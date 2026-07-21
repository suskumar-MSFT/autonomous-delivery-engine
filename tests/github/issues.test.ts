import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock child_process BEFORE importing the module under test ────────────────
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
}));
vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { exec } from 'node:child_process';
import { listIssues, listIssuesViaCli, listIssuesFallback } from '../../src/github/issues.js';

const mockExec = exec as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const CLI_RESPONSE = JSON.stringify([
  { number: 1, title: 'First issue', labels: [{ name: 'bug' }], state: 'open' },
  { number: 2, title: 'Second issue', labels: [], state: 'open' },
]);

const API_RESPONSE = JSON.stringify([
  { number: 3, title: 'API issue', labels: [{ name: 'enhancement' }], state: 'open' },
]);

describe('listIssuesViaCli', () => {
  it('calls gh CLI with correct args and returns parsed issues', async () => {
    mockExec.mockResolvedValueOnce({ stdout: CLI_RESPONSE, stderr: '' });

    const issues = await listIssuesViaCli('owner/repo', 'open');

    expect(mockExec).toHaveBeenCalledWith(
      'gh issue list --repo owner/repo --state open --json number,title,labels,state',
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual({ number: 1, title: 'First issue', labels: ['bug'], state: 'open' });
    expect(issues[1]).toEqual({ number: 2, title: 'Second issue', labels: [], state: 'open' });
  });

  it('throws on non-array JSON', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '{"error":"not array"}', stderr: '' });
    await expect(listIssuesViaCli('owner/repo', 'open')).rejects.toThrow('Expected array');
  });
});

describe('listIssuesFallback', () => {
  it('calls gh api and returns parsed issues', async () => {
    mockExec.mockResolvedValueOnce({ stdout: API_RESPONSE, stderr: '' });

    const issues = await listIssuesFallback('owner/repo', 'open');

    expect(mockExec).toHaveBeenCalledWith(
      'gh api repos/owner/repo/issues?state=open&per_page=100',
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 3,
      title: 'API issue',
      labels: ['enhancement'],
      state: 'open',
    });
  });
});

describe('listIssues', () => {
  it('returns CLI results when CLI succeeds', async () => {
    mockExec.mockResolvedValueOnce({ stdout: CLI_RESPONSE, stderr: '' });

    const issues = await listIssues('owner/repo');
    expect(issues).toHaveLength(2);
  });

  it('falls back to REST API when CLI fails', async () => {
    mockExec
      .mockRejectedValueOnce(new Error('gh not found'))
      .mockResolvedValueOnce({ stdout: API_RESPONSE, stderr: '' });

    const issues = await listIssues('owner/repo');
    expect(issues).toHaveLength(1);
    expect(issues[0].number).toBe(3);
  });

  it('uses "open" as default state', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '[]', stderr: '' });
    await listIssues('owner/repo');
    expect(mockExec).toHaveBeenCalledWith(
      expect.stringContaining('--state open'),
    );
  });
});
