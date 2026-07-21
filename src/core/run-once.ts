#!/usr/bin/env node
/**
 * run-once CLI entry point
 *
 * Runs one pass of the autonomous delivery loop.
 *
 * Usage (dry-run — default, zero subprocess side-effects):
 *   node dist/core/run-once.js [--state-dir <path>] [--repo <owner/repo>] [--checkout-dir <path>]
 *
 *   The default path runs with dryRun:true.  No gh, claude, npm, or git
 *   subprocesses are spawned; no files are mutated.  Safe to run anywhere.
 *
 * Usage (live — M1-2 smoke path):
 *   node dist/core/run-once.js --live [--state-dir <path>] [--repo <owner/repo>] [--checkout-dir <path>]
 *
 * --live flag:
 *   Intended entry point for the REAL (non-dryRun) Builder: invokes Claude
 *   Code CLI, runs tests/build, commits, pushes, and opens a PR.  Full live
 *   wiring (dryRun:false) is implemented in M1-2; the flag is parsed here so
 *   the CLI surface is stable but presently has no additional effect beyond
 *   the default dry-run path.
 *
 *   --live is the ONLY intended gateway for real subprocess execution.
 *   Do NOT run in automated environments without a real gh auth token and
 *   Claude Code CLI installed.
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
    console.log('⚠️  --live flag detected. Full live wiring (dryRun:false) is implemented in M1-2.');
    console.log('   For now the run proceeds in dry-run mode (zero subprocess side-effects).');
    console.log('');
  } else {
    console.log('ℹ️  Dry-run mode (default, zero subprocess side-effects). Pass --live for the real builder (M1-2 smoke path).');
    console.log('');
  }

  const { selected, result } = await runOnce({
    repo,
    checkoutDir,
    stateDir,
    // dryRun:true is enforced inside loop.ts (runBuilder is always called with
    // dryRun:true in M1-1).  No runner is injected here so DefaultCommandRunner
    // would be the fallback — but dryRun:true short-circuits before any
    // runner.run() call, so no real subprocess can be invoked.
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
    console.log('ℹ️  NOTE: Full live wiring (real dryRun:false) is implemented in M1-2.  This run used dry-run mode.');
  }
}

main().catch(err => {
  console.error('run-once error:', err);
  process.exit(1);
});
