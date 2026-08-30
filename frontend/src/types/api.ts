/**
 * API types.
 *
 * Hand-written rather than generated, and kept to what the UI actually reads.
 * They mirror the `select` clauses in the backend's service layer; where the two
 * could drift, the risk is a missing field rendering as `undefined` rather than
 * a wrong value, which is visible immediately.
 */

export type RiskLevel = "LOW" | "MODERATE" | "HIGH" | "CRITICAL";

export type AnalysisStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type AnalysisStage =
  | "NORMALIZING"
  | "FETCHING_DIFF"
  | "EXTRACTING_FEATURES"
  | "PREDICTING"
  | "EXPLAINING"
  | "RECOMMENDING"
  | "PERSISTING"
  | "DONE";

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export type FactorDirection = "INCREASES_RISK" | "DECREASES_RISK" | "NEUTRAL";

export type FactorCategory =
  | "CHANGE_SHAPE"
  | "CHANGE_TYPE"
  | "BLAST_RADIUS"
  | "DEPENDENCY"
  | "DATA_LAYER"
  | "API_CONTRACT"
  | "REPOSITORY_HISTORY"
  | "AUTHOR_CONTEXT"
  | "PROCESS";

export type RecommendationCategory =
  | "TESTING"
  | "CODE_REVIEW"
  | "DEPENDENCY"
  | "DATABASE"
  | "API_CONTRACT"
  | "CONFIGURATION"
  | "SECURITY"
  | "OBSERVABILITY"
  | "ROLLOUT"
  | "SCOPE"
  | "DOCUMENTATION";

export type Priority = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type Effort = "LOW" | "MEDIUM" | "HIGH";

export type MergeDecisionType =
  | "APPROVED_MERGE"
  | "BLOCKED"
  | "DEFERRED"
  | "OVERRIDDEN"
  | "CLOSED_WITHOUT_MERGE";

export type DeploymentEnvironment = "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";

export type DeploymentStatus =
  | "PENDING"
  | "IN_PROGRESS"
  | "SUCCESS"
  | "FAILURE"
  | "ROLLED_BACK"
  | "CANCELLED";

export type TeamRole = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

// ---------------------------------------------------------------------------
// Auth & config
// ---------------------------------------------------------------------------

export interface DeploymentConfig {
  appName: string;
  version: string;
  environment: string;
  auth: {
    githubEnabled: boolean;
    githubMode: "live" | "mock";
    demoLoginEnabled: boolean;
    signInUrl: string;
  };
  risk: {
    bands: Array<{ level: RiskLevel; min: number; max: number }>;
    highRiskThreshold: number;
  };
  realtime: { path: string };
  authenticated: boolean;
}

export interface GithubConnectionStatus {
  connected: boolean;
  mode: "live" | "mock";
  scopes: string[];
  canReadPrivateRepos: boolean;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
}

