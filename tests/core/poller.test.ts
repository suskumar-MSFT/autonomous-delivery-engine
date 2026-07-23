/**
 * tests/core/poller.test.ts
 *
 * Tests for M2-2: edge-triggered external watcher (`pollEvents`).
 *
 * All external boundaries are mocked — NO live gh/filesystem/timers in CI.
 *
 * Key contracts verified:
 *   - Bootstrap: first run (no cursor) writes baseline, does NOT fire runLoop
 *   - No new events: cursor matches fetched state, no fire
 *   - New PR merged: fires runLoop once, advances cursor
 *   - New ready issue: fires runLoop once, advances cursor
 *   - Both new events in one iteration: fires runLoop exactly once
 *   - Multiple iterations: fires on each iteration that has new events
 *   - maxIterations: loop terminates after exactly N iterations
 *   - Cursor advanced before fire (crash-safe order)
 *   - dryRun propagates: when runLoopOpts.live=false, runLoop is called dry
 *   - gh error (code!=0): treated as empty list, no crash
 *   - sleep called between iterations (but not after the last one)
 *   - Empty repo returns no events, no fire
 *   - Corrupt cursor file treated as {} (empty cursor, not null)
 *   - detectNewEvents unit tests (pure function)
 *   - advanceCursor unit tests (pure function, no mutation)
 *   - latestTimestamp unit tests
 *   - readCursor: null on missing file, {} on corrupt JSON
 */

import { describe, it, expect } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  pollEvents,
  detectNewEvents,
  advanceCursor,
  latestTimestamp,
  readCursor,
  fetchMergedPrTimestamps,
  fetchReadyIssueTimestamps,
  type EventCursor,
  type LoopEvent,
  type PollEventsOpts,
} from '../../src/core/poller.js';
import type { CommandRunner, RunOptions, RunResult } from '../../src/agents/builder.js';
import type { LoopRunnerOpts } from '../../src/core/loop-runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_STATE_DIR = join(__dirname, '../../fixtures/state');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NO_SLEEP = async (_ms: number) => { /* instant */ };

/** Runner that always returns the given responses for specific commands. */
function makeGhRunner(
  mergedPrs: Array<{ number: number; mergedAt: string }>,
  readyIssues: Array<{ number: number; updatedAt: string }>,
): CommandRunner {
  return {
    async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
        return { stdout: JSON.stringify(mergedPrs), stderr: '', code: 0 };
      }
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        return { stdout: JSON.stringify(readyIssues), stderr: '', code: 0 };
      }
      // runLoop calls: CI checks + merge — return CI green so loop can proceed
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'checks') {
        return { stdout: JSON.stringify([{ name: 'build-and-test', state: 'SUCCESS' }]), stderr: '', code: 0 };
      }
      if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
        return { stdout: '', stderr: '', code: 0 };
      }
      throw new Error(`Unexpected runner call: ${cmd} ${args.join(' ')}`);
    },
  };
}

/** Runner that returns code=1 for all gh calls. */
function errorRunner(): CommandRunner {
  return {
    async run(_cmd: string, _args: string[], _opts?: RunOptions): Promise<RunResult> {
      return { stdout: '', stderr: 'simulated error', code: 1 };
    },
  };
}

/** Simple in-memory cursor store. */
function makeMemoryStore(initial: string | null = null): {
  readFile: (p: string) => string | null;
  writeFile: (p: string, c: string) => void;
  written: Array<{ path: string; content: string }>;
} {
  let stored = initial;
  const written: Array<{ path: string; content: string }> = [];
  return {
    readFile: (_p) => stored,
    writeFile: (_p, c) => {
      stored = c;
      written.push({ path: _p, content: c });
    },
    written,
  };
}

/** Base runLoopOpts — dry-run, uses FIXTURES_STATE_DIR. */
function dryLoopOpts(overrides: Partial<LoopRunnerOpts> = {}): LoopRunnerOpts {
  return {
    repo: 'owner/repo',
    checkoutDir: '/tmp/checkout',
    stateDir: FIXTURES_STATE_DIR,
    live: false,
    ...overrides,
  };
}

