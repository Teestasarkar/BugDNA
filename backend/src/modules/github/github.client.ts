/**
 * Live GitHub REST client.
 *
 * Written directly against `fetch` rather than using Octokit, for three
 * concrete reasons:
 *
 *  - Octokit v21+ is ESM-only, which conflicts with this CommonJS build;
 *  - rate-limit and conditional-request behaviour is the part of the GitHub
 *    integration that most affects the product, and it should be explicit
 *    rather than buried in a plugin;
 *  - it keeps the dependency surface small for something this central.
 *
 * Behaviour worth knowing about:
 *
 *  - **Conditional requests.** ETags are cached in Redis. A 304 costs no rate
 *    limit at all, which is what makes repeated PR polling viable.
 *  - **Rate limits** are parsed from every response and returned to callers, so
 *    the UI can warn the user before requests start failing.
 *  - **Errors are translated** into the app's taxonomy at this boundary, so no
 *    caller ever sees a raw GitHub status code.
 */
import { env } from "../../config/env";
import { scoped } from "../../lib/logger";
import { request, HttpTimeoutError, HttpNetworkError } from "../../lib/http";
import { cacheGet, cacheSet } from "../../lib/cache";
import { CACHE_KEYS } from "../../config/constants";
import {
  AppError,
  githubRateLimited,
  githubTokenInvalid,
  githubUnavailable,
} from "../../lib/errors";
import type {
  GhDeployment,
  GhEmail,
  GhOAuthTokenResponse,
  GhPullRequestDetail,
  GhPullRequestFile,
  GhPullRequestSummary,
  GhRateLimit,
  GhRepository,
  GhUser,
  GitHubProvider,
  ListPullRequestsOptions,
  ListRepositoriesOptions,
  Paged,
} from "./github.types";

const log = scoped("github");

const API = env.GITHUB_API_BASE;
const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

/** How long an ETag stays usable. Long: GitHub tells us when content changed. */
const ETAG_TTL_SECONDS = 24 * 60 * 60;

interface CachedEtagEntry<T> {
  etag: string;
  data: T;
  hasNextPage: boolean;
}

function headers(token: string): Record<string, string> {
  return {
    accept: ACCEPT,
    authorization: `Bearer ${token}`,
    "x-github-api-version": API_VERSION,
    "user-agent": "BugDNA/1.0 (+https://github.com/Teestasarkar/BugDNA)",
  };
}

function parseRateLimit(h: Headers): GhRateLimit | undefined {
  const limit = h.get("x-ratelimit-limit");
  const remaining = h.get("x-ratelimit-remaining");
  const reset = h.get("x-ratelimit-reset");
  if (!limit || !remaining || !reset) return undefined;

  return {
    limit: Number(limit),
    remaining: Number(remaining),
    used: Number(h.get("x-ratelimit-used") ?? "0"),
    resetAt: new Date(Number(reset) * 1000),
  };
}

/** GitHub advertises further pages via `Link: <...>; rel="next"`. */
function hasNextPage(h: Headers): boolean {
  return (h.get("link") ?? "").includes('rel="next"');
}

/**
 * Translate a GitHub failure into our error taxonomy.
 *
 * The 403-vs-429 distinction matters: GitHub returns 403 for rate limiting
 * *and* for genuine permission failures, distinguished only by the
 * `x-ratelimit-remaining` header. Getting this wrong would tell users they lack
 * access when they are merely throttled.
 */
function translateError(status: number, body: unknown, h: Headers, context: string): AppError {
  const rate = parseRateLimit(h);
  const message =
    typeof body === "object" && body !== null && "message" in body
      ? String((body as { message: unknown }).message)
      : "";

  if (status === 401) return githubTokenInvalid();

  if (status === 403 || status === 429) {
    const exhausted = rate?.remaining === 0;
    const secondary = /secondary rate limit|abuse detection/i.test(message);
    if (exhausted || secondary || status === 429) {
      return githubRateLimited(rate?.resetAt);
    }
    return new AppError(
      403,
      message ||
        `Your GitHub authorization does not grant access to ${context}. ` +
          `Re-connect GitHub and grant the "repo" scope if this is a private repository.`,
      { code: "GITHUB_FORBIDDEN", retryable: false },
    );
  }

  if (status === 404) {
    return new AppError(
      404,
      `${context} was not found on GitHub, or your account cannot see it.`,
      { code: "GITHUB_NOT_FOUND", retryable: false },
    );
  }

  if (status === 422) {
    return new AppError(400, message || `GitHub rejected the request for ${context}.`, {
      code: "BAD_REQUEST",
      retryable: false,
      details: body,
    });
  }

  if (status >= 500) {
    return new AppError(502, "GitHub is having trouble responding. Please try again.", {
      code: "GITHUB_UNAVAILABLE",
      retryable: true,
      context: { githubStatus: status },
    });
  }

  return new AppError(502, message || `Unexpected GitHub response for ${context}.`, {
    code: "GITHUB_UNAVAILABLE",
    retryable: true,
    context: { githubStatus: status },
  });
}

