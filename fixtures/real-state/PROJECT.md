# PROJECT — Autonomous Idea→Ship Delivery System (Build Project)

> Single source of truth for the **build project's current phase + focus**.
> The thing we are building is specified in `design\north-star.md`.

## What we're building
A mostly-autonomous, always-on **Planner + Builder + Monitor** platform that drives an
abstract product idea end-to-end (idea → vision → roadmap → epics/features/stories/tasks →
per-milestone plan → delegated implementation → continuous monitoring & auto-fix), with
human approval gates and hard guardrails. **The product is the system itself.**

## Current phase
- **Phase:** `PHASE -1 COMPLETE (✅ validated) → M0 — RE-SCOPED ENGINE BUILD`
- **Date entered:** 2026-07-21
- **Phase -1 result:** ✅ **Validated.** Hand-drove a real operator idea (`outfit-combos`, Outfyt's
  combinatorial core) → green-CI PR on the *existing* substrate in **~7.6 min unattended, 0
  human code touches**. Live artifact: `suskumar-MSFT/outfit-combos#1` (green 2/2). Proved the
  substrate is already a working **Builder** (FND-001) and that hosted CI works on the personal
  account (FND-002 → ADR-015 Option A).
- **Focus now (M0):** Re-scope the engine away from re-building a Builder. Build only the pieces
  the substrate *lacks*: the **deterministic loop controller** (next-unit selection, ownership
  locking, caps, kill-switch, digest), the **CI/done-bar gate**, and the **front-of-pipeline**
  (idea→decomposition + decision ledger) — orchestrating the substrate's sub-agents as the
  Builder rather than reinventing one (ADR-012, FND-001).

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
**M0 kickoff (re-scoped).** Author the re-scoped M0 spec in `design\` and decompose into GitHub
issues (under `suskumar-MSFT`): (1) deterministic **loop controller** (next-unit selection,
ownership lock in `BACKLOG`, caps, kill-switch, async digest); (2) **CI/done-bar gate** wired to
hosted Actions on `suskumar-MSFT`; (3) **front-of-pipeline** (idea→decomposition + decision-ledger
sync). Explicitly **do not** build a bespoke Builder — orchestrate the work-claw `developer`
sub-agent as the Builder (FND-001, ADR-012). Present the re-scoped M0 plan to the operator as an
async checkpoint, then run the Autonomy Model loop.
