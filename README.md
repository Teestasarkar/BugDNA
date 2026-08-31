<div align="center">

# BugDNA

**Pre-deployment risk intelligence for GitHub pull requests.**

Reads a pull request's diff before it merges, estimates the chance it causes a
production problem, explains why in language a developer can act on, and records
what you decided.

**[bugdna.vercel.app](https://bugdna.vercel.app)** &nbsp;·&nbsp;
[API](https://bugdna-api.onrender.com/api/v1/system/ready) &nbsp;·&nbsp;
[Risk service](https://bugdna-ml.onrender.com/docs)

</div>

> The live deployment runs on free tiers: **Vercel** (web), **Render** (API and
> risk service), **Neon** (Postgres), **Render Key Value** (Redis). Render free
> services sleep after ~15 minutes idle, so the first request can take 30-50s
> while two containers cold-start — the risk service loads an XGBoost model and
> builds a SHAP explainer on boot. Open the two links above first and let them
> wake before using the app. It also differs from the documented production
> topology in two ways, both deliberate and both noted in
> [`infra/paas/render.yaml`](infra/paas/render.yaml): the analysis worker runs
> inside the API process, and the risk service is publicly routable behind a
> shared-secret header rather than network-isolated.

---

## What it actually does

```
GitHub auth → repository → PR discovery → diff ingestion → feature extraction
   → XGBoost risk score → severity band → SHAP explanation → recommendations
   → merge decision → repository health → team rollups → deployment timeline
```

That whole chain is implemented and runs end to end. Not a demo classifier with
a dashboard bolted on — the score is produced by a real gradient-boosted model
in a separate Python service, the explanation is real tree SHAP, and every
recommendation is triggered by a specific signal found in your diff.

### What it actually scores

Read off the live deployment, seeded tenant, shipped model — one row per
distinct pull request, lowest first:

| Change | Score | Band |
|---|---|---|
| Remove an N+1 query | 17 | LOW |
| Batch invoice line loading | 18 | LOW |
| Mid-cycle subscription upgrades | 23 | LOW |
| Hotfix: double-charging on retried webhooks | 25 | LOW |
| Simplify auth middleware | 29 | LOW |
| Documentation typo | 31 | LOW |
| Relax role checks during a rollout | 35 | MODERATE |
| Drop a legacy audit table | 37 | MODERATE |
| Consolidate payment columns (breaking) | 38 | MODERATE |
| Upgrade stripe and pg | 50 | MODERATE |
| Extract a retry policy from callers | 55 | MODERATE |

Two things that table is honest about, and both matter more than the numbers:

**The spread is real but the ordering is not validated.** Scores span 17 to 55
— the pipeline clearly separates a query optimisation from a large refactor. But
a documentation typo at 31 outranks a webhook hotfix at 25, and a dependency
bump at 50 outranks a destructive migration at 37. That is not a defensible
ranking of production risk. It is what a model fitted on **synthetic** data
produces, which is exactly why `/v1/model/info` reports `metrics: null` and why
the product never claims an accuracy figure. Train on real deployment outcomes
and this table becomes meaningful; until then it demonstrates that the machinery
works, not that the judgement does.

**Nothing here reaches HIGH or CRITICAL,** because nothing in the fixtures
earns it. The bands are a product decision (60+ and 80+); the model is not
tuned to reach them on this data, and inflating the fixtures to produce a red
badge for a screenshot would be the exact dishonesty this project is meant to
avoid.

---

## Quick start

```bash
git clone https://github.com/Teestasarkar/BugDNA.git
cd BugDNA

cp .env.example .env          # works as-is; see below to add GitHub OAuth
docker compose up --build
```

Then:

| | |
|---|---|
| Web app | http://localhost:3000 |
| API | http://localhost:4000/api/v1 |
| Risk service docs | http://localhost:8000/docs |

On first boot the risk service trains a bootstrap model (~60s), so predictions
come from genuine XGBoost inference with genuine SHAP attributions rather than a
fallback.

### Seed a demo tenant

```bash
docker compose exec api npx tsx prisma/seed.ts
```

Creates 3 repositories, 24 pull requests with real diffs, ~24 analyses **run
through the actual pipeline**, deployments, incidents, merge decisions and
notifications. Then sign in at `/login` → **View the demo**.

### Run without any GitHub credentials

```bash
# in .env
GITHUB_MODE=mock
```

Serves deterministic fixtures instead of `api.github.com`. The entire workflow —
sign-in, repository selection, PR discovery, diff ingestion, scoring,
explanation — runs offline. This is also what CI uses.

---

## Architecture

```
                    ┌──────────────┐
                    │    Nginx     │  :80/:443 — the only public ingress
                    └──────┬───────┘
              ┌────────────┴────────────┐
              │                         │
      ┌───────▼────────┐       ┌────────▼─────────┐
      │  web           │       │  api             │
      │  Next.js 15    │──────▶│  Express 5       │
      │  React 19      │  REST │  Prisma          │
      │  TanStack+     │   +WS │  Socket.io       │
      │  Zustand       │       └───┬────────┬─────┘
      └────────────────┘           │        │
                          ┌────────▼──┐  ┌──▼─────────┐
                          │ postgres  │  │  redis     │
                          │ system of │  │  cache +   │
                          │  record   │  │  BullMQ    │
                          └───────────┘  └──▲─────────┘
                                            │
                          ┌─────────────────┴──┐
                          │  worker            │  runs the pipeline
                          │  (same image)      │
                          └─────────┬──────────┘
                                    │ HTTP (internal only)
                          ┌─────────▼──────────┐
                          │  ml-service        │
                          │  FastAPI           │
                          │  XGBoost + SHAP    │
                          └────────────────────┘
```

Four decisions worth knowing:

**The worker is a separate process.** A single analysis makes several GitHub
round trips plus an inference call and can take tens of seconds. It never runs
inside an HTTP request. Status is pushed over Socket.io, with HTTP polling as a
fallback for clients whose websocket is blocked.

**The worker reaches browsers via a Redis pub/sub bus.** The socket is held by
an API process, not the worker, so progress events are published onto Redis and
every API instance fans them out to its own rooms. That also makes the API
horizontally scalable for free.

**Redis is never the source of truth.** Cache, transient analysis state and
queue coordination only. Every key is reconstructible from Postgres, so a
flushed Redis costs latency, not data.

**The ML service holds all model logic.** The Node backend sends a feature
vector and receives a score plus attributions. There is deliberately **no**
shadow scorer in the backend — if the risk service cannot answer, the analysis
retries and then fails honestly rather than silently substituting a different
method.

---

## Tenancy

The isolation rule lives in exactly one file
([`repository.access.ts`](backend/src/modules/repositories/repository.access.ts)):

```
a user may read a repository if they connected it,
or if it belongs to a team they are a member of
```

Pull requests, diffs, analyses, risk factors, recommendations, deployments and
health snapshots are all children of a repository, so authorising the repository
authorises the subtree. Controllers call an `assert*` helper and then query
freely — they never hand-roll an ownership check, because one forgotten `where`
clause is how cross-tenant leaks happen.

Unauthorised reads return **404, not 403**: confirming that a private repository
exists is itself a leak. The Socket.io layer authorises room joins through the
same predicate, so realtime is not a hole around REST.

---

## Honesty about the model

Read [`docs/ML_MODEL.md`](docs/ML_MODEL.md) — it is the document to challenge.

The short version:

- The **algorithm** is XGBoost; the **explanation** is exact tree SHAP.
- The **43 features** are all derived from data GitHub actually returns, or from
  deployment outcomes a human reported. No invented metrics.
- Model output is **never** fed back in as a feature.
- The model that ships is fitted on **synthetic** data, is marked
  `synthetic: true`, and reports `metrics: null`. **BugDNA quotes no accuracy
  figure it has not measured.** Train on your own labelled outcomes to get
  metrics that mean something.
- When no model artifact is loaded, a **transparent additive scorer** takes over
  and every surface says so. Its attributions are exactly additive, not
  approximate.
- The 0–100 score, the four bands, the recommendation rules and the health score
  are **product decisions**, not model outputs, and are labelled as such.

---

## Repository layout

```
backend/          Express 5 + Prisma + Socket.io + BullMQ   (58 files, ~16k lines)
  prisma/         schema (16 models, 18 enums) + seed
  src/modules/    auth, github, repositories, pulls, analysis, ml,
                  analytics, teams, notifications, search, timeline, system
  src/queue/      BullMQ queue + the analysis worker
  src/realtime/   Socket.io server + cross-process Redis bus

ml-service/       FastAPI + XGBoost + SHAP
  app/            contract loading, model, heuristic fallback, routers
  training/       bootstrap data generator + training entry point
  tests/          24 behavioural tests

frontend/         Next.js 15 + React 19 + Tailwind v4
  src/components/ 17 UI primitives, risk views, charts, diff viewer, app shell
  src/app/        16 routes

contracts/        feature-spec.json — generated, committed, read by both services
infra/            nginx, EC2 scripts, postgres init
docs/             the documents worth reading
.github/          CI + deploy workflows
```

---

## Development

```bash
# Backend
cd backend
npm install
npx prisma migrate dev
npm run dev              # API on :4000
npm run dev:worker       # worker, separate terminal

# Risk service
cd ml-service
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
python -m training.generate_bootstrap_dataset && python -m training.train --version 1.0.0
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev              # :3000
```

### Checks

```bash
cd backend     && npm run typecheck && npm run lint && npm test && npm run build
cd ml-service  && ruff check app training tests && pytest tests -q
cd frontend    && npm run typecheck && npm run build
```

CI runs all of the above, builds all three Docker images, then stands the whole
stack up with `docker compose` and asserts the pipeline genuinely discriminates
— the risk scores across the seeded tenant must span at least 20 points, or the
build fails.

---

## Deployment

[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) has the runbook. In brief:

**AWS EC2 behind Nginx** — the documented production target.

```bash
# once, on a fresh instance
curl -fsSL https://raw.githubusercontent.com/Teestasarkar/BugDNA/main/infra/ec2/bootstrap.sh | sudo bash

# then
cd /opt/bugdna && ./infra/ec2/generate-secrets.sh && $EDITOR .env
./infra/ec2/deploy.sh
```

CI builds images and pushes to GHCR; the instance pulls. `deploy.sh` takes a
database backup, rolls forward, verifies readiness and **rolls back
automatically** if the stack does not come up.

---

## Documentation

| Document | What it covers |
|---|---|
| [ML_MODEL.md](docs/ML_MODEL.md) | The model, the features, and what it cannot do |
| [Architecture.md](docs/Architecture.md) | Services, data flow, and the decisions behind them |
| [Database.md](docs/Database.md) | Schema, relationships, indexes, tenancy |
| [API.md](docs/API.md) | Every endpoint, the error taxonomy, realtime events |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | EC2 runbook, secrets, TLS, backups, rollback |
| [ASSUMPTIONS.md](docs/ASSUMPTIONS.md) | Every assumption made, and its consequence |
| [PRD.md](docs/PRD.md) | The product: users, jobs, scope |
| [Roadmap.md](docs/Roadmap.md) | What is built, what is next, what was left out |

---

## Licence

MIT.
