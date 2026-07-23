# Milestone 4 — Run-Hardening

> **Status:** in-progress (2026-07-23)
> **Goal:** Harden the autonomous loop for sustained unattended operation — kill-switch,
> telemetry, daily caps, and a status view.
> **Exit criterion:** loop runs a full idea→ship cycle within caps and kill-switch is verified.

---

## Why M4

M1–M3 proved the core thesis end-to-end (idea → plan → build → monitor).  M4 makes the system
safe and observable for unattended production runs:

- **Kill-switch** — `LOOP PAUSED` in PROJECT.md already stops the scheduler.  M4 wires a
  programmatic probe inside `runLoop` itself so the loop stops even if already mid-run.
- **Telemetry** — structured run log (JSONL) so we can answer "what did the loop do today?"
  without grepping raw logs.
- **Daily cap** — prevent unbounded PR/unit churn by counting units in today's run log and
  refusing new units once the daily ceiling is hit.
- **Status view** — `getLoopStatus` reads the run log + PROJECT.md and returns a structured
  health summary; the caller can print it as a table.
- **M4 gate** — live verification that kill-switch, telemetry, caps, and status all work
  together in a real loop invocation.

---

## Module layout

| Story | Module | Description |
|-------|--------|-------------|
| M4-0 | `src/telemetry/run-log.ts` | Scaffold: `RunLogEntry` / `RunLog` types + `appendRunLog` / `readRunLog` stubs |
| M4-1 | `src/telemetry/run-log.ts` | Implement `appendRunLog` (JSONL append, injectable FS + mkdirp) + `readRunLog` |
| M4-2 | `src/core/kill-switch.ts` | `checkKillSwitch(projectFilePath, readFile)` + wire into `runLoop` → `StopReason: 'killed'` |
| M4-3 | `src/telemetry/daily-cap.ts` | `countUnitsToday(log, date)` + daily-cap guard in `runLoop` → `StopReason: 'capped-daily'` |
| M4-4 | `src/cli/status.ts` | `getLoopStatus(opts)` — reads run log + PROJECT.md → structured `LoopStatus` |
| M4-5 | `tests/e2e/m4-gate.test.ts` | Live gate: kill-switch stops loop, telemetry written, status renders |

---

## M4-0 scaffold

`src/telemetry/run-log.ts` exposes:

```ts
export interface RunLogEntry {
  timestamp: string;        // ISO 8601 — when runLoop started
  repo: string;             // target repo  (owner/name)
  unitsProcessed: number;   // units completed this run
  stoppedReason: string;    // StopReason from LoopRunResult
  durationMs: number;       // wall-clock ms for the whole run
  monitorErrors: string[];  // errors from the monitor pre-pass
}

export type RunLog = RunLogEntry[];

export interface TelemetryOpts {
  logFile?: string;                               // default: 'logs/run-log.jsonl'
  enabled?: boolean;                              // default: true
  appendFile?: (path: string, data: string) => Promise<void>;
  mkdirp?: (dir: string) => Promise<void>;
  now?: () => number;
}

export async function appendRunLog(entry: RunLogEntry, opts?: TelemetryOpts): Promise<void>;
export function readRunLog(raw: string): RunLog;
```

All boundaries are injectable.  `appendRunLog` is a stub in M4-0 and is fully implemented in M4-1.

---

## Safety contract

- `appendRunLog` is always write-only and append-safe (JSONL — one entry per line).
- `checkKillSwitch` is always read-only; it never mutates any file.
- The daily-cap guard only reads from the run log; it never mutates it.
- `getLoopStatus` is always read-only.
- No subprocess calls in any telemetry module — pure FS + clock boundaries.
- All boundaries are injectable so every module is testable without live FS or subprocesses.

---

## Sequencing

```
M4-0 (scaffold, this story)
  → M4-1 (telemetry writer, unblocked)
  → M4-2 (kill-switch probe, unblocked)
  → M4-3 (daily cap, deps: M4-1)
  → M4-4 (status view, deps: M4-1)
  → M4-5 (M4 gate, deps: M4-1,M4-2,M4-3,M4-4)
```
