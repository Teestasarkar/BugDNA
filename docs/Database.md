# Database

PostgreSQL 16 via Prisma 6. **20 models, 14 enums.** Full schema:
[`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma).

## Tenancy shape

Everything that can carry user data descends from `Repository`, which is scoped
by `ownerUserId` plus an optional `teamId`. That is what makes the isolation rule
a single predicate rather than a per-table concern.

```
User ──┬─▶ GithubConnection (1:1, encrypted token)
       ├─▶ Session                     (revocable server-side)
       ├─▶ TeamMember ──▶ Team ──┐
       └─▶ Repository ◀──────────┘     (teamId, nullable)
                │
                ├─▶ PullRequest ──┬─▶ ChangedFile
                │                 ├─▶ Analysis ──┬─▶ RiskFactor
                │                 │              ├─▶ Recommendation
                │                 │              ├─▶ AnalysisEvent
                │                 │              └─▶ MergeDecision (1:1)
                │                 └─▶ Deployment
                └─▶ RepositoryHealthSnapshot
```

## Models

| Model | Purpose | Notes |
|---|---|---|
| `User` | Identity | Always arrives via GitHub OAuth; `githubId` is `BigInt` |
| `GithubConnection` | Encrypted OAuth token | AES-256-GCM — ciphertext, IV and auth tag stored separately |
| `Session` | Server-side session record | What makes the JWT revocable |
| `Team` / `TeamMember` | Sharing | The owner is *also* a `TeamMember` with role `OWNER`, so membership queries need no special case |
| `Repository` | Connected repository mirror | The tenancy root. Unique on `(ownerUserId, githubId)` |
| `PullRequest` | PR mirror | Unique on `(repositoryId, number)` |
| `ChangedFile` | Diff plus classification | Carries the extractor's booleans, so the diff view and the model agree on what a file is |
| `Analysis` | One run against one head SHA | Append-only; stores the exact `features` JSON |
| `RiskFactor` | One SHAP contribution | Signed `shapValue` in log-odds, normalised `contribution`, and `evidence` JSON linking to files |
| `Recommendation` | One mitigation | `triggeredByFactorKeys` is the audit trail from "why" to "what to do" |
| `AnalysisEvent` | Pipeline trace | Per-stage durations; answers "where did it fail" |
| `MergeDecision` | The human call | Snapshots the score at decision time; the label a retraining run would use |
| `Deployment` | A ship event | `causedIncident` is the only ground truth in the system |
| `RepositoryHealthSnapshot` | Daily rollup | So dashboards read one row per day rather than aggregating every analysis |
| `Notification` | In-app notification | Loose id references, so one table serves every type |

## Design decisions

**`Analysis` is append-only.** Re-analysing the same pull request creates a new
row. That is what makes "risk went from 82 to 47 after tests were added"
expressible at all, and it means an analysis is a permanent record of what was
known at a point in time.

**The feature vector lives on the analysis.** `features Json` plus
`featureSetVersion`. Three uses: reproducibility, the training data a future
retraining run would consume, and analytics — test-discipline is read back *out*
of the stored vector rather than recomputed, so the dashboard cannot disagree
with what the model was actually shown.

**Snapshots are denormalised on purpose.** `Deployment.riskScoreAtDeploy` and
`MergeDecision.riskScoreAtDecision` copy the score at the moment it mattered, so
a later re-analysis does not rewrite history.

**`BigInt` for GitHub ids.** They exceed `Number.MAX_SAFE_INTEGER`. Serialised to
the client as strings — a JSON number would silently lose precision.

**Cascades follow ownership.** Deleting a user cascades to their repositories and
everything beneath. Deleting a *team* sets `Repository.teamId` to null instead,
because those repositories still belong to a person.

**`degradedReasons` is an array, not a boolean.** An analysis computed from a
truncated diff is not the same as one computed from the whole thing, and the UI
needs to say which limitation applied.

## Indexes

Every index exists for a query that actually runs:

| Index | Serves |
|---|---|
| `repositories(ownerUserId, isActive)` | the tenancy predicate on every list |
| `repositories(teamId)` | the team half of that predicate |
| `pull_requests(repositoryId, state)` | the PR list, filtered by state |
| `pull_requests(repositoryId, githubUpdatedAt)` | its default sort |
| `analyses(repositoryId, createdAt)` | history and analytics windows |
| `analyses(pullRequestId, createdAt)` | per-PR comparison over time |
| `analyses(status)` | finding queued/running work |
| `analyses(riskLevel)` | the "needs attention" query |
| `risk_factors(analysisId, rank)` | ordered factor list |
| `changed_files(module)` | blast-radius and incident-history aggregation |
| `deployments(repositoryId, environment, startedAt)` | the timeline |
| `notifications(userId, readAt)` | the unread badge |
| `repository_health_snapshots(repositoryId, bucketDate)` unique | idempotent daily upsert |

`pg_trgm` and `citext` are created by
[`infra/postgres/init/01-extensions.sql`](../infra/postgres/init/01-extensions.sql)
rather than a migration, because `CREATE EXTENSION` requires superuser — which
the application role deliberately does not have in production.

## Migrations

```bash
npx prisma migrate dev --name what_changed   # development
npx prisma migrate deploy                    # production, idempotent
```

`migrate deploy` runs as part of the **API** container's start command. Exactly
one service applies migrations; two replicas would race.

## Seeding

```bash
npm run seed
```

Creates the demo tenant: 5 users, 1 team, 3 repositories, 24 pull requests with
real diffs, deployments with reported incidents, merge decisions, notifications
and 45 days of health snapshots.

The analyses are **produced by the real pipeline** — feature extraction, a live
call to the risk service, SHAP explanation, recommendation rules. The seed script
does not write invented risk scores. If the risk service is unreachable it seeds
everything else and says clearly that analyses were skipped.
