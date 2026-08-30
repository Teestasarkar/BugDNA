/**
 * Deployment timeline.
 *
 * The product question this answers: *which risky change preceded this
 * incident?*
 *
 * A timeline is a merged, chronological stream of three event types —
 * deployments, merged pull requests and completed analyses — so a reader can see
 * that a CRITICAL-scored PR merged at 14:02, deployed at 14:20, and that the
 * deployment was reported as causing an incident at 14:45.
 *
 * On correlation: BugDNA links a deployment to a PR by matching the deployment
 * SHA against the PR's merge commit or head commit, which is a factual join, not
 * an inference. Where a link cannot be made the event is still shown, unlinked.
 * The `correlation` block reports observed rates and is explicitly labelled as
 * association rather than causation — with the sample size attached, because a
 * "100% failure rate" over two deployments means nothing.
 */
import { prisma } from "../../lib/prisma";
import { badRequest, notFound } from "../../lib/errors";
import { createNotification } from "../notifications/notification.service";
import { publishEvent } from "../../realtime/bus";
import { EVENT, ROOM } from "../../realtime/events";
import { cacheDelPattern } from "../../lib/cache";
import { scoped } from "../../lib/logger";
import { ingestDeployments } from "../github/github.service";
import {
  accessibleRepositoryIds,
  assertRepositoryAccess,
  repositoryAccessWhere,
} from "../repositories/repository.access";
import type { AuthContext } from "../../types/express";

const log = scoped("timeline");

const DAY_MS = 86_400_000;

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
  /** Risk context, where the event has any. */
  riskScore: number | null;
  riskLevel: string | null;
  meta: Record<string, unknown>;
}

export interface TimelineResponse {
  events: TimelineEvent[];
  windowDays: number;
  correlation: {
    deploymentsWithLinkedPr: number;
    deploymentsTotal: number;
    incidentsReported: number;
    /** Average risk of PRs shipped in deployments that caused an incident. */
    avgRiskWhenIncident: number | null;
    /** Average risk of PRs shipped in deployments that did not. */
    avgRiskWhenClean: number | null;
    /** Sample sizes — without these the averages above are not interpretable. */
    incidentSampleSize: number;
    cleanSampleSize: number;
    /** Plain-language reading of the numbers, hedged to match the evidence. */
    interpretation: string;
  };
}

export interface TimelineFilters {
  repositoryId?: string;
  days?: number;
  environments?: Array<"PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT">;
  types?: TimelineEventType[];
  limit?: number;
}

