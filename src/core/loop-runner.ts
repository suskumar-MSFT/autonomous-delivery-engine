/**
 * loop-runner.ts — Persistent loop runner (M2-A / M2-1)
 *
 * Exposes `runLoop`, a multi-unit variant of `runOnce` that processes ready
 * backlog units in sequence within a time/step budget.  This is the substrate
 * that M2-1 (in-process chaining) and M2-2 (edge-triggered watcher) attach to.
 *
 * **Safety contract:**
 * - dryRun/live mode propagates to every `runOnce` call — zero side-effects when live=false.
 * - Each unit claims ownership before work; on builder error or no-PR the
 *   claim is released with `''` so `selectNextUnit` can re-queue the item.
 *   No ghost locks.
 * - Wall-clock budget is checked BEFORE starting each unit, not during.
 * - `runLoop` never merges directly; it delegates to `runOnce` which enforces the done-bar.
 *
 * Implementation status: **COMPLETE** — M2-1 in-process chaining implemented.
 */

import type { BuilderOptions, BuilderResult, CommandRunner } from '../agents/builder.js';
import type { Reviewer } from './reviewer.js';
import { runOnce } from './loop.js';
import { runMonitor } from '../monitor/monitor.js';
import { appendRunLog } from '../telemetry/run-log.js';
import type { TelemetryOpts } from '../telemetry/run-log.js';
import { checkKillSwitch } from './kill-switch.js';
import type { ReadFileFn } from './kill-switch.js';
import { readDailyCount } from '../telemetry/daily-cap.js';
import type { CapReadFileFn } from '../telemetry/daily-cap.js';
import { join } from 'node:path';

// Re-export RunOnceResult so callers do not need a separate import.
export type { RunOnceResult } from './loop.js';
import type { RunOnceResult } from './loop.js';

/** The builder function signature (mirrors the inline type in RunOnceOptions). */
export type BuilderFn = (opts: BuilderOptions) => Promise<BuilderResult>;

/** Options passed to `runLoop`. Aligned with RunOnceOptions + loop-level controls. */
export interface LoopRunnerOpts {
  /** Target repo in `owner/name` format (e.g. `suskumar-MSFT/autonomous-delivery-engine`). */
  repo: string;

  /** Directory containing the engine checkout (passed through to runOnce). */
  checkoutDir: string;

  /** Directory containing the state files (passed through to runOnce). */
  stateDir: string;

  /**
   * Injectable command runner (wraps execFile for subprocesses).
   * Passed through to every `runOnce` call so CI-check and merge subprocesses
   * are mockable in tests — not just the builder boundary.
   * Default: `DefaultCommandRunner` (live subprocess).
   */
  runner?: CommandRunner;

  /**
   * When true, `runOnce` runs in live mode (dryRun:false).
   * Default: false (dry-run — zero side-effects).
   */
  live?: boolean;

  /**
   * Builder function that implements one issue.
   * Injected in tests; defaults to the work-order Builder in production.
   */
  builderFn?: BuilderFn;

  /**
   * Reviewer hook called after the PR is open and CI is green.
   * Injected in tests; defaults to the sub-agent code-reviewer in production.
   */
  reviewer?: Reviewer;

  /**
   * Maximum number of units to process in a single `runLoop` invocation.
   * ADR-004 "walk" cap = 2.  Default: 2.
   */
  maxUnits?: number;

  /**
   * Wall-clock budget for the entire `runLoop` invocation in milliseconds.
   * Checked BEFORE starting each unit; a unit that starts is allowed to finish.
   * Default: 14 minutes (840_000 ms).
   */
  budgetMs?: number;

  /**
   * Injectable clock for deterministic tests.  Default: `() => Date.now()`.
   */
  now?: () => number;

  /**
   * Injectable start timestamp (milliseconds since epoch) for deterministic
   * budget tests.  When omitted, captured from `now()` at the top of `runLoop`.
   * Mirrors the `startedAt` option on `RunOnceOptions`.
   */
  startedAt?: number;

  /**
   * When true, a `runMonitor` pre-pass runs once at the start of `runLoop`,
   * before the unit-processing loop begins.  CI polling is always read-only;
   * the monitor respects the same `dryRun` / `live` flag as the unit loop.
   * Default: false.
   */
  monitorEnabled?: boolean;

