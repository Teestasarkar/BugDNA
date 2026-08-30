# API

Base: `/api/v1`. Authentication is an httpOnly session cookie (a `Bearer` token
is also accepted, for non-browser clients).

## Response envelope

Success:

```json
{ "data": { ... }, "meta": { "page": 1, "perPage": 20, "total": 57, "totalPages": 3 } }
```

Failure — **always** this shape:

```json
{
  "error": {
    "code": "GITHUB_RATE_LIMITED",
    "message": "GitHub API rate limit reached. Access resets at 2026-08-31T14:00:00Z.",
    "status": 429,
    "retryable": true,
    "retryAfterSeconds": 1840,
    "details": { "resetAt": "2026-08-31T14:00:00Z" }
  },
  "requestId": "3f9c1a2e-..."
}
```

`code` is stable across releases and is what clients switch on. `message` is safe
to display. **`retryable` drives the UI's retry affordance** — the frontend shows
"Try again" only where retrying can help, rather than guessing from the status
code.

Every response carries `x-request-id`, echoed from the request when a proxy
supplied one, so an Nginx line, an API line and a worker line can be joined.

## Error codes

| Code | Status | Retryable | Meaning |
|---|---|---|---|
| `VALIDATION_FAILED` | 400 | no | `details` is a per-field array |
| `UNAUTHENTICATED` | 401 | no | no session |
| `SESSION_EXPIRED` | 401 | no | valid signature, dead session |
| `FORBIDDEN` | 403 | no | authenticated but not permitted |
| `NOT_FOUND` | 404 | no | also returned for resources you cannot see |
| `CONFLICT` | 409 | no | e.g. repository already connected |
| `ANALYSIS_IN_PROGRESS` | 409 | no | `details.analysisId` points at the running one |
| `RATE_LIMITED` | 429 | yes | BugDNA's own limit |
| `GITHUB_NOT_CONNECTED` | 400 | no | connect GitHub |
| `GITHUB_NOT_CONFIGURED` | 503 | no | deployment has no OAuth app |
| `GITHUB_TOKEN_INVALID` | 401 | no | reconnect |
| `GITHUB_RATE_LIMITED` | 429 | yes | carries `resetAt` |
| `GITHUB_FORBIDDEN` | 403 | no | scope insufficient |
| `GITHUB_UNAVAILABLE` | 502 | yes | GitHub unreachable |
| `DIFF_UNAVAILABLE` | 502 | yes | diff could not be fetched |
| `ML_UNAVAILABLE` | 503 | yes | risk service down |
| `ML_TIMEOUT` | 504 | yes | inference too slow |
| `ML_INVALID_RESPONSE` | 502/500 | varies | contract mismatch is non-retryable |
| `DATABASE_ERROR` | 500/503 | varies | P2024 pool exhaustion is retryable |

## Endpoints

### System — unauthenticated

| Method | Path | Notes |
|---|---|---|
| `GET` | `/system/health` | liveness; touches no dependency |
| `GET` | `/system/ready` | readiness; **503** when Postgres or Redis is down, **200 `degraded`** when only the risk service is |
| `GET` | `/system/config` | what this deployment supports — the sign-in page needs it before a session exists |
| `GET` | `/system/status` | *(auth)* versions, queue depth, model info |

### Auth

| Method | Path | Notes |
|---|---|---|
| `GET` | `/auth/github?next=` | redirects to GitHub; `next` is stored server-side with the OAuth `state`, never in the query string, so it cannot become an open redirect |
| `GET` | `/auth/github/callback` | consumes `state` (single use), sets the cookie, redirects into the app. Failures redirect to `/login?error=CODE&message=` |
| `POST` | `/auth/demo` | seeded demo account; 403 when `ENABLE_DEMO_LOGIN=false` |
| `GET` | `/auth/me` | current user + GitHub connection state + teams |
| `GET` | `/auth/session` | unauthenticated probe — lets the client tell "signed out" from "request failed" |
| `POST` | `/auth/logout` | `{ allDevices?: boolean }` |
| `POST` | `/auth/github/disconnect` | revokes the credential, keeps the data |

### Repositories

| Method | Path | Notes |
|---|---|---|
| `GET` | `/repositories` | connected, with rollup stats |
| `GET` | `/repositories/available` | from GitHub, annotated with what is already connected and whether the token can pull |
| `GET` | `/repositories/options` | lightweight, for filters |
| `POST` | `/repositories` | `{ owner, name, teamId? }` — validates GitHub access *before* creating the row |
| `GET` | `/repositories/:id` | detail |
| `PATCH` | `/repositories/:id` | `{ autoAnalyze?, teamId? }` |
| `DELETE` | `/repositories/:id` | disconnect — **non-destructive**, returns `analysesRetained` |
| `POST` | `/repositories/:id/sync` | re-pull pull requests |

### Pull requests

| Method | Path | Notes |
|---|---|---|
| `GET` | `/pulls` | filters: `repositoryId`, `state`, `authorLogin`, `search`, `riskLevel` (repeatable), `unanalysedOnly`, `sort` |
| `GET` | `/pulls/:id` | detail with every analysis |
| `GET` | `/pulls/:id/diff` | fetches from GitHub on first access; `?refresh=true` forces |
| `GET` | `/pulls/:id/analyses` | history, oldest first |
| `GET` | `/pulls/authors` | filter options |

