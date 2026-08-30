"use client";

/**
 * Data access.
 *
 * Every server read and write in the app goes through a hook here. Centralising
 * them buys three things worth having:
 *
 *  - **Invalidation is correct by construction.** A mutation declares what it
 *    affects next to itself, using the shared key registry, so it cannot
 *    invalidate a key the list is not cached under.
 *  - **Retry policy is uniform and sensible.** The API tells us whether an error
 *    is retryable; nothing else needs to guess. A 401 or a validation failure is
 *    never retried, an upstream timeout is.
 *  - **Components stay declarative.** A page says what data it needs, not how to
 *    fetch it.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { ApiError, api, type PaginationMeta } from "@/lib/api";
import { analysisCompletionKeys, qk } from "@/lib/query-keys";
import { toast } from "@/stores/toast.store";
import type {
  AnalysisComparison,
  AnalysisDetail,
  AnalysisListItem,
  AnalysisStatusResponse,
  AppNotification,
  AvailableRepository,
  CurrentUser,
  DashboardOverview,
  Deployment,
  DeploymentEnvironment,
  DeploymentStatus,
  DeploymentEnvironment as Environment,
  FeatureCatalogue,
  MergeDecisionType,
  MergeReadiness,
  PullRequestDetail,
  PullRequestDiff,
  PullRequestListItem,
  Repository,
  RepositoryDetail,
  RepositoryHealth,
  RequestAnalysisResult,
  RiskLevel,
  SearchResults,
  SystemStatus,
  TeamDashboard,
  TeamDetail,
  TeamSummary,
  TimelineEventType,
  TimelineResponse,
} from "@/types/api";

// ---------------------------------------------------------------------------
// Shared query behaviour
// ---------------------------------------------------------------------------

/**
 * Whether an error is worth retrying.
 *
 * The API already answers this — `retryable` on the error envelope. Deferring to
 * it means the frontend does not re-implement (and drift from) the backend's own
 * judgement about which failures are transient.
 */
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2) return false;
  if (error instanceof ApiError) {
    // Never retry a signed-out session or a bad request — it will fail again.
    if (error.isAuthError || error.status === 404 || error.status === 400) return false;
    if (error.code === "VALIDATION_FAILED" || error.code === "FORBIDDEN") return false;
    return error.retryable;
  }
  return true;
}

/** Defaults every list/detail query in the app inherits. */
const baseQueryOptions = {
  retry: shouldRetry,
  staleTime: 30_000,
} satisfies Partial<UseQueryOptions>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export function useCurrentUser(enabled = true) {
  return useQuery({
    queryKey: qk.session.current(),
    queryFn: () => api.get<CurrentUser>("/auth/me"),
    // A signed-out user is a normal state, not an error to retry.
    retry: false,
    staleTime: 60_000,
    enabled,
  });
}

/** Unauthenticated probe: what this deployment supports. */
export function useDeploymentConfig() {
  return useQuery({
    queryKey: qk.session.config(),
    queryFn: () => api.get<import("@/types/api").DeploymentConfig>("/system/config"),
    retry: 1,
    // Deployment configuration does not change while the tab is open.
    staleTime: Infinity,
  });
}

export function useSignInAsDemo() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () =>
      api.post<{ user: { id: string; githubLogin: string }; redirectTo: string }>(
        "/auth/demo",
      ),
    onSuccess: async () => {
      // Everything is now visible; drop the whole cache rather than guessing.
      await queryClient.invalidateQueries();
    },
    onError: (error: ApiError) =>
      toast.error("Could not start the demo", { description: error.message }),
  });
}

export function useSignOut() {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, boolean | undefined>({
    mutationFn: (allDevices = false) => api.post("/auth/logout", { allDevices }),
    onSuccess: async () => {
      const { disconnectSocket } = await import("@/lib/realtime");
      disconnectSocket();
      queryClient.clear();
      window.location.href = "/login";
    },
  });
}

