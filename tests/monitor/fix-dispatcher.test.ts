/**
 * tests/monitor/fix-dispatcher.test.ts
 *
 * Tests for M3-3: Fix dispatcher — `dispatchFix` in
 * `src/monitor/fix-dispatcher.ts`.
 *
 * All tests are hermetic: the `writeFile` and `mkdirp` boundaries are fully
 * mocked; no real filesystem I/O, no subprocesses, no network calls.
 *
 * Coverage:
 *   dryRun semantics:
 *     - dryRun: true → returns workOrderPath: null immediately
 *     - dryRun: true → zero writeFile calls
 *     - dryRun: true → zero mkdirp calls
 *     - dryRun: true → dryRun field is true in result
 *     - dryRun: false (explicit) → proceeds to write
 *     - dryRun defaults to false when omitted
 *
 *   Happy path (dryRun: false):
 *     - Returns workOrderPath pointing to <workOrdersDir>/<issueNumber>.json
 *     - writeFile is called exactly once
 *     - mkdirp is called exactly once with the workOrdersDir
 *     - dryRun field is false in result
 *     - issueNumber field matches input
 *     - Writes valid JSON to the correct path
 *
 *   Work-order payload correctness:
 *     - repo field matches input
 *     - issueNumber field matches input
 *     - branch is "fix/issue-<issueNumber>"
 *     - checkoutDir matches input
 *     - requestedAt is an ISO 8601 string derived from now()
 *
 *   Injectable seams:
 *     - Custom workOrdersDir is used (not hardcoded "work-orders")
 *     - Injectable now() is used for requestedAt
 *     - Injectable writeFile is called with (path, jsonString)
 *     - Injectable mkdirp is called with workOrdersDir
 *
 *   Path construction:
 *     - Work-order path uses join(workOrdersDir, `${issueNumber}.json`)
 *     - Works for issue numbers with multiple digits
 *
 *   FixDispatchResult shape:
 *     - workOrderPath is the same path passed to writeFile
 *     - issueNumber matches input
 *     - dryRun matches input
 */

import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import {
  dispatchFix,
  type FixDispatchResult,
  type FixDispatcherOpts,
} from '../../src/monitor/fix-dispatcher.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

interface Mocks {
  writeFile: ReturnType<typeof vi.fn>;
  mkdirp: ReturnType<typeof vi.fn>;
}

/** Builds injectable mocks that succeed by default. */
function makeMocks(): Mocks {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdirp: vi.fn().mockResolvedValue(undefined),
  };
}

/** Builds a minimal FixDispatcherOpts with all seams injected. */
function makeOpts(
  overrides: Partial<FixDispatcherOpts> = {},
  mocks?: Mocks,
): FixDispatcherOpts {
  const m = mocks ?? makeMocks();
  return {
    repo: 'owner/repo',
    issueNumber: 42,
    checkoutDir: '/tmp/engine',
    workOrdersDir: '/tmp/work-orders',
    now: () => 1_700_000_000_000,
    writeFile: m.writeFile as unknown as (path: string, data: string) => Promise<void>,
    mkdirp: m.mkdirp as unknown as (dir: string) => Promise<void>,
    ...overrides,
  };
}

// ── dryRun semantics ─────────────────────────────────────────────────────────