  /**
   * Telemetry options for recording this run to the JSONL run log.
   * When `telemetry.enabled` is false (or `telemetry` is omitted), no log
   * entry is written — safe for dry-run and test modes.
   *
   * The entry is written AFTER the loop completes (or on the error path),
   * capturing the final `stoppedReason`, `unitsProcessed`, and `durationMs`.
   */
  telemetry?: TelemetryOpts;

  /**
   * Injectable `readFile` seam for the kill-switch probe.
   * When omitted, the live `fs/promises.readFile` is used.
   * Override in tests to inject PROJECT.md content without touching the disk.
   */
  killSwitchReadFile?: ReadFileFn;

  /**
   * Maximum number of units to process across ALL `runLoop` invocations in a
   * single UTC calendar day.  Checked BEFORE starting each unit by reading the
   * persisted JSONL run log (`telemetry.logFile`) and summing today's entries.
   *
   * When the ceiling is reached, `runLoop` stops with `StopReason: 'capped-daily'`.
   * Default: no daily cap (unlimited).
   *
   * Requires `telemetry.logFile` (or the default `'logs/run-log.jsonl'`) to be
   * readable for historical count to be non-zero.  Fail-open: if the log file
   * is absent or unreadable, `readDailyCount` returns 0 and the loop continues.
   */
  maxUnitsPerDay?: number;

  /**
   * Injectable `readFile` seam for the daily-cap guard.
   * When omitted, the live `fs/promises.readFile` is used.
   * Override in tests to inject run-log JSONL content without touching the disk.
   */
  dailyCapReadFile?: CapReadFileFn;
}

/** Reason the loop stopped. */
export type StopReason =
  | 'empty'         // no more ready unowned units in the backlog
  | 'cap'           // maxUnits reached
  | 'budget'        // wall-clock budget exhausted before the next unit started
  | 'killed'        // kill-switch sentinel detected in PROJECT.md (M4-2)
  | 'capped-daily'  // daily unit cap reached — units today >= maxUnitsPerDay (M4-3)
  | 'error';        // unrecoverable error (e.g. state file unreadable)

/** Result returned by `runLoop`. */
export interface LoopRunResult {
  /** Number of units that were processed (started -> completed/merged/blocked). */
  unitsProcessed: number;
  /** Per-unit results in processing order. */
  results: RunOnceResult[];
  /** Why the loop stopped. */
  stoppedReason: StopReason;
  /**
   * Non-fatal errors reported by the monitor pre-pass (empty array when
   * `monitorEnabled` is false, or when the pass completed without errors).
   * Propagated here so operators can observe monitor health without crashing
   * the loop.
   */
  monitorErrors: string[];
}

/**
 * Run the delivery loop for up to `opts.maxUnits` units within `opts.budgetMs`.
 *
 * Processing model (M2-1 in-process chaining):
 *   - Budget is checked BEFORE starting each unit (a started unit runs to completion).
 *   - Each iteration calls `runOnce` which owns the claim/build/gate/merge cycle.
 *   - Loop exits on: no more ready units (`empty`), step cap (`cap`),
 *     budget exhausted (`budget`), or an unrecoverable error (`error`).
 *
 * **Safety contract:**
 * - dryRun propagates through `live` → `runOnce` → builder; zero side-effects when live=false.
 * - No subprocess calls are made when live is false/unset.
 * - `runLoop` never merges directly — it delegates entirely to `runOnce`.
 *
 * @param opts - Loop configuration; see `LoopRunnerOpts`.
 * @returns `LoopRunResult` with per-unit results and the stop reason.
 */