export function useDisconnectGithub() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ disconnected: boolean; message: string }>("/auth/github/disconnect"),
    onSuccess: async (result) => {
      toast.warning("GitHub disconnected", { description: result.message });
      await queryClient.invalidateQueries({ queryKey: qk.session.all });
      await queryClient.invalidateQueries({ queryKey: qk.repositories.all });
    },
    onError: (error: ApiError) =>
      toast.error("Could not disconnect GitHub", { description: error.message }),
  });
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export type RepositoryListParams = {
  page?: number;
  perPage?: number;
  search?: string;
  teamId?: string;
  sort?: "recent" | "risk" | "name" | "activity";
  includeInactive?: boolean;
};

export function useRepositories(params: RepositoryListParams = {}) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.repositories.list(params),
    queryFn: () =>
      api.getWithMeta<Repository[], PaginationMeta>("/repositories", { params }),
    // Keeps the previous page visible while the next loads, so pagination does
    // not flash an empty table.
    placeholderData: keepPreviousData,
  });
}

export function useRepositoryOptions() {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.repositories.options(),
    queryFn: () =>
      api.get<Array<{ id: string; fullName: string; language: string | null; private: boolean }>>(
        "/repositories/options",
      ),
    staleTime: 5 * 60_000,
  });
}

export function useRepository(id: string | undefined) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.repositories.detail(id ?? ""),
    queryFn: () => api.get<RepositoryDetail>(`/repositories/${id}`),
    enabled: Boolean(id),
  });
}

export function useAvailableRepositories(params: { page?: number; search?: string } = {}) {
  return useQuery({
    queryKey: qk.repositories.available(params),
    queryFn: () =>
      api.getWithMeta<
        AvailableRepository[],
        { page: number; perPage: number; hasNextPage: boolean; cached: boolean }
      >("/repositories/available", { params: { ...params, perPage: 30 } }),
    // Hits the GitHub API; do not refetch on every focus.
    staleTime: 2 * 60_000,
    retry: shouldRetry,
    placeholderData: keepPreviousData,
  });
}

export function useConnectRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { owner: string; name: string; teamId?: string }) =>
      api.post<{ repositoryId: string; fullName: string; pullRequestsSynced: number }>(
        "/repositories",
        input,
      ),
    onSuccess: async (result) => {
      toast.success(`Connected ${result.fullName}`, {
        description:
          result.pullRequestsSynced > 0
            ? `${result.pullRequestsSynced} open pull request${
                result.pullRequestsSynced === 1 ? "" : "s"
              } ready to analyse.`
            : "No open pull requests found yet.",
        action: { label: "Open", href: `/repositories/${result.repositoryId}` },
      });

      await queryClient.invalidateQueries({ queryKey: qk.repositories.all });
      await queryClient.invalidateQueries({ queryKey: qk.analytics.all });
      await queryClient.invalidateQueries({ queryKey: qk.session.all });
    },
    onError: (error: ApiError) =>
      toast.error("Could not connect the repository", { description: error.message }),
  });
}

export function useDisconnectRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (repositoryId: string) =>
      api.delete<{ disconnected: boolean; analysesRetained: number }>(
        `/repositories/${repositoryId}`,
      ),
    onSuccess: async (result) => {
      toast.show({
        title: "Repository disconnected",
        description: `${result.analysesRetained} past analys${
          result.analysesRetained === 1 ? "is" : "es"
        } kept. Reconnect at any time to restore it.`,
        variant: "neutral",
      });
      await queryClient.invalidateQueries({ queryKey: qk.repositories.all });
      await queryClient.invalidateQueries({ queryKey: qk.analytics.all });
    },
    onError: (error: ApiError) =>
      toast.error("Could not disconnect the repository", { description: error.message }),
  });
}

export function useUpdateRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      repositoryId,
      ...body
    }: { repositoryId: string; autoAnalyze?: boolean; teamId?: string | null }) =>
      api.patch<RepositoryDetail>(`/repositories/${repositoryId}`, body),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({
        queryKey: qk.repositories.detail(variables.repositoryId),
      });
      await queryClient.invalidateQueries({ queryKey: qk.repositories.list() });
    },
    onError: (error: ApiError) =>
      toast.error("Could not update the repository", { description: error.message }),
  });
}

