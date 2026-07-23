/**
 * vision-to-roadmap.ts — Planner step M2-P2: vision doc → roadmap doc + GitHub Milestones
 *
 * Given an approved vision document (`vision/<slug>.md`), this module:
 *   1. Reads the vision file (read-only FS call).
 *   2. Writes a **roadmap work-order** JSON so an external fulfiller (work-claw
 *      sub-agent) can produce `roadmap/<slug>.md` and a structured milestone list.
 *   3. Polls for the fulfiller's result file (which carries the parsed milestones).
 *   4. Creates GitHub Milestones for each entry in the result via `gh` API.
 *   5. Waits for a human to add the `roadmap-approved` label to the same issue.
 *   6. Returns the slug, roadmap path, milestones created, and gate result.
 *
 * **Mockable boundaries (all injectable via config):**
 * - `readFile`         — reads vision doc + result file; injectable for hermetic tests.
 * - `writeFile`        — writes the roadmap work-order JSON; injectable.
 * - `mkdirp`           — creates the orders directory; injectable.
 * - `createMilestones` — creates GitHub Milestones via `gh` API; injectable.
 * - `sleep`            — idle wait between polls; injectable.
 * - `now`              — wall clock for timeout checks; injectable.
 * - `waitForGate`      — polls issue labels for the gate label; injectable.
 *
 * **Safety contract:**
 * - `dryRun=true` → zero FS writes, zero network calls, zero polls. Returns a
 *   clearly-labelled planned result immediately.
 * - Every real side-effect (write, gh call, poll, gate) is guarded behind dryRun.
 * - No subprocess uses shell interpolation — gh calls go through execFile (argv array).
 * - `createMilestones` is never called on dryRun.
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

/** A single milestone produced by the roadmap fulfiller. */
export interface RoadmapMilestone {
  /** Short title for the milestone (e.g. "M1 — Foundations"). */
  title: string;
  /** One-line goal / exit criteria description. */
  description: string;
}

/** Shape of the roadmap work-order JSON file written by this planner step. */
export interface RoadmapOrderPayload {
  /** Target repo in `owner/name` format. */
  repo: string;
  /** GitHub issue number that the planner is operating on. */
  issueNumber: number;
  /** URL-safe slug derived from the issue number (e.g. `issue-42`). */
  slug: string;
  /** Path to the vision document that the fulfiller should read as input. */
  visionPath: string;
  /** Full content of the vision document (embedded for fulfiller convenience). */
  visionContent: string;
  /** Relative path where the fulfiller should write the roadmap doc. */
  roadmapPath: string;
  /** ISO 8601 timestamp of when the work-order was created. */
  requestedAt: string;
}

/**
 * Shape of the result JSON file written by the external roadmap fulfiller.
 * Fulfiller writes `<roadmapOrdersDir>/<slug>.result.json` when done.
 */
export interface RoadmapOrderResult {
  /** True when the roadmap doc was successfully written to `roadmapPath`. */
  written: boolean;
  /** Path where the fulfiller wrote the roadmap doc (should match `roadmapPath`). */
  roadmapPath?: string;
  /**
   * Structured milestones parsed from the roadmap doc.
   * The fulfiller populates this so the planner can create GitHub Milestones
   * without re-parsing the markdown.
   */
  milestones?: RoadmapMilestone[];
  /** Set by the fulfiller when it could not complete the work-order. */
  error?: string;
}

