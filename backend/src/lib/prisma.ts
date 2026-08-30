/**
 * Prisma client singleton.
 *
 * A single instance per process: Prisma manages its own connection pool, and
 * creating clients per-request exhausts Postgres connections. The `global`
 * cache keeps hot-reload (tsx watch) from leaking a new pool on every edit.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import { env } from "../config/env";
import { scoped } from "./logger";
import { AppError } from "./errors";

const log = scoped("prisma");

const globalForPrisma = globalThis as unknown as {
  __bugdnaPrisma?: PrismaClient;
};

function createClient(): PrismaClient {
  const client = new PrismaClient({
    log: env.isDev
      ? [
          { emit: "event", level: "query" },
          { emit: "event", level: "warn" },
          { emit: "event", level: "error" },
        ]
      : [
          { emit: "event", level: "warn" },
          { emit: "event", level: "error" },
        ],
  });

  if (env.isDev) {
    client.$on("query" as never, (e: Prisma.QueryEvent) => {
      // Slow-query visibility during development without drowning the log.
      if (e.duration >= 150) {
        log.debug({ durationMs: e.duration, query: e.query }, "slow query");
      }
    });
  }

  client.$on("warn" as never, (e: Prisma.LogEvent) => log.warn({ target: e.target }, e.message));
  client.$on("error" as never, (e: Prisma.LogEvent) => log.error({ target: e.target }, e.message));

  return client;
}

export const prisma = globalForPrisma.__bugdnaPrisma ?? createClient();

if (env.isDev) globalForPrisma.__bugdnaPrisma = prisma;

/** Verify the database is reachable. Used by the readiness probe. */
export async function checkDatabase(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function disconnectPrisma(): Promise<void> {
  try {
    await prisma.$disconnect();
    log.info("disconnected");
  } catch (e) {
    log.warn({ err: e }, "error during disconnect");
  }
}

/**
 * Translate Prisma's error codes into our error taxonomy.
 *
 * Without this, a unique-constraint violation surfaces as an opaque 500. Call
 * it from a catch block when a specific constraint is plausible.
 */
export function mapPrismaError(e: unknown, resource = "Record"): AppError | undefined {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case "P2002": {
        const fields = (e.meta?.target as string[] | undefined)?.join(", ");
        return new AppError(409, `${resource} already exists${fields ? ` (${fields})` : ""}`, {
          code: "CONFLICT",
          retryable: false,
          details: { fields },
        });
      }
      case "P2025":
        return new AppError(404, `${resource} not found`, {
          code: "NOT_FOUND",
          retryable: false,
        });
      case "P2003":
        return new AppError(409, `${resource} is still referenced by other records`, {
          code: "CONFLICT",
          retryable: false,
        });
      case "P2024":
        return new AppError(503, "The database is under load. Please retry.", {
          code: "DATABASE_ERROR",
          retryable: true,
        });
      default:
        return new AppError(500, "A database error occurred", {
          code: "DATABASE_ERROR",
          retryable: true,
          cause: e,
          context: { prismaCode: e.code },
        });
    }
  }

  if (e instanceof Prisma.PrismaClientInitializationError) {
    return new AppError(503, "The database is unavailable. Please try again shortly.", {
      code: "DATABASE_ERROR",
      retryable: true,
      cause: e,
    });
  }

  if (e instanceof Prisma.PrismaClientValidationError) {
    return new AppError(500, "An invalid database query was constructed", {
      code: "DATABASE_ERROR",
      retryable: false,
      cause: e,
    });
  }

  return undefined;
}

export { Prisma };