export function useSyncRepository() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      repositoryId,
      state = "open",
    }: { repositoryId: string; state?: "open" | "closed" | "all" }) =>
      api.post<{ synced: number; created: number; updated: number }>(
        `/repositories/${repositoryId}/sync`,
        { state },
      ),
    onSuccess: async (result, variables) => {
      toast.success("Repository synced", {
        description: `${result.synced} pull request${result.synced === 1 ? "" : "s"} refreshed.`,
      });
      await queryClient.invalidateQueries({ queryKey: qk.pulls.all });
      await queryClient.invalidateQueries({
        queryKey: qk.repositories.detail(variables.repositoryId),
      });
    },
    onError: (error: ApiError) =>
      toast.error("Sync failed", { description: error.message }),
  });
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export type PullListParams = {
  page?: number;
  perPage?: number;
  repositoryId?: string;
  state?: "OPEN" | "CLOSED" | "MERGED" | "ALL";
  authorLogin?: string;
  search?: string;
  riskLevel?: RiskLevel[];
  unanalysedOnly?: boolean;
  sort?: "updated" | "created" | "risk" | "size";
};

export function usePullRequests(params: PullListParams = {}) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.pulls.list(params),
    queryFn: () =>
      api.getWithMeta<PullRequestListItem[], PaginationMeta>("/pulls", { params }),
    placeholderData: keepPreviousData,
  });
}

export function usePullRequest(id: string | undefined) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.pulls.detail(id ?? ""),
    queryFn: () => api.get<PullRequestDetail>(`/pulls/${id}`),
    enabled: Boolean(id),
  });
}

/**
 * The diff.
 *
 * Separate from the PR detail because it is large and slow — it may fetch from
 * GitHub on first access. The header renders while this is still loading.
 */
export function usePullRequestDiff(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: qk.pulls.diff(id ?? ""),
    queryFn: () => api.get<PullRequestDiff>(`/pulls/${id}/diff`),
    enabled: Boolean(id) && enabled,
    // A diff for a given head SHA never changes, so cache it hard.
    staleTime: 10 * 60_000,
    retry: shouldRetry,
  });
}

export function usePullRequestAnalyses(id: string | undefined) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.pulls.analyses(id ?? ""),
    queryFn: () =>
      api.get<
        Array<{
          id: string;
          status: string;
          riskScore: number | null;
          riskLevel: RiskLevel | null;
          scoredBy: string;
          headSha: string;
          degraded: boolean;
          createdAt: string;
          completedAt: string | null;
          durationMs: number | null;
          modelVersion: string | null;
          featureSetVersion: string | null;
          riskFactors: Array<{
            key: string;
            label: string;
            contribution: number;
            direction: string;
          }>;
        }>
      >(`/pulls/${id}/analyses`),
    enabled: Boolean(id),
  });
}

export function usePullRequestAuthors(repositoryId?: string) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.pulls.authors(repositoryId),
    queryFn: () =>
      api.get<Array<{ login: string; pullRequests: number }>>("/pulls/authors", {
        params: { repositoryId },
      }),
    staleTime: 5 * 60_000,
  });
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

export type AnalysisListParams = {
  page?: number;
  perPage?: number;
  repositoryId?: string;
  pullRequestId?: string;
  authorLogin?: string;
  riskLevel?: RiskLevel[];
  status?: string[];
  days?: number;
};

export function useAnalyses(params: AnalysisListParams = {}) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.analyses.list(params),
    queryFn: () =>
      api.getWithMeta<AnalysisListItem[], PaginationMeta>("/analyses", { params }),
    placeholderData: keepPreviousData,
  });
}

export function useAnalysis(id: string | undefined) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.analyses.detail(id ?? ""),
    queryFn: () => api.get<AnalysisDetail>(`/analyses/${id}`),
    enabled: Boolean(id),
  });
}

/**
 * Status polling.
 *
 * A fallback, not the primary mechanism — Socket.io carries progress. This
 * exists because websockets are blocked on some corporate networks, and an
 * analysis appearing to hang is a worse failure than a few extra requests.
 * Polling stops the moment the analysis reaches a terminal state.
 */
export function useAnalysisStatus(id: string | undefined, active: boolean) {
  return useQuery({
    queryKey: qk.analyses.status(id ?? ""),
    queryFn: () => api.get<AnalysisStatusResponse>(`/analyses/${id}/status`),
    enabled: Boolean(id) && active,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "QUEUED" || status === "RUNNING") return 2_500;
      return false;
    },
    retry: shouldRetry,
  });
}

