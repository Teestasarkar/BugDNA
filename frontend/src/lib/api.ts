/**
 * API client.
 *
 * A thin typed wrapper over `fetch` with three responsibilities:
 *
 *  1. **Send the session cookie.** `credentials: "include"` on every request,
 *     because the API authenticates with an httpOnly cookie.
 *  2. **Turn the API's error envelope into a typed `ApiError`.** The backend
 *     always returns `{ error: { code, message, retryable } }` on failure, so
 *     the UI can switch on a stable code and know whether to offer a retry —
 *     rather than pattern-matching on message strings.
 *  3. **Keep TanStack Query honest.** Throwing a typed error is what lets the
 *     query layer decide what is worth retrying: a 401 or a validation failure
 *     never is, an upstream timeout is.
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/+$/, "");

export const API_PREFIX = "/api/v1";

/** Stable error codes, mirroring backend/src/lib/errors.ts. */
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PAYLOAD_TOO_LARGE"
  | "INTERNAL"
  | "DATABASE_ERROR"
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
  | "ML_UNAVAILABLE"
  | "ML_TIMEOUT"
  | "ML_INVALID_RESPONSE"
  | "ML_MODEL_NOT_LOADED"
  | "ANALYSIS_FAILED"
  | "ANALYSIS_IN_PROGRESS"
  | "ANALYSIS_NOT_COMPLETED"
  | "QUEUE_UNAVAILABLE"
  | "NETWORK_ERROR"
  | "UNKNOWN";

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;
  readonly requestId?: string;

  constructor(init: {
    status: number;
    code: ApiErrorCode;
    message: string;
    retryable?: boolean;
    details?: unknown;
    retryAfterSeconds?: number;
    requestId?: string;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable ?? init.status >= 500;
    this.details = init.details;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.requestId = init.requestId;
  }

  /** True when the user needs to sign in again. */
  get isAuthError(): boolean {
    return this.code === "UNAUTHENTICATED" || this.code === "SESSION_EXPIRED";
  }

  /** True when the fix is to connect or reconnect GitHub. */
  get needsGithub(): boolean {
    return (
      this.code === "GITHUB_NOT_CONNECTED" ||
      this.code === "GITHUB_TOKEN_INVALID" ||
      this.code === "GITHUB_NOT_CONFIGURED"
    );
  }

  /** Field-level issues, when this was a validation failure. */
  get validationIssues(): ValidationIssue[] {
    if (this.code !== "VALIDATION_FAILED" || !Array.isArray(this.details)) return [];
    return this.details as ValidationIssue[];
  }
}

/** Envelope every successful response uses. */
export interface ApiResponse<T, M = unknown> {
  data: T;
  meta?: M;
}

export interface PaginationMeta {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  unreadCount?: number;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /**
   * Query parameters. Undefined, null and empty-string values are dropped;
   * arrays are serialised as repeated keys, which is what the backend's
   * multi-value schemas expect.
   */
  params?: Record<string, unknown>;
  /** Per-request timeout. */
  timeoutMs?: number;
}

function buildUrl(
  path: string,
  params?: RequestOptions["params"],
): string {
  const url = new URL(
    `${API_BASE}${path.startsWith("/api") ? "" : API_PREFIX}${path}`,
  );

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item === undefined || item === null) continue;
          url.searchParams.append(key, String(item));
        }
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

/**
 * Core request.
 *
 * Network-level failures become an ApiError with code NETWORK_ERROR, so callers
 * never have to distinguish "the server said no" from "the server was
 * unreachable" unless they want to.
 */
export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, params, timeoutMs = 30_000, headers, ...rest } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;

  try {
    response = await fetch(buildUrl(path, params), {
      ...rest,
      // The session lives in an httpOnly cookie on the API's origin.
      credentials: "include",
      signal: options.signal ?? controller.signal,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    clearTimeout(timer);

    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError({
        status: 0,
        code: "NETWORK_ERROR",
        message: "The request took too long. Check your connection and try again.",
        retryable: true,
      });
    }

    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message:
        "Could not reach the BugDNA API. It may be starting up, or your connection may be down.",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const requestId = response.headers.get("x-request-id") ?? undefined;

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown;

  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    // A non-JSON body from a JSON API means something in front of it failed —
    // typically an Nginx error page.
    throw new ApiError({
      status: response.status,
      code: response.ok ? "UNKNOWN" : "INTERNAL",
      message: response.ok
        ? "The API returned a response that could not be read."
        : `The API returned an unexpected ${response.status} response.`,
      retryable: !response.ok && response.status >= 500,
      requestId,
    });
  }

  if (!response.ok) {
    const envelope = payload as
      | { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown; retryAfterSeconds?: number } }
      | undefined;

    const error = envelope?.error;

    throw new ApiError({
      status: response.status,
      code: (error?.code as ApiErrorCode) ?? "UNKNOWN",
      message: error?.message ?? `Request failed with status ${response.status}.`,
      retryable: error?.retryable,
      details: error?.details,
      retryAfterSeconds: error?.retryAfterSeconds,
      requestId,
    });
  }

  // Unwrap the `{ data }` envelope so callers work with the payload directly.
  const envelope = payload as ApiResponse<T> | undefined;
  return (envelope && "data" in envelope ? envelope.data : (payload as T)) as T;
}

/** Request that also returns `meta` (pagination, cache hints). */
export async function apiRequestWithMeta<T, M = PaginationMeta>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; meta?: M }> {
  const { body, params, timeoutMs = 30_000, headers, ...rest } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(buildUrl(path, params), {
      ...rest,
      credentials: "include",
      signal: options.signal ?? controller.signal,
      headers: {
        accept: "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error instanceof DOMException && error.name === "AbortError";
    throw new ApiError({
      status: 0,
      code: "NETWORK_ERROR",
      message: aborted
        ? "The request took too long. Check your connection and try again."
        : "Could not reach the BugDNA API.",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : undefined;

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; retryable?: boolean; details?: unknown } })?.error;
    throw new ApiError({
      status: response.status,
      code: (error?.code as ApiErrorCode) ?? "UNKNOWN",
      message: error?.message ?? `Request failed with status ${response.status}.`,
      retryable: error?.retryable,
      details: error?.details,
      requestId: response.headers.get("x-request-id") ?? undefined,
    });
  }

  const envelope = payload as ApiResponse<T, M>;
  return { data: envelope.data, meta: envelope.meta };
}

// ---------------------------------------------------------------------------
// Verb helpers
// ---------------------------------------------------------------------------

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "GET" }),

  getWithMeta: <T, M = PaginationMeta>(
    path: string,
    options?: Omit<RequestOptions, "method" | "body">,
  ) => apiRequestWithMeta<T, M>(path, { ...options, method: "GET" }),

  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method">) =>
    apiRequest<T>(path, { ...options, method: "POST", body }),

  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, "method">) =>
    apiRequest<T>(path, { ...options, method: "PATCH", body }),

  delete: <T>(path: string, options?: Omit<RequestOptions, "method" | "body">) =>
    apiRequest<T>(path, { ...options, method: "DELETE" }),
};

/** Absolute URL for a browser navigation (the OAuth redirect). */
export function apiUrl(path: string): string {
  return `${API_BASE}${path.startsWith("/api") ? "" : API_PREFIX}${path}`;
}

export { API_BASE };
