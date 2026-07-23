import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  createVisionToRoadmapPlanner,
  visionToRoadmap,
  issueSlug,
  createGitHubMilestones,
  type VisionToRoadmapConfig,
  type RoadmapOrderPayload,
  type RoadmapOrderResult,
  type RoadmapMilestone,
  type VisionToRoadmapResult,
} from '../../src/planner/vision-to-roadmap.js';
import type { GateResult } from '../../src/planner/gate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal in-memory FS double keyed by path. */
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
    now:     () => current,
    advance: (ms: number) => { current += ms; },
    sleep:   async (ms: number) => { sleepCalls.push(ms); current += ms; },
    sleepCalls,
  };
}

/** Stub gate that always resolves immediately (label found on attempt 1). */
function makePassGate() {
  return vi.fn(async (n: number, lbl: string): Promise<GateResult> => ({
    issueNumber: n,
    label: lbl,
    attempts: 1,
  }));
}

/** Stub createMilestones that records calls without touching GitHub. */
function makeMilestonesSpy() {
  return vi.fn(async (_repo: string, _milestones: RoadmapMilestone[]) => {});
}

/** Sample milestones for result files. */
const SAMPLE_MILESTONES: RoadmapMilestone[] = [
  { title: 'M1 — Foundations', description: 'Core plumbing + CI green' },
  { title: 'M2 — Planner',     description: 'Idea → roadmap pipeline' },
];

/** Returns a ready-to-use result file content. */
function resultJson(opts: RoadmapOrderResult = { written: true, milestones: SAMPLE_MILESTONES }): string {
  return JSON.stringify(opts, null, 2);
}

const REPO        = 'owner/test-repo';
const ORDERS_DIR  = '/tmp/roadmap-orders';
const ISSUE_NUMBER = 7;
const VISION_PATH = 'vision/issue-7.md';
const VISION_CONTENT = '# Vision\nGoal: build an autonomous delivery engine.';

/** Base config — all deps injected, no real I/O. */
function baseConfig(
  fs: ReturnType<typeof makeMemFs>,
  clock: ReturnType<typeof makeFakeClock>,
): VisionToRoadmapConfig {
  return {
    repo: REPO,
    roadmapOrdersDir: ORDERS_DIR,
    pollTimeoutMs:      500,
    pollIntervalMs:     50,
    gateTimeoutMs:      1_000,
    gatePollIntervalMs: 50,
    readFile:         fs.readFile,
    writeFile:        fs.writeFile,
    mkdirp:           fs.mkdirp,
    createMilestones: makeMilestonesSpy(),
    sleep:            clock.sleep,
    now:              clock.now,
    waitForGate:      makePassGate(),
  };
}

