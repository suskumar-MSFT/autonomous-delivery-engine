/**
 * tests/e2e/m4-gate.test.ts — M4 gate (M4-5)
 *
 * Verifies all five M4 hardening features work correctly together:
 *
 *   1. Kill-switch: LOOP PAUSED in PROJECT.md stops runLoop immediately
 *      (stoppedReason='killed', 0 units, builder never called).
 *   2. Telemetry: runLoop appends a JSONL entry to the run log after an
 *      empty-backlog run (full mkdirp → appendFile path exercised with real FS).
 *   3. Status view: getLoopStatus reads the persisted log and returns the
 *      correct LoopStatus (lastStopReason, lastRunTime, unitsToday,
 *      killSwitchActive).
 *   4. Kill-switch in status: getLoopStatus reflects killSwitchActive=true
 *      when the sentinel is present.
 *   5. Daily cap accounting: getLoopStatus.unitsToday sums entries for today
 *      and ignores past-date entries.
 *   6. Daily cap enforcement: runLoop stops with stoppedReason='capped-daily'
 *      when the historical unit count already meets maxUnitsPerDay.
 *
 * **Hermetic (CI-safe):**
 * No live `gh` API calls or network I/O.  Telemetry tests use a real tmpdir
 * so the FS boundary (mkdirp + appendFile) is exercised end-to-end.  The
 * kill-switch, status, and daily-cap scenarios use injectable fakes.
 * NOT skipped in CI.
 *
 * **Test ordering note:**
 * Scenario 3 (status view) reads the JSONL file written by scenario 2
 * (telemetry), so the two tests must run in order — which Vitest guarantees
 * within a single `describe` block by default.  If scenario 2 fails, scenario
 * 3 is explicitly skipped via a file-existence guard to avoid false attribution.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { runLoop } from '../../src/core/loop-runner.js';
import { getLoopStatus } from '../../src/cli/status.js';
import { readRunLog } from '../../src/telemetry/run-log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * The empty-backlog fixture has only 'done' and 'planned' items —
 * selectNextUnit returns undefined → runLoop exits with stoppedReason='empty'.
 */
const EMPTY_BACKLOG_DIR = join(__dirname, '../fixtures/empty-backlog');
const REPO = 'suskumar-MSFT/autonomous-delivery-engine';

// ── Test-suite state ────────────────────────────────────────────────────────

