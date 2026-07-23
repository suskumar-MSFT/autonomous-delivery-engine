/**
 * fix-dispatcher.ts — Fix dispatcher (M3-3)
 *
 * Given a filed GitHub issue number, writes a fix work-order JSON file that
 * the work-order fulfiller schedule will pick up and process.
 *
 * The work-order format matches `WorkOrderPayload` in
 * `src/agents/work-order-builder.ts` so the existing fulfiller can drive the
 * fix without any changes to the fulfiller contract.
 *
 * Safety invariants:
 *   - `dryRun: true` → zero file writes, zero subprocess calls, zero
 *     directory creation.  Returns `workOrderPath: null`.
 *   - All FS mutations go through injectable `writeFile` / `mkdirp` seams.
 *   - No `CommandRunner` is needed: this module only writes a local file.
 *   - Writes are atomic in intent: the work-order file is written before
 *     returning, so the fulfiller never sees a partial payload.
 */

import { writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ── Public types ──────────────────────────────────────────────────────────────

/** Result returned by `dispatchFix`. */
export interface FixDispatchResult {
  /**
   * Absolute path to the work-order file that was written.
   * `null` when `dryRun` is true (no file was written).
   */
  workOrderPath: string | null;

  /** The issue number for which the fix was dispatched. */
  issueNumber: number;

  /** True when this call was a dry run (no file writes were made). */
  dryRun: boolean;
}

/** Options for `dispatchFix`. */
export interface FixDispatcherOpts {
  /** Target repo in `owner/name` format — written into the work-order. */
  repo: string;

  /**
   * The GitHub issue number to fix.  This becomes the file name
   * (`<issueNumber>.json`) in `workOrdersDir`, matching the fulfiller convention.
   */
  issueNumber: number;

  /**
   * Absolute path to the engine checkout — written into the work-order so the
   * fulfiller knows where to run `claude -p`.
   */
  checkoutDir: string;

  /**
   * When true, no file is written and no directory is created.
   * Returns `workOrderPath: null` immediately.  Default: false.
   */
  dryRun?: boolean;

  /**
   * Directory where work-order files are written.
   * Default: `"work-orders"` (relative to `process.cwd()`), matching the
   * `createWorkOrderBuilder` default so both sides share the same directory.
   */
  workOrdersDir?: string;

  /**
   * Injectable file writer for the work-order JSON.
   * Default: `fs/promises` `writeFile` (UTF-8).
   */
  writeFile?: (path: string, data: string) => Promise<void>;

  /**
   * Injectable mkdirp (recursive mkdir).
   * Default: `fs/promises` `mkdir` with `{ recursive: true }`.
   */
  mkdirp?: (dir: string) => Promise<void>;

  /**
   * Injectable clock for the `requestedAt` timestamp.
   * Default: `Date.now`.
   */
  now?: () => number;
}

// ── Shape of the work-order file ─────────────────────────────────────────────

/**
 * The payload written to `<workOrdersDir>/<issueNumber>.json`.
 *
 * Intentionally mirrors `WorkOrderPayload` in
 * `src/agents/work-order-builder.ts` so the existing fulfiller schedule can
 * process monitor-filed fix issues without modification.
 */
interface WorkOrderPayload {
  repo: string;
  issueNumber: number;
  branch: string;
  checkoutDir: string;
  /** ISO 8601 timestamp of when the work-order was created. */
  requestedAt: string;
}

// ── dispatchFix ───────────────────────────────────────────────────────────────

/**
 * Writes a fix work-order JSON for `issueNumber` so the fulfiller schedule
 * can drive `claude -p` on the fix branch.
 *
 * **dryRun behaviour:** when `dryRun` is true, this function performs ZERO
 * side-effects (no `mkdirp`, no `writeFile`) and returns immediately with
 * `workOrderPath: null`.
 *
 * **File layout:**
 * ```
 * <workOrdersDir>/
 *   <issueNumber>.json        ← written by this function
 *   <issueNumber>.result.json ← written by the fulfiller (polled by WorkOrderBuilder)
 * ```
 *
 * @param opts - Fix dispatcher configuration; see `FixDispatcherOpts`.
 * @returns `FixDispatchResult` describing what happened.
 */
export async function dispatchFix(opts: FixDispatcherOpts): Promise<FixDispatchResult> {
  const {
    repo,
    issueNumber,
    checkoutDir,
    dryRun = false,
    workOrdersDir = 'work-orders',
    now = Date.now,
  } = opts;

  const writeFileFn =
    opts.writeFile ??
    (async (path: string, data: string) => {
      await fsWriteFile(path, data, 'utf8');
    });

  const mkdirpFn =
    opts.mkdirp ??
    (async (dir: string) => {
      await mkdir(dir, { recursive: true });
    });

  // ── DRY-RUN SHORT-CIRCUIT ─────────────────────────────────────────────────
  if (dryRun) {
    return { workOrderPath: null, issueNumber, dryRun: true };
  }

  // ── Ensure work-orders directory exists ───────────────────────────────────
  await mkdirpFn(workOrdersDir);

  // ── Write work-order file ─────────────────────────────────────────────────
  const branch = `fix/issue-${issueNumber}`;
  const workOrderPath = join(workOrdersDir, `${issueNumber}.json`);

  const payload: WorkOrderPayload = {
    repo,
    issueNumber,
    branch,
    checkoutDir,
    requestedAt: new Date(now()).toISOString(),
  };

  await writeFileFn(workOrderPath, JSON.stringify(payload, null, 2));

  return { workOrderPath, issueNumber, dryRun: false };
}
