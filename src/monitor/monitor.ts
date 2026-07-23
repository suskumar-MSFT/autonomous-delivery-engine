/**
 * monitor.ts — Monitor coordinator + shared types (M3 scaffold)
 *
 * M3 adds a Monitor capability that watches CI / PR health, detects regressions,
 * files structured GitHub issues, and dispatches fix work-orders — closing the
 * idea→ship loop with a self-healing feedback layer.
 *
 * **Module layout (M3 sub-stories):**
 *   M3-1: src/monitor/ci-watcher.ts   — `fetchFailedRuns` (CI health poller)
 *   M3-2: src/monitor/issue-filer.ts  — `fileMonitorIssue` (idempotent issue filing)
 *   M3-3: src/monitor/fix-dispatcher.ts — `dispatchFix` (fix work-order writer)
 *   M3-4: this file — `runMonitor` coordinator wired into runLoop
 *
 * **Safety contract:**
 *   - All sub-modules use injectable `CommandRunner` / `writeFile` / `now()` boundaries.
 *   - `dryRun: true` → zero subprocesses, zero file writes, zero gh calls.
 *   - Monitor pass errors are caught and logged; they never abort the unit loop.
 *   - Read paths (CI poller) are always read-only regardless of dryRun.
 *
 * Implementation status: **SCAFFOLD** — types + stubs only (M3-0).
 * Full implementation lands in M3-1..M3-4.
 */

import type { CommandRunner } from '../agents/builder.js';
import { DefaultCommandRunner } from '../agents/builder.js';
import { fetchFailedRuns } from './ci-watcher.js';
import { fileMonitorIssue } from './issue-filer.js';
import { dispatchFix } from './fix-dispatcher.js';

// ── Shared MonitorEvent type ──────────────────────────────────────────────────

/**
 * A structured event emitted by any monitor sub-module.
 * Used as the currency between the CI watcher, issue filer, and fix dispatcher.
 */
export interface MonitorEvent {
  /**
   * Event kind.  M3 ships `ci-failure`; `pr-stale` and `regression` are
   * reserved for M4.
   */
  kind: 'ci-failure' | 'pr-stale' | 'regression';

  /**
   * Opaque identifier for the originating GitHub object (workflow run ID,
   * PR number, etc.).  Used by the issue filer to de-duplicate: one issue
   * per unique `sourceId`.
   */
  sourceId: string;

  /** Human-readable title for the GitHub issue to be filed. */
  title: string;

  /** Markdown body with structured failure detail. */
  body: string;

  /** ISO 8601 timestamp of when the event was detected. */
  detectedAt: string;
}

// ── MonitorRunResult ──────────────────────────────────────────────────────────

/** Summary returned by `runMonitor` after one monitor pass. */
export interface MonitorRunResult {
  /** Number of new failures detected by the CI watcher. */
  failuresDetected: number;

  /** Issue numbers filed (or already-existing) for detected failures. */
  issuesFiledOrExisting: number[];

  /** Work-order paths written by the fix dispatcher (empty if dryRun). */
  workOrdersDispatched: string[];

  /** Any non-fatal errors encountered during the pass (logged; does not abort loop). */
  errors: string[];
}

// ── MonitorOpts ───────────────────────────────────────────────────────────────

/** Options for `runMonitor`. */
export interface MonitorOpts {
  /** Target repo in `owner/name` format. */
  repo: string;

  /** Absolute path to the engine checkout (used by the fix dispatcher). */
  checkoutDir: string;

  /**
   * When true, all mutating calls (issue filing, work-order writes) are
   * skipped.  CI polling (read-only) still runs.  Default: true (safe mode).
   */
  dryRun?: boolean;

  /**
   * Injectable command runner for all `gh` calls.
   * Default: `DefaultCommandRunner` (live subprocess).
   */
  runner?: CommandRunner;

  /**
   * Injectable file writer for work-order writes (used by the fix dispatcher in M3-3).
   * Default: `fs.writeFile` (live filesystem write).
   */
  writeFile?: (path: string, data: string) => Promise<void>;

  /**
   * Injectable clock for deterministic tests.  Default: `() => Date.now()`.
   */
  now?: () => number;

  /**
   * Number of recent workflow runs to scan for failures.  Default: 10.
   */
  lookback?: number;

  /**
   * Injectable mkdirp (recursive mkdir) passed to the fix dispatcher.
   * Default: `fs/promises` `mkdir` with `{ recursive: true }`.
   */
  mkdirp?: (dir: string) => Promise<void>;
}

// ── runMonitor stub (M3-0 scaffold — full impl in M3-4) ──────────────────────

/**
 * Run one monitor pass: poll CI, file issues for new failures, dispatch fix
 * work-orders.
 *
 * **M3-0 stub:** returns an empty result; real implementation lands in M3-4
 * after M3-1..M3-3 provide the sub-module implementations.
 *
 * @param opts - Monitor configuration; see `MonitorOpts`.
 * @returns `MonitorRunResult` summarising the pass.
 */
export async function runMonitor(opts: MonitorOpts): Promise<MonitorRunResult> {
  const { repo, checkoutDir, dryRun = true, lookback } = opts;
  const runner: CommandRunner = opts.runner ?? new DefaultCommandRunner();
  const now = opts.now ?? (() => Date.now());
  const writeFileFn = opts.writeFile;
  const mkdirpFn = opts.mkdirp;

  const result: MonitorRunResult = {
    failuresDetected: 0,
    issuesFiledOrExisting: [],
    workOrdersDispatched: [],
    errors: [],
  };

  // ── Step 1: Fetch failed CI runs (read-only; always runs regardless of dryRun) ──
  let events: MonitorEvent[];
  try {
    events = await fetchFailedRuns({ repo, runner, lookback, now });
  } catch (err) {
    result.errors.push(
      `fetchFailedRuns: ${err instanceof Error ? err.message : String(err)}`,
    );
    return result;
  }

  result.failuresDetected = events.length;

  // ── Step 2: For each event, file an issue then dispatch a fix work-order ───
  for (const event of events) {
    // File the issue (search-before-create; dryRun skips create).
    let issueNumber = 0;
    try {
      const filed = await fileMonitorIssue({ repo, event, dryRun, runner });
      issueNumber = filed.issueNumber;
      if (issueNumber > 0) {
        result.issuesFiledOrExisting.push(issueNumber);
      }
    } catch (err) {
      result.errors.push(
        `fileMonitorIssue(${event.sourceId}): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue; // skip fix dispatch for this event
    }

    // Skip fix dispatch when there is no real issue number (dryRun + not found).
    if (issueNumber <= 0) continue;

    // Dispatch a fix work-order (dryRun-guarded inside dispatchFix).
    try {
      const dispatched = await dispatchFix({
        repo,
        issueNumber,
        checkoutDir,
        dryRun,
        writeFile: writeFileFn,
        mkdirp: mkdirpFn,
        now,
      });
      if (dispatched.workOrderPath !== null) {
        result.workOrdersDispatched.push(dispatched.workOrderPath);
      }
    } catch (err) {
      result.errors.push(
        `dispatchFix(${issueNumber}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return result;
}
