import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface Issue {
  number: number;
  title: string;
  labels: string[];
  state: string;
}

/**
 * Shells out to `gh` CLI to list issues.
 * Falls back to `gh api` if the primary command fails.
 */
export async function listIssues(repo: string, state = 'open'): Promise<Issue[]> {
  try {
    return await listIssuesViaCli(repo, state);
  } catch (_primary) {
    return await listIssuesFallback(repo, state);
  }
}

export async function listIssuesViaCli(repo: string, state: string): Promise<Issue[]> {
  const cmd = `gh issue list --repo ${repo} --state ${state} --json number,title,labels,state`;
  const { stdout } = await execAsync(cmd);
  return parseCliOutput(stdout);
}

export async function listIssuesFallback(repo: string, state: string): Promise<Issue[]> {
  const cmd = `gh api repos/${repo}/issues?state=${state}&per_page=100`;
  const { stdout } = await execAsync(cmd);
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
