/**
 * tests/monitor/ci-watcher.test.ts
 *
 * Tests for M3-1: CI health poller — `fetchFailedRuns` in
 * `src/monitor/ci-watcher.ts`.
 *
 * All tests are hermetic: the `runner` boundary is fully mocked; no real
 * `gh` subprocess is ever spawned.
 *
 * Coverage:
 *   - Returns [] on non-zero gh exit (error resilience)
 *   - Returns [] on invalid / non-array JSON (parse resilience)
 *   - Returns [] when all runs have non-failure conclusions
 *   - Emits MonitorEvent for `failure` conclusion
 *   - Emits MonitorEvent for `action_required` conclusion
 *   - Conclusion comparison is case-insensitive
 *   - Does NOT emit events for cancelled/skipped/success/pending/in_progress
 *   - Multiple failed runs → multiple events (correct count + order)
 *   - sourceId matches databaseId (string)
 *   - sourceId stringifies numeric databaseId
 *   - kind is always 'ci-failure'
 *   - title format: [CI] <name> failed on <sha7> (run <id>)
 *   - body contains run link
 *   - detectedAt uses injectable now()
 *   - Default lookback passes --limit 10 to gh
 *   - Custom lookback passes correct --limit
 *   - Calls runner with correct argv (repo + json fields)
 *   - Never calls real subprocess (runner is fully injectable)
 *   - Returns [] when JSON root is not an array
 *   - Handles headSha shorter than 7 chars gracefully
 */

import { describe, it, expect, vi } from 'vitest';
import { fetchFailedRuns, type CiWatcherOpts } from '../../src/monitor/ci-watcher.js';
import type { CommandRunner } from '../../src/agents/builder.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRunner(stdout: string, code = 0): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue({ stdout, stderr: '', code }),
  } as unknown as CommandRunner;
}

function makeRun(overrides: Partial<{
  databaseId: string | number;
  status: string;
  conclusion: string | null;
  headSha: string;
  updatedAt: string;
  name: string;
}> = {}) {
  return {
    databaseId: '12345',
    status: 'completed',
    conclusion: 'failure',
    headSha: 'abc1234def5678',
    updatedAt: '2026-07-23T10:00:00Z',
    name: 'build-and-test',
    ...overrides,
  };
}

// ── Error resilience ──────────────────────────────────────────────────────────

describe('fetchFailedRuns — error resilience', () => {
  it('returns [] when runner exits with non-zero code', async () => {
    const runner = makeRunner('', 1);
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });

  it('does not throw on non-zero runner exit', async () => {
    const runner = makeRunner('error: auth required', 1);
    await expect(fetchFailedRuns({ repo: 'owner/repo', runner })).resolves.not.toThrow();
  });

  it('returns [] when runner returns invalid JSON', async () => {
    const runner = makeRunner('not-json');
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });

  it('returns [] when JSON root is an object (not array)', async () => {
    const runner = makeRunner('{"error":"unexpected"}');
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });

  it('returns [] when JSON is a number', async () => {
    const runner = makeRunner('42');
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });

  it('returns [] on empty stdout', async () => {
    const runner = makeRunner('');
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });
});

// ── No failures ───────────────────────────────────────────────────────────────

