/**
 * Authentication flows.
 *
 * GitHub OAuth, done properly:
 *
 *  - the `state` parameter is a random value stored in Redis with a short TTL
 *    and consumed on callback, which is what prevents CSRF on the sign-in
 *    endpoint. A callback with an unknown state is rejected, not tolerated;
 *  - the `next` path a user was heading to travels *with* the state on the
 *    server, never in the query string, so it cannot be turned into an open
 *    redirect;
 *  - the access token is encrypted before it is stored, and the plaintext exists
 *    only for the duration of this function.
 */
import { prisma } from "../../lib/prisma";
import { redis } from "../../lib/redis";
import { env } from "../../config/env";
import { scoped } from "../../lib/logger";
import { randomToken } from "../../lib/crypto";
import { CACHE_KEYS, OAUTH_STATE_TTL_SECONDS } from "../../config/constants";
import { AppError, badRequest, forbidden } from "../../lib/errors";
import { getProvider, saveUserToken } from "../github/github.service";
import { createSession, type IssuedSession } from "./session.service";
import { createNotification } from "../notifications/notification.service";

const log = scoped("auth");

// ---------------------------------------------------------------------------
// Step 1 — begin
// ---------------------------------------------------------------------------

export interface AuthorizeUrl {
  url: string;
  state: string;
}

/**
 * Build the GitHub authorize URL and remember the state.
 *
 * The returned `state` is opaque to the client; the only thing that can redeem
 * it is a callback arriving within the TTL.
 */
export async function beginGithubOAuth(nextPath?: string): Promise<AuthorizeUrl> {
  if (env.GITHUB_MODE === "live" && !env.githubConfigured) {
    throw new AppError(
      503,
      "GitHub sign-in is not configured on this deployment. " +
        "Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or set GITHUB_MODE=mock.",
      { code: "GITHUB_NOT_CONFIGURED", retryable: false },
    );
  }

  const state = randomToken(32);

  // Only relative in-app paths are stored, so a crafted `next` cannot redirect
  // the user off-site after sign-in.
  const safeNext = sanitiseNextPath(nextPath);

  await redis.set(
    CACHE_KEYS.oauthState(state),
    JSON.stringify({ next: safeNext, createdAt: Date.now() }),
    "EX",
    OAUTH_STATE_TTL_SECONDS,
  );

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_CALLBACK_URL,
    scope: (env.GITHUB_OAUTH_SCOPES as string[]).join(" "),
    state,
    allow_signup: "true",
  });

  return { url: `https://github.com/login/oauth/authorize?${params.toString()}`, state };
}

/** Accept only same-origin, non-protocol-relative paths. */
export function sanitiseNextPath(nextPath?: string): string {
  const fallback = "/dashboard";
  if (!nextPath) return fallback;
  if (!nextPath.startsWith("/")) return fallback;
  if (nextPath.startsWith("//")) return fallback; // protocol-relative
  if (nextPath.includes("://")) return fallback;
  if (nextPath.length > 512) return fallback;
  return nextPath;
}

// ---------------------------------------------------------------------------
// Step 2 — callback
// ---------------------------------------------------------------------------

export interface CompletedOAuth {
  session: IssuedSession;
  next: string;
  user: { id: string; githubLogin: string; isNew: boolean };
}

