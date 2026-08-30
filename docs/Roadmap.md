# Roadmap

## Built

| Area | State |
|---|---|
| GitHub OAuth, encrypted token storage, session revocation | done |
| Repository connect / sync / disconnect (non-destructive) | done |
| PR discovery, diff ingestion with classification | done |
| 43-feature extraction with a generated cross-language contract | done |
| XGBoost scoring in a separate FastAPI service | done |
| SHAP explanations → developer-facing factors with file evidence | done |
| 19 recommendation rules, each triggered by a detected signal | done |
| Merge-readiness view + recorded decision with forced justification | done |
| Async pipeline: BullMQ worker, Socket.io progress, polling fallback | done |
| Analysis history and two-analysis comparison | done |
| Repository health analytics with a stated formula | done |
| Team dashboards including override rate | done |
| Notifications, realtime, unread badge | done |
| Global search + ⌘K command palette | done |
| Deployment timeline with hedged correlation panel | done |
| Tenancy isolation in one predicate; 404-not-403 | done |
| Docker Compose (dev + prod), Nginx, EC2 scripts, GitHub Actions | done |
| 24 ML behavioural tests; CI e2e asserting the engine discriminates | done |

## Next, in order of value

**1. Train on real outcomes.** Everything about the model's usefulness is
downstream of this. The pipeline, the contract and `train.py --data` are ready;
what is missing is labelled history. Until then the *ranking* is defensible and
the absolute probabilities are not.

**2. GitHub App with webhooks.** Analysis would happen on PR open rather than on
a click, which is what makes the product ambient rather than a thing you
remember to visit. Needs a public callback URL, signature verification and an
installation flow — real work, deliberately deferred because it is orthogonal to
proving the risk pipeline.

**3. Calibration monitoring.** Track Brier score over time against reported
outcomes and surface drift. A model that quietly stops being calibrated is worse
than no model, because people still trust it.

**4. Per-repository thresholds.** A 400-line PR is unremarkable in some
codebases and an outlier in others. `churn_vs_repo_median` partly captures this,
but the bands themselves are global.

**5. Feature-importance feedback.** If `module_incident_history` never predicts
anything for a given team, say so rather than continuing to display it.

## Considered and rejected

| Idea | Why not |
|---|---|
| Blocking merges via a required status check | A tool that vetoes merges on a probability gets disabled within a week. BugDNA informs and records. |
| Ranking developers by average risk | The model assesses changes, not people. Average risk mostly reflects what work someone happens to be doing. |
| LLM-generated explanations | SHAP attributions are exact and auditable. A generated paragraph is neither, and would be the easiest place to introduce a plausible-sounding falsehood. |
| Static analysis integration | A different product. BugDNA reasons about change shape; a linter reasons about code. |
| Storing full diffs indefinitely | Patches are truncated to 120 KB. They are for reviewer context, not archival — GitHub already has the blob. |

## Known limitations

Stated in full in [ASSUMPTIONS.md](ASSUMPTIONS.md) and [ML_MODEL.md §8](ML_MODEL.md).
The short list:

- The model has not read the code — it reasons about the shape of a change.
- Module inference is directory-based and will mislead on unconventional layouts.
- `touches_tests` means a test file changed, not that coverage improved.
- Sorting a PR list by risk sorts the current page, not the whole set.
- Losing Redis mid-flight strands in-flight analyses as `RUNNING`.
- No email transport, so team invites require the person to have signed in once.
