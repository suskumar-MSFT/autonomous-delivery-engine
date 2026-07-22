import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock child_process BEFORE importing the module under test ────────────────
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile } from 'node:child_process';
import { listIssues, listIssuesViaCli, listIssuesFallback, looksLikeAuthError } from '../../src/github/issues.js';

const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Fixture data ─────────────────────────────────────────────────────────────

const CLI_PAYLOAD = [
  { number: 1, title: 'First issue', labels: [{ name: 'bug' }], state: 'open' },
  { number: 2, title: 'Second issue', labels: [], state: 'open' },
];
const CLI_RESPONSE = JSON.stringify(CLI_PAYLOAD);

const API_PAYLOAD = [
  { number: 3, title: 'API issue', labels: [{ name: 'enhancement' }], state: 'open' },
];
const API_RESPONSE = JSON.stringify(API_PAYLOAD);

// ─── listIssuesViaCli ─────────────────────────────────────────────────────────

describe('listIssuesViaCli', () => {
  it('invokes gh via execFile with separate argv (no shell string)', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: CLI_RESPONSE, stderr: '' });

    const issues = await listIssuesViaCli('owner/repo', 'open');

    // Must call execFile, NOT exec — and the second arg must be an argv ARRAY
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['issue', 'list', '--repo', 'owner/repo', '--state', 'open', '--json', 'number,title,labels,state'],
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({ number: 1, title: 'First issue', labels: ['bug'], state: 'open' });
    expect(issues[1]).toEqual({ number: 2, title: 'Second issue', labels: [], state: 'open' });
  });

  it('returns parsed Issue[] from JSON output', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: CLI_RESPONSE, stderr: '' });
    const issues = await listIssuesViaCli('owner/repo', 'open');
    expect(issues).toHaveLength(2);
    expect(issues[0].number).toBe(1);
    expect(issues[0].labels).toEqual(['bug']);
  });

  it('throws on non-array JSON', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '{"error":"not array"}', stderr: '' });
    await expect(listIssuesViaCli('owner/repo', 'open')).rejects.toThrow('Expected array');
  });

  it('rejects an invalid repo argument before calling execFile', async () => {
    await expect(listIssuesViaCli('bad repo; rm -rf /', 'open'))
      .rejects.toThrow('Invalid repo');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ─── listIssuesFallback ───────────────────────────────────────────────────────

describe('listIssuesFallback', () => {
  it('invokes gh api via execFile with separate argv (no shell string)', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: API_RESPONSE, stderr: '' });

    const issues = await listIssuesFallback('owner/repo', 'open');

    // Must use -f flags so `&` in query values is NOT interpreted by a shell
    expect(mockExecFile).toHaveBeenCalledWith(
      'gh',
      ['api', 'repos/owner/repo/issues', '--method', 'GET', '-f', 'state=open', '-f', 'per_page=100'],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({ number: 3, title: 'API issue', labels: ['enhancement'], state: 'open' });
  });

  it('returns parsed Issue[] from fallback JSON output', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: API_RESPONSE, stderr: '' });
    const issues = await listIssuesFallback('owner/repo', 'open');
    expect(issues[0].number).toBe(3);
    expect(issues[0].labels).toEqual(['enhancement']);
  });

  it('rejects an invalid repo argument', async () => {
    await expect(listIssuesFallback('owner&evil', 'open'))
      .rejects.toThrow('Invalid repo');
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

// ─── listIssues (primary + fallback orchestration) ───────────────────────────

describe('listIssues', () => {
  it('returns CLI results when primary path succeeds', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: CLI_RESPONSE, stderr: '' });

    const issues = await listIssues('owner/repo');
    expect(issues).toHaveLength(2);
    expect(issues[0].number).toBe(1);
    expect(issues[1].number).toBe(2);
  });

  it('falls back to REST API when primary path throws, and returns parsed results', async () => {
    // First call (listIssuesViaCli) rejects; second call (listIssuesFallback) resolves
    mockExecFile
      .mockRejectedValueOnce(new Error('gh not found'))
      .mockResolvedValueOnce({ stdout: API_RESPONSE, stderr: '' });

    const issues = await listIssues('owner/repo');
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(3);
    expect(issues[0].title).toBe('API issue');
    expect(issues[0].labels).toEqual(['enhancement']);
  });

  it('uses "open" as default state', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '[]', stderr: '' });
    await listIssues('owner/repo');
    // The argv array must contain '--state' then 'open'
    const call = mockExecFile.mock.calls[0];
    const argv: string[] = call[1];
    const stateIdx = argv.indexOf('--state');
    expect(stateIdx).toBeGreaterThan(-1);
    expect(argv[stateIdx + 1]).toBe('open');
  });

  it('rejects an invalid repo before spawning any child process', async () => {
    await expect(listIssues('not-a-valid/repo!!')).rejects.toThrow('Invalid repo');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('throws a combined error when both CLI and fallback fail', async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error('CLI failed'))
      .mockRejectedValueOnce(new Error('API also failed'));

    await expect(listIssues('owner/repo')).rejects.toThrow(
      /gh issue list failed on both paths/,
    );
  });

  it('combined error message includes both CLI and API failure reasons', async () => {
    mockExecFile
      .mockRejectedValueOnce(new Error('exec: gh not found'))
      .mockRejectedValueOnce(new Error('network timeout'));

    let msg = '';
    try {
      await listIssues('owner/repo');
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('CLI: exec: gh not found');
    expect(msg).toContain('API: network timeout');
  });

  it('includes auth hint in combined error when primary error looks like an auth failure', async () => {
    const authErr = Object.assign(new Error('Request failed'), {
      stderr: 'not logged in. please run: gh auth login',
    });
    mockExecFile
      .mockRejectedValueOnce(authErr)
      .mockRejectedValueOnce(new Error('API also failed'));

    let msg = '';
    try {
      await listIssues('owner/repo');
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('authentication may be required');
    expect(msg).toContain('gh auth login');
  });

  it('includes auth hint when fallback error looks like an auth failure', async () => {
    const authErr = Object.assign(new Error('HTTP 401'), { stderr: '401 Unauthorized' });
    mockExecFile
      .mockRejectedValueOnce(new Error('CLI failed'))
      .mockRejectedValueOnce(authErr);

    let msg = '';
    try {
      await listIssues('owner/repo');
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('authentication may be required');
  });
});

// ─── looksLikeAuthError ───────────────────────────────────────────────────────

describe('looksLikeAuthError', () => {
  it('returns true for "not logged in" in the error message', () => {
    expect(looksLikeAuthError(new Error('not logged in'))).toBe(true);
  });

  it('returns true for auth-related message in err.stderr property', () => {
    const err = Object.assign(new Error('Command failed'), {
      stderr: 'please run: gh auth login',
    });
    expect(looksLikeAuthError(err)).toBe(true);
  });

  it('returns true for 401 status in message', () => {
    expect(looksLikeAuthError(new Error('HTTP 401 Unauthorized'))).toBe(true);
  });

  it('returns true for 403 status in stderr', () => {
    const err = Object.assign(new Error('Request failed'), { stderr: 'HTTP 403 Forbidden' });
    expect(looksLikeAuthError(err)).toBe(true);
  });

  it('returns true for "authentication required" in message', () => {
    expect(looksLikeAuthError(new Error('Authentication Required'))).toBe(true);
  });

  it('returns false for generic errors unrelated to auth', () => {
    expect(looksLikeAuthError(new Error('network timeout'))).toBe(false);
    expect(looksLikeAuthError(new Error('JSON parse error'))).toBe(false);
  });

  it('returns false for ENOENT (gh not installed — not an auth issue)', () => {
    const err = Object.assign(new Error("spawn gh ENOENT"), { code: 'ENOENT' });
    expect(looksLikeAuthError(err)).toBe(false);
  });

  it('handles non-Error values gracefully', () => {
    expect(looksLikeAuthError('not logged in')).toBe(true);
    expect(looksLikeAuthError('network error')).toBe(false);
    expect(looksLikeAuthError(null)).toBe(false);
  });
});

// ─── listIssuesFallback — additional error paths ──────────────────────────────

describe('listIssuesFallback — error paths', () => {
  it('throws on non-array JSON from gh api', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: '{"error":"not an array"}', stderr: '' });
    await expect(listIssuesFallback('owner/repo', 'open')).rejects.toThrow('Expected array');
  });

  it('throws on malformed JSON from gh api', async () => {
    mockExecFile.mockResolvedValueOnce({ stdout: 'not-json-at-all', stderr: '' });
    await expect(listIssuesFallback('owner/repo', 'open')).rejects.toThrow();
  });

  it('propagates rejection when gh api exits non-zero', async () => {
    mockExecFile.mockRejectedValueOnce(
      Object.assign(new Error('Command failed'), { code: 1, stderr: 'gh api error' }),
    );
    await expect(listIssuesFallback('owner/repo', 'open')).rejects.toThrow('Command failed');
  });
});

// ─── listIssuesViaCli — ENOENT / gh-not-installed ────────────────────────────

describe('listIssuesViaCli — ENOENT', () => {
  it('propagates ENOENT when gh is not installed', async () => {
    const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: 'ENOENT' });
    mockExecFile.mockRejectedValueOnce(enoent);
    await expect(listIssuesViaCli('owner/repo', 'open')).rejects.toThrow('ENOENT');
  });
});