// Seed the vision doc into the FS so every test can find it.
function seedVision(fs: ReturnType<typeof makeMemFs>) {
  fs.store.set(VISION_PATH, VISION_CONTENT);
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

describe('createVisionToRoadmapPlanner — dryRun', () => {
  it('returns a planned result without writing any file or calling any dep', async () => {
    const writeSpy      = vi.fn();
    const readSpy       = vi.fn();
    const mkdirpSpy     = vi.fn();
    const milestoneSpy  = vi.fn();
    const gateSpy       = vi.fn();

    const planner = createVisionToRoadmapPlanner({
      repo: REPO,
      roadmapOrdersDir: ORDERS_DIR,
      writeFile:        writeSpy,
      readFile:         readSpy,
      mkdirp:           mkdirpSpy,
      createMilestones: milestoneSpy,
      waitForGate:      gateSpy,
    });

    const result: VisionToRoadmapResult = await planner(ISSUE_NUMBER, true);

    expect(result.slug).toBe('issue-7');
    expect(result.roadmapPath).toBe('roadmap/issue-7.md');
    expect(result.dryRun).toBe(true);
    expect(result.milestones).toEqual([]);
    expect(result.gateResult.issueNumber).toBe(ISSUE_NUMBER);
    expect(result.gateResult.attempts).toBe(0);
    expect(result.gateResult.label).toBe('roadmap-approved');

    // Zero side-effects
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(mkdirpSpy).not.toHaveBeenCalled();
    expect(milestoneSpy).not.toHaveBeenCalled();
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('dryRun default is false — live path runs when not specified', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const gateSpy = makePassGate();
    const cfg = baseConfig(fs, clock);
    cfg.waitForGate = gateSpy;

    const planner = createVisionToRoadmapPlanner(cfg);
    const result = await planner(ISSUE_NUMBER); // no dryRun arg

    expect(result.dryRun).toBeUndefined();
    expect(gateSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Happy path — full live run
// ---------------------------------------------------------------------------

describe('createVisionToRoadmapPlanner — happy path', () => {
  it('reads vision, writes work-order, reads result, creates milestones, waits for gate', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const milestoneSpy = makeMilestonesSpy();
    const gateSpy      = makePassGate();
    const planner = createVisionToRoadmapPlanner({
      ...baseConfig(fs, clock),
      createMilestones: milestoneSpy,
      waitForGate:      gateSpy,
    });

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson({ written: true, milestones: SAMPLE_MILESTONES }));

    const result = await planner(ISSUE_NUMBER);

    // Shape
    expect(result.slug).toBe('issue-7');
    expect(result.roadmapPath).toBe('roadmap/issue-7.md');
    expect(result.dryRun).toBeUndefined();
    expect(result.milestones).toEqual(SAMPLE_MILESTONES);

    // Work-order was written
    const orderPath = join(ORDERS_DIR, 'issue-7.json');
    const rawOrder  = fs.store.get(orderPath);
    expect(rawOrder).toBeDefined();

    const order = JSON.parse(rawOrder!) as RoadmapOrderPayload;
    expect(order.repo).toBe(REPO);
    expect(order.issueNumber).toBe(ISSUE_NUMBER);
    expect(order.slug).toBe('issue-7');
    expect(order.visionPath).toBe('vision/issue-7.md');
    expect(order.visionContent).toBe(VISION_CONTENT);
    expect(order.roadmapPath).toBe('roadmap/issue-7.md');
    expect(order.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // GitHub Milestones created
    expect(milestoneSpy).toHaveBeenCalledOnce();
    expect(milestoneSpy).toHaveBeenCalledWith(REPO, SAMPLE_MILESTONES);

    // Gate called with correct args
    expect(gateSpy).toHaveBeenCalledOnce();
    expect(gateSpy).toHaveBeenCalledWith(ISSUE_NUMBER, 'roadmap-approved', 1_000);

    // Gate result forwarded
    expect(result.gateResult).toEqual({
      issueNumber: ISSUE_NUMBER,
      label: 'roadmap-approved',
      attempts: 1,
    });
  });

  it('mkdirp is called for the orders directory', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const mkdirpSpy = vi.fn(async (_dir: string) => {});
    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const planner = createVisionToRoadmapPlanner({
      ...baseConfig(fs, clock),
      mkdirp: mkdirpSpy,
    });
    await planner(ISSUE_NUMBER);

    expect(mkdirpSpy).toHaveBeenCalledOnce();
    expect(mkdirpSpy).toHaveBeenCalledWith(ORDERS_DIR);
  });

  it('skips createMilestones when result carries an empty milestones array', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const milestoneSpy = makeMilestonesSpy();
    const resultPath   = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: true, milestones: [] }));

    const planner = createVisionToRoadmapPlanner({
      ...baseConfig(fs, clock),
      createMilestones: milestoneSpy,
    });
    const result = await planner(ISSUE_NUMBER);

    expect(milestoneSpy).not.toHaveBeenCalled();
    expect(result.milestones).toEqual([]);
  });

  it('skips createMilestones when result carries no milestones field', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const milestoneSpy = makeMilestonesSpy();
    const resultPath   = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: true })); // no milestones

    const planner = createVisionToRoadmapPlanner({
      ...baseConfig(fs, clock),
      createMilestones: milestoneSpy,
    });
    const result = await planner(ISSUE_NUMBER);

    expect(milestoneSpy).not.toHaveBeenCalled();
    expect(result.milestones).toEqual([]);
  });

  it('polls for the result file — resolves after N sleeps', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    let callCount = 0;
    const planner = createVisionToRoadmapPlanner({
      ...baseConfig(fs, clock),
      readFile: async (path: string) => {
        if (path === VISION_PATH) return VISION_CONTENT;
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
    // Two sleeps between the three result-file polls
    expect(clock.sleepCalls.length).toBe(2);
  });

  it('retries poll when result file contains partial/malformed JSON (non-atomic write)', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    let callCount = 0;
    const planner = createVisionToRoadmapPlanner({
      ...baseConfig(fs, clock),
      pollTimeoutMs:  500,
      pollIntervalMs: 50,
      readFile: async (path: string) => {
        if (path === VISION_PATH) return VISION_CONTENT;
        if (path.endsWith('.result.json')) {
          callCount++;
          if (callCount === 1) return '{broken json'; // partial write
          return resultJson();                        // valid on second read
        }
        return fs.readFile(path);
      },
    });

    const result = await planner(ISSUE_NUMBER);
    expect(result.slug).toBe('issue-7');
    expect(callCount).toBe(2);           // read twice: malformed then valid
    expect(clock.sleepCalls.length).toBe(1); // one sleep between retries
  });
});

// ---------------------------------------------------------------------------
// Missing vision doc
// ---------------------------------------------------------------------------

describe('createVisionToRoadmapPlanner — missing vision doc', () => {
  it('throws when the vision document does not exist', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    // vision NOT seeded

    const planner = createVisionToRoadmapPlanner(baseConfig(fs, clock));

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow(
      /Vision document not found/,
    );
    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('issue-7');
  });
});

