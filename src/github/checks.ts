import type { CommandRunner } from '../agents/builder.js';

// ---------------------------------------------------------------------------
// CI check status
// ---------------------------------------------------------------------------

/**
 * Coarse CI check result for a named check on a PR.
 *
 * - `green`   – the check completed with `SUCCESS`.
 * - `red`     – the check failed (`FAILURE`, `ERROR`, `ACTION_REQUIRED`).
 * - `pending` – the check is still running or queued.
 * - `unknown` – the check was not found, or the gh command failed.
 */
export type CICheckState = 'green' | 'red' | 'pending' | 'unknown';

/**
 * Fetches the state of a named CI check for a pull request via `gh pr checks`.
 *
 * Uses `runner` (CommandRunner) — no direct subprocess call — so this
 * function is fully mockable in tests without spawning a real `gh` process.
 *
 * @param runner      - Injectable CommandRunner (mock in tests).
 * @param repo        - Repository in `owner/name` format.
 * @param prNumber    - Pull request number.
 * @param checkName   - Exact name of the required CI check (default: `build-and-test`).
 * @returns           - Coarse check state.
 */
export async function getCIStatus(
  runner: CommandRunner,
  repo: string,
  prNumber: number,
  checkName = 'build-and-test',
): Promise<CICheckState> {
  // argv form — no shell; checkName comes from a constant, not user input
  const result = await runner.run('gh', [
    'pr', 'checks', String(prNumber),
    '--repo', repo,
    '--json', 'name,state',
  ]);

  if (result.code !== 0) return 'unknown';

  let checks: Array<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed)) return 'unknown';
    checks = parsed as Array<Record<string, unknown>>;
  } catch {
    return 'unknown';
  }

  const check = checks.find(c => String(c['name'] ?? '') === checkName);
  if (!check) return 'unknown';

  const state = String(check['state'] ?? '').toUpperCase();

  if (state === 'SUCCESS') return 'green';
  if (state === 'FAILURE' || state === 'ERROR' || state === 'ACTION_REQUIRED') return 'red';
  // PENDING, IN_PROGRESS, QUEUED, WAITING, REQUESTED, NEUTRAL, SKIPPED, CANCELLED, STALE, …
  return 'pending';
}

// ---------------------------------------------------------------------------
// Utility: extract PR number from a GitHub PR URL
// ---------------------------------------------------------------------------

/**
 * Extracts the numeric PR number from a GitHub PR URL.
 * Returns `null` when the URL does not match the expected shape.
 *
 * @example extractPrNumber('https://github.com/owner/repo/pull/42') // 42
 */
export function extractPrNumber(prUrl: string): number | null {
  const m = prUrl.match(/\/pull\/(\d+)(?:[/?#]|$)/);
  return m ? parseInt(m[1], 10) : null;
}
