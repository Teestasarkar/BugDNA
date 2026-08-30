/**
 * Outbound HTTP.
 *
 * A small wrapper over global `fetch` (Node 18+) that adds the three things
 * every real integration needs and `fetch` does not give you: a hard timeout,
 * bounded retries with backoff and jitter, and a response-size ceiling.
 *
 * Deliberately dependency-free. It replaces what would otherwise be axios plus
 * a retry plugin, and it lets the GitHub client own its rate-limit semantics
 * rather than fighting an abstraction.
 */
import { scoped } from "./logger";

const log = scoped("http");

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** Serialised as JSON unless it is already a string. */
  body?: unknown;
  timeoutMs?: number;
  /** Number of *additional* attempts after the first. */
  retries?: number;
  retryDelayMs?: number;
  /** Which statuses are worth retrying. Defaults to 429 + 5xx. */
  retryOn?: (status: number) => boolean;
  /** Abort if the response body exceeds this many bytes. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  /** Label used in logs. */
  label?: string;
}

export interface HttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  headers: Headers;
  data: T;
  /** Raw text, retained for error reporting when JSON parsing fails. */
  raw: string;
  attempts: number;
  durationMs: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
    readonly headers?: Headers,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class HttpTimeoutError extends Error {
  constructor(readonly timeoutMs: number, readonly url: string) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = "HttpTimeoutError";
  }
}

export class HttpNetworkError extends Error {
  constructor(readonly url: string, cause: unknown) {
    super(`Network error calling ${url}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "HttpNetworkError";
    this.cause = cause;
  }
}

const defaultRetryOn = (status: number) => status === 429 || status >= 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Full jitter backoff. Prevents a fleet of workers from retrying in lockstep
 * and re-hammering an upstream that is already struggling.
 */
function backoffDelay(attempt: number, baseMs: number): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  return Math.min(30_000, Math.round(Math.random() * exponential));
}

export async function request<T = unknown>(
  url: string,
  options: RequestOptions = {},
): Promise<HttpResponse<T>> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 15_000,
    retries = 0,
    retryDelayMs = 500,
    retryOn = defaultRetryOn,
    maxResponseBytes,
    signal: externalSignal,
    label = "http",
  } = options;

  const started = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);

    // Propagate caller cancellation (e.g. a job being cancelled).
    const onExternalAbort = () => controller.abort(new Error("aborted by caller"));
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    try {
      const requestHeaders: Record<string, string> = { ...headers };
      let payload: string | undefined;

      if (body !== undefined) {
        if (typeof body === "string") {
          payload = body;
        } else {
          payload = JSON.stringify(body);
          requestHeaders["content-type"] ??= "application/json";
        }
      }

      const res = await fetch(url, {
        method,
        headers: requestHeaders,
        body: payload,
        signal: controller.signal,
      });

      // Enforce a size ceiling before buffering the whole body.
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (maxResponseBytes && declared > maxResponseBytes) {
        throw new HttpError(
          res.status,
          `Response from ${url} is ${declared} bytes, exceeding the ${maxResponseBytes} byte limit`,
          undefined,
          res.headers,
        );
      }

      const raw = await res.text();

      if (maxResponseBytes && raw.length > maxResponseBytes) {
        throw new HttpError(
          res.status,
          `Response from ${url} exceeded the ${maxResponseBytes} byte limit`,
          undefined,
          res.headers,
        );
      }

      let data: T;
      try {
        data = raw ? (JSON.parse(raw) as T) : (undefined as T);
      } catch {
        data = raw as unknown as T;
      }

      const response: HttpResponse<T> = {
        ok: res.ok,
        status: res.status,
        headers: res.headers,
        data,
        raw,
        attempts: attempt,
        durationMs: Date.now() - started,
      };

      if (!res.ok && retryOn(res.status) && attempt <= retries) {
        // Honour Retry-After when the upstream tells us how long to wait.
        const retryAfter = Number(res.headers.get("retry-after") ?? "0");
        const delay = retryAfter > 0 ? retryAfter * 1000 : backoffDelay(attempt, retryDelayMs);
        log.warn(
          { label, url, status: res.status, attempt, delay },
          "retryable upstream status, backing off",
        );
        await sleep(delay);
        continue;
      }

      return response;
    } catch (e) {
      lastError = e;

      const isAbort = e instanceof Error && e.name === "AbortError";
      const isTimeout = isAbort && !externalSignal?.aborted;

      if (isTimeout) lastError = new HttpTimeoutError(timeoutMs, url);
      else if (!(e instanceof HttpError) && !isAbort) lastError = new HttpNetworkError(url, e);

      // A caller-initiated abort is not a failure to retry.
      if (isAbort && externalSignal?.aborted) throw lastError;
      if (e instanceof HttpError) throw e;

      if (attempt <= retries) {
        const delay = backoffDelay(attempt, retryDelayMs);
        log.warn({ label, url, attempt, delay, err: (lastError as Error).message }, "request failed, retrying");
        await sleep(delay);
        continue;
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  throw lastError ?? new HttpNetworkError(url, new Error("exhausted retries"));
}

export const httpGet = <T>(url: string, o: Omit<RequestOptions, "method" | "body"> = {}) =>
  request<T>(url, { ...o, method: "GET" });

export const httpPost = <T>(url: string, body: unknown, o: Omit<RequestOptions, "method"> = {}) =>
  request<T>(url, { ...o, method: "POST", body });
