import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  createRoadmapDecomposePlanner,
  decomposeRoadmap,
  issueSlug,
  createGitHubIssues,
  buildBacklogRows,
  insertBeforeLaterMilestones,
  type DecomposeConfig,
  type DecomposeOrderPayload,
  type DecomposeOrderResult,
  type DecomposeItem,
  type DecomposeResult,
} from '../../src/planner/decompose.js';
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

/** Stub createIssues that records calls without touching GitHub. */
function makeIssuesSpy(numbers: number[] = [10, 11]) {
  return vi.fn(async (_repo: string, _items: DecomposeItem[]) => numbers);
}

/** Sample items for result files. */
const SAMPLE_ITEMS: DecomposeItem[] = [
  {
    id: 'M3-epic',
    title: 'Monitor epic',
    type: 'epic',
    description: 'Umbrella epic for M3 Monitor work',
    notes: 'Top-level epic',
  },
  {
    id: 'M3-1',
    title: 'CI regression watcher',
    type: 'story',
    description: 'Watch CI for regressions and file issues',
    acceptanceCriteria: 'Detects regression within 5 min; files GitHub issue automatically',
  },
];

/** Returns a ready-to-use result file content. */
function resultJson(
  opts: DecomposeOrderResult = {
    written: true,
    milestoneTitle: 'M3 — Monitor',
    items: SAMPLE_ITEMS,
  },
): string {
  return JSON.stringify(opts, null, 2);
}

const REPO          = 'owner/test-repo';
const ORDERS_DIR    = '/tmp/decompose-orders';
const BACKLOG_PATH  = '/tmp/state/BACKLOG.md';
const ISSUE_NUMBER  = 7;
const ROADMAP_PATH  = 'roadmap/issue-7.md';
const ROADMAP_CONTENT = '# Roadmap\n## M3 — Monitor\nGoal: watch CI and auto-file issues.';

/** Base config — all deps injected, no real I/O. */
function baseConfig(
  fs: ReturnType<typeof makeMemFs>,
  clock: ReturnType<typeof makeFakeClock>,
): DecomposeConfig {
  return {
    repo: REPO,
    backlogPath:        BACKLOG_PATH,
    decomposeOrdersDir: ORDERS_DIR,
    pollTimeoutMs:      500,
    pollIntervalMs:     50,
    gateTimeoutMs:      1_000,
    gatePollIntervalMs: 50,
    readFile:     fs.readFile,
    writeFile:    fs.writeFile,
    mkdirp:       fs.mkdirp,
    createIssues: makeIssuesSpy(),
    sleep:        clock.sleep,
    now:          clock.now,
    waitForGate:  makePassGate(),
  };
}

