import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock child_process BEFORE importing the module under test ────────────────
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile } from 'node:child_process';
import { listIssues, listIssuesViaCli, listIssuesFallback } from '../../src/github/issues.js';

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
});
