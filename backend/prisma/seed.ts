/**
 * Seed the demo tenant.
 *
 * Creates a self-contained account with realistic repositories, pull requests,
 * diffs, deployments and incidents — so a fresh deployment has something to show
 * rather than an empty dashboard, and so the product can be demonstrated with no
 * GitHub credentials and no network.
 *
 * The important part: **analyses are produced by the real pipeline.** This script
 * does not write invented risk scores. It extracts features from the seeded
 * diffs and calls the actual risk service, so every score, SHAP contribution,
 * explanation and recommendation in the demo is genuinely computed by the same
 * code path a real pull request goes through. If the risk service is
 * unreachable, the script seeds everything else and says clearly that analyses
 * were skipped, rather than fabricating them.
 *
 * Idempotent: safe to run repeatedly. Re-running refreshes the demo data without
 * duplicating it.
 *
 *   npm run seed
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { mockFixtures } from "../src/modules/github/github.mock";
import { classifyFile, toFileChangeType } from "../src/modules/analysis/features/classify";
import { extractFeatures } from "../src/modules/analysis/features/extract";
import { buildExplanation } from "../src/modules/analysis/explain/explain";
import { buildRecommendations } from "../src/modules/analysis/recommend/rules";
import { predict } from "../src/modules/ml/ml.client";
import { checkMlService } from "../src/modules/ml/ml.client";
import { scoreToRiskLevel } from "../src/config/constants";
import { sealToken } from "../src/lib/crypto";
import { env } from "../src/config/env";

const prisma = new PrismaClient();

/** Deterministic team-mate accounts so the team dashboard has real members. */
const TEAMMATES = [
  { login: "marcus-lee", name: "Marcus Lee", githubId: 900_300_001, role: "ADMIN" as const },
  { login: "dana-whitfield", name: "Dana Whitfield", githubId: 900_300_002, role: "MEMBER" as const },
  { login: "priya-n", name: "Priya Nadkarni", githubId: 900_300_003, role: "MEMBER" as const },
  { login: "sam-oyelaran", name: "Sam Oyelaran", githubId: 900_300_004, role: "MEMBER" as const },
];

function log(message: string): void {
  process.stdout.write(`  ${message}\n`);
}

function section(title: string): void {
  process.stdout.write(`\n${title}\n`);
}

// ---------------------------------------------------------------------------
// Users & team
// ---------------------------------------------------------------------------

async function seedUsers() {
  section("Users");

  const demoUser = await prisma.user.upsert({
    where: { githubId: BigInt(mockFixtures.user.id) },
    create: {
      githubId: BigInt(mockFixtures.user.id),
      githubLogin: env.SEED_DEMO_LOGIN,
      email: env.SEED_DEMO_EMAIL,
      name: mockFixtures.user.name,
      avatarUrl: mockFixtures.user.avatar_url,
      company: mockFixtures.user.company,
      location: mockFixtures.user.location,
      bio: mockFixtures.user.bio,
      isDemo: true,
      lastSeenAt: new Date(),
    },
    update: { isDemo: true, lastSeenAt: new Date(), githubLogin: env.SEED_DEMO_LOGIN },
    select: { id: true, githubLogin: true },
  });

  log(`demo user: ${demoUser.githubLogin}`);

  // The demo account needs a GitHub connection row so `requireGithubConnection`
  // passes and the flows behave identically to a real account. The stored token
  // is a placeholder that only the mock provider ever accepts.
  const sealed = sealToken("mock_seeded_demo_token_not_a_real_credential");
  await prisma.githubConnection.upsert({
    where: { userId: demoUser.id },
    create: {
      userId: demoUser.id,
      accessTokenCipher: sealed.cipher,
      accessTokenIv: sealed.iv,
      accessTokenTag: sealed.tag,
      scopes: ["read:user", "user:email", "repo"],
      lastValidatedAt: new Date(),
      lastSyncedAt: new Date(),
      rateLimitRemaining: 4_987,
      rateLimitResetAt: new Date(Date.now() + 3_600_000),
    },
    update: {
      accessTokenCipher: sealed.cipher,
      accessTokenIv: sealed.iv,
      accessTokenTag: sealed.tag,
      revokedAt: null,
      lastSyncedAt: new Date(),
    },
  });

  const teammates = [];
  for (const mate of TEAMMATES) {
    const user = await prisma.user.upsert({
      where: { githubId: BigInt(mate.githubId) },
      create: {
        githubId: BigInt(mate.githubId),
        githubLogin: mate.login,
        name: mate.name,
        email: `${mate.login}@bugdna.dev`,
        avatarUrl: `https://avatars.githubusercontent.com/u/${mate.githubId}?v=4`,
        isDemo: true,
      },
      update: { isDemo: true },
      select: { id: true, githubLogin: true },
    });
    teammates.push({ ...user, role: mate.role });
  }

  log(`teammates: ${teammates.map((t) => t.githubLogin).join(", ")}`);

  return { demoUser, teammates };
}

