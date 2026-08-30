/**
 * Feature registry — the contract between the product and the risk model.
 *
 * ## What this is
 *
 * A declarative list of every signal BugDNA extracts from a pull request. Each
 * entry carries the metadata needed by three different consumers:
 *
 *  - the **extractor** (extract.ts), which computes the value;
 *  - the **model service**, which needs a stable, ordered feature vector;
 *  - the **UI**, which needs a human label, a unit and an explanation of why
 *    the signal matters — that is what turns a SHAP number into something a
 *    developer can act on.
 *
 * ## Ground rules
 *
 * 1. **Every feature is derived from data GitHub actually returns**, or from
 *    outcomes a user explicitly reported to BugDNA (deployment status and
 *    incident flags). Nothing here assumes a data source the product does not
 *    have. There are no invented metrics such as "code complexity score" or
 *    "developer seniority".
 *
 * 2. **Model output is never fed back in as a feature.** Using a previous risk
 *    score as an input would create a self-reinforcing loop where the model
 *    confirms its own history. Repository history is expressed through
 *    observable facts (PR sizes, merge rates, deployment failures) instead.
 *
 * 3. **Adding a feature is a three-line change**: add a spec here, add an
 *    extractor in extract.ts, bump FEATURE_SET_VERSION. A startup assertion
 *    fails loudly if a spec has no extractor or vice versa, so the two cannot
 *    drift.
 *
 * 4. **This list is the default, not a claim about what is predictive.** Which
 *    of these features actually carry signal is an empirical question that
 *    depends on the training data an operator supplies. See docs/ML_MODEL.md —
 *    BugDNA deliberately does not assert a validated feature importance
 *    ranking, an accuracy figure or a target definition it has not measured.
 */

/** Mirrors the Prisma `FactorCategory` enum. */
export type FeatureCategory =
  | "CHANGE_SHAPE"
  | "CHANGE_TYPE"
  | "BLAST_RADIUS"
  | "DEPENDENCY"
  | "DATA_LAYER"
  | "API_CONTRACT"
  | "REPOSITORY_HISTORY"
  | "AUTHOR_CONTEXT"
  | "PROCESS";

export type FeatureType = "count" | "ratio" | "boolean" | "hours" | "lines";

/**
 * Direction the product *expects* a feature to push risk, used only for UI copy
 * and for the heuristic fallback's weights. The trained model determines the
 * actual sign; where the two disagree, the model wins and the UI reports what
 * the model said.
 */
export type ExpectedDirection = "increases" | "decreases" | "context";

export interface FeatureSpec {
  key: string;
  label: string;
  /** Why this matters, in language a developer would accept. Shown in the UI. */
  description: string;
  category: FeatureCategory;
  type: FeatureType;
  /**
   * Value used when the signal genuinely cannot be computed (e.g. repository
   * history for a repo connected five minutes ago). Chosen to be neutral rather
   * than alarming, and recorded as a degradation on the analysis.
   */
  fallback: number;
  expectedDirection: ExpectedDirection;
  unit?: string;
  /**
   * Weight used by the transparent heuristic scorer when no trained model is
   * available. Not a claim about true importance — see docs/ML_MODEL.md.
   */
  heuristicWeight: number;
  /** Requires data beyond the PR itself (our DB), so may be unavailable. */
  requiresHistory?: boolean;
}

