# =============================================================================
# BugDNA API + worker
# =============================================================================
# One image serves both processes: the API (`node dist/server.js`) and the
# analysis worker (`node dist/worker.js`). They share all their code, so building
# twice would double CI time and create the possibility of a version skew
# between two halves of the same system.

# ---------------------------------------------------------------------------
# Stage 1 — dependencies
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps

WORKDIR /app

# Prisma's engines are downloaded during install and need OpenSSL present.
RUN apk add --no-cache openssl libc6-compat

COPY package.json package-lock.json* ./
# `npm ci` when a lockfile exists (reproducible), `npm install` otherwise.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

# ---------------------------------------------------------------------------
# Stage 2 — build
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl libc6-compat

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts

# `build` runs `prisma generate` then `tsc`. Generating here means the client is
# baked into the image and the container never needs to generate at boot.
RUN npm run build

# Drop dev dependencies from the tree that will be copied forward.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 3 — runtime
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

WORKDIR /app

# openssl: Prisma query engine. curl: healthcheck. tini: correct signal handling.
RUN apk add --no-cache openssl libc6-compat curl tini

ENV NODE_ENV=production \
    NODE_OPTIONS="--enable-source-maps"

# node:alpine ships a `node` user (uid 1000); use it rather than root.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/prisma ./prisma
# prisma/seed.ts imports from ../src, and it is run with tsx rather than
# compiled, so the sources have to be present for the documented seed command
# (`docker compose exec api npx tsx prisma/seed.ts`) to work at all.
#
# The honest trade: this image is not minimal. node_modules is copied from the
# builder stage without pruning, so tsx, typescript and vitest are already
# inside it; adding ~1 MB of TypeScript alongside them is not what makes it
# large. A genuinely slim image would prune devDependencies, compile the seed
# into dist/, and drop both — worth doing before this carries real traffic.
COPY --from=builder --chown=node:node /app/src ./src
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node docker-entrypoint.sh ./
RUN chmod +x ./docker-entrypoint.sh

USER node

EXPOSE 4000

# Liveness only — deliberately does not touch Postgres, so a slow database does
# not cause the orchestrator to kill a healthy container. Readiness is a separate
# endpoint the deploy gate checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://localhost:4000/healthz || exit 1

# tini reaps zombies and forwards SIGTERM, which is what makes the graceful
# shutdown in server.ts actually run.
ENTRYPOINT ["/sbin/tini", "--", "./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
