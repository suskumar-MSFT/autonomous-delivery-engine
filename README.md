# Autonomous Delivery Engine

A self-driving software delivery substrate that reads project state (markdown files), 
queries GitHub for open issues, and selects the next unit of work — autonomously.

**Milestone M0-1** ("hello-loop vertical slice") proved the core read loop.  
**Milestone M1-1** ("builder module + loop.runOnce") adds the builder agent that drives
Claude Code CLI to implement an issue, runs tests/build, and opens a PR — with a fully
mocked `CommandRunner` boundary so CI never touches real claude/gh/network.

## Architecture

```
src/
  state/       – Typed markdown parsers (roadmap, backlog, project state)
  github/      – Thin gh CLI wrapper (listIssues)
  core/        – Selector logic, hello-loop CLI, loop.runOnce, run-once CLI
  agents/      – Builder agent (Claude Code CLI driver)
fixtures/
  state/       – Sample ROADMAP.md, BACKLOG.md, PROJECT.md
tests/         – Hermetic unit tests (no network, no filesystem side effects)
```

### Key Modules (M1-1)

#### `src/agents/builder.ts`
Exports `runBuilder(opts)` — the Claude Code CLI driver.

- **`CommandRunner` interface** — mockable boundary for ALL subprocess calls (`gh`, `claude`, `git`, `npm`).  
  Default implementation uses `child_process.execFile` (argv arrays, NO shell strings).  
  Pass a mock `runner` in tests → zero real network calls in CI.
- Steps: fetch issue → compute branch `feat/issue-<n>` → assemble prompt → invoke `claude -p "<prompt>"` headlessly → run `npm test` + `npm run build` → if green, commit + push + `gh pr create`.
- Returns `BuilderResult { branch, prUrl, testsPassed, implemented }`.
- `dryRun:true` skips commit/push/PR (safe for loop dry-runs).

#### `src/core/loop.ts`
Exports `runOnce(opts)` — one pass of the autonomous delivery loop.

- Reads `BACKLOG.md` → selects next ready+unowned unit → calls `runBuilder` with `dryRun:true`.
- Returns `{ selected, result }`.
- Ownership-write and gated-merge deferred to M1-3.

#### `src/core/run-once.ts` (CLI)
```bash
node dist/core/run-once.js [--state-dir <path>] [--repo <owner/repo>] [--checkout-dir <path>]
```
Runs `runOnce` in dry-run mode (default — safe).

```bash
node dist/core/run-once.js --live ...
```
**`--live` flag — M1-2 smoke path.**  
Passes the real (non-dryRun) builder.  
⚠️ INTENTIONALLY NOT RUN IN CI. Only use interactively with a real `gh` auth token and Claude Code CLI installed. The CI workflow does not pass `--live`.

## Prerequisites

- Node.js 22+
- `npm`
- `gh` CLI (authenticated) — only required to run CLI commands (not for tests)
- Claude Code CLI (`claude`) — only required for `--live` runs

## Quick Start

### Install dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

Compiled output goes to `dist/`.

### Run hello-loop

```bash
node dist/core/hello-loop.js
# or with custom args:
node dist/core/hello-loop.js --state-dir ./fixtures/state --repo suskumar-MSFT/autonomous-delivery-engine
```

### Run run-once (dry-run)

```bash
node dist/core/run-once.js --state-dir ./fixtures/real-state --repo suskumar-MSFT/autonomous-delivery-engine --checkout-dir .
```

### Test

```bash
npm test
```

### Lint

```bash
npm run lint
```

## State Files

The engine reads three markdown files:

| File | Contents |
|------|----------|
| `ROADMAP.md` | Milestone table: ID, name, phase, status |
| `BACKLOG.md` | Work item table: ID, GH#, title, type, status, owner |
| `PROJECT.md` | Current phase number and focus statement |

## CI

GitHub Actions runs on every push and pull request:
1. `npm ci` — install
2. `npm run lint` — ESLint
3. `npm test` — Vitest (all mocked, no network)
4. `npm run build` — TypeScript compile

## Design Principles

- **Mocked boundary**: `CommandRunner` interface isolates all subprocess calls; tests inject fakes — no real `claude`/`gh`/network in CI
- **Dry-run by default**: `runOnce` always uses `dryRun:true`; `--live` is an explicit opt-in for M1-2 smoke testing
- **Read-only baseline**: hello-loop never writes state or calls mutating GitHub commands
- **Hermetic tests**: unit tests use committed fixture files, no network, no absolute paths
- **Deterministic**: selectNextUnit tie-breaks by lexicographic id — same input always gives same output
- **Thin wrappers**: GitHub integration shells out to `gh` CLI (execFile, NO shell strings)

## License

MIT