export async function getTimeline(
  auth: AuthContext,
  filters: TimelineFilters = {},
): Promise<TimelineResponse> {
  const days = filters.days ?? 30;
  const since = new Date(Date.now() - days * DAY_MS);
  const limit = Math.min(filters.limit ?? 200, 500);

  if (filters.repositoryId) {
    await assertRepositoryAccess(auth, filters.repositoryId);
  }

  const repositoryIds = filters.repositoryId
    ? [filters.repositoryId]
    : await accessibleRepositoryIds(auth);

  if (repositoryIds.length === 0) {
    return {
      events: [],
      windowDays: days,
      correlation: emptyCorrelation(),
    };
  }

  const wants = (type: TimelineEventType): boolean =>
    !filters.types || filters.types.includes(type);

  const [deployments, mergedPrs, analyses] = await Promise.all([
    wants("DEPLOYMENT")
      ? prisma.deployment.findMany({
          where: {
            repositoryId: { in: repositoryIds },
            startedAt: { gte: since },
            ...(filters.environments?.length
              ? { environment: { in: filters.environments as never } }
              : {}),
          },
          orderBy: { startedAt: "desc" },
          take: limit,
          select: {
            id: true,
            environment: true,
            status: true,
            sha: true,
            ref: true,
            description: true,
            actorLogin: true,
            startedAt: true,
            finishedAt: true,
            durationMs: true,
            causedIncident: true,
            incidentSummary: true,
            incidentSeverity: true,
            riskScoreAtDeploy: true,
            riskLevelAtDeploy: true,
            repository: { select: { id: true, fullName: true } },
            pullRequest: {
              select: { id: true, number: true, title: true, authorLogin: true },
            },
          },
        })
      : Promise.resolve([]),

    wants("PULL_REQUEST_MERGED")
      ? prisma.pullRequest.findMany({
          where: {
            repositoryId: { in: repositoryIds },
            mergedAt: { gte: since },
          },
          orderBy: { mergedAt: "desc" },
          take: limit,
          select: {
            id: true,
            number: true,
            title: true,
            authorLogin: true,
            additions: true,
            deletions: true,
            changedFiles: true,
            mergedAt: true,
            mergedBySha: true,
            repository: { select: { id: true, fullName: true } },
            analyses: {
              where: { status: "COMPLETED" },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true, riskScore: true, riskLevel: true },
            },
          },
        })
      : Promise.resolve([]),

    wants("ANALYSIS")
      ? prisma.analysis.findMany({
          where: {
            repositoryId: { in: repositoryIds },
            status: "COMPLETED",
            completedAt: { gte: since },
            // Only surface the noteworthy ones, or the timeline becomes a log.
            riskLevel: { in: ["HIGH", "CRITICAL"] },
          },
          orderBy: { completedAt: "desc" },
          take: limit,
          select: {
            id: true,
            riskScore: true,
            riskLevel: true,
            completedAt: true,
            headSha: true,
            repository: { select: { id: true, fullName: true } },
            pullRequest: { select: { id: true, number: true, title: true, authorLogin: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const events: TimelineEvent[] = [
    ...deployments.map((d): TimelineEvent => ({
      id: `deploy:${d.id}`,
      type: "DEPLOYMENT",
      at: d.startedAt.toISOString(),
      title: d.causedIncident
        ? `${d.environment.toLowerCase()} deployment caused an incident`
        : `Deployed to ${d.environment.toLowerCase()}`,
      subtitle: d.pullRequest
        ? `#${d.pullRequest.number} ${d.pullRequest.title}`
        : (d.description ?? `${d.sha.slice(0, 7)}`),
      repositoryId: d.repository.id,
      repositoryFullName: d.repository.fullName,
      href: d.pullRequest ? `/pulls/${d.pullRequest.id}` : null,
      riskScore: d.riskScoreAtDeploy,
      riskLevel: d.riskLevelAtDeploy,
      meta: {
        environment: d.environment,
        status: d.status,
        sha: d.sha.slice(0, 7),
        ref: d.ref,
        actorLogin: d.actorLogin,
        durationMs: d.durationMs,
        finishedAt: d.finishedAt?.toISOString() ?? null,
        causedIncident: d.causedIncident,
        incidentSummary: d.incidentSummary,
        incidentSeverity: d.incidentSeverity,
        linkedPullRequestNumber: d.pullRequest?.number ?? null,
      },
    })),

    ...mergedPrs
      .filter((pr) => pr.mergedAt !== null)
      .map((pr): TimelineEvent => {
        const latest = pr.analyses[0];
        return {
          id: `merge:${pr.id}`,
          type: "PULL_REQUEST_MERGED",
          at: (pr.mergedAt as Date).toISOString(),
          title: `Merged #${pr.number}`,
          subtitle: pr.title,
          repositoryId: pr.repository.id,
          repositoryFullName: pr.repository.fullName,
          href: `/pulls/${pr.id}`,
          riskScore: latest?.riskScore ?? null,
          riskLevel: latest?.riskLevel ?? null,
          meta: {
            authorLogin: pr.authorLogin,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changedFiles,
            mergeSha: pr.mergedBySha?.slice(0, 7) ?? null,
            analysisId: latest?.id ?? null,
            /** Merged without ever being analysed — worth seeing. */
            unanalysed: latest === undefined,
          },
        };
      }),

    ...analyses
      .filter((a) => a.completedAt !== null)
      .map((a): TimelineEvent => ({
        id: `analysis:${a.id}`,
        type: "ANALYSIS",
        at: (a.completedAt as Date).toISOString(),
        title: `${a.riskLevel} risk assessed on #${a.pullRequest.number}`,
        subtitle: a.pullRequest.title,
        repositoryId: a.repository.id,
        repositoryFullName: a.repository.fullName,
        href: `/analyses/${a.id}`,
        riskScore: a.riskScore,
        riskLevel: a.riskLevel,
        meta: {
          authorLogin: a.pullRequest.authorLogin,
          sha: a.headSha.slice(0, 7),
          pullRequestNumber: a.pullRequest.number,
        },
      })),
  ]
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, limit);

  return {
    events,
    windowDays: days,
    correlation: buildCorrelation(deployments),
  };
}

type DeploymentForCorrelation = {
  causedIncident: boolean | null;
  riskScoreAtDeploy: number | null;
  pullRequest: { id: string } | null;
};

const emptyCorrelation = (): TimelineResponse["correlation"] => ({
  deploymentsWithLinkedPr: 0,
  deploymentsTotal: 0,
  incidentsReported: 0,
  avgRiskWhenIncident: null,
  avgRiskWhenClean: null,
  incidentSampleSize: 0,
  cleanSampleSize: 0,
  interpretation: "No deployments have been recorded in this window.",
});

/**
 * Summarise the observed relationship between shipped risk and incidents.
 *
 * Careful on purpose. This is the claim a product like BugDNA is most tempted to
 * overstate, so the interpretation text is written to match the evidence
 * available: with a handful of deployments it says so rather than reporting a
 * percentage that sounds authoritative.
 */
function buildCorrelation(
  deployments: DeploymentForCorrelation[],
): TimelineResponse["correlation"] {
  if (deployments.length === 0) return emptyCorrelation();

  const linked = deployments.filter((d) => d.pullRequest !== null);
  const withIncident = deployments.filter(
    (d) => d.causedIncident === true && d.riskScoreAtDeploy !== null,
  );
  const clean = deployments.filter(
    (d) => d.causedIncident !== true && d.riskScoreAtDeploy !== null,
  );

  const mean = (rows: DeploymentForCorrelation[]): number | null =>
    rows.length === 0
      ? null
      : Math.round(
          (rows.reduce((sum, d) => sum + (d.riskScoreAtDeploy ?? 0), 0) / rows.length) * 10,
        ) / 10;

  const avgIncident = mean(withIncident);
  const avgClean = mean(clean);
  const incidentsReported = deployments.filter((d) => d.causedIncident === true).length;

  let interpretation: string;

  if (incidentsReported === 0) {
    interpretation =
      `No incidents have been reported for the ${deployments.length} deployment(s) in this window. ` +
      `Report deployment outcomes to build up a comparison.`;
  } else if (withIncident.length < 3 || clean.length < 3) {
    interpretation =
      `Too few deployments with recorded risk scores (${withIncident.length} with incidents, ` +
      `${clean.length} without) to say anything meaningful about the relationship yet.`;
  } else if (avgIncident !== null && avgClean !== null && avgIncident > avgClean + 5) {
    interpretation =
      `Deployments that caused an incident shipped changes scoring ${avgIncident} on average, ` +
      `against ${avgClean} for those that did not. That is an association observed in this ` +
      `repository's history, not proof of causation.`;
  } else if (avgIncident !== null && avgClean !== null && avgClean > avgIncident + 5) {
    interpretation =
      `Incidents in this window followed lower-scoring changes (${avgIncident} average) than ` +
      `clean deployments (${avgClean}). The risk signals are not tracking this repository's ` +
      `failures — worth investigating what they are missing.`;
  } else {
    interpretation =
      `Risk scores for deployments with and without incidents are similar ` +
      `(${avgIncident} versus ${avgClean}), so shipped risk is not currently distinguishing them.`;
  }

  return {
    deploymentsWithLinkedPr: linked.length,
    deploymentsTotal: deployments.length,
    incidentsReported,
    avgRiskWhenIncident: avgIncident,
    avgRiskWhenClean: avgClean,
    incidentSampleSize: withIncident.length,
    cleanSampleSize: clean.length,
    interpretation,
  };
}

// ---------------------------------------------------------------------------
// Deployments
// ---------------------------------------------------------------------------

export interface RecordDeploymentInput {
  repositoryId: string;
  sha: string;
  environment?: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
  status?: "PENDING" | "IN_PROGRESS" | "SUCCESS" | "FAILURE" | "ROLLED_BACK" | "CANCELLED";
  ref?: string;
  description?: string;
  startedAt?: Date;
  finishedAt?: Date;
}

/**
 * Record a deployment manually.
 *
 * Most teams' deployments do not go through the GitHub Deployments API, so this
 * exists alongside `ingestDeployments`. It performs the same SHA-based PR linkage
 * and denormalises the shipped risk score for the timeline.
 */
export async function recordDeployment(
  auth: AuthContext,
  input: RecordDeploymentInput,
): Promise<{ id: string; linkedPullRequestId: string | null }> {
  await assertRepositoryAccess(auth, input.repositoryId);

  const sha = input.sha.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
    throw badRequest("`sha` must be a 7-40 character hexadecimal commit SHA.");
  }

  // Match the deployed commit to a PR: merge commit first, then head.
  const pr = await prisma.pullRequest.findFirst({
    where: {
      repositoryId: input.repositoryId,
      OR: [{ mergedBySha: { startsWith: sha } }, { headSha: { startsWith: sha } }],
    },
    orderBy: { mergedAt: "desc" },
    select: {
      id: true,
      number: true,
      analyses: {
        where: { status: "COMPLETED" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { riskScore: true, riskLevel: true },
      },
    },
  });

  const latest = pr?.analyses[0];
  const startedAt = input.startedAt ?? new Date();

  const deployment = await prisma.deployment.create({
    data: {
      repositoryId: input.repositoryId,
      pullRequestId: pr?.id ?? null,
      sha,
      ref: input.ref ?? null,
      environment: input.environment ?? "PRODUCTION",
      status: input.status ?? "SUCCESS",
      description: input.description?.slice(0, 1000) ?? null,
      actorLogin: auth.githubLogin,
      startedAt,
      finishedAt: input.finishedAt ?? null,
      durationMs: input.finishedAt
        ? input.finishedAt.getTime() - startedAt.getTime()
        : null,
      riskScoreAtDeploy: latest?.riskScore ?? null,
      riskLevelAtDeploy: latest?.riskLevel ?? null,
    },
    select: { id: true, environment: true, status: true, sha: true },
  });

  await publishEvent({
    name: EVENT.deploymentRecorded,
    rooms: [ROOM.repository(input.repositoryId), ROOM.user(auth.userId)],
    payload: {
      deploymentId: deployment.id,
      repositoryId: input.repositoryId,
      environment: deployment.environment,
      status: deployment.status,
      sha: deployment.sha,
      causedIncident: null,
      startedAt: startedAt.toISOString(),
    },
  });

  await cacheDelPattern(`cache:analytics:repo:${input.repositoryId}:*`);

  log.info(
    { deploymentId: deployment.id, repositoryId: input.repositoryId, linkedPr: pr?.number },
    "deployment recorded",
  );

  return { id: deployment.id, linkedPullRequestId: pr?.id ?? null };
}

/**
 * Report the outcome of a deployment.
 *
 * This is the only ground truth BugDNA ever receives, and it is what the
 * `module_incident_history` feature and the correlation panel are built on.
 * Deliberately human-reported: inferring an incident from telemetry BugDNA
 * cannot see would be a fabrication.
 */
export async function reportDeploymentOutcome(
  auth: AuthContext,
  deploymentId: string,
  input: {
    causedIncident: boolean;
    incidentSummary?: string;
    incidentSeverity?: "SEV1" | "SEV2" | "SEV3" | "SEV4";
    status?: "SUCCESS" | "FAILURE" | "ROLLED_BACK";
  },
): Promise<{ id: string }> {
  const deployment = await prisma.deployment.findFirst({
    where: { id: deploymentId, repository: repositoryAccessWhere(auth) },
    select: {
      id: true,
      repositoryId: true,
      sha: true,
      environment: true,
      repository: { select: { fullName: true } },
      pullRequest: { select: { number: true, title: true } },
    },
  });

  if (!deployment) throw notFound("Deployment");

  await prisma.deployment.update({
    where: { id: deploymentId },
    data: {
      causedIncident: input.causedIncident,
      incidentSummary: input.incidentSummary?.slice(0, 2000) ?? null,
      incidentSeverity: input.incidentSeverity ?? null,
      ...(input.status ? { status: input.status } : {}),
      finishedAt: new Date(),
    },
  });

  if (input.causedIncident) {
    await createNotification({
      userId: auth.userId,
      type: "DEPLOYMENT_FAILED",
      severity: input.incidentSeverity === "SEV1" ? "CRITICAL" : "WARNING",
      title: `Incident recorded for ${deployment.repository.fullName}`,
      body: deployment.pullRequest
        ? `Deployment of #${deployment.pullRequest.number} (${deployment.sha.slice(0, 7)}) was reported as causing an incident.`
        : `Deployment ${deployment.sha.slice(0, 7)} was reported as causing an incident.`,
      href: `/timeline?repositoryId=${deployment.repositoryId}`,
      repositoryId: deployment.repositoryId,
    });
  }

  // The incident-history feature reads from this table, so drop the analytics
  // cache and let the next analysis pick up the new ground truth.
  await cacheDelPattern(`cache:analytics:repo:${deployment.repositoryId}:*`);

  log.info(
    { deploymentId, causedIncident: input.causedIncident, by: auth.githubLogin },
    "deployment outcome reported",
  );

  return { id: deploymentId };
}

/** Pull deployments from the GitHub Deployments API. */
export async function syncDeployments(auth: AuthContext, repositoryId: string) {
  await assertRepositoryAccess(auth, repositoryId);
  const result = await ingestDeployments(auth.userId, repositoryId);
  await cacheDelPattern(`cache:analytics:repo:${repositoryId}:*`);
  return result;
}

/** Deployment list for a repository, for the deployments table. */
export async function listDeployments(
  auth: AuthContext,
  filters: { repositoryId?: string; skip?: number; take?: number } = {},
) {
  if (filters.repositoryId) await assertRepositoryAccess(auth, filters.repositoryId);

  const where = {
    repository: repositoryAccessWhere(auth),
    ...(filters.repositoryId ? { repositoryId: filters.repositoryId } : {}),
  };

  const [items, total] = await Promise.all([
    prisma.deployment.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: filters.skip ?? 0,
      take: filters.take ?? 25,
      select: {
        id: true,
        environment: true,
        status: true,
        sha: true,
        ref: true,
        description: true,
        actorLogin: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
        causedIncident: true,
        incidentSummary: true,
        incidentSeverity: true,
        riskScoreAtDeploy: true,
        riskLevelAtDeploy: true,
        repository: { select: { id: true, fullName: true } },
        pullRequest: { select: { id: true, number: true, title: true, authorLogin: true } },
      },
    }),
    prisma.deployment.count({ where }),
  ]);

  return { items, total };
}
