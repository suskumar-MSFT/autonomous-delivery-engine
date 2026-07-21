# BACKLOG — Autonomous Delivery System Build

> Epics → stories → tasks with **status + owner**. The loop claims `owner` before starting a
> unit (prevents double-grab) and releases on PR open/merge. Status legend:
> `⬜ ready` · `🔵 in-progress` · `👀 in-review` · `✅ done` · `⛔ blocked`.
> GitHub is the execution/audit bus; this file is the loop's authoritative work list.

## Milestone M0 — Foundations (re-scoped) 
Repo: `suskumar-MSFT/autonomous-delivery-engine` · Spec: `design\milestone-0.md`

| ID | GH# | Item | Type | Status | Owner | Notes |
|---|---|---|---|---|---|---|
| M0 | #1 | Foundations: loop-controller seedling + CI gate + state/GitHub plumbing | epic | 🔵 in-progress | — | re-scoped per FND-001/ADR-012 |
| M0-1 | #2 | hello-loop vertical slice (read state + list issues + pick next unit) + green CI | story | 🔵 fixing | builder:dev-subagent → PR #3 | Reviewer NEEDS-FIX → bugs #4/#5/#6 dispatched on same branch |
| bug | #4 | command injection via --repo (shell interpolation); violates read-only | bug | 🔵 in-progress | builder:fix-subagent | must-fix; execFile argv |
| bug | #5 | gh REST fallback broken (unquoted &) + tautological test | bug | 🔵 in-progress | builder:fix-subagent | must-fix |
| bug | #6 | state parsers can't read the real state files (schema mismatch) | bug | 🔵 in-progress | builder:fix-subagent | must-fix; #2 exit criterion; ADR-016 |
| M0-2 | — | harden state readers vs malformed/edge-case tables | story | ⬜ ready | — | Reviewer-filed follow-up (create after M0-1 review) |
| M0-3 | — | gh wrapper REST fallback + auth/error handling coverage | story | ⬜ ready | — | follow-up |

## Later milestones
Decomposition lands here as each milestone opens (M1 = orchestrated Builder slice, M2 = Planner + always-on loop, M3 = Monitor, M4 = run-hardening). See `state\ROADMAP.md`.
