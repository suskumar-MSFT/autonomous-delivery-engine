/**
 * poller.ts — Edge-triggered external watcher (M2-2)
 *
 * Polls GitHub at short intervals and fires `runLoop` only when a NEW event
 * is detected vs a stored cursor.  No webhooks — pure polling (ADR-022).
 *
 * Watched event classes:
 *   - PR merged:    a pull request transitioned to merged state
 *   - Issue ready:  an issue has (or gained) a `ready` label
 *
 * Cursor:
 *   - A JSON file (`cursorFile`) persists the latest-seen timestamps per class.
 *   - First run (no cursor file): writes a baseline and does NOT fire, so
 *     stale already-merged PRs don't trigger spurious loop runs.
 *   - Subsequent runs: compare fetched timestamps to cursor; fire once per
 *     iteration that has at least one new event.
 *
 * Safety contract:
 *   - All external I/O (gh queries, cursor file, sleep, clock) is injectable
 *     — every boundary is mockable in tests without live processes or files.
 *   - dryRun propagates through `runLoopOpts` to `runLoop` — zero loop
 *     side-effects when `runLoopOpts.live` is false/unset.
 *   - Cursor is written BEFORE firing `runLoop` so a crash during the loop
 *     does not re-fire the same events on the next poll.
 *   - `maxIterations` bounds the poll loop for deterministic tests.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { CommandRunner } from '../agents/builder.js';
import { DefaultCommandRunner } from '../agents/builder.js';
import { runLoop } from './loop-runner.js';
import type { LoopRunnerOpts, LoopRunResult } from './loop-runner.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persisted state: latest-seen timestamps per event class. */
export interface EventCursor {
  /** ISO timestamp of the most-recently-seen merged PR. */
  latestPrMergedAt?: string;
  /** ISO timestamp of the most-recently-seen ready-labeled issue. */
  latestReadyIssueUpdatedAt?: string;
}

/** A single detected event that can trigger a `runLoop` call. */
export interface LoopEvent {
  /** Which class of event this is. */
  kind: 'pr-merged' | 'issue-ready';
  /** ISO timestamp of the event. */
  timestamp: string;
}

/** Options for `pollEvents`. */
export interface PollEventsOpts {
  /**
   * Target repo in `owner/name` format
   * (e.g. `suskumar-MSFT/autonomous-delivery-engine`).
   */
  repo: string;

  /**
   * Path to the JSON cursor file.
   * Created automatically on the first run (bootstrap pass — no fire).
   */
  cursorFile: string;

  /**
   * Options forwarded verbatim to `runLoop` on each triggered fire.
   * Set `live: false` (the default) to keep `runLoop` in dry-run mode.
   */
  runLoopOpts: LoopRunnerOpts;

  /**
   * Milliseconds to wait between poll iterations.
   * Default: 30_000 (30 seconds).
   */
  pollIntervalMs?: number;

  /**
   * Maximum number of poll iterations before returning.
   * `undefined` (the default) means run indefinitely.
   * Use a finite number in tests to bound execution.
   */
  maxIterations?: number;

  /**
   * Injectable CommandRunner used for the `gh` event-fetch queries.
   * Defaults to `new DefaultCommandRunner()` when omitted.
   * Note: separate from `runLoopOpts.runner`, which handles CI/merge calls.
   */
  runner?: CommandRunner;

  /**
   * Injectable sleep — `(ms) => Promise<void>`.
   * Default: `setTimeout`-based real sleep.
   */
  sleep?: (ms: number) => Promise<void>;

  /**
   * Injectable clock.  Default: `() => Date.now()`.
   * Currently unused internally but provided for future extension.
   */
  now?: () => number;

  /**
   * Injectable cursor file reader.
   * Must return the raw file contents, or `null` when the file does not exist.
   * Default: Node.js `readFileSync` (returns `null` on ENOENT).
   */
  readFile?: (path: string) => string | null;

  /**
   * Injectable cursor file writer.
   * Default: Node.js `writeFileSync`.
   */
  writeFile?: (path: string, content: string) => void;
}

/** Result returned by `pollEvents` after `maxIterations` iterations. */
export interface PollEventsResult {
  /** Number of poll iterations completed. */
  iterations: number;
  /** Number of times `runLoop` was fired (new-event batches). */
  fires: number;
  /** `LoopRunResult` from each fire, in order. */
  loopResults: LoopRunResult[];
}