describe('M4-5 Gate — kill-switch, telemetry, daily cap, status view', () => {
  let tmpDir: string;
  /** Shared JSONL log path used by scenarios 2 and 3 (round-trip test). */
  let logFile: string;

  beforeAll(async () => {
    tmpDir = join(
      tmpdir(),
      `m4-gate-${randomBytes(4).toString('hex')}`,
    );
    // Pre-create the logs sub-directory; telemetry mkdirp will be a no-op.
    await mkdir(join(tmpDir, 'logs'), { recursive: true });
    logFile = join(tmpDir, 'logs', 'run-log.jsonl');
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ── Scenario 1: Kill-switch stops the loop ──────────────────────────────

  it(
    'runLoop stops with stoppedReason=killed and 0 units when LOOP PAUSED is injected',
    async () => {
      let builderCalled = false;

      const result = await runLoop({
        repo: REPO,
        checkoutDir: tmpDir,
        stateDir: EMPTY_BACKLOG_DIR,
        live: false,
        maxUnits: 2,
        // Inject kill-switch: pretend PROJECT.md contains the sentinel.
        killSwitchReadFile: async (_path, _enc) =>
          '# PROJECT\nSome content\nLOOP PAUSED\nMore content\n',
        // Builder must never be called — kill-switch fires before any runOnce.
        builderFn: async () => {
          builderCalled = true;
          return { prUrl: null, dryRun: true };
        },
      });

      expect(result.stoppedReason).toBe('killed');
      expect(result.unitsProcessed).toBe(0);
      expect(result.results).toHaveLength(0);
      expect(builderCalled).toBe(false);
    },
  );

  // ── Scenario 2: Telemetry is written to the JSONL run log ──────────────

  it(
    'runLoop appends a JSONL entry to the run log after an empty-backlog run',
    async () => {
      const result = await runLoop({
        repo: REPO,
        checkoutDir: tmpDir,
        stateDir: EMPTY_BACKLOG_DIR,
        live: false,
        maxUnits: 2,
        telemetry: {
          logFile,
          enabled: true,
          // No overrides — real fs/promises.appendFile + mkdirp exercised.
        },
      });

      expect(result.stoppedReason).toBe('empty');
      expect(result.unitsProcessed).toBe(0);

      // ── Verify the JSONL file exists and has exactly one valid entry ──────
      const raw = await readFile(logFile, 'utf8');
      const entries = readRunLog(raw);

      expect(entries).toHaveLength(1);

      const [entry] = entries;
      expect(entry.repo).toBe(REPO);
      expect(entry.stoppedReason).toBe('empty');
      expect(entry.unitsProcessed).toBe(0);
      expect(entry.durationMs).toBeGreaterThanOrEqual(0);
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // ISO 8601
      expect(entry.monitorErrors).toHaveLength(0);
    },
  );

  // ── Scenario 3: getLoopStatus reads the persisted run log ──────────────
  // Depends on logFile written by scenario 2 (round-trip verification).
  // Guard: skip with a clear message if scenario 2 failed to write the file,
  // so a write failure doesn't masquerade as a getLoopStatus regression.

  it(
    'getLoopStatus returns correct LoopStatus from the persisted run log',
    async (ctx) => {
      // If scenario 2 failed, logFile will be absent — skip rather than
      // produce a misleading failure on getLoopStatus.
      const logExists = await stat(logFile).then(() => true).catch(() => false);
      if (!logExists) {
        console.warn('[M4-5 Scenario 3] logFile missing — scenario 2 must have failed; skipping.');
        ctx.skip();
      }

      // Use a far-future "now" so no log entries fall on "today" → unitsToday=0.
      const farFutureMs = new Date('2099-12-31T23:59:59Z').getTime();

      const status = await getLoopStatus({
        logFile,
        // Non-existent PROJECT.md → checkKillSwitch fail-open → killSwitchActive=false.
        projectFile: join(tmpDir, 'does-not-exist.md'),
        now: () => farFutureMs,
      });

      expect(status.lastStopReason).toBe('empty');   // from scenario 2 log entry
      expect(status.lastRunTime).not.toBeNull();      // timestamp was written
      expect(status.unitsToday).toBe(0);             // no entries for 2099-12-31
      expect(status.monitorErrors).toHaveLength(0);
      expect(status.killSwitchActive).toBe(false);   // missing file → fail-open
    },
  );

  // ── Scenario 4: getLoopStatus reflects active kill-switch ──────────────

  it(
    'getLoopStatus returns killSwitchActive=true when LOOP PAUSED is injected',
    async () => {
      // Path-aware readFile: return sentinel for the project file; throw ENOENT
      // for the log file (exercises fail-open defaults for log reads).
      const projectFile = join(tmpDir, 'paused-project.md');

      const status = await getLoopStatus({
        logFile: join(tmpDir, 'logs', 'non-existent-log.jsonl'),
        projectFile,
        readFile: async (path, _enc) => {
          if (path === projectFile) return '# PROJECT\nLOOP PAUSED\n';
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
      });

      expect(status.killSwitchActive).toBe(true);
      expect(status.lastRunTime).toBeNull();  // no log data → null
      expect(status.unitsToday).toBe(0);
      expect(status.monitorErrors).toHaveLength(0);
    },
  );

  // ── Scenario 5: unitsToday sums today's entries; ignores past dates ────

  it(
    'getLoopStatus.unitsToday sums today entries and ignores past-date entries',
    async () => {
      const multiLogFile = join(tmpDir, 'logs', 'multi-run-log.jsonl');
      const todayMs = Date.now();
      const todayDate = new Date(todayMs).toISOString().slice(0, 10); // 'YYYY-MM-DD'

      // Two entries for today (1 + 2 = 3 units), one from a past date (99 units, ignored).
      const entryToday1 = JSON.stringify({
        timestamp: `${todayDate}T08:00:00.000Z`,
        repo: REPO, unitsProcessed: 1, stoppedReason: 'cap',
        durationMs: 5000, monitorErrors: [],
      });
      const entryToday2 = JSON.stringify({
        timestamp: `${todayDate}T09:30:00.000Z`,
        repo: REPO, unitsProcessed: 2, stoppedReason: 'empty',
        durationMs: 3000, monitorErrors: [],
      });
      const entryPast = JSON.stringify({
        timestamp: '2020-01-01T12:00:00.000Z',
        repo: REPO, unitsProcessed: 99, stoppedReason: 'cap',
        durationMs: 1000, monitorErrors: [],
      });

      await writeFile(
        multiLogFile,
        `${entryToday1}\n${entryToday2}\n${entryPast}\n`,
        'utf8',
      );

      const status = await getLoopStatus({
        logFile: multiLogFile,
        projectFile: join(tmpDir, 'does-not-exist.md'),
        now: () => todayMs,
      });

      expect(status.unitsToday).toBe(3);         // 1 + 2; past entry not counted
      expect(status.lastStopReason).toBe('cap'); // last line in file = entryPast
      expect(status.killSwitchActive).toBe(false);
    },
  );

  // ── Scenario 6: Daily cap enforcement stops the loop ───────────────────
  // Verifies M4-3's enforcement side: runLoop stops with stoppedReason=
  // 'capped-daily' when historicalUnitsToday >= maxUnitsPerDay, BEFORE
  // runOnce is called (builder must never fire).

  it(
    'runLoop stops with stoppedReason=capped-daily when daily cap is already met',
    async () => {
      const todayMs = Date.now();
      const todayDate = new Date(todayMs).toISOString().slice(0, 10);

      // Inject a run log that already has maxUnitsPerDay=2 units for today.
      const historicalJSONL =
        JSON.stringify({
          timestamp: `${todayDate}T07:00:00.000Z`,
          repo: REPO, unitsProcessed: 1, stoppedReason: 'cap',
          durationMs: 3000, monitorErrors: [],
        }) + '\n' +
        JSON.stringify({
          timestamp: `${todayDate}T08:00:00.000Z`,
          repo: REPO, unitsProcessed: 1, stoppedReason: 'empty',
          durationMs: 2000, monitorErrors: [],
        }) + '\n';

      let builderCalled = false;

      const result = await runLoop({
        repo: REPO,
        checkoutDir: tmpDir,
        stateDir: EMPTY_BACKLOG_DIR,
        live: false,
        maxUnits: 2,
        maxUnitsPerDay: 2,
        // nowMs for the daily-cap pre-read: same day as the historical entries.
        startedAt: todayMs,
        // Inject the historical log so readDailyCount returns 2 (= cap).
        dailyCapReadFile: async (_path, _enc) => historicalJSONL,
        // Builder must never be called — cap check fires before runOnce.
        builderFn: async () => {
          builderCalled = true;
          return { prUrl: null, dryRun: true };
        },
      });

      expect(result.stoppedReason).toBe('capped-daily');
      expect(result.unitsProcessed).toBe(0);
      expect(result.results).toHaveLength(0);
      expect(builderCalled).toBe(false);
    },
  );
});
