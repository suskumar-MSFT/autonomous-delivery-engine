/**
 * tests/core/gated-merge.test.ts
 *
 * Tests for M1-3: ownership-claim + gated-merge + reviewer-pass hook.
 *
 * All subprocess calls are mocked — NO live gh/claude/npm/git in CI.
 * File I/O uses temporary directories so fixtures are never mutated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runOnce } from '../../src/core/loop.js';
import type { CommandRunner, BuilderResult, BuilderOptions, RunResult, RunOptions } from '../../src/agents/builder.js';
import type { Reviewer } from '../../src/core/reviewer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTH_FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'state');

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpStateDir(sourceDir = SYNTH_FIXTURE_DIR): string {
  const dir = join(
    tmpdir(),
    `engine-merge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  copyFileSync(join(sourceDir, 'BACKLOG.md'), join(dir, 'BACKLOG.md'));
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const FAKE_PR_URL = 'https://github.com/owner/repo/pull/42';
const FAKE_BRANCH = 'feat/issue-2';

/** Builds a BuilderResult that looks like a successful live build with a PR. */
function liveBuilderResult(overrides: Partial<BuilderResult> = {}): BuilderResult {
  return {
    branch: FAKE_BRANCH,
    prUrl: FAKE_PR_URL,
    testsPassed: true,
    implemented: true,
    ...overrides,
  };
}

/** BuilderResult that succeeded but produced no PR. */
function noprBuilderResult(): BuilderResult {
  return { branch: FAKE_BRANCH, prUrl: null, testsPassed: false, implemented: false };
}

/** Mock builder function that immediately returns a pre-set result. */
function mockBuilderFn(result: BuilderResult): (opts: BuilderOptions) => Promise<BuilderResult> {
  return async () => result;
}

const CI_GREEN_RESPONSE = JSON.stringify([{ name: 'build-and-test', state: 'SUCCESS' }]);
const CI_RED_RESPONSE = JSON.stringify([{ name: 'build-and-test', state: 'FAILURE' }]);
const CI_PENDING_RESPONSE = JSON.stringify([{ name: 'build-and-test', state: 'IN_PROGRESS' }]);

type MockSpec = Record<string, { stdout?: string; stderr?: string; code?: number }>;

function makeMockRunner(spec: MockSpec): CommandRunner {
  return {
    async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
      const key = [cmd, ...args].join(' ');
      const entry = spec[key] ?? Object.entries(spec).find(([k]) => key.startsWith(k))?.[1];
      if (!entry) throw new Error(`MockRunner: unexpected call: ${key}`);
      return { stdout: entry.stdout ?? '', stderr: entry.stderr ?? '', code: entry.code ?? 0 };
    },
  };
}

/** A runner that must NEVER be called (asserts zero subprocess calls). */
function noCallRunner(): CommandRunner {
  return {
    async run(cmd, args) {
      throw new Error(`runner.run() must not be called: ${cmd} ${args.join(' ')}`);
    },
  };
}

/** Mock reviewer returning PASS. */
function passReviewer(): Reviewer {
  return { review: async () => ({ verdict: 'PASS', notes: 'Looks good' }) };
}

/** Mock reviewer returning NEEDS_FIX. */
function failReviewer(): Reviewer {
  return { review: async () => ({ verdict: 'NEEDS_FIX', notes: 'Found a bug' }) };
}

/** Base spec for a gated-merge scenario: CI green + merge succeeds. */
function mergeSpec(ciResponse = CI_GREEN_RESPONSE): MockSpec {
  return {
    'gh pr checks 42 --repo owner/repo --json name,state': { stdout: ciResponse, code: 0 },
    'gh pr merge 42 --repo owner/repo --squash --delete-branch': { stdout: '', code: 0 },
  };
}

// ---------------------------------------------------------------------------
// Dry-run mode (existing contract — must remain green)
// ---------------------------------------------------------------------------