async function seedTeam(
  ownerId: string,
  teammates: Array<{ id: string; role: "ADMIN" | "MEMBER" }>,
) {
  section("Team");

  const team = await prisma.team.upsert({
    where: { slug: "platform-engineering" },
    create: {
      name: "Platform Engineering",
      slug: "platform-engineering",
      description:
        "Owns the payments, checkout and risk platform services. Uses BugDNA to gate pre-merge risk.",
      ownerId,
    },
    update: { ownerId },
    select: { id: true, name: true },
  });

  await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId: ownerId } },
    create: { teamId: team.id, userId: ownerId, role: "OWNER" },
    update: { role: "OWNER" },
  });

  for (const mate of teammates) {
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: team.id, userId: mate.id } },
      create: { teamId: team.id, userId: mate.id, role: mate.role },
      update: { role: mate.role },
    });
  }

  log(`${team.name} with ${teammates.length + 1} members`);
  return team;
}

// ---------------------------------------------------------------------------
// Repositories, pull requests, diffs
// ---------------------------------------------------------------------------

async function seedRepositories(ownerUserId: string, teamId: string) {
  section("Repositories and pull requests");

  const repositories = [];

  for (const spec of mockFixtures.repos) {
    const ghRepo = mockFixtures.toGhRepository(spec);

    const repository = await prisma.repository.upsert({
      where: {
        ownerUserId_githubId: { ownerUserId, githubId: BigInt(ghRepo.id) },
      },
      create: {
        githubId: BigInt(ghRepo.id),
        owner: ghRepo.owner.login,
        name: ghRepo.name,
        fullName: ghRepo.full_name,
        private: ghRepo.private,
        description: ghRepo.description,
        defaultBranch: ghRepo.default_branch,
        language: ghRepo.language,
        htmlUrl: ghRepo.html_url,
        stars: ghRepo.stargazers_count,
        forks: ghRepo.forks_count,
        openIssues: ghRepo.open_issues_count,
        sizeKb: ghRepo.size,
        ownerUserId,
        teamId,
        isActive: true,
        autoAnalyze: true,
        lastSyncedAt: new Date(),
        githubCreatedAt: ghRepo.created_at ? new Date(ghRepo.created_at) : null,
        githubPushedAt: ghRepo.pushed_at ? new Date(ghRepo.pushed_at) : null,
      },
      update: { teamId, isActive: true, lastSyncedAt: new Date(), syncError: null },
      select: { id: true, fullName: true, owner: true, name: true },
    });

    // --- pull requests ----------------------------------------------------
    const pullRequests = [];

    for (let number = 1; number <= spec.prCount; number++) {
      const detail = mockFixtures.buildPullDetail(spec, number);
      const files = mockFixtures.buildFiles(spec, number);

      const state =
        detail.merged_at !== null ? "MERGED" : detail.state === "closed" ? "CLOSED" : "OPEN";

      const pr = await prisma.pullRequest.upsert({
        where: { repositoryId_number: { repositoryId: repository.id, number } },
        create: {
          repositoryId: repository.id,
          number,
          githubId: BigInt(detail.id),
          title: detail.title,
          body: detail.body,
          state,
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
        },
        update: {
          title: detail.title,
          state,
          headSha: detail.head.sha,
          additions: detail.additions,
          deletions: detail.deletions,
          changedFiles: detail.changed_files,
          commits: detail.commits,
          githubUpdatedAt: new Date(detail.updated_at),
          mergedAt: detail.merged_at ? new Date(detail.merged_at) : null,
          mergedBySha: detail.merge_commit_sha,
          lastSyncedAt: new Date(),
        },
        select: { id: true, number: true, headSha: true, title: true, authorLogin: true },
      });

      // --- changed files, classified exactly as ingestion would -----------
      await prisma.changedFile.deleteMany({ where: { pullRequestId: pr.id } });

      const fileRows: Prisma.ChangedFileCreateManyInput[] = files.map((file) => {
        const classification = classifyFile(file.filename, file.patch ?? null);
        return {
          pullRequestId: pr.id,
          filename: file.filename,
          status: toFileChangeType(file.status),
          additions: file.additions,
          deletions: file.deletions,
          changes: file.additions + file.deletions,
          patch: file.patch ?? null,
          patchTruncated: false,
          blobUrl: `https://github.com/${repository.fullName}/blob/${pr.headSha}/${file.filename}`,
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
        };
      });

      await prisma.changedFile.createMany({ data: fileRows });
      pullRequests.push(pr);
    }

    repositories.push({ ...repository, pullRequests });
    log(`${repository.fullName}: ${pullRequests.length} pull requests`);
  }

  return repositories;
}

