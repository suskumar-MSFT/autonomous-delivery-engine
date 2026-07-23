/**
 * loop-runner.ts — Persistent loop runner (M2-A scaffold)
 *
 * Exposes `runLoop`, a multi-unit variant of `runOnce` that processes ready
 * backlog units in sequence within a time/step budget.  This is the substrate
 * that M2-1 (in-process chaining) and M2-2 (edge-triggered watcher) attach to.
 *
 * **Safety contract:**
 * - dryRun/live mode propagates to every `runOnce` call — zero side-effects when live=false.
 * - Each unit claims ownership before work and releases on error; no ghost locks.
 * - Wall-clock budget is checked BEFORE starting each unit, not during.
 * - `runLoop` never merges directly; it delegates to `runOnce` which enforces the done-bar.
 *
 * Implementation status: **SCAFFOLD** — interface + types only.
 * Full implementation ships in M2-1 (in-process chaining story).
 */

import type { BuilderOptions, BuilderResult } from '../agents/builder.js';
import type { Reviewer } from './reviewer.js';

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
 * M2-1 TODO: implement the while-loop body:
 *
 *   const startedAt = opts.now?.() ?? Date.now();
 *   const now = opts.now ?? (() => Date.now());
 *   while (unitsProcessed < maxUnits && (now() - startedAt) < budgetMs) {
 *     const result = await runOnce({ ...opts });
 *     if (!result.selected) { stoppedReason = 'empty'; break; }
 *     results.push(result);
 *     unitsProcessed++;
 *   }
 *
 * Until M2-1, this function throws to make the scaffold-vs-live distinction explicit.
 */
export async function runLoop(opts: LoopRunnerOpts): Promise<LoopRunResult> {
  void opts; // intentionally unused until M2-1
  throw new Error(
    'runLoop is not yet implemented — scaffold only (M2-0). ' +
    'Implementation ships in M2-1 (in-process chaining).',
  );
}
