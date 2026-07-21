import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoadmap, parseBacklog, parseProject } from '../../src/state/parsers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'fixtures', 'state');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

// ─── parseRoadmap ────────────────────────────────────────────────────────────

describe('parseRoadmap', () => {
  it('parses ROADMAP.md fixture correctly', () => {
    const milestones = parseRoadmap(fixture('ROADMAP.md'));
    expect(milestones).toHaveLength(4);

    expect(milestones[0]).toEqual({
      id: 'M0',
      name: 'Substrate bootstrap',
      phase: 0,
      status: 'in-progress',
    });

    expect(milestones[1]).toEqual({
      id: 'M1',
      name: 'Core planner loop',
      phase: 1,
      status: 'planned',
    });
  });

  it('returns correct statuses', () => {
    const milestones = parseRoadmap(fixture('ROADMAP.md'));
    const statuses = milestones.map(m => m.status);
    expect(statuses).toContain('in-progress');
    expect(statuses).toContain('planned');
  });

  it('throws on missing Milestones section', () => {
    expect(() => parseRoadmap('# No section here')).toThrow('Section "## Milestones" not found');
  });

  it('throws on invalid status', () => {
    const bad = `# R\n## Milestones\n| ID | Name | Phase | Status |\n|---|---|---|---|\n| M0 | Test | 0 | unknown |\n`;
    expect(() => parseRoadmap(bad)).toThrow('invalid status');
  });

  it('throws on invalid phase', () => {
    const bad = `# R\n## Milestones\n| ID | Name | Phase | Status |\n|---|---|---|---|\n| M0 | Test | nan | planned |\n`;
    expect(() => parseRoadmap(bad)).toThrow('invalid phase');
  });
});

// ─── parseBacklog ────────────────────────────────────────────────────────────

describe('parseBacklog', () => {
  it('parses BACKLOG.md fixture correctly', () => {
    const items = parseBacklog(fixture('BACKLOG.md'));
    expect(items.length).toBeGreaterThanOrEqual(4);

    const first = items[0];
    expect(first.id).toBe('M0-0');
    expect(first.ghNumber).toBe(1);
    expect(first.type).toBe('story');
    expect(first.status).toBe('done');
    expect(first.owner).toBe('bot');
  });

  it('finds a ready+unowned item', () => {
    const items = parseBacklog(fixture('BACKLOG.md'));
    const ready = items.filter(i => i.status === 'ready' && i.owner === '');
    expect(ready.length).toBeGreaterThan(0);
    expect(ready[0].id).toBe('M0-1');
  });

  it('throws on missing Items section', () => {
    expect(() => parseBacklog('# No section here')).toThrow('Section "## Items" not found');
  });

  it('throws on invalid type', () => {
    const bad = `# B\n## Items\n| ID | GH# | Title | Type | Status | Owner |\n|---|---|---|---|---|---|\n| X-1 | 1 | t | invalid | ready | |\n`;
    expect(() => parseBacklog(bad)).toThrow('invalid type');
  });

  it('throws on invalid gh number', () => {
    const bad = `# B\n## Items\n| ID | GH# | Title | Type | Status | Owner |\n|---|---|---|---|---|---|\n| X-1 | abc | t | story | ready | |\n`;
    expect(() => parseBacklog(bad)).toThrow('invalid gh number');
  });
});

// ─── parseProject ─────────────────────────────────────────────────────────────

describe('parseProject', () => {
  it('parses PROJECT.md fixture correctly', () => {
    const project = parseProject(fixture('PROJECT.md'));
    expect(project.phase).toBe(0);
    expect(project.focus).toBeTruthy();
    expect(typeof project.focus).toBe('string');
  });

  it('throws on missing Phase section', () => {
    expect(() => parseProject('## Focus\nsome focus')).toThrow('Section "## Phase" not found');
  });

  it('throws on missing Focus section', () => {
    expect(() => parseProject('## Phase\n0')).toThrow('Section "## Focus" not found');
  });

  it('throws on invalid phase', () => {
    expect(() => parseProject('## Phase\nnot-a-number\n## Focus\nsome focus')).toThrow(
      'Invalid phase value',
    );
  });
});
