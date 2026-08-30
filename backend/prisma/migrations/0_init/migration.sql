-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "PullRequestState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "FileChangeType" AS ENUM ('ADDED', 'MODIFIED', 'REMOVED', 'RENAMED', 'COPIED', 'CHANGED', 'UNCHANGED');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AnalysisStage" AS ENUM ('NORMALIZING', 'FETCHING_DIFF', 'EXTRACTING_FEATURES', 'PREDICTING', 'EXPLAINING', 'RECOMMENDING', 'PERSISTING', 'DONE');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MODERATE', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ScoringEngine" AS ENUM ('MODEL', 'HEURISTIC');

-- CreateEnum
CREATE TYPE "FactorDirection" AS ENUM ('INCREASES_RISK', 'DECREASES_RISK', 'NEUTRAL');

-- CreateEnum
CREATE TYPE "FactorCategory" AS ENUM ('CHANGE_SHAPE', 'CHANGE_TYPE', 'BLAST_RADIUS', 'DEPENDENCY', 'DATA_LAYER', 'API_CONTRACT', 'REPOSITORY_HISTORY', 'AUTHOR_CONTEXT', 'PROCESS');

-- CreateEnum
CREATE TYPE "RecommendationCategory" AS ENUM ('TESTING', 'CODE_REVIEW', 'DEPENDENCY', 'DATABASE', 'API_CONTRACT', 'CONFIGURATION', 'SECURITY', 'OBSERVABILITY', 'ROLLOUT', 'SCOPE', 'DOCUMENTATION');

-- CreateEnum
CREATE TYPE "RecommendationPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RecommendationEffort" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "MergeDecisionType" AS ENUM ('APPROVED_MERGE', 'BLOCKED', 'DEFERRED', 'OVERRIDDEN', 'CLOSED_WITHOUT_MERGE');

