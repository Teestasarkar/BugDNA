# Product requirements

## The problem

A reviewer approving a pull request has to hold several things in their head at
once: how large the change is, what it touches, whether the tests moved, whether
this area of the codebase has broken before. Most of that information already
exists — in the diff, and in the repository's own history. It is just not
assembled anywhere.

So risk assessment at merge time is intuition, and intuition scales badly. It
varies by reviewer, degrades under time pressure, and leaves no record anyone can
revisit after an incident.

## What BugDNA does

Assembles that information, scores it, explains the score, and records the
decision it informed.

```
authenticate → connect GitHub → select repository → view PRs → select PR
  → fetch/analyse diff → feature extraction → XGBoost risk prediction
  → risk severity → SHAP-based explanation → recommendations → merge decision
```

Plus the views that make it a product rather than a script: repository health
analytics, team dashboards, notifications, global search, and a deployment
timeline.

## Who it is for

| User | What they need | Where they spend time |
|---|---|---|
| **Individual developer** | "Is this safe to merge, and if not, what do I do?" | PR list → analysis detail → merge decision |
| **Startup engineering team** | Shared visibility, no per-person setup | Teams, shared repositories, notifications |
| **Engineering manager** | Trends, recurring patterns, override rates | Team dashboard, repository health, timeline |

## Jobs to be done

1. **Triage.** Given twenty open PRs, which needs attention first?
   → PR list annotated with risk and sortable by it; dashboard "needs attention"
   panel above everything else.
2. **Understand.** Why does it think that?
   → SHAP factors in plain language, each linked to the files that caused it.
3. **Act.** What do I do about it?
   → Recommendations tied to the specific signals detected, never generic.
4. **Decide and record.** Merge, block or defer — with a reason when overriding.
   → Merge-readiness panel; decision persisted against the analysis.
5. **Improve.** What keeps going wrong?
   → Recurring risk factors, test-discipline trend, override rate.
6. **Correlate.** Did shipped risk actually track our incidents?
   → Deployment timeline with a deliberately hedged correlation panel.

## Requirements met

| Requirement | Implementation |
|---|---|
| GitHub auth, repo/PR/diff retrieval | `modules/github` — fetch-based client, ETag caching, rate-limit handling |
| Async analysis, never blocking HTTP | BullMQ worker; `202` + Socket.io status |
| Feature extraction, extensible | `features/registry.ts` → generated contract |
| XGBoost prediction | separate `ml-service` |
| SHAP explainability, developer-readable | `explain/explain.ts` |
| Recommendations tied to detected risk | `recommend/rules.ts`, 19 rules with `when` predicates |
| Merge-readiness / decision view | `merge-decision.tsx` |
| History + comparison over time | `/analyses`, `/analyses/compare` |
| Repository health analytics | `/repositories/[id]` |
| Team dashboards | `/teams/[id]` |
| Notifications, realtime | `notification.service.ts` + Redis bus + Socket.io |
| Global search | `/search` API, command palette (⌘K) |
| Deployment timeline | `/timeline` |
| Loading / empty / error / retry states | `components/states.tsx`, driven by the API's `retryable` flag |
| Tenancy isolation | `repository.access.ts`, one predicate |
| Structured logging, env config, Docker, CI, Nginx, EC2 | `infra/`, `.github/workflows/` |

## Explicitly out of scope

- **Blocking merges.** BugDNA informs; it does not gate. A tool that vetoes a
  merge on the strength of a probability gets switched off within a week.
- **Reviewing code semantics.** It reasons about the *shape* of a change, not
  whether the logic is correct.
- **Ranking developers.** The model assesses changes, not people.
- **Claiming accuracy without measurement.** See [ML_MODEL.md](ML_MODEL.md).

## Success criteria

| | Target | Actual |
|---|---|---|
| A docs typo scores materially below a destructive migration | >20 point gap | **55 points** (17 vs 72) |
| Acting on the advice measurably lowers the score | any reduction | yes — asserted in the test suite |
| Every factor traceable to files in the diff | all applicable | yes, via `evidence` |
| Analysis never blocks a request | `202` in <100ms | yes |
| No unmeasured accuracy claim anywhere in the product | zero | yes — CI asserts it |
