/**
 * tests/telemetry/run-log.test.ts
 *
 * Tests for M4-0 (scaffold) + M4-1 (appendRunLog / readRunLog implementation).
 *
 * M4-0 tests verify shared types + the RunLogEntry shape contract.
 * M4-1 tests verify appendRunLog behaviour via injectable FS seams, and
 * readRunLog JSONL parsing behaviour (valid lines, blanks, malformed lines).
 *
 * All tests are hermetic — no real filesystem writes.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  appendRunLog,
  readRunLog,
  type RunLogEntry,
  type RunLog,
} from '../../src/telemetry/run-log.js';

// ── Type-level smoke tests ────────────────────────────────────────────────────

describe('RunLogEntry type', () => {
  it('accepts a valid run-log entry', () => {
    const entry: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      unitsProcessed: 1,
      stoppedReason: 'empty',
      durationMs: 45_000,
      monitorErrors: [],
    };
    expect(entry.repo).toBe('suskumar-MSFT/autonomous-delivery-engine');
    expect(entry.unitsProcessed).toBe(1);
    expect(entry.stoppedReason).toBe('empty');
    expect(entry.durationMs).toBe(45_000);
    expect(entry.monitorErrors).toHaveLength(0);
  });

  it('accepts all known StopReason strings including M4 additions', () => {
    const reasons: string[] = ['empty', 'cap', 'budget', 'error', 'killed', 'capped-daily'];
    for (const stoppedReason of reasons) {
      const entry: RunLogEntry = {
        timestamp: '2026-07-23T15:00:00.000Z',
        repo: 'owner/repo',
        unitsProcessed: 0,
        stoppedReason,
        durationMs: 0,
        monitorErrors: [],
      };
      expect(entry.stoppedReason).toBe(stoppedReason);
    }
  });

  it('accepts monitorErrors with content', () => {
    const entry: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 0,
      stoppedReason: 'error',
      durationMs: 1_000,
      monitorErrors: ['fetchFailedRuns: timeout', 'fileMonitorIssue: auth error'],
    };
    expect(entry.monitorErrors).toHaveLength(2);
  });
});

describe('RunLog type', () => {
  it('is an array of RunLogEntry', () => {
    const log: RunLog = [
      {
        timestamp: '2026-07-23T14:00:00.000Z',
        repo: 'owner/repo',
        unitsProcessed: 2,
        stoppedReason: 'cap',
        durationMs: 120_000,
        monitorErrors: [],
      },
      {
        timestamp: '2026-07-23T15:00:00.000Z',
        repo: 'owner/repo',
        unitsProcessed: 0,
        stoppedReason: 'empty',
        durationMs: 500,
        monitorErrors: [],
      },
    ];
    expect(log).toHaveLength(2);
    expect(log[0]?.stoppedReason).toBe('cap');
    expect(log[1]?.stoppedReason).toBe('empty');
  });
});

// ── appendRunLog (M4-1 — full implementation) ─────────────────────────────────

describe('appendRunLog (M4-1 implementation)', () => {
  it('appends a JSONL line to the specified logFile', async () => {
    const written: Array<[string, string]> = [];
    const appendFileMock = vi.fn().mockImplementation((p: string, data: string) => {
      written.push([p, data]);
      return Promise.resolve();
    });
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);

    const entry: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 1,
      stoppedReason: 'empty',
      durationMs: 1_000,
      monitorErrors: [],
    };

    await appendRunLog(entry, {
      logFile: 'logs/run-log.jsonl',
      enabled: true,
      appendFile: appendFileMock,
      mkdirp: mkdirpMock,
    });

    expect(appendFileMock).toHaveBeenCalledTimes(1);
    const [path, data] = written[0]!;
    expect(path).toBe('logs/run-log.jsonl');
    expect(data).toBe(JSON.stringify(entry) + '\n');
  });

  it('creates the parent directory via mkdirp', async () => {
    const appendFileMock = vi.fn().mockResolvedValue(undefined);
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);

    const entry: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 0,
      stoppedReason: 'empty',
      durationMs: 0,
      monitorErrors: [],
    };

    await appendRunLog(entry, {
      logFile: 'custom/dir/run-log.jsonl',
      appendFile: appendFileMock,
      mkdirp: mkdirpMock,
    });

    expect(mkdirpMock).toHaveBeenCalledTimes(1);
    expect(mkdirpMock).toHaveBeenCalledWith('custom/dir');
    expect(appendFileMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when enabled=false', async () => {
    const appendFileMock = vi.fn().mockResolvedValue(undefined);
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);

    const entry: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 0,
      stoppedReason: 'empty',
      durationMs: 0,
      monitorErrors: [],
    };

    await appendRunLog(entry, {
      enabled: false,
      appendFile: appendFileMock,
      mkdirp: mkdirpMock,
    });

    expect(appendFileMock).not.toHaveBeenCalled();
    expect(mkdirpMock).not.toHaveBeenCalled();
  });

  it('defaults to logs/run-log.jsonl when logFile is omitted', async () => {
    const appendFileMock = vi.fn().mockResolvedValue(undefined);
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);

    const entry: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 0,
      stoppedReason: 'empty',
      durationMs: 0,
      monitorErrors: [],
    };

    await appendRunLog(entry, {
      appendFile: appendFileMock,
      mkdirp: mkdirpMock,
    });

    expect(appendFileMock).toHaveBeenCalledTimes(1);
    const [path] = (appendFileMock.mock.calls[0] as [string, string]);
    expect(path).toBe('logs/run-log.jsonl');
    expect(mkdirpMock).toHaveBeenCalledWith('logs');
  });

  it('appends multiple entries as separate JSONL lines', async () => {
    const lines: string[] = [];
    const appendFileMock = vi.fn().mockImplementation((_p: string, data: string) => {
      lines.push(data);
      return Promise.resolve();
    });
    const mkdirpMock = vi.fn().mockResolvedValue(undefined);

    const entry1: RunLogEntry = {
      timestamp: '2026-07-23T14:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 2,
      stoppedReason: 'cap',
      durationMs: 120_000,
      monitorErrors: [],
    };
    const entry2: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 0,
      stoppedReason: 'empty',
      durationMs: 500,
      monitorErrors: [],
    };

    const sharedOpts = { appendFile: appendFileMock, mkdirp: mkdirpMock };
    await appendRunLog(entry1, sharedOpts);
    await appendRunLog(entry2, sharedOpts);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(JSON.stringify(entry1) + '\n');
    expect(lines[1]).toBe(JSON.stringify(entry2) + '\n');
  });

  it('round-trips through readRunLog', async () => {
    const chunks: string[] = [];
    const appendFileMock = vi.fn().mockImplementation((_p: string, data: string) => {
      chunks.push(data);
      return Promise.resolve();
    });

    const entry: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 1,
      stoppedReason: 'empty',
      durationMs: 1_000,
      monitorErrors: ['some error'],
    };

    await appendRunLog(entry, {
      appendFile: appendFileMock,
      mkdirp: vi.fn().mockResolvedValue(undefined),
    });

    const raw = chunks.join('');
    const parsed = readRunLog(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(entry);
  });
});

// ── readRunLog ────────────────────────────────────────────────────────────────

describe('readRunLog', () => {
  it('returns an empty array for an empty string', () => {
    expect(readRunLog('')).toEqual([]);
  });

  it('returns an empty array for whitespace-only content', () => {
    expect(readRunLog('   \n\n   \n')).toEqual([]);
  });

  it('parses a single JSONL line', () => {
    const entry: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 1,
      stoppedReason: 'empty',
      durationMs: 1_000,
      monitorErrors: [],
    };
    const raw = JSON.stringify(entry) + '\n';
    const result = readRunLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(entry);
  });

  it('parses multiple JSONL lines in order', () => {
    const e1: RunLogEntry = {
      timestamp: '2026-07-23T14:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 2,
      stoppedReason: 'cap',
      durationMs: 120_000,
      monitorErrors: [],
    };
    const e2: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 0,
      stoppedReason: 'empty',
      durationMs: 500,
      monitorErrors: [],
    };
    const raw = JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n';
    const result = readRunLog(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(e1);
    expect(result[1]).toEqual(e2);
  });

  it('skips blank lines between entries', () => {
    const e1: RunLogEntry = {
      timestamp: '2026-07-23T14:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 1,
      stoppedReason: 'empty',
      durationMs: 0,
      monitorErrors: [],
    };
    const raw = '\n' + JSON.stringify(e1) + '\n\n';
    const result = readRunLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(e1);
  });

  it('skips malformed (non-JSON) lines without throwing', () => {
    const valid: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 1,
      stoppedReason: 'empty',
      durationMs: 0,
      monitorErrors: [],
    };
    const raw =
      'not-json\n' +
      JSON.stringify(valid) + '\n' +
      '{"broken": true\n' +
      JSON.stringify(valid) + '\n';
    const result = readRunLog(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(valid);
    expect(result[1]).toEqual(valid);
  });

  it('skips JSON primitives and arrays (only objects are entries)', () => {
    const valid: RunLogEntry = {
      timestamp: '2026-07-23T15:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 0,
      stoppedReason: 'empty',
      durationMs: 0,
      monitorErrors: [],
    };
    const raw =
      '"a string"\n' +
      '42\n' +
      '[1,2,3]\n' +
      JSON.stringify(valid) + '\n';
    const result = readRunLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(valid);
  });

  it('handles a truncated final line gracefully', () => {
    const valid: RunLogEntry = {
      timestamp: '2026-07-23T14:00:00.000Z',
      repo: 'owner/repo',
      unitsProcessed: 1,
      stoppedReason: 'empty',
      durationMs: 0,
      monitorErrors: [],
    };
    // Second line is truncated (simulates a partially-written append)
    const raw = JSON.stringify(valid) + '\n' + '{"timestamp":"2026-07-23T15';
    const result = readRunLog(raw);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(valid);
  });
});
