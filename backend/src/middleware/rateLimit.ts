/**
 * Rate limiting.
 *
 * Backed by Redis rather than in-process memory, so the limit is a property of
 * the deployment and not of each container — otherwise scaling to N instances
 * silently multiplies every limit by N.
 *
 * Limits are keyed by user id when the caller is authenticated and by IP
 * otherwise, so one noisy tenant cannot exhaust the budget of everyone behind
 * the same NAT.
 */
import rateLimit, { type Options, type RateLimitRequestHandler } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { Request, Response } from "express";
import { redis } from "../lib/redis";
import { env } from "../config/env";
import { rateLimited } from "../lib/errors";
import { scoped } from "../lib/logger";

const log = scoped("ratelimit");

function makeStore(prefix: string) {
  try {
    return new RedisStore({
      // rate-limit-redis speaks raw commands; ioredis exposes `call` for that.
      sendCommand: (...args: string[]) => redis.call(...(args as [string, ...string[]])) as never,
      prefix: `rl:${prefix}:`,
    });
  } catch (e) {
    // Fall back to the in-memory store rather than refusing to boot. Logged
    // loudly because the limit is no longer cluster-wide.
    log.error({ err: e }, "failed to create Redis rate-limit store; using in-memory");
    return undefined;
  }
}

function keyGenerator(req: Request): string {
  if (req.auth?.userId) return `u:${req.auth.userId}`;
  // `ipKeyGenerator` semantics: Express already normalises IPv6 here, and
  // TRUST_PROXY governs whether X-Forwarded-For is believed.
  return `ip:${req.ip ?? "unknown"}`;
}

function handler(_req: Request, res: Response, next: (e: unknown) => void, options: Options): void {
  const retryAfter = Math.ceil(options.windowMs / 1000);
  next(
    rateLimited(
      "You are sending requests too quickly. Please wait a moment and try again.",
      retryAfter,
    ),
  );
}

interface LimiterConfig {
  name: string;
  windowMs: number;
  max: number;
  /** Skip successful requests when counting (useful for auth endpoints). */
  skipSuccessfulRequests?: boolean;
}

function createLimiter(config: LimiterConfig): RateLimitRequestHandler {
  const store = makeStore(config.name);
  return rateLimit({
    windowMs: config.windowMs,
    limit: config.max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator,
    handler,
    skipSuccessfulRequests: config.skipSuccessfulRequests ?? false,
    ...(store ? { store } : {}),
  });
}

/** Broad limit applied to the whole API surface. */
export const generalLimiter = createLimiter({
  name: "general",
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
});

/**
 * Tighter limit on triggering analyses: each one costs a GitHub round trip, a
 * diff download and an ML inference, so this is the expensive door.
 */
export const analysisLimiter = createLimiter({
  name: "analysis",
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_ANALYSIS_MAX,
});

/**
 * Auth endpoints. Only failures count, so a user repeatedly signing in
 * legitimately is not punished while credential-stuffing is.
 */
export const authLimiter = createLimiter({
  name: "auth",
  windowMs: 15 * 60_000,
  max: 30,
  skipSuccessfulRequests: true,
});

/** Search is cheap but easy to hammer from a keystroke handler. */
export const searchLimiter = createLimiter({
  name: "search",
  windowMs: 60_000,
  max: 120,
});
