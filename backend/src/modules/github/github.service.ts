/**
 * GitHub service.
 *
 * The seam between "what GitHub returned" and "what BugDNA stores". Two jobs:
 *
 *  1. **Credential handling.** Resolve a user's encrypted token, decrypt it and
 *     hand it to the provider. Nothing above this layer ever sees a token.
 *  2. **Normalisation and persistence.** Turn GitHub payloads into rows,
 *     classifying every changed file on the way in so the diff view and the
 *     feature extractor agree on what a file is.
 *
 * The provider (`live` or `mock`) is chosen once from configuration, so every
 * caller is agnostic to which one is active.
 */
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { openToken, sealToken } from "../../lib/crypto";
import { scoped } from "../../lib/logger";
import { cached, cacheDelPattern } from "../../lib/cache";
import { CACHE_KEYS } from "../../config/constants";
import {
  AppError,
  githubNotConnected,
  githubTokenInvalid,
  notFound,
} from "../../lib/errors";
import { liveGitHubProvider } from "./github.client";
import { mockGitHubProvider } from "./github.mock";
import {
  classifyFile,
  toFileChangeType,
  truncatePatch,
} from "../analysis/features/classify";
import type {
  GhPullRequestDetail,
  GhRateLimit,
  GhRepository,
  GitHubProvider,
  ListPullRequestsOptions,
  ListRepositoriesOptions,
} from "./github.types";

const log = scoped("github-service");

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

export function getProvider(): GitHubProvider {
  return env.GITHUB_MODE === "mock" ? mockGitHubProvider : liveGitHubProvider;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Resolve and decrypt a user's GitHub token.
 *
 * A decryption failure is treated as an invalid connection rather than a server
 * error: it means the encryption key rotated, and the only remedy is for the
 * user to reconnect. Telling them that is more useful than a 500.
 */
export async function getUserToken(userId: string): Promise<string> {
  const connection = await prisma.githubConnection.findUnique({
    where: { userId },
    select: {
      accessTokenCipher: true,
      accessTokenIv: true,
      accessTokenTag: true,
      revokedAt: true,
    },
  });

  if (!connection || connection.revokedAt) throw githubNotConnected();

  try {
    return openToken({
      cipher: connection.accessTokenCipher,
      iv: connection.accessTokenIv,
      tag: connection.accessTokenTag,
    });
  } catch (e) {
    log.error({ err: e, userId }, "failed to decrypt GitHub token");
    throw githubTokenInvalid();
  }
}

/** Store (or replace) a user's GitHub credential. */
export async function saveUserToken(
  userId: string,
  accessToken: string,
  meta: { scopes: string[]; tokenType?: string; expiresInSeconds?: number },
): Promise<void> {
  const sealed = sealToken(accessToken);
  const expiresAt = meta.expiresInSeconds
    ? new Date(Date.now() + meta.expiresInSeconds * 1000)
    : null;

  await prisma.githubConnection.upsert({
    where: { userId },
    create: {
      userId,
      accessTokenCipher: sealed.cipher,
      accessTokenIv: sealed.iv,
      accessTokenTag: sealed.tag,
      scopes: meta.scopes,
      tokenType: meta.tokenType ?? "bearer",
      expiresAt,
      lastValidatedAt: new Date(),
    },
    update: {
      accessTokenCipher: sealed.cipher,
      accessTokenIv: sealed.iv,
      accessTokenTag: sealed.tag,
      scopes: meta.scopes,
      tokenType: meta.tokenType ?? "bearer",
      expiresAt,
      lastValidatedAt: new Date(),
      revokedAt: null,
    },
  });
}

export async function revokeConnection(userId: string): Promise<void> {
  await prisma.githubConnection.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  await cacheDelPattern(`cache:gh:*${userId}*`);
}

/** Record the latest rate-limit view so the UI can warn ahead of failures. */
async function recordRateLimit(userId: string, rateLimit?: GhRateLimit): Promise<void> {
  if (!rateLimit) return;
  await prisma.githubConnection
    .update({
      where: { userId },
      data: {
        rateLimitRemaining: rateLimit.remaining,
        rateLimitResetAt: rateLimit.resetAt,
      },
    })
    .catch(() => undefined); // telemetry, never fatal
}

export async function getConnectionStatus(userId: string): Promise<{
  connected: boolean;
  scopes: string[];
  connectedAt: string | null;
  lastSyncedAt: string | null;
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  mode: "live" | "mock";
  /** True when the `repo` scope is present, i.e. private repos are reachable. */
  canReadPrivateRepos: boolean;
}> {
  const connection = await prisma.githubConnection.findUnique({
    where: { userId },
    select: {
      scopes: true,
      connectedAt: true,
      lastSyncedAt: true,
      revokedAt: true,
      rateLimitRemaining: true,
      rateLimitResetAt: true,
    },
  });

  const connected = Boolean(connection && !connection.revokedAt);

  return {
    connected,
    scopes: connection?.scopes ?? [],
    connectedAt: connection?.connectedAt?.toISOString() ?? null,
    lastSyncedAt: connection?.lastSyncedAt?.toISOString() ?? null,
    rateLimitRemaining: connection?.rateLimitRemaining ?? null,
    rateLimitResetAt: connection?.rateLimitResetAt?.toISOString() ?? null,
    mode: getProvider().mode,
    canReadPrivateRepos: (connection?.scopes ?? []).includes("repo"),
  };
}

// ---------------------------------------------------------------------------
// Browsing GitHub (pre-connection)
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
  /** Already connected in BugDNA — the UI shows "Connected" instead of "Connect". */
  connected: boolean;
  connectedRepositoryId: string | null;
  /** Whether the token can actually read the code (needed for diffs). */
  canPull: boolean;
}

