import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BacklogItem } from './parsers.js';

// ---------------------------------------------------------------------------
// resolveBlockers — pure, no I/O
// ---------------------------------------------------------------------------

/**
 * Given a list of backlog items, returns a NEW array where any ⛔ blocked item
 * whose **all** `deps` IDs are ✅ done has its status flipped to `ready`.
 *
 * Items that are not blocked, have no deps, or have at least one non-done dep
 * are returned as-is (same reference — no copy unless status changes).
 *
 * Does NOT mutate the input array.
 */
export function resolveBlockers(items: BacklogItem[]): BacklogItem[] {
  const doneIds = new Set(
    items.filter(i => i.status === 'done').map(i => i.id),
  );
  return items.map(item => {
    if (item.status !== 'blocked') return item;
    if (item.deps.length === 0) return item;
    if (item.deps.every(dep => doneIds.has(dep))) {
      return { ...item, status: 'ready' as const };
    }
    return item;
  });
}

// ---------------------------------------------------------------------------
// Markdown write-back — pure, no I/O
// ---------------------------------------------------------------------------

// Matches ⛔ optionally followed by "blocked" (with/without space).
const BLOCKED_RE = /⛔\s*blocked/i;
// What to replace it with.
const READY_TEXT = '⬜ ready';

/**
 * Returns updated BACKLOG markdown with ⛔ blocked → ⬜ ready for every item
 * that `resolveBlockers` would flip.
 *
 * Only the first matching row per ID is updated (duplicate-ID guard, same
 * convention as owner.ts).  Does not mutate the input string.
 */
export function unblockItemsInMarkdown(md: string, items: BacklogItem[]): string {
  // Compute which IDs should be flipped.
  const resolved = resolveBlockers(items);
  const originalStatus = new Map(items.map(i => [i.id, i.status]));
  const toFlip = new Set<string>();
  for (const item of resolved) {
    if (item.status === 'ready' && originalStatus.get(item.id) === 'blocked') {
      toFlip.add(item.id);
    }
  }
  if (toFlip.size === 0) return md;

  const touched = new Set<string>(); // guard against duplicate-ID rows
  return md
    .split('\n')
    .map(line => {
      if (!line.includes('|')) return line;
      const cells = line.split('|');
      // Need at least: '' | ID | GH# | Title | Type | Status | Owner | ...
      if (cells.length < 7) return line;
      const id = cells[1].trim();
      if (!toFlip.has(id) || touched.has(id)) return line;
      // Skip separator rows (e.g. |---|---|...|)
      if (/^[-: ]+$/.test(id)) return line;

      const statusCell = cells[5];
      let updated: string;
      if (BLOCKED_RE.test(statusCell)) {
        updated = statusCell.replace(BLOCKED_RE, READY_TEXT);
      } else if (statusCell.includes('⛔')) {
        updated = statusCell.replace('⛔', READY_TEXT);
      } else {
        // Status cell doesn't contain ⛔ — no change for this row.
        return line;
      }

      touched.add(id);
      const newCells = [...cells];
      newCells[5] = updated;
      return newCells.join('|');
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// File I/O wrapper
// ---------------------------------------------------------------------------

/**
 * Reads `BACKLOG.md` from `stateDir`, runs `unblockItemsInMarkdown`, and
 * writes the file back if any status cells changed.
 *
 * Returns the set of IDs that were auto-unblocked (for logging).
 * Returns an empty set and skips the write when nothing changes.
 */
export function unblockItemsInFile(
  stateDir: string,
  items: BacklogItem[],
): Set<string> {
  // Compute the flip set before touching the file.
  const doneIds = new Set(items.filter(i => i.status === 'done').map(i => i.id));
  const flipped = new Set<string>();
  for (const item of items) {
    if (
      item.status === 'blocked' &&
      item.deps.length > 0 &&
      item.deps.every(dep => doneIds.has(dep))
    ) {
      flipped.add(item.id);
    }
  }

  if (flipped.size > 0) {
    const path = join(stateDir, 'BACKLOG.md');
    const before = readFileSync(path, 'utf8');
    const after = unblockItemsInMarkdown(before, items);
    if (after !== before) {
      writeFileSync(path, after, 'utf8');
    }
  }

  return flipped;
}