export const FEATURE_SPECS: readonly FeatureSpec[] = [
  // -------------------------------------------------------------------------
  // Change shape — how big and how concentrated the change is
  // -------------------------------------------------------------------------
  {
    key: "lines_added",
    label: "Lines added",
    description:
      "Total added lines across the diff. Large additions introduce more new behaviour that has never run in production.",
    category: "CHANGE_SHAPE",
    type: "lines",
    fallback: 0,
    expectedDirection: "increases",
    unit: "lines",
    heuristicWeight: 0.9,
  },
  {
    key: "lines_deleted",
    label: "Lines deleted",
    description:
      "Total removed lines. Deletions can remove guardrails as easily as dead code, so they are counted separately from additions.",
    category: "CHANGE_SHAPE",
    type: "lines",
    fallback: 0,
    expectedDirection: "increases",
    unit: "lines",
    heuristicWeight: 0.7,
  },
  {
    key: "total_churn",
    label: "Total churn",
    description:
      "Added plus deleted lines — the overall size of the change, and the single strongest predictor of review difficulty.",
    category: "CHANGE_SHAPE",
    type: "lines",
    fallback: 0,
    expectedDirection: "increases",
    unit: "lines",
    heuristicWeight: 1.6,
  },
  {
    key: "files_changed",
    label: "Files changed",
    description:
      "How many files the pull request touches. Wide changes are harder to review carefully and harder to revert cleanly.",
    category: "CHANGE_SHAPE",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 1.4,
  },
  {
    key: "commits_count",
    label: "Commits",
    description:
      "Number of commits. Very high counts often indicate an unsquashed exploratory branch rather than a reviewed change.",
    category: "CHANGE_SHAPE",
    type: "count",
    fallback: 1,
    expectedDirection: "context",
    unit: "commits",
    heuristicWeight: 0.2,
  },
  {
    key: "avg_changes_per_file",
    label: "Average change per file",
    description:
      "Mean changed lines per file. Distinguishes a broad mechanical rename from a deep rewrite of a few files.",
    category: "CHANGE_SHAPE",
    type: "ratio",
    fallback: 0,
    expectedDirection: "context",
    unit: "lines/file",
    heuristicWeight: 0.3,
  },
  {
    key: "max_file_churn",
    label: "Largest single-file change",
    description:
      "Churn in the most-modified file. A single very large file change concentrates risk in one place.",
    category: "CHANGE_SHAPE",
    type: "lines",
    fallback: 0,
    expectedDirection: "increases",
    unit: "lines",
    heuristicWeight: 0.6,
  },
  {
    key: "deletion_ratio",
    label: "Deletion ratio",
    description:
      "Share of churn that is deletions. A deletion-heavy change is more likely to remove behaviour something else depends on.",
    category: "CHANGE_SHAPE",
    type: "ratio",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 0.5,
  },
  {
    key: "files_removed",
    label: "Files deleted",
    description:
      "Files removed entirely. Deletions break importers and callers that the diff does not show.",
    category: "CHANGE_SHAPE",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 0.7,
  },
  {
    key: "files_renamed",
    label: "Files renamed or moved",
    description:
      "Renames and moves. They are usually safe but silently break dynamic imports, build config and documentation links.",
    category: "CHANGE_SHAPE",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 0.4,
  },

  // -------------------------------------------------------------------------
  // Change type — what kind of code is being touched
  // -------------------------------------------------------------------------
  {
    key: "source_files_changed",
    label: "Source files changed",
    description:
      "Files classified as application source, excluding tests, docs and generated output.",
    category: "CHANGE_TYPE",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 0.8,
  },
  {
    key: "test_files_changed",
    label: "Test files changed",
    description:
      "Test files touched. Changing behaviour and its tests together is a strong signal the author considered the failure modes.",
    category: "CHANGE_TYPE",
    type: "count",
    fallback: 0,
    expectedDirection: "decreases",
    unit: "files",
    heuristicWeight: -0.9,
  },
  {
    key: "touches_tests",
    label: "Includes test changes",
    description:
      "Whether any test file is part of this change. A behavioural change with no test movement is the most common avoidable risk.",
    category: "CHANGE_TYPE",
    type: "boolean",
    fallback: 0,
    expectedDirection: "decreases",
    heuristicWeight: -1.8,
  },
  {
    key: "test_to_source_ratio",
    label: "Test-to-source churn ratio",
    description:
      "Test churn divided by source churn. Low values on a large change suggest the new behaviour is largely unverified.",
    category: "CHANGE_TYPE",
    type: "ratio",
    fallback: 0,
    expectedDirection: "decreases",
    heuristicWeight: -1.1,
  },
  {
    key: "config_files_changed",
    label: "Configuration files changed",
    description:
      "Configuration changes take effect immediately on deploy and are rarely covered by tests.",
    category: "CHANGE_TYPE",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 0.8,
  },
  {
    key: "infra_files_changed",
    label: "Infrastructure files changed",
    description:
      "Dockerfiles, CI workflows and deployment manifests. Failures here affect the deployment itself, not just the application.",
    category: "CHANGE_TYPE",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 0.9,
  },
  {
    key: "docs_only_change",
    label: "Documentation-only change",
    description:
      "Whether the change touches nothing but documentation. These carry effectively no deployment risk.",
    category: "CHANGE_TYPE",
    type: "boolean",
    fallback: 0,
    expectedDirection: "decreases",
    heuristicWeight: -3.5,
  },
  {
    key: "generated_files_changed",
    label: "Generated files changed",
    description:
      "Build output, lockfiles and generated code. Large diffs here inflate apparent size without adding reviewable logic.",
    category: "CHANGE_TYPE",
    type: "count",
    fallback: 0,
    expectedDirection: "context",
    unit: "files",
    heuristicWeight: 0.1,
  },
  {
    key: "adds_todo_markers",
    label: "Adds TODO or FIXME markers",
    description:
      "New TODO/FIXME/HACK markers indicate the author knowingly left work unfinished in this change.",
    category: "PROCESS",
    type: "boolean",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 0.5,
  },

  // -------------------------------------------------------------------------
  // Dependency
  // -------------------------------------------------------------------------
  {
    key: "dependency_manifest_changed",
    label: "Dependency manifest changed",
    description:
      "A package manifest or lockfile changed. Upgrades pull in third-party code that no reviewer on this PR has read.",
    category: "DEPENDENCY",
    type: "boolean",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 1.5,
  },
  {
    key: "dependency_files_changed",
    label: "Dependency files changed",
    description: "How many manifests or lockfiles changed, across how many ecosystems.",
    category: "DEPENDENCY",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 0.4,
  },
  {
    key: "lockfile_churn",
    label: "Lockfile churn",
    description:
      "Lines changed in lockfiles, a proxy for how much transitive dependency surface moved.",
    category: "DEPENDENCY",
    type: "lines",
    fallback: 0,
    expectedDirection: "increases",
    unit: "lines",
    heuristicWeight: 0.5,
  },

  // -------------------------------------------------------------------------
  // Data layer
  // -------------------------------------------------------------------------
  {
    key: "migration_files_changed",
    label: "Database migrations changed",
    description:
      "Schema migrations are among the hardest changes to roll back, because the data has already moved.",
    category: "DATA_LAYER",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 1.8,
  },
  {
    key: "has_destructive_sql",
    label: "Contains destructive schema changes",
    description:
      "The diff contains DROP, TRUNCATE, an unqualified DELETE, or a new NOT NULL without a default — operations that can lose data or fail on a populated table.",
    category: "DATA_LAYER",
    type: "boolean",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 3.0,
  },

  // -------------------------------------------------------------------------
  // API contract
  // -------------------------------------------------------------------------
  {
    key: "touches_public_api",
    label: "Changes a public API surface",
    description:
      "An exported symbol or route handler changed. Callers outside this pull request may depend on the old shape.",
    category: "API_CONTRACT",
    type: "boolean",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 1.4,
  },
  {
    key: "public_api_files_changed",
    label: "Files with public API changes",
    description: "How many files changed an exported or externally routed symbol.",
    category: "API_CONTRACT",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "files",
    heuristicWeight: 0.5,
  },

  // -------------------------------------------------------------------------
  // Blast radius
  // -------------------------------------------------------------------------
  {
    key: "modules_touched",
    label: "Modules touched",
    description:
      "Distinct modules or components the change spans. A change crossing many modules is harder to reason about and to revert.",
    category: "BLAST_RADIUS",
    type: "count",
    fallback: 0,
    expectedDirection: "increases",
    unit: "modules",
    heuristicWeight: 1.2,
  },
  {
    key: "cross_module_change",
    label: "Spans multiple modules",
    description: "Whether the change crosses module boundaries rather than staying local.",
    category: "BLAST_RADIUS",
    type: "boolean",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 0.6,
  },
  {
    key: "max_module_concentration",
    label: "Largest module share of churn",
    description:
      "Share of churn in the single most-affected module. High concentration means focused work; low means the change is diffuse.",
    category: "BLAST_RADIUS",
    type: "ratio",
    fallback: 1,
    expectedDirection: "decreases",
    heuristicWeight: -0.5,
  },
  {
    key: "languages_touched",
    label: "Languages touched",
    description:
      "Number of distinct languages in the diff. Multi-language changes need reviewers who may not overlap.",
    category: "BLAST_RADIUS",
    type: "count",
    fallback: 1,
    expectedDirection: "increases",
    unit: "languages",
    heuristicWeight: 0.3,
  },

  // -------------------------------------------------------------------------
  // Security-sensitive surface
  // -------------------------------------------------------------------------
  {
    key: "touches_auth_or_secrets",
    label: "Touches authentication or secrets",
    description:
      "Paths or diff content referencing auth, permissions, tokens or cryptography. Mistakes here fail silently and expose data.",
    category: "API_CONTRACT",
    type: "boolean",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 1.9,
  },
  {
    key: "removes_error_handling",
    label: "Removes error handling",
    description:
      "The diff deletes a try/catch, except or error branch. Removing a guard converts a handled failure into an outage.",
    category: "CHANGE_TYPE",
    type: "boolean",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 1.6,
  },

  // -------------------------------------------------------------------------
  // Process / review hygiene
  // -------------------------------------------------------------------------
  {
    key: "has_description",
    label: "Has a description",
    description:
      "Whether the author explained the change. An unexplained PR is reviewed less effectively, whatever its size.",
    category: "PROCESS",
    type: "boolean",
    fallback: 0,
    expectedDirection: "decreases",
    heuristicWeight: -0.6,
  },
  {
    key: "description_length",
    label: "Description length",
    description: "Characters of PR description, as a rough proxy for how much context reviewers were given.",
    category: "PROCESS",
    type: "count",
    fallback: 0,
    expectedDirection: "decreases",
    unit: "chars",
    heuristicWeight: -0.2,
  },
  {
    key: "review_comments_count",
    label: "Review comments",
    description:
      "Inline review comments so far. Zero on a large change means nobody has examined the code yet.",
    category: "PROCESS",
    type: "count",
    fallback: 0,
    expectedDirection: "decreases",
    unit: "comments",
    heuristicWeight: -0.5,
  },
  {
    key: "is_draft",
    label: "Draft pull request",
    description: "Draft PRs are not merge candidates yet, so their risk is informational.",
    category: "PROCESS",
    type: "boolean",
    fallback: 0,
    expectedDirection: "context",
    heuristicWeight: -0.3,
  },
  {
    key: "pr_age_hours",
    label: "Pull request age",
    description:
      "Hours since the PR was opened. Long-lived branches drift further from the base and merge less predictably.",
    category: "PROCESS",
    type: "hours",
    fallback: 0,
    expectedDirection: "increases",
    unit: "hours",
    heuristicWeight: 0.3,
  },

  // -------------------------------------------------------------------------
  // Repository history — observable facts only, never past model output
  // -------------------------------------------------------------------------
  {
    key: "repo_median_pr_churn_30d",
    label: "Repository median PR size (30d)",
    description:
      "Typical PR size in this repository recently. It is the baseline this PR's size is judged against — 400 lines is unremarkable in some repos and an outlier in others.",
    category: "REPOSITORY_HISTORY",
    type: "lines",
    fallback: 0,
    expectedDirection: "context",
    unit: "lines",
    heuristicWeight: 0,
    requiresHistory: true,
  },
  {
    key: "churn_vs_repo_median",
    label: "Size relative to repository norm",
    description:
      "This PR's churn divided by the repository's recent median. Values well above 1 mean the change is unusually large for this codebase.",
    category: "REPOSITORY_HISTORY",
    type: "ratio",
    fallback: 1,
    expectedDirection: "increases",
    heuristicWeight: 0.8,
    requiresHistory: true,
  },
  {
    key: "repo_deployment_failure_rate_90d",
    label: "Repository deployment failure rate (90d)",
    description:
      "Share of recorded deployments that failed or were rolled back. A repository that ships badly is riskier to ship to.",
    category: "REPOSITORY_HISTORY",
    type: "ratio",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 1.0,
    requiresHistory: true,
  },
  {
    key: "module_incident_history",
    label: "Incident history of touched modules",
    description:
      "Share of past reported incidents whose pull requests touched at least one of the same modules. This is the clearest historical signal BugDNA has, because it comes from outcomes a human confirmed.",
    category: "REPOSITORY_HISTORY",
    type: "ratio",
    fallback: 0,
    expectedDirection: "increases",
    heuristicWeight: 1.7,
    requiresHistory: true,
  },
  {
    key: "author_pr_count_90d",
    label: "Author pull requests here (90d)",
    description:
      "How many PRs this author has opened in this repository recently — a proxy for familiarity with the codebase.",
    category: "AUTHOR_CONTEXT",
    type: "count",
    fallback: 0,
    expectedDirection: "decreases",
    unit: "PRs",
    heuristicWeight: -0.4,
    requiresHistory: true,
  },
  {
    key: "author_module_familiarity",
    label: "Author familiarity with touched modules",
    description:
      "Share of the modules in this PR that the author has changed before. Editing unfamiliar code is a well-understood source of defects.",
    category: "AUTHOR_CONTEXT",
    type: "ratio",
    fallback: 0,
    expectedDirection: "decreases",
    heuristicWeight: -1.0,
    requiresHistory: true,
  },
] as const;

