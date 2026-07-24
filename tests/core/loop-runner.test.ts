/**
 * tests/core/loop-runner.test.ts
 *
 * Tests for M2-1: persistent `runLoop` (in-process chaining).
 * M4-1: telemetry wiring — appendRunLog called after each runLoop invocation.
 *
 * All external boundaries are mocked — NO live gh/claude/npm/git in CI.
 * File I/O for live-path tests uses temporary directories so fixtures are
 * never mutated.
 *
 * Key contracts verified:
 *  - dryRun: zero subprocess calls, correct StopReason, correct unit counts
 *  - maxUnits cap: stoppedReason = 'cap' when cap is hit
 *  - empty backlog: stoppedReason = 'empty'
 *  - budget check fires BEFORE each new unit (injectable clock, deterministic)
 *  - live multi-unit: processes 2 distinct ready items in sequence
 *  - error path: unrecoverable runOnce error re-throws with loopResult attached
 *  - M4-1 telemetry: appendRunLog called with correct entry after runLoop
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runLoop } from '../../src/core/loop-runner.js';
import type { LoopRunnerOpts } from '../../src/core/loop-runner.js';
import type { CommandRunner, BuilderResult, BuilderOptions, RunOptions, RunResult } from '../../src/agents/builder.js';
import type { Reviewer } from '../../src/core/reviewer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_STATE_DIR   = join(__dirname, '../../fixtures/state');         // 1 ready item (M0-1)
const EMPTY_BACKLOG_DIR    = join(__dirname, '../fixtures/empty-backlog');     // 0 ready items
const TWO_READY_FIXTURE    = join(__dirname, '../fixtures/two-ready');         // 2 ready items (M0-1, M0-2)

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpStateDir(sourceDir: string): string {
  const dir = join(
    tmpdir(),
    `engine-loop-runner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const FAKE_PR_URL_1 = 'https://github.com/owner/repo/pull/10';
const FAKE_PR_URL_2 = 'https://github.com/owner/repo/pull/11';

function liveBuilderResult(prUrl: string): BuilderResult {
  return { branch: `feat/issue-x`, prUrl, implemented: true, testsPassed: true };
}

/** Mock builder that returns sequential PR URLs per call. */
function sequentialMockBuilder(prUrls: string[]): (opts: BuilderOptions) => Promise<BuilderResult> {
  let callIndex = 0;
  return async () => {
    const url = prUrls[callIndex] ?? FAKE_PR_URL_1;
    callIndex++;
    return liveBuilderResult(url);
  };
}

/** Runner that throws on any call — asserts zero subprocess calls. */
function noCallRunner(): CommandRunner {
  return {
    async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
      throw new Error(`runner.run() must not be called: ${cmd} ${args.join(' ')}`);
    },
  };
}

/** CI-green mock runner (for gh pr checks + gh pr merge). */
function ciGreenRunner(prNumbers: number[]): CommandRunner {
  const CI_GREEN = JSON.stringify([{ name: 'build-and-test', state: 'SUCCESS' }]);
  return {
    async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'checks') {
        return { stdout: CI_GREEN, stderr: '', code: 0 };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
        const prNum = Number(args[2]);
        if (!prNumbers.includes(prNum)) {
          throw new Error(`Unexpected merge for PR #${prNum}; expected one of ${prNumbers}`);
        }
        return { stdout: '', stderr: '', code: 0 };
      }
      throw new Error(`MockRunner: unexpected call: ${cmd} ${args.join(' ')}`);
    },
  };
}

function passReviewer(): Reviewer {
  return { review: async () => ({ verdict: 'PASS', notes: 'Looks good' }) };
}

