# Assumptions

Every assumption BugDNA makes that a reviewer might reasonably question, with the
consequence if it is wrong and where to change it.

---

## 1. The model

| Assumption | Consequence if wrong | Where |
|---|---|---|
| Gradient-boosted trees suit this problem | Features are mostly counts, ratios and booleans with non-linear thresholds — trees handle that well. A neural approach would need far more data for no obvious gain. Swappable behind `POST /v1/predict`. | `ml-service/app/model.py` |
| SHAP is the right explanation method | For a tree ensemble, tree SHAP is exact and additive, so the explanation genuinely accounts for the score. Permutation importance would be global, not per-PR. | `model.py::_explain` |
| The 0–100 score is a linear rescale of the probability | A monotonic curve BugDNA could not explain would make the number less trustworthy, not more. Bands would need recalibrating if this changed. | `routers/predict.py` |
| Bands at 0-34 / 35-59 / 60-79 / 80-100 | **A product decision, not measured.** They are the vocabulary, not a finding. Change in one place and both API and UI follow. | `backend/src/config/constants.ts` |
| No target definition is assumed | Different teams define "risky" differently. Assuming one would bake a choice into the product that belongs to the operator. | `training/train.py --target` |
| **No accuracy is claimed** | The shipped model is synthetic and reports `metrics: null`. Quoting an unvalidated figure would be the most damaging thing this project could do. | [ML_MODEL.md §5](ML_MODEL.md) |

## 2. Features

| Assumption | Consequence if wrong | Where |
|---|---|---|
| The 43 features are a reasonable starting set, not a validated one | Which actually carry signal is empirical and depends on the operator's data. The registry makes adding or removing one a three-line change. | `features/registry.ts` |
| Module = first meaningful path segment, skipping `src`/`lib`/`app` | An unconventional monorepo layout produces misleading module counts, so blast radius is over- or under-stated. | `features/classify.ts::moduleOf` |
| Regex path classification is adequate | A project with unusual conventions may have tests or migrations misclassified. Patterns are data in `constants.ts`, so a new ecosystem is a regex, not a code change. | `config/constants.ts::PATH_PATTERNS` |
| Diff-text patterns detect destructive SQL, auth changes and removed error handling | Pattern matching over patches, not parsing. False positives are possible; the UI shows the evidence files so a reviewer can judge. | `PATCH_PATTERNS` |
| History needs ≥3 prior PRs in 30 days to be meaningful | Below that, history features return documented neutral values and the analysis records a degradation. Better than a confident number from two data points. | `features/extract.ts` |
| Model output is never a feature | Feeding a prior score back in would create a self-confirming loop. | by construction |

## 3. GitHub

| Assumption | Consequence if wrong | Where |
|---|---|---|
| OAuth App, not GitHub App | No webhooks and coarser permissions, so analysis is user-triggered rather than automatic. The provider interface makes an App swappable. | `github.types.ts::GitHubProvider` |
| The `repo` scope will be granted | Without it, private repositories are invisible and their diffs unreadable. Detected and stated explicitly on the connect screen rather than failing later. | `auth.service.ts` |
| 300 files per PR is enough | Beyond it, `truncated` is set and recorded as a degradation. GitHub's own cap is 3000. | `GITHUB_MAX_FILES_PER_PR` |
| 120 KB per patch is enough for reviewer context | Larger patches are cut on a line boundary and flagged. Diffs are stored for context, not archival. | `GITHUB_MAX_PATCH_BYTES` |
| The requester's token fetches the diff | They demonstrably have access, and it attributes API usage to the person who asked. A team member analysing a colleague's PR uses their own quota. | `analysis.service.ts` |
| Deployment ↔ PR linkage by SHA match | Matches merge commit first, then head. A squash-merge with a rewritten SHA will not link, and the deployment shows unlinked rather than wrongly attributed. | `timeline.service.ts` |

## 4. Data and tenancy

