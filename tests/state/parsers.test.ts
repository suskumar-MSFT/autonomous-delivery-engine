import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoadmap, parseBacklog, parseProject } from '../../src/state/parsers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC = join(__dirname, '..', '..', 'fixtures', 'state');
const REAL = join(__dirname, '..', '..', 'fixtures', 'real-state');

function fixture(dir: string, name: string): string {
  return readFileSync(join(dir, name), 'utf8');
}

// ─── parseRoadmap — synthetic fixtures ───────────────────────────────────────

describe('parseRoadmap (synthetic fixtures)', () => {
  it('parses ROADMAP.md fixture correctly', () => {
    const milestones = parseRoadmap(fixture(SYNTHETIC, 'ROADMAP.md'));
    expect(milestones).toHaveLength(4);

    expect(milestones[0]).toEqual({
      id: 'M0',
      name: 'Substrate bootstrap',
      phase: '0',     // phase is now a string label
      status: 'in-progress',
    });

    expect(milestones[1]).toEqual({
      id: 'M1',
      name: 'Core planner loop',
      phase: '1',
      status: 'planned',
    });
  });

  it('returns correct statuses', () => {
    const milestones = parseRoadmap(fixture(SYNTHETIC, 'ROADMAP.md'));
    const statuses = milestones.map(m => m.status);
    expect(statuses).toContain('in-progress');
    expect(statuses).toContain('planned');
  });

  it('throws on missing Milestones section', () => {
    expect(() => parseRoadmap('# No section here')).toThrow('Section "## Milestones" not found');
  });

  it('coerces unknown status to "planned" (lenient)', () => {
    const md = `# R\n## Milestones\n| ID | Name | Phase | Status |\n|---|---|---|---|\n| M0 | Test | crawl | unknown-status |\n`;
    const result = parseRoadmap(md);
    expect(result[0].status).toBe('planned');
  });

  it('keeps phase as a string', () => {
    const md = `# R\n## Milestones\n| ID | Name | Phase | Status |\n|---|---|---|---|\n| M0 | Test | walk | planned |\n`;
    const result = parseRoadmap(md);
    expect(result[0].phase).toBe('walk');
    expect(typeof result[0].phase).toBe('string');
  });
});

// ─── parseRoadmap — real fixtures ────────────────────────────────────────────

describe('parseRoadmap (real ROADMAP.md)', () => {
  it('parses without throwing', () => {
    expect(() => parseRoadmap(fixture(REAL, 'ROADMAP.md'))).not.toThrow();
  });

  it('includes M-1 (done) and M0 (planned)', () => {
    const milestones = parseRoadmap(fixture(REAL, 'ROADMAP.md'));
    const m1 = milestones.find(m => m.id === 'M-1');
    const m0 = milestones.find(m => m.id === 'M0');
    expect(m1).toBeDefined();
    expect(m1!.status).toBe('done');
    expect(m0).toBeDefined();
    expect(m0!.status).toBe('planned');
  });

  it('returns word-phase labels (crawl, walk, run)', () => {
    const milestones = parseRoadmap(fixture(REAL, 'ROADMAP.md'));
    const phases = milestones.map(m => m.phase);
    expect(phases.some(p => /crawl/i.test(p))).toBe(true);
    expect(phases.some(p => /walk/i.test(p))).toBe(true);
  });

  it('has at least 5 milestones', () => {
    const milestones = parseRoadmap(fixture(REAL, 'ROADMAP.md'));
    expect(milestones.length).toBeGreaterThanOrEqual(5);
  });
});

// ─── parseBacklog — synthetic fixtures ───────────────────────────────────────