/** Build a PollEventsOpts with all boundaries mocked. */
function makePollOpts(
  ghRunner: CommandRunner,
  store: ReturnType<typeof makeMemoryStore>,
  overrides: Partial<PollEventsOpts> = {},
): PollEventsOpts {
  return {
    repo: 'owner/repo',
    cursorFile: '/fake/CURSOR.json',
    runLoopOpts: dryLoopOpts(),
    maxIterations: 1,
    sleep: NO_SLEEP,
    runner: ghRunner,
    readFile: store.readFile,
    writeFile: store.writeFile,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function unit tests
// ---------------------------------------------------------------------------

describe('latestTimestamp', () => {
  it('returns undefined for empty array', () => {
    expect(latestTimestamp([])).toBeUndefined();
  });

  it('returns the single element for a one-element array', () => {
    expect(latestTimestamp(['2026-07-01T00:00:00Z'])).toBe('2026-07-01T00:00:00Z');
  });

  it('returns the largest ISO string', () => {
    expect(latestTimestamp([
      '2026-07-01T00:00:00Z',
      '2026-07-23T10:00:00Z',
      '2026-07-22T23:59:59Z',
    ])).toBe('2026-07-23T10:00:00Z');
  });
});

describe('detectNewEvents', () => {
  it('returns empty array when no timestamps fetched', () => {
    const cursor: EventCursor = { latestPrMergedAt: '2026-07-01T00:00:00Z' };
    expect(detectNewEvents(cursor, [], [])).toHaveLength(0);
  });

  it('detects new pr-merged event when timestamp exceeds cursor', () => {
    const cursor: EventCursor = { latestPrMergedAt: '2026-07-01T00:00:00Z' };
    const events = detectNewEvents(cursor, ['2026-07-23T10:00:00Z'], []);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('pr-merged');
    expect(events[0].timestamp).toBe('2026-07-23T10:00:00Z');
  });

  it('does NOT detect pr-merged when timestamp equals cursor', () => {
    const ts = '2026-07-23T10:00:00Z';
    const cursor: EventCursor = { latestPrMergedAt: ts };
    expect(detectNewEvents(cursor, [ts], [])).toHaveLength(0);
  });

  it('detects new issue-ready event when timestamp exceeds cursor', () => {
    const cursor: EventCursor = { latestReadyIssueUpdatedAt: '2026-07-01T00:00:00Z' };
    const events = detectNewEvents(cursor, [], ['2026-07-23T11:00:00Z']);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('issue-ready');
  });

  it('detects both event classes when both are new', () => {
    const cursor: EventCursor = {};
    const events = detectNewEvents(
      cursor,
      ['2026-07-23T10:00:00Z'],
      ['2026-07-23T11:00:00Z'],
    );
    expect(events).toHaveLength(2);
    expect(events.map(e => e.kind).sort()).toEqual(['issue-ready', 'pr-merged']);
  });

  it('fires pr-merged when cursor has no entry for that class', () => {
    const cursor: EventCursor = {}; // no latestPrMergedAt
    const events = detectNewEvents(cursor, ['2026-07-23T10:00:00Z'], []);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('pr-merged');
  });
});

describe('advanceCursor', () => {
  it('returns a new object (does not mutate input)', () => {
    const cursor: EventCursor = { latestPrMergedAt: '2026-07-01T00:00:00Z' };
    const events: LoopEvent[] = [{ kind: 'pr-merged', timestamp: '2026-07-23T10:00:00Z' }];
    const updated = advanceCursor(cursor, events);
    expect(updated).not.toBe(cursor);
    expect(cursor.latestPrMergedAt).toBe('2026-07-01T00:00:00Z'); // unchanged
    expect(updated.latestPrMergedAt).toBe('2026-07-23T10:00:00Z');
  });

  it('advances both classes independently', () => {
    const cursor: EventCursor = {};
    const events: LoopEvent[] = [
      { kind: 'pr-merged', timestamp: '2026-07-23T10:00:00Z' },
      { kind: 'issue-ready', timestamp: '2026-07-23T11:00:00Z' },
    ];
    const updated = advanceCursor(cursor, events);
    expect(updated.latestPrMergedAt).toBe('2026-07-23T10:00:00Z');
    expect(updated.latestReadyIssueUpdatedAt).toBe('2026-07-23T11:00:00Z');
  });

  it('does not regress an existing cursor entry', () => {
    const cursor: EventCursor = { latestPrMergedAt: '2026-07-23T20:00:00Z' };
    const events: LoopEvent[] = [
      { kind: 'pr-merged', timestamp: '2026-07-01T00:00:00Z' }, // older
    ];
    const updated = advanceCursor(cursor, events);
    // Should keep the existing (newer) value
    expect(updated.latestPrMergedAt).toBe('2026-07-23T20:00:00Z');
  });

  it('returns unchanged cursor for empty events array', () => {
    const cursor: EventCursor = { latestPrMergedAt: '2026-07-23T10:00:00Z' };
    const updated = advanceCursor(cursor, []);
    expect(updated).toEqual(cursor);
  });
});

describe('readCursor', () => {
  it('returns null when file does not exist', () => {
    const r = readCursor(() => null, '/nonexistent');
    expect(r).toBeNull();
  });

  it('returns parsed object for valid JSON cursor', () => {
    const cursor: EventCursor = { latestPrMergedAt: '2026-07-23T10:00:00Z' };
    const r = readCursor(() => JSON.stringify(cursor), '/fake');
    expect(r).toEqual(cursor);
  });

  it('returns {} for corrupt JSON', () => {
    const r = readCursor(() => 'not-json{{{', '/fake');
    expect(r).toEqual({});
  });

  it('returns {} for valid JSON that is not an object', () => {
    const r = readCursor(() => '"just a string"', '/fake');
    expect(r).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// fetchMergedPrTimestamps / fetchReadyIssueTimestamps
// ---------------------------------------------------------------------------

describe('fetchMergedPrTimestamps', () => {
  it('returns mergedAt timestamps from gh pr list output', async () => {
    const runner = makeGhRunner(
      [
        { number: 25, mergedAt: '2026-07-23T10:00:00Z' },
        { number: 26, mergedAt: '2026-07-23T11:00:00Z' },
      ],
      [],
    );
    const result = await fetchMergedPrTimestamps(runner, 'owner/repo');
    expect(result).toEqual(['2026-07-23T10:00:00Z', '2026-07-23T11:00:00Z']);
  });

  it('filters out null mergedAt (closed but not merged)', async () => {
    const runner: CommandRunner = {
      async run() {
        return {
          stdout: JSON.stringify([
            { number: 1, mergedAt: '2026-07-23T10:00:00Z' },
            { number: 2, mergedAt: null },
          ]),
          stderr: '',
          code: 0,
        };
      },
    };
    const result = await fetchMergedPrTimestamps(runner, 'owner/repo');
    expect(result).toEqual(['2026-07-23T10:00:00Z']);
  });

  it('returns [] when gh returns non-zero exit code', async () => {
    const result = await fetchMergedPrTimestamps(errorRunner(), 'owner/repo');
    expect(result).toEqual([]);
  });

  it('returns [] when gh output is not valid JSON', async () => {
    const runner: CommandRunner = {
      async run() {
        return { stdout: 'not-json', stderr: '', code: 0 };
      },
    };
    const result = await fetchMergedPrTimestamps(runner, 'owner/repo');
    expect(result).toEqual([]);
  });
});

describe('fetchReadyIssueTimestamps', () => {
  it('returns updatedAt timestamps from gh issue list output', async () => {
    const runner = makeGhRunner([], [
      { number: 42, updatedAt: '2026-07-23T09:00:00Z' },
    ]);
    const result = await fetchReadyIssueTimestamps(runner, 'owner/repo');
    expect(result).toEqual(['2026-07-23T09:00:00Z']);
  });

  it('returns [] on gh error', async () => {
    const result = await fetchReadyIssueTimestamps(errorRunner(), 'owner/repo');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// pollEvents integration
// ---------------------------------------------------------------------------

describe('pollEvents — bootstrap (first run, no cursor file)', () => {
  it('writes a baseline cursor and does NOT fire runLoop', async () => {
    const store = makeMemoryStore(null); // no cursor file
    const ghRunner = makeGhRunner(
      [{ number: 25, mergedAt: '2026-07-23T10:00:00Z' }],
      [],
    );
    const loopCalls: string[] = [];
    const opts = makePollOpts(ghRunner, store, {
      maxIterations: 1,
      runLoopOpts: {
        ...dryLoopOpts(),
        builderFn: async () => {
          loopCalls.push('runLoop fired');
          return { branch: 'feat/x', prUrl: '', implemented: false, testsPassed: false };
        },
      },
    });

    const result = await pollEvents(opts);

    expect(result.fires).toBe(0);
    expect(result.iterations).toBe(1);
    expect(loopCalls).toHaveLength(0);
    // Cursor file should have been written with the baseline
    expect(store.written).toHaveLength(1);
    const cursor = JSON.parse(store.written[0].content) as EventCursor;
    expect(cursor.latestPrMergedAt).toBe('2026-07-23T10:00:00Z');
  });

  it('writes empty baseline when no events exist at all', async () => {
    const store = makeMemoryStore(null);
    const ghRunner = makeGhRunner([], []);
    const opts = makePollOpts(ghRunner, store, { maxIterations: 1 });

    const result = await pollEvents(opts);
    expect(result.fires).toBe(0);
    const cursor = JSON.parse(store.written[0].content) as EventCursor;
    expect(cursor.latestPrMergedAt).toBeUndefined();
    expect(cursor.latestReadyIssueUpdatedAt).toBeUndefined();
  });
});

describe('pollEvents — no new events', () => {
  it('does NOT fire when cursor matches fetched state exactly', async () => {
    const prTs = '2026-07-23T10:00:00Z';
    const issueTs = '2026-07-23T09:00:00Z';
    const existingCursor: EventCursor = {
      latestPrMergedAt: prTs,
      latestReadyIssueUpdatedAt: issueTs,
    };
    const store = makeMemoryStore(JSON.stringify(existingCursor));
    const ghRunner = makeGhRunner(
      [{ number: 25, mergedAt: prTs }],
      [{ number: 42, updatedAt: issueTs }],
    );

    const result = await pollEvents(makePollOpts(ghRunner, store, { maxIterations: 1 }));
    expect(result.fires).toBe(0);
    expect(result.iterations).toBe(1);
  });

  it('does NOT fire when gh returns empty lists', async () => {
    const store = makeMemoryStore(JSON.stringify({ latestPrMergedAt: '2026-07-01T00:00:00Z' }));
    const result = await pollEvents(
      makePollOpts(makeGhRunner([], []), store, { maxIterations: 1 }),
    );
    expect(result.fires).toBe(0);
  });
});

describe('pollEvents — new PR merged', () => {
  it('fires runLoop once when new PR is merged after cursor', async () => {
    const existingCursor: EventCursor = { latestPrMergedAt: '2026-07-22T00:00:00Z' };
    const store = makeMemoryStore(JSON.stringify(existingCursor));
    const ghRunner = makeGhRunner(
      [{ number: 26, mergedAt: '2026-07-23T10:00:00Z' }], // newer than cursor
      [],
    );

    const result = await pollEvents(makePollOpts(ghRunner, store, { maxIterations: 1 }));
    expect(result.fires).toBe(1);
    expect(result.loopResults).toHaveLength(1);
  });

  it('advances cursor to the new PR timestamp after firing', async () => {
    const newTs = '2026-07-23T10:00:00Z';
    const existingCursor: EventCursor = { latestPrMergedAt: '2026-07-22T00:00:00Z' };
    const store = makeMemoryStore(JSON.stringify(existingCursor));
    const ghRunner = makeGhRunner([{ number: 26, mergedAt: newTs }], []);

    await pollEvents(makePollOpts(ghRunner, store, { maxIterations: 1 }));

    // The cursor write should have happened (before the loop fire)
    const lastWrite = store.written[store.written.length - 1];
    const updatedCursor = JSON.parse(lastWrite.content) as EventCursor;
    expect(updatedCursor.latestPrMergedAt).toBe(newTs);
  });
});

describe('pollEvents — new ready issue', () => {
  it('fires runLoop once when an issue gets a newer ready timestamp', async () => {
    const existingCursor: EventCursor = { latestReadyIssueUpdatedAt: '2026-07-22T00:00:00Z' };
    const store = makeMemoryStore(JSON.stringify(existingCursor));
    const ghRunner = makeGhRunner([], [{ number: 42, updatedAt: '2026-07-23T11:00:00Z' }]);

    const result = await pollEvents(makePollOpts(ghRunner, store, { maxIterations: 1 }));
    expect(result.fires).toBe(1);
  });
});

describe('pollEvents — both event classes new', () => {
  it('fires runLoop exactly ONCE even when both pr-merged and issue-ready are new', async () => {
    const existingCursor: EventCursor = {};
    const store = makeMemoryStore(JSON.stringify(existingCursor));
    const ghRunner = makeGhRunner(
      [{ number: 25, mergedAt: '2026-07-23T10:00:00Z' }],
      [{ number: 42, updatedAt: '2026-07-23T11:00:00Z' }],
    );

    const result = await pollEvents(makePollOpts(ghRunner, store, { maxIterations: 1 }));
    expect(result.fires).toBe(1);
    expect(result.loopResults).toHaveLength(1);
  });
});

describe('pollEvents — multiple iterations', () => {
  it('runs exactly maxIterations iterations and fires on each with new events', async () => {
    // Each iteration returns a new (incrementing) PR timestamp so every
    // iteration after the bootstrap detects a new event.
    const timestamps = [
      '2026-07-23T08:00:00Z',
      '2026-07-23T09:00:00Z',
      '2026-07-23T10:00:00Z',
    ];
    let callIdx = 0;
    const runner: CommandRunner = {
      async run(cmd, args) {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
          const ts = timestamps[Math.min(callIdx++, timestamps.length - 1)];
          return { stdout: JSON.stringify([{ number: callIdx, mergedAt: ts }]), stderr: '', code: 0 };
        }
        if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
          return { stdout: '[]', stderr: '', code: 0 };
        }
        return { stdout: '', stderr: '', code: 0 };
      },
    };

    const store = makeMemoryStore(null); // first call bootstraps
    const result = await pollEvents({
      repo: 'owner/repo',
      cursorFile: '/fake/CURSOR.json',
      runLoopOpts: dryLoopOpts(),
      maxIterations: 3,
      sleep: NO_SLEEP,
      runner,
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(result.iterations).toBe(3);
    // Iteration 1: bootstrap (no fire)
    // Iteration 2: ts[1] > ts[0] → fire
    // Iteration 3: ts[2] > ts[1] → fire
    expect(result.fires).toBe(2);
  });

  it('returns correct iteration count when no events ever fire', async () => {
    const store = makeMemoryStore(JSON.stringify({ latestPrMergedAt: '2026-07-23T10:00:00Z' }));
    // Same timestamp on every call — never new
    const runner = makeGhRunner([{ number: 25, mergedAt: '2026-07-23T10:00:00Z' }], []);

    const result = await pollEvents({
      repo: 'owner/repo',
      cursorFile: '/fake/CURSOR.json',
      runLoopOpts: dryLoopOpts(),
      maxIterations: 5,
      sleep: NO_SLEEP,
      runner,
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(result.iterations).toBe(5);
    expect(result.fires).toBe(0);
  });
});

describe('pollEvents — sleep behaviour', () => {
  it('calls sleep (N-1) times for N iterations (no sleep after last)', async () => {
    const sleepCalls: number[] = [];
    const store = makeMemoryStore(JSON.stringify({}));
    const runner = makeGhRunner([], []);

    await pollEvents({
      repo: 'owner/repo',
      cursorFile: '/fake/CURSOR.json',
      runLoopOpts: dryLoopOpts(),
      maxIterations: 4,
      sleep: async (ms) => { sleepCalls.push(ms); },
      runner,
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(sleepCalls).toHaveLength(3); // 4 iterations → 3 sleeps
  });

  it('passes pollIntervalMs to sleep', async () => {
    const sleepCalls: number[] = [];
    const store = makeMemoryStore(JSON.stringify({}));

    await pollEvents({
      repo: 'owner/repo',
      cursorFile: '/fake/CURSOR.json',
      runLoopOpts: dryLoopOpts(),
      maxIterations: 2,
      pollIntervalMs: 12_345,
      sleep: async (ms) => { sleepCalls.push(ms); },
      runner: makeGhRunner([], []),
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(sleepCalls).toEqual([12_345]);
  });
});

describe('pollEvents — gh error resilience', () => {
  it('does not crash when gh returns non-zero exit code; fires=0', async () => {
    const store = makeMemoryStore(JSON.stringify({ latestPrMergedAt: '2026-07-01T00:00:00Z' }));

    const result = await pollEvents({
      repo: 'owner/repo',
      cursorFile: '/fake/CURSOR.json',
      runLoopOpts: dryLoopOpts(),
      maxIterations: 1,
      sleep: NO_SLEEP,
      runner: errorRunner(),
      readFile: store.readFile,
      writeFile: store.writeFile,
    });

    expect(result.fires).toBe(0);
  });
});

describe('pollEvents — corrupt cursor file', () => {
  it('treats corrupt cursor file as empty cursor (not null), does not bootstrap again', async () => {
    // A corrupt file (non-null but bad JSON) → readCursor returns {} → no bootstrap
    // → detectNewEvents is called, but with empty cursor → fires if events exist
    const store = makeMemoryStore('not-json-at-all');
    const ghRunner = makeGhRunner(
      [{ number: 25, mergedAt: '2026-07-23T10:00:00Z' }],
      [],
    );

    const result = await pollEvents(makePollOpts(ghRunner, store, { maxIterations: 1 }));
    // cursor.latestPrMergedAt is undefined → any PR timestamp counts as "new"
    expect(result.fires).toBe(1);
  });
});

describe('pollEvents — cursor written before runLoop (crash safety)', () => {
  it('writes cursor BEFORE firing runLoop so events are not re-fired on crash', async () => {
    // Single interleaved event log shared by both callbacks.
    // A reversed implementation (runLoop before writeCursor) would produce
    // ['loop', 'write'] and the toEqual assertion would correctly fail.
    const order: string[] = [];

    const existingCursor: EventCursor = { latestPrMergedAt: '2026-07-22T00:00:00Z' };
    let stored = JSON.stringify(existingCursor);

    const ghRunner = makeGhRunner([{ number: 26, mergedAt: '2026-07-23T10:00:00Z' }], []);

    await pollEvents({
      repo: 'owner/repo',
      cursorFile: '/fake/CURSOR.json',
      runLoopOpts: {
        ...dryLoopOpts(),
        maxUnits: 1,
        builderFn: async () => {
          order.push('loop');
          return { branch: 'feat/x', prUrl: '', implemented: false, testsPassed: false };
        },
      },
      maxIterations: 1,
      sleep: NO_SLEEP,
      runner: ghRunner,
      readFile: () => stored,
      writeFile: (_p, c) => { stored = c; order.push('write'); },
    });

    // Cursor write must precede runLoop fire
    expect(order).toEqual(['write', 'loop']);
  });
});
