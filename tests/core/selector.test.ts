import { describe, it, expect } from 'vitest';
import { selectNextUnit } from '../../src/core/selector.js';
import type { BacklogItem } from '../../src/state/parsers.js';

function item(overrides: Partial<BacklogItem>): BacklogItem {
  return {
    id: 'X-0',
    ghNumber: 1,
    title: 'Test item',
    type: 'story',
    status: 'ready',
    owner: '',
    ...overrides,
  };
}

describe('selectNextUnit', () => {
  it('returns undefined for empty array', () => {
    expect(selectNextUnit([])).toBeUndefined();
  });

  it('returns undefined when no ready items', () => {
    const items = [item({ status: 'planned' }), item({ id: 'X-1', status: 'done' })];
    expect(selectNextUnit(items)).toBeUndefined();
  });

  it('returns undefined when all ready items are owned', () => {
    const items = [item({ owner: 'bot' }), item({ id: 'X-1', owner: 'human' })];
    expect(selectNextUnit(items)).toBeUndefined();
  });

  it('returns the single ready+unowned item', () => {
    const items = [item({ id: 'M0-1' })];
    expect(selectNextUnit(items)).toEqual(items[0]);
  });

  it('ignores planned, done, in-progress, blocked items', () => {
    const items = [
      item({ id: 'A', status: 'planned' }),
      item({ id: 'B', status: 'done' }),
      item({ id: 'C', status: 'in-progress' }),
      item({ id: 'D', status: 'blocked' }),
      item({ id: 'E', status: 'ready' }),
    ];
    const result = selectNextUnit(items);
    expect(result?.id).toBe('E');
  });

  it('ignores owned items even if ready', () => {
    const items = [
      item({ id: 'A', owner: 'bot' }),
      item({ id: 'B', owner: '' }),
    ];
    expect(selectNextUnit(items)?.id).toBe('B');
  });

  it('breaks ties by natural (numeric-aware) id order', () => {
    const items = [
      item({ id: 'M1-1' }),
      item({ id: 'M0-2' }),
      item({ id: 'M0-1' }),
    ];
    expect(selectNextUnit(items)?.id).toBe('M0-1');
  });

  it('sorts M0-2 before M0-10 (natural sort, not lexicographic)', () => {
    // Lexicographic: "M0-10" < "M0-2" because "1" < "2"
    // Natural sort:  "M0-2"  < "M0-10" because 2 < 10
    const items = [
      item({ id: 'M0-10' }),
      item({ id: 'M0-3' }),
      item({ id: 'M0-2' }),
    ];
    expect(selectNextUnit(items)?.id).toBe('M0-2');
  });

  it('natural sort handles multi-digit milestone prefixes', () => {
    const items = [
      item({ id: 'M10-1' }),
      item({ id: 'M2-1' }),
      item({ id: 'M1-1' }),
    ];
    expect(selectNextUnit(items)?.id).toBe('M1-1');
  });

  it('returns lexicographically first id among ties (alphabetic prefix)', () => {
    const items = [
      item({ id: 'Z-9' }),
      item({ id: 'A-1' }),
      item({ id: 'A-0' }),
    ];
    expect(selectNextUnit(items)?.id).toBe('A-0');
  });

  it('does not mutate the input array', () => {
    const items = [
      item({ id: 'B' }),
      item({ id: 'A' }),
    ];
    const copy = [...items];
    selectNextUnit(items);
    expect(items[0].id).toBe(copy[0].id);
    expect(items[1].id).toBe(copy[1].id);
  });
});
