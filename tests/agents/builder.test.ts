import { describe, it, expect } from 'vitest';
import {
  runBuilder,
  assemblePrompt,
  type CommandRunner,
  type RunResult,
  type RunOptions,
} from '../../src/agents/builder.js';

// ---------------------------------------------------------------------------
// Mock CommandRunner factory
// ---------------------------------------------------------------------------

type MockSpec = Record<string, { stdout?: string; stderr?: string; code?: number }>;

function makeMockRunner(spec: MockSpec): CommandRunner {
  return {
    async run(cmd: string, args: string[], _opts?: RunOptions): Promise<RunResult> {
      // Build a key from cmd + first few args to look up the mock response
      const key = [cmd, ...args].join(' ');
      // Try exact match first, then prefix match
      const entry = spec[key] ?? Object.entries(spec).find(([k]) => key.startsWith(k))?.[1];
      if (!entry) {
        throw new Error(`MockRunner: unexpected call: ${key}`);
      }
      return {
        stdout: entry.stdout ?? '',
        stderr: entry.stderr ?? '',
        code: entry.code ?? 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Shared issue fixture
// ---------------------------------------------------------------------------

const ISSUE_JSON = JSON.stringify({ title: 'Add feature X', body: 'Implement X as described.' });

function baseSpec(overrides: MockSpec = {}): MockSpec {
  return {
    'gh issue view 9 --repo owner/repo --json title,body': { stdout: ISSUE_JSON, code: 0 },
    'claude -p': { stdout: 'Implemented.', code: 0 },
    'npm test': { stdout: 'Tests passed', code: 0 },
    'npm run build': { stdout: 'Build succeeded', code: 0 },
    'git add -A': { stdout: '', code: 0 },
    'git commit': { stdout: '', code: 0 },
    'git push': { stdout: '', code: 0 },
    'gh pr create': { stdout: 'https://github.com/owner/repo/pull/42', code: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: issue → prompt assembly
// ---------------------------------------------------------------------------

describe('assemblePrompt', () => {
  it('includes the repo, issue number, title, body, and branch', () => {
    const prompt = assemblePrompt({
      repo: 'owner/repo',
      issueNumber: 9,
      title: 'Add feature X',
      body: 'Implement X as described.',
      branch: 'feat/issue-9',
    });

    expect(prompt).toContain('owner/repo');
    expect(prompt).toContain('#9');
    expect(prompt).toContain('Add feature X');
    expect(prompt).toContain('Implement X as described.');
    expect(prompt).toContain('feat/issue-9');
  });

  it('contains instructions telling Claude not to commit or push', () => {
    const prompt = assemblePrompt({
      repo: 'owner/repo',
      issueNumber: 1,
      title: 'title',
      body: 'body',
      branch: 'feat/issue-1',
    });
    expect(prompt).toMatch(/do not commit/i);
  });
});

// ---------------------------------------------------------------------------
// Tests: branch naming
// ---------------------------------------------------------------------------

describe('branch naming', () => {
  it('computes branch as feat/issue-<n>', async () => {
    // dryRun:true — zero subprocess calls; no runner spec needed
    const runner: CommandRunner = {
      async run(cmd, args) {
        throw new Error(`Unexpected subprocess call in dryRun: ${cmd} ${args.join(' ')}`);
      },
    };
    const result = await runBuilder({
      repo: 'owner/repo',
      issueNumber: 9,
      checkoutDir: '/tmp/checkout',
      dryRun: true,
      runner,
    });
    expect(result.branch).toBe('feat/issue-9');
  });

  it('uses the correct issue number in the branch for any issue', async () => {
    // dryRun:true — zero subprocess calls; no runner spec needed
    const runner: CommandRunner = {
      async run(cmd, args) {
        throw new Error(`Unexpected subprocess call in dryRun: ${cmd} ${args.join(' ')}`);
      },
    };
    const result = await runBuilder({
      repo: 'owner/repo',
      issueNumber: 42,
      checkoutDir: '/tmp/checkout',
      dryRun: true,
      runner,
    });
    expect(result.branch).toBe('feat/issue-42');
  });
});

// ---------------------------------------------------------------------------
// Tests: happy path
// ---------------------------------------------------------------------------

describe('runBuilder happy path', () => {
  it('dryRun:true returns planned result without invoking ANY subprocess', async () => {
    // The mock throws on ANY unexpected call — if runner.run() is ever
    // invoked with dryRun:true this test will fail, acting as the key
    // regression guard for the "dry-run is not actually dry" defect.
    const runner: CommandRunner = {
      async run(cmd, args) {
        throw new Error(`runner.run() must NEVER be called in dryRun mode — got: ${cmd} ${args.join(' ')}`);
      },
    };

    const result = await runBuilder({
      repo: 'owner/repo',
      issueNumber: 9,
      checkoutDir: '/tmp/checkout',
      dryRun: true,
      runner,
    });

    // dryRun short-circuits before any subprocess: values reflect planned state
    expect(result.branch).toBe('feat/issue-9');
    expect(result.prUrl).toBeNull();
    expect(result.implemented).toBe(false);
    expect(result.testsPassed).toBe(false);
    expect(result.dryRun).toBe(true);
  });

  it('returns prUrl when dryRun:false and all steps succeed', async () => {
    const runner = makeMockRunner(baseSpec());
    const result = await runBuilder({
      repo: 'owner/repo',
      issueNumber: 9,
      checkoutDir: '/tmp/checkout',
      dryRun: false,
      runner,
    });

    expect(result.implemented).toBe(true);
    expect(result.testsPassed).toBe(true);
    expect(result.prUrl).toBe('https://github.com/owner/repo/pull/42');
  });
});

// ---------------------------------------------------------------------------
// Tests: failure path — tests fail
// ---------------------------------------------------------------------------

describe('runBuilder failure path', () => {
  it('returns testsPassed:false and prUrl:null when npm test fails', async () => {
    const runner = makeMockRunner(
      baseSpec({ 'npm test': { stdout: '', stderr: 'FAIL', code: 1 } }),
    );
    const result = await runBuilder({
      repo: 'owner/repo',
      issueNumber: 9,
      checkoutDir: '/tmp/checkout',
      dryRun: false,
      runner,
    });

    expect(result.testsPassed).toBe(false);
    expect(result.prUrl).toBeNull();
    expect(result.implemented).toBe(true); // claude succeeded
  });

  it('returns testsPassed:false and prUrl:null when npm run build fails', async () => {
    const runner = makeMockRunner(
      baseSpec({ 'npm run build': { stdout: '', stderr: 'Build error', code: 1 } }),
    );
    const result = await runBuilder({
      repo: 'owner/repo',
      issueNumber: 9,
      checkoutDir: '/tmp/checkout',
      dryRun: false,
      runner,
    });

    expect(result.testsPassed).toBe(false);
    expect(result.prUrl).toBeNull();
  });

  it('returns implemented:false when claude exits non-zero', async () => {
    const runner = makeMockRunner(
      baseSpec({ 'claude -p': { stdout: '', stderr: 'Claude error', code: 1 } }),
    );
    const result = await runBuilder({
      repo: 'owner/repo',
      issueNumber: 9,
      checkoutDir: '/tmp/checkout',
      dryRun: false,
      runner,
    });

    expect(result.implemented).toBe(false);
    expect(result.testsPassed).toBe(false);
    expect(result.prUrl).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests: repo validation
// ---------------------------------------------------------------------------

describe('runBuilder repo validation', () => {
  it('throws on invalid repo format', async () => {
    const runner = makeMockRunner({});
    await expect(
      runBuilder({
        repo: 'bad repo!',
        issueNumber: 1,
        checkoutDir: '/tmp',
        runner,
      }),
    ).rejects.toThrow(/Invalid repo/);
  });
});