export async function runLoop(opts: LoopRunnerOpts): Promise<LoopRunResult> {
  const {
    repo,
    checkoutDir,
    stateDir,
    runner,
    live = false,
    builderFn,
    reviewer,
    maxUnits = 2,
    budgetMs = 14 * 60 * 1000, // 14 minutes default
    now: nowFn = () => Date.now(),
  } = opts;

  const startedAt = opts.startedAt ?? nowFn();
  const results: RunOnceResult[] = [];
  let unitsProcessed = 0;
  let stoppedReason: StopReason = 'empty';
  let monitorErrors: string[] = [];

  // ── Daily-cap pre-read (M4-3) ─────────────────────────────────────────────
  // Read the persisted run log ONCE at loop start to get historical unit count
  // for today (UTC).  Fail-open: 0 if log is missing or unreadable.
  let historicalUnitsToday = 0;
  if (opts.maxUnitsPerDay !== undefined) {
    const logFile = opts.telemetry?.logFile ?? 'logs/run-log.jsonl';
    historicalUnitsToday = await readDailyCount(logFile, startedAt, opts.dailyCapReadFile);
  }

  // ── Monitor pre-pass (if enabled) ────────────────────────────────────────
  // Runs ONCE before the unit loop.  Non-fatal: any error is swallowed so
  // the unit loop always gets a chance to run.  Errors are surfaced in
  // `monitorErrors` on the returned LoopRunResult for operator visibility.
  if (opts.monitorEnabled) {
    try {
      const monitorResult = await runMonitor({
        repo,
        checkoutDir,
        dryRun: !live,
        runner,
        now: nowFn,
      });
      monitorErrors = monitorResult.errors;
    } catch (err) {
      // runMonitor itself threw (unexpected) — capture as a single error string.
      monitorErrors = [err instanceof Error ? err.message : String(err)];
    }
  }

  // ── Shared telemetry writer (called on normal AND error paths) ───────────
  const writeTelemetry = async (reason: StopReason, units: number): Promise<void> => {
    if (!opts.telemetry) return;
    const durationMs = nowFn() - startedAt;
    try {
      await appendRunLog(
        {
          timestamp: new Date(startedAt).toISOString(),
          repo,
          unitsProcessed: units,
          stoppedReason: reason,
          durationMs,
          monitorErrors,
        },
        opts.telemetry,
      );
    } catch {
      // Silently swallow — telemetry must never crash the loop.
    }
  };

  while (unitsProcessed < maxUnits) {
    // ── Budget check: BEFORE starting each new unit ─────────────────────────
    if (nowFn() - startedAt >= budgetMs) {
      stoppedReason = 'budget';
      break;
    }

    // ── Daily-cap check: BEFORE starting each new unit (M4-3) ───────────────
    // Compares persisted historical count (read once above) plus units already
    // processed in this invocation against the per-day ceiling.
    if (
      opts.maxUnitsPerDay !== undefined &&
      historicalUnitsToday + unitsProcessed >= opts.maxUnitsPerDay
    ) {
      stoppedReason = 'capped-daily';
      break;
    }

    // ── Kill-switch probe: BEFORE starting each new unit ────────────────────
    // Reads PROJECT.md for the `LOOP PAUSED` sentinel.  Fail-open: an
    // unreadable file does NOT stop the loop.
    {
      const projectFile = join(stateDir, 'PROJECT.md');
      const killed = await checkKillSwitch(projectFile, opts.killSwitchReadFile);
      if (killed) {
        stoppedReason = 'killed';
        break;
      }
    }

    let result: RunOnceResult;
    try {
      result = await runOnce({
        repo,
        checkoutDir,
        stateDir,
        runner,
        live,
        builderFn,
        reviewer,
        now: nowFn,
      });
    } catch (err) {
      // Unrecoverable error (e.g. state file unreadable, invalid repo)
      stoppedReason = 'error';
      // Write telemetry BEFORE re-throwing so the error run is logged.
      await writeTelemetry(stoppedReason, unitsProcessed);
      // Re-throw so callers can observe the error, but only after we've
      // set stoppedReason.  We return the partial results alongside the throw
      // by wrapping in a structured error.
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        loopResult: { unitsProcessed, results, stoppedReason, monitorErrors } satisfies LoopRunResult,
      });
    }

    // ── No ready unit — backlog exhausted ────────────────────────────────────
    if (!result.selected) {
      stoppedReason = 'empty';
      break;
    }

    results.push(result);
    unitsProcessed++;

    // ── Step cap reached ─────────────────────────────────────────────────────
    if (unitsProcessed >= maxUnits) {
      stoppedReason = 'cap';
      break;
    }
  }

  const loopResult: LoopRunResult = { unitsProcessed, results, stoppedReason, monitorErrors };

  // ── Telemetry: normal path ────────────────────────────────────────────────
  await writeTelemetry(stoppedReason, unitsProcessed);

  return loopResult;
}
