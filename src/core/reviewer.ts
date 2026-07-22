// ---------------------------------------------------------------------------
// Reviewer interface — pluggable independent code-review hook
// ---------------------------------------------------------------------------

/**
 * Input passed to a Reviewer for a completed PR/branch.
 */
export interface ReviewInput {
  /** Repository in `owner/name` format. */
  repo: string;
  /** PR number (extracted from the PR URL). */
  prNumber: number;
  /** Branch name the PR was opened from. */
  branch: string;
}

/**
 * Outcome of an independent review pass.
 * - `PASS`      – the reviewer is satisfied; the merge gate may proceed.
 * - `NEEDS_FIX` – the reviewer found issues; the merge gate must NOT proceed.
 */
export type ReviewVerdict = 'PASS' | 'NEEDS_FIX';

/**
 * Result returned by a Reviewer.
 */
export interface ReviewResult {
  verdict: ReviewVerdict;
  /** Human-readable notes from the reviewer (may be empty on PASS). */
  notes: string;
}

/**
 * Pluggable reviewer interface wired into the loop between PR-open and the
 * merge gate (ADR-017).
 *
 * In CI/tests, inject a mock that returns `{ verdict: 'PASS', notes: '' }`.
 * DO NOT call a live reviewer in CI.
 */
export interface Reviewer {
  review(input: ReviewInput): Promise<ReviewResult>;
}
