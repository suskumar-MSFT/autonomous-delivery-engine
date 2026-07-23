/**
 * tests/monitor/monitor.test.ts
 *
 * Tests for M3-0: monitor scaffold — shared types + runMonitor stub.
 *
 * M3-0 delivers only the type scaffold and a no-op stub.  These tests verify:
 *   - runMonitor returns a well-formed MonitorRunResult (all fields present)
 *   - Stub always returns zero-failures (no CI calls in M3-0)
 *   - Return type is fully typed (TypeScript compile-time contract)
 *   - dryRun param accepted without error
 *   - No subprocess calls are made (injectable runner is never invoked)
 *
 * Full behavioural tests land with each sub-story (M3-1..M3-4).
 */

import { describe, it, expect, vi } from 'vitest';
import { runMonitor, type MonitorEvent, type MonitorOpts, type MonitorRunResult } from '../../src/monitor/monitor.js';

// ── Type-level smoke tests ────────────────────────────────────────────────────

describe('MonitorEvent type', () => {
  it('accepts a valid ci-failure event', () => {
    const event: MonitorEvent = {
      kind: 'ci-failure',
      sourceId: 'run-12345',
      title: '[CI] Tests failed on main (run 12345)',
      body: '## CI Failure\n\nWorkflow run 12345 failed.',
      detectedAt: '2026-07-23T10:00:00.000Z',
    };
    expect(event.kind).toBe('ci-failure');
    expect(event.sourceId).toBe('run-12345');
  });

  it('accepts pr-stale and regression kinds (reserved for M4)', () => {
    const stale: MonitorEvent = {
      kind: 'pr-stale',
      sourceId: 'pr-42',
      title: '[PR] PR #42 stale',
      body: 'No activity for 7 days.',
      detectedAt: '2026-07-23T10:00:00.000Z',
    };
    const regression: MonitorEvent = {
      kind: 'regression',
      sourceId: 'commit-abc',
      title: '[Regression] test-suite shrank after commit abc',
      body: 'Test count dropped by 12.',
      detectedAt: '2026-07-23T10:00:00.000Z',
    };
    expect(stale.kind).toBe('pr-stale');
    expect(regression.kind).toBe('regression');
  });
});

// ── runMonitor stub contracts ─────────────────────────────────────────────────

describe('runMonitor (M3-0 stub)', () => {
  it('returns a well-formed MonitorRunResult with zero failures', async () => {
    const result: MonitorRunResult = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
    });

    expect(result).toMatchObject({
      failuresDetected: 0,
      issuesFiledOrExisting: [],
      workOrdersDispatched: [],
      errors: [],
    });
  });

  it('accepts dryRun: true without error', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      dryRun: true,
    });
    expect(result.failuresDetected).toBe(0);
  });

  it('accepts dryRun: false without error', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      dryRun: false,
    });
    expect(result.failuresDetected).toBe(0);
  });

  it('never invokes the injectable runner (stub is a no-op)', async () => {
    const runner = vi.fn();
    await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      runner: runner as unknown as MonitorOpts['runner'],
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it('accepts injectable now() without error', async () => {
    const now = vi.fn(() => Date.now());
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      now,
    });
    // stub does not call now() yet (M3-4 will)
    expect(result.failuresDetected).toBe(0);
  });

  it('accepts a custom lookback without error', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
      lookback: 5,
    });
    expect(result.failuresDetected).toBe(0);
  });

  it('issuesFiledOrExisting is an empty array (not null/undefined)', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
    });
    expect(Array.isArray(result.issuesFiledOrExisting)).toBe(true);
    expect(result.issuesFiledOrExisting).toHaveLength(0);
  });

  it('workOrdersDispatched is an empty array (not null/undefined)', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
    });
    expect(Array.isArray(result.workOrdersDispatched)).toBe(true);
    expect(result.workOrdersDispatched).toHaveLength(0);
  });

  it('errors is an empty array (not null/undefined)', async () => {
    const result = await runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
    });
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns a Promise (async contract)', () => {
    const p = runMonitor({
      repo: 'suskumar-MSFT/autonomous-delivery-engine',
      checkoutDir: '/tmp/engine',
    });
    expect(p).toBeInstanceOf(Promise);
    return p;
  });
});
