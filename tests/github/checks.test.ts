import { describe, it, expect } from 'vitest';
import { getCIStatus, extractPrNumber } from '../../src/github/checks.js';
import type { CommandRunner, RunResult, RunOptions } from '../../src/agents/builder.js';

// ---------------------------------------------------------------------------
// Mock runner factory
// ---------------------------------------------------------------------------

type MockSpec = Record<string, { stdout?: string; stderr?: string; code?: number }>;

function makeMockRunner(spec: MockSpec): CommandRunner {
  return {
    async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
      const key = [cmd, ...args].join(' ');
      const entry = spec[key] ?? Object.entries(spec).find(([k]) => key.startsWith(k))?.[1];
      if (!entry) throw new Error(`MockRunner: unexpected call: ${key}`);
      return { stdout: entry.stdout ?? '', stderr: entry.stderr ?? '', code: entry.code ?? 0 };
    },
  };
}

// ---------------------------------------------------------------------------
// extractPrNumber
// ---------------------------------------------------------------------------

describe('extractPrNumber', () => {
  it('extracts number from a standard GitHub PR URL', () => {
    expect(extractPrNumber('https://github.com/owner/repo/pull/42')).toBe(42);
  });

  it('extracts number from URL with trailing slash', () => {
    expect(extractPrNumber('https://github.com/owner/repo/pull/7/')).toBe(7);
  });

  it('extracts number from URL with query string', () => {
    expect(extractPrNumber('https://github.com/owner/repo/pull/100?foo=bar')).toBe(100);
  });

  it('returns null for a non-PR URL', () => {
    expect(extractPrNumber('https://github.com/owner/repo')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(extractPrNumber('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getCIStatus
// ---------------------------------------------------------------------------

const CI_GREEN = JSON.stringify([
  { name: 'build-and-test', state: 'SUCCESS' },
  { name: 'other-check', state: 'SUCCESS' },
]);

const CI_RED = JSON.stringify([
  { name: 'build-and-test', state: 'FAILURE' },
]);

const CI_PENDING = JSON.stringify([
  { name: 'build-and-test', state: 'IN_PROGRESS' },
]);

const CI_ACTION_REQUIRED = JSON.stringify([
  { name: 'build-and-test', state: 'ACTION_REQUIRED' },
]);

const CI_MISSING = JSON.stringify([
  { name: 'some-other-check', state: 'SUCCESS' },
]);

describe('getCIStatus', () => {
  it('returns "green" when build-and-test has state SUCCESS', async () => {
    const runner = makeMockRunner({
      'gh pr checks 42 --repo owner/repo --json name,state': { stdout: CI_GREEN, code: 0 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 42)).toBe('green');
  });

  it('returns "red" when build-and-test has state FAILURE', async () => {
    const runner = makeMockRunner({
      'gh pr checks 42 --repo owner/repo --json name,state': { stdout: CI_RED, code: 0 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 42)).toBe('red');
  });

  it('returns "red" when build-and-test has state ACTION_REQUIRED', async () => {
    const runner = makeMockRunner({
      'gh pr checks 42 --repo owner/repo --json name,state': { stdout: CI_ACTION_REQUIRED, code: 0 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 42)).toBe('red');
  });

  it('returns "pending" when build-and-test is still running', async () => {
    const runner = makeMockRunner({
      'gh pr checks 42 --repo owner/repo --json name,state': { stdout: CI_PENDING, code: 0 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 42)).toBe('pending');
  });

  it('returns "unknown" when the named check is not present', async () => {
    const runner = makeMockRunner({
      'gh pr checks 42 --repo owner/repo --json name,state': { stdout: CI_MISSING, code: 0 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 42)).toBe('unknown');
  });

  it('returns "unknown" when gh pr checks exits non-zero', async () => {
    const runner = makeMockRunner({
      'gh pr checks 42 --repo owner/repo --json name,state': { stdout: '', stderr: 'error', code: 1 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 42)).toBe('unknown');
  });

  it('returns "unknown" when JSON is malformed', async () => {
    const runner = makeMockRunner({
      'gh pr checks 42 --repo owner/repo --json name,state': { stdout: 'not-json', code: 0 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 42)).toBe('unknown');
  });

  it('returns "unknown" when JSON is not an array', async () => {
    const runner = makeMockRunner({
      'gh pr checks 42 --repo owner/repo --json name,state': { stdout: '{"error":"oops"}', code: 0 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 42)).toBe('unknown');
  });

  it('supports a custom check name', async () => {
    const payload = JSON.stringify([{ name: 'my-custom-check', state: 'SUCCESS' }]);
    const runner = makeMockRunner({
      'gh pr checks 99 --repo owner/repo --json name,state': { stdout: payload, code: 0 },
    });
    expect(await getCIStatus(runner, 'owner/repo', 99, 'my-custom-check')).toBe('green');
  });

  it('calls gh pr checks via the runner (no direct subprocess)', async () => {
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(cmd, args) {
        calls.push([cmd, ...args].join(' '));
        return { stdout: CI_GREEN, stderr: '', code: 0 };
      },
    };
    await getCIStatus(runner, 'owner/repo', 42);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe('gh pr checks 42 --repo owner/repo --json name,state');
  });
});
