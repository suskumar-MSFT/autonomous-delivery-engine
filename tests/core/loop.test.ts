import { describe, it, expect } from 'vitest';
import { runOnce } from '../../src/core/loop.js';
import type { CommandRunner } from '../../src/agents/builder.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_STATE_DIR = join(__dirname, '../../fixtures/state');
/** A fixtures dir whose BACKLOG.md has NO ready+unowned items (all done/planned). */
const EMPTY_BACKLOG_STATE_DIR = join(__dirname, '../fixtures/empty-backlog');

// ---------------------------------------------------------------------------
// The fixtures/state/BACKLOG.md has at least one ready+unowned item.
// ---------------------------------------------------------------------------

describe('runOnce', () => {
  it('returns the selected backlog item and a dryRun builder result', async () => {
    // dryRun:true (hardcoded in loop.ts) now short-circuits BEFORE any
    // subprocess call — no gh/claude/npm mock entries are needed.
    const runner: CommandRunner = {
      async run(cmd, args) {
        throw new Error(`Unexpected subprocess call in dryRun: ${cmd} ${args.join(' ')}`);
      },
    };

    const { selected, result } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      runner,
    });

    expect(selected).toBeDefined();
    expect(selected?.status).toBe('ready');
    expect(selected?.owner).toBe('');

    expect(result).not.toBeNull();
    // dryRun:true short-circuits — planned result values
    expect(result?.implemented).toBe(false);
    expect(result?.testsPassed).toBe(false);
    expect(result?.dryRun).toBe(true);
    // no PR in dryRun
    expect(result?.prUrl).toBeNull();
    expect(result?.branch).toBe(`feat/issue-${selected?.ghNumber}`);
  });

  it('returns {selected:undefined, result:null} when backlog has no ready+unowned items', async () => {
    // Uses a fixture BACKLOG.md with only done/planned items — selectNextUnit
    // returns undefined, triggering the early-return in loop.ts (~lines 37-39).
    // The runner must NEVER be called since we exit before runBuilder.
    const runner: CommandRunner = {
      async run(cmd, args) {
        throw new Error(`runner.run() must not be called when no item is selected: ${cmd} ${args.join(' ')}`);
      },
    };

    const { selected, result } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: EMPTY_BACKLOG_STATE_DIR,
      runner,
    });

    expect(selected).toBeUndefined();
    expect(result).toBeNull();
  });

  it('propagates runner into builder (no real network calls)', async () => {
    // dryRun:true means the runner is never actually called; we just verify
    // that the run completes without error and returns the planned shape.
    const calledWith: string[] = [];
    const runner: CommandRunner = {
      async run(cmd, args) {
        calledWith.push(`${cmd} ${args.join(' ')}`);
        // Should never reach here in dryRun mode
        return { stdout: 'ok', stderr: '', code: 0 };
      },
    };

    const { result } = await runOnce({
      repo: 'owner/repo',
      checkoutDir: '/tmp/checkout',
      stateDir: FIXTURES_STATE_DIR,
      runner,
    });

    // dryRun:true — zero subprocess calls
    expect(calledWith).toHaveLength(0);
    expect(result?.dryRun).toBe(true);
    expect(result?.branch).toMatch(/^feat\/issue-\d+$/);
  });

  // ── M1-5: repo validation independent of builderFn ───────────────────────

  it('throws synchronously on an invalid repo string (dryRun path)', async () => {
    // M1-5: runOnce must reject malformed repo before dispatching builderFn.
    // A custom builderFn is injected to confirm it is NEVER called — the guard
    // fires before the backlog read.
    let builderCalled = false;
    const invalidRepos = [
      '',
      'no-slash',
      'owner/repo; rm -rf /',
      'owner/repo | cat',
      'owner repo',
      '../traversal/repo',
    ];

    for (const badRepo of invalidRepos) {
      await expect(
        runOnce({
          repo: badRepo,
          checkoutDir: '/tmp/checkout',
          stateDir: FIXTURES_STATE_DIR,
          builderFn: async () => {
            builderCalled = true;
            return { branch: '', implemented: false, testsPassed: false, prUrl: null, dryRun: true };
          },
        }),
      ).rejects.toThrow(/Invalid repo/);
    }

    expect(builderCalled).toBe(false);
  });

  it('accepts a valid repo string and does not call the default runner (dryRun path)', async () => {
    // M1-5: confirm valid repos pass the guard and proceed normally.
    const validRepos = [
      'owner/repo',
      'suskumar-MSFT/autonomous-delivery-engine',
      'org.name/repo.name',
      'a/b',
    ];

    for (const goodRepo of validRepos) {
      const { result } = await runOnce({
        repo: goodRepo,
        checkoutDir: '/tmp/checkout',
        stateDir: FIXTURES_STATE_DIR,
        runner: {
          async run(cmd, args) {
            throw new Error(`Unexpected subprocess in dryRun: ${cmd} ${args.join(' ')}`);
          },
        },
      });
      expect(result?.dryRun).toBe(true);
    }
  });
});