describe('runOnce dry-run (backward compat)', () => {
  it('returns dry-run mergeStatus in dryRun mode', async () => {
    const { selected, result, mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: SYNTH_FIXTURE_DIR, // read-only; no file writes in dryRun
      runner: noCallRunner(),
    });
    expect(selected).toBeDefined();
    expect(result?.dryRun).toBe(true);
    expect(mergeStatus).toBe('dry-run');
  });

  it('returns null mergeStatus when no unit is selected', async () => {
    // Copy the empty-backlog fixture into a temp dir so we can pass it safely
    const emptyDir = join(__dirname, '..', 'fixtures', 'empty-backlog');
    const { selected, result, mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: emptyDir,
      runner: noCallRunner(),
    });
    expect(selected).toBeUndefined();
    expect(result).toBeNull();
    expect(mergeStatus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ownership claim — live path
// ---------------------------------------------------------------------------

describe('ownership claim (live path)', () => {
  it('claims ownership in BACKLOG.md before builder dispatch', async () => {
    const stateDir = makeTmpStateDir();
    const backlogBefore = readFileSync(join(stateDir, 'BACKLOG.md'), 'utf8');
    // M0-1 is ready+unowned in the synthetic fixture
    const row0 = backlogBefore.split('\n').find(l => l.includes('| M0-1'));
    expect(row0?.split('|')[6]?.trim()).toBe(''); // confirm unowned

    await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner(mergeSpec()),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
    });

    const backlogAfter = readFileSync(join(stateDir, 'BACKLOG.md'), 'utf8');
    // The row must now have a non-empty owner
    const rowAfter = backlogAfter.split('\n').find(l => l.includes('| M0-1'));
    expect(rowAfter).toBeDefined();
    // After merge it gets released to 'bot (PR URL)'
    expect(rowAfter!.split('|')[6].trim()).not.toBe('');
  });

  it('claim is idempotent: does not double-claim an already-owned unit', async () => {
    const stateDir = makeTmpStateDir();
    // Pre-write owner so the unit appears owned
    const before = readFileSync(join(stateDir, 'BACKLOG.md'), 'utf8');
    writeFileSync(
      join(stateDir, 'BACKLOG.md'),
      before.replace('| M0-1   | 2    | hello-loop vertical slice          | story   | ready       |       |',
                     '| M0-1   | 2    | hello-loop vertical slice          | story   | ready       | alice |'),
      'utf8',
    );

    // With M0-1 pre-owned, selectNextUnit should skip it and either pick
    // another ready item or return undefined.  Either way, claimOwner
    // must NOT overwrite 'alice'.
    await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner({
        'gh pr checks 1 --repo owner/repo --json name,state': { stdout: CI_GREEN_RESPONSE, code: 0 },
        'gh pr checks 42 --repo owner/repo --json name,state': { stdout: CI_GREEN_RESPONSE, code: 0 },
        'gh pr merge 1 --repo owner/repo --squash --delete-branch': { stdout: '', code: 0 },
        'gh pr merge 42 --repo owner/repo --squash --delete-branch': { stdout: '', code: 0 },
      }),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
    }).catch(() => { /* ignore errors from missing PR items */ });

    const after = readFileSync(join(stateDir, 'BACKLOG.md'), 'utf8');
    const rowM01 = after.split('\n').find(l => {
      const cells = l.split('|');
      return cells.length > 1 && cells[1].trim() === 'M0-1';
    });
    // alice must not be overwritten by the claim
    if (rowM01) {
      expect(rowM01.split('|')[6].trim()).toBe('alice');
    }
  });

  it('updates ownership on PR open (releases to PR URL)', async () => {
    const stateDir = makeTmpStateDir();

    await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner(mergeSpec()),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
    });

    const after = readFileSync(join(stateDir, 'BACKLOG.md'), 'utf8');
    const row = after.split('\n').find(l => l.includes('| M0-1'));
    expect(row).toBeDefined();
    // Owner should include the PR URL after release
    expect(row!.split('|')[6]).toContain(FAKE_PR_URL);
  });
});

// ---------------------------------------------------------------------------
// Merge gate — happy path
// ---------------------------------------------------------------------------

describe('gated merge — happy path', () => {
  it('merges when CI green + reviewer PASS + within cap', async () => {
    const stateDir = makeTmpStateDir();
    const r = makeMockRunner(mergeSpec());
    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: r,
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
    });
    expect(mergeStatus).toBe('merged');
  });

  it('calls gh pr merge with the correct argv (no shell string)', async () => {
    const stateDir = makeTmpStateDir();
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(cmd, args) {
        calls.push([cmd, ...args].join(' '));
        return { stdout: CI_GREEN_RESPONSE, stderr: '', code: 0 };
      },
    };
    await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner,
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
    });
    const mergeCall = calls.find(c => c.startsWith('gh pr merge'));
    expect(mergeCall).toBeDefined();
    // Must use argv array form (individual args, no shell escaping)
    expect(mergeCall).toBe('gh pr merge 42 --repo owner/repo --squash --delete-branch');
  });

  it('merges without reviewer when no reviewer is configured', async () => {
    const stateDir = makeTmpStateDir();
    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner(mergeSpec()),
      builderFn: mockBuilderFn(liveBuilderResult()),
      // No reviewer
      live: true,
    });
    expect(mergeStatus).toBe('merged');
  });
});

// ---------------------------------------------------------------------------
// Merge gate — blocked paths
// ---------------------------------------------------------------------------

