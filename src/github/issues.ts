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

/**
 * Returns true when an error looks like a gh authentication failure.
 * Inspects the error message and, for ExecFileException, the `stderr` property.
 */
export function looksLikeAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const stderr = (err != null && typeof err === 'object') ? (err as { stderr?: string }).stderr ?? '' : '';
  const combined = `${msg}\n${stderr}`.toLowerCase();
  return (
    combined.includes('not logged in') ||
    combined.includes('authentication required') ||
    combined.includes('auth token') ||
    combined.includes('please run: gh auth login') ||
    /\b(401|403)\b/.test(combined)
  );
}

export interface Issue {
  number: number;
  title: string;
  labels: string[];
  state: string;
}

/**
 * Shells out to `gh` CLI (via execFile — no shell) to list issues.
 * Falls back to `gh api` if the primary command fails.
 * When both paths fail, throws a combined error so the caller can see both failure messages.
 */
export async function listIssues(repo: string, state = 'open'): Promise<Issue[]> {
  validateRepo(repo);
  let primaryErr: unknown;
  try {
    return await listIssuesViaCli(repo, state);
  } catch (err) {
    primaryErr = err;
  }
  try {
    return await listIssuesFallback(repo, state);
  } catch (fallbackErr) {
    const primary = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    const fallback = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    const authHint = looksLikeAuthError(primaryErr) || looksLikeAuthError(fallbackErr)
      ? ' (authentication may be required — run `gh auth login`)'
      : '';
    throw new Error(
      `gh issue list failed on both paths${authHint}.\n  CLI: ${primary}\n  API: ${fallback}`,
    );
  }
}

export async function listIssuesViaCli(repo: string, state: string): Promise<Issue[]> {
  validateRepo(repo);
  // execFile — argv array, never a shell string → no command injection possible
  const { stdout } = await execFileAsync('gh', [
    'issue', 'list',
    '--repo', repo,
    '--state', state,
    '--json', 'number,title,labels,state',
  ]);
  return parseCliOutput(stdout);
}

export async function listIssuesFallback(repo: string, state: string): Promise<Issue[]> {
  validateRepo(repo);
  // execFile — argv array; `&` in repo/state values is inert, not a shell operator
  const { stdout } = await execFileAsync('gh', [
    'api',
    `repos/${repo}/issues`,
    '--method', 'GET',
    '-f', `state=${state}`,
    '-f', 'per_page=100',
  ]);
  return parseFallbackOutput(stdout);
}

function parseCliOutput(raw: string): Issue[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Expected array from gh CLI output');
  return parsed.map((item: unknown) => {
    const i = item as Record<string, unknown>;
    const labels = Array.isArray(i.labels)
      ? (i.labels as Array<{ name?: string }>).map(l => l.name ?? String(l))
      : [];
    return {
      number: Number(i.number),
      title: String(i.title),
      labels,
      state: String(i.state),
    };
  });
}

function parseFallbackOutput(raw: string): Issue[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Expected array from gh api output');
  return parsed.map((item: unknown) => {
    const i = item as Record<string, unknown>;
    const labelsRaw = Array.isArray(i.labels) ? (i.labels as Array<{ name?: string }>) : [];
    return {
      number: Number(i.number),
      title: String(i.title),
      labels: labelsRaw.map(l => l.name ?? ''),
      state: String(i.state),
    };
  });
}
