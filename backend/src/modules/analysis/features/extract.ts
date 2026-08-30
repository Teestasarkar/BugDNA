/**
 * Feature extraction.
 *
 * Turns a persisted pull request + its classified diff + repository history into
 * the numeric vector the risk model consumes.
 *
 * Three properties this is built for:
 *
 *  - **Explainability.** Alongside every feature we record *evidence* — which
 *    files made it fire. That is what lets the UI turn "dependency_manifest_changed
 *    = 1" into "package-lock.json and package.json changed", and link the factor
 *    back to the diff.
 *
 *  - **Honesty about missing data.** History features need our own database to
 *    have seen this repository for a while. On a freshly connected repo they are
 *    unavailable, and rather than fabricating a plausible number we emit the
 *    documented fallback and record a degradation reason the UI shows.
 *
 *  - **Determinism.** Same commit, same vector. The only time-dependent feature
 *    is `pr_age_hours`, which is computed against the PR's last-updated
 *    timestamp rather than `now` where possible.
 */
import { prisma } from "../../../lib/prisma";
import { scoped } from "../../../lib/logger";
import { FEATURE_KEYS, fallbackVector, type FeatureVector } from "./registry";
import { FEATURE_SET_VERSION } from "../../../config/constants";

const log = scoped("features");

/** Windows used by the history features. Documented in docs/ML_MODEL.md. */
const RECENT_WINDOW_DAYS = 30;
const HISTORY_WINDOW_DAYS = 90;
/** Below this many prior PRs, repository history is treated as unavailable. */
const MIN_PRS_FOR_HISTORY = 3;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface ExtractionFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
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
  patch: string | null;
}

export interface ExtractionPullRequest {
  id: string;
  number: number;
  title: string;
  body: string | null;
  authorLogin: string;
  draft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  comments: number;
  reviewComments: number;
  labels: string[];
  githubCreatedAt: Date;
  githubUpdatedAt: Date;
}

export interface ExtractionInput {
  repositoryId: string;
  pullRequest: ExtractionPullRequest;
  files: ExtractionFile[];
}

export interface FeatureEvidence {
  /** Files that caused this feature to take its value. */
  files: string[];
  /** Optional note shown in the UI, e.g. the modules involved. */
  note?: string;
}

export interface ExtractionResult {
  features: FeatureVector;
  featureSetVersion: string;
  /** Distinct modules the PR touches, in descending order of churn. */
  modules: Array<{ module: string; churn: number; files: number }>;
  evidence: Record<string, FeatureEvidence>;
  /** Non-fatal problems the UI should disclose. */
  degradedReasons: string[];
  historyAvailable: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bool = (v: boolean): number => (v ? 1 : 0);

const safeDiv = (numerator: number, denominator: number, fallback = 0): number =>
  denominator === 0 ? fallback : numerator / denominator;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** Does the patch contain a destructive SQL operation? Re-checked from content. */
function patchHasDestructiveSql(file: ExtractionFile): boolean {
  if (!file.patch) return false;
  if (!file.isMigration && !file.filename.endsWith(".sql") && !file.filename.endsWith(".prisma")) {
    return false;
  }
  return /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|SCHEMA)\b|\bTRUNCATE\b|\bNOT\s+NULL\b(?![\s\S]{0,60}DEFAULT)/i.test(
    file.patch,
  );
}

function patchTouchesAuth(file: ExtractionFile): boolean {
  if (file.isDocs || file.isTest) return false;
  const haystack = `${file.filename}\n${file.patch ?? ""}`;
  return /\b(password|secret|token|credential|api[_-]?key|private[_-]?key|authenticate|authoriz|permission|\brole\b|jwt|oauth|session|encrypt|decrypt|bcrypt|argon2)\b/i.test(
    haystack,
  );
}

