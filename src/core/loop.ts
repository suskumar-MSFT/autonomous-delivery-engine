import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseBacklog } from '../state/parsers.js';
import { selectNextUnit } from './selector.js';
import type { BacklogItem } from '../state/parsers.js';
import { runBuilder, type BuilderResult, type CommandRunner } from '../agents/builder.js';

export interface RunOnceOptions {
  repo: string;
  checkoutDir: string;
  stateDir: string;
  runner?: CommandRunner;
}

export interface RunOnceResult {
  selected: BacklogItem | undefined;
  result: BuilderResult | null;
}

/**
 * One pass of the autonomous delivery loop (dry-run only in M1-1).
 *
 * 1. Reads BACKLOG.md from stateDir
 * 2. Selects the next ready+unowned unit via selectNextUnit
 * 3. Calls runBuilder with dryRun:true (no commit/push/PR)
 * 4. Returns {selected, result}
 *
 * Real ownership-write and gated-merge are deferred to M1-3.
 */
export async function runOnce(opts: RunOnceOptions): Promise<RunOnceResult> {
  const { repo, checkoutDir, stateDir, runner } = opts;

  const backlogMd = readFileSync(join(stateDir, 'BACKLOG.md'), 'utf8');
  const backlogItems = parseBacklog(backlogMd);
  const selected = selectNextUnit(backlogItems);

  if (!selected) {
    return { selected: undefined, result: null };
  }

  const result = await runBuilder({
    repo,
    issueNumber: selected.ghNumber,
    checkoutDir,
    dryRun: true,
    runner,
  });

  return { selected, result };
}