// ---------------------------------------------------------------------------
// Default I/O helpers
// ---------------------------------------------------------------------------

function defaultReadFile(p: string): string | null {
  try {
    return readFileSync(p, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function defaultWriteFile(p: string, content: string): void {
  writeFileSync(p, content, 'utf8');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * Reads the cursor file.
 * Returns `null` when the file does not exist (bootstrap case),
 * or `{}` when the file is present but unparseable.
 */
export function readCursor(
  readFile: (p: string) => string | null,
  cursorFile: string,
): EventCursor | null {
  const raw = readFile(cursorFile);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as EventCursor;
    }
    return {};
  } catch {
    return {};
  }
}

/** Serialises and writes a cursor to `cursorFile`. */
export function writeCursor(
  writeFile: (p: string, c: string) => void,
  cursorFile: string,
  cursor: EventCursor,
): void {
  writeFile(cursorFile, JSON.stringify(cursor, null, 2));
}

// ---------------------------------------------------------------------------
// GitHub event fetchers (read-only gh calls — no side-effects)
// ---------------------------------------------------------------------------

/**
 * Returns the ISO `mergedAt` timestamps of up to 20 recently closed PRs.
 * Closed-but-not-merged PRs have `mergedAt: null` in the JSON and are filtered out.
 */
export async function fetchMergedPrTimestamps(
  runner: CommandRunner,
  repo: string,
): Promise<string[]> {
  const result = await runner.run('gh', [
    'pr', 'list',
    '--repo', repo,
    '--state', 'closed',
    '--json', 'number,mergedAt',
    '--limit', '20',
  ]);
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>)
      .map(item => String(item['mergedAt'] ?? ''))
      .filter(ts => ts !== '' && ts !== 'null');
  } catch {
    return [];
  }
}

/**
 * Returns the ISO `updatedAt` timestamps of up to 20 open issues with the
 * `ready` label.
 */
export async function fetchReadyIssueTimestamps(
  runner: CommandRunner,
  repo: string,
): Promise<string[]> {
  const result = await runner.run('gh', [
    'issue', 'list',
    '--repo', repo,
    '--label', 'ready',
    '--json', 'number,updatedAt',
    '--limit', '20',
  ]);
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Record<string, unknown>>)
      .map(item => String(item['updatedAt'] ?? ''))
      .filter(ts => ts !== '' && ts !== 'null');
  } catch {
    return [];
  }
}

/** Returns the latest (maximum) ISO timestamp string, or `undefined` if the array is empty. */
export function latestTimestamp(timestamps: string[]): string | undefined {
  if (timestamps.length === 0) return undefined;
  return timestamps.reduce((a, b) => (a > b ? a : b));
}

// ---------------------------------------------------------------------------
// Event detection
// ---------------------------------------------------------------------------

/**
 * Compares fetched timestamps against the stored cursor and returns any
 * events that are newer than the cursor (i.e. not yet seen).
 *
 * An event is "new" when:
 *   - The cursor has no entry for that class (first time that class fires), OR
 *   - The fetched latest timestamp is strictly greater than the cursor entry.
 */
export function detectNewEvents(
  cursor: EventCursor,
  mergedPrTimestamps: string[],
  readyIssueTimestamps: string[],
): LoopEvent[] {
  const events: LoopEvent[] = [];

  const latestPr = latestTimestamp(mergedPrTimestamps);
  if (latestPr !== undefined) {
    if (cursor.latestPrMergedAt === undefined || latestPr > cursor.latestPrMergedAt) {
      events.push({ kind: 'pr-merged', timestamp: latestPr });
    }
  }

  const latestIssue = latestTimestamp(readyIssueTimestamps);
  if (latestIssue !== undefined) {
    if (
      cursor.latestReadyIssueUpdatedAt === undefined ||
      latestIssue > cursor.latestReadyIssueUpdatedAt
    ) {
      events.push({ kind: 'issue-ready', timestamp: latestIssue });
    }
  }

  return events;
}

/**
 * Returns a new cursor with timestamps advanced to cover all `events`.
 * Does not mutate the input cursor.
 */
