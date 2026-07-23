/**
 * ci-watcher.ts — CI health poller (M3-1)
 *
 * Fetches GitHub Actions workflow run status for recent commits and emits
 * `MonitorEvent` records for any newly-failed runs.
 *
 * Safety invariants:
 *   - Read-only: `fetchFailedRuns` never writes to GitHub or the filesystem.
 *   - All `gh` calls go through the injectable `runner` boundary.
 *   - Returns `[]` on `gh` error; never throws for transient failures.
 */

import type { CommandRunner } from '../agents/builder.js';
import { DefaultCommandRunner } from '../agents/builder.js';
import type { MonitorEvent } from './monitor.js';

const DEFAULT_LOOKBACK = 10;

// ── Public interface ──────────────────────────────────────────────────────────

/** Options for `fetchFailedRuns`. */
export interface CiWatcherOpts {
  /** Target repo in `owner/name` format. */
  repo: string;

  /**
   * Injectable command runner for all `gh` calls.
   * Default: `DefaultCommandRunner` (live subprocess).
   */
  runner?: CommandRunner;

  /**
   * Number of recent workflow runs to scan.  Default: 10.
   */
  lookback?: number;

  /**
   * Injectable clock — used for `detectedAt` on emitted events.
   * Default: `() => Date.now()`.
   */
  now?: () => number;
}

// ── Internal GhRun shape ──────────────────────────────────────────────────────

/** Shape of one entry returned by `gh run list --json ...`. */
interface GhRun {
  databaseId: string | number;
  status: string;
  conclusion: string | null;
  headSha: string;
  updatedAt: string;
  name: string;
}

// ── fetchFailedRuns ───────────────────────────────────────────────────────────

/**
 * Fetches recent GitHub Actions workflow runs for `repo` and returns a
 * `MonitorEvent` for every run that concluded with a failure.
 *
 * The function is strictly read-only — it only calls `gh run list`.
 * On any `gh` error (non-zero exit, unparseable JSON, unexpected shape)
 * it returns an empty array rather than throwing, so a transient GitHub
 * outage never aborts the monitor pass.
 *
 * @param opts - CI watcher configuration; see `CiWatcherOpts`.
 * @returns `MonitorEvent[]` for failed runs, or `[]` on error.
 */
export async function fetchFailedRuns(opts: CiWatcherOpts): Promise<MonitorEvent[]> {
  const { repo, lookback = DEFAULT_LOOKBACK } = opts;
  const runner = opts.runner ?? new DefaultCommandRunner();
  const now = opts.now ?? (() => Date.now());

  // gh run list — argv array (no shell), read-only
  const result = await runner.run('gh', [
    'run', 'list',
    '--repo', repo,
    '--limit', String(lookback),
    '--json', 'databaseId,status,conclusion,headSha,updatedAt,name',
  ]);

  if (result.code !== 0) return [];

  let runs: GhRun[];
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return [];
    runs = parsed as GhRun[];
  } catch {
    return [];
  }

  const detectedAt = new Date(now()).toISOString();
  const events: MonitorEvent[] = [];

  for (const run of runs) {
    const conclusion = (run.conclusion ?? '').toLowerCase();
    if (conclusion !== 'failure' && conclusion !== 'action_required') continue;

    const runId = String(run.databaseId);
    const headSha = run.headSha ?? '';
    const sha = headSha.length >= 7 ? headSha.slice(0, 7) : headSha;

    events.push({
      kind: 'ci-failure',
      sourceId: runId,
      title: `[CI] ${run.name} failed on ${sha} (run ${runId})`,
      body: [
        '## CI Failure',
        '',
        `**Workflow:** ${run.name}`,
        `**Run ID:** ${runId}`,
        `**Commit:** ${headSha}`,
        `**Conclusion:** ${run.conclusion ?? ''}`,
        `**Updated at:** ${run.updatedAt}`,
        '',
        `[View run](https://github.com/${repo}/actions/runs/${runId})`,
      ].join('\n'),
      detectedAt,
    });
  }

  return events;
}