export interface CurrentUser {
  id: string;
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  company: string | null;
  location: string | null;
  bio: string | null;
  isDemo: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  github: GithubConnectionStatus;
  teams: Array<{
    id: string;
    name: string;
    slug: string;
    avatarUrl: string | null;
    role: TeamRole;
  }>;
  counts: { repositories: number; analyses: number };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface AvailableRepository {
  githubId: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  stars: number;
  forks: number;
  openIssues: number;
  htmlUrl: string;
  pushedAt: string | null;
  connected: boolean;
  connectedRepositoryId: string | null;
  canPull: boolean;
}

export interface RepositoryStats {
  openPullRequests: number;
  analysedPullRequests: number;
  avgRiskScore: number | null;
  highRiskOpen: number;
  lastAnalysisAt: string | null;
  latestRiskLevel: RiskLevel | null;
}

export interface Repository {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  description: string | null;
  language: string | null;
  defaultBranch: string;
  htmlUrl: string | null;
  stars: number;
  isActive: boolean;
  autoAnalyze: boolean;
  connectedAt: string;
  lastSyncedAt: string | null;
  syncError: string | null;
  githubPushedAt: string | null;
  team: { id: string; name: string; slug: string } | null;
  counts: { pullRequests: number; analyses: number; deployments: number };
  stats: RepositoryStats;
}

export interface RepositoryDetail extends Repository {
  githubId: string;
  homepage: string | null;
  forks: number;
  openIssues: number;
  githubCreatedAt: string | null;
  ownerUser: { githubLogin: string; avatarUrl: string | null };
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export interface LatestAnalysisSummary {
  id: string;
  status: AnalysisStatus;
  stage: AnalysisStage | null;
  progress: number;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  scoredBy: "MODEL" | "HEURISTIC";
  degraded: boolean;
  headSha: string;
  createdAt: string;
  completedAt: string | null;
  /** False when the PR has new commits since this analysis. */
  isCurrent: boolean;
  topFactors: Array<{ key: string; label: string; contribution: number }>;
}

export interface PullRequestListItem {
  id: string;
  number: number;
  title: string;
  state: PullRequestState;
  draft: boolean;
  authorLogin: string;
  authorAvatarUrl: string | null;
  baseRef: string;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  reviewComments: number;
  labels: string[];
  htmlUrl: string | null;
  mergeable: boolean | null;
  githubCreatedAt: string;
  githubUpdatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  repository: { id: string; fullName: string; language: string | null; private: boolean };
  counts: { analyses: number; files: number };
  latestAnalysis: LatestAnalysisSummary | null;
}

export interface ChangedFile {
  id: string;
  filename: string;
  previousFilename: string | null;
  status: "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED" | "COPIED" | "CHANGED" | "UNCHANGED";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string | null;
  patchTruncated: boolean;
  blobUrl: string | null;
  extension?: string | null;
  language: string | null;
  module: string | null;
  isTest: boolean;
  isConfig: boolean;
  isDependencyManifest: boolean;
  isMigration: boolean;
  isInfra: boolean;
  isDocs: boolean;
  isGenerated: boolean;
  touchesPublicApi: boolean;
}

export interface PullRequestDetail {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: PullRequestState;
  draft: boolean;
  locked: boolean;
  authorLogin: string;
  authorAvatarUrl: string | null;
  baseRef: string;
  baseSha: string | null;
  headRef: string;
  headSha: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  reviewComments: number;
  labels: string[];
  htmlUrl: string | null;
  mergeable: boolean | null;
  mergeableState: string | null;
  githubCreatedAt: string;
  githubUpdatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  lastSyncedAt: string;
  repository: {
    id: string;
    fullName: string;
    owner: string;
    name: string;
    language: string | null;
    private: boolean;
    defaultBranch: string;
    htmlUrl: string | null;
  };
  files: ChangedFile[];
  analyses: Array<{
    id: string;
    status: AnalysisStatus;
    stage: AnalysisStage | null;
    progress: number;
    riskScore: number | null;
    riskLevel: RiskLevel | null;
    scoredBy: "MODEL" | "HEURISTIC";
    degraded: boolean;
    headSha: string;
    summary: string | null;
    createdAt: string;
    completedAt: string | null;
    durationMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
  }>;
  diffAvailable: boolean;
  latestAnalysisIsCurrent: boolean;
}

export interface PullRequestDiff {
  pullRequestId: string;
  headSha: string;
  files: ChangedFile[];
  totals: {
    files: number;
    additions: number;
    deletions: number;
    truncatedPatches: number;
  };
  modules: Array<{ module: string; churn: number; files: number }>;
  maxPatchBytes: number;
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

export interface RiskFactor {
  id: string;
  key: string;
  label: string;
  value: number | null;
  displayValue: string | null;
  /** SHAP contribution in log-odds space. Sign carries direction. */
  shapValue: number;
  /** Normalised 0-100 share of the total explained movement. */
  contribution: number;
  direction: FactorDirection;
  category: FactorCategory;
  description: string | null;
  evidence: { files?: string[]; note?: string } | null;
  rank: number;
}

export interface Recommendation {
  id: string;
  title: string;
  description: string;
  rationale: string | null;
  category: RecommendationCategory;
  priority: Priority;
  effort: Effort;
  /** Feature keys that caused this to fire — the audit trail. */
  triggeredByFactorKeys: string[];
  targets: { files?: string[]; modules?: string[] } | null;
  rank: number;
}

export interface AnalysisEvent {
  id: string;
  stage: AnalysisStage;
  status: AnalysisStatus;
  message: string | null;
  durationMs: number | null;
  metadata: unknown;
  createdAt: string;
}

export interface MergeDecision {
  id: string;
  decision: MergeDecisionType;
  reason: string | null;
  riskScoreAtDecision: number | null;
  riskLevelAtDecision: RiskLevel | null;
  addressedRecommendationIds: string[];
  createdAt: string;
  user: { githubLogin: string; avatarUrl: string | null };
}

export interface AnalysisDetail {
  id: string;
  status: AnalysisStatus;
  stage: AnalysisStage | null;
  progress: number;
  headSha: string;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  probability: number | null;
  confidence: number | null;
  scoredBy: "MODEL" | "HEURISTIC";
  modelName: string | null;
  modelVersion: string | null;
  featureSetVersion: string | null;
  features: Record<string, number> | null;
  summary: string | null;
  degraded: boolean;
  degradedReasons: string[];
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  createdAt: string;
  requestedBy: { githubLogin: string; avatarUrl: string | null; name: string | null } | null;
  repository: {
    id: string;
    fullName: string;
    owner: string;
    name: string;
    private: boolean;
    language: string | null;
    defaultBranch: string;
    htmlUrl: string | null;
  };
  pullRequest: PullRequestDetail;
  riskFactors: RiskFactor[];
  recommendations: Recommendation[];
  events: AnalysisEvent[];
  mergeDecision: MergeDecision | null;
}

export interface AnalysisListItem {
  id: string;
  status: AnalysisStatus;
  stage: AnalysisStage | null;
  progress: number;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  scoredBy: "MODEL" | "HEURISTIC";
  degraded: boolean;
  summary: string | null;
  headSha: string;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  repository: { id: string; fullName: string; language: string | null; private: boolean };
  pullRequest: {
    id: string;
    number: number;
    title: string;
    state: PullRequestState;
    authorLogin: string;
    authorAvatarUrl: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    htmlUrl: string | null;
  };
  riskFactors: Array<{
    key: string;
    label: string;
    contribution: number;
    category: FactorCategory;
  }>;
  mergeDecision: { decision: MergeDecisionType } | null;
}

export interface AnalysisStatusResponse {
  id: string;
  status: AnalysisStatus;
  stage: AnalysisStage | null;
  progress: number;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  degraded: boolean;
  completedAt: string | null;
  durationMs: number | null;
}

export interface RequestAnalysisResult {
  analysisId: string;
  status: "QUEUED" | "RUNNING" | "COMPLETED";
  reused: boolean;
  jobId?: string;
  headSha: string;
}

export interface MergeReadiness {
  analysisId: string;
  status: AnalysisStatus;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  scoredBy: "MODEL" | "HEURISTIC";
  degraded: boolean;
  degradedReasons: string[];
  pullRequestState: PullRequestState;
  isDraft: boolean;
  githubMergeable: boolean | null;
  alreadyMerged: boolean;
  outstandingRecommendations: Array<{
    id: string;
    title: string;
    priority: Priority;
    category: RecommendationCategory;
  }>;
  highPriorityOutstanding: number;
  justificationRequired: boolean;
  highRiskThreshold: number;
  decision: {
    decision: MergeDecisionType;
    createdAt: string;
    addressedRecommendationIds: string[];
  } | null;
}

export interface AnalysisComparison {
  base: ComparisonSide;
  compare: ComparisonSide;
  scoreDelta: number;
  levelChanged: boolean;
  factorChanges: Array<{
    key: string;
    label: string;
    category: FactorCategory;
    before: { value: number | null; contribution: number; direction: FactorDirection } | null;
    after: { value: number | null; contribution: number; direction: FactorDirection } | null;
    change: "ADDED" | "REMOVED" | "CHANGED";
    contributionDelta: number;
  }>;
}

interface ComparisonSide {
  id: string;
  pullRequestId: string;
  status: AnalysisStatus;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  headSha: string;
  createdAt: string;
  summary: string | null;
  modelVersion: string | null;
  riskFactors: Array<{
    key: string;
    label: string;
    value: number | null;
    displayValue: string | null;
    contribution: number;
    direction: FactorDirection;
    category: FactorCategory;
  }>;
}

export interface FeatureCatalogue {
  featureSetVersion: string;
  riskBands: Array<{ level: RiskLevel; min: number; max: number }>;
  features: Array<{
    key: string;
    label: string;
    description: string;
    category: FactorCategory;
    type: string;
    unit: string | null;
    expectedDirection: "increases" | "decreases" | "context";
    requiresHistory: boolean;
  }>;
  model: {
    name: string;
    version: string;
    engine: "xgboost" | "heuristic";
    feature_set_version: string;
    trained_at: string | null;
    metrics: Record<string, number> | null;
    feature_count: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface RiskDistribution {
  LOW: number;
  MODERATE: number;
  HIGH: number;
  CRITICAL: number;
}

export interface TrendPoint extends RiskDistribution {
  date: string;
  analyses: number;
  avgRiskScore: number | null;
  maxRiskScore: number | null;
}

export interface TopRiskFactor {
  key: string;
  label: string;
  category: FactorCategory;
  occurrences: number;
  frequency: number;
  avgContribution: number | null;
}

export interface DashboardOverview {
  hasRepositories: boolean;
  totals: {
    repositories: number;
    openPullRequests: number;
    analyses: number;
    highRiskOpen: number;
    avgRiskScore: number | null;
    pendingAnalyses: number;
  };
  distribution: RiskDistribution;
  trend: TrendPoint[];
  topRiskFactors: TopRiskFactor[];
  recentAnalyses: Array<{
    id: string;
    riskScore: number | null;
    riskLevel: RiskLevel | null;
    completedAt: string | null;
    scoredBy: "MODEL" | "HEURISTIC";
    degraded: boolean;
    repository: { id: string; fullName: string };
    pullRequest: {
      id: string;
      number: number;
      title: string;
      authorLogin: string;
      authorAvatarUrl: string | null;
      state: PullRequestState;
    };
  }>;
  attentionNeeded: Array<{
    id: string;
    riskScore: number | null;
    riskLevel: RiskLevel | null;
    summary: string | null;
    completedAt: string | null;
    repository: { id: string; fullName: string };
    pullRequest: {
      id: string;
      number: number;
      title: string;
      authorLogin: string;
      authorAvatarUrl: string | null;
      additions: number;
      deletions: number;
      changedFiles: number;
    };
    riskFactors: Array<{ key: string; label: string; contribution: number }>;
  }>;
  windowDays: number;
}

export interface HealthScore {
  score: number | null;
  confidence: "low" | "medium" | "high";
  components: Record<string, number>;
}

export interface RepositoryHealth {
  repositoryId: string;
  windowDays: number;
  health: HealthScore;
  totals: {
    analyses: number;
    avgRiskScore: number | null;
    p90RiskScore: number | null;
    maxRiskScore: number | null;
    highRiskCount: number;
    pullRequestsOpened: number;
    pullRequestsMerged: number;
    avgChurn: number | null;
    testCoverageRatio: number | null;
    deployments: number;
    deploymentsFailed: number;
    deploymentFailureRate: number | null;
    highRiskOverrides: number;
    decisionsRecorded: number;
  };
  distribution: RiskDistribution;
  trend: TrendPoint[];
  recurringRiskFactors: TopRiskFactor[];
  contributors: Array<{
    login: string;
    pullRequests: number;
    avgAdditions: number | null;
    avgFilesChanged: number | null;
  }>;
}

export interface TeamDashboard {
  team: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    createdAt: string;
    members: Array<{
      role: TeamRole;
      joinedAt: string;
      user: { id: string; githubLogin: string; name: string | null; avatarUrl: string | null };
    }>;
    repositories: Array<{ id: string; fullName: string; language: string | null; private: boolean }>;
  };
  windowDays: number;
  totals: {
    repositories: number;
    analyses: number;
    avgRiskScore: number | null;
    highRiskCount: number;
    openPullRequests: number;
    highRiskOverrides: number;
    overrideRate: number | null;
  };
  distribution: RiskDistribution;
  trend: TrendPoint[];
  repositories: Array<{
    id: string;
    fullName: string;
    language: string | null;
    private: boolean;
    analyses: number;
    avgRiskScore: number | null;
    maxRiskScore: number | null;
  }>;
  contributors: Array<{
    login: string;
    pullRequests: number;
    avgChurn: number | null;
    avgFilesChanged: number | null;
    avgRiskScore: number | null;
    analysedPullRequests: number;
  }>;
  recurringRiskFactors: TopRiskFactor[];
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  avatarUrl: string | null;
  createdAt: string;
  role: TeamRole;
  joinedAt: string;
  owner: { githubLogin: string; avatarUrl: string | null };
  counts: { members: number; repositories: number };
}

export interface TeamDetail {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  avatarUrl: string | null;
  createdAt: string;
  viewerRole: TeamRole;
  owner: { id: string; githubLogin: string; avatarUrl: string | null; name: string | null };
  members: Array<{
    id: string;
    githubLogin: string;
    name: string | null;
    avatarUrl: string | null;
    role: TeamRole;
    joinedAt: string;
    lastSeenAt: string | null;
  }>;
  repositories: Array<{
    id: string;
    fullName: string;
    language: string | null;
    private: boolean;
    _count: { pullRequests: number; analyses: number };
  }>;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type NotificationType =
  | "ANALYSIS_QUEUED"
  | "ANALYSIS_COMPLETED"
  | "ANALYSIS_FAILED"
  | "HIGH_RISK_PR"
  | "MERGE_DECISION_RECORDED"
  | "DEPLOYMENT_RECORDED"
  | "DEPLOYMENT_FAILED"
  | "REPOSITORY_CONNECTED"
  | "REPOSITORY_SYNC_FAILED"
  | "TEAM_MEMBER_ADDED"
  | "SYSTEM";

export type NotificationSeverity = "INFO" | "SUCCESS" | "WARNING" | "CRITICAL";

export interface AppNotification {
  id: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  href: string | null;
  repositoryId: string | null;
  pullRequestId: string | null;
  analysisId: string | null;
  read: boolean;
  createdAt: string;
  metadata: unknown;
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export type TimelineEventType = "DEPLOYMENT" | "PULL_REQUEST_MERGED" | "ANALYSIS";

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  at: string;
  title: string;
  subtitle: string | null;
  repositoryId: string;
  repositoryFullName: string;
  href: string | null;
  riskScore: number | null;
  riskLevel: RiskLevel | null;
  meta: Record<string, unknown>;
}

export interface TimelineResponse {
  events: TimelineEvent[];
  windowDays: number;
  correlation: {
    deploymentsWithLinkedPr: number;
    deploymentsTotal: number;
    incidentsReported: number;
    avgRiskWhenIncident: number | null;
    avgRiskWhenClean: number | null;
    incidentSampleSize: number;
    cleanSampleSize: number;
    interpretation: string;
  };
}

export interface Deployment {
  id: string;
  environment: DeploymentEnvironment;
  status: DeploymentStatus;
  sha: string;
  ref: string | null;
  description: string | null;
  actorLogin: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  causedIncident: boolean | null;
  incidentSummary: string | null;
  incidentSeverity: "SEV1" | "SEV2" | "SEV3" | "SEV4" | null;
  riskScoreAtDeploy: number | null;
  riskLevelAtDeploy: RiskLevel | null;
  repository: { id: string; fullName: string };
  pullRequest: { id: string; number: number; title: string; authorLogin: string } | null;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export type SearchCategory =
  | "repositories"
  | "pullRequests"
  | "analyses"
  | "riskFactors"
  | "recommendations";

export interface SearchResultItem {
  id: string;
  category: SearchCategory;
  title: string;
  subtitle: string | null;
  href: string;
  meta: Record<string, unknown>;
}

export interface SearchResults {
  query: string;
  totalMatches: number;
  groups: Array<{ category: SearchCategory; label: string; items: SearchResultItem[] }>;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export interface SystemStatus {
  service: string;
  version: string;
  environment: string;
  uptimeSeconds: number;
  github: { mode: string; configured: boolean; apiBase: string };
  analysis: {
    featureSetVersion: string;
    featureCount: number;
    riskBands: Array<{ level: RiskLevel; min: number; max: number }>;
    concurrency: number;
    maxAttempts: number;
    timeoutMs: number;
    highRiskThreshold: number;
  };
  model: FeatureCatalogue["model"];
  dependencies: {
    database: { ok: boolean; latencyMs?: number; error?: string };
    redis: { ok: boolean; latencyMs?: number; error?: string };
    mlService: { ok: boolean; latencyMs?: number; engine?: string; error?: string };
  };
  queue: { waiting: number; active: number; delayed: number; failed: number; completed: number } | null;
  timestamp: string;
}
