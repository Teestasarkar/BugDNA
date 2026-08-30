# Deployment

Two targets are supported. The **EC2 + Nginx** path is the documented production
architecture; the **managed PaaS** path exists to get a clickable public URL
quickly.

---

## 0. Secrets you need

| Secret | How to get it | Required |
|---|---|---|
| `SESSION_SECRET` | `openssl rand -hex 48` | yes |
| `TOKEN_ENCRYPTION_KEY` | `openssl rand -hex 32` (**exactly** 64 hex chars) | yes |
| `ML_SERVICE_TOKEN` | `openssl rand -hex 24` | yes in production |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | yes |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth App, below | for real GitHub data |

`./infra/ec2/generate-secrets.sh` writes the first four into `.env` for you.

> **`TOKEN_ENCRYPTION_KEY` encrypts stored GitHub access tokens.** If you change
> it, every existing connection becomes unreadable and users must reconnect.
> Back it up.

### Creating the GitHub OAuth App

<https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**

> Create it under the **Teestasarkar** account.

| Field | Value |
|---|---|
| Application name | BugDNA |
| Homepage URL | `https://your-domain` (or `http://<ec2-public-dns>`) |
| Authorization callback URL | `https://your-domain/api/v1/auth/github/callback` |

Then in `.env`:

```bash
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
GITHUB_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
GITHUB_CALLBACK_URL=https://your-domain/api/v1/auth/github/callback
GITHUB_OAUTH_SCOPES=read:user,user:email,repo
```

The **callback URL must match exactly** — including scheme and trailing path.
A mismatch is the single most common cause of a failed sign-in, and GitHub's
error message does not say so.

The `repo` scope is what allows private repositories and their diffs to be read.
Without it BugDNA lists only public repositories, and the UI says so explicitly
on the connect screen.

---

## 1. AWS EC2 behind Nginx

### 1.1 Provision

| | Recommended | Minimum |
|---|---|---|
| Instance | `t3.small` (2 vCPU, 2 GB) | `t3.micro` (1 GB) — works with the swap the bootstrap script adds |
| Storage | 20 GB gp3 | 12 GB |
| OS | Ubuntu 22.04 or Amazon Linux 2023 | either |

**Security group inbound:** `22` (your IP only), `80`, `443`. Nothing else.
Postgres, Redis, the API and the risk service are never exposed — Nginx is the
only ingress and the rest live on the internal Docker network.

### 1.2 Bootstrap

```bash
ssh ubuntu@<ec2-public-dns>
curl -fsSL https://raw.githubusercontent.com/Teestasarkar/BugDNA/main/infra/ec2/bootstrap.sh | sudo bash
```