export function useMergeReadiness(id: string | undefined) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.analyses.mergeReadiness(id ?? ""),
    queryFn: () => api.get<MergeReadiness>(`/analyses/${id}/merge-readiness`),
    enabled: Boolean(id),
  });
}

export function useAnalysisComparison(base?: string, compare?: string) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.analyses.compare(base ?? "", compare ?? ""),
    queryFn: () =>
      api.get<AnalysisComparison>("/analyses/compare", { params: { base, compare } }),
    enabled: Boolean(base && compare),
  });
}

/** The feature catalogue and model metadata — the methodology view. */
export function useFeatureCatalogue() {
  return useQuery({
    queryKey: qk.analyses.features(),
    queryFn: () => api.get<FeatureCatalogue>("/analyses/features"),
    staleTime: 10 * 60_000,
    retry: 1,
  });
}

export function useRequestAnalysis() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ pullRequestId, force = false }: { pullRequestId: string; force?: boolean }) =>
      api.post<RequestAnalysisResult>("/analyses", { pullRequestId, force }),

    onSuccess: async (result) => {
      if (result.reused && result.status === "COMPLETED") {
        // Nothing was queued — the same commit already has a result.
        toast.show({
          title: "This commit has already been analysed",
          description: "Showing the existing result. Use Re-analyse to force a fresh run.",
          variant: "neutral",
          action: { label: "View", href: `/analyses/${result.analysisId}` },
        });
      } else {
        // A loading toast, replaced in place by the socket's completion event
        // because both use the same id.
        toast.loading("Analysis queued", {
          id: `analysis-${result.analysisId}`,
          description: "Extracting risk signals from the diff. This usually takes a few seconds.",
        });
      }

      await queryClient.invalidateQueries({ queryKey: qk.pulls.all });
      await queryClient.invalidateQueries({ queryKey: qk.analyses.list() });
    },

    onError: (error: ApiError) => {
      // An analysis already running is not a failure — point at it.
      if (error.code === "ANALYSIS_IN_PROGRESS") {
        const analysisId = (error.details as { analysisId?: string } | undefined)?.analysisId;
        toast.show({
          title: "An analysis is already running for this commit",
          variant: "neutral",
          ...(analysisId
            ? { action: { label: "View progress", href: `/analyses/${analysisId}` } }
            : {}),
        });
        return;
      }

      toast.error("Could not start the analysis", {
        description: error.message,
      });
    },
  });
}

export function useRetryAnalysis() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (analysisId: string) =>
      api.post<RequestAnalysisResult>(`/analyses/${analysisId}/retry`),
    onSuccess: async (result) => {
      toast.loading("Re-running the analysis", {
        id: `analysis-${result.analysisId}`,
      });
      await queryClient.invalidateQueries({ queryKey: qk.analyses.all });
    },
    onError: (error: ApiError) =>
      toast.error("Could not retry", { description: error.message }),
  });
}

export function useCancelAnalysis() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (analysisId: string) => api.post(`/analyses/${analysisId}/cancel`),
    onSuccess: async (_result, analysisId) => {
      toast.show({ title: "Analysis cancelled", variant: "neutral" });
      toast.dismiss(`analysis-${analysisId}`);
      await queryClient.invalidateQueries({ queryKey: qk.analyses.all });
    },
    onError: (error: ApiError) =>
      toast.error("Could not cancel", { description: error.message }),
  });
}

export function useRecordMergeDecision() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      analysisId,
      ...body
    }: {
      analysisId: string;
      decision: MergeDecisionType;
      reason?: string;
      addressedRecommendationIds?: string[];
    }) => api.post<{ id: string }>(`/analyses/${analysisId}/decision`, body),

    onSuccess: async (_result, variables) => {
      toast.success("Decision recorded", {
        description: "It now appears in the repository's history and team rollups.",
      });
      for (const key of analysisCompletionKeys()) {
        await queryClient.invalidateQueries({ queryKey: key });
      }
      await queryClient.invalidateQueries({
        queryKey: qk.analyses.mergeReadiness(variables.analysisId),
      });
    },

    onError: (error: ApiError) =>
      toast.error("Could not record the decision", { description: error.message }),
  });
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export function useDashboardOverview(days = 30) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.analytics.overview(days),
    queryFn: () => api.get<DashboardOverview>("/analytics/overview", { params: { days } }),
  });
}

