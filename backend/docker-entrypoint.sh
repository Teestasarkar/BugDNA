#!/bin/sh
# Applies pending migrations, then hands PID 1 to the real command.
#
# This lives in the image rather than in a platform's start-command field for
# two reasons. Signals: the final `exec` means the Node process inherits PID 1
# from tini, so SIGTERM reaches the graceful shutdown in server.ts instead of
# being swallowed by a wrapper. And portability: `&&` in a start command is only
# a shell operator if the platform runs it through a shell, and Render does not
# — it word-splits and execs, which turned `&&` into an argument to prisma.
#
# Migrations are opt-in because exactly one process may apply them; two replicas
# racing on the same database is how a deploy corrupts its own schema.
set -e

if [ "${RUN_MIGRATIONS_ON_START:-false}" = "true" ]; then
  echo "[entrypoint] applying database migrations"
  ./node_modules/.bin/prisma migrate deploy
  echo "[entrypoint] migrations up to date"
fi

exec "$@"