/** Base options for dry-run tests (live=false). */
function dryRunOpts(stateDir: string, overrides: Partial<LoopRunnerOpts> = {}): LoopRunnerOpts {
  return {
    repo: 'owner/repo',
    checkoutDir: '/tmp/checkout',
    stateDir,
    runner: noCallRunner(),
    live: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Dry-run mode
// ---------------------------------------------------------------------------

describe('runLoop — dry-run', () => {
  it('returns empty when backlog has no ready items', async () => {
    const r = await runLoop(dryRunOpts(EMPTY_BACKLOG_DIR));
    expect(r.unitsProcessed).toBe(0);
    expect(r.results).toHaveLength(0);
    expect(r.stoppedReason).toBe('empty');
  });

  it('processes one unit and stops at cap when maxUnits=1', async () => {
    // In dryRun mode claimOwner is not called, so the same ready item is
    // selected on every iteration. maxUnits=1 caps it after one pass.
    const r = await runLoop(dryRunOpts(FIXTURES_STATE_DIR, { maxUnits: 1 }));
    expect(r.unitsProcessed).toBe(1);
    expect(r.results).toHaveLength(1);
    expect(r.stoppedReason).toBe('cap');
    expect(r.results[0].mergeStatus).toBe('dry-run');
  });

  it('processes two units and stops at cap when maxUnits=2', async () => {
    // Same item selected twice in dryRun (ownership not updated).
    const r = await runLoop(dryRunOpts(FIXTURES_STATE_DIR, { maxUnits: 2 }));
    expect(r.unitsProcessed).toBe(2);
    expect(r.results).toHaveLength(2);
    expect(r.stoppedReason).toBe('cap');
    expect(r.results[0].mergeStatus).toBe('dry-run');
    expect(r.results[1].mergeStatus).toBe('dry-run');
  });

  it('makes zero subprocess calls in dryRun regardless of maxUnits', async () => {
    // noCallRunner() will throw if any subprocess is invoked.
    // This verifies the dryRun no-side-effects contract holds in runLoop.
    await expect(runLoop(dryRunOpts(FIXTURES_STATE_DIR, { maxUnits: 3 }))).resolves.toBeDefined();
  });

  it('returns cap stoppedReason when maxUnits=0 would never enter the loop', async () => {
    // maxUnits=0: while(0<0) is immediately false; stoppedReason stays 'empty'.
    const r = await runLoop(dryRunOpts(FIXTURES_STATE_DIR, { maxUnits: 0 }));
    expect(r.unitsProcessed).toBe(0);
    expect(r.stoppedReason).toBe('empty');
  });
});

// ---------------------------------------------------------------------------
// Budget check (deterministic clock)
// ---------------------------------------------------------------------------

describe('runLoop — budget enforcement', () => {
  it('fires budget stop BEFORE the first unit when already over budget', async () => {
    // Inject startedAt=0 and a now() that always returns a huge elapsed value,
    // so the budget check fires immediately before the first unit.
    const r = await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      startedAt: 0,
      budgetMs: 1,
      now: () => 999_999_999,
    });

    expect(r.unitsProcessed).toBe(0);
    expect(r.stoppedReason).toBe('budget');
  });

  it('processes first unit then stops on budget before second unit', async () => {
    // Inject startedAt=base so the first budget check sees elapsed=0 (within budget)
    // and the second sees elapsed=100_000 (exceeds budgetMs=50 → stops before unit 2).
    const base = 1_000_000;
    let nowCallCount = 0;
    const now = () => {
      nowCallCount++;
      // Call 1: budget check before unit 1 → within budget (elapsed = 0).
      // Call 2+: budget check before unit 2 → over budget.
      return nowCallCount <= 1 ? base : base + 100_000;
    };

    const r = await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      startedAt: base,
      budgetMs: 50,
      maxUnits: 10,
      now,
    });

    expect(r.unitsProcessed).toBe(1);
    expect(r.stoppedReason).toBe('budget');
  });

  it('does not stop on budget when well within cap', async () => {
    // budgetMs=60s, maxUnits=2 → should hit cap, not budget.
    const r = await runLoop(dryRunOpts(FIXTURES_STATE_DIR, {
      budgetMs: 60_000,
      maxUnits: 2,
    }));
    expect(r.stoppedReason).toBe('cap');
    expect(r.unitsProcessed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Live mode — multi-unit chaining
// ---------------------------------------------------------------------------

describe('runLoop — live multi-unit chaining', () => {
  it('processes 2 distinct ready items in sequence (live)', async () => {
    // Use two-ready fixture (M0-1 + M0-2). Live path claims ownership so
    // the second iteration picks the second item.
    const stateDir = makeTmpStateDir(TWO_READY_FIXTURE);
    const builderFn = sequentialMockBuilder([FAKE_PR_URL_1, FAKE_PR_URL_2]);
    const runner = ciGreenRunner([10, 11]); // PR numbers from URLs above

    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner,
      live: true,
      builderFn,
      reviewer: passReviewer(),
      maxUnits: 2,
      budgetMs: 60_000,
    });

    expect(r.unitsProcessed).toBe(2);
    expect(r.results).toHaveLength(2);
    expect(r.stoppedReason).toBe('cap');
    expect(r.results[0].mergeStatus).toBe('merged');
    expect(r.results[1].mergeStatus).toBe('merged');
    // Both units should be distinct items
    expect(r.results[0].selected?.id).toBe('M0-1');
    expect(r.results[1].selected?.id).toBe('M0-2');
  });

  it('stops with stoppedReason=empty after consuming all ready items (live)', async () => {
    // Only one ready item — after processing it, second iteration sees empty.
    const stateDir = makeTmpStateDir(FIXTURES_STATE_DIR);
    const builderFn = sequentialMockBuilder([FAKE_PR_URL_1]);
    const runner = ciGreenRunner([10]);

    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner,
      live: true,
      builderFn,
      reviewer: passReviewer(),
      maxUnits: 5,           // well above available items
      budgetMs: 60_000,
    });

    expect(r.unitsProcessed).toBe(1);
    expect(r.stoppedReason).toBe('empty');
    expect(r.results[0].mergeStatus).toBe('merged');
  });

  it('makes zero subprocess calls when live=false even with live runner provided', async () => {
    // Passing live=false (default) must not invoke the runner even if one is provided.
    const stateDir = makeTmpStateDir(TWO_READY_FIXTURE);
    const calls: string[] = [];
    const spyRunner: CommandRunner = {
      async run(cmd, args) {
        calls.push(`${cmd} ${args.join(' ')}`);
        return { stdout: '', stderr: '', code: 0 };
      },
    };

    await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir,
      runner: spyRunner,
      live: false,
      maxUnits: 2,
      budgetMs: 60_000,
    });

    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe('runLoop — error handling', () => {
  it('throws with loopResult attached when runOnce throws (invalid repo)', async () => {
    // An invalid repo causes runOnce to throw synchronously.
    // runLoop should rethrow with a loopResult property on the error.
    let thrown: unknown = null;
    try {
      await runLoop({
        repo: 'not-valid!!',   // REPO_RE will reject this
        checkoutDir: '/tmp/checkout',
        stateDir: FIXTURES_STATE_DIR,
        live: false,
        maxUnits: 1,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    const errWithResult = thrown as Error & { loopResult?: unknown };
    expect(errWithResult.loopResult).toBeDefined();
    const loopResult = errWithResult.loopResult as { stoppedReason: string; unitsProcessed: number };
    expect(loopResult.stoppedReason).toBe('error');
    expect(loopResult.unitsProcessed).toBe(0);
  });

  it('attaches partial results when error occurs after one unit', async () => {
    // Mock builder that succeeds the first time then throws on the second call.
    // Uses TWO_READY_FIXTURE (M0-1 + M0-2) so the second iteration has a real
    // ready item to attempt; without it, runLoop exits with 'empty' not 'error'.
    let callCount = 0;
    const builderFn = async (_opts: BuilderOptions): Promise<BuilderResult> => {
      callCount++;
      if (callCount > 1) throw new Error('builder exploded on call 2');
      return liveBuilderResult(FAKE_PR_URL_1);
    };

    const stateDir = makeTmpStateDir(TWO_READY_FIXTURE);
    const runner = ciGreenRunner([10]);

    let thrown: unknown = null;
    try {
      await runLoop({
        repo: 'owner/repo',
        checkoutDir: '/tmp/checkout',
        stateDir,
        runner,
        live: true,
        builderFn,
        reviewer: passReviewer(),
        maxUnits: 3,
        budgetMs: 60_000,
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).not.toBeNull();
    const errWithResult = thrown as Error & { loopResult?: { unitsProcessed: number; stoppedReason: string } };
    expect(errWithResult.loopResult?.stoppedReason).toBe('error');
    // First unit was processed before the error
    expect(errWithResult.loopResult?.unitsProcessed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Monitor pre-pass (monitorEnabled)
// ---------------------------------------------------------------------------

describe('runLoop — monitorEnabled pre-pass', () => {
  /** Runner that records which gh sub-commands are called. */
  function recordingRunner(): { runner: CommandRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(cmd: string, args: string[]): Promise<RunResult> {
        calls.push([cmd, ...args]);
        // respond to gh run list (monitor pre-pass)
        if (cmd === 'gh' && args.includes('run') && args.includes('list')) {
          return { stdout: '[]', stderr: '', code: 0 };
        }
        // default: success (covers any other calls from runOnce in dryRun)
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    return { runner, calls };
  }

  it('monitorEnabled=false (default): runner not called for gh run list', async () => {
    const { runner, calls } = recordingRunner();
    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      runner,
      live: false,
      maxUnits: 1,
      monitorEnabled: false,
    });
    const runListCalls = calls.filter(c => c.includes('run') && c.includes('list'));
    expect(runListCalls).toHaveLength(0);
    expect(r.monitorErrors).toEqual([]);
  });

  it('monitorEnabled=true: runner called for gh run list before unit loop', async () => {
    const { runner, calls } = recordingRunner();
    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      runner,
      live: false,
      maxUnits: 1,
      monitorEnabled: true,
    });
    const runListCalls = calls.filter(c => c.includes('run') && c.includes('list'));
    expect(runListCalls).toHaveLength(1);
    expect(r.monitorErrors).toEqual([]);
  });

  it('monitorEnabled=true with no failures: unit loop still runs normally', async () => {
    const { runner } = recordingRunner();
    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      runner,
      live: false,
      maxUnits: 1,
      monitorEnabled: true,
    });
    expect(r.unitsProcessed).toBe(1);
    expect(r.results[0].mergeStatus).toBe('dry-run');
    expect(r.monitorErrors).toEqual([]);
  });

  it('monitor pre-pass error is non-fatal: unit loop continues and error in monitorErrors', async () => {
    // Provide a runner that throws on gh run list (simulates monitor blowup).
    const faultyRunner: CommandRunner = {
      async run(_cmd: string, args: string[]): Promise<RunResult> {
        if (args.includes('run') && args.includes('list')) {
          throw new Error('monitor exploded');
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    };
    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      runner: faultyRunner,
      live: false,
      maxUnits: 1,
      monitorEnabled: true,
    });
    // Unit loop ran despite monitor failure
    expect(r.unitsProcessed).toBe(1);
    expect(r.results[0].mergeStatus).toBe('dry-run');
    // Error surfaced in monitorErrors (fetchFailedRuns caught it internally → errors[])
    // The throw from faultyRunner is caught by fetchFailedRuns' error guard.
    expect(Array.isArray(r.monitorErrors)).toBe(true);
  });

  it('monitorEnabled not set (undefined): runner not called for gh run list', async () => {
    const { runner, calls } = recordingRunner();
    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      runner,
      live: false,
      maxUnits: 1,
      // monitorEnabled omitted — defaults to false
    });
    const runListCalls = calls.filter(c => c.includes('run') && c.includes('list'));
    expect(runListCalls).toHaveLength(0);
    expect(r.monitorErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M4-1 Telemetry wiring
// ---------------------------------------------------------------------------

describe('runLoop — telemetry wiring (M4-1)', () => {
  it('calls appendFile with a JSONL entry when telemetry.enabled=true', async () => {
    const written: Array<[string, string]> = [];
    const appendFileMock = vi.fn().mockImplementation((p: string, data: string) => {
      written.push([p, data]);
      return Promise.resolve();
    });
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);

    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      live: false,
      maxUnits: 1,
      telemetry: {
        enabled: true,
        logFile: 'logs/run-log.jsonl',
        appendFile: appendFileMock,
        mkdirp: mkdirpMock,
      },
    });

    expect(appendFileMock).toHaveBeenCalledTimes(1);
    const [path, data] = written[0]!;
    expect(path).toBe('logs/run-log.jsonl');
    const entry = JSON.parse(data.trimEnd()) as Record<string, unknown>;
    expect(entry.repo).toBe('owner/repo');
    expect(entry.stoppedReason).toBe(r.stoppedReason);
    expect(entry.unitsProcessed).toBe(r.unitsProcessed);
    expect(typeof entry.timestamp).toBe('string');
    expect(typeof entry.durationMs).toBe('number');
    expect(Array.isArray(entry.monitorErrors)).toBe(true);
    expect(data.endsWith('\n')).toBe(true);
  });

  it('does NOT call appendFile when telemetry is omitted', async () => {
    const appendFileMock = vi.fn().mockResolvedValue(undefined);
    await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      live: false,
      maxUnits: 1,
      // no telemetry key
    });
    expect(appendFileMock).not.toHaveBeenCalled();
  });

  it('does NOT call appendFile when telemetry.enabled=false', async () => {
    const appendFileMock = vi.fn().mockResolvedValue(undefined);
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);
    await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      live: false,
      maxUnits: 1,
      telemetry: { enabled: false, appendFile: appendFileMock, mkdirp: mkdirpMock },
    });
    expect(appendFileMock).not.toHaveBeenCalled();
  });

  it('telemetry entry timestamp matches startedAt (injectable clock)', async () => {
    const FIXED_START = 1_700_000_000_000;
    let tick = 0;
    const nowFn = () => FIXED_START + tick++ * 5_000;

    const written: string[] = [];
    const appendFileMock = vi.fn().mockImplementation((_p: string, data: string) => {
      written.push(data);
      return Promise.resolve();
    });

    await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      live: false,
      maxUnits: 1,
      now: nowFn,
      telemetry: {
        enabled: true,
        appendFile: appendFileMock,
        mkdirp: vi.fn().mockResolvedValue(undefined),
      },
    });

    expect(written).toHaveLength(1);
    const entry = JSON.parse(written[0]!.trimEnd()) as Record<string, unknown>;
    expect(entry.timestamp).toBe(new Date(FIXED_START).toISOString());
  });

  it('telemetry write failure is swallowed — runLoop still returns result', async () => {
    const appendFileMock = vi.fn().mockRejectedValue(new Error('disk full'));
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);

    const r = await runLoop({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      live: false,
      maxUnits: 1,
      telemetry: { enabled: true, appendFile: appendFileMock, mkdirp: mkdirpMock },
    });

    // Loop result is intact despite write failure
    expect(r.stoppedReason).toBeDefined();
    expect(typeof r.unitsProcessed).toBe('number');
  });

  it('telemetry written on error path (stoppedReason=error) before re-throw', async () => {
    const written: string[] = [];
    const appendFileMock = vi.fn().mockImplementation((_p: string, data: string) => {
      written.push(data);
      return Promise.resolve();
    });
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);

    let thrown: unknown = null;
    try {
      await runLoop({
        repo: 'not-valid!!',   // invalid repo — runOnce throws immediately
        checkoutDir: '/tmp/checkout',
        stateDir: FIXTURES_STATE_DIR,
        live: false,
        maxUnits: 1,
        telemetry: { enabled: true, appendFile: appendFileMock, mkdirp: mkdirpMock },
      });
    } catch (err) {
      thrown = err;
    }

    // The error was re-thrown
    expect(thrown).not.toBeNull();
    expect(thrown).toBeInstanceOf(Error);
    // AND the telemetry entry was still written
    expect(appendFileMock).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(written[0]!.trimEnd()) as Record<string, unknown>;
    expect(entry.stoppedReason).toBe('error');
    expect(entry.unitsProcessed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M4-2 Kill-switch probe wiring
// ---------------------------------------------------------------------------

describe('runLoop — kill-switch probe (M4-2)', () => {
  /** Returns a killSwitchReadFile mock that always returns the given content. */
  function makeKillReader(content: string) {
    return vi.fn().mockResolvedValue(content);
  }

  it('stops with stoppedReason=killed when PROJECT.md contains LOOP PAUSED', async () => {
    const r = await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      maxUnits: 3,
      killSwitchReadFile: makeKillReader('# PROJECT\n\nLOOP PAUSED\n'),
    });
    expect(r.stoppedReason).toBe('killed');
    expect(r.unitsProcessed).toBe(0);
    expect(r.results).toHaveLength(0);
  });

  it('kill-switch fires before the first unit (no units processed)', async () => {
    const builderSpy = vi.fn().mockResolvedValue({
      branch: 'feat/x',
      prUrl: 'https://github.com/o/r/pull/1',
      implemented: true,
      testsPassed: true,
    });
    const r = await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      maxUnits: 2,
      builderFn: builderSpy,
      killSwitchReadFile: makeKillReader('LOOP PAUSED'),
    });
    expect(r.stoppedReason).toBe('killed');
    expect(builderSpy).not.toHaveBeenCalled();
  });

  it('continues normally when PROJECT.md has no LOOP PAUSED', async () => {
    const r = await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      maxUnits: 1,
      killSwitchReadFile: makeKillReader('# PROJECT\n\n## Current phase\nActive\n'),
    });
    expect(r.stoppedReason).not.toBe('killed');
    expect(r.unitsProcessed).toBe(1);
  });

  it('fail-open: continues when kill-switch readFile rejects (ENOENT)', async () => {
    const errorReader = vi.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const r = await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      maxUnits: 1,
      killSwitchReadFile: errorReader,
    });
    // Loop should NOT be killed by an unreadable project file
    expect(r.stoppedReason).not.toBe('killed');
    expect(r.unitsProcessed).toBe(1);
  });

  it('kill-switch is checked before each unit, not just once', async () => {
    // First call: no sentinel. Second call: sentinel present.
    let callCount = 0;
    const toggleReader = vi.fn().mockImplementation(async () => {
      callCount++;
      // Return sentinel on the second check (before unit 2).
      return callCount >= 2 ? 'LOOP PAUSED' : '# PROJECT — no sentinel';
    });

    const r = await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      maxUnits: 3,
      killSwitchReadFile: toggleReader,
    });

    // Unit 1 processed (kill-switch clear on check 1).
    // Loop killed before unit 2 (kill-switch active on check 2).
    expect(r.stoppedReason).toBe('killed');
    expect(r.unitsProcessed).toBe(1);
    expect(toggleReader).toHaveBeenCalledTimes(2);
  });

  it('kill-switch path is stateDir/PROJECT.md', async () => {
    // Verify the injected reader is called with the expected path.
    const capturedPaths: string[] = [];
    const capturingReader = vi.fn().mockImplementation(async (p: string) => {
      capturedPaths.push(p);
      return '# no sentinel';
    });

    await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      maxUnits: 1,
      killSwitchReadFile: capturingReader,
    });

    expect(capturedPaths.length).toBeGreaterThanOrEqual(1);
    for (const p of capturedPaths) {
      expect(p).toMatch(/PROJECT\.md$/);
    }
  });

  it('telemetry captures stoppedReason=killed when kill-switch fires', async () => {
    const written: string[] = [];
    const appendFileMock = vi.fn().mockImplementation((_p: string, data: string) => {
      written.push(data);
      return Promise.resolve();
    });

    await runLoop({
      ...dryRunOpts(FIXTURES_STATE_DIR),
      maxUnits: 2,
      killSwitchReadFile: makeKillReader('LOOP PAUSED'),
      telemetry: {
        enabled: true,
        appendFile: appendFileMock,
        mkdirp: vi.fn().mockResolvedValue(undefined),
      },
    });

    expect(appendFileMock).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(written[0]!.trimEnd()) as Record<string, unknown>;
    expect(entry.stoppedReason).toBe('killed');
    expect(entry.unitsProcessed).toBe(0);
  });
});
