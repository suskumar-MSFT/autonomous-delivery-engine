import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(_execFile);

/** Must match owner/name — no shell metacharacters allowed. */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

function validateRepo(repo: string): void {
  if (!REPO_RE.test(repo)) {
    throw new Error(
      `Invalid repo "${repo}": expected "owner/name" format (letters, digits, hyphens, dots only)`,
    );
  }
}

// ---------------------------------------------------------------------------
// CommandRunner interface — mockable boundary for all subprocess calls
// ---------------------------------------------------------------------------

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RunOptions {
  /** Working directory for the subprocess. */
  cwd?: string;
}

/**
 * Mockable boundary for all subprocess calls (gh, claude, git, npm).
 * Tests inject a fake; production uses DefaultCommandRunner backed by execFile.
 */
export interface CommandRunner {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
}

// ---------------------------------------------------------------------------
// Default implementation — execFile, NO shell
// ---------------------------------------------------------------------------

export class DefaultCommandRunner implements CommandRunner {
  async run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
    try {
      const result = await execFileAsync(cmd, args, {
        cwd: opts?.cwd,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr), code: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: unknown; stderr?: unknown; code?: unknown };
      return {
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? ''),
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// BuilderResult
// ---------------------------------------------------------------------------

export interface BuilderResult {
  branch: string;
  prUrl: string | null;
  testsPassed: boolean;
  implemented: boolean;
  /**
   * True when the run was a dry-run: no subprocesses were invoked, no files
   * were mutated. All other fields reflect the *planned* state only.
   * Absent (undefined) on real (live) runs — backward-compatible with callers
   * that do not check this field.
   */
  dryRun?: true;
}

// ---------------------------------------------------------------------------
// runBuilder
// ---------------------------------------------------------------------------

export interface BuilderOptions {
  repo: string;
  issueNumber: number;
  checkoutDir: string;
  /** When true, skip commit/push/PR (safe for loop dry-runs). */
  dryRun?: boolean;
  runner?: CommandRunner;
}

/**
 * Drives Claude Code CLI to implement a GitHub issue, then runs tests/build
 * and, if they pass, opens a PR.
 *
 * All subprocess calls go through `runner` — inject a mock in tests so
 * claude/gh/network are NEVER called in CI.
 *
 * When `dryRun` is true this function performs ZERO subprocess side-effects:
 * it computes the branch name and assembles the prompt, then returns early
 * with a clearly-labelled planned result.  No gh, claude, npm, git, or any
 * other subprocess is invoked.
 */
export async function runBuilder(opts: BuilderOptions): Promise<BuilderResult> {
  const { repo, issueNumber, checkoutDir, dryRun = false } = opts;
  validateRepo(repo);

  // (b) Compute branch name — pure, no I/O
  const branch = `feat/issue-${issueNumber}`;

  // ─── DRY-RUN SHORT-CIRCUIT ───────────────────────────────────────────────
  // When dryRun is true we must not invoke any subprocess (gh, claude, npm,
  // git).  Assemble the prompt using placeholder issue data (no network call)
  // and return a planned result immediately.
  if (dryRun) {
    // Use placeholder data so the prompt is still assembled (useful for
    // inspection) without touching the network.
    assemblePrompt({
      repo,
      issueNumber,
      title: `issue #${issueNumber}`,
      body: '(dry-run placeholder — issue not fetched)',
      branch,
    });
    return { branch, prUrl: null, testsPassed: false, implemented: false, dryRun: true };
  }
  // ─────────────────────────────────────────────────────────────────────────

  const runner: CommandRunner = opts.runner ?? new DefaultCommandRunner();

  // (a) Fetch issue title + body
  const { title, body } = await fetchIssue(runner, repo, issueNumber);

  // (c) Assemble implementation prompt
  const prompt = assemblePrompt({ repo, issueNumber, title, body, branch });

  // (d) Invoke Claude Code CLI headlessly
  const claudeResult = await runner.run('claude', ['-p', prompt], { cwd: checkoutDir });
  const implemented = claudeResult.code === 0;

  if (!implemented) {
    return { branch, prUrl: null, testsPassed: false, implemented: false };
  }

  // (e) Run tests + build
  const testsPassed = await runTestsAndBuild(runner, checkoutDir);

  if (!testsPassed) {
    return { branch, prUrl: null, testsPassed: false, implemented: true };
  }

  // (f) Tests passed — commit + push + open PR
  const prUrl = await commitPushAndPR(runner, repo, branch, issueNumber, title, checkoutDir);
  return { branch, prUrl, testsPassed: true, implemented: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface IssueData {
  title: string;
  body: string;
}

async function fetchIssue(runner: CommandRunner, repo: string, issueNumber: number): Promise<IssueData> {
  const result = await runner.run('gh', [
    'issue', 'view', String(issueNumber),
    '--repo', repo,
    '--json', 'title,body',
  ]);

  if (result.code !== 0) {
    throw new Error(`Failed to fetch issue #${issueNumber}: ${result.stderr}`);
  }

  const parsed = JSON.parse(result.stdout) as { title?: unknown; body?: unknown };
  return {
    title: String(parsed.title ?? ''),
    body: String(parsed.body ?? ''),
  };
}

export function assemblePrompt(opts: {
  repo: string;
  issueNumber: number;
  title: string;
  body: string;
  branch: string;
}): string {
  return [
    `You are implementing GitHub issue #${opts.issueNumber} in the repository ${opts.repo}.`,
    ``,
    `Issue title: ${opts.title}`,
    ``,
    `Issue body:`,
    `${opts.body}`,
    ``,
    `Branch: ${opts.branch}`,
    ``,
    `Instructions:`,
    `1. Read the issue carefully and implement what is described.`,
    `2. Write clean, well-typed TypeScript following existing code conventions.`,
    `3. Add or update tests as needed (vitest).`,
    `4. Do NOT commit or push — the orchestrator will handle that.`,
    `5. When done, output a brief summary of what you implemented.`,
  ].join('\n');
}

async function runTestsAndBuild(runner: CommandRunner, cwd: string): Promise<boolean> {
  const testResult = await runner.run('npm', ['test'], { cwd });
  if (testResult.code !== 0) return false;

  const buildResult = await runner.run('npm', ['run', 'build'], { cwd });
  return buildResult.code === 0;
}

async function commitPushAndPR(
  runner: CommandRunner,
  repo: string,
  branch: string,
  issueNumber: number,
  title: string,
  cwd: string,
): Promise<string | null> {
  // git add all changes
  const addResult = await runner.run('git', ['add', '-A'], { cwd });
  if (addResult.code !== 0) return null;

  // git commit
  const commitMsg = `feat: implement #${issueNumber} — ${title}`;
  const commitResult = await runner.run('git', ['commit', '-m', commitMsg], { cwd });
  if (commitResult.code !== 0) return null;

  // git push
  const pushResult = await runner.run('git', ['push', '--set-upstream', 'origin', branch], { cwd });
  if (pushResult.code !== 0) return null;

  // gh pr create
  const prBody = `Implements #${issueNumber}.\n\n${title}`;
  const prResult = await runner.run('gh', [
    'pr', 'create',
    '--repo', repo,
    '--title', `${title} (#${issueNumber})`,
    '--body', prBody,
    '--head', branch,
  ]);

  if (prResult.code !== 0) return null;

  // gh pr create prints the PR URL to stdout
  return prResult.stdout.trim() || null;
}
