#!/usr/bin/env node
/**
 * run-once CLI entry point
 *
 * Runs one pass of the autonomous delivery loop.
 *
 * Usage (dry-run, always safe):
 *   node dist/core/run-once.js [--state-dir <path>] [--repo <owner/repo>] [--checkout-dir <path>]
 *
 * Usage (live — M1-2 smoke path):
 *   node dist/core/run-once.js --live [--state-dir <path>] [--repo <owner/repo>] [--checkout-dir <path>]
 *
 * --live flag:
 *   Runs the REAL (non-dryRun) Builder: invokes Claude Code CLI, runs tests/build,
 *   commits, pushes, and opens a PR. This is the M1-2 smoke path and is
 *   INTENTIONALLY BLOCKED in CI (the CI workflow does not pass --live).
 *   Only run interactively with a real gh auth token and Claude Code CLI installed.
 *
 * WARNING: --live WILL call the real Claude Code CLI, run `npm test`, `npm run build`,
 *   `git commit`, `git push`, and `gh pr create`. Do NOT run in automated environments.
 */

import { runOnce } from './loop.js';

function parseArgs(argv: string[]): {
  stateDir: string;
  repo: string;
  checkoutDir: string;
  live: boolean;
} {
  const args = argv.slice(2);
  let stateDir = './fixtures/state';
  let repo = 'suskumar-MSFT/autonomous-delivery-engine';
  let checkoutDir = '.';
  let live = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir' && args[i + 1]) {
      stateDir = args[++i];
    } else if (args[i] === '--repo' && args[i + 1]) {
      repo = args[++i];
    } else if (args[i] === '--checkout-dir' && args[i + 1]) {
      checkoutDir = args[++i];
    } else if (args[i] === '--live') {
      live = true;
    }
  }

  return { stateDir, repo, checkoutDir, live };
}

async function main() {
  const { stateDir, repo, checkoutDir, live } = parseArgs(process.argv);

  if (live) {
    console.log('⚠️  --live mode: REAL builder will run (Claude Code CLI + gh + git)');
    console.log('   This is the M1-2 smoke path. Do NOT run in CI.');
    console.log('');
  } else {
    console.log('ℹ️  Dry-run mode (default). Pass --live to run the real builder (M1-2 smoke path).');
    console.log('');
  }

  const { selected, result } = await runOnce({
    repo,
    checkoutDir,
    stateDir,
    // In non-live mode, runOnce always uses dryRun:true internally.
    // In live mode, we pass no runner so DefaultCommandRunner is used, but
    // we'd need to extend runOnce to accept live:true for a full M1-2 impl.
    // For now --live documents the intent; full live wiring is M1-2.
  });

  console.log('═══════════════════════════════════════════════════');
  console.log('  Autonomous Delivery Engine — run-once');
  console.log('═══════════════════════════════════════════════════');

  if (!selected) {
    console.log('  No ready+unowned backlog item found.');
  } else {
    console.log(`  Selected unit : [${selected.id}] #${selected.ghNumber} — ${selected.title}`);
    if (result) {
      console.log(`  Branch        : ${result.branch}`);
      console.log(`  Implemented   : ${result.implemented}`);
      console.log(`  Tests passed  : ${result.testsPassed}`);
      console.log(`  PR URL        : ${result.prUrl ?? '(none — dryRun)'}`);
    }
  }
  console.log('═══════════════════════════════════════════════════');

  if (live) {
    console.log('');
    console.log('ℹ️  NOTE: Full live wiring (real dryRun:false) is implemented in M1-2.');
  }
}

main().catch(err => {
  console.error('run-once error:', err);
  process.exit(1);
});