/** Stable, ordered key list. The model's feature vector uses this order. */
export const FEATURE_KEYS: readonly string[] = FEATURE_SPECS.map((f) => f.key);

const SPEC_BY_KEY = new Map(FEATURE_SPECS.map((f) => [f.key, f]));

export function getFeatureSpec(key: string): FeatureSpec | undefined {
  return SPEC_BY_KEY.get(key);
}

/** A computed feature vector: every registry key mapped to a number. */
export type FeatureVector = Record<string, number>;

/** Neutral vector, used as the base so a missing extractor cannot yield NaN. */
export function fallbackVector(): FeatureVector {
  const vector: FeatureVector = {};
  for (const spec of FEATURE_SPECS) vector[spec.key] = spec.fallback;
  return vector;
}

/**
 * Render a feature value the way a developer would read it.
 *
 * Used for the `displayValue` on each risk factor, so the explanation reads
 * "43 files" rather than "43".
 */
export function formatFeatureValue(key: string, value: number): string {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) return String(value);

  switch (spec.type) {
    case "boolean":
      return value >= 0.5 ? "Yes" : "No";
    case "ratio":
      return `${Math.round(value * 100)}%`;
    case "hours": {
      if (value < 24) return `${Math.round(value)}h`;
      return `${Math.round(value / 24)}d`;
    }
    case "lines":
      return `${Math.round(value).toLocaleString("en-US")} ${value === 1 ? "line" : "lines"}`;
    case "count": {
      const rounded = Math.round(value);
      return spec.unit ? `${rounded.toLocaleString("en-US")} ${spec.unit}` : String(rounded);
    }
    default:
      return String(value);
  }
}

/** Duplicate-key guard, run once at module load. */
(function assertRegistryIntegrity(): void {
  const seen = new Set<string>();
  for (const spec of FEATURE_SPECS) {
    if (seen.has(spec.key)) {
      throw new Error(`Duplicate feature key in registry: ${spec.key}`);
    }
    seen.add(spec.key);

    if (!/^[a-z][a-z0-9_]*$/.test(spec.key)) {
      throw new Error(
        `Feature key "${spec.key}" must be lower_snake_case so it is safe to use as a column name.`,
      );
    }
  }
})();
