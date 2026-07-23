/**
 * tests/monitor/monitor.test.ts
 *
 * Tests for M3-0 (scaffold) + M3-4 (runMonitor full implementation).
 *
 * M3-0 tests verify shared types + the MonitorRunResult shape contract.
 * M3-4 tests verify end-to-end runMonitor behaviour via injectable seams:
 *   - fetchFailedRuns wired via injectable runner
 *   - fileMonitorIssue wired via injectable runner (search + create)
 *   - dispatchFix wired via injectable writeFile/mkdirp
 *
 * All tests are hermetic — no real gh/fs subprocesses.
 */

import { describe, it, expect, vi } from 'vitest';
import { runMonitor, type MonitorEvent, type MonitorOpts, type MonitorRunResult } from '../../src/monitor/monitor.js';
import type { CommandRunner } from '../../src/agents/builder.js';

// ── Type-level smoke tests ────────────────────────────────────────────────────

describe('MonitorEvent type', () => {
  it('accepts a valid ci-failure event', () => {
    const event: MonitorEvent = {
      kind: 'ci-failure',
      sourceId: 'run-12345',
      title: '[CI] Tests failed on main (run 12345)',
      body: '## CI Failure\n\nWorkflow run 12345 failed.',
      detectedAt: '2026-07-23T10:00:00.000Z',
    };
    expect(event.kind).toBe('ci-failure');
    expect(event.sourceId).toBe('run-12345');
  });

  it('accepts pr-stale and regression kinds (reserved for M4)', () => {
    const stale: MonitorEvent = {
      kind: 'pr-stale',
      sourceId: 'pr-42',
      title: '[PR] PR #42 stale',
      body: 'No activity for 7 days.',
      detectedAt: '2026-07-23T10:00:00.000Z',
    };
    const regression: MonitorEvent = {
      kind: 'regression',
      sourceId: 'commit-abc',
      title: '[Regression] test-suite shrank after commit abc',
      body: 'Test count dropped by 12.',
      detectedAt: '2026-07-23T10:00:00.000Z',
    };
    expect(stale.kind).toBe('pr-stale');
    expect(regression.kind).toBe('regression');
  });
});

// ── runMonitor implementation contracts ──────────────────────────────────────

// Shared helper: a runner that returns no failed runs (gh run list → []).
function noFailuresRunner(): CommandRunner {
  return {
    run: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '', code: 0 }),
  };
}

describe('runMonitor (M3-0 scaffold + M3-4 wiring)', () => {
  it('returns a well-formed MonitorRunResult with zero failures when no runs fail', async () => {
    const result: MonitorRunResult = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      runner: noFailuresRunner(),
    });

    expect(result).toMatchObject({
      failuresDetected: 0,
      issuesFiledOrExisting: [],
      workOrdersDispatched: [],
      errors: [],
    });
  });

  it('accepts dryRun: true without error', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      dryRun: true,
      runner: noFailuresRunner(),
    });
    expect(result.failuresDetected).toBe(0);
  });

  it('accepts dryRun: false without error (no failures → nothing mutating)', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner: noFailuresRunner(),
    });
    expect(result.failuresDetected).toBe(0);
  });

  it('calls the injectable runner (for fetchFailedRuns CI poll)', async () => {
    // M3-4: runner IS called for gh run list — returns [] so no issues or work-orders
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '', code: 0 }),
    };
    await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      runner,
    });
    expect((runner.run as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('writeFile not called when dryRun=true (no work-orders written)', async () => {
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '', code: 0 }),
    };
    const writeFile = vi.fn();
    await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      dryRun: true,
      runner,
      writeFile: writeFile as MonitorOpts['writeFile'],
    });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('accepts injectable now() and passes it to sub-modules', async () => {
    const now = vi.fn(() => Date.now());
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '', code: 0 }),
    };
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      now,
      runner,
    });
    // fetchFailedRuns calls now() for detectedAt; no failures so count=0
    expect(result.failuresDetected).toBe(0);
    expect(now).toHaveBeenCalled();
  });

  it('accepts a custom lookback without error', async () => {
    const runner: CommandRunner = {
      run: vi.fn().mockResolvedValue({ stdout: '[]', stderr: '', code: 0 }),
    };
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      lookback: 5,
      runner,
    });
    expect(result.failuresDetected).toBe(0);
  });

  it('issuesFiledOrExisting is an empty array when no failures', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      runner: noFailuresRunner(),
    });
    expect(Array.isArray(result.issuesFiledOrExisting)).toBe(true);
    expect(result.issuesFiledOrExisting).toHaveLength(0);
  });

  it('workOrdersDispatched is an empty array when no failures', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      runner: noFailuresRunner(),
    });
    expect(Array.isArray(result.workOrdersDispatched)).toBe(true);
    expect(result.workOrdersDispatched).toHaveLength(0);
  });

  it('errors is an empty array when no failures', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      runner: noFailuresRunner(),
    });
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns a Promise (async contract)', () => {
    const p = runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      runner: noFailuresRunner(),
    });
    expect(p).toBeInstanceOf(Promise);
    return p;
  });
});

