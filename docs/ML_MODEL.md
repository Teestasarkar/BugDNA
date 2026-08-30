# The risk model

This is the document to read before trusting a number BugDNA shows you.

It states exactly what the model is, what it is trained on, what it does **not**
know, and which parts of the system are learned versus decided. If you are
evaluating BugDNA, the claims here are the ones to challenge.

---

## 1. The short version

| | |
|---|---|
| **Algorithm** | XGBoost gradient-boosted decision trees (`binary:logistic`) |
| **Explainability** | SHAP `TreeExplainer` — exact tree SHAP, not an approximation |
| **Features** | 43, all derived from GitHub data or user-reported outcomes |
| **Serving** | A separate Python/FastAPI service, called over HTTP by the Node API |
| **Out-of-the-box model** | Fitted on **synthetic** data, marked `synthetic: true`, reports **no accuracy metrics** |
| **Accuracy claim** | **None**, until you train on your own labelled outcomes |

The last two rows are the important ones and are elaborated in §5.

---

## 2. What is learned and what is decided

A recurring source of confusion in risk products is presenting a product
decision as a model output. BugDNA keeps the line explicit:

| Component | Learned or decided | Where it lives |
|---|---|---|
| Probability that a PR is risky | **Learned** | XGBoost model |
| Which features drove that probability | **Learned** (SHAP over the model) | `ml-service/app/model.py` |
| The 0–100 score | **Decided** — a linear rescale of the probability | `ml-service/app/routers/predict.py` |
| LOW / MODERATE / HIGH / CRITICAL bands | **Decided** — 0-34 / 35-59 / 60-79 / 80-100 | `backend/src/config/constants.ts` |
| Which recommendations to show | **Decided** — declarative rules over detected factors | `backend/src/modules/analysis/recommend/rules.ts` |
| Repository health score | **Decided** — a stated weighted formula | `backend/src/modules/analytics/analytics.service.ts` |
| The fallback score when no model is loaded | **Decided** — additive weights from the feature contract | `ml-service/app/heuristic.py` |

Everything in the "decided" column is visible in the UI as such. The health
score shows its component breakdown; the bands are listed on the methodology
page; a heuristic-scored analysis is labelled on every surface that displays it.

---

## 3. Features

All 43 are declared in [`contracts/feature-spec.json`](../contracts/feature-spec.json),
generated from the TypeScript registry at
`backend/src/modules/analysis/features/registry.ts`. The methodology tab in
Settings renders the whole catalogue with descriptions.

### Three rules the feature set obeys

**1. Every feature comes from data that actually exists.** Each one is computed
from the GitHub PR payload, the changed-file diff, or a deployment outcome a
human reported. There is no "code complexity score", no "developer seniority",
no static-analysis metric BugDNA does not compute. If a signal would require a
data source the product does not have, it is not in the set.

**2. Model output is never fed back in as a feature.** Using a previous risk
score as an input would create a loop where the model confirms its own history.
Repository history is expressed through observable facts instead — median PR
size, deployment failure rate, whether past *reported incidents* touched the
same modules.

**3. Missing history is disclosed, not fabricated.** Six features need BugDNA to
have observed a repository for a while. On a freshly connected repo they fall
back to a documented neutral value, and the analysis records a degradation
reason the UI displays. Silently substituting `0` would make "no history" look
identical to "zero prior incidents".

### Categories

| Category | Count | Examples |
|---|---|---|
| Change shape | 10 | `total_churn`, `files_changed`, `deletion_ratio`, `max_file_churn` |
| Change type | 9 | `touches_tests`, `test_to_source_ratio`, `docs_only_change`, `removes_error_handling` |
| Dependency | 3 | `dependency_manifest_changed`, `lockfile_churn` |
| Data layer | 2 | `migration_files_changed`, `has_destructive_sql` |
| API contract | 4 | `touches_public_api`, `touches_auth_or_secrets` |
| Blast radius | 4 | `modules_touched`, `max_module_concentration`, `languages_touched` |
| Process | 5 | `has_description`, `review_comments_count`, `pr_age_hours` |
| Repository history | 4 | `churn_vs_repo_median`, `module_incident_history`, `repo_deployment_failure_rate_90d` |
| Author context | 2 | `author_module_familiarity`, `author_pr_count_90d` |

### Adding a feature

Three steps, and a guard that fails loudly if you miss one:

1. Add a `FeatureSpec` to `registry.ts`.
2. Compute it in `extract.ts`.
3. Bump `FEATURE_SET_VERSION` in `constants.ts`, then run
   `npm run contracts:generate` in `backend/` and commit the result.