-- CreateEnum
CREATE TYPE "DeploymentEnvironment" AS ENUM ('PRODUCTION', 'STAGING', 'PREVIEW', 'DEVELOPMENT');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'ROLLED_BACK', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('SEV1', 'SEV2', 'SEV3', 'SEV4');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('ANALYSIS_QUEUED', 'ANALYSIS_COMPLETED', 'ANALYSIS_FAILED', 'HIGH_RISK_PR', 'MERGE_DECISION_RECORDED', 'DEPLOYMENT_RECORDED', 'DEPLOYMENT_FAILED', 'REPOSITORY_CONNECTED', 'REPOSITORY_SYNC_FAILED', 'TEAM_MEMBER_ADDED', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "avatarUrl" TEXT,
    "githubId" BIGINT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "githubType" TEXT NOT NULL DEFAULT 'User',
    "company" TEXT,
    "location" TEXT,
    "bio" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_connections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessTokenCipher" TEXT NOT NULL,
    "accessTokenIv" TEXT NOT NULL,
    "accessTokenTag" TEXT NOT NULL,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenType" TEXT NOT NULL DEFAULT 'bearer',
    "expiresAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastValidatedAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "rateLimitRemaining" INTEGER,
    "rateLimitResetAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "avatarUrl" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,
    "defaultBranch" TEXT NOT NULL DEFAULT 'main',
    "language" TEXT,
    "htmlUrl" TEXT,
    "homepage" TEXT,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "forks" INTEGER NOT NULL DEFAULT 0,
    "openIssues" INTEGER NOT NULL DEFAULT 0,
    "sizeKb" INTEGER NOT NULL DEFAULT 0,
    "ownerUserId" TEXT NOT NULL,
    "teamId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "autoAnalyze" BOOLEAN NOT NULL DEFAULT true,
    "githubCreatedAt" TIMESTAMP(3),
    "githubPushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pull_requests" (
    "id" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "number" INTEGER NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" "PullRequestState" NOT NULL DEFAULT 'OPEN',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "authorLogin" TEXT NOT NULL,
    "authorAvatarUrl" TEXT,
    "authorGithubId" BIGINT,
    "baseRef" TEXT NOT NULL,
    "baseSha" TEXT,
    "headRef" TEXT NOT NULL,
    "headSha" TEXT NOT NULL,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changedFiles" INTEGER NOT NULL DEFAULT 0,
    "commits" INTEGER NOT NULL DEFAULT 0,
    "reviewComments" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "htmlUrl" TEXT,
    "mergeable" BOOLEAN,
    "mergeableState" TEXT,
    "githubCreatedAt" TIMESTAMP(3) NOT NULL,
    "githubUpdatedAt" TIMESTAMP(3) NOT NULL,
    "mergedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "mergedBySha" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changed_files" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "previousFilename" TEXT,
    "status" "FileChangeType" NOT NULL DEFAULT 'MODIFIED',
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "changes" INTEGER NOT NULL DEFAULT 0,
    "patch" TEXT,
    "patchTruncated" BOOLEAN NOT NULL DEFAULT false,
    "blobUrl" TEXT,
    "extension" TEXT,
    "language" TEXT,
    "module" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "isConfig" BOOLEAN NOT NULL DEFAULT false,
    "isDependencyManifest" BOOLEAN NOT NULL DEFAULT false,
    "isMigration" BOOLEAN NOT NULL DEFAULT false,
    "isInfra" BOOLEAN NOT NULL DEFAULT false,
    "isDocs" BOOLEAN NOT NULL DEFAULT false,
    "isGenerated" BOOLEAN NOT NULL DEFAULT false,
    "touchesPublicApi" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changed_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analyses" (
    "id" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "requestedById" TEXT,
    "headSha" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "stage" "AnalysisStage",
    "progress" INTEGER NOT NULL DEFAULT 0,
    "riskScore" DOUBLE PRECISION,
    "riskLevel" "RiskLevel",
    "probability" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION,
    "scoredBy" "ScoringEngine" NOT NULL DEFAULT 'MODEL',
    "modelName" TEXT,
    "modelVersion" TEXT,
    "features" JSONB,
    "featureSetVersion" TEXT,
    "summary" TEXT,
    "jobId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "degraded" BOOLEAN NOT NULL DEFAULT false,
    "degradedReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "risk_factors" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" DOUBLE PRECISION,
    "displayValue" TEXT,
    "shapValue" DOUBLE PRECISION NOT NULL,
    "contribution" DOUBLE PRECISION NOT NULL,
    "direction" "FactorDirection" NOT NULL,
    "category" "FactorCategory" NOT NULL DEFAULT 'CHANGE_SHAPE',
    "description" TEXT,
    "evidence" JSONB,
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "risk_factors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "rationale" TEXT,
    "category" "RecommendationCategory" NOT NULL,
    "priority" "RecommendationPriority" NOT NULL DEFAULT 'MEDIUM',
    "triggeredByFactorKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targets" JSONB,
    "effort" "RecommendationEffort" NOT NULL DEFAULT 'MEDIUM',
    "rank" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_events" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "stage" "AnalysisStage" NOT NULL,
    "status" "AnalysisStatus" NOT NULL,
    "message" TEXT,
    "durationMs" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merge_decisions" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "pullRequestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "decision" "MergeDecisionType" NOT NULL,
    "reason" TEXT,
    "riskScoreAtDecision" DOUBLE PRECISION,
    "riskLevelAtDecision" "RiskLevel",
    "addressedRecommendationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merge_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployments" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "pullRequestId" TEXT,
    "githubDeploymentId" BIGINT,
    "environment" "DeploymentEnvironment" NOT NULL DEFAULT 'PRODUCTION',
    "ref" TEXT,
    "sha" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "causedIncident" BOOLEAN,
    "incidentSummary" TEXT,
    "incidentSeverity" "IncidentSeverity",
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "riskScoreAtDeploy" DOUBLE PRECISION,
    "riskLevelAtDeploy" "RiskLevel",
    "description" TEXT,
    "actorLogin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_health_snapshots" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "bucketDate" TIMESTAMP(3) NOT NULL,
    "analysesCount" INTEGER NOT NULL DEFAULT 0,
    "pullRequestsOpened" INTEGER NOT NULL DEFAULT 0,
    "pullRequestsMerged" INTEGER NOT NULL DEFAULT 0,
    "avgRiskScore" DOUBLE PRECISION,
    "maxRiskScore" DOUBLE PRECISION,
    "p90RiskScore" DOUBLE PRECISION,
    "lowCount" INTEGER NOT NULL DEFAULT 0,
    "moderateCount" INTEGER NOT NULL DEFAULT 0,
    "highCount" INTEGER NOT NULL DEFAULT 0,
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "avgPrSize" DOUBLE PRECISION,
    "avgFilesChanged" DOUBLE PRECISION,
    "testCoverageRatio" DOUBLE PRECISION,
    "deploymentsCount" INTEGER NOT NULL DEFAULT 0,
    "failedDeployments" INTEGER NOT NULL DEFAULT 0,
    "incidentsCount" INTEGER NOT NULL DEFAULT 0,
    "topRiskFactors" JSONB,
    "healthScore" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repository_health_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "repositoryId" TEXT,
    "pullRequestId" TEXT,
    "analysisId" TEXT,
    "metadata" JSONB,
    "readAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_githubId_key" ON "users"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "users_githubLogin_key" ON "users"("githubLogin");

-- CreateIndex
CREATE INDEX "users_githubLogin_idx" ON "users"("githubLogin");

-- CreateIndex
CREATE UNIQUE INDEX "github_connections_userId_key" ON "github_connections"("userId");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "teams_slug_key" ON "teams"("slug");

-- CreateIndex
CREATE INDEX "teams_ownerId_idx" ON "teams"("ownerId");

-- CreateIndex
CREATE INDEX "team_members_userId_idx" ON "team_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_teamId_userId_key" ON "team_members"("teamId", "userId");

-- CreateIndex
CREATE INDEX "repositories_ownerUserId_isActive_idx" ON "repositories"("ownerUserId", "isActive");

-- CreateIndex
CREATE INDEX "repositories_teamId_idx" ON "repositories"("teamId");

-- CreateIndex
CREATE INDEX "repositories_fullName_idx" ON "repositories"("fullName");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_ownerUserId_githubId_key" ON "repositories"("ownerUserId", "githubId");

-- CreateIndex
CREATE INDEX "pull_requests_repositoryId_state_idx" ON "pull_requests"("repositoryId", "state");

-- CreateIndex
CREATE INDEX "pull_requests_repositoryId_githubUpdatedAt_idx" ON "pull_requests"("repositoryId", "githubUpdatedAt");

-- CreateIndex
CREATE INDEX "pull_requests_authorLogin_idx" ON "pull_requests"("authorLogin");

-- CreateIndex
CREATE UNIQUE INDEX "pull_requests_repositoryId_number_key" ON "pull_requests"("repositoryId", "number");

-- CreateIndex
CREATE INDEX "changed_files_pullRequestId_idx" ON "changed_files"("pullRequestId");

-- CreateIndex
CREATE INDEX "changed_files_module_idx" ON "changed_files"("module");

-- CreateIndex
CREATE UNIQUE INDEX "changed_files_pullRequestId_filename_key" ON "changed_files"("pullRequestId", "filename");

-- CreateIndex
CREATE INDEX "analyses_repositoryId_createdAt_idx" ON "analyses"("repositoryId", "createdAt");

-- CreateIndex
CREATE INDEX "analyses_pullRequestId_createdAt_idx" ON "analyses"("pullRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "analyses_status_idx" ON "analyses"("status");

-- CreateIndex
CREATE INDEX "analyses_riskLevel_idx" ON "analyses"("riskLevel");

-- CreateIndex
CREATE INDEX "analyses_requestedById_idx" ON "analyses"("requestedById");

-- CreateIndex
CREATE INDEX "risk_factors_analysisId_rank_idx" ON "risk_factors"("analysisId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "risk_factors_analysisId_key_key" ON "risk_factors"("analysisId", "key");

-- CreateIndex
CREATE INDEX "recommendations_analysisId_rank_idx" ON "recommendations"("analysisId", "rank");

-- CreateIndex
CREATE INDEX "analysis_events_analysisId_createdAt_idx" ON "analysis_events"("analysisId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "merge_decisions_analysisId_key" ON "merge_decisions"("analysisId");

-- CreateIndex
CREATE INDEX "merge_decisions_pullRequestId_idx" ON "merge_decisions"("pullRequestId");

-- CreateIndex
CREATE INDEX "merge_decisions_userId_idx" ON "merge_decisions"("userId");

-- CreateIndex
CREATE INDEX "deployments_repositoryId_startedAt_idx" ON "deployments"("repositoryId", "startedAt");

-- CreateIndex
CREATE INDEX "deployments_repositoryId_environment_startedAt_idx" ON "deployments"("repositoryId", "environment", "startedAt");

-- CreateIndex
CREATE INDEX "deployments_pullRequestId_idx" ON "deployments"("pullRequestId");

-- CreateIndex
CREATE INDEX "repository_health_snapshots_repositoryId_bucketDate_idx" ON "repository_health_snapshots"("repositoryId", "bucketDate");

-- CreateIndex
CREATE UNIQUE INDEX "repository_health_snapshots_repositoryId_bucketDate_key" ON "repository_health_snapshots"("repositoryId", "bucketDate");

-- CreateIndex
CREATE INDEX "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_analysisId_idx" ON "notifications"("analysisId");

-- AddForeignKey
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changed_files" ADD CONSTRAINT "changed_files_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "risk_factors" ADD CONSTRAINT "risk_factors_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_events" ADD CONSTRAINT "analysis_events_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_decisions" ADD CONSTRAINT "merge_decisions_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "analyses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_decisions" ADD CONSTRAINT "merge_decisions_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merge_decisions" ADD CONSTRAINT "merge_decisions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_pullRequestId_fkey" FOREIGN KEY ("pullRequestId") REFERENCES "pull_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_health_snapshots" ADD CONSTRAINT "repository_health_snapshots_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

