/**
 * idea-to-vision.ts — Planner step M2-P1: idea issue → vision doc (M2-P1)
 *
 * Given a GitHub issue containing a raw idea, this module:
 *   1. Fetches the issue title + body (read-only gh call).
 *   2. Writes a **vision work-order** JSON so an external fulfiller (work-claw
 *      sub-agent) can produce `vision/<slug>.md`.
 *   3. Polls for the fulfiller's result file.
 *   4. Waits for a human to add the `vision-approved` label to the same issue.
 *   5. Returns the slug, vision path, and gate result.
 *
 * **Mockable boundaries (all injectable via config):**
 * - `fetchIssue`   — reads issue title+body via `gh`; injectable for hermetic tests.
 * - `writeFile`    — writes the vision work-order JSON; injectable.
 * - `readFile`     — reads the fulfiller result file; injectable.
 * - `mkdirp`       — creates the orders directory; injectable.
 * - `sleep`        — idle wait between polls; injectable.
 * - `now`          — wall clock for timeout checks; injectable.
 * - `waitForGate`  — polls issue labels for the gate label; injectable.
 *
 * **Safety contract:**
 * - `dryRun=true` → zero FS writes, zero network calls, zero polls. Returns a
 *   clearly-labelled planned result immediately.
 * - Every real side-effect (write, poll, gate) is guarded behind the dryRun flag.
 * - No subprocess uses shell interpolation — gh calls go through execFile (argv array).
 */

import { execFile as _execFile } from 'node:child_process';
import { writeFile as fsWriteFile, readFile as fsReadFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createGateWatcher, type GateResult } from './gate.js';

const execFileAsync = promisify(_execFile);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Shape of the vision work-order JSON file written by this planner step. */
export interface VisionOrderPayload {
  /** Target repo in `owner/name` format. */
  repo: string;
  /** GitHub issue number that contains the raw idea. */
  issueNumber: number;
  /** URL-safe slug derived from the issue number (e.g. `issue-42`). */
  slug: string;
  /** Relative path where the fulfiller should write the vision doc. */
  visionPath: string;
  /** Issue title (the idea in brief). */
  ideaTitle: string;
  /** Issue body (the full idea description). */
  ideaBody: string;
  /** ISO 8601 timestamp of when the work-order was created. */
  requestedAt: string;
}

/**
 * Shape of the result JSON file written by the external vision fulfiller.
 * Fulfiller writes `<visionOrdersDir>/<slug>.result.json` when done.
 */
export interface VisionOrderResult {
  /** True when the vision doc was successfully written to `visionPath`. */
  written: boolean;
  /** Path where the fulfiller wrote the vision doc (should match `visionPath`). */
  visionPath?: string;
  /** Set by the fulfiller when it could not complete the work-order. */
  error?: string;
}

/** Result returned by a successful `ideaToVisionPlanner` invocation. */
export interface IdeaToVisionResult {
  /** URL-safe slug for this vision (e.g. `issue-42`). */
  slug: string;
  /** Path to the written vision doc (e.g. `vision/issue-42.md`). */
  visionPath: string;
  /**
   * Gate result from `waitForGate`.
   * `attempts` is 0 on dryRun runs.
   */
  gateResult: GateResult;
  /** Present (true) when the run was a dry-run; absent on live runs. */
  dryRun?: true;
}

// ---------------------------------------------------------------------------
// Injectable dependency types
// ---------------------------------------------------------------------------

/** Fetches issue title and body from GitHub. */
export type FetchIssueFn = (
  repo: string,
  issueNumber: number,
) => Promise<{ title: string; body: string }>;

// ---------------------------------------------------------------------------
// Default fetchIssue (real gh CLI — read-only)
// ---------------------------------------------------------------------------

/**
 * Fetches issue title and body via `gh issue view`.
 * Uses execFile (argv array) — no shell, no injection risk.
 * Read-only: does not create, update, or delete anything.
 */
export async function fetchIssueDetails(
  repo: string,
  issueNumber: number,
): Promise<{ title: string; body: string }> {
  const { stdout } = await execFileAsync('gh', [
    'issue', 'view', String(issueNumber),
    '--repo', repo,
    '--json', 'title,body',
  ]);
  const parsed = JSON.parse(stdout) as { title?: unknown; body?: unknown };
  return {
    title: String(parsed.title ?? ''),
    body: String(parsed.body ?? ''),
  };
}