`assertVectorMatchesRegistry` throws on the first analysis if the extractor and
registry disagree, and CI fails if the committed contract is stale. The two
services cannot silently drift.

---

## 4. The target definition is yours

**BugDNA does not assume what "risky" means.** That is a genuine product
decision with real consequences, and different teams will answer differently:

- "was implicated in a production incident within 7 days of merge"
- "required a revert or a hotfix"
- "triggered a rollback"
- "caused a SEV1 or SEV2"

Each implies a different model. `training/train.py --target <column>` names the
column; the choice is recorded in the artifact metadata so a model can always be
traced back to what it was actually predicting.

The closest thing BugDNA collects natively is the **deployment outcome** a user
reports on the timeline (`causedIncident`, plus a severity). That is deliberately
human-reported: inferring an incident from telemetry BugDNA cannot see would be
a fabrication.

---

## 5. What ships out of the box, and why it makes no accuracy claim

A fresh install has no labelled data. The options were: fail every analysis, or
serve something honest and clearly labelled. BugDNA does the second, in two
layers.

### Layer 1 — the bootstrap model

`training/generate_bootstrap_dataset.py` samples plausible feature vectors and
labels them by passing each through **the same documented heuristic weights the
fallback scorer uses**, plus Gaussian noise. The consequence, stated plainly:

> A model trained on this data learns to approximate BugDNA's stated heuristic.
> It does not learn anything about real-world failures.

That is a deliberate choice, not a shortcut. It means the bootstrap model is:

- **consistent** with the documented weights, so scores are explainable and
  stable rather than arbitrary;
- **honest** — the artifact is marked `synthetic: true` and its `metrics` field
  is `null`, so `/v1/model/info` and the Settings page report no accuracy;
- **replaceable** — supply `--data` with real outcomes and this file is
  irrelevant.

Holdout numbers from the synthetic split *are* recorded, under a separate
`syntheticHoldout` key, purely so a developer can confirm training worked. They
measure how well the model reproduces the heuristic — not how well it predicts
incidents. CI asserts this separation holds (`ci.yml`, job `ml-service`).

### Layer 2 — the heuristic fallback

If no artifact loads at all, `app/heuristic.py` scores instead. It is an
**additive linear model over normalised features**, which has one property that
matters here: because the model is a sum of per-feature terms, those terms *are*
its attributions. There is no approximation, so the explanation UI needs no
special case, and the additive identity is asserted in the test suite:

```
BASE_LOG_ODDS + sum(attributions) == logit(probability)
```

Its weights come from `heuristicWeight` in the shared contract — visible in a
committed JSON file rather than buried in a binary. They encode ordinary
engineering judgement (a destructive migration is riskier than a docs typo) and
are explicitly **not** a claim about measured predictive importance.

Every response it produces reports `engine: "heuristic"`, the backend records
`scoredBy: HEURISTIC`, and the UI states it on the analysis page, the badge and
the merge panel.

### The calibration constant

`LOG_ODDS_SCALE = 4.5` in `heuristic.py` divides the summed weights before the
sigmoid. It exists because the raw sum for a genuinely alarming PR reaches ~+27
log-odds, where the sigmoid is numerically saturated — every high-risk change
would collapse to exactly 100 and lose all resolution. That would break the
product's central loop: a developer who acts on the recommendations would see
the score stay pinned.

It is a presentation constant. It changes the *spread* of scores, never their
order.

---

## 6. Training on your own data

```bash
cd ml-service

# One row per historical pull request: the 43 contract columns plus a binary
# outcome column of your choosing.
python -m training.train \
  --data data/history.csv \
  --target caused_incident \
  --version 2.0.0

# Pick it up without a restart
curl -X POST localhost:8000/v1/model/reload -H "x-internal-token: $ML_SERVICE_TOKEN"
```

Missing feature columns are a **hard error**, not silently filled: training on a
subset produces a model whose vector layout does not match what the service
sends, and the mismatch surfaces as quietly wrong scores rather than a failure.

When trained on real data, `metrics` is populated from a stratified holdout and
reported everywhere the model is described:

| Metric | Why it is included |
|---|---|
| `rocAuc` | Ranking quality, threshold-independent |
| `averagePrecision` | More informative than AUC when positives are rare |
| `brierScore` | **Calibration** — directly measures whether a "70" means 70% |
| `precisionAt50` / `recallAt50` / `f1At50` | The operating point actually used. A model that flags everything has perfect recall and is useless |
| `logLoss` | Optimisation target |
| `positiveRate`, `holdoutRows` | Context without which the rest is uninterpretable |