export async function completeGithubOAuth(
  code: string,
  state: string,
  meta: { userAgent?: string; ip?: string },
): Promise<CompletedOAuth> {
  // --- consume the state (single use) -------------------------------------
  const stateKey = CACHE_KEYS.oauthState(state);
  const stored = await redis.get(stateKey);
  await redis.del(stateKey);

  if (!stored) {
    throw badRequest(
      "This sign-in link has expired or was already used. Please start again.",
      { code: "GITHUB_AUTH_FAILED" },
    );
  }

  const { next } = JSON.parse(stored) as { next: string };

  // --- exchange the code --------------------------------------------------
  const provider = getProvider();
  const tokenResponse = await provider.exchangeOAuthCode(code, env.GITHUB_CALLBACK_URL);
  const accessToken = tokenResponse.access_token;

  const grantedScopes = (tokenResponse.scope ?? "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // --- identify the user --------------------------------------------------
  const ghUser = await provider.getAuthenticatedUser(accessToken);

  // The profile email is often null; fall back to the primary verified address.
  let email = ghUser.email;
  if (!email) {
    const emails = await provider.getAuthenticatedUserEmails(accessToken);
    email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
  }

  const existing = await prisma.user.findUnique({
    where: { githubId: BigInt(ghUser.id) },
    select: { id: true },
  });

  const user = await prisma.user.upsert({
    where: { githubId: BigInt(ghUser.id) },
    create: {
      githubId: BigInt(ghUser.id),
      githubLogin: ghUser.login,
      githubType: ghUser.type,
      name: ghUser.name,
      email,
      avatarUrl: ghUser.avatar_url,
      company: ghUser.company,
      location: ghUser.location,
      bio: ghUser.bio,
      lastSeenAt: new Date(),
    },
    update: {
      // Keep the mirror fresh, but never overwrite a stored email with null.
      githubLogin: ghUser.login,
      name: ghUser.name,
      avatarUrl: ghUser.avatar_url,
      company: ghUser.company,
      location: ghUser.location,
      bio: ghUser.bio,
      lastSeenAt: new Date(),
      ...(email ? { email } : {}),
    },
    select: { id: true, githubLogin: true },
  });

  await saveUserToken(user.id, accessToken, {
    scopes: grantedScopes,
    tokenType: tokenResponse.token_type,
    ...(tokenResponse.expires_in ? { expiresInSeconds: tokenResponse.expires_in } : {}),
  });

  const session = await createSession(user.id, meta);
  const isNew = existing === null;

  if (isNew) {
    await createNotification({
      userId: user.id,
      type: "SYSTEM",
      severity: "INFO",
      title: "Welcome to BugDNA",
      body: "Connect a repository to start analysing pull requests before they merge.",
      href: "/repositories/connect",
    });
  }

  log.info(
    { userId: user.id, githubLogin: user.githubLogin, isNew, scopes: grantedScopes },
    "github sign-in completed",
  );

  return {
    session,
    next,
    user: { id: user.id, githubLogin: user.githubLogin, isNew },
  };
}

// ---------------------------------------------------------------------------
// Demo sign-in
// ---------------------------------------------------------------------------

/**
 * Sign in as the seeded demo account.
 *
 * Exists so the product can be evaluated without anyone handing over GitHub
 * access. It is safe rather than merely convenient: the demo user owns only the
 * synthetic repositories created by the seed script, and the same tenancy
 * predicate that isolates real users isolates this one. It refuses to run unless
 * a user explicitly flagged `isDemo` exists, so it cannot be pointed at a real
 * account, and it can be switched off with ENABLE_DEMO_LOGIN=false.
 */
export async function signInAsDemo(meta: {
  userAgent?: string;
  ip?: string;
}): Promise<{ session: IssuedSession; user: { id: string; githubLogin: string } }> {
  if (!env.ENABLE_DEMO_LOGIN) {
    throw forbidden("Demo sign-in is disabled on this deployment.");
  }

  const demoUser = await prisma.user.findFirst({
    where: { isDemo: true, githubLogin: env.SEED_DEMO_LOGIN },
    select: { id: true, githubLogin: true },
  });

  if (!demoUser) {
    throw new AppError(
      503,
      "The demo account has not been seeded on this deployment. " +
        "Run `npm run seed` in the backend to create it.",
      { code: "NOT_FOUND", retryable: false },
    );
  }

  const session = await createSession(demoUser.id, meta);
  log.info({ userId: demoUser.id }, "demo sign-in");

  return { session, user: demoUser };
}

// ---------------------------------------------------------------------------
// Current user
// ---------------------------------------------------------------------------

export async function getCurrentUser(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      githubLogin: true,
      name: true,
      email: true,
      avatarUrl: true,
      company: true,
      location: true,
      bio: true,
      isDemo: true,
      createdAt: true,
      lastSeenAt: true,
      connection: {
        select: {
          scopes: true,
          connectedAt: true,
          lastSyncedAt: true,
          revokedAt: true,
          rateLimitRemaining: true,
          rateLimitResetAt: true,
        },
      },
      teamMemberships: {
        select: {
          role: true,
          team: { select: { id: true, name: true, slug: true, avatarUrl: true } },
        },
      },
      _count: { select: { repositories: true, analyses: true } },
    },
  });

  if (!user) throw new AppError(401, "Your account no longer exists.", {
    code: "SESSION_EXPIRED",
    retryable: false,
  });

  const connection = user.connection;
  const githubConnected = Boolean(connection && !connection.revokedAt);

  return {
    id: user.id,
    githubLogin: user.githubLogin,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    company: user.company,
    location: user.location,
    bio: user.bio,
    isDemo: user.isDemo,
    createdAt: user.createdAt.toISOString(),
    lastSeenAt: user.lastSeenAt?.toISOString() ?? null,
    github: {
      connected: githubConnected,
      mode: getProvider().mode,
      scopes: connection?.scopes ?? [],
      canReadPrivateRepos: (connection?.scopes ?? []).includes("repo"),
      connectedAt: connection?.connectedAt?.toISOString() ?? null,
      lastSyncedAt: connection?.lastSyncedAt?.toISOString() ?? null,
      rateLimitRemaining: connection?.rateLimitRemaining ?? null,
      rateLimitResetAt: connection?.rateLimitResetAt?.toISOString() ?? null,
    },
    teams: user.teamMemberships.map((m) => ({ ...m.team, role: m.role })),
    counts: {
      repositories: user._count.repositories,
      analyses: user._count.analyses,
    },
  };
}