// ── M3-4 behavioural tests ────────────────────────────────────────────────────

/** One failed run entry for gh run list --json */
function makeFailedRun(overrides: Partial<{
  databaseId: string; conclusion: string; headSha: string;
  updatedAt: string; name: string; status: string;
}> = {}) {
  return {
    databaseId: '99001',
    status: 'completed',
    conclusion: 'failure',
    headSha: 'abc1234def56',
    updatedAt: '2026-07-23T12:00:00Z',
    name: 'build-and-test',
    ...overrides,
  };
}

/**
 * Build a full mock runner that handles all three gh calls:
 *   1. gh run list → `runs` JSON
 *   2. gh issue list (search) → `existingIssues` JSON
 *   3. gh issue create → issue URL (only invoked when createUrl is provided and not dryRun)
 */
function makeFullRunner(
  runs: object[],
  existingIssues: object[] = [],
  createUrl = 'https://github.com/owner/repo/issues/42',
): CommandRunner {
  return {
    run: vi.fn(async (_cmd: string, args: string[]) => {
      if (args.includes('run') && args.includes('list')) {
        return { stdout: JSON.stringify(runs), stderr: '', code: 0 };
      }
      if (args.includes('issue') && args.includes('list')) {
        return { stdout: JSON.stringify(existingIssues), stderr: '', code: 0 };
      }
      if (args.includes('issue') && args.includes('create')) {
        return { stdout: createUrl, stderr: '', code: 0 };
      }
      throw new Error(`Unexpected gh call: ${args.join(' ')}`);
    }),
  } as unknown as CommandRunner;
}

describe('runMonitor (M3-4 implementation) — no failures', () => {
  it('returns failuresDetected=0 when runner returns empty runs', async () => {
    const result = await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      runner: makeFullRunner([]),
    });
    expect(result.failuresDetected).toBe(0);
    expect(result.issuesFiledOrExisting).toHaveLength(0);
    expect(result.workOrdersDispatched).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('calls runner.run with gh run list and --repo', async () => {
    const runner = makeFullRunner([]);
    await runMonitor({ repo: 'myorg/myrepo', checkoutDir: '/tmp/engine', runner });
    const mock = (runner.run as ReturnType<typeof vi.fn>);
    const runListCall = mock.mock.calls.find((c: string[][]) => c[1].includes('run') && c[1].includes('list'));
    expect(runListCall).toBeDefined();
    expect(runListCall![1]).toContain('myorg/myrepo');
  });
});

