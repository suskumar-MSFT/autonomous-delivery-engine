import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  createIdeaToVisionPlanner,
  ideaToVision,
  issueSlug,
  fetchIssueDetails,
  type IdeaToVisionConfig,
  type VisionOrderPayload,
  type VisionOrderResult,
  type IdeaToVisionResult,
} from '../../src/planner/idea-to-vision.js';
import type { GateResult } from '../../src/planner/gate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory FS double keyed by absolute path. */
function makeMemFs() {
  const store = new Map<string, string>();
  return {
    store,
    writeFile: async (path: string, content: string) => { store.set(path, content); },
    readFile:  async (path: string) => store.get(path),
    mkdirp:    async (_dir: string) => { /* no-op */ },
  };
}

/** Fake clock + controllable sleep that never actually blocks. */
function makeFakeClock(startMs = 0) {
  let current = startMs;
  const sleepCalls: number[] = [];
  return {
    now:    () => current,
    advance:(ms: number) => { current += ms; },
    sleep:  async (ms: number) => { sleepCalls.push(ms); current += ms; },
    sleepCalls,
  };
}

/** Stub gate that always resolves immediately (label found on attempt 1). */
function makePassGate(_label = 'vision-approved') {
  return vi.fn(async (n: number, lbl: string): Promise<GateResult> => ({
    issueNumber: n,
    label: lbl,
    attempts: 1,
  }));
}

/** Returns a ready-to-use result file content. */
function resultJson(opts: VisionOrderResult = { written: true, visionPath: 'vision/issue-7.md' }): string {
  return JSON.stringify(opts, null, 2);
}

const REPO = 'owner/test-repo';
const ORDERS_DIR = '/tmp/vision-orders';
const ISSUE_NUMBER = 7;

/** Base config — all deps injected, no real I/O. */
function baseConfig(fs: ReturnType<typeof makeMemFs>, clock: ReturnType<typeof makeFakeClock>): IdeaToVisionConfig {
  return {
    repo: REPO,
    visionOrdersDir: ORDERS_DIR,
    pollTimeoutMs:    500,
    pollIntervalMs:   50,
    gateTimeoutMs:    1_000,
    gatePollIntervalMs: 50,
    fetchIssue:  async () => ({ title: 'My Idea', body: 'Some details here.' }),
    writeFile:   fs.writeFile,
    readFile:    fs.readFile,
    mkdirp:      fs.mkdirp,
    sleep:       clock.sleep,
    now:         clock.now,
    waitForGate: makePassGate(),
  };
}

// ---------------------------------------------------------------------------
// issueSlug helper
// ---------------------------------------------------------------------------

describe('issueSlug', () => {
  it('returns "issue-<n>" format', () => {
    expect(issueSlug(7)).toBe('issue-7');
    expect(issueSlug(42)).toBe('issue-42');
    expect(issueSlug(0)).toBe('issue-0');
  });
});

// ---------------------------------------------------------------------------
// dryRun — zero side-effects
// ---------------------------------------------------------------------------

