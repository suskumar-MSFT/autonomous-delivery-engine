import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolveBlockers, unblockItemsInMarkdown, unblockItemsInFile } from '../../src/state/unblock.js';
import { parseDeps, parseBacklog } from '../../src/state/parsers.js';
import type { BacklogItem } from '../../src/state/parsers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_STATE = join(__dirname, '..', '..', 'fixtures', 'real-state');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function item(overrides: Partial<BacklogItem> & Pick<BacklogItem, 'id'>): BacklogItem {
  return {
    ghNumber: 0,
    title: overrides.id,
    type: 'story',
    status: 'ready',
    owner: '',
    deps: [],
    ...overrides,
  };
}

function mkBacklogMd(rows: string[]): string {
  const header = '# Backlog\n\n## Items\n| ID | GH# | Title | Type | Status | Owner | Notes |\n|---|---|---|---|---|---|---|\n';
  return header + rows.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// parseDeps
// ---------------------------------------------------------------------------

describe('parseDeps', () => {
  it('returns [] for empty string', () => {
    expect(parseDeps('')).toEqual([]);
  });

  it('returns [] when no deps annotation', () => {
    expect(parseDeps('Unblocked by M2-1 (done). Some notes.')).toEqual([]);
  });

  it('parses a single dep', () => {
    expect(parseDeps('deps: M2-P1')).toEqual(['M2-P1']);
  });

  it('parses multiple deps', () => {
    expect(parseDeps('deps: M2-1,M2-2')).toEqual(['M2-1', 'M2-2']);
  });

  it('parses deps with spaces around commas', () => {
    expect(parseDeps('deps: M2-P1, M2-P2')).toEqual(['M2-P1', 'M2-P2']);
  });

  it('is case-insensitive', () => {
    expect(parseDeps('DEPS: M1-1')).toEqual(['M1-1']);
  });

  it('works when deps annotation appears mid-notes', () => {
    expect(parseDeps('on M2-P2. deps: M2-P2. ADR-022.')).toEqual(['M2-P2']);
  });

  it('handles dot-separated IDs', () => {
    expect(parseDeps('deps: M2.1,M2.2')).toEqual(['M2.1', 'M2.2']);
  });
});

// ---------------------------------------------------------------------------
// resolveBlockers
// ---------------------------------------------------------------------------

describe('resolveBlockers', () => {
  it('returns empty array unchanged', () => {
    expect(resolveBlockers([])).toEqual([]);
  });

  it('leaves non-blocked items unchanged', () => {
    const items = [
      item({ id: 'A', status: 'ready' }),
      item({ id: 'B', status: 'done' }),
      item({ id: 'C', status: 'planned' }),
    ];
    const result = resolveBlockers(items);
    expect(result[0].status).toBe('ready');
    expect(result[1].status).toBe('done');
    expect(result[2].status).toBe('planned');
  });

  it('leaves blocked item unchanged when deps is empty', () => {
    const items = [item({ id: 'A', status: 'blocked', deps: [] })];
    expect(resolveBlockers(items)[0].status).toBe('blocked');
  });

  it('leaves blocked item unchanged when dep not done', () => {
    const items = [
      item({ id: 'A', status: 'blocked', deps: ['B'] }),
      item({ id: 'B', status: 'in-progress' }),
    ];
    expect(resolveBlockers(items)[0].status).toBe('blocked');
  });

  it('flips blocked → ready when single dep is done', () => {
    const items = [
      item({ id: 'A', status: 'blocked', deps: ['B'] }),
      item({ id: 'B', status: 'done' }),
    ];
    const result = resolveBlockers(items);
    expect(result[0].status).toBe('ready');
  });

  it('flips blocked → ready when all multiple deps are done', () => {
    const items = [
      item({ id: 'A', status: 'blocked', deps: ['B', 'C'] }),
      item({ id: 'B', status: 'done' }),
      item({ id: 'C', status: 'done' }),
    ];
    expect(resolveBlockers(items)[0].status).toBe('ready');
  });

  it('keeps blocked when only SOME deps are done', () => {
    const items = [
      item({ id: 'A', status: 'blocked', deps: ['B', 'C'] }),
      item({ id: 'B', status: 'done' }),
      item({ id: 'C', status: 'ready' }),
    ];
    expect(resolveBlockers(items)[0].status).toBe('blocked');
  });

  it('does not mutate input array', () => {
    const items = [
      item({ id: 'A', status: 'blocked', deps: ['B'] }),
      item({ id: 'B', status: 'done' }),
    ];
    resolveBlockers(items);
    expect(items[0].status).toBe('blocked'); // original unchanged
  });

  it('resolves a chain: B unblocks A, C stays blocked (C deps on A)', () => {
    const items = [
      item({ id: 'A', status: 'blocked', deps: ['B'] }),
      item({ id: 'B', status: 'done' }),
      item({ id: 'C', status: 'blocked', deps: ['A'] }), // A is not done yet
    ];
    const result = resolveBlockers(items);
    expect(result[0].status).toBe('ready'); // A unblocked
    expect(result[2].status).toBe('blocked'); // C still blocked (A is ready, not done)
  });

  it('preserves all other fields unchanged', () => {
    const orig = item({ id: 'A', status: 'blocked', deps: ['B'], owner: 'bot', ghNumber: 5 });
    const items = [orig, item({ id: 'B', status: 'done' })];
    const result = resolveBlockers(items);
    const resolved = result[0];
    expect(resolved.id).toBe('A');
    expect(resolved.owner).toBe('bot');
    expect(resolved.ghNumber).toBe(5);
    expect(resolved.deps).toEqual(['B']);
  });
});

// ---------------------------------------------------------------------------
// unblockItemsInMarkdown
// ---------------------------------------------------------------------------

describe('unblockItemsInMarkdown', () => {
  it('returns original markdown when no items to flip', () => {
    const md = mkBacklogMd([
      '| A | 1 | title | story | ✅ done | — | |',
      '| B | 2 | title | story | ⬜ ready | — | |',
    ]);
    const items = [
      item({ id: 'A', status: 'done' }),
      item({ id: 'B', status: 'ready' }),
    ];
    expect(unblockItemsInMarkdown(md, items)).toBe(md);
  });

  it('replaces ⛔ blocked with ⬜ ready for a flipped item', () => {
    const md = mkBacklogMd([
      '| A | 1 | title | story | ✅ done | — | |',
      '| B | 2 | title | story | ⛔ blocked | — | deps: A |',
    ]);
    const items = [
      item({ id: 'A', status: 'done' }),
      item({ id: 'B', status: 'blocked', deps: ['A'] }),
    ];
    const result = unblockItemsInMarkdown(md, items);
    expect(result).toContain('⬜ ready');
    expect(result).not.toContain('⛔ blocked');
  });

  it('only updates the first matching row (duplicate-ID guard)', () => {
    const md = mkBacklogMd([
      '| A | 1 | title | story | ✅ done | — | |',
      '| B | 2 | title | story | ⛔ blocked | — | deps: A |',
      '| B | 3 | dup   | story | ⛔ blocked | — | deps: A |',
    ]);
    const items = [
      item({ id: 'A', status: 'done' }),
      item({ id: 'B', status: 'blocked', deps: ['A'] }),
    ];
    const result = unblockItemsInMarkdown(md, items);
    const lines = result.split('\n').filter(l => l.includes('| B |'));
    expect(lines[0]).toContain('⬜ ready');
    expect(lines[1]).toContain('⛔ blocked'); // duplicate row NOT touched
  });

  it('handles ⛔ without the word "blocked" (bare emoji)', () => {
    const md = mkBacklogMd([
      '| A | 1 | t | story | ✅ done | — | |',
      '| B | 2 | t | story | ⛔ | — | deps: A |',
    ]);
    const items = [
      item({ id: 'A', status: 'done' }),
      item({ id: 'B', status: 'blocked', deps: ['A'] }),
    ];
    const result = unblockItemsInMarkdown(md, items);
    expect(result).toContain('⬜ ready');
  });

  it('does not touch items whose dep is not done', () => {
    const md = mkBacklogMd([
      '| A | 1 | t | story | ⬜ ready | — | |',
      '| B | 2 | t | story | ⛔ blocked | — | deps: A |',
    ]);
    const items = [
      item({ id: 'A', status: 'ready' }),
      item({ id: 'B', status: 'blocked', deps: ['A'] }),
    ];
    const result = unblockItemsInMarkdown(md, items);
    expect(result).toBe(md); // unchanged
  });
});

// ---------------------------------------------------------------------------
// unblockItemsInFile
// ---------------------------------------------------------------------------

describe('unblockItemsInFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `unblock-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes updated BACKLOG.md when items are unblocked', () => {
    const md = mkBacklogMd([
      '| A | 1 | done item | story | ✅ done | — | |',
      '| B | 2 | blocked   | story | ⛔ blocked | — | deps: A |',
    ]);
    writeFileSync(join(tmpDir, 'BACKLOG.md'), md, 'utf8');

    const items = [
      item({ id: 'A', status: 'done' }),
      item({ id: 'B', status: 'blocked', deps: ['A'] }),
    ];
    const flipped = unblockItemsInFile(tmpDir, items);

    expect(flipped).toContain('B');
    const written = readFileSync(join(tmpDir, 'BACKLOG.md'), 'utf8');
    expect(written).toContain('⬜ ready');
    expect(written).not.toContain('⛔ blocked');
  });

  it('returns empty set and does not write when nothing to flip', () => {
    const md = mkBacklogMd([
      '| A | 1 | ready | story | ⬜ ready | — | |',
    ]);
    writeFileSync(join(tmpDir, 'BACKLOG.md'), md, 'utf8');
    const mtime1 = readFileSync(join(tmpDir, 'BACKLOG.md')).length;

    const items = [item({ id: 'A', status: 'ready' })];
    const flipped = unblockItemsInFile(tmpDir, items);

    expect(flipped.size).toBe(0);
    expect(readFileSync(join(tmpDir, 'BACKLOG.md')).length).toBe(mtime1); // no rewrite
  });

  it('returns a set of all flipped IDs', () => {
    const md = mkBacklogMd([
      '| X | 1 | done | story | ✅ done | — | |',
      '| Y | 2 | blocked | story | ⛔ blocked | — | deps: X |',
      '| Z | 3 | blocked | story | ⛔ blocked | — | deps: X |',
    ]);
    writeFileSync(join(tmpDir, 'BACKLOG.md'), md, 'utf8');

    const items = [
      item({ id: 'X', status: 'done' }),
      item({ id: 'Y', status: 'blocked', deps: ['X'] }),
      item({ id: 'Z', status: 'blocked', deps: ['X'] }),
    ];
    const flipped = unblockItemsInFile(tmpDir, items);
    expect(flipped).toContain('Y');
    expect(flipped).toContain('Z');
    expect(flipped.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// parseBacklog — deps column integration
// ---------------------------------------------------------------------------

describe('parseBacklog — deps field', () => {
  it('returns deps:[] for rows without Notes column', () => {
    const md = '# B\n## Items\n| ID | GH# | Title | Type | Status | Owner |\n|---|---|---|---|---|---|\n| A | 1 | t | story | ready | |\n';
    const items = parseBacklog(md);
    expect(items[0].deps).toEqual([]);
  });

  it('returns deps:[] for Notes column with no deps annotation', () => {
    const md = '# B\n## Items\n| ID | GH# | Title | Type | Status | Owner | Notes |\n|---|---|---|---|---|---|---|\n| A | 1 | t | story | ready | | some notes |\n';
    const items = parseBacklog(md);
    expect(items[0].deps).toEqual([]);
  });

  it('parses deps from Notes column', () => {
    const md = '# B\n## Items\n| ID | GH# | Title | Type | Status | Owner | Notes |\n|---|---|---|---|---|---|---|\n| A | 1 | t | story | blocked | | deps: B,C |\n';
    const items = parseBacklog(md);
    expect(items[0].deps).toEqual(['B', 'C']);
  });
});

// ---------------------------------------------------------------------------
// resolveBlockers — real BACKLOG fixture (integration)
// ---------------------------------------------------------------------------

describe('resolveBlockers (real BACKLOG fixture)', () => {
  it('parses real BACKLOG.md without throwing', () => {
    const md = readFileSync(join(REAL_STATE, 'BACKLOG.md'), 'utf8');
    expect(() => parseBacklog(md)).not.toThrow();
  });

  it('does not flip items whose deps are not all done', () => {
    const md = readFileSync(join(REAL_STATE, 'BACKLOG.md'), 'utf8');
    const items = parseBacklog(md);
    const resolved = resolveBlockers(items);
    // No item should go from blocked→ready unless all deps done
    const doneIds = new Set(items.filter(i => i.status === 'done').map(i => i.id));
    for (let i = 0; i < items.length; i++) {
      if (items[i].status === 'blocked' && resolved[i].status === 'ready') {
        const allDone = items[i].deps.every(dep => doneIds.has(dep));
        expect(allDone).toBe(true);
      }
    }
  });
});