Installs Docker + Compose, creates 2 GB of swap (**not optional** below 2 GB of
RAM — the risk service's first model load will otherwise be OOM-killed),
configures log rotation, a `ufw` firewall, unattended security updates, and a
nightly `pg_dump` cron.

### 1.3 Configure

```bash
cd /opt/bugdna
cp .env.example .env
./infra/ec2/generate-secrets.sh      # generates the cryptographic secrets
$EDITOR .env
```

Set these to your real host:

```bash
NODE_ENV=production
APP_URL=https://bugdna.example.com
API_URL=https://bugdna.example.com
CORS_ORIGINS=https://bugdna.example.com
NEXT_PUBLIC_API_URL=https://bugdna.example.com
NEXT_PUBLIC_WS_URL=https://bugdna.example.com
GITHUB_CALLBACK_URL=https://bugdna.example.com/api/v1/auth/github/callback
BUGDNA_SERVER_NAME=bugdna.example.com

COOKIE_SECURE=true          # HTTPS only
LOG_FORMAT=json
```

On a bare EC2 DNS name with no TLS yet, use `http://<ec2-public-dns>` and leave
`COOKIE_SECURE=false` until certbot has run.

> `NEXT_PUBLIC_*` values are **inlined into the browser bundle at build time**.
> Changing them requires rebuilding the web image, not just restarting it. That
> is the trade for not shipping a runtime config fetch on every page load.

### 1.4 Authenticate to the registry

CI pushes images to GHCR; the instance pulls them.

```bash
# a classic PAT with read:packages, from the Teestasarkar account
echo $GITHUB_TOKEN | docker login ghcr.io -u Teestasarkar --password-stdin
```

### 1.5 Deploy

```bash
./infra/ec2/deploy.sh              # :latest
./infra/ec2/deploy.sh v1.4.0       # a specific tag
./infra/ec2/deploy.sh --rollback   # back to the previous tag
```

The script, in order: validates `.env` (refusing placeholder values), takes a
`pg_dump`, pulls, rolls forward, waits up to 180s for
`/api/v1/system/ready`, and **rolls back automatically** if it does not come up.
The deployed tag is recorded in `.deploy-state` so `--rollback` has a target.

### 1.6 TLS

```bash
sudo ./infra/ec2/setup-tls.sh bugdna.example.com you@example.com
```

Point an A record at the instance first. Certbot rewrites the Nginx server block
in place and installs a renewal timer. Then set `COOKIE_SECURE=true` and
redeploy.

### 1.7 Automate it

In GitHub → **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `EC2_HOST` | public DNS or IP |
| `EC2_USER` | `ubuntu` or `ec2-user` |
| `EC2_SSH_KEY` | the **private** key, full PEM contents |
| `EC2_APP_DIR` | optional, defaults to `/opt/bugdna` |

And as **variables** (not secrets — they are inlined into the public bundle):

| Variable | Value |
|---|---|
| `PUBLIC_API_URL` | `https://bugdna.example.com` |
| `PUBLIC_WS_URL` | `https://bugdna.example.com` |

Every push to `main` then builds, pushes and deploys.
[`deploy.yml`](../.github/workflows/deploy.yml) verifies the result from outside
the instance afterwards, which catches security-group and DNS problems the
instance's own health check cannot.

---

## 2. Managed PaaS (fastest to a public URL)

Free tiers, no server to run.

| Service | Component |
|---|---|
| [Neon](https://neon.tech) | Postgres |
| [Upstash](https://upstash.com) | Redis |
| [Render](https://render.com) | API, worker, risk service |
| [Vercel](https://vercel.com) | Next.js frontend |

[`infra/paas/render.yaml`](../infra/paas/render.yaml) declares the three Render
services. Import it as a Blueprint, then set the secrets Render marks as
`sync: false`.

**Order matters**, because each step's output is the next step's input:

1. Create the Neon database → copy its connection string.
2. Create the Upstash Redis instance → copy its `rediss://` URL.
3. Deploy the Render blueprint with `DATABASE_URL` and `REDIS_URL` set → note
   the API's public URL.
4. Deploy the frontend to Vercel with `NEXT_PUBLIC_API_URL` and
   `NEXT_PUBLIC_WS_URL` pointing at that API URL.
5. Set `CORS_ORIGINS` and `APP_URL` on the API to the Vercel URL, and update the
   GitHub OAuth callback to `https://<api-url>/api/v1/auth/github/callback`.
6. Redeploy the API.

Two caveats worth knowing before demoing this:

- **Render free instances sleep** after inactivity. The first request takes
  ~30–50s. Warm it before a demo.
- **Upstash free tier has a command limit.** Fine for a demo; the cache-heavy
  paths will hit it under real load.

---

## 3. Operating

### Health

| Endpoint | Answers | Use for |
|---|---|---|
| `GET /health` | is the process up | load-balancer liveness — touches no dependency |
| `GET /api/v1/system/ready` | are Postgres and Redis reachable | deploy gate; 503 when not |
| `GET /api/v1/system/status` | versions, queue depth, model info | operator view (needs a session) |

`/ready` returns **200 with `status: "degraded"`** when the risk service is down
but Postgres and Redis are healthy. That is deliberate: the app is fully usable
for browsing and reading past analyses while the model service restarts, and
failing readiness would take the whole deployment out of rotation for a
non-critical dependency.

### Logs

```bash
docker compose -f docker-compose.prod.yml logs -f api worker ml-service
```

All three emit structured JSON in production with a shared `x-request-id`, so an
Nginx access line can be joined to the API line and the worker line for the same
request.

### Backups

The bootstrap script installs a nightly `pg_dump` at 03:15 UTC into
`/opt/bugdna/backups`, kept 14 days. `deploy.sh` also takes one before every
deploy, because migrations are the one step that is not trivially reversible.

```bash
./infra/ec2/backup.sh                            # manual
gunzip -c backups/bugdna-<ts>.sql.gz | \
  docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U bugdna -d bugdna                        # restore
```

Copy them off the instance. A backup on the same EBS volume as the database is
not a backup.

### Retraining

```bash
docker compose -f docker-compose.prod.yml exec ml-service \
  python -m training.train --data /app/data/history.csv --target caused_incident --version 2.0.0

docker compose -f docker-compose.prod.yml exec ml-service \
  curl -X POST localhost:8000/v1/model/reload -H "x-internal-token: $ML_SERVICE_TOKEN"
```

The `ml-models` volume persists artifacts across redeploys, so a new release
does not retrain.

---

## 4. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Sign-in redirects to `/login?error=GITHUB_AUTH_FAILED` | callback URL mismatch | make `GITHUB_CALLBACK_URL` and the OAuth App's callback byte-identical |
| Signed in, then immediately signed out | cookie rejected | `COOKIE_SECURE=true` over plain HTTP, or `CORS_ORIGINS` missing the app origin |
| Analyses stay QUEUED forever | worker not running | `docker compose logs worker`; check `REDIS_URL` |
| Every analysis fails `ML_UNAVAILABLE` | risk service down or still training | `docker compose logs ml-service`; first boot takes ~60s |
| Analyses complete but say "heuristic scorer" | no model artifact loaded | `BOOTSTRAP_MODEL_ON_START=true`, or train one; check the `ml-models` volume |
| Live progress never updates | websocket blocked | expected — HTTP polling takes over. Confirm Nginx passes `Upgrade`/`Connection` on `/socket.io/` |
| Private repositories missing | no `repo` scope | reconnect GitHub from Settings and grant it |
| `GITHUB_RATE_LIMITED` | quota exhausted | resets hourly; BugDNA uses ETags so unchanged data costs nothing |
| Container OOM-killed on a 1 GB instance | no swap | re-run `bootstrap.sh`, or lower `ANALYSIS_CONCURRENCY` to 1 |
| `contracts/feature-spec.json is out of date` in CI | registry edited without regenerating | `cd backend && npm run contracts:generate` and commit |

---

## 5. Security checklist

- [ ] `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY` are freshly generated, not the
      `.env.example` placeholders (the app refuses to start in production
      otherwise)
- [ ] `ML_SERVICE_TOKEN` is set — the risk service **refuses to boot** in
      production without it
- [ ] `COOKIE_SECURE=true` and TLS terminated
- [ ] Security group exposes only `22`, `80`, `443`
- [ ] No `ports:` mapping on postgres, redis, api, web or ml-service in
      `docker-compose.prod.yml`
- [ ] `TRUST_PROXY=true` behind Nginx, so rate limiting keys on the real client
      IP rather than the proxy's
- [ ] `ENABLE_DEMO_LOGIN=false` if this deployment should not offer the demo
      account
- [ ] `TOKEN_ENCRYPTION_KEY` backed up somewhere other than the instance
