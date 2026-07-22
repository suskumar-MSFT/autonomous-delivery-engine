# BACKLOG — Autonomous Delivery System Build

> Epics → stories → tasks with **status + owner**. The loop claims `owner` before starting a
> unit (prevents double-grab) and releases on PR open/merge. Status legend:
> `⬜ ready` · `🔵 in-progress` · `👀 in-review` · `✅ done` · `⛔ blocked`.
> GitHub is the execution/audit bus; this file is the loop's authoritative work list.

## Milestone M0 — Foundations (re-scoped) 
Repo: `suskumar-MSFT/autonomous-delivery-engine` · Spec: `design\milestone-0.md`

| ID | GH# | Item | Type | Status | Owner | Notes |
|---|---|---|---|---|---|---|
| M0 | #1 | Foundations: loop-controller seedling + CI gate + state/GitHub plumbing | epic | 🔵 in-progress | — | slice-1 (M0-1) merged; M0-2/M0-3 hardening open |
| M0-1 | #2 | hello-loop vertical slice (read state + list issues + pick next unit) + green CI | story | ✅ done | PR #3 (merged) | full loop: build→review→fix→review PASS→gated-merge; 48 tests |
| bug | #4 | command injection via --repo (shell interpolation); violates read-only | bug | ✅ done | PR #3 | execFile argv + repo regex validation |
| bug | #5 | gh REST fallback broken (unquoted &) + tautological test | bug | ✅ done | PR #3 | execFile argv; test asserts parsed output |
| bug | #6 | state parsers can't read the real state files (schema mismatch) | bug | ✅ done | PR #3 | lenient parsers + real-state fixtures |
| M0-2 | #7 | harden state readers + clean parseProject phase/focus extraction | story | 🔵 in-progress | loop-bot | Reviewer-filed follow-up (display-only polish + hardening) |
| M0-3 | — | gh wrapper REST fallback + auth/error handling coverage | story | ⬜ ready | — | folded into #7 partially; keep for auth/error depth |
| M1 | #8 | Orchestrated Builder: controller drives one issue → gated-merged PR (core thesis) | epic | 🔵 in-progress | — | spec design\milestone-1.md |
| M1-1 | #9 | Builder module (Claude Code CLI driver) + loop.runOnce(), mocked boundaries + green CI | story | ✅ done | merged PR #10 (2026-07-21) | build→review(NEEDS-FIX #11: dryRun not dry)→fix→re-review PASS→gated-merge |
| M1-2 | #12 | Work-order Builder (Option b): engine writes `work-orders\<id>.json` → scheduled work-claw job dispatches a `developer` sub-agent → PR, reported back through the `CommandRunner`/builder seam | story | ✅ done | — | **MERGED PR #14** (2026-07-22): `WorkOrderBuilder` + `createWorkOrderBuilder` factory; dryRun truly dry, bounded poll (injectable clock), drop-in behind `builderFn` seam; 13 hermetic tests (125 total). Review PASS, CI green. Fulfiller schedule is the remaining M1-2 counterpart |
| M1-3 | #13 | ownership claim + gated-merge + Reviewer-pass hook + wall-clock cap wired into the loop controller | story | ✅ done | merged PR #13 (2026-07-22) | build→CI red(1 racy test)→fix(injectable clock)→CI green→review PASS→gated-merge; 112 tests |
| M1-4 | — | owner.ts: guard against multi-row writes on duplicate ids (claim/release should target a single row) | story | ⬜ ready | — | Reviewer nit (latent; not triggerable today — dup-id rows aren't ready+unowned) |
| M1-5 | — | loop.ts: validate `repo` independently of `builderFn` (defense-in-depth if a non-validating builderFn is injected) | story | ⬜ ready | — | Reviewer nit (no injection risk today — argv form) |
| M0-3 | — | gh wrapper REST fallback + auth/error handling coverage | story | ⬜ ready | — | follow-up |

## Milestone M2 — Always-on loop (event-driven trigger) · planned (ADR-022)
> Evolves the loop from a blind 30m timer to event-driven. The 30m work-claw job stays as the
> bridge until M2-1+M2-2 are proven, then M2-3 retires it. Build only after M1's fulfiller is wired.

| ID | GH# | Item | Type | Status | Owner | Notes |
|---|---|---|---|---|---|---|
| M2-1 | — | In-process loop chaining: after a unit finishes (merge/blocked/capped), immediately select the next ready unit and continue within caps/time budget | story | ⬜ ready | — | Event-driven layer 1 (ADR-022); removes the inter-unit gap; needs the M2 persistent loop process |
| M2-2 | — | External-event watcher: short-interval **edge-triggered** `gh` poll (PR merged, CI concluded, issue labeled ready, regression) firing `runOnce` only on a NEW event vs a stored cursor (dedup) | story | ⬜ ready | — | Event-driven layer 2 (ADR-022); pickup latency ≤30m → ~sec; no webhooks (no reachable endpoint), no self-hosted runner on a public repo (security) |
| M2-3 | — | Retire/downgrade the 30m work-claw timer to a slow daily backstop once M2-1+M2-2 proven for ≥3 real cycles | story | ⬜ ready | — | ADR-022 retirement gate; depends on M2-1, M2-2 |

## Later milestones
Decomposition lands here as each milestone opens (M1 = orchestrated Builder slice, M2 = Planner + always-on loop, M3 = Monitor, M4 = run-hardening). See `state\ROADMAP.md`.
