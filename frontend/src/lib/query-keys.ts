/**
 * Query key registry.
 *
 * Every TanStack Query key in the app is constructed here. That matters more
 * than it looks: keys are how invalidation works, and hand-written keys scattered
 * across components drift almost immediately — you end up with a mutation that
 * invalidates `["analyses"]` while the list is cached under `["analysis","list"]`,
 * and the UI silently stops updating.
 *
 * The keys are hierarchical, so a broad invalidation cascades:
 *
 *     qk.analyses.all          -> ["analyses"]
 *     qk.analyses.list({...})  -> ["analyses","list",{...}]
 *     qk.analyses.detail(id)   -> ["analyses","detail",id]
 *
 * Invalidating `qk.analyses.all` therefore refreshes every list and detail at
 * once, which is what a completed analysis should do.
 */

/**
 * Any serialisable filter object.
 *
 * A `type` alias rather than an `interface` on purpose: TypeScript gives object
 * type aliases an implicit index signature, so a caller's specific filter type
 * (RepositoryListParams and friends) is assignable to this without every one of
 * them having to declare `[key: string]: unknown`.
 */
export type ListParams = Record<string, unknown>;

export const qk = {
  // --- session ------------------------------------------------------------
  session: {
    all: ["session"] as const,
    current: () => ["session", "current"] as const,
    config: () => ["session", "config"] as const,
  },

  // --- repositories -------------------------------------------------------
  repositories: {
    all: ["repositories"] as const,
    list: (params: ListParams = {}) => ["repositories", "list", params] as const,
    options: () => ["repositories", "options"] as const,
    detail: (id: string) => ["repositories", "detail", id] as const,
    /** Repositories on GitHub available to connect. */
    available: (params: ListParams = {}) => ["repositories", "available", params] as const,
    health: (id: string, days: number) => ["repositories", "health", id, days] as const,
    snapshots: (id: string, days: number) => ["repositories", "snapshots", id, days] as const,
  },

  // --- pull requests ------------------------------------------------------
  pulls: {
    all: ["pulls"] as const,
    list: (params: ListParams = {}) => ["pulls", "list", params] as const,
    detail: (id: string) => ["pulls", "detail", id] as const,
    diff: (id: string) => ["pulls", "diff", id] as const,
    analyses: (id: string) => ["pulls", "analyses", id] as const,
    authors: (repositoryId?: string) => ["pulls", "authors", repositoryId ?? "all"] as const,
  },

  // --- analyses -----------------------------------------------------------
  analyses: {
    all: ["analyses"] as const,
    list: (params: ListParams = {}) => ["analyses", "list", params] as const,
    detail: (id: string) => ["analyses", "detail", id] as const,
    status: (id: string) => ["analyses", "status", id] as const,
    mergeReadiness: (id: string) => ["analyses", "merge-readiness", id] as const,
    compare: (base: string, compare: string) =>
      ["analyses", "compare", base, compare] as const,
    features: () => ["analyses", "features"] as const,
  },

  // --- analytics ----------------------------------------------------------
  analytics: {
    all: ["analytics"] as const,
    overview: (days: number) => ["analytics", "overview", days] as const,
    team: (teamId: string, days: number) => ["analytics", "team", teamId, days] as const,
  },

  // --- teams --------------------------------------------------------------
  teams: {
    all: ["teams"] as const,
    list: () => ["teams", "list"] as const,
    detail: (id: string) => ["teams", "detail", id] as const,
  },

  // --- notifications ------------------------------------------------------
  notifications: {
    all: ["notifications"] as const,
    list: (params: ListParams = {}) => ["notifications", "list", params] as const,
    unreadCount: () => ["notifications", "unread-count"] as const,
  },

  // --- timeline -----------------------------------------------------------
  timeline: {
    all: ["timeline"] as const,
    events: (params: ListParams = {}) => ["timeline", "events", params] as const,
    deployments: (params: ListParams = {}) => ["timeline", "deployments", params] as const,
  },

  // --- search -------------------------------------------------------------
  search: {
    all: ["search"] as const,
    query: (q: string, limit: number) => ["search", "query", q, limit] as const,
  },

  // --- system -------------------------------------------------------------
  system: {
    all: ["system"] as const,
    status: () => ["system", "status"] as const,
  },
} as const;

/**
 * Query keys to invalidate when an analysis reaches a terminal state.
 *
 * Collected in one place because a completed analysis touches a surprising
 * number of views: the analysis itself, the pull request that owns it, the
 * repository's health, the dashboard rollup, the timeline and the notification
 * count. Missing one is how a stale dashboard happens.
 */
export function analysisCompletionKeys(): readonly unknown[][] {
  return [
    [...qk.analyses.all],
    [...qk.pulls.all],
    [...qk.analytics.all],
    [...qk.repositories.all],
    [...qk.timeline.all],
    [...qk.notifications.all],
  ];
}