Hyperparameters default to conservative settings for a few-thousand-row tabular
problem (shallow trees, low learning rate). They are **not** tuned against any
benchmark, are recorded in the artifact metadata, and are overridable with
`--params '{"max_depth": 5}'`.

---

## 7. Guardrails

Things the service refuses to do quietly:

| Situation | Behaviour |
|---|---|
| Feature vector width does not match the trained model | Load is refused; falls back to the heuristic with a logged reason, or 503 if the fallback is disabled |
| Caller's feature-set version differs from the service's | Scores anyway, aligned by key, with a warning in the response |
| A feature is missing from the request | Uses the documented neutral value, reports it in `warnings` |
| A feature is unrecognised | Ignored, reported in `warnings` |
| A feature is `NaN` or infinite | Replaced with the fallback, reported |
| No feature contract found | Runs in permissive mode with alphabetical ordering, and says so |
| `ML_SERVICE_TOKEN` unset in production | **Refuses to start** |
| SHAP package unavailable | Falls back to XGBoost's built-in `pred_contribs`, which is numerically equivalent |

---

## 8. What this model cannot do

Stated plainly, because a risk tool that oversells itself is worse than none:

- **It has not read your code.** It reasons about the *shape* of a change —
  size, spread, what kind of files, what the diff text pattern-matches — not
  about program semantics. It cannot tell you the logic is wrong.
- **It does not know your architecture.** "Blast radius" is inferred from
  directory structure. A monorepo with unconventional layout will produce
  misleading module counts.
- **It cannot see your tests pass.** `touches_tests` means a test file changed,
  not that coverage improved or CI is green.
- **It has no model of your users or traffic.** A change to a code path nobody
  executes scores the same as one on the checkout flow, unless module incident
  history happens to distinguish them.
- **Its absolute probabilities are not calibrated** until trained and validated
  on your data. Treat the *ranking* as the useful output before then.
- **Correlation is not causation.** The timeline reports observed association
  between shipped risk and incidents, with sample sizes, and refuses to
  interpret below three samples per side.

---

## 9. Files

| Path | Purpose |
|---|---|
| `contracts/feature-spec.json` | The shared contract — generated, committed, read by both services |
| `backend/src/modules/analysis/features/registry.ts` | Authoritative feature declarations |
| `backend/src/modules/analysis/features/extract.ts` | Computes the vector |
| `backend/src/modules/analysis/features/classify.ts` | Path and patch classification |
| `backend/src/modules/analysis/explain/explain.ts` | SHAP values → developer-facing factors |
| `backend/src/modules/analysis/recommend/rules.ts` | Factor-triggered recommendations |
| `ml-service/app/features.py` | Loads the contract, aligns incoming vectors |
| `ml-service/app/model.py` | Artifact loading, inference, SHAP |
| `ml-service/app/heuristic.py` | Transparent fallback scorer |
| `ml-service/training/train.py` | Training entry point |
| `ml-service/training/generate_bootstrap_dataset.py` | Synthetic bootstrap data |
| `ml-service/tests/test_scoring.py` | Behavioural guarantees |

---

## 10. The tests that matter

`ml-service/tests/test_scoring.py` asserts behavioural properties rather than
implementation details, and CI runs the whole suite **twice** — once against the
heuristic and once against a trained XGBoost model — because both engines must
satisfy the same contract.

The ones worth knowing about:

- a docs-only change scores **more than 20 points below** a destructive
  migration with no tests;
- **adding test coverage reduces the score** — the product's central promise;
- attributions are **exactly additive** for the heuristic;
- protective factors are reported, not just problems;
- a partial feature vector degrades with a warning rather than producing a
  confident wrong answer;
- a synthetic or absent model **reports no accuracy metrics**;
- scoring is **deterministic** — the same commit always produces the same score.

Measured spread across the seeded demo tenant, with the shipped bootstrap model:

| Change | Score | Band |
|---|---|---|
| Documentation typo | 17 | LOW |
| Well-tested feature | 18 | LOW |
| Dependency bump | 21 | LOW |
| Large refactor, no tests | 55 | MODERATE |
| Auth relaxation, no tests | 45 | MODERATE |
| Destructive migration, no tests | 72 | HIGH |
| …with tests added | 70 | HIGH |

Those are real numbers from the shipped artifact, not illustrations. The
heuristic produces a wider spread (8 → 88) because it is not shrunk by label
noise.
