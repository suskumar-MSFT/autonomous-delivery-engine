/**
 * tests/telemetry/daily-cap.test.ts
 *
 * Tests for M4-3: `countUnitsToday`, `utcDateString`, and `readDailyCount`.
 *
 * All tests are hermetic — no real filesystem reads.
 * `readDailyCount` is exercised via an injectable `readFile` seam.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  countUnitsToday,
  utcDateString,
  readDailyCount,
} from '../../src/telemetry/daily-cap.js';
import type { RunLog, RunLogEntry } from '../../src/telemetry/run-log.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<RunLogEntry> = {}): RunLogEntry {
  return {
    timestamp: '2026-07-23T15:00:00.000Z',
    repo: 'owner/repo',
    unitsProcessed: 1,
    stoppedReason: 'empty',
    durationMs: 5_000,
    monitorErrors: [],
    ...overrides,
  };
}

/** Builds a JSONL string from an array of RunLogEntry objects. */
function toJsonl(entries: RunLogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

// ── countUnitsToday ───────────────────────────────────────────────────────────

describe('countUnitsToday', () => {
  it('returns 0 for an empty log', () => {
    expect(countUnitsToday([], '2026-07-23')).toBe(0);
  });

  it('counts entries matching the given date prefix', () => {
    const log: RunLog = [
      makeEntry({ timestamp: '2026-07-23T08:00:00.000Z', unitsProcessed: 1 }),
      makeEntry({ timestamp: '2026-07-23T09:30:00.000Z', unitsProcessed: 2 }),
    ];
    expect(countUnitsToday(log, '2026-07-23')).toBe(3);
  });

  it('ignores entries from a different date', () => {
    const log: RunLog = [
      makeEntry({ timestamp: '2026-07-22T23:59:59.999Z', unitsProcessed: 5 }), // yesterday UTC
      makeEntry({ timestamp: '2026-07-23T00:00:00.000Z', unitsProcessed: 1 }), // today UTC
    ];
    expect(countUnitsToday(log, '2026-07-23')).toBe(1);
  });

  it('returns 0 when no entries match the given date', () => {
    const log: RunLog = [
      makeEntry({ timestamp: '2026-07-22T10:00:00.000Z', unitsProcessed: 3 }),
    ];
    expect(countUnitsToday(log, '2026-07-23')).toBe(0);
  });

  it('sums unitsProcessed=0 entries without inflating the count', () => {
    const log: RunLog = [
      makeEntry({ timestamp: '2026-07-23T10:00:00.000Z', unitsProcessed: 0 }),
      makeEntry({ timestamp: '2026-07-23T11:00:00.000Z', unitsProcessed: 2 }),
    ];
    expect(countUnitsToday(log, '2026-07-23')).toBe(2);
  });

  it('handles entries with various stop reasons', () => {
    const log: RunLog = [
      makeEntry({ timestamp: '2026-07-23T10:00:00.000Z', unitsProcessed: 1, stoppedReason: 'cap' }),
      makeEntry({ timestamp: '2026-07-23T10:30:00.000Z', unitsProcessed: 0, stoppedReason: 'empty' }),
      makeEntry({ timestamp: '2026-07-23T11:00:00.000Z', unitsProcessed: 1, stoppedReason: 'killed' }),
    ];
    expect(countUnitsToday(log, '2026-07-23')).toBe(2);
  });

  it('matches the UTC date prefix exactly — does not prefix-match other fields', () => {
    // The date '2026-07' should NOT be a valid match for YYYY-MM-DD comparison
    // (we always pass full YYYY-MM-DD, so this is a correctness boundary test).
    const log: RunLog = [
      makeEntry({ timestamp: '2026-07-23T00:00:00.000Z', unitsProcessed: 2 }),
    ];
    // Passing a month-only prefix — should still work (timestamp starts with it),
    // but callers always pass YYYY-MM-DD per the contract.
    // This test documents the prefix-matching behaviour.
    expect(countUnitsToday(log, '2026-07')).toBe(2); // prefix match is by design
    expect(countUnitsToday(log, '2026-07-23')).toBe(2);
    expect(countUnitsToday(log, '2026-07-24')).toBe(0);
  });

  it('handles a large log spanning many days', () => {
    const log: RunLog = Array.from({ length: 30 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0');
      return makeEntry({
        timestamp: `2026-07-${day}T12:00:00.000Z`,
        unitsProcessed: i + 1,
      });
    });
    // Day 23 is index 22, unitsProcessed = 23.
    expect(countUnitsToday(log, '2026-07-23')).toBe(23);
    expect(countUnitsToday(log, '2026-07-01')).toBe(1);
    expect(countUnitsToday(log, '2026-07-30')).toBe(30);
  });
});

// ── utcDateString ─────────────────────────────────────────────────────────────

describe('utcDateString', () => {
  it('converts epoch ms to YYYY-MM-DD (UTC)', () => {
    // 2026-07-23T00:00:00.000Z
    const ms = Date.UTC(2026, 6, 23); // month is 0-indexed
    expect(utcDateString(ms)).toBe('2026-07-23');
  });

  it('handles midnight UTC correctly', () => {
    const ms = Date.UTC(2026, 6, 23, 0, 0, 0, 0);
    expect(utcDateString(ms)).toBe('2026-07-23');
  });

  it('handles 23:59:59 UTC on the same day', () => {
    const ms = Date.UTC(2026, 6, 23, 23, 59, 59, 999);
    expect(utcDateString(ms)).toBe('2026-07-23');
  });

  it('correctly flips to the next UTC day at midnight', () => {
    const beforeMidnight = Date.UTC(2026, 6, 23, 23, 59, 59, 999);
    const atMidnight = Date.UTC(2026, 6, 24, 0, 0, 0, 0);
    expect(utcDateString(beforeMidnight)).toBe('2026-07-23');
    expect(utcDateString(atMidnight)).toBe('2026-07-24');
  });

  it('produces a 10-character YYYY-MM-DD string', () => {
    const result = utcDateString(Date.now());
    expect(result).toHaveLength(10);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── readDailyCount ────────────────────────────────────────────────────────────

describe('readDailyCount', () => {
  const TODAY_UTC = Date.UTC(2026, 6, 23, 15, 0, 0); // 2026-07-23T15:00:00Z

  it('returns 0 when the log file does not exist (ENOENT)', async () => {
    const readFile = vi.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }),
    );
    const count = await readDailyCount('logs/run-log.jsonl', TODAY_UTC, readFile);
    expect(count).toBe(0);
  });

  it('returns 0 when the log file is empty', async () => {
    const readFile = vi.fn().mockResolvedValue('');
    const count = await readDailyCount('logs/run-log.jsonl', TODAY_UTC, readFile);
    expect(count).toBe(0);
  });

  it('returns the correct count for a single matching entry', async () => {
    const entry = makeEntry({
      timestamp: '2026-07-23T10:00:00.000Z',
      unitsProcessed: 2,
    });
    const readFile = vi.fn().mockResolvedValue(toJsonl([entry]));
    const count = await readDailyCount('logs/run-log.jsonl', TODAY_UTC, readFile);
    expect(count).toBe(2);
  });

  it('sums multiple entries for today', async () => {
    const entries = [
      makeEntry({ timestamp: '2026-07-23T08:00:00.000Z', unitsProcessed: 1 }),
      makeEntry({ timestamp: '2026-07-23T09:30:00.000Z', unitsProcessed: 2 }),
    ];
    const readFile = vi.fn().mockResolvedValue(toJsonl(entries));
    const count = await readDailyCount('logs/run-log.jsonl', TODAY_UTC, readFile);
    expect(count).toBe(3);
  });

  it('excludes entries from other dates', async () => {
    const entries = [
      makeEntry({ timestamp: '2026-07-22T23:59:00.000Z', unitsProcessed: 5 }), // yesterday
      makeEntry({ timestamp: '2026-07-23T00:00:00.000Z', unitsProcessed: 1 }), // today
    ];
    const readFile = vi.fn().mockResolvedValue(toJsonl(entries));
    const count = await readDailyCount('logs/run-log.jsonl', TODAY_UTC, readFile);
    expect(count).toBe(1);
  });

  it('returns 0 on a read error other than ENOENT (fail-open)', async () => {
    const readFile = vi.fn().mockRejectedValue(new Error('EACCES: permission denied'));
    const count = await readDailyCount('logs/run-log.jsonl', TODAY_UTC, readFile);
    expect(count).toBe(0);
  });

  it('reads from the path passed to it', async () => {
    const readFile = vi.fn().mockResolvedValue('');
    await readDailyCount('custom/path/run-log.jsonl', TODAY_UTC, readFile);
    expect(readFile).toHaveBeenCalledWith('custom/path/run-log.jsonl', 'utf-8');
  });

  it('returns 0 when nowMs is for a different day than log entries', async () => {
    const entries = [
      makeEntry({ timestamp: '2026-07-23T10:00:00.000Z', unitsProcessed: 3 }),
    ];
    const readFile = vi.fn().mockResolvedValue(toJsonl(entries));
    // nowMs is 2026-07-24
    const tomorrowMs = Date.UTC(2026, 6, 24, 10, 0, 0);
    const count = await readDailyCount('logs/run-log.jsonl', tomorrowMs, readFile);
    expect(count).toBe(0);
  });

  it('skips malformed JSONL lines gracefully', async () => {
    const goodEntry = makeEntry({
      timestamp: '2026-07-23T10:00:00.000Z',
      unitsProcessed: 1,
    });
    const raw = `${JSON.stringify(goodEntry)}\nnot-valid-json\n`;
    const readFile = vi.fn().mockResolvedValue(raw);
    const count = await readDailyCount('logs/run-log.jsonl', TODAY_UTC, readFile);
    expect(count).toBe(1);
  });
});
