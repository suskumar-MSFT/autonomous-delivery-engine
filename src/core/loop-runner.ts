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
}

/** Reason the loop stopped. */
export type StopReason =
  | 'empty'   // no more ready unowned units in the backlog
  | 'cap'     // maxUnits reached
  | 'budget'  // wall-clock budget exhausted before the next unit started
  | 'error';  // unrecoverable error (e.g. state file unreadable)

/** Result returned by `runLoop`. */
export interface LoopRunResult {
  /** Number of units that were processed (started -> completed/merged/blocked). */
  unitsProcessed: number;
  /** Per-unit results in processing order. */
  results: RunOnceResult[];
  /** Why the loop stopped. */
  stoppedReason: StopReason;
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

  // ── Monitor pre-pass (if enabled) ────────────────────────────────────────
  // Runs ONCE before the unit loop.  Non-fatal: any error is swallowed so
  // the unit loop always gets a chance to run.
  if (opts.monitorEnabled) {
    try {
      await runMonitor({
        repo,
        checkoutDir,
        dryRun: !live,
        runner,
        now: nowFn,
      });
    } catch {
      // Monitor errors never abort the unit loop.
    }
  }

  while (unitsProcessed < maxUnits) {
    // ── Budget check: BEFORE starting each new unit ─────────────────────────
    if (nowFn() - startedAt >= budgetMs) {
      stoppedReason = 'budget';
      break;
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
      // Re-throw so callers can observe the error, but only after we've
      // set stoppedReason.  We return the partial results alongside the throw
      // by wrapping in a structured error.
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        loopResult: { unitsProcessed, results, stoppedReason } satisfies LoopRunResult,
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

  return { unitsProcessed, results, stoppedReason };
}
