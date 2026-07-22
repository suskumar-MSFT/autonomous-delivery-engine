import { writeFile as fsWriteFile, readFile as fsReadFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuilderOptions, BuilderResult } from './builder.js';

// ---------------------------------------------------------------------------
// Work-order + result shapes
// ---------------------------------------------------------------------------

/** Shape of the work-order JSON file written by this builder. */
export interface WorkOrderPayload {
  repo: string;
  issueNumber: number;
  branch: string;
  checkoutDir: string;
  /** ISO 8601 timestamp of when the work-order was created. */
  requestedAt: string;
}

/**
 * Shape of the result JSON file written by an external fulfiller.
 * Either a success payload or an error payload.
 */
export interface WorkOrderResult {
  prUrl?: string | null;
  branch?: string;
  testsPassed?: boolean;
  implemented?: boolean;
  /** Set by the fulfiller when it cannot complete the work-order. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Builder config — all external dependencies are injectable for hermeticity
// ---------------------------------------------------------------------------

const DEFAULT_POLL_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes
const DEFAULT_POLL_INTERVAL_MS = 5_000;          // 5 seconds

export interface WorkOrderBuilderConfig {
  /**
   * Directory where work-order files are read/written.
   * Default: `"work-orders"` (relative to `process.cwd()`).
   */
  workOrdersDir?: string;
  /** Max wall-clock time to wait for a result file, ms. Default: 5 minutes. */
  pollTimeoutMs?: number;
  /** Delay between poll attempts, ms. Default: 5 seconds. */
  pollIntervalMs?: number;
  /** Injectable clock — `Date.now` in production. */
  now?: () => number;
  /** Injectable sleep — real `setTimeout` in production. */
  sleep?: (ms: number) => Promise<void>;
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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a WorkOrderBuilder function that satisfies the
 * `(opts: BuilderOptions) => Promise<BuilderResult>` contract used by
 * `loop.ts` / `runOnce`.
 *
 * Instead of invoking Claude directly the builder writes a work-order JSON
 * file and polls for an external fulfiller to write the matching result file.
 *
 * dryRun contract: when `opts.dryRun` is `true`, NO file is written, NO poll
 * is attempted — returns a planned result immediately (mirrors M1-1 behaviour
 * exactly).
 *
 * All side-effecting dependencies are injectable so tests are hermetic:
 * no real timers, no real filesystem I/O, no network.
 *
 * @example
 * ```ts
 * // Production use — wired into loop.ts as builderFn:
 * const builder = createWorkOrderBuilder();
 *
 * // Test use — fully injected:
 * const builder = createWorkOrderBuilder({
 *   workOrdersDir: tmpDir,
 *   pollTimeoutMs: 100,
 *   pollIntervalMs: 10,
 *   now: fakeNow,
 *   sleep: fakeSleep,
 *   writeFile: fakeWrite,
 *   readFile: fakeRead,
 *   mkdirp: async () => {},
 * });
 * ```
 */
export function createWorkOrderBuilder(
  config: WorkOrderBuilderConfig = {},
): (opts: BuilderOptions) => Promise<BuilderResult> {
  const {
    workOrdersDir = 'work-orders',
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = Date.now,
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    writeFile = async (path: string, content: string) => {
      await fsWriteFile(path, content, 'utf8');
    },
    readFile = async (path: string) => {
      try {
        return await fsReadFile(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    mkdirp = async (dir: string) => {
      await mkdir(dir, { recursive: true });
    },
  } = config;

  return async function workOrderBuilder(opts: BuilderOptions): Promise<BuilderResult> {
    const { repo, issueNumber, checkoutDir, dryRun = false } = opts;

    const branch = `feat/issue-${issueNumber}`;

    // ── DRY-RUN SHORT-CIRCUIT ─────────────────────────────────────────────
    // When dryRun is true: write NO file, poll NOTHING — immediate return.
    // This mirrors the M1-1 dryRun-is-truly-dry contract.
    if (dryRun) {
      return {
        branch,
        prUrl: null,
        testsPassed: false,
        implemented: false,
        dryRun: true,
      };
    }

    // ── Write work-order ──────────────────────────────────────────────────
    await mkdirp(workOrdersDir);

    const workOrderPath = join(workOrdersDir, `${issueNumber}.json`);
    const payload: WorkOrderPayload = {
      repo,
      issueNumber,
      branch,
      checkoutDir,
      requestedAt: new Date(now()).toISOString(),
    };
    await writeFile(workOrderPath, JSON.stringify(payload, null, 2));

    // ── Poll for result ───────────────────────────────────────────────────
    const resultPath = join(workOrdersDir, `${issueNumber}.result.json`);
    const deadline = now() + pollTimeoutMs;

    for (;;) {
      const raw = await readFile(resultPath);

      if (raw !== undefined) {
        // Result file appeared — parse and map to BuilderResult
        const result = JSON.parse(raw) as WorkOrderResult;

        if (result.error !== undefined) {
          // Fulfiller reported an error
          return {
            branch: result.branch ?? branch,
            prUrl: null,
            testsPassed: false,
            implemented: false,
          };
        }

        return {
          branch: result.branch ?? branch,
          prUrl: result.prUrl ?? null,
          testsPassed: result.testsPassed ?? false,
          implemented: result.implemented ?? false,
        };
      }

      // Result not yet available — check deadline before sleeping
      if (now() >= deadline) {
        // Timed out — return a clear error result (not a hang)
        return {
          branch,
          prUrl: null,
          testsPassed: false,
          implemented: false,
        };
      }

      await sleep(pollIntervalMs);
    }
  };
}

// ---------------------------------------------------------------------------
// Default export — convenience singleton with production defaults
// ---------------------------------------------------------------------------

/**
 * Drop-in WorkOrderBuilder with production defaults.
 * Wire into `runOnce` via `builderFn: WorkOrderBuilder`.
 */
export const WorkOrderBuilder: (opts: BuilderOptions) => Promise<BuilderResult> =
  createWorkOrderBuilder();
