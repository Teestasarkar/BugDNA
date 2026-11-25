<div align="center">

# PR Risk Radar

**Pre-merge defect risk for GitHub pull requests, learned from real history and explained with SHAP.**

Scores a pull request before it merges, names the three factors pushing its risk up, and says what to do about
each. The model is XGBoost trained on 18,000 merged PRs from 45 open-source repositories, labelled by tracing
later bug fixes back to the PRs whose lines they had to change (SZZ).

</div>

---

## Results

<!-- results:start -->

**18,000 pull requests from 45 repositories; 21.7% labelled defect-inducing.** Test split = the newest 20% of every repository (3,600 PRs, merged 2023-04-10 to 2025-08-31), never used for training, tuning or threshold selection.

| Held-out test | Value |
|---|---|
| ROC-AUC | **0.783** |
| PR-AUC (base rate 0.185) | **0.519** |
| **Balanced mode** (threshold = max F1 on validation): defect-causing PRs caught | **62.7%** (417 of 665) |
| Balanced mode: precision | **38.6%** (flags 30.0% of PRs) |
| **High-recall mode** (threshold catching 80% of validation defects): caught | **79.4%** (528 of 665) |
| High-recall mode: precision | **31.0%** (flags 47.3% of PRs) |
| Recall when reviewing only the riskiest 20% | 50.1% |
| Precision among the riskiest 10% | 62.5% (3.4x base rate) |
| ROC-AUC on repositories never seen in training (5-fold, grouped by repo) | 0.793 ± 0.005 |

| Same test split | ROC-AUC | PR-AUC |
|---|---|---|
| Random | 0.500 | 0.185 |
| Lines changed (bigger = riskier) | 0.702 | 0.351 |
| Logistic regression, same 31 features | 0.782 | 0.501 |
| **XGBoost, 31 features** | **0.783** | **0.519** |

Model: 521 trees, depth 2, learning rate 0.05, min child weight 5, L2 10.0, best of 60 configurations by validation ROC-AUC (0.806). Thresholds: balanced 0.270, high recall 0.168.

**Reading these numbers honestly**

- *Most of the signal is in the features, not the model class.* Logistic regression on the same 31 features reaches 0.782 ROC-AUC against XGBoost's 0.783; XGBoost's edge shows more at the top of the ranking (PR-AUC 0.519 vs 0.501). Both clear the lines-changed heuristic (0.702) by a wide margin.
- *The newest PRs had the least time to be found faulty.* The test split's defect rate (18.5%) is below validation's (22.2%), partly because its PRs had fewer months for fixes to land, so some test "false alarms" are probably defects nobody has fixed yet.
- *Precision and recall trade off along one curve.* Both modes are points on the same model's curve, fixed on validation before the test split was scored; a reviewer chooses how many PRs they can afford to look at, not a better model.

Top risk drivers (mean |SHAP| on the test split):

1. Source lines added (`source_lines_added`): 0.629
2. Prior bug fixes (1y) (`prior_fixes_365d`): 0.351
3. Repository fix share (`repo_fix_share`): 0.343
4. Is a bug fix (`is_fix`): 0.202
5. Prior changes (1y) (`prior_changes_365d`): 0.158
6. Lines added (`lines_added`): 0.133
7. Lines deleted (`lines_deleted`): 0.118
8. Author's prior changes (`author_prior_changes`): 0.107

**Model history.** v1 (28 features, 24-configuration grid) and v2 (31 features, 60-configuration random search) were both evaluated on the same test split. Every v2 change was chosen on validation (`training/experiments.py`, `artifacts/experiments.json`), but the test split has now been looked at twice, so treat the v2 figures as slightly optimistic.

| Held-out test | v1 | v2 |
|---|---|---|
| ROC-AUC | 0.773 | 0.783 |
| PR-AUC | 0.507 | 0.519 |
| Caught (balanced mode) | 60.5% | 62.7% |
| Precision (balanced mode) | 39.8% | 38.6% |
| Precision among the riskiest 10% | 60.8% | 62.5% |
| Unseen repositories ROC-AUC | 0.778 | 0.793 |

