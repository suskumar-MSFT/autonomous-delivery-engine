# Autonomous Delivery Engine

A self-driving software delivery substrate that reads project state (markdown files), 
queries GitHub for open issues, and selects the next unit of work — autonomously.

This is milestone **M0-1** ("hello-loop vertical slice"): a read-only TypeScript/Node 22 
project that proves the core loop: parse state → fetch GitHub data → select next task → print summary.

## Architecture

```
src/
  state/       – Typed markdown parsers (roadmap, backlog, project state)
  github/      – Thin gh CLI wrapper (listIssues)
  core/        – Selector logic + hello-loop CLI entry
fixtures/
  state/       – Sample ROADMAP.md, BACKLOG.md, PROJECT.md
tests/         – Hermetic unit tests (no network, no filesystem side effects)
```

## Prerequisites

- Node.js 22+
- `npm`
- `gh` CLI (authenticated) — only required to run the `hello-loop` CLI (not for tests)

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

This prints:
- Current phase and focus
- Milestone statuses from ROADMAP.md
- Number of open GitHub issues
- The next unit of work it would pick (read-only — nothing is written or mutated)

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
3. `npm test` — Vitest
4. `npm run build` — TypeScript compile

## Design Principles

- **Read-only**: hello-loop never writes state or calls mutating GitHub commands
- **Hermetic tests**: unit tests use committed fixture files, no network, no absolute paths
- **Deterministic**: selectNextUnit tie-breaks by lexicographic id — same input always gives same output
- **Thin wrappers**: GitHub integration shells out to `gh` CLI with a REST fallback

## License

MIT
