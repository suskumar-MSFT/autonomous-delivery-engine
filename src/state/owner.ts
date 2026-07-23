import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if an owner cell value counts as "unowned"
 * (empty, em-dash, or plain dash).
 */
function isEmptyOwner(cell: string): boolean {
  const t = cell.trim();
  return t === '' || t === '\u2014' /* — */ || t === '-';
}

/**
 * Finds and returns the pipe-split cells array for the row whose first data
 * cell (index 1) matches `unitId`, or null if not found / is a separator row.
 *
 * Split shape: ['', ' ID ', ' GH# ', ' Title ', ' Type ', ' Status ', ' Owner ', ...]
 * Index:          0     1      2        3           4         5            6
 */
function findRowCells(line: string, unitId: string): string[] | null {
  if (!line.includes('|')) return null;
  const cells = line.split('|');
  // Need at least 7 segments (empty, ID, GH#, Title, Type, Status, Owner, maybe empty)
  if (cells.length < 7) return null;
  const id = cells[1].trim();
  if (id !== unitId) return null;
  // Skip separator rows (e.g. |---|---|...|)
  if (/^[-: ]+$/.test(id)) return null;
  return cells;
}

/**
 * Updates the owner cell (column index 6 in the pipe-split array) of a
 * markdown table row while preserving surrounding whitespace padding.
 */
function replaceOwnerCell(cells: string[], newOwner: string): string {
  const col = cells[6];
  // Preserve left padding (spaces before content), set right to single space
  const leftPad = col.length - col.trimStart().length;
  cells[6] = ' '.repeat(Math.max(1, leftPad)) + newOwner + ' ';
  return cells.join('|');
}

// ---------------------------------------------------------------------------
// Pure markdown write-back functions (return updated string, no I/O)
// ---------------------------------------------------------------------------

/**
 * Returns updated markdown with the owner cell for `unitId` set to `newOwner`.
 *
 * **Claim semantics (idempotent):**  Only overwrites the cell when the current
 * value is empty/em-dash.  If the cell already has a non-empty owner (even a
 * different one) the markdown is returned unchanged, preventing double-claims.
 * If the cell already equals `newOwner` exactly, it is also a no-op.
 *
 * Returns the original markdown unchanged if `unitId` is not found.
 */
export function claimOwnerInMarkdown(md: string, unitId: string, newOwner: string): string {
  const lines = md.split('\n');
  let touched = false; // stop after the first matching row to guard against duplicate IDs
  const updated = lines.map(line => {
    if (touched) return line;
    const cells = findRowCells(line, unitId);
    if (!cells) return line;
    // Idempotent: only claim if currently unowned
    const currentOwner = cells[6]?.trim() ?? '';
    if (currentOwner === newOwner) { touched = true; return line; } // already this owner — no-op
    if (!isEmptyOwner(currentOwner)) { touched = true; return line; } // already owned by someone else — skip
    touched = true;
    return replaceOwnerCell([...cells], newOwner);
  });
  return updated.join('\n');
}

/**
 * Returns updated markdown with the owner cell for `unitId` set to `newOwner`,
 * **unconditionally** (used when releasing/updating ownership post-PR-open).
 *
 * Returns the original markdown unchanged if `unitId` is not found.
 */
export function releaseOwnerInMarkdown(md: string, unitId: string, newOwner: string): string {
  const lines = md.split('\n');
  let touched = false; // stop after the first matching row to guard against duplicate IDs
  const updated = lines.map(line => {
    if (touched) return line;
    const cells = findRowCells(line, unitId);
    if (!cells) return line;
    const current = cells[6]?.trim() ?? '';
    if (current === newOwner) { touched = true; return line; } // already the target value — no-op
    touched = true;
    return replaceOwnerCell([...cells], newOwner);
  });
  return updated.join('\n');
}

// ---------------------------------------------------------------------------
// File I/O wrappers (read BACKLOG.md → transform → write back if changed)
// ---------------------------------------------------------------------------

/**
 * Reads `BACKLOG.md` from `stateDir`, applies `claimOwnerInMarkdown`, and
 * writes the file back if the content changed.
 *
 * Idempotent: calling this twice with the same arguments is a no-op on the
 * second call (the file is only written when the content actually changes).
 */
export function claimOwnerInFile(stateDir: string, unitId: string, newOwner: string): void {
  const path = join(stateDir, 'BACKLOG.md');
  const before = readFileSync(path, 'utf8');
  const after = claimOwnerInMarkdown(before, unitId, newOwner);
  if (after !== before) {
    writeFileSync(path, after, 'utf8');
  }
}

/**
 * Reads `BACKLOG.md` from `stateDir`, applies `releaseOwnerInMarkdown`, and
 * writes the file back if the content changed.
 */
export function releaseOwnerInFile(stateDir: string, unitId: string, newOwner: string): void {
  const path = join(stateDir, 'BACKLOG.md');
  const before = readFileSync(path, 'utf8');
  const after = releaseOwnerInMarkdown(before, unitId, newOwner);
  if (after !== before) {
    writeFileSync(path, after, 'utf8');
  }
}
