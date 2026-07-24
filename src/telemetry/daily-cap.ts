/**
 * daily-cap.ts — Daily unit-cap guard (M4-3)
 *
 * Prevents the autonomous loop from processing unbounded units per calendar day
 * by counting units already recorded in the JSONL run log for today (UTC) and
 * stopping the loop when the `maxUnitsPerDay` ceiling is reached.
 *
 * **Module layout:**
 *   M4-3: `countUnitsToday` pure helper + `readDailyCount` async boundary wrapper
 *         consumed by `runLoop` in `loop-runner.ts`.
 *
 * **Safety contract:**
 * - All functions in this module are read-only — no mutations to the log or any state file.
 * - The `readFile` boundary is injectable so tests remain hermetic (no live FS).
 * - Fail-open: if the log file is unreadable (ENOENT, permission error, etc.),
 *   `readDailyCount` returns 0 so the loop is never incorrectly blocked.
 * - No subprocess calls — pure FS + clock boundaries.
 */

import type { RunLog } from './run-log.js';
import { readRunLog } from './run-log.js';

// ── Injectable readFile type ───────────────────────────────────────────────────

/**
 * Injectable readFile for the daily-cap guard.
 * Mirrors the `ReadFileFn` signature used by the kill-switch module.
 */
export type CapReadFileFn = (path: string, encoding: BufferEncoding) => Promise<string>;

// ── countUnitsToday ───────────────────────────────────────────────────────────

/**
 * Counts the total number of units processed across all `RunLogEntry` records
 * whose `timestamp` starts with `date` (UTC date prefix `YYYY-MM-DD`).
 *
 * Pure helper — takes a pre-parsed `RunLog` so it can be used without I/O.
 *
 * @param log  - Parsed run log (e.g. from `readRunLog`).
 * @param date - UTC date string in `'YYYY-MM-DD'` format.
 * @returns    Total `unitsProcessed` for that date, or 0 when there are no matching entries.
 */
export function countUnitsToday(log: RunLog, date: string): number {
  let total = 0;
  for (const entry of log) {
    // ISO 8601 timestamps start with 'YYYY-MM-DDTHH:mm:ss.sssZ'.
    // Matching the prefix gives us all UTC entries for the given date.
    if (entry.timestamp.startsWith(date)) {
      total += entry.unitsProcessed;
    }
  }
  return total;
}

// ── utcDateString ─────────────────────────────────────────────────────────────

/**
 * Returns the UTC date for a given epoch-millisecond timestamp in `'YYYY-MM-DD'` format.
 *
 * Exported so callers can derive today's date from an injectable `now()` clock,
 * keeping date arithmetic testable without mocking the system clock globally.
 *
 * @param ms - Epoch milliseconds (e.g. from `Date.now()` or an injectable clock).
 * @returns  UTC date string, e.g. `'2026-07-23'`.
 */
export function utcDateString(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

// ── readDailyCount ────────────────────────────────────────────────────────────

/**
 * Reads and parses the JSONL run-log at `logFile`, then returns the count of
 * units processed today (UTC date derived from `nowMs`).
 *
 * **Fail-open**: returns 0 if the file is missing or unreadable, so the loop is
 * never incorrectly blocked on a log I/O error.
 *
 * @param logFile  - Path to the JSONL run-log file.
 * @param nowMs    - Current epoch-milliseconds (injectable for deterministic tests).
 * @param readFile - Injectable `readFile` seam; defaults to Node.js `fs/promises.readFile`.
 * @returns Number of units processed today according to the persisted log, or 0 on error.
 */
export async function readDailyCount(
  logFile: string,
  nowMs: number,
  readFile?: CapReadFileFn,
): Promise<number> {
  const readFileFn: CapReadFileFn =
    readFile ??
    (async (p, enc) => {
      const { readFile: fsReadFile } = await import('node:fs/promises');
      return fsReadFile(p, enc);
    });

  try {
    const raw = await readFileFn(logFile, 'utf-8');
    const log: RunLog = readRunLog(raw);
    return countUnitsToday(log, utcDateString(nowMs));
  } catch {
    // ENOENT, EACCES, or parse failure → assume no historical units today.
    return 0;
  }
}