describe('runMonitor (M3-4 implementation) — one failure, new issue (live)', () => {
  const ISSUE_URL = 'https://github.com/owner/repo/issues/77';

  function opts(): MonitorOpts {
    return {
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner: makeFullRunner([makeFailedRun()], [], ISSUE_URL),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdirp: vi.fn().mockResolvedValue(undefined),
      statFile: vi.fn().mockRejectedValue(new Error('ENOENT')), // no result file → dispatch
      now: () => new Date('2026-07-23T12:00:00Z').getTime(),
    };
  }

  it('failuresDetected = 1', async () => {
    const result = await runMonitor(opts());
    expect(result.failuresDetected).toBe(1);
  });

  it('issuesFiledOrExisting contains the new issue number', async () => {
    const result = await runMonitor(opts());
    expect(result.issuesFiledOrExisting).toContain(77);
  });

  it('workOrdersDispatched contains one path', async () => {
    const result = await runMonitor(opts());
    expect(result.workOrdersDispatched).toHaveLength(1);
    expect(result.workOrdersDispatched[0]).toContain('77');
  });

  it('errors is empty', async () => {
    const result = await runMonitor(opts());
    expect(result.errors).toHaveLength(0);
  });

  it('writeFile is called once (work-order written)', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    await runMonitor({ ...opts(), writeFile });
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it('work-order JSON contains repo and issueNumber', async () => {
    let written = '';
    const writeFile = vi.fn(async (_path: string, data: string) => { written = data; });
    await runMonitor({ ...opts(), writeFile });
    const payload = JSON.parse(written) as { repo: string; issueNumber: number; branch: string };
    expect(payload.repo).toBe('owner/repo');
    expect(payload.issueNumber).toBe(77);
    expect(payload.branch).toBe('fix/issue-77');
  });
});

describe('runMonitor (M3-4 implementation) — dryRun=true', () => {
  it('runs CI poll (read-only) but skips issue create and work-order write', async () => {
    const writeFile = vi.fn();
    const runner = makeFullRunner([makeFailedRun()], []); // empty existing → dryRun skips create
    const result = await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: true,
      runner,
      writeFile,
    });
    // CI poll ran → failure detected
    expect(result.failuresDetected).toBe(1);
    // But create was skipped → issueNumber=0 → not added to list
    expect(result.issuesFiledOrExisting).toHaveLength(0);
    // No work-order written
    expect(result.workOrdersDispatched).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('does not call gh issue create (dryRun guard)', async () => {
    const runner = makeFullRunner([makeFailedRun()], []);
    const mock = runner.run as ReturnType<typeof vi.fn>;
    await runMonitor({ repo: 'owner/repo', checkoutDir: '/tmp/engine', dryRun: true, runner });
    const createCall = mock.mock.calls.find((c: string[][]) => c[1].includes('create'));
    expect(createCall).toBeUndefined();
  });
});

describe('runMonitor (M3-4 implementation) — already-existing issue', () => {
  it('issuesFiledOrExisting contains existing issue number', async () => {
    const existingIssues = [{ number: 55, title: '[CI] build-and-test failed on abc1234 (run 99001)' }];
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const mkdirp = vi.fn().mockResolvedValue(undefined);
    // statFile throws → result file absent → dispatch proceeds
    const statFile = vi.fn().mockRejectedValue(new Error('ENOENT'));
    const result = await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner: makeFullRunner([makeFailedRun()], existingIssues),
      writeFile,
      mkdirp,
      statFile,
    });
    expect(result.issuesFiledOrExisting).toContain(55);
    // fix still dispatched for existing issue (no result file yet)
    expect(result.workOrdersDispatched).toHaveLength(1);
  });

  it('gh issue create is NOT called when issue already exists', async () => {
    const existingIssues = [{ number: 55, title: '[CI] build-and-test failed on abc1234 (run 99001)' }];
    const runner = makeFullRunner([makeFailedRun()], existingIssues);
    const mock = runner.run as ReturnType<typeof vi.fn>;
    await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner,
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdirp: vi.fn().mockResolvedValue(undefined),
      statFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    });
    const createCall = mock.mock.calls.find((c: string[][]) => c[1].includes('create'));
    expect(createCall).toBeUndefined();
  });
});

describe('runMonitor (M3-4 implementation) — idempotency guard (result file exists)', () => {
  it('skips dispatchFix when result file already exists (fix already fulfilled)', async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    // statFile resolves → result file exists → skip dispatch
    const statFile = vi.fn().mockResolvedValue(undefined);
    const result = await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner: makeFullRunner([makeFailedRun()], [], 'https://github.com/owner/repo/issues/99'),
      writeFile,
      statFile,
    });
    expect(result.failuresDetected).toBe(1);
    expect(result.issuesFiledOrExisting).toContain(99);
    // dispatch skipped — result file existed
    expect(result.workOrdersDispatched).toHaveLength(0);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('statFile called with the result-file path for the issue', async () => {
    const statFile = vi.fn().mockRejectedValue(new Error('ENOENT')); // absent
    await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner: makeFullRunner([makeFailedRun()], [], 'https://github.com/owner/repo/issues/42'),
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdirp: vi.fn().mockResolvedValue(undefined),
      statFile,
    });
    expect(statFile).toHaveBeenCalledOnce();
    const calledPath = statFile.mock.calls[0][0] as string;
    expect(calledPath).toContain('42');
    expect(calledPath).toContain('.result.json');
  });

  it('custom workOrdersDir is used for the result file check', async () => {
    const statFile = vi.fn().mockResolvedValue(undefined); // result exists → skip
    await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      workOrdersDir: '/custom/orders',
      runner: makeFullRunner([makeFailedRun()], [], 'https://github.com/owner/repo/issues/7'),
      writeFile: vi.fn(),
      statFile,
    });
    const calledPath = statFile.mock.calls[0][0] as string;
    expect(calledPath).toContain('custom');
    expect(calledPath).toContain('orders');
  });
});

