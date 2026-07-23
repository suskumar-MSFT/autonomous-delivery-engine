import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { claimOwnerInMarkdown, releaseOwnerInMarkdown, claimOwnerInFile, releaseOwnerInFile } from '../../src/state/owner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_FIXTURE = join(__dirname, '..', '..', 'fixtures', 'real-state', 'BACKLOG.md');
const SYNTH_FIXTURE = join(__dirname, '..', '..', 'fixtures', 'state', 'BACKLOG.md');

// ---------------------------------------------------------------------------
// Minimal synthetic markdown helpers
// ---------------------------------------------------------------------------

const SYNTHETIC_MD = `# Backlog

## Items

| ID     | GH#  | Title           | Type  | Status  | Owner |
|--------|------|-----------------|-------|---------|-------|
| M0-0   | 1    | First story     | story | done    | bot   |
| M0-1   | 2    | Second story    | story | ready   |       |
| M0-2   | 3    | Third story     | story | planned | —     |
`;

const SYNTHETIC_MD_WITH_NOTES = `# Backlog

## Items

| ID   | GH# | Title       | Type  | Status | Owner | Notes         |
|------|-----|-------------|-------|--------|-------|---------------|
| M1-1 | 5   | Core loop   | story | ready  | —     | some note     |
| M1-2 | 6   | Builder     | story | ready  |       | another note  |
`;

// Markdown with two rows sharing the same ID (duplicate/corrupted state)
const SYNTHETIC_MD_DUPS = `# Backlog

## Items

| ID   | GH# | Title         | Type  | Status | Owner |
|------|-----|---------------|-------|--------|-------|
| M0-1 | 2   | First copy    | story | ready  |       |
| M0-1 | 3   | Duplicate row | story | ready  | —     |
| M0-2 | 4   | Other story   | story | ready  |       |
`;

// Dup fixture where the FIRST row is already owned by someone else;
// the second row (same ID) is unowned — must NOT be claimed.
const SYNTHETIC_MD_DUPS_FIRST_OWNED = `# Backlog

## Items

| ID   | GH# | Title         | Type  | Status | Owner |
|------|-----|---------------|-------|--------|-------|
| M0-1 | 2   | First copy    | story | ready  | alice |
| M0-1 | 3   | Duplicate row | story | ready  |       |
| M0-2 | 4   | Other story   | story | ready  |       |
`;

