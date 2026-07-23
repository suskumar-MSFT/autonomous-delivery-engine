/**
 * run-log.ts — Run telemetry log (M4 scaffold)
 *
 * Provides a structured JSONL append-log for `runLoop` invocations.  One
 * entry per `runLoop` call; consumers can answer "what did the loop do today?"
 * by reading and filtering the log.
 *
 * **Module layout (M4 sub-stories):**
 *   M4-0: types + `appendRunLog` / `readRunLog` stubs
 *   M4-1: full `appendRunLog` implementation (JSONL append, injectable FS + mkdirp) ← this story
 *
 * **Safety contract:**
 *   - `appendRunLog` is append-only; it never overwrites existing entries.
 *   - `readRunLog` is always read-only.
 *   - All I/O boundaries (appendFile, mkdirp, now) are injectable — no live FS
 *     in tests.
 *   - No subprocess calls — pure FS + clock.
 *
 * Implementation status: **M4-1 COMPLETE** — `appendRunLog` fully implemented.
 */

// ── RunLogEntry ───────────────────────────────────────────────────────────────

/**
 * One entry in the run log, written by `appendRunLog` after each `runLoop`
 * invocation.
 */
export interface RunLogEntry {
  /**
   * ISO 8601 timestamp of when `runLoop` started.
   * Used for daily-cap accounting (M4-3) and status view (M4-4).
   */
  timestamp: string;

  /** Target repo in `owner/name` format. */
  repo: string;

  /**
   * Number of units completed (started + reached merge/no-pr/blocked) this run.
   * Maps to `LoopRunResult.unitsProcessed`.
   */
  unitsProcessed: number;

  /**
   * Why the loop stopped.
   * Maps to `LoopRunResult.stoppedReason` (extended in M4-2 with `'killed'`
   * and in M4-3 with `'capped-daily'`).
   */
  stoppedReason: string;

  /**
   * Wall-clock milliseconds for the entire `runLoop` invocation.
   * Computed as `endTime - startTime` by the telemetry layer.
   */
  durationMs: number;

  /**
   * Non-fatal errors reported by the monitor pre-pass.
   * Empty when `monitorEnabled` is false or the pass completed cleanly.
   */
  monitorErrors: string[];
}

// ── RunLog ────────────────────────────────────────────────────────────────────

/** An ordered list of `RunLogEntry` records (oldest first). */
export type RunLog = RunLogEntry[];

// ── TelemetryOpts ─────────────────────────────────────────────────────────────

/** Options for `appendRunLog`. */
export interface TelemetryOpts {
  /**
   * Absolute or CWD-relative path to the JSONL log file.
   * Default: `'logs/run-log.jsonl'`.
   */
  logFile?: string;

  /**
   * When false, `appendRunLog` returns immediately without writing anything.
   * Useful for dry-run and test modes.  Default: true.
   */
  enabled?: boolean;

  /**
   * Injectable file appender — appends `data` to `path`, creating the file
   * if it does not exist.
   * Default: Node.js `fs/promises` `appendFile`.
   */
  appendFile?: (path: string, data: string) => Promise<void>;

  /**
   * Injectable recursive mkdir — creates `dir` and all parent directories.
   * Default: Node.js `fs/promises` `mkdir` with `{ recursive: true }`.
   */
  mkdirp?: (dir: string) => Promise<void>;

  /**
   * Injectable clock.  Default: `() => Date.now()`.
   * Currently unused by `appendRunLog` itself (timestamp comes from the
   * entry), but provided for future extension.
   */
  now?: () => number;
}

// ── appendRunLog (M4-1 — full implementation) ────────────────────────────────

/**
 * Appends one `RunLogEntry` as a JSONL line to `opts.logFile`.
 *
 * The directory containing `logFile` is created automatically if absent.
 * Each call appends exactly one `\n`-terminated JSON line so the file is
 * valid JSONL (parseable line-by-line).
 *
 * When `opts.enabled` is false the call is a no-op (safe for dry-run mode).
 *
 * **Safety:** append-only — never overwrites existing entries.
 *
 * @param entry - The telemetry entry to append.
 * @param opts  - Telemetry configuration; see `TelemetryOpts`.
 */
export async function appendRunLog(
  entry: RunLogEntry,
  opts?: TelemetryOpts,
): Promise<void> {
  const enabled = opts?.enabled ?? true;
  if (!enabled) return;

  const logFile = opts?.logFile ?? 'logs/run-log.jsonl';

  const appendFileFn =
    opts?.appendFile ??
    (async (p: string, data: string) => {
      const { appendFile } = await import('node:fs/promises');
      await appendFile(p, data);
    });

  const mkdirpFn =
    opts?.mkdirp ??
    (async (dir: string) => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(dir, { recursive: true });
    });

  // Ensure parent directory exists before appending.
  const { dirname } = await import('node:path');
  await mkdirpFn(dirname(logFile));

  await appendFileFn(logFile, JSON.stringify(entry) + '\n');
}

// ── readRunLog ────────────────────────────────────────────────────────────────

/**
 * Parses a JSONL string (one JSON object per line) into a `RunLog`.
 *
 * Lines that are blank or fail to parse are silently skipped so a partially-
 * written file (e.g. a truncated last line) does not break consumers.
 *
 * @param raw - Raw JSONL file contents (e.g. from `fs.readFileSync`).
 * @returns   Ordered array of `RunLogEntry` (oldest first).
 */
export function readRunLog(raw: string): RunLog {
  const entries: RunLog = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        entries.push(parsed as RunLogEntry);
      }
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}
