/**
 * decompose.ts — Planner step M2-P3: roadmap → BACKLOG rows + GitHub Issues
 *
 * Given an approved roadmap document (`roadmap/<slug>.md`), this module:
 *   1. Reads the roadmap file (read-only FS call).
 *   2. Writes a **decomposition work-order** JSON so an external fulfiller
 *      can produce a structured epic/story breakdown.
 *   3. Polls for the fulfiller's result file (with partial-JSON retry guard).
 *   4. Creates GitHub Issues for each item via `gh issue create` (execFile).
 *   5. Appends BACKLOG.md rows (read → splice before "## Later milestones" → write).
 *   6. Waits for a human to add the `backlog-approved` label to the same issue.
 *   7. Returns items, issue numbers, backlog path, and gate result.
 *
 * **Mockable boundaries (all injectable via config):**
 * - `readFile`      — reads roadmap doc, result file, and current BACKLOG.md.
 * - `writeFile`     — writes work-order JSON and updated BACKLOG.md.
 * - `mkdirp`        — creates the orders directory.
 * - `createIssues`  — creates GitHub Issues via `gh issue create`; injectable.
 * - `sleep`         — idle wait between polls; injectable.
 * - `now`           — wall clock for timeout checks; injectable.
 * - `waitForGate`   — polls issue labels for the gate label; injectable.
 *
 * **Safety contract:**
 * - `dryRun=true` → zero FS writes, zero network calls, zero polls. Returns a
 *   clearly-labelled planned result immediately.
 * - Every real side-effect (write, gh call, poll, gate) is guarded behind dryRun.
 * - No subprocess uses shell interpolation — gh calls go through execFile (argv).
 * - `createIssues` is never called on dryRun.
 * - BACKLOG write is never called on dryRun.
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

/** A single work item (epic, story, task, or bug) in the decomposition. */
export interface DecomposeItem {
  /** Unique identifier within the milestone (e.g. "M3-1", "M3-epic"). */
  id: string;
  /** Short title, used as the GitHub issue title. */
  title: string;
  /** Work item kind. */
  type: 'epic' | 'story' | 'task' | 'bug';
  /** Description body used as the GitHub issue body. */
  description: string;
  /**
   * Optional acceptance criteria — appended to the GitHub issue body as a
   * separate section and used as the BACKLOG notes field if no `notes` given.
   */
  acceptanceCriteria?: string;
  /** Optional BACKLOG notes (overrides acceptanceCriteria in BACKLOG rows). */
  notes?: string;
}

/** Shape of the decomposition work-order JSON written by this planner step. */
export interface DecomposeOrderPayload {
  /** Target repo in `owner/name` format. */
  repo: string;
  /** GitHub issue number that the planner is operating on. */
  issueNumber: number;
  /** URL-safe slug derived from the issue number (e.g. `issue-42`). */
  slug: string;
  /** Path to the roadmap document the fulfiller should read as input. */
  roadmapPath: string;
  /** Full content of the roadmap document (embedded for fulfiller convenience). */
  roadmapContent: string;
  /** Path where the fulfiller should append BACKLOG rows (informational). */
  backlogPath: string;
  /** ISO 8601 timestamp of when the work-order was created. */
  requestedAt: string;
}

/**
 * Shape of the result JSON file written by the external decomposition fulfiller.
 * Fulfiller writes `<decomposeOrdersDir>/<slug>.result.json` when done.
 */
export interface DecomposeOrderResult {
  /** True when the decomposition was successfully produced. */
  written: boolean;
  /**
   * Title for the new BACKLOG milestone section header
   * (e.g. "M3 — Monitor"). If omitted, the slug is used.
   */
  milestoneTitle?: string;
  /**
   * Ordered list of epics and stories to create.
   * The fulfiller populates this so the planner can create GitHub Issues
   * and BACKLOG rows without re-parsing markdown.
   */
  items?: DecomposeItem[];
  /** Set by the fulfiller when it could not complete the work-order. */
  error?: string;
}