// ---------------------------------------------------------------------------
// Temp dir helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makeTmpStateDir(backlogContent?: string): string {
  const dir = join(tmpdir(), `engine-owner-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  const content = backlogContent ?? readFileSync(SYNTH_FIXTURE, 'utf8');
  writeFileSync(join(dir, 'BACKLOG.md'), content, 'utf8');
  return dir;
}

function makeTmpStateDirFromReal(): string {
  const dir = join(tmpdir(), `engine-owner-real-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  copyFileSync(REAL_FIXTURE, join(dir, 'BACKLOG.md'));
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// claimOwnerInMarkdown — pure function tests
// ---------------------------------------------------------------------------

describe('claimOwnerInMarkdown', () => {
  it('writes the owner cell for a matching unowned row (empty cell)', () => {
    const result = claimOwnerInMarkdown(SYNTHETIC_MD, 'M0-1', 'bot');
    // Should find and update M0-1
    expect(result).toContain('| M0-1 ');
    const lines = result.split('\n');
    const row = lines.find(l => l.includes('| M0-1'));
    expect(row).toBeDefined();
    const cells = row!.split('|');
    expect(cells[6].trim()).toBe('bot');
  });

  it('writes the owner cell when current value is em-dash', () => {
    const result = claimOwnerInMarkdown(SYNTHETIC_MD, 'M0-2', 'bot');
    const lines = result.split('\n');
    const row = lines.find(l => l.includes('| M0-2'));
    expect(row).toBeDefined();
    const cells = row!.split('|');
    expect(cells[6].trim()).toBe('bot');
  });

  it('is idempotent: returns same markdown when owner already equals newOwner', () => {
    const once = claimOwnerInMarkdown(SYNTHETIC_MD, 'M0-1', 'bot');
    const twice = claimOwnerInMarkdown(once, 'M0-1', 'bot');
    expect(twice).toBe(once);
  });

  it('does NOT overwrite a row that already has a different owner', () => {
    // M0-0 already has owner 'bot' — should not change
    const result = claimOwnerInMarkdown(SYNTHETIC_MD, 'M0-0', 'alice');
    const lines = result.split('\n');
    const row = lines.find(l => l.includes('| M0-0'));
    expect(row).toBeDefined();
    const cells = row!.split('|');
    expect(cells[6].trim()).toBe('bot'); // unchanged
  });

  it('returns unchanged markdown when unitId is not found', () => {
    const result = claimOwnerInMarkdown(SYNTHETIC_MD, 'NONEXISTENT', 'bot');
    expect(result).toBe(SYNTHETIC_MD);
  });

  it('does NOT modify non-matching rows', () => {
    const result = claimOwnerInMarkdown(SYNTHETIC_MD, 'M0-1', 'bot');
    // M0-0 and M0-2 should be unchanged
    const lines = result.split('\n');
    const row0 = lines.find(l => l.includes('| M0-0'))!;
    const row2 = lines.find(l => l.includes('| M0-2'))!;
    expect(row0.split('|')[6].trim()).toBe('bot');  // original 'bot' unchanged
    expect(row2.split('|')[6].trim()).toBe('\u2014'); // em-dash unchanged (we only updated M0-1)
  });

  it('handles rows with a Notes column (7-col table)', () => {
    const result = claimOwnerInMarkdown(SYNTHETIC_MD_WITH_NOTES, 'M1-1', 'bot');
    const lines = result.split('\n');
    const row = lines.find(l => l.includes('| M1-1'))!;
    const cells = row.split('|');
    expect(cells[6].trim()).toBe('bot');
    // Notes column (cells[7]) must not be corrupted
    expect(cells[7].trim()).toBe('some note');
  });

  it('handles the real BACKLOG.md format (reads real fixture)', () => {
    const md = readFileSync(REAL_FIXTURE, 'utf8');
    // M0-3 is unowned in the current fixture; claim it
    const result = claimOwnerInMarkdown(md, 'M0-3', 'bot');
    const lines = result.split('\n');
    const row = lines.find(l => {
      const cells = l.split('|');
      return cells.length > 1 && cells[1].trim() === 'M0-3';
    });
    expect(row).toBeDefined();
    expect(row!.split('|')[6].trim()).toBe('bot');
  });

  it('only updates the FIRST matching row when duplicate IDs exist (claim guard)', () => {
    // Both rows have ID M0-1 and are unowned — only the first should be claimed
    const result = claimOwnerInMarkdown(SYNTHETIC_MD_DUPS, 'M0-1', 'bot');
    const lines = result.split('\n');
    const rows = lines.filter(l => {
      const cells = l.split('|');
      return cells.length > 1 && cells[1].trim() === 'M0-1';
    });
    expect(rows).toHaveLength(2);
    // First row claimed
    expect(rows[0].split('|')[6].trim()).toBe('bot');
    // Second row (duplicate) must remain unmodified
    expect(rows[1].split('|')[6].trim()).toBe('\u2014');
  });

  it('does not touch unrelated rows when duplicate IDs exist', () => {
    const result = claimOwnerInMarkdown(SYNTHETIC_MD_DUPS, 'M0-1', 'bot');
    const lines = result.split('\n');
    const m02Row = lines.find(l => {
      const cells = l.split('|');
      return cells.length > 1 && cells[1].trim() === 'M0-2';
    });
    expect(m02Row).toBeDefined();
    expect(m02Row!.split('|')[6].trim()).toBe(''); // unchanged
  });

  it('does NOT claim the second dup row when the first row is already owned by someone else', () => {
    // Row 1: M0-1 owned by "alice" (blocked). Row 2: M0-1 unowned.
    // Calling claim("M0-1", "bob") must leave BOTH rows unchanged —
    // touched=true on the blocked row prevents falling through to row 2.
    const result = claimOwnerInMarkdown(SYNTHETIC_MD_DUPS_FIRST_OWNED, 'M0-1', 'bob');
    const lines = result.split('\n');
    const rows = lines.filter(l => {
      const cells = l.split('|');
      return cells.length > 1 && cells[1].trim() === 'M0-1';
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].split('|')[6].trim()).toBe('alice'); // blocked — unchanged
    expect(rows[1].split('|')[6].trim()).toBe('');      // NOT claimed despite being unowned
  });
});

// ---------------------------------------------------------------------------
// releaseOwnerInMarkdown — pure function tests
// ---------------------------------------------------------------------------

describe('releaseOwnerInMarkdown', () => {
  it('overwrites owner unconditionally (even when currently owned)', () => {
    // M0-0 has owner 'bot' — release should overwrite with new value
    const result = releaseOwnerInMarkdown(SYNTHETIC_MD, 'M0-0', 'bot (PR #42)');
    const lines = result.split('\n');
    const row = lines.find(l => l.includes('| M0-0'))!;
    const cells = row.split('|');
    expect(cells[6].trim()).toBe('bot (PR #42)');
  });

  it('is idempotent when target value already matches', () => {
    const once = releaseOwnerInMarkdown(SYNTHETIC_MD, 'M0-0', 'bot (PR #42)');
    const twice = releaseOwnerInMarkdown(once, 'M0-0', 'bot (PR #42)');
    expect(twice).toBe(once);
  });

  it('returns unchanged markdown when unitId is not found', () => {
    const result = releaseOwnerInMarkdown(SYNTHETIC_MD, 'NONEXISTENT', 'bot');
    expect(result).toBe(SYNTHETIC_MD);
  });

  it('updates the real BACKLOG.md format without corrupting structure', () => {
    const md = readFileSync(REAL_FIXTURE, 'utf8');
    const newOwner = 'bot (https://github.com/owner/repo/pull/7)';
    const result = releaseOwnerInMarkdown(md, 'M0-2', newOwner);
    // Check the row is updated
    const lines = result.split('\n');
    const row = lines.find(l => {
      const cells = l.split('|');
      return cells.length > 1 && cells[1].trim() === 'M0-2';
    });
    expect(row).toBeDefined();
    expect(row!.split('|')[6].trim()).toBe(newOwner);
    // Other rows must not be corrupted
    expect(result).toContain('| M0-3 ');
  });

  it('only updates the FIRST matching row when duplicate IDs exist (release guard)', () => {
    // Both rows share ID M0-1 (first unowned, second em-dash); release should only touch first
    const result = releaseOwnerInMarkdown(SYNTHETIC_MD_DUPS, 'M0-1', 'bot (PR #99)');
    const lines = result.split('\n');
    const rows = lines.filter(l => {
      const cells = l.split('|');
      return cells.length > 1 && cells[1].trim() === 'M0-1';
    });
    expect(rows).toHaveLength(2);
    // First row updated
    expect(rows[0].split('|')[6].trim()).toBe('bot (PR #99)');
    // Second row (duplicate) must remain unmodified
    expect(rows[1].split('|')[6].trim()).toBe('\u2014');
  });
});

// ---------------------------------------------------------------------------
// claimOwnerInFile — file I/O wrapper tests
// ---------------------------------------------------------------------------

describe('claimOwnerInFile', () => {
  it('writes the file when owner is empty', () => {
    const dir = makeTmpStateDir();
    claimOwnerInFile(dir, 'M0-1', 'bot');

    const written = readFileSync(join(dir, 'BACKLOG.md'), 'utf8');
    const row = written.split('\n').find(l => l.includes('| M0-1'));
    expect(row).toBeDefined();
    expect(row!.split('|')[6].trim()).toBe('bot');
  });

  it('does not write file when owner is already set (idempotent)', () => {
    const dir = makeTmpStateDir();
    // First claim
    claimOwnerInFile(dir, 'M0-1', 'bot');
    const afterFirst = readFileSync(join(dir, 'BACKLOG.md'), 'utf8');

    // Second claim with same value — file content must not change
    claimOwnerInFile(dir, 'M0-1', 'bot');
    const afterSecond = readFileSync(join(dir, 'BACKLOG.md'), 'utf8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('does NOT overwrite a different existing owner', () => {
    const dir = makeTmpStateDir();
    // M0-0 already has owner 'bot' in the synthetic fixture
    claimOwnerInFile(dir, 'M0-0', 'alice');

    const written = readFileSync(join(dir, 'BACKLOG.md'), 'utf8');
    const row = written.split('\n').find(l => l.includes('| M0-0'));
    expect(row!.split('|')[6].trim()).toBe('bot'); // unchanged
  });

  it('works with the real-state BACKLOG.md fixture', () => {
    const dir = makeTmpStateDirFromReal();
    // M0-3 is unowned in the current fixture; claim it
    claimOwnerInFile(dir, 'M0-3', 'bot');

    const written = readFileSync(join(dir, 'BACKLOG.md'), 'utf8');
    const row = written.split('\n').find(l => {
      const cells = l.split('|');
      return cells.length > 1 && cells[1].trim() === 'M0-3';
    });
    expect(row).toBeDefined();
    expect(row!.split('|')[6].trim()).toBe('bot');
  });
});

// ---------------------------------------------------------------------------
// releaseOwnerInFile — file I/O wrapper tests
// ---------------------------------------------------------------------------

describe('releaseOwnerInFile', () => {
  it('unconditionally updates the owner cell', () => {
    const dir = makeTmpStateDir();
    // M0-0 starts with owner 'bot'
    releaseOwnerInFile(dir, 'M0-0', 'bot (PR #42)');

    const written = readFileSync(join(dir, 'BACKLOG.md'), 'utf8');
    const row = written.split('\n').find(l => l.includes('| M0-0'));
    expect(row!.split('|')[6].trim()).toBe('bot (PR #42)');
  });

  it('ownership round-trip: claim then release', () => {
    const dir = makeTmpStateDir();
    claimOwnerInFile(dir, 'M0-1', 'bot');
    releaseOwnerInFile(dir, 'M0-1', 'bot (https://github.com/owner/repo/pull/7)');

    const written = readFileSync(join(dir, 'BACKLOG.md'), 'utf8');
    const row = written.split('\n').find(l => l.includes('| M0-1'));
    expect(row!.split('|')[6].trim()).toBe('bot (https://github.com/owner/repo/pull/7)');
  });
});