export function useRepositoryHealth(repositoryId: string | undefined, days = 30) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.repositories.health(repositoryId ?? "", days),
    queryFn: () =>
      api.get<RepositoryHealth>(`/analytics/repositories/${repositoryId}`, {
        params: { days },
      }),
    enabled: Boolean(repositoryId),
  });
}

export function useRepositorySnapshots(repositoryId: string | undefined, days = 90) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.repositories.snapshots(repositoryId ?? "", days),
    queryFn: () =>
      api.get<
        Array<{
          date: string;
          analyses: number;
          avgRiskScore: number | null;
          healthScore: number | null;
          LOW: number;
          MODERATE: number;
          HIGH: number;
          CRITICAL: number;
          deployments: number;
          incidents: number;
        }>
      >(`/analytics/repositories/${repositoryId}/snapshots`, { params: { days } }),
    enabled: Boolean(repositoryId),
  });
}

export function useTeamDashboard(teamId: string | undefined, days = 30) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.analytics.team(teamId ?? "", days),
    queryFn: () => api.get<TeamDashboard>(`/analytics/teams/${teamId}`, { params: { days } }),
    enabled: Boolean(teamId),
  });
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export function useTeams() {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.teams.list(),
    queryFn: () => api.get<TeamSummary[]>("/teams"),
  });
}