function patchRemovesErrorHandling(file: ExtractionFile): boolean {
  if (!file.patch) return false;
  return /^-\s*(try\s*\{|catch\s*\(|except\b|rescue\b)|^-\s*if\s*\(\s*(err|error)\b/m.test(
    file.patch,
  );
}

function patchAddsTodo(file: ExtractionFile): boolean {
  if (!file.patch) return false;
  return /^\+.*\b(TODO|FIXME|HACK|XXX)\b/im.test(file.patch);
}

// ---------------------------------------------------------------------------
// Repository history
// ---------------------------------------------------------------------------

interface HistoryContext {
  available: boolean;
  medianChurn30d: number;
  deploymentFailureRate90d: number;
  moduleIncidentHistory: number;
  authorPrCount90d: number;
  authorModuleFamiliarity: number;
  reasons: string[];
}

/**
 * Gather the historical signals.
 *
 * Deliberately all read-only aggregate queries against data we already ingested
 * — no extra GitHub calls, so extraction cost is bounded and offline-safe.
 */
async function loadHistory(
  repositoryId: string,
  pullRequest: ExtractionPullRequest,
  touchedModules: string[],
): Promise<HistoryContext> {
  const now = Date.now();
  const recentCutoff = new Date(now - RECENT_WINDOW_DAYS * 86_400_000);
  const historyCutoff = new Date(now - HISTORY_WINDOW_DAYS * 86_400_000);
  const reasons: string[] = [];

  const empty: HistoryContext = {
    available: false,
    medianChurn30d: 0,
    deploymentFailureRate90d: 0,
    moduleIncidentHistory: 0,
    authorPrCount90d: 0,
    authorModuleFamiliarity: 0,
    reasons,
  };

  try {
    // --- typical PR size in this repo -------------------------------------
    const recentPrs = await prisma.pullRequest.findMany({
      where: {
        repositoryId,
        id: { not: pullRequest.id },
        githubCreatedAt: { gte: recentCutoff },
      },
      select: { additions: true, deletions: true },
      take: 500,
    });

    if (recentPrs.length < MIN_PRS_FOR_HISTORY) {
      reasons.push(
        `This repository has only ${recentPrs.length} other pull request(s) in the last ` +
          `${RECENT_WINDOW_DAYS} days, so repository-history signals were not used. ` +
          `They become available as BugDNA observes more activity.`,
      );
      return { ...empty, reasons };
    }

    const medianChurn30d = median(recentPrs.map((p) => p.additions + p.deletions));

    // --- deployment reliability -------------------------------------------
    const [totalDeployments, failedDeployments] = await Promise.all([
      prisma.deployment.count({
        where: { repositoryId, startedAt: { gte: historyCutoff } },
      }),
      prisma.deployment.count({
        where: {
          repositoryId,
          startedAt: { gte: historyCutoff },
          OR: [
            { status: { in: ["FAILURE", "ROLLED_BACK"] } },
            { causedIncident: true },
          ],
        },
      }),
    ]);

    const deploymentFailureRate90d = safeDiv(failedDeployments, totalDeployments, 0);

    if (totalDeployments === 0) {
      reasons.push(
        "No deployments have been recorded for this repository, so deployment-reliability " +
          "signals were not used. Record deployments to enable them.",
      );
    }

    // --- incident history for the modules this PR touches -----------------
    let moduleIncidentHistory = 0;

    if (touchedModules.length > 0) {
      const incidentDeployments = await prisma.deployment.findMany({
        where: {
          repositoryId,
          startedAt: { gte: historyCutoff },
          causedIncident: true,
          pullRequestId: { not: null },
        },
        select: {
          pullRequest: {
            select: { files: { select: { module: true } } },
          },
        },
        take: 200,
      });

      if (incidentDeployments.length > 0) {
        const overlapping = incidentDeployments.filter((d) => {
          const modules = new Set(
            (d.pullRequest?.files ?? [])
              .map((f) => f.module)
              .filter((m): m is string => m !== null),
          );
          return touchedModules.some((m) => modules.has(m));
        }).length;

        moduleIncidentHistory = safeDiv(overlapping, incidentDeployments.length, 0);
      }
    }

    // --- author context ---------------------------------------------------
    const authorPrs = await prisma.pullRequest.findMany({
      where: {
        repositoryId,
        authorLogin: pullRequest.authorLogin,
        id: { not: pullRequest.id },
        githubCreatedAt: { gte: historyCutoff },
      },
      select: { files: { select: { module: true } } },
      take: 200,
    });

    const authorModules = new Set<string>();
    for (const pr of authorPrs) {
      for (const f of pr.files) {
        if (f.module) authorModules.add(f.module);
      }
    }

    const authorModuleFamiliarity =
      touchedModules.length === 0
        ? 0
        : safeDiv(
            touchedModules.filter((m) => authorModules.has(m)).length,
            touchedModules.length,
            0,
          );

    return {
      available: true,
      medianChurn30d,
      deploymentFailureRate90d,
      moduleIncidentHistory,
      authorPrCount90d: authorPrs.length,
      authorModuleFamiliarity,
      reasons,
    };
  } catch (e) {
    // History is an enhancement, not a requirement. A failure here degrades the
    // analysis rather than failing it.
    log.warn({ err: e, repositoryId }, "failed to load repository history");
    reasons.push(
      "Repository-history signals could not be loaded for this analysis and were " +
        "treated as unavailable.",
    );
    return { ...empty, reasons };
  }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export async function extractFeatures(input: ExtractionInput): Promise<ExtractionResult> {
  const { pullRequest: pr, files } = input;
  const degradedReasons: string[] = [];
  const evidence: Record<string, FeatureEvidence> = {};

  const record = (key: string, matchedFiles: string[], note?: string): void => {
    if (matchedFiles.length === 0 && !note) return;
    evidence[key] = { files: matchedFiles.slice(0, 12), ...(note ? { note } : {}) };
  };

  // ---- per-file partitions -------------------------------------------------
  const testFiles = files.filter((f) => f.isTest);
  const docsFiles = files.filter((f) => f.isDocs);
  const configFiles = files.filter((f) => f.isConfig);
  const infraFiles = files.filter((f) => f.isInfra);
  const dependencyFiles = files.filter((f) => f.isDependencyManifest);
  const migrationFiles = files.filter((f) => f.isMigration);
  const generatedFiles = files.filter((f) => f.isGenerated);
  const publicApiFiles = files.filter((f) => f.touchesPublicApi);
  const sourceFiles = files.filter(
    (f) => !f.isTest && !f.isDocs && !f.isGenerated && !f.isDependencyManifest,
  );

  const destructiveSqlFiles = files.filter(patchHasDestructiveSql);
  const authFiles = files.filter(patchTouchesAuth);
  const errorHandlingFiles = files.filter(patchRemovesErrorHandling);
  const todoFiles = files.filter(patchAddsTodo);

  const removedFiles = files.filter((f) => f.status === "REMOVED");
  const renamedFiles = files.filter((f) => f.status === "RENAMED" || f.status === "COPIED");

  // ---- churn --------------------------------------------------------------
  // Prefer the diff we actually stored; fall back to the PR payload's own
  // counts when the file list was unavailable.
  const filesChurn = files.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const linesAdded = files.length > 0 ? files.reduce((s, f) => s + f.additions, 0) : pr.additions;
  const linesDeleted =
    files.length > 0 ? files.reduce((s, f) => s + f.deletions, 0) : pr.deletions;
  const totalChurn = files.length > 0 ? filesChurn : pr.additions + pr.deletions;
  const filesChanged = files.length > 0 ? files.length : pr.changedFiles;

  if (files.length === 0) {
    degradedReasons.push(
      "No changed-file details were available, so size signals came from the pull " +
        "request summary and content-based signals could not be computed.",
    );
  }

  const testChurn = testFiles.reduce((s, f) => s + f.additions + f.deletions, 0);
  const sourceChurn = sourceFiles.reduce((s, f) => s + f.additions + f.deletions, 0);
  const lockfileChurn = dependencyFiles
    .filter((f) => /lock|\.sum$/i.test(f.filename))
    .reduce((s, f) => s + f.additions + f.deletions, 0);

  // ---- modules ------------------------------------------------------------
  const moduleChurn = new Map<string, { churn: number; files: number }>();
  for (const f of files) {
    const key = f.module ?? "(root)";
    const current = moduleChurn.get(key) ?? { churn: 0, files: 0 };
    current.churn += f.additions + f.deletions;
    current.files += 1;
    moduleChurn.set(key, current);
  }

  const modules = [...moduleChurn.entries()]
    .map(([module, v]) => ({ module, churn: v.churn, files: v.files }))
    .sort((a, b) => b.churn - a.churn);

  const touchedModules = modules.map((m) => m.module).filter((m) => m !== "(root)");
  const maxModuleChurn = modules[0]?.churn ?? 0;

  const languages = new Set(
    files.map((f) => f.language).filter((l): l is string => l !== null),
  );

  // ---- history ------------------------------------------------------------
  const history = await loadHistory(input.repositoryId, pr, touchedModules);
  degradedReasons.push(...history.reasons);

  // ---- assemble -----------------------------------------------------------
  const docsOnly = files.length > 0 && docsFiles.length === files.length;

  const features: FeatureVector = {
    ...fallbackVector(),

    // change shape
    lines_added: linesAdded,
    lines_deleted: linesDeleted,
    total_churn: totalChurn,
    files_changed: filesChanged,
    commits_count: pr.commits,
    avg_changes_per_file: safeDiv(totalChurn, filesChanged, 0),
    max_file_churn: files.reduce((max, f) => Math.max(max, f.additions + f.deletions), 0),
    deletion_ratio: safeDiv(linesDeleted, totalChurn, 0),
    files_removed: removedFiles.length,
    files_renamed: renamedFiles.length,

    // change type
    source_files_changed: sourceFiles.length,
    test_files_changed: testFiles.length,
    touches_tests: bool(testFiles.length > 0),
    test_to_source_ratio: safeDiv(testChurn, sourceChurn, 0),
    config_files_changed: configFiles.length,
    infra_files_changed: infraFiles.length,
    docs_only_change: bool(docsOnly),
    generated_files_changed: generatedFiles.length,
    adds_todo_markers: bool(todoFiles.length > 0),

    // dependency
    dependency_manifest_changed: bool(dependencyFiles.length > 0),
    dependency_files_changed: dependencyFiles.length,
    lockfile_churn: lockfileChurn,

    // data layer
    migration_files_changed: migrationFiles.length,
    has_destructive_sql: bool(destructiveSqlFiles.length > 0),

    // api contract
    touches_public_api: bool(publicApiFiles.length > 0),
    public_api_files_changed: publicApiFiles.length,
    touches_auth_or_secrets: bool(authFiles.length > 0),
    removes_error_handling: bool(errorHandlingFiles.length > 0),

    // blast radius
    modules_touched: touchedModules.length,
    cross_module_change: bool(touchedModules.length > 1),
    max_module_concentration: safeDiv(maxModuleChurn, totalChurn, 1),
    languages_touched: Math.max(1, languages.size),

    // process
    has_description: bool((pr.body ?? "").trim().length > 0),
    description_length: (pr.body ?? "").length,
    review_comments_count: pr.reviewComments,
    is_draft: bool(pr.draft),
    pr_age_hours: Math.max(
      0,
      (pr.githubUpdatedAt.getTime() - pr.githubCreatedAt.getTime()) / 3_600_000,
    ),

    // repository history
    repo_median_pr_churn_30d: history.medianChurn30d,
    churn_vs_repo_median: history.available
      ? safeDiv(totalChurn, history.medianChurn30d, 1)
      : 1,
    repo_deployment_failure_rate_90d: history.deploymentFailureRate90d,
    module_incident_history: history.moduleIncidentHistory,
    author_pr_count_90d: history.authorPrCount90d,
    author_module_familiarity: history.authorModuleFamiliarity,
  };

  // ---- evidence -----------------------------------------------------------
  record("test_files_changed", testFiles.map((f) => f.filename));
  record("touches_tests", testFiles.map((f) => f.filename));
  record("dependency_manifest_changed", dependencyFiles.map((f) => f.filename));
  record("dependency_files_changed", dependencyFiles.map((f) => f.filename));
  record("lockfile_churn", dependencyFiles.filter((f) => /lock|\.sum$/i.test(f.filename)).map((f) => f.filename));
  record("migration_files_changed", migrationFiles.map((f) => f.filename));
  record("has_destructive_sql", destructiveSqlFiles.map((f) => f.filename));
  record("touches_public_api", publicApiFiles.map((f) => f.filename));
  record("public_api_files_changed", publicApiFiles.map((f) => f.filename));
  record("touches_auth_or_secrets", authFiles.map((f) => f.filename));
  record("removes_error_handling", errorHandlingFiles.map((f) => f.filename));
  record("adds_todo_markers", todoFiles.map((f) => f.filename));
  record("config_files_changed", configFiles.map((f) => f.filename));
  record("infra_files_changed", infraFiles.map((f) => f.filename));
  record("files_removed", removedFiles.map((f) => f.filename));
  record("files_renamed", renamedFiles.map((f) => f.filename));
  record(
    "max_file_churn",
    files.length
      ? [
          [...files].sort(
            (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
          )[0]?.filename ?? "",
        ].filter(Boolean)
      : [],
  );
  record(
    "modules_touched",
    [],
    touchedModules.length > 0
      ? `Modules: ${modules
          .filter((m) => m.module !== "(root)")
          .slice(0, 6)
          .map((m) => `${m.module} (${m.churn} lines)`)
          .join(", ")}`
      : undefined,
  );
  record(
    "cross_module_change",
    [],
    touchedModules.length > 1 ? `Spans ${touchedModules.length} modules` : undefined,
  );
  record(
    "churn_vs_repo_median",
    [],
    history.available
      ? `Repository median is ${Math.round(history.medianChurn30d)} lines over the last ${RECENT_WINDOW_DAYS} days`
      : undefined,
  );
  record(
    "module_incident_history",
    [],
    history.available && history.moduleIncidentHistory > 0
      ? `${Math.round(history.moduleIncidentHistory * 100)}% of reported incidents in this repository involved these modules`
      : undefined,
  );
  record(
    "author_module_familiarity",
    [],
    history.available
      ? `${pr.authorLogin} has previously changed ${Math.round(history.authorModuleFamiliarity * 100)}% of the modules in this pull request`
      : undefined,
  );

  assertVectorMatchesRegistry(features);

  return {
    features,
    featureSetVersion: FEATURE_SET_VERSION,
    modules,
    evidence,
    degradedReasons,
    historyAvailable: history.available,
  };
}

/**
 * Guard against extractor/registry drift.
 *
 * If a feature is added to the registry but not computed here (or vice versa),
 * the model would silently receive a vector of a different shape. Failing here
 * turns that into an obvious error at the first analysis rather than a quiet
 * accuracy regression.
 */
function assertVectorMatchesRegistry(vector: FeatureVector): void {
  const produced = Object.keys(vector);
  const expected = new Set(FEATURE_KEYS);

  const extra = produced.filter((k) => !expected.has(k));
  const missing = FEATURE_KEYS.filter((k) => !(k in vector));

  if (extra.length > 0 || missing.length > 0) {
    throw new Error(
      `Feature vector does not match the registry. ` +
        `Missing: [${missing.join(", ")}]. Unexpected: [${extra.join(", ")}]. ` +
        `Update registry.ts and extract.ts together, then bump FEATURE_SET_VERSION.`,
    );
  }

  for (const [key, value] of Object.entries(vector)) {
    if (!Number.isFinite(value)) {
      throw new Error(`Feature "${key}" produced a non-finite value (${value}).`);
    }
  }
}

/**
 * Load everything extraction needs for a pull request, then extract.
 *
 * Kept here so the pipeline has a single call site and the query shape stays
 * next to the code that depends on it.
 */
export async function extractFeaturesForPullRequest(
  pullRequestId: string,
): Promise<ExtractionResult & { pullRequest: ExtractionPullRequest }> {
  const pr = await prisma.pullRequest.findUnique({
    where: { id: pullRequestId },
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
      repositoryId: true,
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

  if (!pr) throw new Error(`Pull request ${pullRequestId} not found`);

  const pullRequest: ExtractionPullRequest = {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    authorLogin: pr.authorLogin,
    draft: pr.draft,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commits: pr.commits,
    comments: pr.comments,
    reviewComments: pr.reviewComments,
    labels: pr.labels,
    githubCreatedAt: pr.githubCreatedAt,
    githubUpdatedAt: pr.githubUpdatedAt,
  };

  const result = await extractFeatures({
    repositoryId: pr.repositoryId,
    pullRequest,
    files: pr.files.map((f) => ({ ...f, status: f.status as string })),
  });

  return { ...result, pullRequest };
}
