# PROJECT — Autonomous Idea→Ship Delivery System (Build Project)

> Single source of truth for the **build project's current phase + focus**.
> The thing we are building is specified in `design\north-star.md`.

## What we're building
A mostly-autonomous, always-on **Planner + Builder + Monitor** platform that drives an
abstract product idea end-to-end (idea → vision → roadmap → epics/features/stories/tasks →
per-milestone plan → delegated implementation → continuous monitoring & auto-fix), with
human approval gates and hard guardrails. **The product is the system itself.**

## Current phase
- **Phase:** `M1 — ORCHESTRATED BUILDER (builder + loop + work-order Builder all merged; wiring the runtime fulfiller)`
- **Date entered:** 2026-07-21
- **M1 progress:** ✅ M1-1 (builder module, mocked) + ✅ M1-3 (loop controller: ownership-claim + gated-merge + Reviewer hook + wall-clock cap) + ✅ **M1-2 (work-order Builder, ADR-020)** MERGED (PR #10, #13, #14). Repo default branch fixed → `main`.
- **Now:** wire the **runtime fulfiller** — a work-claw schedule that watches `work-orders\<id>.json`, spawns a `developer` sub-agent to implement each, and writes `work-orders\<id>.result.json` (PR URL). This closes the work-order Builder loop end-to-end — the first time the *engine* drives a live change.
- **Loop trigger installed (ADR-021):** work-claw job `Autonomous Delivery Loop — Trigger` (every 2h) now advances the loop between human messages. Kill-switch: add a `LOOP PAUSED` line to this file or say "pause".

## Committed choices
| # | Decision | Choice | ADR |
|---|---|---|---|
| 1 | Runtime language/stack | **TypeScript on Node.js 22** | ADR-001 |
| 2 | Target code repo | **New private repo `suskumar-MSFT/autonomous-delivery-engine`** (account amended by ADR-015), checked out at `C:\Workspace\Features\IdeaToProductE2E\engine\` | ADR-002 + ADR-015 |
| 3 | Architecture | **Planner + Builder + Reviewer + Monitor on the work-claw substrate**, coordinated via `state\*` files + GitHub as the shared bus | ADR-003 |
| 4 | Loop cadence + Builder cap | Crawl: manual trigger, cap=1 · Walk: every 30 min (08:00–20:00 PT, weekdays), cap=2 · Run: + event reactions | ADR-004 |
| 5 | Gate policy | **Async oversight (ADR-006)** — objective bars (CI + evals + self-review) + gated auto-merge; human is revocable async oversight, not a blocking gate | ADR-006 (supersedes ADR-005) |
| 6 | CI / GitHub account | **Option A: host project repos under `suskumar-MSFT`** (hosted CI works; EMU account blocks runners) | ADR-015 |

## Pointers
- Requirements/spec → `design\north-star.md`
- Architecture + ADRs → `design\architecture.md`
- Milestones → `state\ROADMAP.md`
- Backlog → `state\BACKLOG.md` (created after roadmap gate)
- Decisions/gates → `state\DECISIONS.md`
- Build log → `logs\<date>.md`

## Next action
**Wire the runtime fulfiller** (the M1-2 counterpart, as a schedule not code). `WorkOrderBuilder` is
merged (PR #14): the engine now *emits* `work-orders\<id>.json` and polls for `work-orders\<id>.result.json`.
What's missing is the *fulfiller*: a work-claw scheduled job that watches `work-orders\*.json`, spawns a
`developer` sub-agent to implement each work-order → opens the PR → writes `work-orders\<id>.result.json`
with the PR URL. Wiring that closes the loop end-to-end (engine drives a live change for the first time).
Then a real E2E dry-then-live run of `runOnce` against one issue is the M1 exit criterion.

**Loop now self-advances** via the `Autonomous Delivery Loop — Trigger` job (every 2h, ADR-021) — no
human message required to continue.
