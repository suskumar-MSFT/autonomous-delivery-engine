/**
 * gate.ts — Human gate harness (M2-P4)
 *
 * `waitForGate` polls a GitHub issue's labels at a short interval and resolves
 * when the expected gate label appears.  Every Planner stage uses this to pause
 * the loop at a human-review checkpoint without busy-spinning.
 *
 * **Mockable boundaries:**
 * - `fetchLabels` — wraps `gh` CLI via execFile; injectable for hermetic tests.
 * - `sleep` — real `setTimeout` in production; injectable for instant tests.
 * - `now` — `Date.now` in production; injectable for deterministic timeout tests.
 *
 * **Safety:** this module makes NO filesystem mutations and NO side-effecting
 * subprocess calls beyond reading issue labels.  It is a read-only polling helper.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(_execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Configuration for the gate watcher (all external deps are injectable). */
export interface GateWatcherConfig {
  /** Target repo in `owner/name` format. */
  repo: string;

  /**
   * Injectable label fetcher.
   * Given (repo, issueNumber), returns the current set of label strings.
   * Default: real `gh` CLI call via `execFile` (no shell, no injection risk).
   */
  fetchLabels?: (repo: string, issueNumber: number) => Promise<string[]>;

  /**
   * Injectable sleep function.
   * Default: real `setTimeout`-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;

  /**
   * Injectable clock.
   * Default: `Date.now`.
   */
  now?: () => number;

  /**
   * Delay between poll attempts in milliseconds.
   * Default: 10 000 ms (10 seconds).
   */
  pollIntervalMs?: number;
}

/** Resolved result of a successful `waitForGate` call. */
export interface GateResult {
  /** The issue number that was polled. */
  issueNumber: number;
  /** The gate label that was found. */
  label: string;
  /** Number of poll attempts made (including the successful one). */
  attempts: number;
}

/**
 * Thrown when the gate label does not appear before `timeoutMs` elapses.
 * Callers can inspect `issueNumber`, `label`, `timeoutMs`, and `attempts`.
 */
export class GateTimeoutError extends Error {
  constructor(
    public readonly issueNumber: number,
    public readonly label: string,
    public readonly timeoutMs: number,
    public readonly attempts: number,
  ) {
    super(
      `Gate timeout: label "${label}" not found on issue #${issueNumber} ` +
      `after ${timeoutMs}ms (${attempts} poll attempt${attempts === 1 ? '' : 's'})`,
    );
    this.name = 'GateTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Default fetchLabels (real gh CLI — read-only)
// ---------------------------------------------------------------------------

/**
 * Fetches the current label names for a single GitHub issue using `gh api`.
 * Uses execFile (argv array) — no shell, no injection risk.
 * Read-only: does not create, update, or delete anything on GitHub.
 */
export async function fetchIssueLabels(
  repo: string,
  issueNumber: number,
): Promise<string[]> {
  const { stdout } = await execFileAsync('gh', [
    'api',
    `repos/${repo}/issues/${issueNumber}`,
    '--jq', '.labels[].name',
  ]);
  // `--jq` returns one label name per line (empty string when no labels)
  return stdout
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a `waitForGate` function bound to the given config.
 * Inject all deps in tests for hermetic, instant-running test loops.
 *
 * @example Production:
 * ```ts
 * const waitForGate = createGateWatcher({ repo: 'owner/my-repo' });
 * await waitForGate(42, 'vision-approved', 24 * 60 * 60 * 1000); // up to 24h
 * ```
 *
 * @example Test (fully injected):
 * ```ts
 * const labels = new Map<number, string[]>([[42, []]]);
 * const clock = makeFakeClock();
 * const waitForGate = createGateWatcher({
 *   repo: 'owner/repo',
 *   fetchLabels: async (_repo, n) => labels.get(n) ?? [],
 *   sleep: clock.sleep,
 *   now: clock.now,
 *   pollIntervalMs: 50,
 * });
 * ```
 */
export function createGateWatcher(
  config: GateWatcherConfig,
): (issueNumber: number, label: string, timeoutMs: number) => Promise<GateResult> {
  const {
    repo,
    fetchLabels = fetchIssueLabels,
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
    pollIntervalMs = 10_000,
  } = config;

  /**
   * Polls `issueNumber`'s labels until `label` appears, then resolves.
   * Rejects with `GateTimeoutError` if `timeoutMs` elapses first.
   *
   * Polling model:
   *   1. Fetch labels immediately (attempt 1).
   *   2. If found → resolve.
   *   3. If deadline would be exceeded on next iteration → reject.
   *   4. Otherwise sleep `pollIntervalMs` and repeat.
   *
   * The deadline is checked AFTER a successful fetch that did not find the
   * label — so we always make at least one fetch attempt.
   */
  return async function waitForGate(
    issueNumber: number,
    label: string,
    timeoutMs: number,
  ): Promise<GateResult> {
    const deadline = now() + timeoutMs;
    let attempts = 0;

    for (;;) {
      attempts++;
      const labels = await fetchLabels(repo, issueNumber);

      if (labels.includes(label)) {
        return { issueNumber, label, attempts };
      }

      // Label not found — check if deadline has passed
      if (now() >= deadline) {
        throw new GateTimeoutError(issueNumber, label, timeoutMs, attempts);
      }

      await sleep(pollIntervalMs);
    }
  };
}

// ---------------------------------------------------------------------------
// Convenience top-level export
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: creates a one-shot `GateWatcher` and immediately calls it.
 *
 * Prefer `createGateWatcher` when polling multiple issues or in tight loops
 * (avoids re-creating the closure each time).
 */
export async function waitForGate(
  opts: GateWatcherConfig & {
    issueNumber: number;
    label: string;
    timeoutMs: number;
  },
): Promise<GateResult> {
  const { issueNumber, label, timeoutMs, ...config } = opts;
  const watcher = createGateWatcher(config);
  return watcher(issueNumber, label, timeoutMs);
}