/** Result returned by a successful `visionToRoadmapPlanner` invocation. */
export interface VisionToRoadmapResult {
  /** URL-safe slug for this roadmap (e.g. `issue-42`). */
  slug: string;
  /** Path to the written roadmap doc (e.g. `roadmap/issue-42.md`). */
  roadmapPath: string;
  /** Milestones that were created on GitHub (empty array on dryRun). */
  milestones: RoadmapMilestone[];
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

/**
 * Creates GitHub Milestones from a list of `RoadmapMilestone` entries.
 * Called only on live (non-dryRun) runs.
 */
export type CreateMilestonesFn = (
  repo: string,
  milestones: RoadmapMilestone[],
) => Promise<void>;

// ---------------------------------------------------------------------------
// Default createMilestones (real gh API — mutating)
// ---------------------------------------------------------------------------

/**
 * Creates GitHub Milestones via `gh api` (POST).
 *
 * Uses execFile (argv array) — no shell, no injection risk.
 * **Mutating:** creates resources on GitHub. Never call from dryRun paths.
 *
 * Each milestone is posted individually; partial failures surface immediately.
 */
export async function createGitHubMilestones(
  repo: string,
  milestones: RoadmapMilestone[],
): Promise<void> {
  for (const m of milestones) {
    await execFileAsync('gh', [
      'api',
      `repos/${repo}/milestones`,
      '--method', 'POST',
      '--field', `title=${m.title}`,
      '--field', `description=${m.description}`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// Slug helper (re-exported for tests; same logic as idea-to-vision)
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

const DEFAULT_POLL_TIMEOUT_MS  = 5 * 60 * 1_000;       // 5 min for fulfiller
const DEFAULT_POLL_INTERVAL_MS = 5_000;                  // 5 s between polls
const DEFAULT_GATE_TIMEOUT_MS  = 24 * 60 * 60 * 1_000;  // 24 h for human gate
const DEFAULT_GATE_POLL_MS     = 30_000;                 // 30 s between gate polls

export interface VisionToRoadmapConfig {
  /** Target repo in `owner/name` format. */
  repo: string;

  /**
   * Directory where roadmap work-order and result files are read/written.
   * Default: `"roadmap-orders"` (relative to `process.cwd()`).
   */
  roadmapOrdersDir?: string;

  /** Max wall-clock time to wait for the fulfiller to write the result file, ms. Default: 5 min. */
  pollTimeoutMs?: number;

  /** Delay between work-order result poll attempts, ms. Default: 5 s. */
  pollIntervalMs?: number;

  /** Max wall-clock time to wait for the `roadmap-approved` label, ms. Default: 24 h. */
  gateTimeoutMs?: number;

  /** Delay between gate poll attempts, ms. Default: 30 s. */
  gatePollIntervalMs?: number;

  /**
   * Injectable FS read function.
   * Returns `undefined` when the file does not exist.
   * Default: `fs/promises` `readFile` (UTF-8), suppressing ENOENT.
   */
  readFile?: (path: string) => Promise<string | undefined>;

  /**
   * Injectable FS write function.
   * Default: `fs/promises` `writeFile` (UTF-8).
   */
  writeFile?: (path: string, content: string) => Promise<void>;

  /**
   * Injectable mkdirp (recursive mkdir).
   * Default: `fs/promises` `mkdir` with `{ recursive: true }`.
   */
  mkdirp?: (dir: string) => Promise<void>;

  /**
   * Injectable GitHub Milestone creator.
   * Default: real `gh api` POST via execFile. Never called on dryRun.
   */
  createMilestones?: CreateMilestonesFn;

  /**
   * Injectable sleep function.
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
 * Creates a `visionToRoadmapPlanner` function bound to the given config.
 *
 * Inject all deps in tests for hermetic, instant-running test cases:
 * no real timers, no real filesystem I/O, no network, no gh calls.
 *
 * @example Production:
 * ```ts
 * const planner = createVisionToRoadmapPlanner({ repo: 'owner/my-repo' });
 * const result = await planner(42);          // live — writes files, creates milestones, gates
 * const dryResult = await planner(42, true); // dry-run — zero side-effects
 * ```
 *
 * @example Test (fully injected):
 * ```ts
 * const fs = makeMemFs();
 * const clock = makeFakeClock();
 * const planner = createVisionToRoadmapPlanner({
 *   repo: 'owner/repo',
 *   readFile: fs.readFile,
 *   writeFile: fs.writeFile,
 *   mkdirp: async () => {},
 *   createMilestones: vi.fn(),
 *   sleep: clock.sleep,
 *   now: clock.now,
 *   waitForGate: async (n, label) => ({ issueNumber: n, label, attempts: 1 }),
 * });
 * ```
 */
export function createVisionToRoadmapPlanner(
  config: VisionToRoadmapConfig,
): (issueNumber: number, dryRun?: boolean) => Promise<VisionToRoadmapResult> {
  const {
    repo,
    roadmapOrdersDir    = 'roadmap-orders',
    pollTimeoutMs       = DEFAULT_POLL_TIMEOUT_MS,
    pollIntervalMs      = DEFAULT_POLL_INTERVAL_MS,
    gateTimeoutMs       = DEFAULT_GATE_TIMEOUT_MS,
    gatePollIntervalMs  = DEFAULT_GATE_POLL_MS,
    readFile = async (path: string) => {
      try { return await fsReadFile(path, 'utf8'); } catch { return undefined; }
    },
    writeFile = async (path: string, content: string) => { await fsWriteFile(path, content, 'utf8'); },
    mkdirp    = async (dir: string) => { await mkdir(dir, { recursive: true }); },
    createMilestones = createGitHubMilestones,
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    now   = () => Date.now(),
  } = config;

  // Build gate function if not injected — shares sleep/now with poll loop.
  const gateWatcher = config.waitForGate ?? createGateWatcher({
    repo,
    sleep,
    now,
    pollIntervalMs: gatePollIntervalMs,
  });

  /**
   * Runs the vision→roadmap planner step for a single issue.
   *
   * @param issueNumber - GitHub issue whose vision has been approved.
   * @param dryRun      - When true, returns immediately with zero side-effects.
   */
  return async function planVisionToRoadmap(
    issueNumber: number,
    dryRun = false,
  ): Promise<VisionToRoadmapResult> {
    const slug        = issueSlug(issueNumber);
    const visionPath  = `vision/${slug}.md`;
    const roadmapPath = `roadmap/${slug}.md`;

    // ── DRY-RUN SHORT-CIRCUIT ─────────────────────────────────────────────
    if (dryRun) {
      return {
        slug,
        roadmapPath,
        milestones: [],
        gateResult: { issueNumber, label: 'roadmap-approved', attempts: 0 },
        dryRun: true,
      };
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── 1. Read vision document ───────────────────────────────────────────
    const visionContent = await readFile(visionPath);
    if (visionContent === undefined) {
      throw new Error(
        `Vision document not found at "${visionPath}" for issue #${issueNumber}`,
      );
    }

    // ── 2. Write roadmap work-order ───────────────────────────────────────
    await mkdirp(roadmapOrdersDir);

    const orderPath  = join(roadmapOrdersDir, `${slug}.json`);
    const resultPath = join(roadmapOrdersDir, `${slug}.result.json`);

    const payload: RoadmapOrderPayload = {
      repo,
      issueNumber,
      slug,
      visionPath,
      visionContent,
      roadmapPath,
      requestedAt: new Date(now()).toISOString(),
    };
    await writeFile(orderPath, JSON.stringify(payload, null, 2));

    // ── 3. Poll for fulfiller result ──────────────────────────────────────
    const deadline = now() + pollTimeoutMs;
    let result: RoadmapOrderResult | undefined;

    for (;;) {
      const raw = await readFile(resultPath);

      if (raw !== undefined) {
        // Guard against partial writes: if the fulfiller hasn't finished
        // flushing the file, JSON.parse may receive truncated content.
        // Treat a SyntaxError as "not ready yet" and continue polling.
        try {
          result = JSON.parse(raw) as RoadmapOrderResult;
        } catch {
          // Partial/malformed JSON — fulfiller still writing; retry after sleep.
          if (now() >= deadline) {
            throw new Error(
              `Roadmap work-order timed out after ${pollTimeoutMs}ms (slug: ${slug})`,
            );
          }
          await sleep(pollIntervalMs);
          continue;
        }

        if (result.error !== undefined) {
          throw new Error(`Roadmap fulfiller error for ${slug}: ${result.error}`);
        }

        if (!result.written) {
          throw new Error(`Roadmap fulfiller reported written=false for ${slug}`);
        }

        break; // roadmap doc written — proceed to milestone creation
      }

      if (now() >= deadline) {
        throw new Error(
          `Roadmap work-order timed out after ${pollTimeoutMs}ms (slug: ${slug})`,
        );
      }

      await sleep(pollIntervalMs);
    }

    // ── 4. Create GitHub Milestones ───────────────────────────────────────
    const milestones: RoadmapMilestone[] = result?.milestones ?? [];
    if (milestones.length > 0) {
      await createMilestones(repo, milestones);
    }

    // ── 5. Wait for human gate (roadmap-approved label) ───────────────────
    const gateResult = await gateWatcher(issueNumber, 'roadmap-approved', gateTimeoutMs);

    return { slug, roadmapPath, milestones, gateResult };
  };
}

// ---------------------------------------------------------------------------
// Convenience top-level export
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: creates a one-shot planner and immediately invokes it.
 *
 * Prefer `createVisionToRoadmapPlanner` when processing multiple issues or in
 * tight loops (avoids re-creating the closure each time).
 */
export async function visionToRoadmap(
  opts: VisionToRoadmapConfig & { issueNumber: number; dryRun?: boolean },
): Promise<VisionToRoadmapResult> {
  const { issueNumber, dryRun, ...config } = opts;
  return createVisionToRoadmapPlanner(config)(issueNumber, dryRun);
}
