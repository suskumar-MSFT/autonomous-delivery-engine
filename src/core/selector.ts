import type { BacklogItem } from '../state/parsers.js';

/**
 * Selects the next unit of work from the backlog.
 *
 * Criteria:
 * - status === 'ready'
 * - owner is empty string (unowned)
 * - deterministic tie-break: natural/numeric-aware sort on the id
 *   so that M0-2 sorts before M0-10.
 *
 * Returns undefined if no eligible items exist.
 */
export function selectNextUnit(items: BacklogItem[]): BacklogItem | undefined {
  const eligible = items.filter(
    item => item.status === 'ready' && item.owner === '',
  );

  if (eligible.length === 0) return undefined;

  // Numeric-aware tie-break: split each id into text and numeric segments,
  // compare segments in order so "M0-2" < "M0-10" < "M0-100".
  const parts = (id: string): Array<string | number> =>
    id.split(/(\d+)/).map(seg => (/^\d+$/.test(seg) ? parseInt(seg, 10) : seg));

  const copy = [...eligible];
  copy.sort((a, b) => {
    const pa = parts(a.id);
    const pb = parts(b.id);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const va = pa[i] ?? '';
      const vb = pb[i] ?? '';
      if (typeof va === 'number' && typeof vb === 'number') {
        if (va !== vb) return va - vb;
      } else {
        const cmp = String(va).localeCompare(String(vb));
        if (cmp !== 0) return cmp;
      }
    }
    return 0;
  });

  return copy[0];
}
