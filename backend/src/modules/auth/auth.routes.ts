/**
 * Auth routes.
 *
 * The OAuth endpoints redirect rather than returning JSON, because the browser
 * is the client for that leg of the flow. Failures redirect back to the app with
 * an error code in the query string, so the sign-in page can show a real message
 * instead of dumping the user on a blank JSON error.
 */
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env";
import { asyncHandler } from "../../middleware/error";
import { validate, shortText } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { authLimiter } from "../../middleware/rateLimit";
import { scoped } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { errorMessage, isAppError } from "../../lib/errors";
import {
  beginGithubOAuth,
  completeGithubOAuth,
  getCurrentUser,
  sanitiseNextPath,
  signInAsDemo,
} from "./auth.service";
import {
  readSessionCookie,
  revokeAllSessions,
  revokeSession,
  sessionCookieOptions,
  verifySessionToken,
} from "./session.service";
import { revokeConnection } from "../github/github.service";

const log = scoped("auth-routes");
const router = Router();

/** Redirect back into the app, carrying an error the sign-in page can render. */
function redirectWithError(code: string, message: string): string {
  const params = new URLSearchParams({ error: code, message });
  return `${env.APP_URL}/login?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// GET /auth/github — begin sign-in
// ---------------------------------------------------------------------------
router.get(
  "/github",
  authLimiter,
  validate({ query: z.object({ next: z.string().max(512).optional() }) }),
  asyncHandler(async (req, res) => {
    const next = (req.query as { next?: string }).next;

    // In mock mode there is no third party to visit, so the callback is invoked
    // directly. This is what lets the whole flow be exercised offline.
    if (env.GITHUB_MODE === "mock") {
      const { state } = await beginGithubOAuth(next);
      res.redirect(
        `${env.API_URL}${env.apiPrefix}/auth/github/callback?code=mock_code&state=${state}`,
      );
      return;
    }

    const { url } = await beginGithubOAuth(next);
    res.redirect(url);
  }),
);

// ---------------------------------------------------------------------------
// GET /auth/github/callback — finish sign-in
// ---------------------------------------------------------------------------
router.get(
  "/github/callback",
  authLimiter,
  asyncHandler(async (req, res) => {
    const query = req.query as Record<string, string | undefined>;

    // GitHub reports user-side refusal here rather than as an HTTP error.
    if (query.error) {
      log.warn({ error: query.error, description: query.error_description }, "oauth denied");
      res.redirect(
        redirectWithError(
          query.error === "access_denied" ? "ACCESS_DENIED" : "GITHUB_AUTH_FAILED",
          query.error === "access_denied"
            ? "GitHub authorization was cancelled."
            : (query.error_description ?? "GitHub sign-in failed."),
        ),
      );
      return;
    }

    if (!query.code || !query.state) {
      res.redirect(
        redirectWithError("GITHUB_AUTH_FAILED", "The sign-in response was incomplete."),
      );
      return;
    }

    try {
      const result = await completeGithubOAuth(query.code, query.state, {
        userAgent: req.header("user-agent"),
        ip: req.ip,
      });

      res.cookie(env.COOKIE_NAME, result.session.token, sessionCookieOptions());

      const destination = result.user.isNew ? "/repositories/connect" : result.next;
      res.redirect(`${env.APP_URL}${sanitiseNextPath(destination)}`);
    } catch (e) {
      const code = isAppError(e) ? e.code : "GITHUB_AUTH_FAILED";
      const message = isAppError(e) ? e.message : "Sign-in failed. Please try again.";
      log.warn({ err: errorMessage(e), code }, "oauth callback failed");
      res.redirect(redirectWithError(code, message));
    }
  }),
);

// ---------------------------------------------------------------------------
// POST /auth/demo — seeded demo account
// ---------------------------------------------------------------------------
router.post(
  "/demo",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { session, user } = await signInAsDemo({
      userAgent: req.header("user-agent"),
      ip: req.ip,
    });

    res.cookie(env.COOKIE_NAME, session.token, sessionCookieOptions());
    res.json({
      data: {
        user,
        expiresAt: session.expiresAt.toISOString(),
        redirectTo: "/dashboard",
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /auth/me — current user
// ---------------------------------------------------------------------------
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await getCurrentUser(req.user().userId);
    res.json({ data: user });
  }),
);

// ---------------------------------------------------------------------------
// GET /auth/session — cheap "am I signed in" probe
// ---------------------------------------------------------------------------
// Deliberately unauthenticated so the frontend can distinguish "signed out"
// from "request failed" without treating a 401 as an error condition.
router.get(
  "/session",
  asyncHandler(async (req, res) => {
    const token = readSessionCookie(req);
    const claims = token ? verifySessionToken(token) : null;
    res.json({
      data: {
        authenticated: claims !== null,
        githubMode: env.GITHUB_MODE,
        githubConfigured: env.githubConfigured,
        demoLoginEnabled: env.ENABLE_DEMO_LOGIN,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
router.post(
  "/logout",
  requireAuth,
  validate({ body: z.object({ allDevices: z.boolean().optional() }).default({}) }),
  asyncHandler(async (req, res) => {
    const auth = req.user();
    const { allDevices } = req.body as { allDevices?: boolean };

    if (allDevices) {
      const count = await revokeAllSessions(auth.userId);
      res.clearCookie(env.COOKIE_NAME, { path: "/" });
      res.json({ data: { signedOut: true, sessionsRevoked: count } });
      return;
    }

    await revokeSession(auth.sessionId);
    res.clearCookie(env.COOKIE_NAME, { path: "/" });
    res.json({ data: { signedOut: true, sessionsRevoked: 1 } });
  }),
);

// ---------------------------------------------------------------------------
// POST /auth/github/disconnect — revoke the GitHub credential, keep the account
// ---------------------------------------------------------------------------
router.post(
  "/github/disconnect",
  requireAuth,
  asyncHandler(async (req, res) => {
    await revokeConnection(req.user().userId);
    res.json({
      data: {
        disconnected: true,
        message:
          "GitHub has been disconnected. Your repositories and past analyses are kept, " +
          "but no new data can be fetched until you reconnect.",
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// PATCH /auth/me — the small amount of profile a user can edit
// ---------------------------------------------------------------------------
router.patch(
  "/me",
  requireAuth,
  validate({
    body: z.object({
      name: shortText(120).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    const body = req.body as { name?: string };

    await prisma.user.update({
      where: { id: req.user().userId },
      data: { ...(body.name !== undefined ? { name: body.name } : {}) },
    });

    res.json({ data: await getCurrentUser(req.user().userId) });
  }),
);

export default router;
