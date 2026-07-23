/**
 * tests/monitor/issue-filer.test.ts
 *
 * Tests for M3-2: Issue filer — `fileMonitorIssue` in
 * `src/monitor/issue-filer.ts`.
 *
 * All tests are hermetic: the `runner` boundary is fully mocked; no real
 * `gh` subprocess is ever spawned.
 *
 * Coverage:
 *   Happy path — issue already exists (exact title match):
 *     - Returns alreadyExisted: true with correct issueNumber
 *     - Does NOT call gh issue create when issue found
 *     - dryRun=true still returns existing issue (alreadyExisted: true)
 *
 *   Happy path — issue not found, create succeeds:
 *     - Returns alreadyExisted: false, issueNumber from URL
 *     - Correct argv for gh issue list (search)
 *     - Correct argv for gh issue create
 *     - dryRun=false is the default
 *
 *   dryRun semantics:
 *     - dryRun: skips create, returns issueNumber: 0 when not found
 *     - dryRun: still calls search (read-only path)
 *     - dryRun: runner called exactly once (search only, no create)
 *
 *   Search resilience:
 *     - Search non-zero exit → treats as not found → proceeds to create
 *     - Search invalid JSON → treats as not found → proceeds to create
 *     - Search non-array JSON → treats as not found → proceeds to create
 *     - Search result with wrong title → not matched → proceeds to create
 *     - Search result with matching title among multiple → returns it
 *
 *   Create error handling:
 *     - Throws when gh issue create exits non-zero
 *     - Throws when gh output has no issue URL
 *
 *   Argv correctness:
 *     - gh issue list receives --repo, --state open, --search <title>, --json, --limit 20
 *     - gh issue create receives --repo, --title, --body (no shell interpolation)
 *
 *   parseIssueNumberFromOutput (exported helper):
 *     - Parses standard GitHub issue URL
 *     - Parses URL from multi-line output
 *     - Returns null for non-URL output
 *     - Returns null for empty string
 *
 *   IssueFiledResult shape:
 *     - dryRun field reflects input dryRun value
 */

import { describe, it, expect, vi } from 'vitest';
import {
  fileMonitorIssue,
  parseIssueNumberFromOutput,
  type IssueFiledResult,
} from '../../src/monitor/issue-filer.js';
import type { CommandRunner } from '../../src/agents/builder.js';
import type { MonitorEvent } from '../../src/monitor/monitor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a mock runner that returns different responses per call index. */
function makeSequentialRunner(...responses: Array<{ stdout: string; stderr?: string; code?: number }>): CommandRunner {
  const fn = vi.fn();
  for (const resp of responses) {
    fn.mockResolvedValueOnce({ stdout: resp.stdout, stderr: resp.stderr ?? '', code: resp.code ?? 0 });
  }
  return { run: fn } as unknown as CommandRunner;
}

/** Builds a sample MonitorEvent for use in tests. */
function makeEvent(overrides: Partial<MonitorEvent> = {}): MonitorEvent {
  return {
    kind: 'ci-failure',
    sourceId: 'run-99',
    title: '[CI] build-and-test failed on abc1234 (run 99)',
    body: '## CI Failure\n\nRun 99 failed.',
    detectedAt: '2026-07-23T12:00:00.000Z',
    ...overrides,
  };
}

/** Search result JSON with one matching issue. */
function searchHit(number: number, title: string): string {
  return JSON.stringify([{ number, title }]);
}

/** Empty search result (no matches). */
const EMPTY_SEARCH = JSON.stringify([]);

/** A valid gh issue create URL output. */
function issueUrl(number: number): string {
  return `https://github.com/suskumar-MSFT/autonomous-delivery-engine/issues/${number}\n`;
}

// ── Happy path: issue already exists ─────────────────────────────────────────

describe('fileMonitorIssue — existing issue', () => {
  it('returns alreadyExisted: true with correct issueNumber when found', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: searchHit(42, event.title) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.alreadyExisted).toBe(true);
    expect(result.issueNumber).toBe(42);
  });

  it('does NOT call gh issue create when issue already exists', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: searchHit(42, event.title) },
    );
    await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it('returns correct dryRun flag when issue found on dryRun', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: searchHit(7, event.title) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, dryRun: true, runner });
    expect(result.alreadyExisted).toBe(true);
    expect(result.issueNumber).toBe(7);
    expect(result.dryRun).toBe(true);
  });

  it('picks the first exact title match among multiple search results', async () => {
    const event = makeEvent();
    const results = JSON.stringify([
      { number: 5, title: '[CI] something else' },
      { number: 11, title: event.title },
      { number: 12, title: event.title },
    ]);
    const runner = makeSequentialRunner({ stdout: results });
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.issueNumber).toBe(11);
    expect(result.alreadyExisted).toBe(true);
  });
});

// ── Happy path: issue not found, create succeeds ─────────────────────────────