describe('parseBacklog (synthetic fixtures)', () => {
  it('parses BACKLOG.md fixture correctly', () => {
    const items = parseBacklog(fixture(SYNTHETIC, 'BACKLOG.md'));
    expect(items.length).toBeGreaterThanOrEqual(4);

    const first = items[0];
    expect(first.id).toBe('M0-0');
    expect(first.ghNumber).toBe(1);
    expect(first.type).toBe('story');
    expect(first.status).toBe('done');
    expect(first.owner).toBe('bot');
  });

  it('finds a ready+unowned item', () => {
    const items = parseBacklog(fixture(SYNTHETIC, 'BACKLOG.md'));
    const ready = items.filter(i => i.status === 'ready' && i.owner === '');
    expect(ready.length).toBeGreaterThan(0);
    expect(ready[0].id).toBe('M0-1');
  });

  it('throws when no Items or Milestone section exists', () => {
    expect(() => parseBacklog('# No section here')).toThrow('Section "## Items" not found');
  });

  it('coerces invalid type to "task" (lenient)', () => {
    const bad = `# B\n## Items\n| ID | GH# | Title | Type | Status | Owner |\n|---|---|---|---|---|---|\n| X-1 | 1 | t | invalid | ready | |\n`;
    const items = parseBacklog(bad);
    expect(items[0].type).toBe('task');
  });

  it('defaults gh number to 0 for unparseable values', () => {
    const bad = `# B\n## Items\n| ID | GH# | Title | Type | Status | Owner |\n|---|---|---|---|---|---|\n| X-1 | abc | t | story | ready | |\n`;
    const items = parseBacklog(bad);
    expect(items[0].ghNumber).toBe(0);
  });
});

// ─── parseBacklog — real fixtures ────────────────────────────────────────────

describe('parseBacklog (real BACKLOG.md)', () => {
  it('parses without throwing', () => {
    expect(() => parseBacklog(fixture(REAL, 'BACKLOG.md'))).not.toThrow();
  });

  it('finds M0-2 and M0-3 as ready+unowned items', () => {
    const items = parseBacklog(fixture(REAL, 'BACKLOG.md'));
    const ready = items.filter(i => i.status === 'ready' && i.owner === '');
    const ids = ready.map(i => i.id);
    expect(ids).toContain('M0-2');
    expect(ids).toContain('M0-3');
  });

  it('parses emoji statuses correctly (in-progress, ready)', () => {
    const items = parseBacklog(fixture(REAL, 'BACKLOG.md'));
    const m0 = items.find(i => i.id === 'M0');
    expect(m0).toBeDefined();
    expect(m0!.status).toBe('in-progress');
    const m02 = items.find(i => i.id === 'M0-2');
    expect(m02!.status).toBe('ready');
  });

  it('parses #n gh-numbers correctly', () => {
    const items = parseBacklog(fixture(REAL, 'BACKLOG.md'));
    const m01 = items.find(i => i.id === 'M0-1');
    expect(m01).toBeDefined();
    expect(m01!.ghNumber).toBe(2);
  });

  it('maps em-dash owner to empty string', () => {
    const items = parseBacklog(fixture(REAL, 'BACKLOG.md'));
    const m02 = items.find(i => i.id === 'M0-2');
    expect(m02!.owner).toBe('');
  });
});

// ─── parseProject — synthetic fixtures ───────────────────────────────────────

describe('parseProject (synthetic fixtures)', () => {
  it('parses PROJECT.md fixture correctly', () => {
    const project = parseProject(fixture(SYNTHETIC, 'PROJECT.md'));
    expect(project.phase).toBe('0');    // phase is now a string
    expect(typeof project.phase).toBe('string');
  });

  it('focus is a string (may be empty)', () => {
    const project = parseProject(fixture(SYNTHETIC, 'PROJECT.md'));
    expect(typeof project.focus).toBe('string');
  });

  it('throws on missing Phase section', () => {
    expect(() => parseProject('## Focus\nsome focus')).toThrow('Section "## Current phase" not found');
  });

  it('focus is empty string when Focus section is absent', () => {
    const project = parseProject('## Phase\n0');
    expect(project.focus).toBe('');
  });
});

// ─── parseProject — real fixtures ────────────────────────────────────────────

describe('parseProject (real PROJECT.md)', () => {
  it('parses without throwing', () => {
    expect(() => parseProject(fixture(REAL, 'PROJECT.md'))).not.toThrow();
  });

  it('returns a non-empty phase string', () => {
    const project = parseProject(fixture(REAL, 'PROJECT.md'));
    expect(project.phase.length).toBeGreaterThan(0);
  });

  it('focus is a string', () => {
    const project = parseProject(fixture(REAL, 'PROJECT.md'));
    expect(typeof project.focus).toBe('string');
  });
});
