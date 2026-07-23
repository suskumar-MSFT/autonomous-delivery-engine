import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBacklog } from '../state/parsers.js';
import { selectNextUnit } from './selector.js';
import type { BacklogItem } from '../state/parsers.js';
import {
  runBuilder,
  DefaultCommandRunner,
  type BuilderResult,
  type BuilderOptions,
  type CommandRunner,
} from '../agents/builder.js';
import { claimOwnerInFile, releaseOwnerInFile } from '../state/owner.js';
import { getCIStatus, extractPrNumber } from '../github/checks.js';
import type { Reviewer } from './reviewer.js';

// ---------------------------------------------------------------------------
// Repo validation — independent of builderFn (defense-in-depth, M1-5)
// ---------------------------------------------------------------------------

/** Must match owner/name — no shell metacharacters allowed. */
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Validates the repo string before any network or subprocess call.
 * Duplicated from builder.ts intentionally: runOnce must guard this
 * regardless of which builderFn is injected.
 */
function validateRepo(repo: string): void {
  if (!REPO_RE.test(repo)) {
    throw new Error(
      `Invalid repo "${repo}": expected "owner/name" format (letters, digits, hyphens, dots only)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default wall-clock cap per loop pass: 10 minutes. */
const DEFAULT_CAP_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoopCap {
  /** Wall-clock milliseconds before a pass is considered timed-out. Default: 10 min. */
  capMs?: number;
}

/**
 * Outcome of the merge gate at the end of a `runOnce` pass.
 *
 * - `merged`            – All gates passed; `gh pr merge` was called.
 * - `dry-run`           – Pass ran in dry-run mode (no live actions).
 * - `no-pr`             – Builder did not produce a PR URL.
 * - `blocked-ci`        – Required CI check was not green.
 * - `blocked-reviewer`  – Independent reviewer returned NEEDS_FIX.
 * - `capped`            – Wall-clock cap exceeded before all gates passed.
 */
export type MergeStatus =
  | 'merged'
  | 'dry-run'
  | 'no-pr'
  | 'blocked-ci'
  | 'blocked-reviewer'
  | 'capped';

export interface RunOnceOptions {
  repo: string;
  checkoutDir: string;
  stateDir: string;
  runner?: CommandRunner;
  /**
   * Independent reviewer hook.  Called after a PR exists, before the merge
   * gate.  Mock in tests — DO NOT inject a live reviewer in CI.
   * When omitted, the reviewer gate is skipped (treated as PASS).
   */
  reviewer?: Reviewer;
  /**
   * When true, runs the builder in live mode (dryRun:false) and evaluates
   * the merge gate.  Default: false (dry-run — zero side-effects).
   */
  live?: boolean;
  /**
   * Coarse cap configuration.
   */
  cap?: LoopCap;
  /**
   * Injectable start timestamp (milliseconds since epoch) for deterministic
   * cap testing.  Default: `now()` at the top of `runOnce`.
   */
  startedAt?: number;
  /**
   * Injectable clock for deterministic cap testing.  Default: `Date.now`.
   * When `startedAt` is omitted it defaults to `now()`.
   */
  now?: () => number;
  /**
   * Injectable builder function.  Default: `runBuilder` from agents/builder.ts.
   * Inject a mock in tests to decouple loop logic from the builder subprocess chain.
   */
  builderFn?: (opts: BuilderOptions) => Promise<BuilderResult>;
}

export interface RunOnceResult {
  selected: BacklogItem | undefined;
  result: BuilderResult | null;
  /**
   * Outcome of the merge gate.  `null` when no unit was selected.
   */
  mergeStatus: MergeStatus | null;
}

// ---------------------------------------------------------------------------
// runOnce — one pass of the autonomous delivery loop
// ---------------------------------------------------------------------------

/**
 * One pass of the autonomous delivery loop.
 *
 * Dry-run path (default, `live` not set or false):
 *   1. Reads BACKLOG.md → selects the next ready+unowned unit.
 *   2. Runs the builder with dryRun:true (no subprocess, no file mutations).
 *   3. Returns `{ selected, result, mergeStatus: 'dry-run' }`.
 *   No subprocess is invoked; no file is mutated.  Safe to call anywhere.
 *
 * Live path (`live: true`):
 *   1. Reads BACKLOG.md → selects the next ready+unowned unit.
 *   2. Claims ownership in BACKLOG.md (idempotent).
 *   3. Runs the builder with dryRun:false (real subprocess chain).
 *   4. If a PR URL was produced:
 *      a. Updates ownership in BACKLOG.md to record the PR.
 *      b. Checks the required CI check `build-and-test` via `gh pr checks`.
 *      c. Calls the optional Reviewer hook.
 *      d. Enforces the wall-clock cap.
 *      e. When all gates pass: calls `gh pr merge --squash --delete-branch`.
 *   5. Returns `{ selected, result, mergeStatus }`.
 *
 * All subprocess calls (gh, git, npm, claude) go through `runner`
 * (CommandRunner).  Inject a mock in tests — no live network in CI.
 *
 * Security: repo is validated via REPO_RE at the top of `runOnce` (M1-5),
 * independently of whichever builderFn is injected.
 * All gh/git calls use execFile argv form — no shell interpolation.
 */
export async function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  const {
    repo,
    checkoutDir,
    stateDir,
    runner,
    reviewer,
    live = false,
    builderFn = runBuilder,
    now = Date.now,
  } = opts;
  const startedAt = opts.startedAt ?? now();
  const capMs = opts.cap?.capMs ?? DEFAULT_CAP_MS;

  // ── 0. Validate repo (defense-in-depth — independent of builderFn) ────────
  validateRepo(repo);

  // ── 1. Read + parse backlog ───────────────────────────────────────────────
  const backlogMd = readFileSync(join(stateDir, 'BACKLOG.md'), 'utf8');
  const backlogItems = parseBacklog(backlogMd);
  const selected = selectNextUnit(backlogItems);

  if (!selected) {
    return { selected: undefined, result: null, mergeStatus: null };
  }

  // ── 2. Live only: claim ownership BEFORE dispatching builder ─────────────
  //    dryRun path must not mutate files (ADR-017 / no-side-effects contract).
  if (live) {
    claimOwnerInFile(stateDir, selected.id, 'bot');
  }

  // ── 3. Run builder ────────────────────────────────────────────────────────
  const result = await builderFn({
    repo,
    issueNumber: selected.ghNumber,
    checkoutDir,
    dryRun: !live,
    runner,
  });

  // ── 4. Dry-run early return ───────────────────────────────────────────────
  if (!live) {
    return { selected, result, mergeStatus: 'dry-run' };
  }

  // ── 5. Live: no PR URL → builder did not open a PR ───────────────────────
  if (!result.prUrl) {
    return { selected, result, mergeStatus: 'no-pr' };
  }

  // ── 6. Update ownership to record PR URL ─────────────────────────────────
  releaseOwnerInFile(stateDir, selected.id, `bot (${result.prUrl})`);

  // ── 7. Wall-clock cap (pre-gate) ─────────────────────────────────────────
  if (now() - startedAt > capMs) {
    return { selected, result, mergeStatus: 'capped' };
  }

  // ── 8. Gate: CI check `build-and-test` must be green ─────────────────────
  const prNumber = extractPrNumber(result.prUrl);
  if (prNumber === null) {
    // Malformed PR URL — treat as CI blocked
    return { selected, result, mergeStatus: 'blocked-ci' };
  }

  const effectiveRunner: CommandRunner = runner ?? new DefaultCommandRunner();
  const ciStatus = await getCIStatus(effectiveRunner, repo, prNumber, 'build-and-test');
  if (ciStatus !== 'green') {
    return { selected, result, mergeStatus: 'blocked-ci' };
  }

  // ── 9. Gate: independent reviewer verdict ────────────────────────────────
  if (reviewer) {
    const reviewResult = await reviewer.review({
      repo,
      prNumber,
      branch: result.branch,
    });
    if (reviewResult.verdict !== 'PASS') {
      return { selected, result, mergeStatus: 'blocked-reviewer' };
    }
  }

  // ── 10. Wall-clock cap (post-reviewer) ───────────────────────────────────
  if (now() - startedAt > capMs) {
    return { selected, result, mergeStatus: 'capped' };
  }

  // ── 11. All gates passed — merge (ADR-017: controller is the merge actor) ─
  //    argv form: no shell, no string interpolation.
  await effectiveRunner.run('gh', [
    'pr', 'merge', String(prNumber),
    '--repo', repo,
    '--squash',
    '--delete-branch',
  ]);

  return { selected, result, mergeStatus: 'merged' };
}
