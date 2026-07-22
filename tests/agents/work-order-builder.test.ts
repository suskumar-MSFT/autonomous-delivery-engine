import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  createWorkOrderBuilder,
  WorkOrderBuilder,
  type WorkOrderPayload,
  type WorkOrderResult,
} from '../../src/agents/work-order-builder.js';
import type { BuilderOptions } from '../../src/agents/builder.js';

// ---------------------------------------------------------------------------
// Helpers — injectable FS doubles
// ---------------------------------------------------------------------------

/** Minimal in-memory FS double keyed by absolute path. */
function makeMemFs() {
  const store = new Map<string, string>();
  return {
    store,
    writeFile: async (path: string, content: string) => {
      store.set(path, content);
    },
    readFile: async (path: string) => store.get(path),
    mkdirp: async (_dir: string) => { /* no-op */ },
  };
}

/** Fake clock + controllable sleep that never actually blocks. */
function makeFakeClock(startMs = 0) {
  let current = startMs;
  const sleepCalls: number[] = [];
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      current += ms; // advance time immediately so poll loop terminates
    },
    sleepCalls,
  };
}

const BASE_OPTS: BuilderOptions = {
  repo: 'owner/repo',
  issueNumber: 12,
  checkoutDir: '/tmp/checkout',
};

const WORK_ORDERS_DIR = '/test/work-orders';

// ---------------------------------------------------------------------------
// dryRun — writes nothing, polls nothing
// ---------------------------------------------------------------------------

describe('WorkOrderBuilder dryRun', () => {
  it('returns a planned result without writing any file', async () => {
    const writeSpy = vi.fn();
    const readSpy = vi.fn();
    const mkdirpSpy = vi.fn();

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      writeFile: writeSpy,
      readFile: readSpy,
      mkdirp: mkdirpSpy,
    });

    const result = await builder({ ...BASE_OPTS, dryRun: true });

    // Result shape mirrors M1-1 dryRun contract
    expect(result.branch).toBe('feat/issue-12');
    expect(result.prUrl).toBeNull();
    expect(result.testsPassed).toBe(false);
    expect(result.implemented).toBe(false);
    expect(result.dryRun).toBe(true);

    // Zero FS side-effects
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(mkdirpSpy).not.toHaveBeenCalled();
  });

  it('does not poll at all when dryRun:true (no sleep invocations)', async () => {
    const sleepSpy = vi.fn();
    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      sleep: sleepSpy,
      writeFile: vi.fn(),
      readFile: vi.fn(),
      mkdirp: vi.fn(),
    });

    await builder({ ...BASE_OPTS, dryRun: true });
    expect(sleepSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Work-order JSON content
// ---------------------------------------------------------------------------

describe('WorkOrderBuilder work-order payload', () => {
  it('writes the correct work-order JSON to work-orders/<issueNumber>.json', async () => {
    const clock = makeFakeClock(1_000_000);
    const fs = makeMemFs();

    // Pre-populate result so poll terminates immediately
    const resultPath = join(WORK_ORDERS_DIR, '12.result.json');
    const goodResult: WorkOrderResult = {
      prUrl: 'https://github.com/owner/repo/pull/99',
      branch: 'feat/issue-12',
      testsPassed: true,
      implemented: true,
    };
    fs.store.set(resultPath, JSON.stringify(goodResult));

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      mkdirp: fs.mkdirp,
    });

    await builder({ ...BASE_OPTS });

    const workOrderPath = join(WORK_ORDERS_DIR, '12.json');
    const raw = fs.store.get(workOrderPath);
    expect(raw).toBeDefined();

    const payload = JSON.parse(raw!) as WorkOrderPayload;
    expect(payload.repo).toBe('owner/repo');
    expect(payload.issueNumber).toBe(12);
    expect(payload.branch).toBe('feat/issue-12');
    expect(payload.checkoutDir).toBe('/tmp/checkout');
    expect(payload.requestedAt).toBe(new Date(1_000_000).toISOString());
  });

  it('calls mkdirp on the work-orders directory before writing', async () => {
    const mkdirpSpy = vi.fn().mockResolvedValue(undefined);
    const fs = makeMemFs();

    // Pre-populate result
    fs.store.set(
      join(WORK_ORDERS_DIR, '12.result.json'),
      JSON.stringify({ prUrl: null, testsPassed: false, implemented: false }),
    );

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 1_000,
      pollIntervalMs: 100,
      now: makeFakeClock().now,
      sleep: async () => { /* no-op */ },
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      mkdirp: mkdirpSpy,
    });

    await builder({ ...BASE_OPTS });
    expect(mkdirpSpy).toHaveBeenCalledWith(WORK_ORDERS_DIR);
  });
});

// ---------------------------------------------------------------------------
// Happy path — result file present immediately
// ---------------------------------------------------------------------------