/**
 * List the repositories a user could connect, annotated with what is already
 * connected.
 *
 * Cached per user+page: the list changes rarely, and this is hit on every visit
 * to the connect screen.
 */
export async function listAvailableRepositories(
  userId: string,
  options: ListRepositoriesOptions & { search?: string } = {},
): Promise<{ items: AvailableRepository[]; page: number; perPage: number; hasNextPage: boolean; cached: boolean }> {
  const token = await getUserToken(userId);
  const provider = getProvider();

  const page = options.page ?? 1;
  const perPage = options.perPage ?? 30;
  const search = (options.search ?? "").trim().toLowerCase();

  const key = CACHE_KEYS.githubUserRepos(userId, page, perPage, search);

  const { value, hit } = await cached(key, env.CACHE_TTL_REPOS, async () => {
    const result = await provider.listRepositories(token, { ...options, page, perPage });
    await recordRateLimit(userId, result.rateLimit);
    return {
      repos: result.items,
      hasNextPage: result.hasNextPage,
    };
  });

  // Which of these are already connected? Resolved from our own DB, never cached
  // with the GitHub payload — connection state changes independently.
  const githubIds = value.repos.map((r) => BigInt(r.id));
  const connectedRows = githubIds.length
    ? await prisma.repository.findMany({
        where: { ownerUserId: userId, githubId: { in: githubIds } },
        select: { id: true, githubId: true },
      })
    : [];

  const connectedByGithubId = new Map(
    connectedRows.map((r) => [r.githubId.toString(), r.id]),
  );

  let items = value.repos.map((r) => toAvailableRepository(r, connectedByGithubId));

  if (search) {
    items = items.filter(
      (r) =>
        r.fullName.toLowerCase().includes(search) ||
        (r.description ?? "").toLowerCase().includes(search),
    );
  }

  return { items, page, perPage, hasNextPage: value.hasNextPage, cached: hit };
}