describe('createIdeaToVisionPlanner — dryRun', () => {
  it('returns a planned result without writing any file or calling any dep', async () => {
    const writeSpy  = vi.fn();
    const readSpy   = vi.fn();
    const mkdirpSpy = vi.fn();
    const fetchSpy  = vi.fn();
    const gateSpy   = vi.fn();

    const planner = createIdeaToVisionPlanner({
      repo: REPO,
      visionOrdersDir: ORDERS_DIR,
      writeFile:   writeSpy,
      readFile:    readSpy,
      mkdirp:      mkdirpSpy,
      fetchIssue:  fetchSpy,
      waitForGate: gateSpy,
    });

    const result: IdeaToVisionResult = await planner(ISSUE_NUMBER, true);

    expect(result.slug).toBe('issue-7');
    expect(result.visionPath).toBe('vision/issue-7.md');
    expect(result.dryRun).toBe(true);
    expect(result.gateResult.issueNumber).toBe(ISSUE_NUMBER);
    expect(result.gateResult.attempts).toBe(0);

    // Zero side-effects
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(mkdirpSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('dryRun default is false — live path runs when not specified', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    const cfg   = baseConfig(fs, clock);
    const gateSpy = makePassGate();
    cfg.waitForGate = gateSpy;

    // Pre-seed result file so the poll loop exits immediately
    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const planner = createIdeaToVisionPlanner(cfg);
    const result = await planner(ISSUE_NUMBER); // no dryRun arg

    expect(result.dryRun).toBeUndefined();
    expect(gateSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Happy path — full live run
// ---------------------------------------------------------------------------

describe('createIdeaToVisionPlanner — happy path', () => {
  it('fetches issue, writes work-order, reads result, waits for gate', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    const gateSpy = makePassGate();
    const planner = createIdeaToVisionPlanner({
      ...baseConfig(fs, clock),
      waitForGate: gateSpy,
    });

    // Pre-seed the result file (fulfiller already done)
    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson({ written: true, visionPath: 'vision/issue-7.md' }));

    const result = await planner(ISSUE_NUMBER);

    // Shape
    expect(result.slug).toBe('issue-7');
    expect(result.visionPath).toBe('vision/issue-7.md');
    expect(result.dryRun).toBeUndefined();

    // Work-order was written
    const orderPath = join(ORDERS_DIR, 'issue-7.json');
    const rawOrder = fs.store.get(orderPath);
    expect(rawOrder).toBeDefined();

    const order = JSON.parse(rawOrder!) as VisionOrderPayload;
    expect(order.repo).toBe(REPO);
    expect(order.issueNumber).toBe(ISSUE_NUMBER);
    expect(order.slug).toBe('issue-7');
    expect(order.visionPath).toBe('vision/issue-7.md');
    expect(order.ideaTitle).toBe('My Idea');
    expect(order.ideaBody).toBe('Some details here.');
    expect(order.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Gate called with correct args
    expect(gateSpy).toHaveBeenCalledOnce();
    expect(gateSpy).toHaveBeenCalledWith(ISSUE_NUMBER, 'vision-approved', 1_000);

    // Gate result forwarded
    expect(result.gateResult).toEqual({ issueNumber: ISSUE_NUMBER, label: 'vision-approved', attempts: 1 });
  });

  it('polls for the result file — resolves after N sleeps', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    const gateSpy = makePassGate();

    let callCount = 0;
    const planner = createIdeaToVisionPlanner({
      ...baseConfig(fs, clock),
      waitForGate: gateSpy,
      readFile: async (path: string) => {
        // First 2 reads return undefined; 3rd returns the result
        if (path.endsWith('.result.json')) {
          callCount++;
          if (callCount < 3) return undefined;
          return resultJson();
        }
        return fs.readFile(path);
      },
    });

    const result = await planner(ISSUE_NUMBER);
    expect(result.slug).toBe('issue-7');
    expect(callCount).toBe(3);
    // Two sleeps between the three polls
    expect(clock.sleepCalls.length).toBe(2);
  });

  it('retries poll when result file contains partial/malformed JSON (non-atomic write)', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    const gateSpy = makePassGate();

    let callCount = 0;
    const planner = createIdeaToVisionPlanner({
      ...baseConfig(fs, clock),
      waitForGate: gateSpy,
      pollTimeoutMs: 500,
      pollIntervalMs: 50,
      readFile: async (path: string) => {
        if (path.endsWith('.result.json')) {
          callCount++;
          if (callCount === 1) return '{broken json'; // partial write on first read
          return resultJson();                         // valid on second read
        }
        return fs.readFile(path);
      },
    });

    const result = await planner(ISSUE_NUMBER);
    expect(result.slug).toBe('issue-7');
    expect(callCount).toBe(2);          // read twice: malformed then valid
    expect(clock.sleepCalls.length).toBe(1); // one sleep between retries
  });

  it('mkdirp is called for the orders directory', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    const mkdirpSpy = vi.fn(async (_dir: string) => {});
    const gateSpy   = makePassGate();

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const planner = createIdeaToVisionPlanner({
      ...baseConfig(fs, clock),
      mkdirp: mkdirpSpy,
      waitForGate: gateSpy,
    });
    await planner(ISSUE_NUMBER);

    expect(mkdirpSpy).toHaveBeenCalledOnce();
    expect(mkdirpSpy).toHaveBeenCalledWith(ORDERS_DIR);
  });
});

// ---------------------------------------------------------------------------
// Work-order poll timeout
// ---------------------------------------------------------------------------

describe('createIdeaToVisionPlanner — poll timeout', () => {
  it('throws when result file never appears within pollTimeoutMs', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();

    // Result file never appears; clock advances on every sleep call
    // pollTimeoutMs = 500, pollIntervalMs = 50 → deadline hit after ≥10 sleeps
    const planner = createIdeaToVisionPlanner({
      ...baseConfig(fs, clock),
      pollTimeoutMs: 100,   // tight budget
      pollIntervalMs: 50,
    });

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow(
      /Vision work-order timed out/,
    );
    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('issue-7');
  });
});

// ---------------------------------------------------------------------------
// Fulfiller error in result file
// ---------------------------------------------------------------------------

describe('createIdeaToVisionPlanner — fulfiller error', () => {
  it('throws when result file contains an error field', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: false, error: 'Agent crashed' }));

    const planner = createIdeaToVisionPlanner(baseConfig(fs, clock));

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('Agent crashed');
    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('issue-7');
  });

  it('throws when result file has written=false and no error field', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: false }));

    const planner = createIdeaToVisionPlanner(baseConfig(fs, clock));

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow(/written=false/);
  });
});