<details><summary>Per-repository results</summary>

| Repository | PRs | Defect rate | Test PRs | Test ROC-AUC |
|---|---|---|---|---|
| [encode/httpx](https://github.com/encode/httpx) | 400 | 4.5% | 80 | 0.97 |
| [encode/starlette](https://github.com/encode/starlette) | 400 | 7.2% | 80 | 0.64 |
| [encode/uvicorn](https://github.com/encode/uvicorn) | 400 | 7.5% | 80 | 0.88 |
| [fastapi/fastapi](https://github.com/fastapi/fastapi) | 400 | 22.0% | 80 | 0.77 |
| [pydantic/pydantic](https://github.com/pydantic/pydantic) | 400 | 9.2% | 80 | 0.65 |
| [python-poetry/poetry](https://github.com/python-poetry/poetry) | 400 | 20.5% | 80 | 0.81 |
| [astral-sh/uv](https://github.com/astral-sh/uv) | 400 | 9.0% | 80 | 0.79 |
| [astral-sh/ruff](https://github.com/astral-sh/ruff) | 400 | 29.8% | 80 | 0.79 |
| [psf/black](https://github.com/psf/black) | 400 | 18.8% | 80 | 0.82 |
| [python/mypy](https://github.com/python/mypy) | 400 | 15.5% | 80 | 0.72 |
| [aio-libs/aiohttp](https://github.com/aio-libs/aiohttp) | 400 | 21.2% | 80 | 0.83 |
| [PrefectHQ/prefect](https://github.com/PrefectHQ/prefect) | 400 | 17.8% | 80 | 0.62 |
| [mlflow/mlflow](https://github.com/mlflow/mlflow) | 400 | 24.2% | 80 | 0.89 |
| [huggingface/datasets](https://github.com/huggingface/datasets) | 400 | 18.5% | 80 | 0.75 |
| [vitejs/vite](https://github.com/vitejs/vite) | 400 | 22.0% | 80 | 0.68 |
| [vuejs/core](https://github.com/vuejs/core) | 400 | 30.0% | 80 | 0.74 |
| [tailwindlabs/tailwindcss](https://github.com/tailwindlabs/tailwindcss) | 400 | 13.8% | 80 | 0.69 |
| [prettier/prettier](https://github.com/prettier/prettier) | 400 | 8.0% | 80 | 0.78 |
| [eslint/eslint](https://github.com/eslint/eslint) | 400 | 16.8% | 80 | 0.76 |
| [trpc/trpc](https://github.com/trpc/trpc) | 400 | 32.5% | 80 | 0.76 |
| [vercel/swr](https://github.com/vercel/swr) | 400 | 39.8% | 80 | 0.73 |
| [facebook/react](https://github.com/facebook/react) | 400 | 16.5% | 80 | 0.81 |
| [honojs/hono](https://github.com/honojs/hono) | 400 | 32.0% | 80 | 0.60 |
| [excalidraw/excalidraw](https://github.com/excalidraw/excalidraw) | 400 | 43.5% | 80 | 0.88 |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | 400 | 41.8% | 80 | 0.77 |
| [gin-gonic/gin](https://github.com/gin-gonic/gin) | 400 | 13.0% | 80 | 0.47 |
| [caddyserver/caddy](https://github.com/caddyserver/caddy) | 400 | 12.0% | 80 | 0.74 |
| [golangci/golangci-lint](https://github.com/golangci/golangci-lint) | 400 | 17.8% | 80 | 0.72 |
| [tokio-rs/tokio](https://github.com/tokio-rs/tokio) | 400 | 4.0% | 80 | 0.87 |
| [tokio-rs/axum](https://github.com/tokio-rs/axum) | 400 | 10.2% | 80 | 0.70 |
| [nushell/nushell](https://github.com/nushell/nushell) | 400 | 24.8% | 80 | 0.84 |
| [tauri-apps/tauri](https://github.com/tauri-apps/tauri) | 400 | 35.8% | 80 | 0.74 |
| [starship/starship](https://github.com/starship/starship) | 400 | 27.5% | 80 | 0.71 |
| [square/okhttp](https://github.com/square/okhttp) | 400 | 10.0% | 80 | 0.88 |
| [redis/redis](https://github.com/redis/redis) | 400 | 19.8% | 80 | 0.78 |
| [valkey-io/valkey](https://github.com/valkey-io/valkey) | 400 | 15.8% | 80 | 0.90 |
| [getsentry/sentry-python](https://github.com/getsentry/sentry-python) | 400 | 24.2% | 80 | 0.71 |
| [pydantic/pydantic-core](https://github.com/pydantic/pydantic-core) | 400 | 21.8% | 80 | 0.77 |
| [tokio-rs/tracing](https://github.com/tokio-rs/tracing) | 400 | 9.0% | 80 | 0.70 |
| [pmndrs/jotai](https://github.com/pmndrs/jotai) | 400 | 40.5% | 80 | 0.84 |
| [react-hook-form/react-hook-form](https://github.com/react-hook-form/react-hook-form) | 400 | 43.0% | 80 | 0.75 |
| [fastify/fastify](https://github.com/fastify/fastify) | 400 | 25.2% | 80 | 0.75 |
| [TanStack/router](https://github.com/TanStack/router) | 400 | 48.0% | 80 | 0.71 |
| [marimo-team/marimo](https://github.com/marimo-team/marimo) | 400 | 39.0% | 80 | 0.85 |
| [reflex-dev/reflex](https://github.com/reflex-dev/reflex) | 400 | 14.8% | 80 | 0.80 |

</details>

<!-- results:end -->

These numbers come from `artifacts/metrics.json` via `python -m training.report`; none are typed by hand.

### More caveats

- **The label is "a later bug fix changed lines this PR wrote."** It is the standard proxy in just-in-time defect
  prediction (SZZ), not ground truth. Some real defects are never fixed or are fixed by adding code that cannot
  be traced back, so some "clean" PRs are not clean. Precision is therefore a lower bound on how often a flagged
  PR really was problematic.
- **The test set is the future.** Each repository's newest 20% of PRs were held out. Hyperparameters, early
  stopping and the threshold were chosen on the 20% before that. Shuffling PRs randomly would leak a
  repository's own future into training and inflate every metric.
- **Bots and docs-only PRs are excluded.** They cannot be defect-inducing under this labelling, and leaving them
  in would add thousands of easy negatives that make any model look better.
- **"Unseen repositories" is the number for live scoring.** When you score a PR from a repository outside the
  dataset, expect the leave-repos-out figure, not the in-repo test figure.

---

## What it does

```
GitHub PR ──► diff + base-branch history ──► 31 features ──► XGBoost ──► probability
                                                                   │
                                     exact TreeSHAP per feature ◄──┘
                                                │
         % share of risk per feature, top 3 factors + remediation ──► web UI / JSON API
                                                │
         summed across flagged / defect-causing PRs ──► "Risk drivers" dashboard
```

- **Overview dashboard:** held-out ROC and precision-recall curves, comparison with baselines, global SHAP
  importance, per-repository results.
- **PR explorer:** all 18,000 PRs with their score and what actually happened. Filter to *caught*, *missed*,
  *false alarm* or *clean*, and follow links to the fix PRs that SZZ traced.
- **PR detail:** score (a percentile against validation PRs), band, both operating modes, the top 3 risk
  factors each with its **percentage of the PR's risk** and a remediation step, a risk-composition bar, and the
  SHAP breakdown of every feature.
- **Risk drivers:** SHAP summed across a population (flagged, defect-causing, caught or missed PRs, optionally
  one repository). It shows each feature's average share of risk, how many PRs it is the #1 driver for, the
  typical value against the dataset median, and the recommended fix. Each driver links to its PRs in the
  explorer.
- **Analyze a PR:** paste any public GitHub PR URL. The server reads it through the GitHub API, computes the
  same features with the same code used in training, and explains the score.

### Train/serve parity

The live scorer and the offline miner call the same `riskradar.features.compute_features`; only the source of
history differs (a git clone vs. the GitHub REST API). `python -m training.parity_check` re-derives dataset PRs
through the API and diffs every model feature against the mined value. See [Verification](#verification).

---

## How the data was built

| Step | Code | What happens |
|---|---|---|
| Select repos | [`mining/screen.py`](mining/screen.py) | Rule fixed before training: at least 400 eligible squash-merged PRs before the cutoff, and under 10% `Merge pull request` commits. The first 45 qualifying [candidates](mining/candidates.txt) in file order. |
| Read history | [`mining/gitlog.py`](mining/gitlog.py) | First-parent log of the default branch with per-file status and line counts. |
| Pick PRs | [`mining/build_dataset.py`](mining/build_dataset.py) | Squash commits `Title (#123)` by humans that touch source code and merged before **2025-09-01**. The latest 400 per repo. |
| Featurize | [`riskradar/features.py`](riskradar/features.py) | History is replayed oldest-first, so each PR's features see only what existed before it merged. |
| Label | [`mining/szz.py`](mining/szz.py) | For every later bug-fix commit (title keywords, excluding typo/lint/docs/test "fixes"), `git blame -w` the deleted or modified source lines at the fix's parent, honouring `.git-blame-ignore-revs`. A blamed PR is defect-inducing. Fixes are searched through each repository's latest commit at clone time (Nov 2026), so every labelled PR had at least 13 months for its defects to be found and fixed, except in `pydantic/pydantic-core`, whose last commit is from Jan 2026 (at least 4 months). |
| Select features | [`training/experiments.py`](training/experiments.py) | v2 candidates added on top of the original 28 and kept only if dropping them lowered validation ROC-AUC (mean of 3 seeds). 3 of 13 kept. The test split is never loaded. |
| Train | [`training/train.py`](training/train.py) | Per-repo chronological split 60/20/20. 60-configuration random search on validation AUC with early stopping. Two thresholds fixed on validation: max F1 ("balanced") and the highest catching 80% of validation defects ("high recall"). One evaluation on test. |

### The 31 features

| Group | Features |
|---|---|
| Size | lines added, **source lines added**, lines deleted, files changed, deletion ratio, files added, files deleted |
| Diffusion | directories changed, top-level subsystems changed, change entropy, largest file's share of churn |
| Content | source files, test files, test churn ratio, source-changed-without-tests, config files, dependency files, languages |
| Purpose | is a bug fix |
| File history (last 100 changes per file) | prior changes (1y), recent changes (90d), distinct prior authors (1y), prior bug fixes (1y), days since last change |
| Author experience | prior changes in repo, changes in last 90 days, changes in the touched top-level directories, share of files touched before, share of last year's changes to these files |
| Repository context (last 100 changes) | **share that were bug fixes**, **how many landed in the last 30 days** |

Bold = added in v2. Ten other candidates were tried and dropped on validation (`riskradar/features.py`,
`DROPPED_ON_VALIDATION`); they are still computed so the experiment can be re-run.

Review activity (comments, approvals, CI) is deliberately absent. Git history does not record it, and a
pre-merge score that relied on it couldn't be computed before review.

---

## Run it

```bash
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt

# API + built web app on :8000 (uses the committed model in artifacts/)
cd web && npm ci && npm run build && cd ..
uvicorn api.main:app --port 8000
```

For web development, run `npm run dev` in `web/` (port 5173, proxies `/api` to :8000).

Live scoring works without credentials at GitHub's anonymous limit of 60 requests/hour (about 3 PRs). Set
`GITHUB_TOKEN` (a fine-grained token with no permissions is enough for public repos) for 5,000/hour.

Or with Docker:

```bash
docker build -t pr-risk-radar . && docker run -p 8000:8000 -e GITHUB_TOKEN=... pr-risk-radar
```

### Reproduce the dataset and model

Mining needs only git and the standard library; full clones of the 45 repositories are about 4.3 GB.

```bash
# clone each repo in mining/candidates.txt as a bare, single-branch clone into ../clones/<owner>__<name>.git
python -m mining.build_dataset --repos mining/candidates.txt --clones ../clones   # ~1 h for the 45 on 4 cores
python -m mining.screen --clones ../clones          # applies the selection rule, writes mining/repos.txt
python -m mining.assemble                           # -> data/prs.csv.gz, data/repos.json
python -m training.train                            # -> artifacts/
python -m training.report                           # refresh the README results
```

### API

| Method | Path | Returns |
|---|---|---|
| GET | `/api/metrics` | Every evaluation number, curves, importance, feature specs |
| GET | `/api/repos` | Per-repository counts, defect rates and test results |
| GET | `/api/prs?repo=&split=test&outcome=tp\|fp\|fn\|tn&band=&factor=&q=&sort=&limit=&offset=` | Scored PRs with their top risk driver |
| GET | `/api/prs/{owner}/{repo}/{number}` | One dataset PR: features, score, SHAP, % share of risk per feature, top 3 factors |
| GET | `/api/drivers?population=flagged\|defects\|caught\|missed\|all&split=test&repo=` | Risk drivers across a population: average SHAP share, #1/top-3 counts, recommended fix |
| POST | `/api/analyze` `{"url": "https://github.com/o/r/pull/1"}` | Live score for any public PR |
| POST | `/api/score` `{"features": {...}}` | Score a raw feature vector |

Interactive docs at `/docs`.

---

## Verification

- `pytest` covers path classification, fix-title rules, every feature against hand-computed values, the
  git-log parser, **SZZ end to end on a synthetic repository with a known answer**, and the API on a model
  trained from scratch inside the test. It also asserts that SHAP contributions plus the base value reproduce the
  model's log-odds.
- Training cross-checks XGBoost's built-in TreeSHAP against the `shap` package's `TreeExplainer` (max
  difference recorded in `metrics.json`).
- The two speed-ups in SZZ (restricting blame to files a labelled PR touched, and bounding blame at the
  commit before the window) were checked to produce byte-identical labels to the unoptimised run.
- Train/serve parity (`artifacts/parity.json`): four dataset PRs re-scored live through the GitHub API. All diff
  and file-history features matched in all four. Author and repository counts matched in two and differed in
  two, because the API counts commits that reached the branch through occasional merges while training replays
  first-parent history. The score moved by at most 0.001 probability (under 1 percentile point), with the same
  band.

## Repository layout

```
riskradar/   shared by mining, training and serving: features, path rules, SHAP → factors, scoring
mining/      git log parsing, history replay, SZZ, repository screening, dataset assembly
training/    training + evaluation, README report, live/offline parity check
api/         FastAPI app and the GitHub-API-backed feature history
web/         React + TypeScript + Vite dashboard
data/        prs.csv.gz (the labelled dataset), repos.json (per-repo mining stats)
artifacts/   model.json, model_meta.json, metrics.json, predictions.csv.gz
tests/       pytest suite
```

## Limits

- The score estimates whether a later fix will touch this PR's lines. It does not judge code quality, and a low
  score is not a guarantee.
- Only squash-merge repositories are mined, so that a PR is one commit in both git and the API. Repositories
  that use merge commits are scored by the same model, but they are outside its training distribution.
- Live scoring identifies the author by commit e-mail, as training does, but GitHub's commits API also counts
  commits that arrived through merges, so live author-experience counts can run higher than offline ones in
  repositories that occasionally merge branches (see Verification for the measured effect).

## Licence

MIT. The dataset contains public commit metadata (repository, PR number, title, file paths, timestamps); author
e-mails are stored only as truncated SHA-256 hashes.
