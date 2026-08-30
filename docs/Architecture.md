# Architecture

Four services, one database, one cache. This document explains the boundaries and
the reasoning behind them, because the boundaries are the design.

---

## Services

| Service | Stack | Responsibility |
|---|---|---|
| **web** | Next.js 15, React 19, Tailwind v4 | The interface. TanStack Query for server state, Zustand for client state. |
| **api** | Express 5, Prisma, Socket.io | HTTP surface, auth, tenancy, GitHub integration, realtime fan-out. Enqueues work; never does it. |
| **worker** | same image as api | Runs the analysis pipeline. |
| **ml-service** | FastAPI, XGBoost, SHAP | Scores a feature vector and explains the result. Internal only. |
| **postgres** | 16 | System of record. |
| **redis** | 7 | Cache, transient state, BullMQ, cross-process event bus. |
| **nginx** | 1.27 | The only public ingress. |

---

## Why the worker is a separate process

One analysis makes several GitHub round trips (PR detail, then paged file lists),
then an inference call. Ten to forty seconds is normal; a large PR is longer.

Doing that inside an HTTP request means a request that holds a connection for a
minute, a client that must poll or hang, and a timeout somewhere in the chain
that produces a failure with no diagnosis. So:

- `POST /analyses` creates the row, enqueues a job and returns **202** with an
  analysis id, in milliseconds.
- The worker consumes the job and drives the pipeline.
- Progress is pushed over Socket.io; `GET /analyses/:id/status` is the polling
  fallback for clients whose websocket is blocked.

Three further benefits fall out of it:

- **Isolation.** A wedged analysis or an OOM in the pipeline cannot take the API
  down.
- **Independent scaling.** Analysis throughput is bounded by GitHub rate limits
  and inference cost, not HTTP traffic.
- **Deploy safety.** The worker drains in-flight jobs on SIGTERM without holding
  open HTTP connections.

---

## Why realtime goes through a Redis bus

The worker produces progress events. The browser's socket is held by an **API**
process. Without a bridge, those events reach nobody.

```
worker ──publish──▶ redis channel `bugdna:realtime` ──▶ every api instance
                                                          └─▶ io.to(room).emit()
```

`realtime/bus.ts` publishes; `realtime/socket.ts` subscribes and fans out to the
rooms that instance happens to hold. Two consequences:

- The API **scales horizontally for free** — each instance delivers to its own
  clients.
- Realtime is **best-effort by design**. Every event mirrors state already
  committed to Postgres, so a dropped message costs a live update, never
  correctness. The client refetches on reconnect rather than assuming it missed
  nothing.

Room membership is authorised on join, using the same tenancy predicate as REST.
A client cannot subscribe to `analysis:<id>` for an analysis it may not read —
otherwise the socket layer would be a hole straight around the HTTP
authorisation.

---

## Why Redis is not the source of truth

Everything in Redis is derived and reconstructible:

| Use | Key shape | Lost on flush |
|---|---|---|
| GitHub response cache | `cache:gh:*` | a slower next request |
| ETag store | `etag:gh:*` | one wasted conditional request |
| Analytics memoisation | `cache:analytics:*` | a slower dashboard |
| Live analysis state | `state:analysis:*` | the UI reads Postgres instead |
| Duplicate-analysis lock | `lock:analysis:*` | a duplicate analysis, which is idempotent |
| OAuth state | `oauth:state:*` | one sign-in must be retried |
| BullMQ queue | `bull:*` | **in-flight jobs**, see below |

The one real exposure is the queue. If Redis were lost mid-flight, those
analyses would stay `RUNNING` in Postgres and need re-queueing from the UI —
nothing is corrupted, and `--appendonly yes` with `noeviction` makes it unlikely.
That is the trade being made, stated rather than hidden.

---

## Why the ML service is separate — and has no shadow in the backend

The requirement was that the model be replaceable without rewriting the product.
The boundary is one HTTP call: features in, score plus attributions out.

```ts
POST /v1/predict
{ feature_set_version, features: { key: number }, context }
  ↓
{ model: { engine, version, metrics },
  prediction: { probability, risk_score, risk_level, confidence },
  explanation: { base_value, contributions[], method, notes[] },
  warnings[] }
```

