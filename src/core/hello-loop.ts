#!/usr/bin/env node
/**
 * hello-loop CLI entry point
 *
 * Read-only: prints a summary of the current project state and
 * what the next unit of work would be. Never writes or mutates anything.
 *
 * Usage:
 *   node dist/core/hello-loop.js [--state-dir <path>] [--repo <owner/repo>]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseRoadmap, parseBacklog, parseProject } from '../state/parsers.js';
import { listIssues } from '../github/issues.js';
import { selectNextUnit } from './selector.js';

function parseArgs(argv: string[]): { stateDir: string; repo: string } {
  const args = argv.slice(2);
  let stateDir = './fixtures/state';
  let repo = 'suskumar-MSFT/autonomous-delivery-engine';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--state-dir' && args[i + 1]) {
      stateDir = args[++i];
    } else if (args[i] === '--repo' && args[i + 1]) {
      repo = args[++i];
    }
  }

  return { stateDir, repo };
}

async function main() {
  const { stateDir, repo } = parseArgs(process.argv);

  // Read state files
  const roadmapMd = readFileSync(join(stateDir, 'ROADMAP.md'), 'utf8');
  const backlogMd = readFileSync(join(stateDir, 'BACKLOG.md'), 'utf8');
  const projectMd = readFileSync(join(stateDir, 'PROJECT.md'), 'utf8');

  const project = parseProject(projectMd);
  const milestones = parseRoadmap(roadmapMd);
  const backlogItems = parseBacklog(backlogMd);

  // Fetch open issues from GitHub (read-only)
  let issueCount = 0;
  let issueError: string | null = null;
  try {
    const issues = await listIssues(repo);
    issueCount = issues.length;
  } catch (err) {
    issueError = err instanceof Error ? err.message : String(err);
  }

  const nextUnit = selectNextUnit(backlogItems);

  // Print summary
  console.log('═══════════════════════════════════════════════════');
  console.log('  Autonomous Delivery Engine — hello-loop');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Current phase : ${project.phase}`);
  console.log(`  Focus         : ${project.focus}`);
  console.log('');
  console.log('  Milestones:');
  for (const m of milestones) {
    const marker = m.status === 'done' ? '✓' : m.status === 'in-progress' ? '▶' : '○';
    console.log(`    ${marker}  [${m.id}] ${m.name} (phase ${m.phase}) — ${m.status}`);
  }
  console.log('');
  if (issueError) {
    console.log(`  Open GitHub issues : (error: ${issueError})`);
  } else {
    console.log(`  Open GitHub issues : ${issueCount}`);
  }
  console.log('');
  if (nextUnit) {
    console.log(`  Next unit to pick  : [${nextUnit.id}] #${nextUnit.ghNumber} — ${nextUnit.title}`);
  } else {
    console.log('  Next unit to pick  : (none — no ready+unowned items)');
  }
  console.log('═══════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('hello-loop error:', err);
  process.exit(1);
});
