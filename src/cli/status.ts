/**
 * status.ts — Loop status view (M4-4)
 *
 * Provides `getLoopStatus`, a read-only query over the JSONL run log and
 * PROJECT.md that returns a structured `LoopStatus` summary.  Callers can
 * print it as a table, push it to a dashboard, or use it to gate further
 * loop invocations.
 *
 * **Safety contract:**
 * - Read-only: never writes to any file.
 * - All I/O boundaries (`readFile`) are injectable — no live FS in tests.
 * - No subprocess calls — pure FS + clock boundaries.
 * - Fail-open on every read: a missing/unreadable file yields safe zero/null
 *   defaults rather than throwing.
 *
 * Implementation status: **M4-4 COMPLETE**.
 */

import { readRunLog } from '../telemetry/run-log.js';
import { countUnitsToday, utcDateString } from '../telemetry/daily-cap.js';
import { checkKillSwitch } from '../core/kill-switch.js';

// ── Injectable types ───────────────────────────────────────────────────────────

/**
 * Injectable `readFile` seam.  Resolves with file contents as a string;
 * rejects on I/O error (ENOENT, EACCES, …).
 */
export type StatusReadFileFn = (
  path: string,
  encoding: BufferEncoding,
) => Promise<string>;

// ── LoopStatus ────────────────────────────────────────────────────────────────

/**
 * Structured health summary returned by `getLoopStatus`.
 *
 * All nullable fields are `null` when no run-log data is available (e.g. on a
 * fresh checkout before the loop has run for the first time).
 */
export interface LoopStatus {
  /**
   * ISO 8601 timestamp of when the most recent `runLoop` invocation started.
   * `null` if the run log is empty or unreadable.
   */
  lastRunTime: string | null;

  /**
   * Stop reason from the most recent `runLoop` invocation.
   * `null` if the run log is empty or unreadable.
   */
  lastStopReason: string | null;

  /**
   * Total units processed across all `runLoop` invocations today (UTC).
   * `0` when the run log is empty, unreadable, or has no entries for today.
   */
  unitsToday: number;

  /**
   * Non-fatal monitor errors from the most recent run that had a monitor
   * pre-pass.  Empty array when the last run had no monitor errors, or when
   * no run with a monitor pre-pass is recorded.
   */
  monitorErrors: string[];

  /**
   * Whether the kill-switch sentinel (`LOOP PAUSED`) is currently active in
   * PROJECT.md.  `false` when the file is unreadable (fail-open).
   */
  killSwitchActive: boolean;
}

// ── StatusOpts ────────────────────────────────────────────────────────────────

/** Options for `getLoopStatus`. */
export interface StatusOpts {
  /**
   * Absolute or CWD-relative path to the JSONL run log.
   * Default: `'logs/run-log.jsonl'`.
   */
  logFile?: string;

  /**
   * Absolute or CWD-relative path to PROJECT.md (for kill-switch check).
   * Default: `'state/PROJECT.md'`.
   */
  projectFile?: string;

  /**
   * Injectable `readFile` seam used for both the run log and PROJECT.md.
   * Default: Node.js `fs/promises.readFile`.
   */
  readFile?: StatusReadFileFn;

  /**
   * Injectable clock.  Used to derive "today" (UTC) for `unitsToday`.
   * Default: `() => Date.now()`.
   */
  now?: () => number;
}

// ── getLoopStatus ─────────────────────────────────────────────────────────────

/**
 * Returns a structured `LoopStatus` health summary by reading the JSONL run
 * log (for telemetry) and PROJECT.md (for kill-switch state).
 *
 * Both reads are fail-open: I/O errors produce safe defaults rather than
 * throwing, so callers can display a degraded status even when some files are
 * missing.
 *
 * @param opts - Configuration; see `StatusOpts`.
 * @returns    Structured `LoopStatus` — always resolves, never rejects.
 */
export async function getLoopStatus(opts?: StatusOpts): Promise<LoopStatus> {
  const logFile = opts?.logFile ?? 'logs/run-log.jsonl';
  const projectFile = opts?.projectFile ?? 'state/PROJECT.md';
  const nowFn = opts?.now ?? (() => Date.now());

  const readFileFn: StatusReadFileFn =
    opts?.readFile ??
    (async (p, enc) => {
      const { readFile: fsReadFile } = await import('node:fs/promises');
      return fsReadFile(p, enc);
    });

  // ── Read run log ──────────────────────────────────────────────────────────
  let lastRunTime: string | null = null;
  let lastStopReason: string | null = null;
  let monitorErrors: string[] = [];
  let unitsToday = 0;

  try {
    const raw = await readFileFn(logFile, 'utf-8');
    const log = readRunLog(raw);

    if (log.length > 0) {
      const last = log[log.length - 1];
      lastRunTime = last.timestamp;
      lastStopReason = last.stoppedReason;
      monitorErrors = last.monitorErrors ?? [];
    }

    unitsToday = countUnitsToday(log, utcDateString(nowFn()));
  } catch {
    // Missing or unreadable run log → safe zero/null defaults (already set above).
  }

  // ── Read PROJECT.md for kill-switch ───────────────────────────────────────
  // Delegate to the authoritative checkKillSwitch (M4-2) so sentinel matching
  // logic stays in one place and cannot drift.  checkKillSwitch is fail-open
  // by contract (returns false on ENOENT/EACCES), so no try/catch needed here.
  const killSwitchActive = await checkKillSwitch(projectFile, readFileFn);

  return {
    lastRunTime,
    lastStopReason,
    unitsToday,
    monitorErrors,
    killSwitchActive,
  };
}
