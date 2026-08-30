/**
 * Authentication middleware.
 *
 * `requireAuth` is the gate: it establishes `req.auth`, which every downstream
 * tenancy check reads. There is deliberately no way for a controller to "guess"
 * an identity — if `req.auth` is absent, `req.user()` throws.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  readSessionCookie,
  resolveAuthContext,
  touchSession,
  verifySessionToken,
} from "../modules/auth/session.service";
import {
  forbidden,
  githubNotConnected,
  sessionExpired,
  unauthenticated,
} from "../lib/errors";
import { prisma } from "../lib/prisma";
import { env } from "../config/env";
import { safeEqual } from "../lib/crypto";

/**
 * Attach `req.auth` or reject with 401.
 *
 * The two failure modes are kept distinct on purpose: a missing cookie is
 * UNAUTHENTICATED (show the sign-in page), while a validly-signed cookie whose
 * session is gone is SESSION_EXPIRED (tell the user why they were signed out).
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  try {
    const token = readSessionCookie(req);
    if (!token) {
      next(unauthenticated());
      return;
    }

    const claims = verifySessionToken(token);
    if (!claims) {
      clearStaleCookie(res);
      next(sessionExpired());
      return;
    }

    const auth = await resolveAuthContext(claims.sid);
    if (!auth) {
      clearStaleCookie(res);
      next(sessionExpired());
      return;
    }

    req.auth = auth;

    // Fire-and-forget: presence tracking must not add latency to the request.
    void touchSession(auth.sessionId);

    next();
  } catch (e) {
    next(e);
  }
};

/**
 * Populate `req.auth` when a valid session exists, but never reject.
 *
 * Used by endpoints that behave differently for signed-in users without
 * requiring it (e.g. the public health endpoint, or a landing-page counter).
 */
export const optionalAuth: RequestHandler = async (req, _res, next) => {
  try {
    const token = readSessionCookie(req);
    if (!token) return next();

    const claims = verifySessionToken(token);
    if (!claims) return next();

    const auth = await resolveAuthContext(claims.sid);
    if (auth) req.auth = auth;

    next();
  } catch {
    // An unreadable optional session is simply an anonymous request.
    next();
  }
};

function clearStaleCookie(res: Response): void {
  res.clearCookie(env.COOKIE_NAME, {
    path: "/",
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}

/**
 * Require that the caller has a usable GitHub connection.
 *
 * Placed on routes that will certainly hit the GitHub API, so the user gets a
 * clear "connect GitHub" prompt instead of a confusing upstream error partway
 * through an operation.
 */
export const requireGithubConnection: RequestHandler = async (req, _res, next) => {
  try {
    const { userId } = req.user();
    const connection = await prisma.githubConnection.findUnique({
      where: { userId },
      select: { revokedAt: true },
    });

    if (!connection || connection.revokedAt) {
      next(githubNotConnected());
      return;
    }

    next();
  } catch (e) {
    next(e);
  }
};

/**
 * Require a specific role within a team.
 *
 * Reads `req.params.teamId`. Membership alone is not enough for destructive
 * operations — only OWNER/ADMIN may mutate team composition.
 */
export function requireTeamRole(...allowed: Array<"OWNER" | "ADMIN" | "MEMBER" | "VIEWER">) {
  return async function check(req: Request, _res: Response, next: NextFunction) {
    try {
      const { userId } = req.user();
      // Express 5 types param values as `string | string[]`; only a single
      // value is meaningful here.
      const raw = req.params.teamId;
      const teamId = typeof raw === "string" ? raw : undefined;

      if (!teamId) {
        next(forbidden("No team specified"));
        return;
      }

      const membership = await prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId } },
        select: { role: true },
      });

      // Deliberately a 404-style message: we do not confirm the existence of
      // teams the caller cannot see.
      if (!membership) {
        next(forbidden("You do not have access to this team"));
        return;
      }

      if (!allowed.includes(membership.role)) {
        next(
          forbidden(
            `This action requires one of the following team roles: ${allowed.join(", ")}`,
          ),
        );
        return;
      }

      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * Guard for internal service-to-service calls (currently unused by the ML
 * service, which is called outbound-only, but required by the webhook-style
 * endpoints the ML service could call back on).
 *
 * Compared in constant time so the token cannot be discovered by timing.
 */
export const requireInternalToken: RequestHandler = (req, _res, next) => {
  const provided = req.header("x-internal-token") ?? "";
  if (!env.ML_SERVICE_TOKEN || !safeEqual(provided, env.ML_SERVICE_TOKEN)) {
    next(forbidden("Invalid internal service token"));
    return;
  }
  next();
};