describe('runMonitor (M3-4 implementation) — error resilience', () => {
  it('fileMonitorIssue create error adds to errors[] and skips fix dispatch', async () => {
    const runner: CommandRunner = {
      run: vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes('run') && args.includes('list')) {
          return { stdout: JSON.stringify([makeFailedRun()]), stderr: '', code: 0 };
        }
        if (args.includes('issue') && args.includes('list')) {
          return { stdout: '[]', stderr: '', code: 0 };
        }
        if (args.includes('issue') && args.includes('create')) {
          return { stdout: '', stderr: 'auth error', code: 1 }; // create fails
        }
        throw new Error(`Unexpected: ${args.join(' ')}`);
      }),
    } as unknown as CommandRunner;

    const writeFile = vi.fn();
    const result = await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner,
      writeFile,
    });

    expect(result.failuresDetected).toBe(1);
    expect(result.issuesFiledOrExisting).toHaveLength(0);
    expect(result.workOrdersDispatched).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('fileMonitorIssue');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('dispatchFix error adds to errors[] but issue is still in issuesFiledOrExisting', async () => {
    const writeFile = vi.fn().mockRejectedValue(new Error('disk full'));
    const mkdirp = vi.fn().mockResolvedValue(undefined);
    const statFile = vi.fn().mockRejectedValue(new Error('ENOENT')); // no result file → attempt dispatch
    const result = await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner: makeFullRunner([makeFailedRun()], [], 'https://github.com/owner/repo/issues/88'),
      writeFile,
      mkdirp,
      statFile,
    });

    expect(result.failuresDetected).toBe(1);
    expect(result.issuesFiledOrExisting).toContain(88);
    expect(result.workOrdersDispatched).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('dispatchFix');
  });

  it('processes remaining events after one event errors', async () => {
    let createCallCount = 0;
    const runner: CommandRunner = {
      run: vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes('run') && args.includes('list')) {
          return {
            stdout: JSON.stringify([
              makeFailedRun({ databaseId: '111', name: 'lint' }),
              makeFailedRun({ databaseId: '222', name: 'build-and-test' }),
            ]),
            stderr: '', code: 0,
          };
        }
        if (args.includes('issue') && args.includes('list')) {
          return { stdout: '[]', stderr: '', code: 0 };
        }
        if (args.includes('issue') && args.includes('create')) {
          createCallCount++;
          if (createCallCount === 1) {
            return { stdout: '', stderr: 'rate limited', code: 1 }; // first create fails
          }
          return { stdout: 'https://github.com/owner/repo/issues/200', stderr: '', code: 0 };
        }
        throw new Error(`Unexpected: ${args.join(' ')}`);
      }),
    } as unknown as CommandRunner;

    const result = await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner,
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdirp: vi.fn().mockResolvedValue(undefined),
      statFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    });

    expect(result.failuresDetected).toBe(2);
    expect(result.errors).toHaveLength(1); // first event errored
    expect(result.issuesFiledOrExisting).toContain(200); // second event succeeded
    expect(result.workOrdersDispatched).toHaveLength(1);
  });
});

describe('runMonitor (M3-4 implementation) — multiple failures', () => {
  it('processes all failed runs', async () => {
    let issueNum = 100;
    const runner: CommandRunner = {
      run: vi.fn(async (_cmd: string, args: string[]) => {
        if (args.includes('run') && args.includes('list')) {
          return {
            stdout: JSON.stringify([
              makeFailedRun({ databaseId: '11', name: 'lint' }),
              makeFailedRun({ databaseId: '22', name: 'build' }),
            ]),
            stderr: '', code: 0,
          };
        }
        if (args.includes('issue') && args.includes('list')) {
          return { stdout: '[]', stderr: '', code: 0 };
        }
        if (args.includes('issue') && args.includes('create')) {
          issueNum++;
          return { stdout: `https://github.com/owner/repo/issues/${issueNum}`, stderr: '', code: 0 };
        }
        throw new Error(`Unexpected: ${args.join(' ')}`);
      }),
    } as unknown as CommandRunner;

    const result = await runMonitor({
      repo: 'owner/repo',
      checkoutDir: '/tmp/engine',
      dryRun: false,
      runner,
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdirp: vi.fn().mockResolvedValue(undefined),
      statFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    });

    expect(result.failuresDetected).toBe(2);
    expect(result.issuesFiledOrExisting).toHaveLength(2);
    expect(result.workOrdersDispatched).toHaveLength(2);
    expect(result.errors).toHaveLength(0);
  });
});
