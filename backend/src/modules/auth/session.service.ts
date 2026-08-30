/**
 * Session management.
 *
 * Design: the cookie carries a short signed JWT whose only meaningful claim is
 * `sid`, pointing at a `Session` row. That gives us both halves of what a
 * session needs to be:
 *
 *  - **stateless verification** — the signature is checked without a DB round
 *    trip, so a forged cookie is rejected immediately;
 *  - **server-side revocation** — because the row is authoritative, "sign out
 *    everywhere" and "this session was revoked" actually work, which a bare JWT
 *    cannot do.
 *
 * The per-request identity lookup is cached in Redis for a few seconds so a
 * burst of requests costs one query, not one per request. The cache is keyed by
 * session id and dropped on revocation.
 */
import jwt, { type JwtPayload } from "jsonwebtoken";
import type { Request } from "express";
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { cacheDel, cacheGet, cacheSet } from "../../lib/cache";
import { env } from "../../config/env";
import { scoped } from "../../lib/logger";
import type { AuthContext } from "../../types/express";

const log = scoped("session");

/** Seconds a resolved AuthContext is cached. Short enough that a revoked
 *  session or a new team membership takes effect almost immediately. */
const AUTH_CACHE_TTL_SECONDS = 15;

const authCacheKey = (sessionId: string) => `auth:ctx:${sessionId}`;

interface SessionTokenClaims extends JwtPayload {
  sid: string;
  uid: string;
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

export interface IssuedSession {
  token: string;
  sessionId: string;
  expiresAt: Date;
}

export async function createSession(
  userId: string,
  meta: { userAgent?: string; ip?: string } = {},
): Promise<IssuedSession> {
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_HOURS * 3_600_000);

  const session = await prisma.session.create({
    data: {
      userId,
      expiresAt,
      userAgent: meta.userAgent?.slice(0, 512) ?? null,
      ip: meta.ip?.slice(0, 64) ?? null,
    },
    select: { id: true },
  });

  const token = jwt.sign({ sid: session.id, uid: userId }, env.sessionSecret, {
    expiresIn: `${env.SESSION_TTL_HOURS}h`,
    issuer: "bugdna",
    subject: userId,
  });

  log.info({ userId, sessionId: session.id }, "session created");

  return { token, sessionId: session.id, expiresAt };
}

// ---------------------------------------------------------------------------
// Verify & resolve
// ---------------------------------------------------------------------------

/** Verify the cookie signature. Returns null for anything not trustworthy. */
export function verifySessionToken(token: string): SessionTokenClaims | null {
  try {
    const decoded = jwt.verify(token, env.sessionSecret, { issuer: "bugdna" });
    if (typeof decoded === "string") return null;
    const claims = decoded as SessionTokenClaims;
    if (!claims.sid || !claims.uid) return null;
    return claims;
  } catch {
    // Expired / malformed / wrong signature are all the same to a caller.
    return null;
  }
}

/**
 * Resolve a verified session id into the full tenancy context.
 *
 * Returns null when the session no longer exists, has expired, or was revoked —
 * i.e. the signature was valid but the session is not.
 */
export async function resolveAuthContext(sessionId: string): Promise<AuthContext | null> {
  const cached = await cacheGet<AuthContext>(authCacheKey(sessionId));
  if (cached) return cached;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      user: {
        select: {
          id: true,
          githubLogin: true,
          isDemo: true,
          teamMemberships: { select: { teamId: true } },
        },
      },
    },
  });

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  const context: AuthContext = {
    userId: session.user.id,
    sessionId: session.id,
    githubLogin: session.user.githubLogin,
    isDemo: session.user.isDemo,
    teamIds: session.user.teamMemberships.map((m) => m.teamId),
  };

  await cacheSet(authCacheKey(sessionId), context, AUTH_CACHE_TTL_SECONDS);
  return context;
}

/**
 * Record activity without adding a write to every request.
 *
 * A Redis marker throttles the update to once per five minutes per session, so
 * "last active" stays useful while costing roughly nothing.
 */
export async function touchSession(sessionId: string): Promise<void> {
  const marker = `session:touched:${sessionId}`;
  try {
    const isFirst = await redis.set(marker, "1", "EX", 300, "NX");
    if (isFirst !== "OK") return;
  } catch {
    return; // Redis down: skip the bookkeeping rather than failing the request.
  }

  const now = new Date();
  try {
    const session = await prisma.session.update({
      where: { id: sessionId },
      data: { lastActiveAt: now },
      select: { userId: true },
    });
    await prisma.user.update({
      where: { id: session.userId },
      data: { lastSeenAt: now },
    });
  } catch (e) {
    // Bookkeeping only — never fail a request because presence tracking failed.
    log.debug({ err: e, sessionId }, "failed to touch session");
  }
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session
    .update({ where: { id: sessionId }, data: { revokedAt: new Date() } })
    .catch(() => undefined); // already gone is a success for a sign-out
  await cacheDel(authCacheKey(sessionId));
  log.info({ sessionId }, "session revoked");
}

export async function revokeAllSessions(userId: string): Promise<number> {
  const sessions = await prisma.session.findMany({
    where: { userId, revokedAt: null },
    select: { id: true },
  });

  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (sessions.length > 0) {
    await cacheDel(...sessions.map((s) => authCacheKey(s.id)));
  }

  return sessions.length;
}

/** Drop the cached context so the next request re-reads (e.g. after a team change). */
export async function invalidateAuthCache(sessionId: string): Promise<void> {
  await cacheDel(authCacheKey(sessionId));
}

/** Housekeeping: remove sessions that expired more than 30 days ago. */
export async function pruneExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3_600_000);
  const { count } = await prisma.session.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  if (count > 0) log.info({ count }, "pruned expired sessions");
  return count;
}

// ---------------------------------------------------------------------------
// Cookie helpers
// ---------------------------------------------------------------------------

export function sessionCookieOptions(): {
  httpOnly: true;
  secure: boolean;
  sameSite: "lax" | "none";
  path: string;
  maxAge: number;
  domain?: string;
} {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    // `lax` lets the cookie survive the GitHub OAuth redirect back to us.
    // `none` is required when the API and app are on different sites, which
    // also mandates Secure — so it is only reachable over HTTPS.
    sameSite: env.COOKIE_SECURE && isCrossSite() ? "none" : "lax",
    path: "/",
    maxAge: env.SESSION_TTL_HOURS * 3_600_000,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

/** True when the browser app and the API are on different registrable domains. */
function isCrossSite(): boolean {
  try {
    const app = new URL(env.APP_URL).hostname;
    const api = new URL(env.API_URL).hostname;
    return registrableDomain(app) !== registrableDomain(api);
  } catch {
    return false;
  }
}

function registrableDomain(hostname: string): string {
  const parts = hostname.split(".");
  return parts.length <= 2 ? hostname : parts.slice(-2).join(".");
}

/** Read the session cookie, tolerating its absence. */
export function readSessionCookie(req: Request): string | undefined {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[env.COOKIE_NAME];
  if (fromCookie) return fromCookie;

  // Bearer fallback: convenient for API clients and integration tests. Browsers
  // always use the cookie.
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();

  return undefined;
}