// ---------------------------------------------------------------------------
// Gate timeout propagation
// ---------------------------------------------------------------------------

describe('createIdeaToVisionPlanner — gate timeout propagation', () => {
  it('propagates GateTimeoutError when the gate times out', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const planner = createIdeaToVisionPlanner({
      ...baseConfig(fs, clock),
      waitForGate: async (_n, _lbl, _timeout) => {
        throw new Error('Gate timed out');
      },
    });

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('Gate timed out');
  });
});

// ---------------------------------------------------------------------------
// ideaToVision convenience wrapper
// ---------------------------------------------------------------------------

describe('ideaToVision convenience wrapper', () => {
  it('dryRun — zero side-effects, returns planned result', async () => {
    const writeSpy = vi.fn();
    const result = await ideaToVision({
      repo: REPO,
      issueNumber: 5,
      dryRun: true,
      visionOrdersDir: ORDERS_DIR,
      writeFile: writeSpy,
      readFile:  async () => undefined,
      mkdirp:    async () => {},
      fetchIssue: vi.fn(),
      waitForGate: vi.fn(),
    });

    expect(result.slug).toBe('issue-5');
    expect(result.visionPath).toBe('vision/issue-5.md');
    expect(result.dryRun).toBe(true);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('live run — delegates to planner correctly', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    const gateSpy = makePassGate();

    const resultPath = join(ORDERS_DIR, 'issue-3.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: true, visionPath: 'vision/issue-3.md' }));

    const result = await ideaToVision({
      repo: REPO,
      issueNumber: 3,
      visionOrdersDir: ORDERS_DIR,
      fetchIssue:   async () => ({ title: 'Idea 3', body: 'Body 3.' }),
      writeFile:    fs.writeFile,
      readFile:     fs.readFile,
      mkdirp:       fs.mkdirp,
      sleep:        clock.sleep,
      now:          clock.now,
      waitForGate:  gateSpy,
      pollTimeoutMs: 500,
      pollIntervalMs: 50,
      gateTimeoutMs: 1_000,
    });

    expect(result.slug).toBe('issue-3');
    expect(result.visionPath).toBe('vision/issue-3.md');
    expect(result.gateResult.attempts).toBe(1);
    expect(gateSpy).toHaveBeenCalledWith(3, 'vision-approved', 1_000);

    // Work-order was written
    const order = JSON.parse(fs.store.get(join(ORDERS_DIR, 'issue-3.json'))!) as VisionOrderPayload;
    expect(order.ideaTitle).toBe('Idea 3');
  });
});

// ---------------------------------------------------------------------------
// fetchIssueDetails export — verify it is exported (no real call in CI)
// ---------------------------------------------------------------------------

describe('fetchIssueDetails export', () => {
  it('is a function (exported for injection into production config)', () => {
    expect(typeof fetchIssueDetails).toBe('function');
  });
});