| Assumption | Consequence if wrong | Where |
|---|---|---|
| Repository is the tenancy root | Every user-owned row hangs off one, so one predicate covers the subtree. A future resource that does not would need its own rule — and the pattern makes that obvious. | `repository.access.ts` |
| Team membership grants full read | No per-repository ACLs within a team. Finer control would need a `RepositoryCollaborator` join table. | schema |
| Unauthorised reads return 404 | Deliberate. A 403 confirms existence. | `repository.access.ts` |
| Analyses are append-only | Re-analysing creates a new row, so history is preserved and risk is comparable over time. Costs storage. | schema |
| Disconnecting a repository is non-destructive | Analyses are evidence; deleting a team's risk history because someone unticked a repository would be surprising. Rows accumulate. | `repository.service.ts` |
| BigInt GitHub ids serialise as strings | They exceed `Number.MAX_SAFE_INTEGER`; a number would silently lose precision. | `lib/serialize.ts` |

## 5. Operations

| Assumption | Consequence if wrong | Where |
|---|---|---|
| Redis may be lost | Everything is reconstructible except in-flight queue jobs, which strand as `RUNNING` and can be re-queued. | [Architecture §Redis](Architecture.md) |
| The risk service is not required for readiness | The app stays usable for browsing while it restarts; failing readiness would pull the whole deployment. Reported as `degraded`. | `system.routes.ts` |
| One instance applies migrations | The API does, exactly once. Two replicas would race. | `docker-compose.prod.yml` |
| 2 vCPU / 2 GB is enough | SHAP + XGBoost is the memory-hungriest part. 1 GB works with swap; `ANALYSIS_CONCURRENCY` is the lever. | [DEPLOYMENT.md](DEPLOYMENT.md) |
| `NEXT_PUBLIC_*` at build time | Changing the API URL needs a rebuild, not a restart. Avoids a runtime config fetch on every page load. | `frontend/Dockerfile` |
| Demo login is safe to expose | The demo user owns only seeded synthetic repositories, and the tenancy predicate isolates it like any other account. `ENABLE_DEMO_LOGIN=false` removes it. | `auth.service.ts` |

## 6. Product

| Assumption | Consequence if wrong | Where |
|---|---|---|
| **BugDNA must not block merges** | A tool that says "you may not merge this" on the strength of a probability gets switched off within a week. It states the assessment and records the decision. | `merge-decision.tsx` |
| A justification is required to override HIGH/CRITICAL | Mild friction on exactly the decision a team will want to re-read after an incident. | `analysis.service.ts` |
| Recommendations must be caused by a detected signal | "Consider adding tests" on every PR is noise that trains people to ignore the tool. Every rule declares a `when` predicate and its triggering feature keys. | `recommend/rules.ts` |
| Protective factors are shown alongside problems | A view listing only what is wrong makes a LOW score feel arbitrary. | `risk-factors.tsx` |
| Contributors are not ranked | The model assesses changes, not people; average risk mostly reflects the kind of work someone happens to be doing. A "riskiest developers" leaderboard would be unkind and unsupported. | `teams/[id]/page.tsx` |
| The health score is a heuristic and says so | Shown with its component breakdown and a confidence level, shrunk toward 100 on thin evidence. | `analytics.service.ts` |
| Correlation is not causation | The timeline reports observed association with sample sizes, and refuses to interpret below three samples per side. | `timeline.service.ts` |

---

## What would change first with real usage

Honest ordering, if this went past a demo:

1. **Train on real labelled outcomes.** Everything about the model's usefulness
   is downstream of this. Until then the ranking is defensible and the absolute
   probabilities are not.
2. **A GitHub App with webhooks**, so analysis happens on PR open rather than on
   a click.
3. **Calibration monitoring** — track Brier score over time against reported
   outcomes, and surface drift.
4. **Per-repository thresholds.** A 400-line PR is unremarkable in some
   codebases and an outlier in others; `churn_vs_repo_median` partly captures
   this, but the bands themselves are global.
5. **Feature-importance feedback.** If `module_incident_history` never predicts
   anything for a given team, say so rather than continuing to show it.
