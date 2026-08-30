/**
 * Express request augmentation.
 *
 * `req.auth` is populated by the `requireAuth` / `optionalAuth` middleware and
 * is the single source of tenancy information for the request. Controllers read
 * from it rather than re-deriving identity, which is what keeps the isolation
 * rule in one place.
 */

/** Authenticated caller context, attached by the auth middleware. */
export interface AuthContext {
  userId: string;
  sessionId: string;
  githubLogin: string;
  /** Team ids the user belongs to — the second half of the tenancy predicate. */
  teamIds: string[];
  isDemo: boolean;
}

declare global {
  namespace Express {
    interface Request {
      /** Correlation id, echoed back as the `x-request-id` response header. */
      id: string;
      /** Present only after `requireAuth`; use `req.user()` for a checked read. */
      auth?: AuthContext;
      /** Throws if unauthenticated — lets controllers avoid non-null assertions. */
      user(): AuthContext;
      /** High-resolution start time, used to report request duration. */
      startedAt: number;
    }
  }
}

export {};