/** Seed the roadmap doc into the FS so every live test can find it. */
function seedRoadmap(fs: ReturnType<typeof makeMemFs>) {
  fs.store.set(ROADMAP_PATH, ROADMAP_CONTENT);
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
// buildBacklogRows
// ---------------------------------------------------------------------------

describe('buildBacklogRows', () => {
  it('produces correct section header and table rows', () => {
    const section = buildBacklogRows('M3 — Monitor', SAMPLE_ITEMS, [10, 11]);
    expect(section).toContain('## Milestone M3 — Monitor · planned');
    expect(section).toContain('| ID | GH# | Item | Type | Status | Owner | Notes |');
    expect(section).toContain('| M3-epic | #10 | Monitor epic | epic | ⬜ ready | — | Top-level epic |');
    expect(section).toContain('| M3-1 | #11 | CI regression watcher | story | ⬜ ready | — |');
  });

  it('uses acceptanceCriteria as notes when no notes field is set', () => {
    const item: DecomposeItem = {
      id: 'M3-2',
      title: 'Some story',
      type: 'story',
      description: 'A description',
      acceptanceCriteria: 'Must pass CI',
    };
    const section = buildBacklogRows('M3', [item], [99]);
    expect(section).toContain('Must pass CI');
  });

  it('falls back to truncated description when neither notes nor acceptanceCriteria set', () => {
    const longDesc = 'X'.repeat(100);
    const item: DecomposeItem = {
      id: 'M3-3',
      title: 'No notes',
      type: 'task',
      description: longDesc,
    };
    const section = buildBacklogRows('M3', [item], [5]);
    // Description is sliced to 80 chars
    expect(section).toContain('X'.repeat(80));
    expect(section).not.toContain('X'.repeat(81));
  });

  it('uses — for GH# when issueNumbers has no entry for that index', () => {
    const section = buildBacklogRows('M3', [SAMPLE_ITEMS[0]!], []);
    expect(section).toContain('| M3-epic | — |');
  });
});

// ---------------------------------------------------------------------------
// insertBeforeLaterMilestones
// ---------------------------------------------------------------------------

describe('insertBeforeLaterMilestones', () => {
  it('inserts new section immediately before ## Later milestones', () => {
    const existing = '# BACKLOG\n\n## Milestone M2\n| row |\n\n## Later milestones\nFoo.';
    const section  = '\n## Milestone M3 · planned\n| a |\n';
    const result   = insertBeforeLaterMilestones(existing, section);

    expect(result).toContain('## Milestone M3 · planned');
    const m3Idx   = result.indexOf('## Milestone M3');
    const laterIdx = result.indexOf('## Later milestones');
    expect(m3Idx).toBeLessThan(laterIdx);
  });

  it('appends new section at end of file when ## Later milestones is absent', () => {
    const existing = '# BACKLOG\n\n## Milestone M2\n| row |';
    const section  = '\n## Milestone M3 · planned\n| a |\n';
    const result   = insertBeforeLaterMilestones(existing, section);

    expect(result).toBe(existing + section);
    expect(result).not.toContain('## Later milestones');
  });
});

// ---------------------------------------------------------------------------
// dryRun — zero side-effects
// ---------------------------------------------------------------------------

describe('createRoadmapDecomposePlanner — dryRun', () => {
  it('returns a planned result without writing any file or calling any dep', async () => {
    const writeSpy  = vi.fn();
    const readSpy   = vi.fn();
    const mkdirpSpy = vi.fn();
    const issuesSpy = vi.fn();
    const gateSpy   = vi.fn();

    const planner = createRoadmapDecomposePlanner({
      repo: REPO,
      backlogPath:        BACKLOG_PATH,
      decomposeOrdersDir: ORDERS_DIR,
      writeFile:    writeSpy,
      readFile:     readSpy,
      mkdirp:       mkdirpSpy,
      createIssues: issuesSpy,
      waitForGate:  gateSpy,
    });

    const result: DecomposeResult = await planner(ISSUE_NUMBER, true);

    expect(result.slug).toBe('issue-7');
    expect(result.backlogPath).toBe(BACKLOG_PATH);
    expect(result.dryRun).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.issueNumbers).toEqual([]);
    expect(result.milestoneTitle).toBe('');
    expect(result.gateResult.issueNumber).toBe(ISSUE_NUMBER);
    expect(result.gateResult.attempts).toBe(0);
    expect(result.gateResult.label).toBe('backlog-approved');

    // Zero side-effects
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(mkdirpSpy).not.toHaveBeenCalled();
    expect(issuesSpy).not.toHaveBeenCalled();
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('dryRun default is false — live path runs when dryRun not specified', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const gateSpy = makePassGate();
    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      waitForGate: gateSpy,
    });
    const result = await planner(ISSUE_NUMBER); // no dryRun arg

    expect(result.dryRun).toBeUndefined();
    expect(gateSpy).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Happy path — full live run
// ---------------------------------------------------------------------------

describe('createRoadmapDecomposePlanner — happy path', () => {
  it('reads roadmap, writes work-order, reads result, creates issues, appends BACKLOG, gates', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    // Seed an existing BACKLOG with a Later milestones section
    const existingBacklog = '# BACKLOG\n\n## Milestone M2\n| row |\n\n## Later milestones\nSee ROADMAP.';
    fs.store.set(BACKLOG_PATH, existingBacklog);

    const issuesSpy = makeIssuesSpy([42, 43]);
    const gateSpy   = makePassGate();

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson({
      written: true,
      milestoneTitle: 'M3 — Monitor',
      items: SAMPLE_ITEMS,
    }));

    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      createIssues: issuesSpy,
      waitForGate:  gateSpy,
    });

    const result = await planner(ISSUE_NUMBER);

    // Shape
    expect(result.slug).toBe('issue-7');
    expect(result.backlogPath).toBe(BACKLOG_PATH);
    expect(result.milestoneTitle).toBe('M3 — Monitor');
    expect(result.items).toEqual(SAMPLE_ITEMS);
    expect(result.issueNumbers).toEqual([42, 43]);
    expect(result.dryRun).toBeUndefined();

    // Work-order was written
    const orderPath = join(ORDERS_DIR, 'issue-7.json');
    const rawOrder  = fs.store.get(orderPath);
    expect(rawOrder).toBeDefined();

    const order = JSON.parse(rawOrder!) as DecomposeOrderPayload;
    expect(order.repo).toBe(REPO);
    expect(order.issueNumber).toBe(ISSUE_NUMBER);
    expect(order.slug).toBe('issue-7');
    expect(order.roadmapPath).toBe('roadmap/issue-7.md');
    expect(order.roadmapContent).toBe(ROADMAP_CONTENT);
    expect(order.backlogPath).toBe(BACKLOG_PATH);
    expect(order.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // GitHub Issues created
    expect(issuesSpy).toHaveBeenCalledOnce();
    expect(issuesSpy).toHaveBeenCalledWith(REPO, SAMPLE_ITEMS);

    // BACKLOG was updated
    const updatedBacklog = fs.store.get(BACKLOG_PATH);
    expect(updatedBacklog).toBeDefined();
    expect(updatedBacklog).toContain('## Milestone M3 — Monitor · planned');
    expect(updatedBacklog).toContain('#42');
    expect(updatedBacklog).toContain('#43');
    // New section is before "## Later milestones"
    const m3Idx     = updatedBacklog!.indexOf('## Milestone M3');
    const laterIdx  = updatedBacklog!.indexOf('## Later milestones');
    expect(m3Idx).toBeLessThan(laterIdx);

    // Gate called with correct args
    expect(gateSpy).toHaveBeenCalledOnce();
    expect(gateSpy).toHaveBeenCalledWith(ISSUE_NUMBER, 'backlog-approved', 1_000);

    // Gate result forwarded
    expect(result.gateResult).toEqual({
      issueNumber: ISSUE_NUMBER,
      label: 'backlog-approved',
      attempts: 1,
    });
  });

  it('mkdirp is called for the orders directory', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    const mkdirpSpy  = vi.fn(async (_dir: string) => {});
    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      mkdirp: mkdirpSpy,
    });
    await planner(ISSUE_NUMBER);

    expect(mkdirpSpy).toHaveBeenCalledOnce();
    expect(mkdirpSpy).toHaveBeenCalledWith(ORDERS_DIR);
  });

  it('skips createIssues and BACKLOG write when result carries empty items array', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    const issuesSpy  = makeIssuesSpy();
    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: true, milestoneTitle: 'M3', items: [] }));

    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      createIssues: issuesSpy,
    });
    const result = await planner(ISSUE_NUMBER);

    expect(issuesSpy).not.toHaveBeenCalled();
    expect(result.issueNumbers).toEqual([]);
    expect(result.items).toEqual([]);
    // BACKLOG was not written (no items)
    expect(fs.store.has(BACKLOG_PATH)).toBe(false);
  });

  it('skips createIssues and BACKLOG write when result has no items field', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    const issuesSpy  = makeIssuesSpy();
    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: true })); // no items

    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      createIssues: issuesSpy,
    });
    const result = await planner(ISSUE_NUMBER);

    expect(issuesSpy).not.toHaveBeenCalled();
    expect(result.items).toEqual([]);
  });

  it('uses slug as milestoneTitle when result omits milestoneTitle', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: true, items: SAMPLE_ITEMS }));

    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
    });
    const result = await planner(ISSUE_NUMBER);

    expect(result.milestoneTitle).toBe('issue-7');
  });

  it('polls for the result file — resolves after N sleeps', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    let callCount = 0;
    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      readFile: async (path: string) => {
        if (path === ROADMAP_PATH) return ROADMAP_CONTENT;
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
    seedRoadmap(fs);

    let callCount = 0;
    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      pollTimeoutMs:  500,
      pollIntervalMs: 50,
      readFile: async (path: string) => {
        if (path === ROADMAP_PATH) return ROADMAP_CONTENT;
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
    expect(callCount).toBe(2);               // read twice: malformed then valid
    expect(clock.sleepCalls.length).toBe(1); // one sleep between retries
  });
});