function toAvailableRepository(
  r: GhRepository,
  connected: Map<string, string>,
): AvailableRepository {
  const connectedId = connected.get(String(r.id)) ?? null;
  return {
    githubId: String(r.id),
    owner: r.owner.login,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    description: r.description,
    language: r.language,
    defaultBranch: r.default_branch,
    stars: r.stargazers_count,
    forks: r.forks_count,
    openIssues: r.open_issues_count,
    htmlUrl: r.html_url,
    pushedAt: r.pushed_at,
    connected: connectedId !== null,
    connectedRepositoryId: connectedId,
    // `pull` is what the diff endpoints require. Without it, connecting would
    // succeed and every analysis would then fail — better to surface it here.
    canPull: r.permissions?.pull ?? true,
  };
}

// ---------------------------------------------------------------------------
// Pull request synchronisation
// ---------------------------------------------------------------------------

export interface SyncResult {
  repositoryId: string;
  synced: number;
  created: number;
  updated: number;
  fromCache: boolean;
}

/**
 * Pull the PR list for a connected repository and reconcile it into Postgres.
 *
 * Upsert-based rather than delete-and-replace: analyses reference pull requests,
 * so rows must survive a re-sync.
 */
export async function syncPullRequests(
  userId: string,
  repositoryId: string,
  options: ListPullRequestsOptions = {},
): Promise<SyncResult> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, owner: true, name: true, ownerUserId: true },
  });

  if (!repository) throw notFound("Repository");

  const token = await getUserToken(userId);
  const provider = getProvider();
  const state = options.state ?? "open";
  const page = options.page ?? 1;

  const key = CACHE_KEYS.githubPulls(repositoryId, state, page);

  let created = 0;
  let updated = 0;

  const { value, hit } = await cached(key, env.CACHE_TTL_PULLS, async () => {
    const result = await provider.listPullRequests(token, repository.owner, repository.name, {
      ...options,
      state,
      page,
    });
    await recordRateLimit(userId, result.rateLimit);
    return result.items;
  });

  for (const pr of value) {
    // Named `prState` to avoid shadowing the `state` filter above.
    const prState =
      pr.merged_at !== null ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN";

    const data = {
      githubId: BigInt(pr.id),
      title: pr.title.slice(0, 1000),
      body: pr.body?.slice(0, 20_000) ?? null,
      state: prState as "OPEN" | "CLOSED" | "MERGED",
      draft: pr.draft,
      locked: pr.locked,
      authorLogin: pr.user?.login ?? "unknown",
      authorAvatarUrl: pr.user?.avatar_url ?? null,
      authorGithubId: pr.user ? BigInt(pr.user.id) : null,
      baseRef: pr.base.ref,
      baseSha: pr.base.sha,
      headRef: pr.head.ref,
      headSha: pr.head.sha,
      comments: pr.comments ?? 0,
      reviewComments: pr.review_comments ?? 0,
      labels: pr.labels.map((l) => l.name),
      htmlUrl: pr.html_url,
      githubCreatedAt: new Date(pr.created_at),
      githubUpdatedAt: new Date(pr.updated_at),
      mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
      closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
      mergedBySha: pr.merge_commit_sha,
      lastSyncedAt: new Date(),
    };

    const existing = await prisma.pullRequest.findUnique({
      where: { repositoryId_number: { repositoryId, number: pr.number } },
      select: { id: true },
    });

    if (existing) {
      // The list endpoint does not return additions/deletions/changed_files, so
      // those are deliberately left untouched here — they are filled in by
      // `ingestPullRequestDiff` when the PR is opened or analysed.
      await prisma.pullRequest.update({
        where: { id: existing.id },
        data,
      });
      updated++;
    } else {
      await prisma.pullRequest.create({
        data: { ...data, repositoryId, number: pr.number },
      });
      created++;
    }
  }

  await prisma.repository.update({
    where: { id: repositoryId },
    data: { lastSyncedAt: new Date(), syncError: null },
  });

  await prisma.githubConnection
    .update({ where: { userId }, data: { lastSyncedAt: new Date() } })
    .catch(() => undefined);

  log.info({ repositoryId, synced: value.length, created, updated }, "pull requests synced");

  return { repositoryId, synced: value.length, created, updated, fromCache: hit };
}

// ---------------------------------------------------------------------------
// Diff ingestion
// ---------------------------------------------------------------------------

