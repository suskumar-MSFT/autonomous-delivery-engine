import type { BacklogItem } from '../state/parsers.js';

/**
 * Selects the next unit of work from the backlog.
 *
 * Criteria:
 * - status === 'ready'
 * - owner is empty string (unowned)
 * - deterministic tie-break: lowest id lexicographically
 *
 * Returns undefined if no eligible items exist.
 */
export function selectNextUnit(items: BacklogItem[]): BacklogItem | undefined {
  const eligible = items.filter(
    item => item.status === 'ready' && item.owner === '',
  );

  if (eligible.length === 0) return undefined;

  // Deterministic tie-break: sort by id lexicographically, pick first
  eligible.sort((a, b) => a.id.localeCompare(b.id));
  return eligible[0];
}