// ---------------------------------------------------------------------------
// Missing roadmap doc
// ---------------------------------------------------------------------------

describe('createRoadmapDecomposePlanner — missing roadmap doc', () => {
  it('throws when the roadmap document does not exist', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    // roadmap NOT seeded

    const planner = createRoadmapDecomposePlanner(baseConfig(fs, clock));

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow(
      /Roadmap document not found/,
    );
    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('issue-7');
  });
});

// ---------------------------------------------------------------------------
// Work-order poll timeout
// ---------------------------------------------------------------------------

describe('createRoadmapDecomposePlanner — poll timeout', () => {
  it('throws when result file never appears within pollTimeoutMs', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);
    // Result file never appears; clock advances on every sleep call

    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      pollTimeoutMs:  100,
      pollIntervalMs: 50,
    });

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow(
      /Decompose work-order timed out/,
    );
    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('issue-7');
  });
});

// ---------------------------------------------------------------------------
// Fulfiller error in result file
// ---------------------------------------------------------------------------

describe('createRoadmapDecomposePlanner — fulfiller error', () => {
  it('throws when result file contains an error field', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: false, error: 'Agent crashed' }));

    const planner = createRoadmapDecomposePlanner(baseConfig(fs, clock));

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('Agent crashed');
    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('issue-7');
  });

  it('throws when result file has written=false and no error field', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, JSON.stringify({ written: false }));

    const planner = createRoadmapDecomposePlanner(baseConfig(fs, clock));

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow(/written=false/);
  });
});