describe('fileMonitorIssue — create new issue', () => {
  it('returns alreadyExisted: false, issueNumber from URL', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: issueUrl(99) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.alreadyExisted).toBe(false);
    expect(result.issueNumber).toBe(99);
    expect(result.dryRun).toBe(false);
  });

  it('dryRun=false is the default', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: issueUrl(10) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.dryRun).toBe(false);
  });

  it('calls gh issue list with correct argv', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: issueUrl(1) },
    );
    await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    const firstCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]];
    expect(firstCall[0]).toBe('gh');
    expect(firstCall[1]).toEqual([
      'issue', 'list',
      '--repo', 'owner/repo',
      '--state', 'open',
      '--search', event.title,
      '--json', 'number,title',
      '--limit', '20',
    ]);
  });

  it('calls gh issue create with correct argv', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: issueUrl(5) },
    );
    await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    const secondCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[1] as [string, string[]];
    expect(secondCall[0]).toBe('gh');
    expect(secondCall[1]).toEqual([
      'issue', 'create',
      '--repo', 'owner/repo',
      '--title', event.title,
      '--body', event.body,
    ]);
  });

  it('calls runner exactly twice (search + create) on happy path', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: issueUrl(3) },
    );
    await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});

// ── dryRun semantics ──────────────────────────────────────────────────────────

describe('fileMonitorIssue — dryRun', () => {
  it('skips create, returns issueNumber: 0 when not found', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner({ stdout: EMPTY_SEARCH });
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, dryRun: true, runner });
    expect(result.issueNumber).toBe(0);
    expect(result.alreadyExisted).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  it('still calls search (read-only) on dryRun', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner({ stdout: EMPTY_SEARCH });
    await fileMonitorIssue({ repo: 'owner/repo', event, dryRun: true, runner });
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const firstCall = (runner.run as ReturnType<typeof vi.fn>).mock.calls[0] as [string, string[]];
    expect(firstCall[1][0]).toBe('issue');
    expect(firstCall[1][1]).toBe('list');
  });

  it('calls runner exactly once on dryRun + not found (no create)', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner({ stdout: EMPTY_SEARCH });
    await fileMonitorIssue({ repo: 'owner/repo', event, dryRun: true, runner });
    expect((runner.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});

// ── Search resilience ─────────────────────────────────────────────────────────

describe('fileMonitorIssue — search resilience', () => {
  it('proceeds to create when search returns non-zero exit', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: '', stderr: 'network error', code: 1 },
      { stdout: issueUrl(20) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.alreadyExisted).toBe(false);
    expect(result.issueNumber).toBe(20);
  });

  it('proceeds to create when search returns invalid JSON', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: 'not json at all' },
      { stdout: issueUrl(21) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.alreadyExisted).toBe(false);
    expect(result.issueNumber).toBe(21);
  });

  it('proceeds to create when search returns non-array JSON', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: JSON.stringify({ error: 'unexpected' }) },
      { stdout: issueUrl(22) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.alreadyExisted).toBe(false);
    expect(result.issueNumber).toBe(22);
  });

  it('does not match on different title — proceeds to create', async () => {
    const event = makeEvent({ title: '[CI] exact-title' });
    const runner = makeSequentialRunner(
      { stdout: JSON.stringify([{ number: 5, title: '[CI] different-title' }]) },
      { stdout: issueUrl(30) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.alreadyExisted).toBe(false);
    expect(result.issueNumber).toBe(30);
  });
});

// ── Create error handling ─────────────────────────────────────────────────────

describe('fileMonitorIssue — create errors', () => {
  it('throws when gh issue create exits non-zero', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: '', stderr: 'HTTP 422', code: 1 },
    );
    await expect(fileMonitorIssue({ repo: 'owner/repo', event, runner })).rejects.toThrow(
      'gh issue create failed',
    );
  });

  it('throws when create output has no issue URL', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: 'some unexpected output without a URL' },
    );
    await expect(fileMonitorIssue({ repo: 'owner/repo', event, runner })).rejects.toThrow(
      'could not parse issue number',
    );
  });
});

// ── parseIssueNumberFromOutput ────────────────────────────────────────────────

describe('parseIssueNumberFromOutput', () => {
  it('parses issue number from standard GitHub issue URL', () => {
    expect(parseIssueNumberFromOutput(
      'https://github.com/owner/repo/issues/42',
    )).toBe(42);
  });

  it('parses issue number from multi-line output (URL on last line)', () => {
    const output = 'Creating issue...\nhttps://github.com/owner/repo/issues/123\n';
    expect(parseIssueNumberFromOutput(output)).toBe(123);
  });

  it('returns null for output with no issue URL', () => {
    expect(parseIssueNumberFromOutput('some error message')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseIssueNumberFromOutput('')).toBeNull();
  });

  it('parses large issue numbers correctly', () => {
    expect(parseIssueNumberFromOutput(
      'https://github.com/owner/repo/issues/9999',
    )).toBe(9999);
  });
});

// ── IssueFiledResult shape ────────────────────────────────────────────────────

describe('IssueFiledResult — shape contract', () => {
  it('dryRun field is false when dryRun not set (default)', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: issueUrl(1) },
    );
    const result: IssueFiledResult = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result.dryRun).toBe(false);
  });

  it('dryRun field is true when dryRun: true passed', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner({ stdout: EMPTY_SEARCH });
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, dryRun: true, runner });
    expect(result.dryRun).toBe(true);
  });

  it('all three fields are present on the result', async () => {
    const event = makeEvent();
    const runner = makeSequentialRunner(
      { stdout: EMPTY_SEARCH },
      { stdout: issueUrl(55) },
    );
    const result = await fileMonitorIssue({ repo: 'owner/repo', event, runner });
    expect(result).toHaveProperty('issueNumber');
    expect(result).toHaveProperty('alreadyExisted');
    expect(result).toHaveProperty('dryRun');
  });
});