Nothing about XGBoost or SHAP crosses that line except a label saying which
produced the answer. The model can be retrained, re-tuned or swapped for a
different algorithm entirely and the Node codebase does not change.

The corollary matters as much: **there is deliberately no fallback scorer in the
backend.** If the risk service cannot answer, the analysis retries with backoff
and then fails honestly. Quietly substituting a different scoring method in the
product backend would make the reported risk untraceable — you could not tell,
after the fact, what actually produced a number. The transparent heuristic
fallback lives *inside* the ML service, so a fallback score is still produced by
the component that owns scoring, and is always labelled `engine: "heuristic"`.

It also keeps the ML dependency tree (xgboost, shap, numpy, pandas — several
hundred megabytes) out of the API's runtime image entirely.

---

## The feature contract

Both services need the same 43 features in the same order. Maintaining that list
twice guarantees drift, and drift here does not produce an error — it produces
quietly wrong scores.

```
backend/src/modules/analysis/features/registry.ts     ← authoritative
        │  npm run contracts:generate
        ▼
contracts/feature-spec.json                            ← committed
        │
        ▼
ml-service/app/features.py                             ← loads it
```

The registry is authoritative because that is where the extractor functions live,
so it cannot drift from what is actually computed. CI runs
`npm run contracts:check` and fails if the committed JSON is stale.

Three guards on top:

- `assertVectorMatchesRegistry` throws on the first analysis if the extractor and
  registry disagree.
- The ML service compares the trained model's stored feature list against the
  contract on load and refuses a mismatched artifact.
- A `feature_set_version` mismatch between caller and service produces a warning
  in the response rather than a silent mis-scoring.

---

## The analysis pipeline

```
NORMALIZING          resolve the repository, confirm it is still connected
FETCHING_DIFF        GitHub: PR detail + paged file list, classify each file
EXTRACTING_FEATURES  43 signals, plus repository history from our own tables
PREDICTING           POST to the risk service
EXPLAINING           SHAP values → ranked, labelled factors with file evidence
RECOMMENDING         declarative rules fire on detected factors
PERSISTING           one transaction: analysis + factors + recommendations
```

Each stage writes an `AnalysisEvent` with a duration, so a completed analysis can
answer "where did the time go" and a failed one can answer "where did it stop".

### Failure policy

Three distinct outcomes, preserved end to end:

| Kind | Example | Behaviour |
|---|---|---|
| **Retryable** | GitHub 5xx, ML cold start, network | thrown; BullMQ retries with backoff. Status stays `RUNNING` and the UI says "retrying" |
| **Terminal** | contract mismatch, PR deleted, token revoked | recorded `FAILED` immediately — retrying cannot help |
| **Degraded** | diff truncated, no repository history, heuristic used | **completes**, with `degraded: true` and reasons the UI displays |

The third is the one most systems get wrong. An analysis computed from half a
diff is not the same as one computed from all of it, and presenting them
identically would be dishonest. `degradedReasons` is a string array shown on the
analysis page and summarised on the badge.

### Deduplication

Natural user behaviour is to click twice. Three layers:

1. A **completed** analysis for the same head SHA is reused unless `force`.
2. A **queued or running** one is returned as-is, so the client attaches.
3. A short **Redis lock** on `(pullRequestId, headSha)` closes the race between
   two simultaneous requests that both pass 1 and 2.

The BullMQ job id *is* the analysis id, so enqueueing is idempotent at that layer
too.

---

## Tenancy

One predicate, one file
([`repository.access.ts`](../backend/src/modules/repositories/repository.access.ts)):

```
ownerUserId = :me  OR  teamId IN (:myTeamIds)
```

Every user-owned row is reachable from a `Repository`, so authorising the
repository authorises the subtree. Controllers call `assertRepositoryAccess`,
`assertPullRequestAccess` or `assertAnalysisAccess` and then query freely.

Two details that are easy to get wrong and are handled explicitly:

- **404, not 403.** Telling an attacker "this exists but is not yours" leaks the
  existence of private repositories.