export interface IngestedDiff {
  pullRequestId: string;
  headSha: string;
  filesIngested: number;
  /** True when GitHub capped the file list or patches were cut. */
  truncated: boolean;
  degradedReasons: string[];
}

/**
 * Fetch a PR's detail and changed files, then persist both.
 *
 * This is the step the risk pipeline depends on. It records `truncated` and any
 * degradation reasons rather than silently analysing a partial diff, because a
 * feature vector computed from half a PR is misleading, and the UI says so.
 */
export async function ingestPullRequestDiff(
  userId: string,
  repositoryId: string,
  pullNumber: number,
): Promise<IngestedDiff> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, owner: true, name: true },
  });
  if (!repository) throw notFound("Repository");

  const token = await getUserToken(userId);
  const provider = getProvider();
  const degradedReasons: string[] = [];

  const detail = await provider.getPullRequest(
    token,
    repository.owner,
    repository.name,
    pullNumber,
  );

  const { files, truncated } = await provider.listPullRequestFiles(
    token,
    repository.owner,
    repository.name,
    pullNumber,
  );

  if (truncated) {
    degradedReasons.push(
      `GitHub returned only the first ${files.length} changed files for this pull request; ` +
        `risk signals are computed from a partial diff.`,
    );
  }

  const pullRequest = await upsertPullRequestDetail(repositoryId, detail);

  // Replace the file set for this PR. Safe to delete: ChangedFile has no
  // children, and the head SHA determines its content.
  await prisma.changedFile.deleteMany({ where: { pullRequestId: pullRequest.id } });

  let missingPatches = 0;

  for (const file of files) {
    const { patch, truncated: patchTruncated } = truncatePatch(
      file.patch,
      env.GITHUB_MAX_PATCH_BYTES,
    );

    if (!file.patch) missingPatches++;

    const classification = classifyFile(file.filename, patch);

    await prisma.changedFile.create({
      data: {
        pullRequestId: pullRequest.id,
        filename: file.filename.slice(0, 1024),
        previousFilename: file.previous_filename?.slice(0, 1024) ?? null,
        status: toFileChangeType(file.status),
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch,
        patchTruncated,
        blobUrl: file.blob_url,
        extension: classification.extension,
        language: classification.language,
        module: classification.module,
        isTest: classification.isTest,
        isConfig: classification.isConfig,
        isDependencyManifest: classification.isDependencyManifest,
        isMigration: classification.isMigration,
        isInfra: classification.isInfra,
        isDocs: classification.isDocs,
        isGenerated: classification.isGenerated,
        touchesPublicApi: classification.touchesPublicApi,
      },
    });
  }

  if (missingPatches > 0) {
    degradedReasons.push(
      `${missingPatches} of ${files.length} files had no diff content available ` +
        `(binary or too large); content-based signals could not be computed for them.`,
    );
  }

  log.info(
    { repositoryId, pullNumber, files: files.length, truncated },
    "pull request diff ingested",
  );

  return {
    pullRequestId: pullRequest.id,
    headSha: detail.head.sha,
    filesIngested: files.length,
    truncated,
    degradedReasons,
  };
}