// ---------------------------------------------------------------------------
// Slug helper
// ---------------------------------------------------------------------------

/**
 * Derives a deterministic, URL-safe slug from an issue number.
 * e.g. issue 42 → `"issue-42"`
 */
export function issueSlug(issueNumber: number): string {
  return `issue-${issueNumber}`;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_POLL_TIMEOUT_MS  = 5 * 60 * 1_000;  // 5 min for fulfiller
const DEFAULT_POLL_INTERVAL_MS = 5_000;             // 5 s between polls
const DEFAULT_GATE_TIMEOUT_MS  = 24 * 60 * 60 * 1_000; // 24 h for human gate
const DEFAULT_GATE_POLL_MS     = 30_000;            // 30 s between gate polls

export interface IdeaToVisionConfig {
  /** Target repo in `owner/name` format. */
  repo: string;

  /**
   * Directory where vision work-order and result files are read/written.
   * Default: `"vision-orders"` (relative to `process.cwd()`).
   */
  visionOrdersDir?: string;

  /** Max wall-clock time to wait for the fulfiller to write the result file, ms. Default: 5 min. */
  pollTimeoutMs?: number;

  /** Delay between work-order result poll attempts, ms. Default: 5 s. */
  pollIntervalMs?: number;

  /** Max wall-clock time to wait for the `vision-approved` label, ms. Default: 24 h. */
  gateTimeoutMs?: number;

  /** Delay between gate poll attempts, ms. Default: 30 s. */
  gatePollIntervalMs?: number;

  /**
   * Injectable issue fetcher.
   * Default: real `gh issue view` via execFile.
   */
  fetchIssue?: FetchIssueFn;

  /**
   * Injectable FS write function.
   * Default: `fs/promises` `writeFile` (UTF-8).
   */
  writeFile?: (path: string, content: string) => Promise<void>;

  /**
   * Injectable FS read function.
   * Returns `undefined` when the file does not exist.
   * Default: `fs/promises` `readFile` (UTF-8), suppressing ENOENT.
   */
  readFile?: (path: string) => Promise<string | undefined>;

  /**
   * Injectable mkdirp (recursive mkdir).
   * Default: `fs/promises` `mkdir` with `{ recursive: true }`.
   */
  mkdirp?: (dir: string) => Promise<void>;

  /**
   * Injectable sleep function (used for both work-order poll and gate poll).
   * Default: real `setTimeout`-based sleep.
   */
  sleep?: (ms: number) => Promise<void>;

  /**
   * Injectable clock for deterministic timeout tests.
   * Default: `Date.now`.
   */
  now?: () => number;

  /**
   * Injectable gate function bound to (issueNumber, label, timeoutMs).
   * Default: `createGateWatcher({ repo, sleep, now, pollIntervalMs: gatePollIntervalMs })`.
   * Inject a stub in tests to decouple from label-polling logic.
   */
  waitForGate?: (issueNumber: number, label: string, timeoutMs: number) => Promise<GateResult>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an `ideaToVisionPlanner` function bound to the given config.
 *
 * Inject all deps in tests for hermetic, instant-running test cases:
 * no real timers, no real filesystem I/O, no network, no gh calls.
 *
 * @example Production:
 * ```ts
 * const planner = createIdeaToVisionPlanner({ repo: 'owner/my-repo' });
 * const result = await planner(42);        // live — writes files, polls, gates
 * const dryResult = await planner(42, true); // dry-run — zero side-effects
 * ```
 *
 * @example Test (fully injected):
 * ```ts
 * const fs = makeMemFs();
 * const clock = makeFakeClock();
 * const planner = createIdeaToVisionPlanner({
 *   repo: 'owner/repo',
 *   fetchIssue: async () => ({ title: 'My Idea', body: 'Details...' }),
 *   writeFile: fs.writeFile,
 *   readFile: fs.readFile,
 *   mkdirp: async () => {},
 *   sleep: clock.sleep,
 *   now: clock.now,
 *   waitForGate: async (n, label) => ({ issueNumber: n, label, attempts: 1 }),
 * });
 * ```
 */
export function createIdeaToVisionPlanner(
  config: IdeaToVisionConfig,
): (issueNumber: number, dryRun?: boolean) => Promise<IdeaToVisionResult> {
  const {
    repo,
    visionOrdersDir = 'vision-orders',
    pollTimeoutMs    = DEFAULT_POLL_TIMEOUT_MS,
    pollIntervalMs   = DEFAULT_POLL_INTERVAL_MS,
    gateTimeoutMs    = DEFAULT_GATE_TIMEOUT_MS,
    gatePollIntervalMs = DEFAULT_GATE_POLL_MS,
    fetchIssue = fetchIssueDetails,
    writeFile  = async (path: string, content: string) => { await fsWriteFile(path, content, 'utf8'); },
    readFile   = async (path: string) => {
      try { return await fsReadFile(path, 'utf8'); } catch { return undefined; }
    },
    mkdirp     = async (dir: string) => { await mkdir(dir, { recursive: true }); },
    sleep      = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    now        = () => Date.now(),
  } = config;

  // Build gate function if not injected — shares sleep/now with poll loop.
  const gateWatcher = config.waitForGate ?? createGateWatcher({
    repo,
    sleep,
    now,
    pollIntervalMs: gatePollIntervalMs,
  });

  /**
   * Runs the idea→vision planner step for a single issue.
   *
   * @param issueNumber - GitHub issue containing the raw idea.
   * @param dryRun      - When true, returns immediately with zero side-effects.
   */
  return async function planIdeaToVision(
    issueNumber: number,
    dryRun = false,
  ): Promise<IdeaToVisionResult> {
    const slug      = issueSlug(issueNumber);
    const visionPath = `vision/${slug}.md`;

    // ── DRY-RUN SHORT-CIRCUIT ─────────────────────────────────────────────
    if (dryRun) {
      return {
        slug,
        visionPath,
        gateResult: { issueNumber, label: 'vision-approved', attempts: 0 },
        dryRun: true,
      };
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── 1. Fetch issue ────────────────────────────────────────────────────
    const { title, body } = await fetchIssue(repo, issueNumber);

    // ── 2. Write vision work-order ────────────────────────────────────────
    await mkdirp(visionOrdersDir);

    const orderPath  = join(visionOrdersDir, `${slug}.json`);
    const resultPath = join(visionOrdersDir, `${slug}.result.json`);

    const payload: VisionOrderPayload = {
      repo,
      issueNumber,
      slug,
      visionPath,
      ideaTitle: title,
      ideaBody:  body,
      requestedAt: new Date(now()).toISOString(),
    };
    await writeFile(orderPath, JSON.stringify(payload, null, 2));

    // ── 3. Poll for fulfiller result ──────────────────────────────────────
    const deadline = now() + pollTimeoutMs;
    for (;;) {
      const raw = await readFile(resultPath);

      if (raw !== undefined) {
        // Guard against partial writes: if the fulfiller hasn't finished
        // flushing the file, JSON.parse may receive truncated content.
        // Treat a SyntaxError as "not ready yet" and continue polling.
        let result: VisionOrderResult;
        try {
          result = JSON.parse(raw) as VisionOrderResult;
        } catch {
          // Partial/malformed JSON — fulfiller still writing; retry after sleep.
          if (now() >= deadline) {
            throw new Error(
              `Vision work-order timed out after ${pollTimeoutMs}ms (slug: ${slug})`,
            );
          }
          await sleep(pollIntervalMs);
          continue;
        }

        if (result.error !== undefined) {
          throw new Error(`Vision fulfiller error for ${slug}: ${result.error}`);
        }

        if (!result.written) {
          throw new Error(`Vision fulfiller reported written=false for ${slug}`);
        }

        break; // vision doc written — proceed to gate
      }

      if (now() >= deadline) {
        throw new Error(
          `Vision work-order timed out after ${pollTimeoutMs}ms (slug: ${slug})`,
        );
      }

      await sleep(pollIntervalMs);
    }

    // ── 4. Wait for human gate (vision-approved label) ────────────────────
    const gateResult = await gateWatcher(issueNumber, 'vision-approved', gateTimeoutMs);

    return { slug, visionPath, gateResult };
  };
}

// ---------------------------------------------------------------------------
// Convenience top-level export
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: creates a one-shot planner and immediately invokes it.
 *
 * Prefer `createIdeaToVisionPlanner` when processing multiple issues or in
 * tight loops (avoids re-creating the closure each time).
 */
export async function ideaToVision(
  opts: IdeaToVisionConfig & { issueNumber: number; dryRun?: boolean },
): Promise<IdeaToVisionResult> {
  const { issueNumber, dryRun, ...config } = opts;
  return createIdeaToVisionPlanner(config)(issueNumber, dryRun);
}