describe('gated merge — blocked by CI', () => {
  it('withholds merge when CI check is red', async () => {
    const stateDir = makeTmpStateDir();
    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner(mergeSpec(CI_RED_RESPONSE)),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
    });
    expect(mergeStatus).toBe('blocked-ci');
  });

  it('withholds merge when CI check is pending', async () => {
    const stateDir = makeTmpStateDir();
    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner(mergeSpec(CI_PENDING_RESPONSE)),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
    });
    expect(mergeStatus).toBe('blocked-ci');
  });

  it('does NOT call gh pr merge when CI is red', async () => {
    const stateDir = makeTmpStateDir();
    const mergeCalls: string[] = [];
    const runner: CommandRunner = {
      async run(cmd, args) {
        const key = [cmd, ...args].join(' ');
        if (key.startsWith('gh pr merge')) mergeCalls.push(key);
        return { stdout: CI_RED_RESPONSE, stderr: '', code: 0 };
      },
    };
    await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner,
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
    });
    expect(mergeCalls).toHaveLength(0);
  });
});

describe('gated merge — blocked by reviewer', () => {
  it('withholds merge when reviewer returns NEEDS_FIX', async () => {
    const stateDir = makeTmpStateDir();
    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner(mergeSpec()),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: failReviewer(),
      live: true,
    });
    expect(mergeStatus).toBe('blocked-reviewer');
  });

  it('does NOT call gh pr merge when reviewer returns NEEDS_FIX', async () => {
    const stateDir = makeTmpStateDir();
    const mergeCalls: string[] = [];
    const runner: CommandRunner = {
      async run(cmd, args) {
        const key = [cmd, ...args].join(' ');
        if (key.startsWith('gh pr merge')) mergeCalls.push(key);
        return { stdout: CI_GREEN_RESPONSE, stderr: '', code: 0 };
      },
    };
    await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner,
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: failReviewer(),
      live: true,
    });
    expect(mergeCalls).toHaveLength(0);
  });
});

describe('gated merge — no PR', () => {
  it('returns no-pr when builder produces no PR URL', async () => {
    const stateDir = makeTmpStateDir();
    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: noCallRunner(),
      builderFn: mockBuilderFn(noprBuilderResult()),
      live: true,
    });
    expect(mergeStatus).toBe('no-pr');
  });
});

// ---------------------------------------------------------------------------
// Wall-clock cap
// ---------------------------------------------------------------------------

describe('wall-clock cap', () => {
  it('returns capped when cap is exceeded before CI check', async () => {
    const stateDir = makeTmpStateDir();
    // startedAt is far in the past; capMs is 1ms → already over cap
    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      // Runner should not be called for gh pr checks / merge
      runner: noCallRunner(),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
      startedAt: Date.now() - 999_999,
      cap: { capMs: 1 },
    });
    expect(mergeStatus).toBe('capped');
  });

  it('returns capped when the cap is exceeded post-reviewer (deterministic clock)', async () => {
    const stateDir = makeTmpStateDir();
    let checksCallCount = 0;
    const runner: CommandRunner = {
      async run(_cmd, args) {
        if (args[0] === 'pr' && args[1] === 'checks') {
          checksCallCount++;
          return { stdout: CI_GREEN_RESPONSE, stderr: '', code: 0 };
        }
        if (args[0] === 'pr' && args[1] === 'merge') {
          throw new Error('merge must not be called when capped');
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    };

    // Injectable clock: 1st read (pre-CI cap) sees elapsed 0 → no cap, so the
    // CI check IS reached; 2nd read (post-reviewer cap) sees elapsed > cap →
    // 'capped' fires before merge. Deterministic — no wall-clock flakiness.
    const start = 1_000_000;
    let nowCall = 0;
    const now = () => (++nowCall <= 1 ? start : start + 100);

    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner,
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
      startedAt: start,
      now,
      cap: { capMs: 50 },
    });

    expect(checksCallCount).toBe(1); // CI check was reached (pre-CI cap did NOT fire)
    expect(mergeStatus).toBe('capped'); // post-reviewer cap fired before merge
  });

  it('allows merge when well within cap', async () => {
    const stateDir = makeTmpStateDir();
    const { mergeStatus } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner(mergeSpec()),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer: passReviewer(),
      live: true,
      startedAt: Date.now(),
      cap: { capMs: 60_000 }, // 1 minute — plenty of time
    });
    expect(mergeStatus).toBe('merged');
  });
});

// ---------------------------------------------------------------------------
// Reviewer PASS path — covered above; here we ensure verdict is checked
// ---------------------------------------------------------------------------

describe('reviewer hook', () => {
  it('calls the reviewer with repo, prNumber, and branch', async () => {
    const stateDir = makeTmpStateDir();
    let capturedInput: Parameters<Reviewer['review']>[0] | null = null;
    const reviewer: Reviewer = {
      async review(input) {
        capturedInput = input;
        return { verdict: 'PASS', notes: '' };
      },
    };
    await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: makeMockRunner(mergeSpec()),
      builderFn: mockBuilderFn(liveBuilderResult()),
      reviewer,
      live: true,
    });
    expect(capturedInput).not.toBeNull();
    expect(capturedInput!.repo).toBe('owner/repo');
    expect(capturedInput!.prNumber).toBe(42);
    expect(capturedInput!.branch).toBe(FAKE_BRANCH);
  });
});