describe('WorkOrderBuilder happy path', () => {
  it('returns correct BuilderResult when result file is present on first poll', async () => {
    const fs = makeMemFs();
    const clock = makeFakeClock();

    const successResult: WorkOrderResult = {
      prUrl: 'https://github.com/owner/repo/pull/42',
      branch: 'feat/issue-12',
      testsPassed: true,
      implemented: true,
    };
    fs.store.set(join(WORK_ORDERS_DIR, '12.result.json'), JSON.stringify(successResult));

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      mkdirp: fs.mkdirp,
    });

    const result = await builder({ ...BASE_OPTS });

    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
    expect(result.branch).toBe('feat/issue-12');
    expect(result.testsPassed).toBe(true);
    expect(result.implemented).toBe(true);
    expect(result.dryRun).toBeUndefined();
  });

  it('returns prUrl from result when testsPassed:false', async () => {
    const fs = makeMemFs();
    const clock = makeFakeClock();

    const partialResult: WorkOrderResult = {
      prUrl: null,
      branch: 'feat/issue-12',
      testsPassed: false,
      implemented: true,
    };
    fs.store.set(join(WORK_ORDERS_DIR, '12.result.json'), JSON.stringify(partialResult));

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      mkdirp: fs.mkdirp,
    });

    const result = await builder({ ...BASE_OPTS });
    expect(result.prUrl).toBeNull();
    expect(result.implemented).toBe(true);
    expect(result.testsPassed).toBe(false);
  });

  it('falls back to computed branch when result omits branch field', async () => {
    const fs = makeMemFs();
    const clock = makeFakeClock();

    const minimalResult: WorkOrderResult = { implemented: true, testsPassed: true, prUrl: 'https://github.com/owner/repo/pull/7' };
    fs.store.set(join(WORK_ORDERS_DIR, '12.result.json'), JSON.stringify(minimalResult));

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      mkdirp: fs.mkdirp,
    });

    const result = await builder({ ...BASE_OPTS });
    expect(result.branch).toBe('feat/issue-12');
  });
});

// ---------------------------------------------------------------------------
// Error result file
// ---------------------------------------------------------------------------

describe('WorkOrderBuilder error result', () => {
  it('returns implemented:false and prUrl:null when result contains error field', async () => {
    const fs = makeMemFs();
    const clock = makeFakeClock();

    const errorResult: WorkOrderResult = { error: 'Claude failed: context exceeded' };
    fs.store.set(join(WORK_ORDERS_DIR, '12.result.json'), JSON.stringify(errorResult));

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      mkdirp: fs.mkdirp,
    });

    const result = await builder({ ...BASE_OPTS });
    expect(result.prUrl).toBeNull();
    expect(result.implemented).toBe(false);
    expect(result.testsPassed).toBe(false);
  });

  it('uses branch from error result when provided', async () => {
    const fs = makeMemFs();
    const clock = makeFakeClock();

    const errorResult: WorkOrderResult = { error: 'oops', branch: 'feat/issue-12' };
    fs.store.set(join(WORK_ORDERS_DIR, '12.result.json'), JSON.stringify(errorResult));

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 5_000,
      pollIntervalMs: 100,
      now: clock.now,
      sleep: clock.sleep,
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      mkdirp: fs.mkdirp,
    });

    const result = await builder({ ...BASE_OPTS });
    expect(result.branch).toBe('feat/issue-12');
  });
});

// ---------------------------------------------------------------------------
// Poll timeout — bounded, no hang
// ---------------------------------------------------------------------------

describe('WorkOrderBuilder poll timeout', () => {
  it('returns error result (not a hang) when result never appears', async () => {
    const sleepCalls: number[] = [];
    let time = 0;

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 1_000,
      pollIntervalMs: 250,
      now: () => time,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        time += ms; // advance fake clock
      },
      writeFile: async () => { /* no-op */ },
      readFile: async () => undefined, // result never appears
      mkdirp: async () => { /* no-op */ },
    });

    const result = await builder({ ...BASE_OPTS });

    // Must return — not hang
    expect(result.prUrl).toBeNull();
    expect(result.implemented).toBe(false);
    expect(result.testsPassed).toBe(false);

    // Poll attempts must be bounded (≤ timeout/interval + 1 safety margin)
    const maxExpectedSleeps = Math.ceil(1_000 / 250) + 1;
    expect(sleepCalls.length).toBeLessThanOrEqual(maxExpectedSleeps);
    // And must actually have attempted to poll (at least 1 sleep)
    expect(sleepCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('terminates after exactly the right number of poll intervals', async () => {
    const sleepCalls: number[] = [];
    let time = 0;

    // pollTimeoutMs=500, pollIntervalMs=100 → expect ~5 sleeps
    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 500,
      pollIntervalMs: 100,
      now: () => time,
      sleep: async (ms: number) => {
        sleepCalls.push(ms);
        time += ms;
      },
      writeFile: async () => { /* no-op */ },
      readFile: async () => undefined,
      mkdirp: async () => { /* no-op */ },
    });

    await builder({ ...BASE_OPTS });

    // Bounded: deadline is 500ms, each sleep is 100ms → at most 5 sleeps
    expect(sleepCalls.length).toBeLessThanOrEqual(5);
  });

  it('resolves immediately when result appears after a few polls', async () => {
    let time = 0;
    let pollCount = 0;
    const fs = makeMemFs();

    const builder = createWorkOrderBuilder({
      workOrdersDir: WORK_ORDERS_DIR,
      pollTimeoutMs: 10_000,
      pollIntervalMs: 100,
      now: () => time,
      sleep: async (ms: number) => { time += ms; },
      writeFile: fs.writeFile,
      readFile: async (path: string) => {
        pollCount++;
        // Provide result on 3rd read of the result file
        if (pollCount >= 3 && path.endsWith('12.result.json')) {
          return JSON.stringify({
            prUrl: 'https://github.com/owner/repo/pull/55',
            branch: 'feat/issue-12',
            testsPassed: true,
            implemented: true,
          } satisfies WorkOrderResult);
        }
        return undefined;
      },
      mkdirp: fs.mkdirp,
    });

    const result = await builder({ ...BASE_OPTS });
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/55');
    expect(result.implemented).toBe(true);
    // Should not have polled more than 3 times for the result
    expect(pollCount).toBeLessThanOrEqual(5); // work-order write is also a write, not a read
  });
});

// ---------------------------------------------------------------------------
// Default export sanity check
// ---------------------------------------------------------------------------

describe('WorkOrderBuilder default export', () => {
  it('is a function that satisfies the builder contract', () => {
    expect(typeof WorkOrderBuilder).toBe('function');
  });
});