interface GhCallOptions {
  token: string;
  /** Human-readable subject used in error messages. */
  context: string;
  /** Cache key for the ETag entry; omit to skip conditional requests. */
  etagKey?: string;
  timeoutMs?: number;
  retries?: number;
  maxResponseBytes?: number;
}

/** Core GET with conditional-request support. */
async function ghGet<T>(
  path: string,
  options: GhCallOptions,
): Promise<{ data: T; rateLimit?: GhRateLimit; hasNextPage: boolean; fromCache: boolean }> {
  const url = path.startsWith("http") ? path : `${API}${path}`;

  const cachedEtag = options.etagKey
    ? await cacheGet<CachedEtagEntry<T>>(options.etagKey)
    : undefined;

  const requestHeaders = headers(options.token);
  if (cachedEtag?.etag) requestHeaders["if-none-match"] = cachedEtag.etag;

  let response;
  try {
    response = await request<T>(url, {
      method: "GET",
      headers: requestHeaders,
      timeoutMs: options.timeoutMs ?? env.GITHUB_REQUEST_TIMEOUT_MS,
      retries: options.retries ?? 1,
      // 429 is handled explicitly below; retrying it here would burn the budget.
      retryOn: (status) => status >= 500,
      maxResponseBytes: options.maxResponseBytes,
      label: "github",
    });
  } catch (e) {
    if (e instanceof HttpTimeoutError) {
      throw new AppError(504, `GitHub did not respond in time while fetching ${options.context}.`, {
        code: "GITHUB_UNAVAILABLE",
        retryable: true,
        cause: e,
      });
    }
    if (e instanceof HttpNetworkError) throw githubUnavailable(e);
    throw e;
  }

  const rateLimit = parseRateLimit(response.headers);

  // 304: content unchanged. Serve the cached body — this consumed no quota.
  if (response.status === 304 && cachedEtag) {
    log.debug({ path, context: options.context }, "github 304, serving cached body");
    return {
      data: cachedEtag.data,
      rateLimit,
      hasNextPage: cachedEtag.hasNextPage,
      fromCache: true,
    };
  }

  if (!response.ok) {
    throw translateError(response.status, response.data, response.headers, options.context);
  }

  const next = hasNextPage(response.headers);

  const etag = response.headers.get("etag");
  if (options.etagKey && etag) {
    await cacheSet(
      options.etagKey,
      { etag, data: response.data, hasNextPage: next } satisfies CachedEtagEntry<T>,
      ETAG_TTL_SECONDS,
    );
  }

  if (rateLimit && rateLimit.remaining < 100) {
    log.warn(
      { remaining: rateLimit.remaining, resetAt: rateLimit.resetAt },
      "GitHub rate limit running low",
    );
  }

  return { data: response.data, rateLimit, hasNextPage: next, fromCache: false };
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export const liveGitHubProvider: GitHubProvider = {
  mode: "live",

  async exchangeOAuthCode(code, redirectUri) {
    const response = await request<GhOAuthTokenResponse>(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: { accept: "application/json" },
        body: {
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirectUri,
        },
        timeoutMs: env.GITHUB_REQUEST_TIMEOUT_MS,
        retries: 1,
        label: "github-oauth",
      },
    );

    if (!response.ok) {
      throw new AppError(502, "GitHub rejected the sign-in attempt.", {
        code: "GITHUB_AUTH_FAILED",
        retryable: true,
        context: { status: response.status },
      });
    }

    const data = response.data;

    // GitHub reports OAuth failures as HTTP 200 with an `error` field.
    if (data.error || !data.access_token) {
      throw new AppError(
        400,
        data.error_description || "GitHub sign-in failed. Please try again.",
        { code: "GITHUB_AUTH_FAILED", retryable: false, context: { error: data.error } },
      );
    }

    return data;
  },

  async getAuthenticatedUser(token) {
    const { data } = await ghGet<GhUser>("/user", { token, context: "your GitHub profile" });
    return data;
  },

  async getAuthenticatedUserEmails(token) {
    try {
      const { data } = await ghGet<GhEmail[]>("/user/emails", {
        token,
        context: "your GitHub email addresses",
      });
      return Array.isArray(data) ? data : [];
    } catch (e) {
      // The `user:email` scope is optional; absence is not an error.
      if (e instanceof AppError && (e.status === 403 || e.status === 404)) return [];
      throw e;
    }
  },

  async listRepositories(token, options: ListRepositoriesOptions = {}) {
    const page = options.page ?? 1;
    const perPage = Math.min(options.perPage ?? 30, 100);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      sort: options.sort ?? "pushed",
      direction: options.direction ?? "desc",
      affiliation: options.affiliation ?? "owner,collaborator,organization_member",
    });

    const { data, rateLimit, hasNextPage: next } = await ghGet<GhRepository[]>(
      `/user/repos?${params.toString()}`,
      {
        token,
        context: "your repositories",
        etagKey: CACHE_KEYS.githubEtag(`repos:${page}:${perPage}:${params.get("sort")}`),
      },
    );

    return {
      items: (Array.isArray(data) ? data : []).filter((r) => !r.archived && !r.disabled),
      page,
      perPage,
      hasNextPage: next,
      rateLimit,
    } satisfies Paged<GhRepository>;
  },

  async getRepository(token, owner, repo) {
    const { data } = await ghGet<GhRepository>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      { token, context: `repository ${owner}/${repo}` },
    );
    return data;
  },

  async listPullRequests(token, owner, repo, options: ListPullRequestsOptions = {}) {
    const page = options.page ?? 1;
    const perPage = Math.min(options.perPage ?? 30, 100);
    const params = new URLSearchParams({
      page: String(page),
      per_page: String(perPage),
      state: options.state ?? "open",
      sort: options.sort ?? "updated",
      direction: options.direction ?? "desc",
    });

    const { data, rateLimit, hasNextPage: next } = await ghGet<GhPullRequestSummary[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params.toString()}`,
      {
        token,
        context: `pull requests for ${owner}/${repo}`,
        etagKey: CACHE_KEYS.githubEtag(
          `pulls:${owner}/${repo}:${params.get("state")}:${page}:${perPage}`,
        ),
      },
    );

    return {
      items: Array.isArray(data) ? data : [],
      page,
      perPage,
      hasNextPage: next,
      rateLimit,
    } satisfies Paged<GhPullRequestSummary>;
  },

  async getPullRequest(token, owner, repo, number) {
    const { data } = await ghGet<GhPullRequestDetail>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
      { token, context: `pull request #${number} in ${owner}/${repo}` },
    );
    return data;
  },

  /**
   * Fetch the changed files, paging until the configured ceiling.
   *
   * GitHub caps this endpoint at 3000 files and omits `patch` for very large or
   * binary files. `truncated` tells the pipeline that its view of the diff is
   * incomplete, which is recorded on the analysis as a degradation rather than
   * silently skewing the features.
   */
  async listPullRequestFiles(token, owner, repo, number) {
    const perPage = 100;
    const maxFiles = env.GITHUB_MAX_FILES_PER_PR;
    const files: GhPullRequestFile[] = [];
    let page = 1;
    let truncated = false;

    while (files.length < maxFiles) {
      const { data, hasNextPage: next } = await ghGet<GhPullRequestFile[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files` +
          `?per_page=${perPage}&page=${page}`,
        {
          token,
          context: `changed files for pull request #${number}`,
          etagKey: CACHE_KEYS.githubEtag(`files:${owner}/${repo}:${number}:${page}`),
          // A single page of 100 patches can be large; cap it defensively.
          maxResponseBytes: 40 * 1024 * 1024,
        },
      );

      const batch = Array.isArray(data) ? data : [];
      files.push(...batch);

      if (!next || batch.length === 0) break;
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      page++;

      // Hard stop: 30 pages * 100 = 3000, GitHub's own ceiling.
      if (page > 30) {
        truncated = true;
        break;
      }
    }

    return { files: files.slice(0, maxFiles), truncated: truncated || files.length > maxFiles };
  },

  async listDeployments(token, owner, repo, options = {}) {
    const params = new URLSearchParams({ per_page: String(options.perPage ?? 30) });
    if (options.environment) params.set("environment", options.environment);

    try {
      const { data } = await ghGet<GhDeployment[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/deployments?${params}`,
        { token, context: `deployments for ${owner}/${repo}` },
      );
      return Array.isArray(data) ? data : [];
    } catch (e) {
      // Most repositories have no Deployments configured; that is not a failure.
      if (e instanceof AppError && e.status === 404) return [];
      throw e;
    }
  },

  /**
   * Cheapest possible liveness check for a stored token.
   *
   * Granted scopes are advertised in the `x-oauth-scopes` response header
   * rather than the body, so this reads the raw response instead of going
   * through `ghGet` (which only returns the parsed body). One request, no
   * conditional caching — we want the current truth, not a cached one.
   */
  async validateToken(token) {
    let response;
    try {
      response = await request<unknown>(`${API}/user`, {
        method: "GET",
        headers: headers(token),
        timeoutMs: 8_000,
        retries: 0,
        label: "github-validate",
      });
    } catch (e) {
      if (e instanceof HttpNetworkError || e instanceof HttpTimeoutError) {
        throw githubUnavailable(e);
      }
      throw e;
    }

    if (response.status === 401) return { valid: false, scopes: [] };

    if (!response.ok) {
      throw translateError(
        response.status,
        response.data,
        response.headers,
        "your GitHub profile",
      );
    }

    const scopes = (response.headers.get("x-oauth-scopes") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    return { valid: true, scopes };
  },
};