// ---------------------------------------------------------------------------
// Deployments and incidents
// ---------------------------------------------------------------------------

/**
 * Seed deployments for merged pull requests, marking a couple as having caused
 * incidents.
 *
 * The incidents are what make the timeline's correlation panel and the
 * `module_incident_history` feature meaningful — without any reported outcome,
 * both correctly report that there is nothing to compare.
 */
async function seedDeployments(
  repositories: Array<{
    id: string;
    fullName: string;
    pullRequests: Array<{ id: string; number: number; headSha: string }>;
  }>,
) {
  section("Deployments");

  let created = 0;
  let incidents = 0;

  for (const repository of repositories) {
    const merged = await prisma.pullRequest.findMany({
      where: { repositoryId: repository.id, mergedAt: { not: null } },
      orderBy: { mergedAt: "desc" },
      select: { id: true, number: true, mergedAt: true, mergedBySha: true, headSha: true },
    });

    await prisma.deployment.deleteMany({ where: { repositoryId: repository.id } });

    for (const [index, pr] of merged.entries()) {
      const mergedAt = pr.mergedAt as Date;
      // Deploy roughly 40 minutes after merge.
      const startedAt = new Date(mergedAt.getTime() + 40 * 60_000);
      const durationMs = 3 * 60_000 + index * 12_000;

      // Every third merged PR in the first repository is reported as having
      // caused an incident, giving the correlation panel a real sample.
      const causedIncident = index % 3 === 0 && index < 4;

      await prisma.deployment.create({
        data: {
          repositoryId: repository.id,
          pullRequestId: pr.id,
          sha: pr.mergedBySha ?? pr.headSha,
          ref: "main",
          environment: "PRODUCTION",
          status: causedIncident ? "ROLLED_BACK" : "SUCCESS",
          description: `Automated deploy of #${pr.number} from main`,
          actorLogin: "github-actions[bot]",
          startedAt,
          finishedAt: new Date(startedAt.getTime() + durationMs),
          durationMs,
          causedIncident: causedIncident ? true : false,
          incidentSummary: causedIncident
            ? "Elevated 5xx rate on the payments API shortly after rollout; rolled back and reapplied with a fix."
            : null,
          incidentSeverity: causedIncident ? "SEV2" : null,
        },
      });

      created++;
      if (causedIncident) incidents++;
    }

    // A staging deployment for the most recent open PR, so the timeline shows
    // more than one environment.
    const latestOpen = await prisma.pullRequest.findFirst({
      where: { repositoryId: repository.id, state: "OPEN" },
      orderBy: { githubUpdatedAt: "desc" },
      select: { id: true, headSha: true, number: true },
    });

    if (latestOpen) {
      await prisma.deployment.create({
        data: {
          repositoryId: repository.id,
          pullRequestId: latestOpen.id,
          sha: latestOpen.headSha,
          ref: `refs/pull/${latestOpen.number}/head`,
          environment: "STAGING",
          status: "SUCCESS",
          description: `Preview deploy of #${latestOpen.number}`,
          actorLogin: "github-actions[bot]",
          startedAt: new Date(Date.now() - 4 * 3_600_000),
          finishedAt: new Date(Date.now() - 4 * 3_600_000 + 150_000),
          durationMs: 150_000,
        },
      });
      created++;
    }
  }

  log(`${created} deployments, ${incidents} reported incidents`);
  return { created, incidents };
}