/** Result returned by a successful `roadmapDecomposePlanner` invocation. */
export interface DecomposeResult {
  /** URL-safe slug for this decomposition (e.g. `issue-42`). */
  slug: string;
  /** Path to the BACKLOG file that was appended (e.g. `state/BACKLOG.md`). */
  backlogPath: string;
  /** Title used for the new BACKLOG milestone section. */
  milestoneTitle: string;
  /** Items produced by the fulfiller (empty on dryRun). */
  items: DecomposeItem[];
  /** GitHub issue numbers created, parallel to `items` (empty on dryRun). */
  issueNumbers: number[];
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
 * Creates GitHub Issues for each `DecomposeItem`.
 * Returns created issue numbers in the same order as `items`.
 * Called only on live (non-dryRun) runs.
 */
export type CreateIssuesFn = (
  repo: string,
  items: DecomposeItem[],
) => Promise<number[]>;

// ---------------------------------------------------------------------------
// Default createIssues (real gh CLI — mutating)
// ---------------------------------------------------------------------------

/**
 * Creates GitHub Issues via `gh issue create`.
 *
 * Uses execFile (argv array) — no shell, no injection risk.
 * **Mutating:** creates resources on GitHub. Never call from dryRun paths.
 *
 * Each item is created individually; the issue URL in stdout is parsed to
 * extract the issue number. Partial failures surface immediately.
 */
export async function createGitHubIssues(
  repo: string,
  items: DecomposeItem[],
): Promise<number[]> {
  const numbers: number[] = [];
  for (const item of items) {
    const body = item.acceptanceCriteria
      ? `${item.description}\n\n## Acceptance Criteria\n${item.acceptanceCriteria}`
      : item.description;
    const { stdout } = await execFileAsync('gh', [
      'issue', 'create',
      '--repo', repo,
      '--title', item.title,
      '--body', body,
    ]);
    // gh outputs the new issue URL: "https://github.com/owner/repo/issues/42\n"
    const match = stdout.trim().match(/\/issues\/(\d+)$/);
    if (!match) {
      throw new Error(
        `Failed to parse issue number from gh output: ${stdout.trim()}`,
      );
    }
    numbers.push(Number(match[1]));
  }
  return numbers;
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
// BACKLOG markdown helpers (exported for unit-testing)
// ---------------------------------------------------------------------------

const BACKLOG_TABLE_HEADER =
  '| ID | GH# | Item | Type | Status | Owner | Notes |\n|---|---|---|---|---|---|---|';

/**
 * Builds a new BACKLOG markdown section string for the given items.
 *
 * Section format:
 * ```
 * \n## Milestone {milestoneTitle} · planned\n\n{table header}\n{rows}
 * ```
 *
 * The trailing `\n` is intentional — it separates this section from whatever
 * follows (either "## Later milestones" or EOF).
 */
export function buildBacklogRows(
  milestoneTitle: string,
  items: DecomposeItem[],
  issueNumbers: number[],
): string {
  const rows = items.map((item, i) => {
    const ghNum = issueNumbers[i] !== undefined ? `#${issueNumbers[i]}` : '—';
    const notes = item.notes
      ?? item.acceptanceCriteria
      ?? item.description.slice(0, 80);
    return `| ${item.id} | ${ghNum} | ${item.title} | ${item.type} | ⬜ ready | — | ${notes} |`;
  });
  return (
    `\n## Milestone ${milestoneTitle} · planned\n\n` +
    `${BACKLOG_TABLE_HEADER}\n` +
    `${rows.join('\n')}\n`
  );
}

/**
 * Inserts `newSection` immediately before the `\n## Later milestones` marker.
 * If the marker is not found, appends `newSection` to the end of `existing`.
 */
export function insertBeforeLaterMilestones(
  existing: string,
  newSection: string,
): string {
  const marker = '\n## Later milestones';
  const idx = existing.indexOf(marker);
  if (idx === -1) {
    return existing + newSection;
  }
  return existing.slice(0, idx) + newSection + existing.slice(idx);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_POLL_TIMEOUT_MS  = 5 * 60 * 1_000;       // 5 min for fulfiller
const DEFAULT_POLL_INTERVAL_MS = 5_000;                  // 5 s between polls
const DEFAULT_GATE_TIMEOUT_MS  = 24 * 60 * 60 * 1_000;  // 24 h for human gate
const DEFAULT_GATE_POLL_MS     = 30_000;                 // 30 s between gate polls

export interface DecomposeConfig {
  /** Target repo in `owner/name` format. */
  repo: string;

  /**
   * Path to BACKLOG.md that will be read and updated.
   * Default: `"state/BACKLOG.md"` (relative to `process.cwd()`).
   */
  backlogPath?: string;

  /**
   * Directory where decomposition work-order and result files are read/written.
   * Default: `"decompose-orders"` (relative to `process.cwd()`).
   */
  decomposeOrdersDir?: string;

  /** Max wall-clock time to wait for the fulfiller to write the result file, ms. Default: 5 min. */
  pollTimeoutMs?: number;

  /** Delay between work-order result poll attempts, ms. Default: 5 s. */
  pollIntervalMs?: number;

  /** Max wall-clock time to wait for the `backlog-approved` label, ms. Default: 24 h. */
  gateTimeoutMs?: number;

  /** Delay between gate poll attempts, ms. Default: 30 s. */
  gatePollIntervalMs?: number;

  /**
   * Injectable FS read function.
   * Returns `undefined` when the file does not exist (suppresses ENOENT).
   * Used for roadmap doc, result file, and reading the current BACKLOG.md.
   * Default: `fs/promises` `readFile` (UTF-8), suppressing ENOENT.
   */
  readFile?: (path: string) => Promise<string | undefined>;

  /**
   * Injectable FS write function.
   * Used for the work-order JSON and updated BACKLOG.md.
   * Default: `fs/promises` `writeFile` (UTF-8).
   */
  writeFile?: (path: string, content: string) => Promise<void>;

  /**
   * Injectable mkdirp (recursive mkdir).
   * Default: `fs/promises` `mkdir` with `{ recursive: true }`.
   */
  mkdirp?: (dir: string) => Promise<void>;

  /**
   * Injectable GitHub Issue creator.
   * Default: real `gh issue create` via execFile. Never called on dryRun.
   */
  createIssues?: CreateIssuesFn;

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
 * Creates a `roadmapDecomposePlanner` function bound to the given config.
 *
 * Inject all deps in tests for hermetic, instant-running test cases:
 * no real timers, no real filesystem I/O, no network, no gh calls.
 *
 * @example Production:
 * ```ts
 * const planner = createRoadmapDecomposePlanner({ repo: 'owner/my-repo' });
 * const result = await planner(42);          // live — creates issues, appends BACKLOG, gates
 * const dryResult = await planner(42, true); // dry-run — zero side-effects
 * ```
 *
 * @example Test (fully injected):
 * ```ts
 * const fs = makeMemFs();
 * const clock = makeFakeClock();
 * const planner = createRoadmapDecomposePlanner({
 *   repo: 'owner/repo',
 *   readFile:     fs.readFile,
 *   writeFile:    fs.writeFile,
 *   mkdirp:       async () => {},
 *   createIssues: vi.fn().mockResolvedValue([10, 11]),
 *   sleep:        clock.sleep,
 *   now:          clock.now,
 *   waitForGate:  async (n, label) => ({ issueNumber: n, label, attempts: 1 }),
 * });
 * ```
 */
export function createRoadmapDecomposePlanner(
  config: DecomposeConfig,
): (issueNumber: number, dryRun?: boolean) => Promise<DecomposeResult> {
  const {
    repo,
    backlogPath         = 'state/BACKLOG.md',
    decomposeOrdersDir  = 'decompose-orders',
    pollTimeoutMs       = DEFAULT_POLL_TIMEOUT_MS,
    pollIntervalMs      = DEFAULT_POLL_INTERVAL_MS,
    gateTimeoutMs       = DEFAULT_GATE_TIMEOUT_MS,
    gatePollIntervalMs  = DEFAULT_GATE_POLL_MS,
    readFile = async (path: string) => {
      try { return await fsReadFile(path, 'utf8'); } catch { return undefined; }
    },
    writeFile = async (path: string, content: string) => {
      await fsWriteFile(path, content, 'utf8');
    },
    mkdirp = async (dir: string) => { await mkdir(dir, { recursive: true }); },
    createIssues = createGitHubIssues,
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
   * Runs the roadmap→decompose planner step for a single issue.
   *
   * @param issueNumber - GitHub issue whose roadmap has been approved.
   * @param dryRun      - When true, returns immediately with zero side-effects.
   */
  return async function planRoadmapDecompose(
    issueNumber: number,
    dryRun = false,
  ): Promise<DecomposeResult> {
    const slug        = issueSlug(issueNumber);
    const roadmapPath = `roadmap/${slug}.md`;

    // ── DRY-RUN SHORT-CIRCUIT ─────────────────────────────────────────────
    if (dryRun) {
      return {
        slug,
        backlogPath,
        milestoneTitle: '',
        items: [],
        issueNumbers: [],
        gateResult: { issueNumber, label: 'backlog-approved', attempts: 0 },
        dryRun: true,
      };
    }
    // ─────────────────────────────────────────────────────────────────────

    // ── 1. Read roadmap document ──────────────────────────────────────────
    const roadmapContent = await readFile(roadmapPath);
    if (roadmapContent === undefined) {
      throw new Error(
        `Roadmap document not found at "${roadmapPath}" for issue #${issueNumber}`,
      );
    }

    // ── 2. Write decompose work-order ─────────────────────────────────────
    await mkdirp(decomposeOrdersDir);

    const orderPath  = join(decomposeOrdersDir, `${slug}.json`);
    const resultPath = join(decomposeOrdersDir, `${slug}.result.json`);

    const payload: DecomposeOrderPayload = {
      repo,
      issueNumber,
      slug,
      roadmapPath,
      roadmapContent,
      backlogPath,
      requestedAt: new Date(now()).toISOString(),
    };
    await writeFile(orderPath, JSON.stringify(payload, null, 2));

    // ── 3. Poll for fulfiller result ──────────────────────────────────────
    const deadline = now() + pollTimeoutMs;
    let result: DecomposeOrderResult | undefined;

    for (;;) {
      const raw = await readFile(resultPath);

      if (raw !== undefined) {
        // Guard against partial writes: if the fulfiller hasn't finished
        // flushing the file, JSON.parse may receive truncated content.
        // Treat a SyntaxError as "not ready yet" and continue polling.
        try {
          result = JSON.parse(raw) as DecomposeOrderResult;
        } catch {
          // Partial/malformed JSON — fulfiller still writing; retry after sleep.
          if (now() >= deadline) {
            throw new Error(
              `Decompose work-order timed out after ${pollTimeoutMs}ms (slug: ${slug})`,
            );
          }
          await sleep(pollIntervalMs);
          continue;
        }

        if (result.error !== undefined) {
          throw new Error(`Decompose fulfiller error for ${slug}: ${result.error}`);
        }

        if (!result.written) {
          throw new Error(`Decompose fulfiller reported written=false for ${slug}`);
        }

        break; // decomposition ready — proceed to GitHub issues + BACKLOG
      }

      if (now() >= deadline) {
        throw new Error(
          `Decompose work-order timed out after ${pollTimeoutMs}ms (slug: ${slug})`,
        );
      }

      await sleep(pollIntervalMs);
    }

    // ── 4. Create GitHub Issues ───────────────────────────────────────────
    const items: DecomposeItem[] = result?.items ?? [];
    const issueNumbers = items.length > 0
      ? await createIssues(repo, items)
      : [];

    // ── 5. Append BACKLOG rows ────────────────────────────────────────────
    const milestoneTitle = result?.milestoneTitle ?? slug;
    if (items.length > 0) {
      const existing    = (await readFile(backlogPath)) ?? '';
      const newSection  = buildBacklogRows(milestoneTitle, items, issueNumbers);
      const updated     = insertBeforeLaterMilestones(existing, newSection);
      await writeFile(backlogPath, updated);
    }

    // ── 6. Wait for human gate (backlog-approved label) ───────────────────
    const gateResult = await gateWatcher(issueNumber, 'backlog-approved', gateTimeoutMs);

    return { slug, backlogPath, milestoneTitle, items, issueNumbers, gateResult };
  };
}

// ---------------------------------------------------------------------------
// Convenience top-level export
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper: creates a one-shot planner and immediately invokes it.
 *
 * Prefer `createRoadmapDecomposePlanner` when processing multiple issues or in
 * tight loops (avoids re-creating the closure each time).
 */
export async function decomposeRoadmap(
  opts: DecomposeConfig & { issueNumber: number; dryRun?: boolean },
): Promise<DecomposeResult> {
  const { issueNumber, dryRun, ...config } = opts;
  return createRoadmapDecomposePlanner(config)(issueNumber, dryRun);
}
