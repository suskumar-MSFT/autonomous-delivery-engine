/**
 * issue-filer.ts — Issue filer (M3-2)
 *
 * Given a `MonitorEvent`, creates a structured GitHub issue for it.
 * Idempotent: searches open issues for an exact title match before creating,
 * so repeated monitor passes over the same event never produce duplicates.
 *
 * Safety invariants:
 *   - All `gh` calls go through the injectable `runner` boundary.
 *   - `dryRun: true` → zero mutating subprocess calls (search/read is still allowed).
 *   - Search failure is non-fatal: treated as "not found" so the create path runs.
 *   - Create failure throws; the monitor coordinator catches and logs it.
 *   - Argv is always an array (no shell interpolation; no command injection).
 */

import type { CommandRunner } from '../agents/builder.js';
import { DefaultCommandRunner } from '../agents/builder.js';
import type { MonitorEvent } from './monitor.js';

// ── Public types ──────────────────────────────────────────────────────────────

/** Result returned by `fileMonitorIssue`. */
export interface IssueFiledResult {
  /** The GitHub issue number (existing or newly created). 0 if dryRun + not found. */
  issueNumber: number;

  /**
   * True when the issue already existed in the open-issues list before this call.
   * False when a new issue was created (or when dryRun skipped creation).
   */
  alreadyExisted: boolean;

  /** True when this call was a dry run (no mutating gh calls were made). */
  dryRun: boolean;
}

/** Options for `fileMonitorIssue`. */
export interface IssueFilerOpts {
  /** Target repo in `owner/name` format. */
  repo: string;

  /** The monitor event to file an issue for. */
  event: MonitorEvent;

  /**
   * When true, mutating calls (`gh issue create`) are skipped.
   * The search (read-only) still runs.  Default: false.
   */
  dryRun?: boolean;

  /**
   * Injectable command runner for all `gh` calls.
   * Default: `DefaultCommandRunner` (live subprocess).
   */
  runner?: CommandRunner;
}

// ── fileMonitorIssue ──────────────────────────────────────────────────────────

/**
 * Files a GitHub issue for `event`, or returns the existing issue if one with
 * the same title is already open in `repo`.
 *
 * **Idempotency:** `gh issue list --search <title>` is called first; if an
 * issue with an exact title match is found, its number is returned immediately
 * without creating a duplicate.
 *
 * **dryRun behaviour:** if `dryRun` is true, the search still runs (read-only),
 * but `gh issue create` is never called.  When the issue does not already exist
 * and dryRun is true, `issueNumber` is 0.
 *
 * **Error behaviour:** search failures are treated as "not found" (non-fatal).
 * Create failures throw an `Error`; the caller (monitor coordinator) is
 * responsible for catching and logging.
 *
 * @param opts - Issue-filer configuration; see `IssueFilerOpts`.
 * @returns `IssueFiledResult` describing what happened.
 */
export async function fileMonitorIssue(opts: IssueFilerOpts): Promise<IssueFiledResult> {
  const { repo, event, dryRun = false } = opts;
  const runner: CommandRunner = opts.runner ?? new DefaultCommandRunner();

  // Step 1: search for an existing open issue with the same title (read-only).
  const existing = await searchExistingIssue(runner, repo, event.title);
  if (existing !== null) {
    return { issueNumber: existing, alreadyExisted: true, dryRun };
  }

  // Step 2: if dryRun, skip the mutating create call.
  if (dryRun) {
    return { issueNumber: 0, alreadyExisted: false, dryRun: true };
  }

  // Step 3: create the issue.
  const issueNumber = await createIssue(runner, repo, event.title, event.body);
  return { issueNumber, alreadyExisted: false, dryRun: false };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Shape of one entry returned by `gh issue list --json number,title`. */
interface GhIssue {
  number: number;
  title: string;
}

/**
 * Searches open issues for an exact title match.
 * Returns the issue number if found, or `null` if not found / on any error.
 */
async function searchExistingIssue(
  runner: CommandRunner,
  repo: string,
  title: string,
): Promise<number | null> {
  const result = await runner.run('gh', [
    'issue', 'list',
    '--repo', repo,
    '--state', 'open',
    '--search', title,
    '--json', 'number,title',
    '--limit', '20',
  ]);

  if (result.code !== 0) return null; // treat transient failure as "not found"

  let issues: GhIssue[];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return null;
    issues = parsed as GhIssue[];
  } catch {
    return null;
  }

  // Client-side exact match — gh search may return fuzzy results.
  const match = issues.find(i => i.title === title);
  return match !== undefined ? match.number : null;
}

/**
 * Creates a GitHub issue and returns its number.
 * Throws on gh error or if the issue URL cannot be parsed.
 */
async function createIssue(
  runner: CommandRunner,
  repo: string,
  title: string,
  body: string,
): Promise<number> {
  const result = await runner.run('gh', [
    'issue', 'create',
    '--repo', repo,
    '--title', title,
    '--body', body,
  ]);

  if (result.code !== 0) {
    throw new Error(`gh issue create failed (exit ${result.code}): ${result.stderr}`);
  }

  const num = parseIssueNumberFromOutput(result.stdout.trim());
  if (num === null) {
    throw new Error(
      `fileMonitorIssue: could not parse issue number from gh output: "${result.stdout.trim()}"`,
    );
  }
  return num;
}

/**
 * Parses an issue number from a GitHub issue URL like
 * `https://github.com/owner/repo/issues/42`.
 * Returns `null` if the URL pattern is not found.
 */
export function parseIssueNumberFromOutput(output: string): number | null {
  const match = /\/issues\/(\d+)/.exec(output);
  return match !== null ? Number(match[1]) : null;
}
