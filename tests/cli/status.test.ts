/**
 * tests/cli/status.test.ts
 *
 * Tests for M4-4: `getLoopStatus`.
 *
 * All tests are hermetic — no real filesystem reads.
 * Both run-log and PROJECT.md reads use an injectable `readFile` seam.
 */

import { describe, it, expect, vi } from 'vitest';
import { getLoopStatus } from '../../src/cli/status.js';
import type { RunLogEntry } from '../../src/telemetry/run-log.js';

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

function toJsonl(entries: RunLogEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Frozen "now" for today 2026-07-23T15:00:00Z */
const TODAY_NOW = () => Date.UTC(2026, 6, 23, 15, 0, 0);

/** A readFile mock that returns empty string for both files by default. */
function makeReadFile(overrides: Record<string, string> = {}) {
  return vi.fn().mockImplementation(async (path: string) => {
    if (path in overrides) return overrides[path];
    return '';
  });
}

// ── getLoopStatus — run log absent / empty ────────────────────────────────────

describe('getLoopStatus — run log absent or empty', () => {
  it('returns null lastRunTime when log file does not exist', async () => {
    const readFile = vi.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.lastRunTime).toBeNull();
    expect(status.lastStopReason).toBeNull();
    expect(status.unitsToday).toBe(0);
    expect(status.monitorErrors).toEqual([]);
    expect(status.killSwitchActive).toBe(false);
  });

  it('returns null lastRunTime when log file is empty', async () => {
    const readFile = makeReadFile({ 'logs/run-log.jsonl': '' });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.lastRunTime).toBeNull();
    expect(status.lastStopReason).toBeNull();
    expect(status.unitsToday).toBe(0);
    expect(status.monitorErrors).toEqual([]);
  });
});

// ── getLoopStatus — lastRunTime / lastStopReason ──────────────────────────────

describe('getLoopStatus — lastRunTime and lastStopReason', () => {
  it('returns timestamp and stop reason from the last log entry', async () => {
    const entries = [
      makeEntry({ timestamp: '2026-07-23T10:00:00.000Z', stoppedReason: 'cap' }),
      makeEntry({ timestamp: '2026-07-23T11:30:00.000Z', stoppedReason: 'empty' }),
    ];
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl(entries) });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.lastRunTime).toBe('2026-07-23T11:30:00.000Z');
    expect(status.lastStopReason).toBe('empty');
  });

  it('returns the single entry when log has one record', async () => {
    const entry = makeEntry({ timestamp: '2026-07-23T08:00:00.000Z', stoppedReason: 'budget' });
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl([entry]) });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.lastRunTime).toBe('2026-07-23T08:00:00.000Z');
    expect(status.lastStopReason).toBe('budget');
  });

  it('handles killed stop reason', async () => {
    const entry = makeEntry({ stoppedReason: 'killed' });
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl([entry]) });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.lastStopReason).toBe('killed');
  });

  it('handles capped-daily stop reason', async () => {
    const entry = makeEntry({ stoppedReason: 'capped-daily' });
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl([entry]) });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.lastStopReason).toBe('capped-daily');
  });
});

// ── getLoopStatus — unitsToday ─────────────────────────────────────────────────

describe('getLoopStatus — unitsToday', () => {
  it('sums unitsProcessed for today only', async () => {
    const entries = [
      makeEntry({ timestamp: '2026-07-22T23:59:00.000Z', unitsProcessed: 5 }), // yesterday
      makeEntry({ timestamp: '2026-07-23T08:00:00.000Z', unitsProcessed: 1 }), // today
      makeEntry({ timestamp: '2026-07-23T09:00:00.000Z', unitsProcessed: 2 }), // today
    ];
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl(entries) });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.unitsToday).toBe(3);
  });

  it('returns 0 when no entries match today', async () => {
    const entries = [
      makeEntry({ timestamp: '2026-07-22T12:00:00.000Z', unitsProcessed: 4 }), // yesterday
    ];
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl(entries) });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.unitsToday).toBe(0);
  });

  it('respects the injectable now() for "today" calculation', async () => {
    const entries = [
      makeEntry({ timestamp: '2026-07-24T10:00:00.000Z', unitsProcessed: 3 }), // tomorrow
    ];
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl(entries) });
    // now returns tomorrow
    const tomorrow = () => Date.UTC(2026, 6, 24, 12, 0, 0);
    const status = await getLoopStatus({ readFile, now: tomorrow });
    expect(status.unitsToday).toBe(3);
  });
});

// ── getLoopStatus — monitorErrors ─────────────────────────────────────────────