export function useTeam(id: string | undefined) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.teams.detail(id ?? ""),
    queryFn: () => api.get<TeamDetail>(`/teams/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateTeam() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      api.post<{ id: string; name: string; slug: string }>("/teams", input),
    onSuccess: async (team) => {
      toast.success(`Created ${team.name}`);
      await queryClient.invalidateQueries({ queryKey: qk.teams.all });
      await queryClient.invalidateQueries({ queryKey: qk.session.all });
    },
    onError: (error: ApiError) =>
      toast.error("Could not create the team", { description: error.message }),
  });
}

export function useAddTeamMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      teamId,
      ...body
    }: { teamId: string; githubLogin: string; role?: "ADMIN" | "MEMBER" | "VIEWER" }) =>
      api.post<{ githubLogin: string; role: string }>(`/teams/${teamId}/members`, body),
    onSuccess: async (member, variables) => {
      toast.success(`Added ${member.githubLogin}`);
      await queryClient.invalidateQueries({ queryKey: qk.teams.detail(variables.teamId) });
    },
    onError: (error: ApiError) =>
      toast.error("Could not add the member", { description: error.message }),
  });
}

export function useRemoveTeamMember() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      api.delete<{ removed: boolean }>(`/teams/${teamId}/members/${userId}`),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: qk.teams.detail(variables.teamId) });
    },
    onError: (error: ApiError) =>
      toast.error("Could not remove the member", { description: error.message }),
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function useNotifications(params: { page?: number; unreadOnly?: boolean } = {}) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.notifications.list(params),
    queryFn: () =>
      api.getWithMeta<AppNotification[], PaginationMeta>("/notifications", { params }),
    placeholderData: keepPreviousData,
  });
}

export function useUnreadCount() {
  return useQuery({
    queryKey: qk.notifications.unreadCount(),
    queryFn: () => api.get<{ unreadCount: number }>("/notifications/unread-count"),
    // Socket events keep this current; the interval is a safety net for a client
    // whose websocket is blocked.
    refetchInterval: 120_000,
    retry: false,
    staleTime: 30_000,
  });
}

export function useMarkNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ marked: number; unreadCount: number }>("/notifications/read", { ids }),
    onSuccess: async (result) => {
      queryClient.setQueryData(qk.notifications.unreadCount(), {
        unreadCount: result.unreadCount,
      });
      await queryClient.invalidateQueries({ queryKey: qk.notifications.list() });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => api.post<{ marked: number }>("/notifications/read-all"),
    onSuccess: async () => {
      queryClient.setQueryData(qk.notifications.unreadCount(), { unreadCount: 0 });
      await queryClient.invalidateQueries({ queryKey: qk.notifications.all });
    },
  });
}

export function useDismissNotification() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      api.delete<{ dismissed: boolean; unreadCount: number }>(`/notifications/${id}`),
    onSuccess: async (result) => {
      queryClient.setQueryData(qk.notifications.unreadCount(), {
        unreadCount: result.unreadCount,
      });
      await queryClient.invalidateQueries({ queryKey: qk.notifications.list() });
    },
  });
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type TimelineParams = {
  repositoryId?: string;
  days?: number;
  environment?: Environment[];
  type?: TimelineEventType[];
  limit?: number;
};

export function useTimeline(params: TimelineParams = {}) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.timeline.events(params),
    queryFn: () => api.get<TimelineResponse>("/timeline", { params }),
  });
}

export function useDeployments(params: { page?: number; repositoryId?: string } = {}) {
  return useQuery({
    ...baseQueryOptions,
    queryKey: qk.timeline.deployments(params),
    queryFn: () =>
      api.getWithMeta<Deployment[], PaginationMeta>("/timeline/deployments", { params }),
    placeholderData: keepPreviousData,
  });
}

export function useRecordDeployment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: {
      repositoryId: string;
      sha: string;
      environment?: DeploymentEnvironment;
      status?: DeploymentStatus;
      ref?: string;
      description?: string;
    }) =>
      api.post<{ id: string; linkedPullRequestId: string | null }>(
        "/timeline/deployments",
        input,
      ),
    onSuccess: async (result) => {
      toast.success("Deployment recorded", {
        description: result.linkedPullRequestId
          ? "Linked to the pull request that shipped in it."
          : "No matching pull request found for that commit — recorded unlinked.",
      });
      await queryClient.invalidateQueries({ queryKey: qk.timeline.all });
      await queryClient.invalidateQueries({ queryKey: qk.analytics.all });
    },
    onError: (error: ApiError) =>
      toast.error("Could not record the deployment", { description: error.message }),
  });
}

/** Report whether a deployment caused an incident — the only ground truth. */
export function useReportDeploymentOutcome() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      deploymentId,
      ...body
    }: {
      deploymentId: string;
      causedIncident: boolean;
      incidentSummary?: string;
      incidentSeverity?: "SEV1" | "SEV2" | "SEV3" | "SEV4";
      status?: "SUCCESS" | "FAILURE" | "ROLLED_BACK";
    }) => api.post<{ id: string }>(`/timeline/deployments/${deploymentId}/outcome`, body),

    onSuccess: async (_result, variables) => {
      toast.success(
        variables.causedIncident ? "Incident recorded" : "Deployment marked clean",
        {
          description: variables.causedIncident
            ? "Future analyses of these modules will take this into account."
            : undefined,
        },
      );
      await queryClient.invalidateQueries({ queryKey: qk.timeline.all });
      await queryClient.invalidateQueries({ queryKey: qk.analytics.all });
    },

    onError: (error: ApiError) =>
      toast.error("Could not record the outcome", { description: error.message }),
  });
}

export function useSyncDeployments() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (repositoryId: string) =>
      api.post<{ ingested: number; linked: number }>("/timeline/deployments/sync", {
        repositoryId,
      }),
    onSuccess: async (result) => {
      toast.success("Deployments synced from GitHub", {
        description: `${result.ingested} new, ${result.linked} linked to pull requests.`,
      });
      await queryClient.invalidateQueries({ queryKey: qk.timeline.all });
    },
    onError: (error: ApiError) =>
      toast.error("Could not sync deployments", { description: error.message }),
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export function useSearch(query: string, enabled = true) {
  return useQuery({
    queryKey: qk.search.query(query, 5),
    queryFn: () => api.get<SearchResults>("/search", { params: { q: query, limit: 5 } }),
    enabled,
    // Search is typed into; keep results briefly so backspacing is instant.
    staleTime: 20_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export function useSystemStatus(enabled = true) {
  return useQuery({
    queryKey: qk.system.status(),
    queryFn: () => api.get<SystemStatus>("/system/status"),
    enabled,
    refetchInterval: 30_000,
    retry: 1,
  });
}
