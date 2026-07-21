# ROADMAP — Building the Autonomous Delivery System

> First-cut build milestones. Crawl → walk → run. Status updated on milestone
> start/finish. Detailed backlog per milestone lands in `state\BACKLOG.md` after the
> roadmap gate.

## Legend
`⬜ not started` · `🔵 in progress` · `✅ done` · `⛔ blocked`

## Milestones
| # | Milestone | Phase | Goal (exit criteria) | Status |
|---|---|---|---|---|
| **M-1** | Validate-first (phase -1) | crawl⁻ | Hand-drive ONE real idea → passing PR on the *existing* substrate (no bespoke engine); measure success rate, human-touch count, human-minutes/PR. **Exit:** one real idea reaches a green PR by hand + a written go/no-go on building the engine. | ✅ **DONE** — `suskumar-MSFT/outfit-combos#1` green (2/2 CI, 8/8 tests), idea→green-PR ~7.6 min unattended, 0 code touches. GO = **re-scope** engine (FND-001); CI account = Option A (ADR-015). |
| **M0** | Foundations & scaffolding (**re-scoped**) | crawl | Repo `suskumar-MSFT/autonomous-delivery-engine`; TS + vitest + lint; `state\` schema lib; `gh` wrapper (+REST fallback); config + secrets; structured logging. **Re-scope (FND-001/ADR-012):** build the **loop controller + CI/done-bar gate + front-of-pipeline**, NOT a bespoke Builder (orchestrate the work-claw sub-agent as Builder). **Exit:** `hello-loop` reads state + lists GitHub issues, green CI on `suskumar-MSFT`. | ⬜ |
| **M1** | Thin vertical slice — orchestrated Builder | crawl | The loop controller takes **one existing GitHub issue → dispatches the substrate Builder → branch → change + test → PR** and applies the done-bar gate, manually triggered. **Exit:** one real PR opened via the controller passing CI. | ⬜ |
| **M2** | Planner + always-on loop | walk | Planner: idea→vision→roadmap→epic/feature/story decomposition with gates + GitHub Projects sync. Deterministic loop controller: next-unit selection + ownership claim. Scheduled every 30 min; Builder cap 2. **Exit:** an idea flows to a populated, gated backlog and the loop drives ≥2 stories to PRs unattended. | ⬜ |
| **M3** | Monitor + proactive fix | walk | Watch CI / PR health / shipped changes; detect regressions; file issues; dispatch fixes. **Exit:** an injected CI failure is auto-triaged → issue filed → fix PR dispatched. | ⬜ |
| **M4** | Run-hardening | run | Event reactions (PR merged / CI failed / approval), scope+cost caps, kill-switch, quality gates, run/cost telemetry + a status view. **Exit:** loop runs a full idea→ship cycle within caps, kill-switch verified. | ⬜ |

## Sequencing rationale
- **Slice before breadth:** M1 proves the riskiest path (agent → real code → passing PR)
  end-to-end on one issue before we build the Planner or the always-on loop on top.
- **Determinism where it counts:** the loop controller (M2) is plain code; agents stay
  scoped to open-ended plan/build/monitor work.
- **Safety last-mile is explicit:** caps + kill-switch + telemetry (M4) gate the shift
  from supervised "walk" to unattended "run".

## First milestone in focus
**M0 (re-scoped engine build).** M-1 (validate-first) is ✅ **complete** — the substrate proved
itself as a Builder, so M0 pivots to building only what the substrate lacks: the deterministic
**loop controller + CI/done-bar gate + front-of-pipeline** (FND-001, ADR-012), with all repos
under `suskumar-MSFT` (ADR-015).
