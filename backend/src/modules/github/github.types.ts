/**
 * GitHub API shapes.
 *
 * Only the fields BugDNA actually consumes are declared. Modelling the full
 * payloads would be a maintenance burden and would obscure which parts of the
 * API the risk pipeline genuinely depends on.
 */

export interface GhUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  type: string;
  company: string | null;
  location: string | null;
  bio: string | null;
  html_url: string;
}

export interface GhEmail {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility: string | null;
}

export interface GhRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  html_url: string;
  homepage: string | null;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  size: number;
  archived: boolean;
  disabled: boolean;
  fork: boolean;
  created_at: string | null;
  updated_at: string | null;
  pushed_at: string | null;
  permissions?: {
    admin: boolean;
    maintain?: boolean;
    push: boolean;
    triage?: boolean;
    pull: boolean;
  };
  owner: {
    id: number;
    login: string;
    avatar_url: string | null;
    type: string;
  };
}

export interface GhPullRequestSummary {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft: boolean;
  locked: boolean;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: {
    id: number;
    login: string;
    avatar_url: string | null;
  } | null;
  labels: Array<{ id: number; name: string; color: string }>;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string };
  comments?: number;
  review_comments?: number;
}

/**
 * The detail endpoint adds the aggregate change counts, which the list endpoint
 * omits. The risk pipeline needs them, which is why a PR is always fetched
 * individually before analysis rather than relying on the list payload.
 */
export interface GhPullRequestDetail extends GhPullRequestSummary {
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  comments: number;
  review_comments: number;
  mergeable: boolean | null;
  mergeable_state: string | null;
  merged: boolean;
  merged_by: { login: string } | null;
}

export interface GhPullRequestFile {
  sha: string;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
  /** Absent for binary files and for very large diffs. */
  patch?: string;
  previous_filename?: string;
}

export interface GhDeployment {
  id: number;
  sha: string;
  ref: string;
  task: string;
  environment: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  creator: { login: string } | null;
}

export interface GhDeploymentStatus {
  id: number;
  state: "error" | "failure" | "inactive" | "in_progress" | "queued" | "pending" | "success";
  description: string | null;
  environment: string | null;
  created_at: string;
}

export interface GhOAuthTokenResponse {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
}

// ---------------------------------------------------------------------------
// Client-side wrappers
// ---------------------------------------------------------------------------

/** Rate-limit state parsed from response headers, surfaced to the UI. */
export interface GhRateLimit {
  limit: number;
  remaining: number;
  resetAt: Date;
  used: number;
}

export interface Paged<T> {
  items: T[];
  page: number;
  perPage: number;
  /** True when GitHub's Link header advertises a next page. */
  hasNextPage: boolean;
  rateLimit?: GhRateLimit;
}

export interface ListRepositoriesOptions {
  page?: number;
  perPage?: number;
  sort?: "created" | "updated" | "pushed" | "full_name";
  direction?: "asc" | "desc";
  /** GitHub's `affiliation` filter; defaults to owner+collaborator+org member. */
  affiliation?: string;
}

export interface ListPullRequestsOptions {
  page?: number;
  perPage?: number;
  state?: "open" | "closed" | "all";
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
}

/**
 * The provider interface.
 *
 * Two implementations exist: `live` (api.github.com) and `mock` (deterministic
 * fixtures). The pipeline is written against this interface so the product can
 * be demonstrated and tested with no network and no credentials, and so the
 * seeded demo tenant behaves identically to a real one.
 */
export interface GitHubProvider {
  readonly mode: "live" | "mock";

  exchangeOAuthCode(code: string, redirectUri: string): Promise<GhOAuthTokenResponse>;
  getAuthenticatedUser(token: string): Promise<GhUser>;
  getAuthenticatedUserEmails(token: string): Promise<GhEmail[]>;
  listRepositories(token: string, options?: ListRepositoriesOptions): Promise<Paged<GhRepository>>;
  getRepository(token: string, owner: string, repo: string): Promise<GhRepository>;
  listPullRequests(
    token: string,
    owner: string,
    repo: string,
    options?: ListPullRequestsOptions,
  ): Promise<Paged<GhPullRequestSummary>>;
  getPullRequest(
    token: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<GhPullRequestDetail>;
  listPullRequestFiles(
    token: string,
    owner: string,
    repo: string,
    number: number,
  ): Promise<{ files: GhPullRequestFile[]; truncated: boolean }>;
  listDeployments(
    token: string,
    owner: string,
    repo: string,
    options?: { perPage?: number; environment?: string },
  ): Promise<GhDeployment[]>;
  /** Cheap call used to validate that a stored token still works. */
  validateToken(token: string): Promise<{ valid: boolean; scopes: string[] }>;
}
