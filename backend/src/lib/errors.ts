/**
 * Error taxonomy.
 *
 * Every failure the API can produce is one of these. Each carries an HTTP
 * status, a stable machine-readable `code` the frontend switches on, and an
 * operator-safe `message`. Unexpected throws are converted to a generic 500 by
 * the error middleware so internal details never reach a client.
 *
 * `retryable` drives the UI's retry affordances: the frontend shows a "Try
 * again" button only where retrying can actually help.
 */

export type ErrorCode =
  // 4xx — client
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  // 5xx — server / upstream
  | "INTERNAL"
  | "DATABASE_ERROR"
  | "CACHE_ERROR"
  // GitHub integration
  | "GITHUB_NOT_CONNECTED"
  | "GITHUB_NOT_CONFIGURED"
  | "GITHUB_AUTH_FAILED"
  | "GITHUB_TOKEN_INVALID"
  | "GITHUB_RATE_LIMITED"
  | "GITHUB_FORBIDDEN"
  | "GITHUB_NOT_FOUND"
  | "GITHUB_UNAVAILABLE"
  | "DIFF_UNAVAILABLE"
  | "DIFF_TOO_LARGE"
  // ML service
  | "ML_UNAVAILABLE"
  | "ML_TIMEOUT"
  | "ML_INVALID_RESPONSE"
  | "ML_MODEL_NOT_LOADED"
  // analysis pipeline
  | "ANALYSIS_FAILED"
  | "ANALYSIS_IN_PROGRESS"
  | "ANALYSIS_NOT_COMPLETED"
  | "QUEUE_UNAVAILABLE";

export interface AppErrorOptions {
  /** Machine-readable, stable across releases. */
  code?: ErrorCode;
  /** Structured detail safe to show a client (e.g. field validation errors). */
  details?: unknown;
  /** Can the same request succeed if retried? Drives UI retry buttons. */
  retryable?: boolean;
  /** Seconds after which a retry is sensible (surfaced as Retry-After). */
  retryAfterSeconds?: number;
  /** Original error, logged but never serialised to the client. */
  cause?: unknown;
  /** Extra context for logs only. */
  context?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly context?: Record<string, unknown>;
  /** Distinguishes deliberate errors from genuine bugs in logs. */
  readonly expected = true;

  constructor(status: number, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.status = status;
    this.code = options.code ?? defaultCodeForStatus(status);
    this.details = options.details;
    this.retryable = options.retryable ?? status >= 500;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.context = options.context;
    Error.captureStackTrace?.(this, AppError);
  }

  /** Client-facing shape. Never includes `cause` or `context`. */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        status: this.status,
        retryable: this.retryable,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(this.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: this.retryAfterSeconds }
          : {}),
      },
    };
  }
}

function defaultCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL" : "BAD_REQUEST";
  }
}

// ---------------------------------------------------------------------------
// Constructors — used instead of `new AppError(...)` so call sites read well
// and status/code pairings stay consistent.
// ---------------------------------------------------------------------------

export const badRequest = (message: string, o: AppErrorOptions = {}) =>
  new AppError(400, message, { code: "BAD_REQUEST", retryable: false, ...o });

export const validationFailed = (details: unknown, message = "Request validation failed") =>
  new AppError(400, message, { code: "VALIDATION_FAILED", details, retryable: false });

export const unauthenticated = (message = "Authentication required", o: AppErrorOptions = {}) =>
  new AppError(401, message, { code: "UNAUTHENTICATED", retryable: false, ...o });

export const sessionExpired = (message = "Your session has expired. Please sign in again.") =>
  new AppError(401, message, { code: "SESSION_EXPIRED", retryable: false });

export const forbidden = (message = "You do not have access to this resource", o: AppErrorOptions = {}) =>
  new AppError(403, message, { code: "FORBIDDEN", retryable: false, ...o });

export const notFound = (resource = "Resource", o: AppErrorOptions = {}) =>
  new AppError(404, `${resource} not found`, { code: "NOT_FOUND", retryable: false, ...o });

export const conflict = (message: string, o: AppErrorOptions = {}) =>
  new AppError(409, message, { code: "CONFLICT", retryable: false, ...o });

export const rateLimited = (message = "Too many requests", retryAfterSeconds?: number) =>
  new AppError(429, message, {
    code: "RATE_LIMITED",
    retryable: true,
    retryAfterSeconds,
  });

export const internal = (message = "An unexpected error occurred", o: AppErrorOptions = {}) =>
  new AppError(500, message, { code: "INTERNAL", retryable: true, ...o });

export const serviceUnavailable = (message: string, o: AppErrorOptions = {}) =>
  new AppError(503, message, { code: "INTERNAL", retryable: true, ...o });

// --- GitHub -----------------------------------------------------------------

export const githubNotConnected = () =>
  new AppError(400, "Connect your GitHub account to continue", {
    code: "GITHUB_NOT_CONNECTED",
    retryable: false,
  });

export const githubNotConfigured = () =>
  new AppError(
    503,
    "GitHub sign-in is not configured on this deployment. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.",
    { code: "GITHUB_NOT_CONFIGURED", retryable: false },
  );

export const githubTokenInvalid = () =>
  new AppError(
    401,
    "Your GitHub authorization is no longer valid. Please reconnect GitHub.",
    { code: "GITHUB_TOKEN_INVALID", retryable: false },
  );

export const githubRateLimited = (resetAt?: Date) =>
  new AppError(
    429,
    resetAt
      ? `GitHub API rate limit reached. Access resets at ${resetAt.toISOString()}.`
      : "GitHub API rate limit reached.",
    {
      code: "GITHUB_RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: resetAt
        ? Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000))
        : undefined,
      details: resetAt ? { resetAt: resetAt.toISOString() } : undefined,
    },
  );

export const githubUnavailable = (cause?: unknown) =>
  new AppError(502, "GitHub is currently unreachable. Please try again.", {
    code: "GITHUB_UNAVAILABLE",
    retryable: true,
    cause,
  });

export const diffUnavailable = (reason?: string) =>
  new AppError(
    502,
    reason
      ? `Could not retrieve the diff for this pull request: ${reason}`
      : "Could not retrieve the diff for this pull request.",
    { code: "DIFF_UNAVAILABLE", retryable: true },
  );

// --- ML service -------------------------------------------------------------

export const mlUnavailable = (cause?: unknown) =>
  new AppError(
    503,
    "The risk analysis service is temporarily unavailable. The analysis will be retried.",
    { code: "ML_UNAVAILABLE", retryable: true, cause },
  );

export const mlTimeout = (ms: number) =>
  new AppError(504, `The risk analysis service did not respond within ${ms}ms.`, {
    code: "ML_TIMEOUT",
    retryable: true,
  });

export const mlInvalidResponse = (details?: unknown) =>
  new AppError(502, "The risk analysis service returned an unexpected response.", {
    code: "ML_INVALID_RESPONSE",
    retryable: true,
    details,
  });

// --- analysis ---------------------------------------------------------------

export const analysisInProgress = (analysisId: string) =>
  new AppError(409, "An analysis is already running for this commit.", {
    code: "ANALYSIS_IN_PROGRESS",
    retryable: false,
    details: { analysisId },
  });

export const analysisNotCompleted = (status: string) =>
  new AppError(409, `This analysis is ${status.toLowerCase()} and has no results yet.`, {
    code: "ANALYSIS_NOT_COMPLETED",
    retryable: true,
    details: { status },
  });

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Best-effort message extraction for logging arbitrary throws. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