// ---------------------------------------------------------------------------
// Gate timeout propagation
// ---------------------------------------------------------------------------

describe('createRoadmapDecomposePlanner — gate timeout propagation', () => {
  it('propagates GateTimeoutError when the gate times out', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();
    seedRoadmap(fs);

    const resultPath = join(ORDERS_DIR, 'issue-7.result.json');
    fs.store.set(resultPath, resultJson());

    const planner = createRoadmapDecomposePlanner({
      ...baseConfig(fs, clock),
      waitForGate: async (_n, _lbl, _timeout) => {
        throw new Error('Gate timed out');
      },
    });

    await expect(planner(ISSUE_NUMBER)).rejects.toThrow('Gate timed out');
  });
});

// ---------------------------------------------------------------------------
// decomposeRoadmap convenience wrapper
// ---------------------------------------------------------------------------

describe('decomposeRoadmap convenience wrapper', () => {
  it('dryRun — zero side-effects, returns planned result', async () => {
    const writeSpy  = vi.fn();
    const readSpy   = vi.fn();
    const issuesSpy = vi.fn();

    const result = await decomposeRoadmap({
      repo: REPO,
      issueNumber: 5,
      dryRun: true,
      backlogPath:        BACKLOG_PATH,
      decomposeOrdersDir: ORDERS_DIR,
      writeFile:    writeSpy,
      readFile:     readSpy,
      mkdirp:       async () => {},
      createIssues: issuesSpy,
      waitForGate:  vi.fn(),
    });

    expect(result.slug).toBe('issue-5');
    expect(result.backlogPath).toBe(BACKLOG_PATH);
    expect(result.dryRun).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.issueNumbers).toEqual([]);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    expect(issuesSpy).not.toHaveBeenCalled();
  });

  it('live run — delegates to planner correctly', async () => {
    const fs    = makeMemFs();
    const clock = makeFakeClock();

    const roadmapPath3 = 'roadmap/issue-3.md';
    fs.store.set(roadmapPath3, 'Roadmap for issue 3.');

    const resultPath = join(ORDERS_DIR, 'issue-3.result.json');
    fs.store.set(resultPath, JSON.stringify({
      written: true,
      milestoneTitle: 'M3 — Monitor',
      items: SAMPLE_ITEMS,
    }));

    const issuesSpy = makeIssuesSpy([20, 21]);
    const gateSpy   = makePassGate();

    const result = await decomposeRoadmap({
      repo: REPO,
      issueNumber: 3,
      backlogPath:        BACKLOG_PATH,
      decomposeOrdersDir: ORDERS_DIR,
      readFile:     fs.readFile,
      writeFile:    fs.writeFile,
      mkdirp:       fs.mkdirp,
      createIssues: issuesSpy,
      sleep:        clock.sleep,
      now:          clock.now,
      waitForGate:  gateSpy,
      pollTimeoutMs:    500,
      pollIntervalMs:   50,
      gateTimeoutMs:    1_000,
    });

    expect(result.slug).toBe('issue-3');
    expect(result.backlogPath).toBe(BACKLOG_PATH);
    expect(result.milestoneTitle).toBe('M3 — Monitor');
    expect(result.items).toEqual(SAMPLE_ITEMS);
    expect(result.issueNumbers).toEqual([20, 21]);
    expect(result.gateResult.attempts).toBe(1);
    expect(gateSpy).toHaveBeenCalledWith(3, 'backlog-approved', 1_000);
    expect(issuesSpy).toHaveBeenCalledWith(REPO, SAMPLE_ITEMS);

    // Work-order was written with roadmap content embedded
    const order = JSON.parse(fs.store.get(join(ORDERS_DIR, 'issue-3.json'))!) as DecomposeOrderPayload;
    expect(order.roadmapContent).toBe('Roadmap for issue 3.');
    expect(order.roadmapPath).toBe('roadmap/issue-3.md');
    expect(order.backlogPath).toBe(BACKLOG_PATH);
  });
});

// ---------------------------------------------------------------------------
// createGitHubIssues export — verify it is exported (no real call in CI)
// ---------------------------------------------------------------------------

describe('createGitHubIssues export', () => {
  it('is a function (exported for injection into production config)', () => {
    expect(typeof createGitHubIssues).toBe('function');
  });
});