describe('dispatchFix — dryRun: true', () => {
  it('returns workOrderPath: null', async () => {
    const result = await dispatchFix(makeOpts({ dryRun: true }));
    expect(result.workOrderPath).toBeNull();
  });

  it('returns dryRun: true in result', async () => {
    const result = await dispatchFix(makeOpts({ dryRun: true }));
    expect(result.dryRun).toBe(true);
  });

  it('returns correct issueNumber even in dryRun', async () => {
    const result = await dispatchFix(makeOpts({ dryRun: true, issueNumber: 7 }));
    expect(result.issueNumber).toBe(7);
  });

  it('calls writeFile zero times', async () => {
    const mocks = makeMocks();
    await dispatchFix(makeOpts({ dryRun: true }, mocks));
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it('calls mkdirp zero times', async () => {
    const mocks = makeMocks();
    await dispatchFix(makeOpts({ dryRun: true }, mocks));
    expect(mocks.mkdirp).not.toHaveBeenCalled();
  });
});

describe('dispatchFix — dryRun defaults to false', () => {
  it('writes file when dryRun is omitted', async () => {
    const mocks = makeMocks();
    const result = await dispatchFix(makeOpts({}, mocks));
    expect(mocks.writeFile).toHaveBeenCalledOnce();
    expect(result.dryRun).toBe(false);
    expect(result.workOrderPath).not.toBeNull();
  });
});

describe('dispatchFix — dryRun: false (explicit)', () => {
  it('proceeds to write when dryRun is false', async () => {
    const mocks = makeMocks();
    const result = await dispatchFix(makeOpts({ dryRun: false }, mocks));
    expect(mocks.writeFile).toHaveBeenCalledOnce();
    expect(result.dryRun).toBe(false);
  });
});

// ── Happy path ───────────────────────────────────────────────────────────────

describe('dispatchFix — happy path', () => {
  it('returns workOrderPath = join(workOrdersDir, issueNumber.json)', async () => {
    const mocks = makeMocks();
    const opts = makeOpts({ workOrdersDir: '/tmp/work-orders', issueNumber: 42 }, mocks);
    const result = await dispatchFix(opts);
    expect(result.workOrderPath).toBe(join('/tmp/work-orders', '42.json'));
  });

  it('writeFile called exactly once', async () => {
    const mocks = makeMocks();
    await dispatchFix(makeOpts({}, mocks));
    expect(mocks.writeFile).toHaveBeenCalledOnce();
  });

  it('mkdirp called exactly once with workOrdersDir', async () => {
    const mocks = makeMocks();
    await dispatchFix(makeOpts({ workOrdersDir: '/tmp/wo' }, mocks));
    expect(mocks.mkdirp).toHaveBeenCalledOnce();
    expect(mocks.mkdirp).toHaveBeenCalledWith('/tmp/wo');
  });

  it('dryRun field is false in result', async () => {
    const result = await dispatchFix(makeOpts());
    expect(result.dryRun).toBe(false);
  });

  it('issueNumber field matches input', async () => {
    const result = await dispatchFix(makeOpts({ issueNumber: 99 }));
    expect(result.issueNumber).toBe(99);
  });

  it('writeFile receives the workOrderPath as first arg', async () => {
    const mocks = makeMocks();
    const opts = makeOpts({ workOrdersDir: '/wo', issueNumber: 5 }, mocks);
    await dispatchFix(opts);
    const [path] = mocks.writeFile.mock.calls[0] as [string, string];
    expect(path).toBe(join('/wo', '5.json'));
  });

  it('writeFile receives valid JSON as second arg', async () => {
    const mocks = makeMocks();
    await dispatchFix(makeOpts({}, mocks));
    const [, data] = mocks.writeFile.mock.calls[0] as [string, string];
    expect(() => JSON.parse(data)).not.toThrow();
  });
});

// ── Work-order payload correctness ───────────────────────────────────────────

describe('dispatchFix — work-order payload', () => {
  async function getPayload(overrides: Partial<FixDispatcherOpts> = {}): Promise<Record<string, unknown>> {
    const mocks = makeMocks();
    await dispatchFix(makeOpts(overrides, mocks));
    const [, data] = mocks.writeFile.mock.calls[0] as [string, string];
    return JSON.parse(data) as Record<string, unknown>;
  }

  it('repo field matches input', async () => {
    const payload = await getPayload({ repo: 'myorg/myrepo' });
    expect(payload['repo']).toBe('myorg/myrepo');
  });

  it('issueNumber field matches input', async () => {
    const payload = await getPayload({ issueNumber: 17 });
    expect(payload['issueNumber']).toBe(17);
  });

  it('branch is fix/issue-<issueNumber>', async () => {
    const payload = await getPayload({ issueNumber: 55 });
    expect(payload['branch']).toBe('fix/issue-55');
  });

  it('checkoutDir matches input', async () => {
    const payload = await getPayload({ checkoutDir: '/home/user/engine' });
    expect(payload['checkoutDir']).toBe('/home/user/engine');
  });

  it('requestedAt is ISO 8601 string from now()', async () => {
    const nowMs = 1_700_000_000_000;
    const payload = await getPayload({ now: () => nowMs });
    expect(payload['requestedAt']).toBe(new Date(nowMs).toISOString());
  });

  it('requestedAt uses injectable now() (not real clock)', async () => {
    const fixedMs = 1_234_567_890_123;
    const payload = await getPayload({ now: () => fixedMs });
    expect(payload['requestedAt']).toBe(new Date(fixedMs).toISOString());
  });
});

// ── Injectable seams ─────────────────────────────────────────────────────────

describe('dispatchFix — injectable seams', () => {
  it('uses custom workOrdersDir (not hardcoded "work-orders")', async () => {
    const mocks = makeMocks();
    const dir = join('custom', 'dir');
    const opts = makeOpts({ workOrdersDir: dir, issueNumber: 3 }, mocks);
    const result = await dispatchFix(opts);
    expect(result.workOrderPath).toContain(dir);
    expect(mocks.mkdirp).toHaveBeenCalledWith(dir);
  });

  it('injectable writeFile receives path and JSON string', async () => {
    const mocks = makeMocks();
    await dispatchFix(makeOpts({ issueNumber: 11 }, mocks));
    expect(mocks.writeFile).toHaveBeenCalledOnce();
    const [path, data] = mocks.writeFile.mock.calls[0] as [string, string];
    expect(path).toContain('11.json');
    expect(typeof data).toBe('string');
    expect(JSON.parse(data)).toMatchObject({ issueNumber: 11 });
  });
});

// ── Path construction ─────────────────────────────────────────────────────────

describe('dispatchFix — path construction', () => {
  it('works for multi-digit issue numbers', async () => {
    const mocks = makeMocks();
    const opts = makeOpts({ issueNumber: 1234, workOrdersDir: '/wo' }, mocks);
    const result = await dispatchFix(opts);
    expect(result.workOrderPath).toBe(join('/wo', '1234.json'));
  });

  it('workOrderPath returned matches path passed to writeFile', async () => {
    const mocks = makeMocks();
    const result = await dispatchFix(makeOpts({}, mocks));
    const [writtenPath] = mocks.writeFile.mock.calls[0] as [string, string];
    expect(result.workOrderPath).toBe(writtenPath);
  });
});

// ── FixDispatchResult shape ───────────────────────────────────────────────────

describe('dispatchFix — FixDispatchResult shape', () => {
  it('result has workOrderPath, issueNumber, dryRun fields', async () => {
    const result: FixDispatchResult = await dispatchFix(makeOpts());
    expect(result).toHaveProperty('workOrderPath');
    expect(result).toHaveProperty('issueNumber');
    expect(result).toHaveProperty('dryRun');
  });

  it('dryRun=true result has all three fields', async () => {
    const result: FixDispatchResult = await dispatchFix(makeOpts({ dryRun: true }));
    expect(result).toHaveProperty('workOrderPath');
    expect(result).toHaveProperty('issueNumber');
    expect(result).toHaveProperty('dryRun');
  });
});