// ---------------------------------------------------------------------------
// Analyses — run through the real pipeline
// ---------------------------------------------------------------------------

/**
 * Analyse the seeded pull requests using the production code path.
 *
 * Feature extraction, scoring, SHAP explanation and recommendation generation
 * are all the real implementations. Only the queue is bypassed — this runs
 * inline so the seed completes deterministically instead of depending on a
 * worker being up.
 */
async function seedAnalyses(
  requestedById: string,
  repositories: Array<{
    id: string;
    fullName: string;
    pullRequests: Array<{ id: string; number: number; headSha: string; title: string; authorLogin: string }>;
  }>,
): Promise<{ analysed: number; skipped: number }> {
  section("Analyses (via the real risk pipeline)");

  const health = await checkMlService();
  if (!health.ok) {
    log(`risk service unreachable at ${env.ML_SERVICE_URL} — skipping analyses.`);
    log(`   reason: ${health.error ?? "unknown"}`);
    log(`   start it with:  docker compose up ml-service`);
    log(`   then re-run:    npm run seed`);
    return { analysed: 0, skipped: repositories.reduce((n, r) => n + r.pullRequests.length, 0) };
  }

  log(`risk service: ${health.engine} engine, model ${health.modelVersion ?? "unversioned"}`);

  let analysed = 0;
  let skipped = 0;

  for (const repository of repositories) {
    for (const pr of repository.pullRequests) {
      try {
        const pullRequest = await prisma.pullRequest.findUnique({
          where: { id: pr.id },
          select: {
            id: true,
            number: true,
            title: true,
            body: true,
            authorLogin: true,
            draft: true,
            additions: true,
            deletions: true,
            changedFiles: true,
            commits: true,
            comments: true,
            reviewComments: true,
            labels: true,
            githubCreatedAt: true,
            githubUpdatedAt: true,
            files: {
              select: {
                filename: true,
                status: true,
                additions: true,
                deletions: true,
                changes: true,
                language: true,
                module: true,
                isTest: true,
                isConfig: true,
                isDependencyManifest: true,
                isMigration: true,
                isInfra: true,
                isDocs: true,
                isGenerated: true,
                touchesPublicApi: true,
                patch: true,
              },
            },
          },
        });

        if (!pullRequest) continue;

        const extraction = await extractFeatures({
          repositoryId: repository.id,
          pullRequest,
          files: pullRequest.files.map((f) => ({ ...f, status: f.status as string })),
        });

        const prediction = await predict({
          feature_set_version: extraction.featureSetVersion,
          features: extraction.features,
          context: {
            analysis_id: `seed-${repository.id}-${pr.number}`,
            repository: repository.fullName,
            pull_request_number: pr.number,
          },
          max_contributions: 16,
        });

        const scoredBy = prediction.model.engine === "heuristic" ? "HEURISTIC" : "MODEL";
        const riskScore = Math.max(0, Math.min(100, prediction.prediction.risk_score));
        const riskLevel = scoreToRiskLevel(riskScore);

        const degradedReasons = [...extraction.degradedReasons, ...prediction.warnings];
        if (scoredBy === "HEURISTIC") {
          degradedReasons.push(
            "No trained model artifact was available, so this score came from the transparent " +
              "rule-based fallback scorer rather than the XGBoost model.",
          );
        }

        const explanation = buildExplanation({
          contributions: prediction.explanation.contributions,
          features: extraction.features,
          evidence: extraction.evidence,
          explanation: prediction.explanation,
          riskScore,
          riskLevel,
          pullRequest: {
            number: pullRequest.number,
            authorLogin: pullRequest.authorLogin,
            title: pullRequest.title,
          },
          scoredBy,
          degradedReasons,
        });

        const recommendations = buildRecommendations({
          features: extraction.features,
          evidence: extraction.evidence,
          factors: explanation.factors,
          riskLevel,
          riskScore,
          modules: extraction.modules,
          pullRequest: {
            number: pullRequest.number,
            authorLogin: pullRequest.authorLogin,
            title: pullRequest.title,
          },
        });

        // Backdate to the PR's own timeline so the trend charts have shape.
        const completedAt = new Date(pullRequest.githubUpdatedAt.getTime() + 5 * 60_000);

        // Replace any prior seeded analysis for this exact commit.
        await prisma.analysis.deleteMany({
          where: { pullRequestId: pr.id, headSha: pr.headSha },
        });

        const analysis = await prisma.analysis.create({
          data: {
            pullRequestId: pr.id,
            repositoryId: repository.id,
            requestedById,
            headSha: pr.headSha,
            status: "COMPLETED",
            stage: "DONE",
            progress: 100,
            riskScore,
            riskLevel,
            probability: prediction.prediction.probability,
            confidence: prediction.prediction.confidence,
            scoredBy,
            modelName: prediction.model.name,
            modelVersion: prediction.model.version,
            features: extraction.features as never,
            featureSetVersion: extraction.featureSetVersion,
            summary: explanation.summary,
            queuedAt: new Date(completedAt.getTime() - 30_000),
            startedAt: new Date(completedAt.getTime() - 28_000),
            completedAt,
            createdAt: new Date(completedAt.getTime() - 30_000),
            durationMs: 2_400 + (pr.number % 7) * 300,
            degraded: degradedReasons.length > 0,
            degradedReasons,
            riskFactors: {
              create: explanation.factors.map((factor) => ({
                key: factor.key,
                label: factor.label,
                value: factor.value,
                displayValue: factor.displayValue,
                shapValue: factor.shapValue,
                contribution: factor.contribution,
                direction: factor.direction,
                category: factor.category,
                description: factor.description,
                evidence: (factor.evidence ?? undefined) as never,
                rank: factor.rank,
              })),
            },
            recommendations: {
              create: recommendations.map((rec, index) => ({
                title: rec.title,
                description: rec.description,
                rationale: rec.rationale,
                category: rec.category,
                priority: rec.priority,
                effort: rec.effort,
                triggeredByFactorKeys: rec.triggeredByFactorKeys,
                targets: (rec.targets ?? undefined) as never,
                rank: index + 1,
              })),
            },
            events: {
              create: [
                { stage: "NORMALIZING", status: "RUNNING", message: "Reading pull request metadata", durationMs: 120 },
                { stage: "FETCHING_DIFF", status: "RUNNING", message: "Retrieving changed files", durationMs: 640 },
                { stage: "EXTRACTING_FEATURES", status: "RUNNING", message: "Extracting risk signals", durationMs: 310 },
                { stage: "PREDICTING", status: "RUNNING", message: "Scoring with the risk model", durationMs: 780 },
                { stage: "EXPLAINING", status: "RUNNING", message: "Attributing the score to factors", durationMs: 160 },
                { stage: "RECOMMENDING", status: "RUNNING", message: "Producing mitigations", durationMs: 90 },
                {
                  stage: "DONE",
                  status: "COMPLETED",
                  message: `Scored ${Math.round(riskScore)}/100 (${riskLevel})`,
                  durationMs: 45,
                },
              ],
            },
          },
          select: { id: true },
        });

        // Backfill the risk snapshot onto deployments that shipped this PR, so
        // the timeline shows what risk actually went out.
        await prisma.deployment.updateMany({
          where: { pullRequestId: pr.id },
          data: { riskScoreAtDeploy: riskScore, riskLevelAtDeploy: riskLevel },
        });

        analysed++;
        process.stdout.write(
          `  ${repository.fullName} #${String(pr.number).padEnd(3)} ` +
            `${String(Math.round(riskScore)).padStart(3)}/100 ${riskLevel.padEnd(8)} ` +
            `${explanation.factors.length} factors, ${recommendations.length} recommendations\n`,
        );

        void analysis;
      } catch (e) {
        skipped++;
        log(
          `${repository.fullName} #${pr.number}: skipped (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
  }

  return { analysed, skipped };
}

// ---------------------------------------------------------------------------
// Merge decisions and notifications
// ---------------------------------------------------------------------------

/**
 * Record merge decisions on some analysed pull requests.
 *
 * This is what populates the "how often do we override high risk" rollup on the
 * team dashboard — the loop from assessment to human decision.
 */
async function seedMergeDecisions(userId: string): Promise<number> {
  section("Merge decisions");

  const analyses = await prisma.analysis.findMany({
    where: { status: "COMPLETED", mergeDecision: null },
    orderBy: { riskScore: "desc" },
    take: 14,
    select: {
      id: true,
      pullRequestId: true,
      riskScore: true,
      riskLevel: true,
      completedAt: true,
      pullRequest: { select: { state: true, number: true } },
      recommendations: { select: { id: true }, take: 2 },
    },
  });

  let created = 0;

  for (const [index, analysis] of analyses.entries()) {
    // Only decide on PRs that are actually resolved, plus a couple of open ones
    // that were explicitly blocked.
    const isMerged = analysis.pullRequest.state === "MERGED";
    const isHighRisk = analysis.riskLevel === "HIGH" || analysis.riskLevel === "CRITICAL";

    let decision: "APPROVED_MERGE" | "BLOCKED" | "DEFERRED" | "OVERRIDDEN" | "CLOSED_WITHOUT_MERGE";
    let reason: string | null;

    if (isMerged && isHighRisk) {
      decision = "OVERRIDDEN";
      reason =
        "Release deadline for the ledger migration. Deployed behind a feature flag with the " +
        "on-call engineer watching the payments dashboard, and a tested rollback ready.";
    } else if (isMerged) {
      decision = "APPROVED_MERGE";
      reason = null;
    } else if (isHighRisk && index % 2 === 0) {
      decision = "BLOCKED";
      reason = "Holding until the destructive migration has a verified backfill and rollback plan.";
    } else if (index % 3 === 0) {
      decision = "DEFERRED";
      reason = "Waiting on a review from the module owner.";
    } else {
      continue;
    }

    await prisma.mergeDecision.create({
      data: {
        analysisId: analysis.id,
        pullRequestId: analysis.pullRequestId,
        userId,
        decision,
        reason,
        riskScoreAtDecision: analysis.riskScore,
        riskLevelAtDecision: analysis.riskLevel,
        addressedRecommendationIds:
          decision === "APPROVED_MERGE" ? analysis.recommendations.map((r) => r.id) : [],
        createdAt: analysis.completedAt ?? new Date(),
      },
    });

    created++;
  }

  log(`${created} merge decisions recorded`);
  return created;
}

async function seedNotifications(userId: string): Promise<number> {
  section("Notifications");

  await prisma.notification.deleteMany({ where: { userId } });

  const highRisk = await prisma.analysis.findMany({
    where: { status: "COMPLETED", riskLevel: { in: ["HIGH", "CRITICAL"] } },
    orderBy: { riskScore: "desc" },
    take: 5,
    select: {
      id: true,
      riskScore: true,
      riskLevel: true,
      repositoryId: true,
      pullRequestId: true,
      completedAt: true,
      repository: { select: { fullName: true } },
      pullRequest: { select: { number: true, title: true } },
    },
  });

  const rows: Prisma.NotificationCreateManyInput[] = highRisk.map((analysis, index) => ({
    userId,
    type: "HIGH_RISK_PR",
    severity: analysis.riskLevel === "CRITICAL" ? "CRITICAL" : "WARNING",
    title: `High-risk pull request in ${analysis.repository.fullName}`,
    body:
      `#${analysis.pullRequest.number} "${analysis.pullRequest.title}" scored ` +
      `${Math.round(analysis.riskScore ?? 0)}/100 (${analysis.riskLevel}).`,
    href: `/analyses/${analysis.id}`,
    repositoryId: analysis.repositoryId,
    pullRequestId: analysis.pullRequestId,
    analysisId: analysis.id,
    // Leave the two most recent unread so the bell shows a badge.
    readAt: index < 2 ? null : new Date(),
    createdAt: analysis.completedAt ?? new Date(),
  }));

  const incidentDeployment = await prisma.deployment.findFirst({
    where: { causedIncident: true },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      sha: true,
      repositoryId: true,
      startedAt: true,
      repository: { select: { fullName: true } },
      pullRequest: { select: { number: true } },
    },
  });

  if (incidentDeployment) {
    rows.push({
      userId,
      type: "DEPLOYMENT_FAILED",
      severity: "CRITICAL",
      title: `Incident recorded for ${incidentDeployment.repository.fullName}`,
      body:
        `Deployment of #${incidentDeployment.pullRequest?.number ?? "?"} ` +
        `(${incidentDeployment.sha.slice(0, 7)}) was rolled back after elevated 5xx rates.`,
      href: `/timeline?repositoryId=${incidentDeployment.repositoryId}`,
      repositoryId: incidentDeployment.repositoryId,
      readAt: null,
      createdAt: incidentDeployment.startedAt,
    });
  }

  rows.push({
    userId,
    type: "SYSTEM",
    severity: "INFO",
    title: "Welcome to BugDNA",
    body: "This demo tenant is seeded with synthetic repositories, pull requests and real analyses.",
    href: "/dashboard",
    readAt: new Date(),
    createdAt: new Date(Date.now() - 30 * 86_400_000),
  });

  await prisma.notification.createMany({ data: rows });
  log(`${rows.length} notifications`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  process.stdout.write("\nSeeding the BugDNA demo tenant\n");
  process.stdout.write("==============================\n");

  const { demoUser, teammates } = await seedUsers();
  const team = await seedTeam(demoUser.id, teammates);
  const repositories = await seedRepositories(demoUser.id, team.id);
  await seedDeployments(repositories);
  const { analysed, skipped } = await seedAnalyses(demoUser.id, repositories);

  if (analysed > 0) {
    await seedMergeDecisions(demoUser.id);
  }

  await seedNotifications(demoUser.id);

  // Roll up the last 45 days so the health charts are populated on first load.
  section("Health snapshots");
  const { computeDailySnapshots } = await import("../src/modules/analytics/analytics.service");
  let snapshots = 0;
  for (let daysAgo = 45; daysAgo >= 0; daysAgo--) {
    snapshots += await computeDailySnapshots(new Date(Date.now() - daysAgo * 86_400_000));
  }
  log(`${snapshots} daily snapshots computed`);

  // ---- summary -----------------------------------------------------------
  const counts = {
    users: await prisma.user.count(),
    repositories: await prisma.repository.count(),
    pullRequests: await prisma.pullRequest.count(),
    changedFiles: await prisma.changedFile.count(),
    analyses: await prisma.analysis.count(),
    riskFactors: await prisma.riskFactor.count(),
    recommendations: await prisma.recommendation.count(),
    deployments: await prisma.deployment.count(),
    notifications: await prisma.notification.count(),
  };

  process.stdout.write("\nSeed complete\n");
  process.stdout.write("-------------\n");
  for (const [key, value] of Object.entries(counts)) {
    process.stdout.write(`  ${key.padEnd(16)} ${value}\n`);
  }

  if (skipped > 0) {
    process.stdout.write(
      `\n  ${skipped} pull request(s) have no analysis yet.\n` +
        `  Start the risk service and re-run \`npm run seed\`, or analyse them from the UI.\n`,
    );
  }

  process.stdout.write(
    `\n  Sign in at ${env.APP_URL}/login and choose "View the demo"` +
      ` (or POST ${env.apiPrefix}/auth/demo).\n\n`,
  );
}

main()
  .catch((e) => {
    process.stderr.write(`\nSeed failed: ${e instanceof Error ? e.stack : String(e)}\n\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    // Redis connections are opened by the imported modules; close the process
    // explicitly so the script does not hang on open handles.
    const { disconnectRedis } = await import("../src/lib/redis");
    await disconnectRedis().catch(() => undefined);
  });
