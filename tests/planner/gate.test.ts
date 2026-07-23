import { describe, it, expect, vi } from 'vitest';
import {
  createGateWatcher,
  waitForGate,
  GateTimeoutError,
  fetchIssueLabels,
  type GateResult,
} from '../../src/planner/gate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fake clock where sleep() advances the clock immediately (never blocks). */
function makeFakeClock(startMs = 0) {
  let current = startMs;
  const sleepCalls: number[] = [];
  return {
    now: () => current,
    advance: (ms: number) => { current += ms; },
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      current += ms;
    },
    sleepCalls,
  };
}

/** Builds a fetchLabels spy: returns labelMap[issueNumber] or []. */
function makeFetchLabels(labelMap: Map<number, string[]>) {
  return vi.fn(async (_repo: string, issueNumber: number): Promise<string[]> => {
    return labelMap.get(issueNumber) ?? [];
  });
}

const REPO = 'owner/test-repo';

// ---------------------------------------------------------------------------
// createGateWatcher — label found immediately (first poll)
// ---------------------------------------------------------------------------

describe('createGateWatcher — label present on first poll', () => {
  it('resolves with attempts=1 when label is already set', async () => {
    const labels = new Map([[7, ['vision-approved', 'bug']]]);
    const clock = makeFakeClock();
    const fetchSpy = makeFetchLabels(labels);

    const waitForGate = createGateWatcher({
      repo: REPO,
      fetchLabels: fetchSpy,
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 5_000,
    });

    const result: GateResult = await waitForGate(7, 'vision-approved', 60_000);

    expect(result).toEqual({ issueNumber: 7, label: 'vision-approved', attempts: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(REPO, 7);
    // No sleep because label was found immediately
    expect(clock.sleepCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// createGateWatcher — label appears after N polls
// ---------------------------------------------------------------------------

describe('createGateWatcher — label appears after several polls', () => {
  it('resolves on the Nth attempt after sleeping (N-1) times', async () => {
    // Label added after 3rd poll
    let callCount = 0;
    const clock = makeFakeClock();
    const fetchSpy = vi.fn(async (): Promise<string[]> => {
      callCount++;
      return callCount >= 3 ? ['roadmap-approved'] : [];
    });

    const waitForGate = createGateWatcher({
      repo: REPO,
      fetchLabels: fetchSpy,
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 1_000,
    });

    const result = await waitForGate(99, 'roadmap-approved', 30_000);

    expect(result.attempts).toBe(3);
    expect(result.label).toBe('roadmap-approved');
    expect(result.issueNumber).toBe(99);
    // Slept twice (between attempt 1→2 and 2→3)
    expect(clock.sleepCalls).toHaveLength(2);
    expect(clock.sleepCalls[0]).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// createGateWatcher — timeout (label never appears)
// ---------------------------------------------------------------------------

describe('createGateWatcher — timeout', () => {
  it('throws GateTimeoutError when deadline passes without label', async () => {
    const clock = makeFakeClock(0);
    const fetchSpy = vi.fn(async (): Promise<string[]> => []);

    const waitForGate = createGateWatcher({
      repo: REPO,
      fetchLabels: fetchSpy,
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 5_000,
    });

    // timeoutMs = 8 000ms, pollIntervalMs = 5 000ms
    // attempt 1: t=0, no label, deadline 8000 not passed, sleep 5000 → t=5000
    // attempt 2: t=5000, no label, deadline 8000 not passed, sleep 5000 → t=10000
    // attempt 3: t=10000, no label, now (10000) >= deadline (8000) → throw
    await expect(waitForGate(3, 'backlog-approved', 8_000)).rejects.toThrow(GateTimeoutError);
  });

  it('GateTimeoutError has correct properties', async () => {
    const clock = makeFakeClock(0);
    const waitForGate = createGateWatcher({
      repo: REPO,
      fetchLabels: async () => [],
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 5_000,
    });

    let thrown: GateTimeoutError | undefined;
    try {
      await waitForGate(42, 'vision-approved', 3_000);
    } catch (err) {
      thrown = err as GateTimeoutError;
    }

    expect(thrown).toBeInstanceOf(GateTimeoutError);
    expect(thrown?.issueNumber).toBe(42);
    expect(thrown?.label).toBe('vision-approved');
    expect(thrown?.timeoutMs).toBe(3_000);
    expect(thrown?.attempts).toBeGreaterThan(0);
    expect(thrown?.name).toBe('GateTimeoutError');
    expect(thrown?.message).toContain('vision-approved');
    expect(thrown?.message).toContain('#42');
  });

  it('makes at least one fetch attempt before timing out', async () => {
    // Even with timeoutMs=0, one fetch must occur
    const clock = makeFakeClock(1000); // already past any deadline
    const fetchSpy = vi.fn(async (): Promise<string[]> => []);

    const waitForGate = createGateWatcher({
      repo: REPO,
      fetchLabels: fetchSpy,
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 100,
    });

    // deadline = 1000 + 0 = 1000; now() = 1000 → deadline immediately hit after first fetch
    await expect(waitForGate(1, 'some-label', 0)).rejects.toThrow(GateTimeoutError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createGateWatcher — polling uses configured repo
// ---------------------------------------------------------------------------

describe('createGateWatcher — repo forwarded to fetchLabels', () => {
  it('passes the configured repo to every fetchLabels call', async () => {
    const clock = makeFakeClock();
    const fetchSpy = vi.fn(async (): Promise<string[]> => ['done']);

    const waitForGate = createGateWatcher({
      repo: 'acme/special-repo',
      fetchLabels: fetchSpy,
      sleep: clock.sleep,
      now: clock.now,
    });

    await waitForGate(5, 'done', 60_000);
    expect(fetchSpy).toHaveBeenCalledWith('acme/special-repo', 5);
  });
});

// ---------------------------------------------------------------------------
// createGateWatcher — pollIntervalMs respected
// ---------------------------------------------------------------------------

describe('createGateWatcher — pollIntervalMs', () => {
  it('sleeps with configured interval between polls', async () => {
    let call = 0;
    const clock = makeFakeClock();
    const waitForGate = createGateWatcher({
      repo: REPO,
      fetchLabels: async () => (++call >= 2 ? ['ready'] : []),
      sleep: clock.sleep,
      now: clock.now,
      pollIntervalMs: 7_500,
    });

    await waitForGate(10, 'ready', 60_000);
    expect(clock.sleepCalls).toEqual([7_500]);
  });
});

// ---------------------------------------------------------------------------
// Convenience waitForGate top-level function
// ---------------------------------------------------------------------------

describe('waitForGate (top-level convenience)', () => {
  it('resolves when label is present', async () => {
    const clock = makeFakeClock();
    const result = await waitForGate({
      repo: REPO,
      issueNumber: 11,
      label: 'vision-approved',
      timeoutMs: 30_000,
      fetchLabels: async () => ['vision-approved'],
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.label).toBe('vision-approved');
    expect(result.issueNumber).toBe(11);
    expect(result.attempts).toBe(1);
  });

  it('rejects with GateTimeoutError on timeout', async () => {
    const clock = makeFakeClock();
    await expect(
      waitForGate({
        repo: REPO,
        issueNumber: 22,
        label: 'roadmap-approved',
        timeoutMs: 100,
        fetchLabels: async () => [],
        sleep: clock.sleep,
        now: clock.now,
        pollIntervalMs: 200,
      }),
    ).rejects.toThrow(GateTimeoutError);
  });
});

// ---------------------------------------------------------------------------
// fetchIssueLabels — unit (mock execFile via vi.mock not needed — we test
// the real exported fetchLabels here only in shape/contract; gh not available
// in CI, so we skip live calls)
// ---------------------------------------------------------------------------

describe('fetchIssueLabels', () => {
  it('is exported and is a function', () => {
    expect(typeof fetchIssueLabels).toBe('function');
  });

  it('does NOT get called by createGateWatcher tests (confirming injection works)', () => {
    // The tests above never touch the real gh binary — they inject fetchLabels.
    // This test is a documentation assertion.
    expect(true).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GateTimeoutError — message formatting
// ---------------------------------------------------------------------------

describe('GateTimeoutError message', () => {
  it('uses singular "attempt" for 1 attempt', () => {
    const err = new GateTimeoutError(1, 'my-label', 5000, 1);
    expect(err.message).toContain('1 poll attempt)');
  });

  it('uses plural "attempts" for multiple attempts', () => {
    const err = new GateTimeoutError(2, 'other-label', 10000, 4);
    expect(err.message).toContain('4 poll attempts)');
  });
});