/** Upsert the full PR detail, including the aggregate change counts. */
async function upsertPullRequestDetail(
  repositoryId: string,
  detail: GhPullRequestDetail,
): Promise<{ id: string }> {
  const state = detail.merged_at !== null ? "MERGED" : detail.state === "closed" ? "CLOSED" : "OPEN";

  const shared = {
    githubId: BigInt(detail.id),
    title: detail.title.slice(0, 1000),
    body: detail.body?.slice(0, 20_000) ?? null,
    state: state as "OPEN" | "CLOSED" | "MERGED",
    draft: detail.draft,
    locked: detail.locked,
    authorLogin: detail.user?.login ?? "unknown",
    authorAvatarUrl: detail.user?.avatar_url ?? null,
    authorGithubId: detail.user ? BigInt(detail.user.id) : null,
    baseRef: detail.base.ref,
    baseSha: detail.base.sha,
    headRef: detail.head.ref,
    headSha: detail.head.sha,
    additions: detail.additions,
    deletions: detail.deletions,
    changedFiles: detail.changed_files,
    commits: detail.commits,
    comments: detail.comments,
    reviewComments: detail.review_comments,
    labels: detail.labels.map((l) => l.name),
    htmlUrl: detail.html_url,
    mergeable: detail.mergeable,
    mergeableState: detail.mergeable_state,
    githubCreatedAt: new Date(detail.created_at),
    githubUpdatedAt: new Date(detail.updated_at),
    mergedAt: detail.merged_at ? new Date(detail.merged_at) : null,
    closedAt: detail.closed_at ? new Date(detail.closed_at) : null,
    mergedBySha: detail.merge_commit_sha,
    lastSyncedAt: new Date(),
  };

  return prisma.pullRequest.upsert({
    where: { repositoryId_number: { repositoryId, number: detail.number } },
    create: { ...shared, repositoryId, number: detail.number },
    update: shared,
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

/**
 * Ingest GitHub Deployments for a repository, linking each to the PR whose
 * merge commit matches its SHA. That linkage is what makes the deployment
 * timeline able to say "this deploy shipped PR #431, which scored HIGH".
 */
export async function ingestDeployments(
  userId: string,
  repositoryId: string,
): Promise<{ ingested: number; linked: number }> {
  const repository = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { id: true, owner: true, name: true },
  });
  if (!repository) throw notFound("Repository");

  const token = await getUserToken(userId);
  const provider = getProvider();

  const deployments = await provider.listDeployments(token, repository.owner, repository.name, {
    perPage: 50,
  });

  let ingested = 0;
  let linked = 0;

  for (const d of deployments) {
    // Match on merge commit first, then head SHA — a squashed merge produces a
    // merge commit that is not any PR's head.
    const pr = await prisma.pullRequest.findFirst({
      where: { repositoryId, OR: [{ mergedBySha: d.sha }, { headSha: d.sha }] },
      select: {
        id: true,
        analyses: {
          where: { status: "COMPLETED" },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { riskScore: true, riskLevel: true },
        },
      },
    });

    const latestAnalysis = pr?.analyses[0];

    const existing = await prisma.deployment.findFirst({
      where: { repositoryId, githubDeploymentId: BigInt(d.id) },
      select: { id: true },
    });

    const data = {
      environment: normaliseEnvironment(d.environment),
      ref: d.ref,
      sha: d.sha,
      description: d.description?.slice(0, 1000) ?? null,
      actorLogin: d.creator?.login ?? null,
      startedAt: new Date(d.created_at),
      pullRequestId: pr?.id ?? null,
      riskScoreAtDeploy: latestAnalysis?.riskScore ?? null,
      riskLevelAtDeploy: latestAnalysis?.riskLevel ?? null,
    };

    if (existing) {
      await prisma.deployment.update({ where: { id: existing.id }, data });
    } else {
      await prisma.deployment.create({
        data: { ...data, repositoryId, githubDeploymentId: BigInt(d.id) },
      });
      ingested++;
    }

    if (pr) linked++;
  }

  log.info({ repositoryId, ingested, linked }, "deployments ingested");
  return { ingested, linked };
}

function normaliseEnvironment(
  value: string,
): "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT" {
  const v = value.toLowerCase();
  if (v.includes("prod")) return "PRODUCTION";
  if (v.includes("stag")) return "STAGING";
  if (v.includes("preview") || v.includes("pr-")) return "PREVIEW";
  return "DEVELOPMENT";
}

/** Surface configuration problems as a first-class error, not a 500. */
export function assertGithubConfigured(): void {
  if (env.GITHUB_MODE === "mock") return;
  if (!env.githubConfigured) {
    throw new AppError(
      503,
      "GitHub sign-in is not configured on this deployment.",
      { code: "GITHUB_NOT_CONFIGURED", retryable: false },
    );
  }
}