describe('fetchFailedRuns — no failures', () => {
  it('returns [] when all runs succeeded', async () => {
    const runs = [makeRun({ conclusion: 'success' }), makeRun({ conclusion: 'success' })];
    const runner = makeRunner(JSON.stringify(runs));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });

  it('returns [] for cancelled conclusion', async () => {
    const runner = makeRunner(JSON.stringify([makeRun({ conclusion: 'cancelled' })]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });

  it('returns [] for skipped conclusion', async () => {
    const runner = makeRunner(JSON.stringify([makeRun({ conclusion: 'skipped' })]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });

  it('returns [] for null conclusion (in-progress run)', async () => {
    const runner = makeRunner(JSON.stringify([makeRun({ conclusion: null, status: 'in_progress' })]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });

  it('returns [] for empty runs array', async () => {
    const runner = makeRunner(JSON.stringify([]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toEqual([]);
  });
});

// ── Failure detection ─────────────────────────────────────────────────────────

describe('fetchFailedRuns — failure detection', () => {
  it('emits a MonitorEvent for a run with conclusion=failure', async () => {
    const run = makeRun({ conclusion: 'failure' });
    const runner = makeRunner(JSON.stringify([run]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('ci-failure');
  });

  it('emits a MonitorEvent for conclusion=action_required', async () => {
    const run = makeRun({ conclusion: 'action_required' });
    const runner = makeRunner(JSON.stringify([run]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('ci-failure');
  });

  it('conclusion comparison is case-insensitive — FAILURE', async () => {
    const run = makeRun({ conclusion: 'FAILURE' });
    const runner = makeRunner(JSON.stringify([run]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toHaveLength(1);
  });

  it('conclusion comparison is case-insensitive — ACTION_REQUIRED', async () => {
    const run = makeRun({ conclusion: 'ACTION_REQUIRED' });
    const runner = makeRunner(JSON.stringify([run]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toHaveLength(1);
  });

  it('emits events for all failed runs (multiple failures)', async () => {
    const runs = [
      makeRun({ databaseId: '111', conclusion: 'failure', name: 'lint' }),
      makeRun({ databaseId: '222', conclusion: 'success', name: 'deploy' }),
      makeRun({ databaseId: '333', conclusion: 'action_required', name: 'build-and-test' }),
    ];
    const runner = makeRunner(JSON.stringify(runs));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toHaveLength(2);
    expect(result[0].sourceId).toBe('111');
    expect(result[1].sourceId).toBe('333');
  });
});

// ── Event shape ───────────────────────────────────────────────────────────────

describe('fetchFailedRuns — event shape', () => {
  it('sourceId matches string databaseId', async () => {
    const run = makeRun({ databaseId: 'run-abc-99' });
    const runner = makeRunner(JSON.stringify([run]));
    const [event] = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(event.sourceId).toBe('run-abc-99');
  });

  it('sourceId stringifies numeric databaseId', async () => {
    const run = makeRun({ databaseId: 99999 });
    const runner = makeRunner(JSON.stringify([run]));
    const [event] = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(event.sourceId).toBe('99999');
    expect(typeof event.sourceId).toBe('string');
  });

  it('title includes workflow name', async () => {
    const run = makeRun({ name: 'e2e-tests', databaseId: '42' });
    const runner = makeRunner(JSON.stringify([run]));
    const [event] = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(event.title).toContain('e2e-tests');
  });

  it('title includes 7-char sha prefix', async () => {
    const run = makeRun({ headSha: 'deadbeef1234' });
    const runner = makeRunner(JSON.stringify([run]));
    const [event] = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(event.title).toContain('deadbee');
  });

  it('title includes run id', async () => {
    const run = makeRun({ databaseId: '7654321' });
    const runner = makeRunner(JSON.stringify([run]));
    const [event] = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(event.title).toContain('7654321');
  });

  it('title starts with [CI]', async () => {
    const run = makeRun();
    const runner = makeRunner(JSON.stringify([run]));
    const [event] = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(event.title).toMatch(/^\[CI\]/);
  });

  it('body contains a link to the run', async () => {
    const run = makeRun({ databaseId: '555', conclusion: 'failure' });
    const runner = makeRunner(JSON.stringify([run]));
    const [event] = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(event.body).toContain('https://github.com/owner/repo/actions/runs/555');
  });

  it('detectedAt is an ISO string using injectable now()', async () => {
    const fixedMs = new Date('2026-07-23T12:00:00.000Z').getTime();
    const now = vi.fn(() => fixedMs);
    const run = makeRun();
    const runner = makeRunner(JSON.stringify([run]));
    const [event] = await fetchFailedRuns({ repo: 'owner/repo', runner, now });
    expect(event.detectedAt).toBe('2026-07-23T12:00:00.000Z');
    expect(now).toHaveBeenCalled();
  });

  it('handles headSha shorter than 7 chars without crashing', async () => {
    const run = makeRun({ headSha: 'abc' });
    const runner = makeRunner(JSON.stringify([run]));
    const result = await fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(result).toHaveLength(1);
    expect(result[0].title).toContain('abc');
  });
});

// ── gh argv / runner boundary ─────────────────────────────────────────────────

describe('fetchFailedRuns — runner boundary', () => {
  it('calls runner with gh run list and --repo', async () => {
    const runner = makeRunner('[]');
    await fetchFailedRuns({ repo: 'myorg/myrepo', runner });
    const mock = runner.run as ReturnType<typeof vi.fn>;
    expect(mock).toHaveBeenCalledOnce();
    const [cmd, argv] = mock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('gh');
    expect(argv).toContain('run');
    expect(argv).toContain('list');
    expect(argv).toContain('--repo');
    expect(argv).toContain('myorg/myrepo');
  });

  it('uses default lookback of 10 (--limit 10)', async () => {
    const runner = makeRunner('[]');
    await fetchFailedRuns({ repo: 'owner/repo', runner });
    const mock = runner.run as ReturnType<typeof vi.fn>;
    const argv = mock.mock.calls[0][1] as string[];
    const limitIdx = argv.indexOf('--limit');
    expect(limitIdx).toBeGreaterThan(-1);
    expect(argv[limitIdx + 1]).toBe('10');
  });

  it('passes custom lookback as --limit', async () => {
    const runner = makeRunner('[]');
    await fetchFailedRuns({ repo: 'owner/repo', runner, lookback: 25 });
    const mock = runner.run as ReturnType<typeof vi.fn>;
    const argv = mock.mock.calls[0][1] as string[];
    const limitIdx = argv.indexOf('--limit');
    expect(argv[limitIdx + 1]).toBe('25');
  });

  it('requests the expected JSON fields', async () => {
    const runner = makeRunner('[]');
    await fetchFailedRuns({ repo: 'owner/repo', runner });
    const mock = runner.run as ReturnType<typeof vi.fn>;
    const argv = mock.mock.calls[0][1] as string[];
    const jsonIdx = argv.indexOf('--json');
    expect(jsonIdx).toBeGreaterThan(-1);
    const fields = argv[jsonIdx + 1];
    expect(fields).toContain('databaseId');
    expect(fields).toContain('conclusion');
    expect(fields).toContain('headSha');
    expect(fields).toContain('updatedAt');
    expect(fields).toContain('name');
  });

  it('returns a Promise (async contract)', () => {
    const runner = makeRunner('[]');
    const p = fetchFailedRuns({ repo: 'owner/repo', runner });
    expect(p).toBeInstanceOf(Promise);
    return p;
  });
});

// ── CiWatcherOpts type-level smoke ────────────────────────────────────────────

describe('CiWatcherOpts type contract', () => {
  it('accepts minimal opts (repo only) and uses DefaultCommandRunner implicitly', async () => {
    // We don't actually call it with a live runner; just verify the type compiles
    // and that the function signature accepts repo-only options.
    const opts: CiWatcherOpts = { repo: 'owner/repo' };
    expect(opts.repo).toBe('owner/repo');
    expect(opts.runner).toBeUndefined();
    expect(opts.lookback).toBeUndefined();
    expect(opts.now).toBeUndefined();
  });
});