describe('getLoopStatus — monitorErrors', () => {
  it('returns monitorErrors from the last log entry', async () => {
    const entries = [
      makeEntry({ monitorErrors: ['timeout'] }),
      makeEntry({ monitorErrors: ['ci poll failed', 'rate limited'] }),
    ];
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl(entries) });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.monitorErrors).toEqual(['ci poll failed', 'rate limited']);
  });

  it('returns empty array when last entry has no monitor errors', async () => {
    const entry = makeEntry({ monitorErrors: [] });
    const readFile = makeReadFile({ 'logs/run-log.jsonl': toJsonl([entry]) });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.monitorErrors).toEqual([]);
  });

  it('returns empty array when log is empty', async () => {
    const readFile = makeReadFile({ 'logs/run-log.jsonl': '' });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.monitorErrors).toEqual([]);
  });
});

// ── getLoopStatus — killSwitchActive ─────────────────────────────────────────

describe('getLoopStatus — killSwitchActive', () => {
  it('returns false when PROJECT.md does not contain LOOP PAUSED', async () => {
    const readFile = makeReadFile({
      'logs/run-log.jsonl': '',
      'state/PROJECT.md': '# PROJECT\n## Current phase\nActive.',
    });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.killSwitchActive).toBe(false);
  });

  it('returns true when PROJECT.md contains LOOP PAUSED', async () => {
    const readFile = makeReadFile({
      'logs/run-log.jsonl': '',
      'state/PROJECT.md': '# PROJECT\nLOOP PAUSED\n## Current phase\nActive.',
    });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.killSwitchActive).toBe(true);
  });

  it('detects LOOP PAUSED on any line (not just first)', async () => {
    const readFile = makeReadFile({
      'logs/run-log.jsonl': '',
      'state/PROJECT.md': '## header\nsome content\nLOOP PAUSED\nmore content',
    });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.killSwitchActive).toBe(true);
  });

  it('returns false when PROJECT.md is missing (fail-open)', async () => {
    const readFile = vi.fn().mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.killSwitchActive).toBe(false);
  });

  it('is case-sensitive — does not match loop paused (lowercase)', async () => {
    const readFile = makeReadFile({
      'logs/run-log.jsonl': '',
      'state/PROJECT.md': 'loop paused\nLoop Paused',
    });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.killSwitchActive).toBe(false);
  });
});

// ── getLoopStatus — custom paths ──────────────────────────────────────────────

describe('getLoopStatus — custom paths', () => {
  it('reads from custom logFile path', async () => {
    const readFile = vi.fn().mockResolvedValue('');
    await getLoopStatus({
      logFile: 'custom/logs/run.jsonl',
      readFile,
      now: TODAY_NOW,
    });
    expect(readFile).toHaveBeenCalledWith('custom/logs/run.jsonl', 'utf-8');
  });

  it('reads from custom projectFile path', async () => {
    const readFile = vi.fn().mockResolvedValue('');
    await getLoopStatus({
      projectFile: 'custom/PROJECT.md',
      readFile,
      now: TODAY_NOW,
    });
    expect(readFile).toHaveBeenCalledWith('custom/PROJECT.md', 'utf-8');
  });

  it('reads both files using the same readFile seam', async () => {
    const readFile = vi.fn().mockResolvedValue('');
    await getLoopStatus({ readFile, now: TODAY_NOW });
    // Should have been called for log file and project file
    expect(readFile).toHaveBeenCalledTimes(2);
  });
});

// ── getLoopStatus — defaults ──────────────────────────────────────────────────

describe('getLoopStatus — default paths', () => {
  it('uses logs/run-log.jsonl and state/PROJECT.md by default', async () => {
    const readFile = vi.fn().mockResolvedValue('');
    await getLoopStatus({ readFile, now: TODAY_NOW });
    const calls = readFile.mock.calls.map(([p]: [string]) => p);
    expect(calls).toContain('logs/run-log.jsonl');
    expect(calls).toContain('state/PROJECT.md');
  });
});

// ── getLoopStatus — malformed JSONL ───────────────────────────────────────────

describe('getLoopStatus — malformed JSONL', () => {
  it('skips malformed lines and still returns valid data', async () => {
    const goodEntry = makeEntry({ timestamp: '2026-07-23T12:00:00.000Z', unitsProcessed: 2 });
    const raw = `not-valid-json\n${JSON.stringify(goodEntry)}\n`;
    const readFile = makeReadFile({ 'logs/run-log.jsonl': raw });
    const status = await getLoopStatus({ readFile, now: TODAY_NOW });
    expect(status.lastRunTime).toBe('2026-07-23T12:00:00.000Z');
    expect(status.unitsToday).toBe(2);
  });
});
