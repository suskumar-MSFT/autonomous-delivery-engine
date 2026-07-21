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

export interface Issue {
  number: number;
  title: string;
  labels: string[];
  state: string;
}

/**
 * Shells out to `gh` CLI (via execFile — no shell) to list issues.
 * Falls back to `gh api` if the primary command fails.
 */
export async function listIssues(repo: string, state = 'open'): Promise<Issue[]> {
  validateRepo(repo);
  try {
    return await listIssuesViaCli(repo, state);
  } catch (_primary) {
    return await listIssuesFallback(repo, state);
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
