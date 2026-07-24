/**
 * tests/core/kill-switch.test.ts
 *
 * Tests for M4-2: `checkKillSwitch` — injectable kill-switch probe.
 *
 * All tests are hermetic — no live filesystem reads.
 *
 * Contracts verified:
 *  - Returns true  when PROJECT.md contains `LOOP PAUSED` anywhere on a line.
 *  - Returns false when PROJECT.md does NOT contain the sentinel.
 *  - Returns false (fail-open) when the file cannot be read.
 *  - Case-sensitive: `loop paused` / `LOOP paused` do NOT trigger.
 *  - Matches inline (sentinel need not occupy the whole line).
 *  - Injected readFile seam is called exactly once with the given path.
 */

import { describe, it, expect, vi } from 'vitest';
import { checkKillSwitch } from '../../src/core/kill-switch.js';
import type { ReadFileFn } from '../../src/core/kill-switch.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a readFile mock that resolves with the given content. */
function makeReader(content: string): ReadFileFn {
  return vi.fn().mockResolvedValue(content);
}

/** Returns a readFile mock that rejects with the given error. */
function makeErrorReader(err: Error): ReadFileFn {
  return vi.fn().mockRejectedValue(err);
}

const PROJECT_PATH = '/state/PROJECT.md';

// ── Sentinel detection ────────────────────────────────────────────────────────

describe('checkKillSwitch — sentinel detection', () => {
  it('returns true when file contains LOOP PAUSED on its own line', async () => {
    const reader = makeReader('# PROJECT\n\nLOOP PAUSED\n\n## Current phase\n...');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(true);
  });

  it('returns true when LOOP PAUSED is inline (not the whole line)', async () => {
    const reader = makeReader('## Status\nKill-switch active: LOOP PAUSED — do not advance\n');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(true);
  });

  it('returns true when LOOP PAUSED appears at the very start of the file', async () => {
    const reader = makeReader('LOOP PAUSED');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(true);
  });

  it('returns true when LOOP PAUSED appears multiple times', async () => {
    const reader = makeReader('LOOP PAUSED\n\nSome text\n\nLOOP PAUSED');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(true);
  });

  it('returns false when file does not contain the sentinel', async () => {
    const reader = makeReader('# PROJECT\n\n## Current phase\nActive\n\n## Next action\nM4-2');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(false);
  });

  it('returns false for an empty file', async () => {
    const reader = makeReader('');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(false);
  });
});

// ── Case-sensitivity ──────────────────────────────────────────────────────────

describe('checkKillSwitch — case-sensitivity', () => {
  it('returns false for lowercase loop paused', async () => {
    const reader = makeReader('loop paused\n');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(false);
  });

  it('returns false for mixed-case Loop Paused', async () => {
    const reader = makeReader('Loop Paused\n');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(false);
  });

  it('returns false for LOOP paused (wrong case on second word)', async () => {
    const reader = makeReader('LOOP paused\n');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(false);
  });

  it('returns true for exact LOOP PAUSED with surrounding text', async () => {
    const reader = makeReader('<!-- LOOP PAUSED -->\n');
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(true);
  });
});

// ── Fail-open on I/O error ────────────────────────────────────────────────────

describe('checkKillSwitch — fail-open on I/O error', () => {
  it('returns false when readFile throws ENOENT', async () => {
    const reader = makeErrorReader(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await checkKillSwitch('/missing/PROJECT.md', reader)).toBe(false);
  });

  it('returns false when readFile throws EACCES', async () => {
    const reader = makeErrorReader(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    expect(await checkKillSwitch('/restricted/PROJECT.md', reader)).toBe(false);
  });

  it('returns false for any unexpected readFile error', async () => {
    const reader = makeErrorReader(new Error('unexpected disk failure'));
    expect(await checkKillSwitch(PROJECT_PATH, reader)).toBe(false);
  });
});

// ── Injectable seam usage ─────────────────────────────────────────────────────

describe('checkKillSwitch — seam usage', () => {
  it('calls readFile exactly once with the given path and utf8 encoding', async () => {
    const reader = makeReader('no sentinel here');
    await checkKillSwitch(PROJECT_PATH, reader);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith(PROJECT_PATH, 'utf8');
  });

  it('calls readFile once even when sentinel is found on line 1', async () => {
    const reader = makeReader('LOOP PAUSED\nmore content\n');
    await checkKillSwitch(PROJECT_PATH, reader);
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it('uses the exact path passed — not a hardcoded fallback', async () => {
    const customPath = '/custom/workspace/state/PROJECT.md';
    const reader = makeReader('# no sentinel');
    await checkKillSwitch(customPath, reader);
    expect(reader).toHaveBeenCalledWith(customPath, 'utf8');
  });
});