### Analyses

| Method | Path | Notes |
|---|---|---|
| `POST` | `/analyses` | `{ pullRequestId, force? }` → **202** queued, or **200** when an existing result for the same SHA is reused |
| `GET` | `/analyses` | history; same filter vocabulary |
| `GET` | `/analyses/:id` | full detail — factors, recommendations, events, diff, decision |
| `GET` | `/analyses/:id/status` | lightweight polling fallback |
| `GET` | `/analyses/:id/merge-readiness` | assessment + outstanding items + whether a justification is required |
| `POST` | `/analyses/:id/decision` | records the call; **rejects** an override of HIGH/CRITICAL without a reason |
| `POST` | `/analyses/:id/retry` | new row, so the failure stays in history |
| `POST` | `/analyses/:id/cancel` | |
| `GET` | `/analyses/compare?base=&compare=` | score delta + per-factor changes |
| `GET` | `/analyses/features` | the full feature catalogue + live model metadata |

`POST /analyses` returns `202` with:

```json
{
  "data": { "analysisId": "c...", "status": "QUEUED", "reused": false, "headSha": "a1b2c3d" },
  "meta": {
    "realtime": { "room": "analysis:c...", "subscribeEvent": "subscribe:analysis" },
    "statusUrl": "/api/v1/analyses/c.../status"
  }
}
```

### Analytics

| Method | Path |
|---|---|
| `GET` | `/analytics/overview?days=30` |
| `GET` | `/analytics/repositories/:id?days=30` |
| `GET` | `/analytics/repositories/:id/snapshots?days=90` |
| `GET` | `/analytics/teams/:teamId?days=30` |

### Teams, notifications, search, timeline

| Method | Path | Notes |
|---|---|---|
| `GET`/`POST` | `/teams` | |
| `GET`/`PATCH`/`DELETE` | `/teams/:teamId` | delete unlinks repositories, does not delete them |
| `POST`/`PATCH`/`DELETE` | `/teams/:teamId/members[/:userId]` | role-gated |
| `POST` | `/teams/:teamId/leave` | |
| `GET` | `/notifications` | `?unreadOnly`, `?type` |
| `GET` | `/notifications/unread-count` | |
| `POST` | `/notifications/read` · `/read-all` | |
| `DELETE` | `/notifications/:id` | dismiss |
| `GET` | `/search?q=&limit=&category=` | grouped by kind; <2 chars returns recents |
| `GET` | `/timeline` | merged event stream + correlation panel |
| `GET`/`POST` | `/timeline/deployments` | |
| `POST` | `/timeline/deployments/:id/outcome` | **the only ground-truth input** |
| `POST` | `/timeline/deployments/sync` | import from the GitHub Deployments API |

## Realtime

Socket.io at `/socket.io`, authenticated by the same session cookie
(`withCredentials: true`). An unauthenticated handshake is rejected outright.

**Rooms** — membership is authorised on join using the same tenancy predicate as
REST, so the socket is not a hole around HTTP authorisation:

| Room | Joined |
|---|---|
| `user:<userId>` | automatically |
| `analysis:<id>` | `emit("subscribe:analysis", id)` |
| `repo:<id>` | `emit("subscribe:repository", id)` |

**Events:** `analysis:queued`, `analysis:progress`, `analysis:completed`,
`analysis:failed`, `notification:created`, `repository:synced`,
`repository:sync_failed`, `deployment:recorded`, `merge_decision:recorded`.

Realtime is **best-effort**. Every event mirrors state already committed to
Postgres, so a dropped message costs a live update, never correctness — and the
client refetches on reconnect rather than assuming it missed nothing.

## Rate limits

Redis-backed, so the limit is a property of the deployment rather than of each
container. Keyed by user id when authenticated, IP otherwise.

| Scope | Default |
|---|---|
| General | 300 / minute |
| `POST /analyses` | 30 / minute |
| Auth | 30 / 15 min, **failures only** |
| Search | 120 / minute |

## Validation

Zod on body, query and params. Parsed values **replace** the originals, so
downstream code works with coerced types (`?page=2` arrives as the number `2`)
and unknown keys are stripped rather than forwarded. Repeated query parameters
(`?riskLevel=HIGH&riskLevel=CRITICAL`) are normalised to arrays.

## The internal ML contract

Not part of the public API — the risk service is never proxied through Nginx.

```
POST /v1/predict          x-internal-token: <shared secret>
{ "feature_set_version": "1.0.0", "features": { "total_churn": 1030, ... } }
  ↓
{ "model":      { "engine": "xgboost", "version": "1.0.0", "metrics": null },
  "prediction": { "probability": 0.72, "risk_score": 72.3, "risk_level": "HIGH" },
  "explanation":{ "base_value": -0.82, "contributions": [...], "method": "shap_tree" },
  "warnings":   [] }
```

Also `GET /health`, `GET /v1/model/info`, `GET /v1/features`,
`POST /v1/model/reload`.