- **`AND`-composed `where` clauses.** The tenancy predicate is itself an `OR`. A
  search filter contributes another. Spread into one flat object, the second
  `OR` key silently replaces the first and widens every query past the tenancy
  boundary. Every composed query uses an explicit `AND: [...]` array so that
  mistake is unrepresentable.

---

## Authentication

The cookie carries a short signed JWT whose only meaningful claim is `sid`,
pointing at a `Session` row.

That gives both halves of what a session needs:

- **stateless verification** — the signature is checked with no database round
  trip, so a forged cookie is rejected immediately;
- **server-side revocation** — the row is authoritative, so "sign out
  everywhere" and "this session was revoked" actually work, which a bare JWT
  cannot do.

The per-request identity lookup is cached in Redis for 15 seconds, so a burst of
requests costs one query. Short enough that a revocation or a new team membership
takes effect almost immediately.

GitHub access tokens are sealed with **AES-256-GCM** before storage. GCM is
authenticated, so a tampered ciphertext fails to decrypt rather than yielding
garbage. A decryption failure is treated as "this connection is unusable, ask the
user to reconnect" rather than a server error — because that is what a rotated
key actually means.

---

## GitHub integration

Written directly against `fetch` rather than Octokit, for three reasons:

- Octokit v21+ is ESM-only, which conflicts with this CommonJS build;
- rate-limit and conditional-request behaviour is the part of the integration
  that most affects the product, and should be explicit rather than buried in a
  plugin;
- it keeps the dependency surface small for something this central.

What that buys:

- **ETags cached in Redis.** A 304 costs *no* rate limit at all, which is what
  makes repeated PR polling viable.
- **403 vs 429 disambiguation.** GitHub returns 403 for rate limiting *and* for
  genuine permission failures, distinguished only by `x-ratelimit-remaining`.
  Getting this wrong tells users they lack access when they are merely throttled.
- **Hard caps.** `GITHUB_MAX_FILES_PER_PR` and `GITHUB_MAX_PATCH_BYTES` stop a
  pathological PR exhausting memory, and truncation is recorded as a degradation
  rather than silently skewing the features.

A `mock` provider implements the same interface with deterministic fixtures, so
the entire product runs with no credentials and no network — used by CI and by
the seeded demo.

---

## Frontend state

A clean split, because letting the two overlap is how stale UI happens:

| Concern | Owner | Why |
|---|---|---|
| Anything from the API | **TanStack Query** | caching, refetch, retry policy driven by the API's own `retryable` flag |
| Live analysis progress | **Zustand** | changes several times a second; putting it in the query cache would invalidate constantly |
| Sidebar, theme, palette, filters | **Zustand** (persisted) | no server owns it |

Query keys are all constructed in one registry (`lib/query-keys.ts`).
Hand-written keys scattered across components drift immediately — you end up
with a mutation invalidating `["analyses"]` while the list is cached under
`["analysis","list"]`, and the UI silently stops updating.

When a socket event says an analysis completed, the store records the summary
*and* the query cache is invalidated so the authoritative record is refetched.
The socket payload is a summary; the full analysis with factors and
recommendations comes from the API.

---

## Design system

Colour means risk. Nothing else in the interface is emerald, amber or rose, so a
red badge always means the same thing and a glance is enough. The brand accent is
violet precisely so it can never be mistaken for a severity.

That constraint is enforced structurally: `Badge` has no `success`/`danger`
variants. A coloured badge is produced by passing a risk class from
`lib/risk.ts`. Chart series for non-risk data use a separate `--chart-*` ramp.

---

## What was deliberately left out

| Not built | Why |
|---|---|
| GitHub App (vs OAuth App) | An App gives finer-grained installs and webhooks, but adds installation flows and JWT signing. OAuth reaches a working product faster; the provider interface makes it swappable. |
| Webhooks | Would make analysis automatic on PR open. Needs a public callback URL and signature verification — real work, and orthogonal to proving the risk pipeline. |
| Postgres full-text search | `contains` is index-assisted for the prefix cases here and needs no extra configuration. A `tsvector` index is the natural upgrade if the corpus grows. |
| Multi-region / read replicas | Not a real constraint at this scale. |
| A model registry (MLflow etc.) | Versioned artifacts on a volume plus a metadata sidecar is enough for one model. |