export function advanceCursor(cursor: EventCursor, events: LoopEvent[]): EventCursor {
  const updated: EventCursor = { ...cursor };
  for (const ev of events) {
    if (ev.kind === 'pr-merged') {
      if (
        updated.latestPrMergedAt === undefined ||
        ev.timestamp > updated.latestPrMergedAt
      ) {
        updated.latestPrMergedAt = ev.timestamp;
      }
    } else if (ev.kind === 'issue-ready') {
      if (
        updated.latestReadyIssueUpdatedAt === undefined ||
        ev.timestamp > updated.latestReadyIssueUpdatedAt
      ) {
        updated.latestReadyIssueUpdatedAt = ev.timestamp;
      }
    }
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Polls GitHub for new events and fires `runLoop` when any are detected.
 *
 * **Bootstrap behaviour (first run):**
 * When `cursorFile` does not exist, `pollEvents` writes the current GitHub
 * state as the baseline cursor and does NOT fire `runLoop`.  This prevents
 * spurious runs from events that already occurred before the poller started.
 *
 * **Subsequent runs:**
 * Each iteration fetches event timestamps from GitHub and compares them to
 * the cursor.  If any class has a timestamp newer than the cursor, `runLoop`
 * is fired exactly once for that iteration (regardless of how many classes
 * changed).  The cursor is advanced before `runLoop` is called so that a
 * crash inside `runLoop` does not re-fire the same events.
 *
 * **Iteration cap:**
 * When `maxIterations` is set, the loop terminates after that many iterations
 * and returns a `PollEventsResult`.  This is the intended mode for tests.
 * When unset, the loop runs indefinitely (production daemon mode).
 *
 * **Sleep:**
 * After each iteration (except the final one when `maxIterations` is reached),
 * `pollEvents` calls `sleep(pollIntervalMs)`.  Inject a no-op to make tests fast.
 *
 * @param opts - Poll configuration; see `PollEventsOpts`.
 * @returns `PollEventsResult` (only when `maxIterations` is finite).
 */
export async function pollEvents(opts: PollEventsOpts): Promise<PollEventsResult> {
  const {
    repo,
    cursorFile,
    runLoopOpts,
    pollIntervalMs = 30_000,
    maxIterations,
    sleep = defaultSleep,
    readFile = defaultReadFile,
    writeFile = defaultWriteFile,
  } = opts;

  const runner: CommandRunner = opts.runner ?? new DefaultCommandRunner();

  let iterations = 0;
  let fires = 0;
  const loopResults: LoopRunResult[] = [];

  while (maxIterations === undefined || iterations < maxIterations) {
    // ── Fetch current state from GitHub (read-only) ───────────────────────
    const [mergedPrTimestamps, readyIssueTimestamps] = await Promise.all([
      fetchMergedPrTimestamps(runner, repo),
      fetchReadyIssueTimestamps(runner, repo),
    ]);

    // ── Read cursor ───────────────────────────────────────────────────────
    const cursor = readCursor(readFile, cursorFile);

    if (cursor === null) {
      // ── Bootstrap: first run — write baseline, do NOT fire ──────────────
      const baseline: EventCursor = {};
      const latestPr = latestTimestamp(mergedPrTimestamps);
      const latestIssue = latestTimestamp(readyIssueTimestamps);
      if (latestPr !== undefined) baseline.latestPrMergedAt = latestPr;
      if (latestIssue !== undefined) baseline.latestReadyIssueUpdatedAt = latestIssue;
      writeCursor(writeFile, cursorFile, baseline);
    } else {
      // ── Detect new events and fire if any found ───────────────────────
      const newEvents = detectNewEvents(cursor, mergedPrTimestamps, readyIssueTimestamps);

      if (newEvents.length > 0) {
        // Advance cursor BEFORE firing — crash-safe (no re-fire on restart)
        const updatedCursor = advanceCursor(cursor, newEvents);
        writeCursor(writeFile, cursorFile, updatedCursor);

        const loopResult = await runLoop(runLoopOpts);
        fires++;
        loopResults.push(loopResult);
      }
    }

    iterations++;

    // ── Sleep between polls (skip after the last iteration) ──────────────
    if (maxIterations === undefined || iterations < maxIterations) {
      await sleep(pollIntervalMs);
    }
  }

  return { iterations, fires, loopResults };
}