// ---------------------------------------------------------------------------
// Work-order poll timeout
// ---------------------------------------------------------------------------

describe('createVisionToRoadmapPlanner — poll timeout', () => {
  it('throws when result file never appears within pollTimeoutMs', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);
    // Result file never appears; clock advances on every sleep call

    const planner = createVisionToRoadmapPlanner({
      ...baseConfig(fs, clock),
      pollTimeoutMs:  100,
      pollIntervalMs: 50,
    });

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow(
      /Roadmap work-order timed out/,
    );
    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('issue-7');
  });
});

// ---------------------------------------------------------------------------
// Fulfiller error in result file
// ---------------------------------------------------------------------------

describe('createVisionToRoadmapPlanner — fulfiller error', () => {
  it('throws when result file contains an error field', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: false, error: 'Agent crashed' }));

    const planner = createVisionToRoadmapPlanner(baseConfig(fs, clock));

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('Agent crashed');
    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('issue-7');
  });

  it('throws when result file has written=false and no error field', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: false }));

    const planner = createVisionToRoadmapPlanner(baseConfig(fs, clock));

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow(/written=false/);
  });
});

// ---------------------------------------------------------------------------
// Gate timeout propagation
// ---------------------------------------------------------------------------

describe('createVisionToRoadmapPlanner — gate timeout propagation', () => {
  it('propagates GateTimeoutError when the gate times out', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const planner = createVisionToRoadmapPlanner({
      ...baseConfig(fs, clock),
      waitForGate: async (_n, _lbl, _timeout) => {
        throw new Error('Gate timed out');
      },
    });

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('Gate timed out');
  });
});

// ---------------------------------------------------------------------------
// visionToRoadmap convenience wrapper
// ---------------------------------------------------------------------------

describe('visionToRoadmap convenience wrapper', () => {
  it('dryRun — zero side-effects, returns planned result', async () => {
    const writeSpy     = vi.fn();
    const readSpy      = vi.fn();
    const milestoneSpy = vi.fn();

    const result = await visionToRoadmap({
      repo: REPO,
      issueNumber: 5,
      dryRun: true,
      roadmapOrdersDir: ORDERS_DIR,
      writeFile:        writeSpy,
      readFile:         readSpy,
      mkdirp:           async () => {},
      createMilestones: milestoneSpy,
      waitForGate:      vi.fn(),
    });

    expect(result.slug).toBe('issue-5');
    expect(result.roadmapPath).toBe('roadmap/issue-5.md');
    expect(result.dryRun).toBe(true);
    expect(result.milestones).toEqual([]);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(milestoneSpy).not.toHaveBeenCalled();
  });

  it('live run — delegates to planner correctly', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedVision(fs);

    const milestoneSpy = makeMilestonesSpy();
    const gateSpy      = makePassGate();

    const resultPath = join(ORDERS_DIR, 'issue-3.result.json');
    const visionPath3 = 'vision/issue-3.md';
    fs.store.set(visionPath3, 'Vision for issue 3.');
    fs.store.set(resultPath, JSON.stringify({ written: true, milestones: SAMPLE_MILESTONES }));

    const result = await visionToRoadmap({
      repo: REPO,
      issueNumber: 3,
      roadmapOrdersDir: ORDERS_DIR,
      readFile:         fs.readFile,
      writeFile:        fs.writeFile,
      mkdirp:           fs.mkdirp,
      createMilestones: milestoneSpy,
      sleep:            clock.sleep,
      now:              clock.now,
      waitForGate:      gateSpy,
      pollTimeoutMs:    500,
      pollIntervalMs:   50,
      gateTimeoutMs:    1_000,
    });

    expect(result.slug).toBe('issue-3');
    expect(result.roadmapPath).toBe('roadmap/issue-3.md');
    expect(result.milestones).toEqual(SAMPLE_MILESTONES);
    expect(result.gateResult.attempts).toBe(1);
    expect(gateSpy).toHaveBeenCalledWith(3, 'roadmap-approved', 1_000);
    expect(milestoneSpy).toHaveBeenCalledWith(REPO, SAMPLE_MILESTONES);

    // Work-order was written with vision content embedded
    const order = JSON.parse(fs.store.get(join(ORDERS_DIR, 'issue-3.json'))!) as RoadmapOrderPayload;
    expect(order.visionContent).toBe('Vision for issue 3.');
    expect(order.visionPath).toBe('vision/issue-3.md');
  });
});

// ---------------------------------------------------------------------------
// createGitHubMilestones export — verify it is exported (no real call in CI)
// ---------------------------------------------------------------------------

describe('createGitHubMilestones export', () => {
  it('is a function (exported for injection into production config)', () => {
    expect(typeof createGitHubMilestones).toBe('function');
  });
});
