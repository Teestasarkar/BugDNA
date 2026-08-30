/**
 * Explanation layer.
 *
 * The model returns SHAP values: signed numbers in log-odds space. On their own
 * they are useless to a developer deciding whether to merge. This module's whole
 * job is the translation:
 *
 *     { key: "has_destructive_sql", shap_value: 0.81 }
 *
 *          becomes
 *
 *     "Contains destructive schema changes — increases risk, 24% of the
 *      assessment. The diff drops two columns and a table. Rolling this back
 *      will not restore the data."
 *      Evidence: prisma/migrations/20260812093000_ledger_consolidation/migration.sql
 *
 * Three decisions worth defending:
 *
 *  1. **Protective factors are shown, not hidden.** A view that lists only what
 *     is wrong makes a score feel arbitrary. Showing that tests were included
 *     and the author knows the module is what makes a LOW score credible.
 *
 *  2. **The model's sign wins.** Where the model disagrees with the product's
 *     expectation for a feature, the UI reports what the model actually did.
 *     Silently correcting it would make the explanation a fiction.
 *
 *  3. **Evidence is attached.** Every factor that can be traced to files carries
 *     them, so a developer can go from "why" straight to the diff.
 */
import {
  formatFeatureValue,
  getFeatureSpec,
  type FeatureVector,
} from "../features/registry";
import type { FeatureEvidence } from "../features/extract";
import type { MlContribution, MlExplanation } from "../../ml/ml.types";

/** How many factors to persist. Enough to be complete, few enough to read. */
const MAX_FACTORS = 12;

/**
 * Contributions below this share of total movement are noise. Dropping them
 * keeps the explanation honest — a factor worth 0.3% is not a reason.
 */
const MIN_CONTRIBUTION_PERCENT = 1.5;

export interface RiskFactorDraft {
  key: string;
  label: string;
  value: number | null;
  displayValue: string | null;
  shapValue: number;
  contribution: number;
  direction: "INCREASES_RISK" | "DECREASES_RISK" | "NEUTRAL";
  category:
    | "CHANGE_SHAPE"
    | "CHANGE_TYPE"
    | "BLAST_RADIUS"
    | "DEPENDENCY"
    | "DATA_LAYER"
    | "API_CONTRACT"
    | "REPOSITORY_HISTORY"
    | "AUTHOR_CONTEXT"
    | "PROCESS";
  description: string | null;
  evidence: FeatureEvidence | null;
  rank: number;
}

export interface ExplanationResult {
  factors: RiskFactorDraft[];
  /** One-paragraph narrative for the top of the analysis view. */
  summary: string;
  /** Method the model used, passed through for display. */
  method: MlExplanation["method"];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Factor construction
// ---------------------------------------------------------------------------

export function buildExplanation(args: {
  contributions: MlContribution[];
  features: FeatureVector;
  evidence: Record<string, FeatureEvidence>;
  explanation: MlExplanation;
  riskScore: number;
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  pullRequest: { number: number; authorLogin: string; title: string };
  scoredBy: "MODEL" | "HEURISTIC";
  degradedReasons: string[];
}): ExplanationResult {
  const { contributions, features, evidence, explanation } = args;

  // Normalise contributions to shares of total absolute movement, so bar widths
  // in the UI are comparable across analyses regardless of model scale.
  const totalAbs = contributions.reduce(
    (sum, c) => sum + Math.abs(Number.isFinite(c.shap_value) ? c.shap_value : 0),
    0,
  );

  const ranked = [...contributions]
    .map((c) => {
      const share = totalAbs === 0 ? 0 : (Math.abs(c.shap_value) / totalAbs) * 100;
      return { c, share };
    })
    .filter(({ share }) => share >= MIN_CONTRIBUTION_PERCENT)
    .sort((a, b) => Math.abs(b.c.shap_value) - Math.abs(a.c.shap_value))
    .slice(0, MAX_FACTORS);

  const factors: RiskFactorDraft[] = ranked.map(({ c, share }, index) => {
    const spec = getFeatureSpec(c.key);
    const value = Number.isFinite(c.feature_value)
      ? c.feature_value
      : (features[c.key] ?? null);

    return {
      key: c.key,
      label: spec?.label ?? humaniseKey(c.key),
      value: value ?? null,
      displayValue:
        value !== null && value !== undefined ? formatFeatureValue(c.key, value) : null,
      shapValue: c.shap_value,
      contribution: Math.round(share * 10) / 10,
      direction:
        Math.abs(c.shap_value) < 1e-9
          ? "NEUTRAL"
          : c.shap_value > 0
            ? "INCREASES_RISK"
            : "DECREASES_RISK",
      category: spec?.category ?? "CHANGE_SHAPE",
      description: spec?.description ?? null,
      evidence: evidence[c.key] ?? null,
      rank: index + 1,
    };
  });

  return {
    factors,
    summary: buildSummary({ ...args, factors }),
    method: explanation.method,
    notes: explanation.notes,
  };
}

function humaniseKey(key: string): string {
  return key
    .split("_")
    .map((part, i) => (i === 0 ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Narrative summary
// ---------------------------------------------------------------------------

const LEVEL_OPENING: Record<string, string> = {
  LOW: "This change looks safe to merge.",
  MODERATE: "This change is worth a careful review before merging.",
  HIGH: "This change needs attention before it is merged.",
  CRITICAL: "This change carries a high chance of causing a production problem.",
};

/**
 * Compose the paragraph shown above the factor list.
 *
 * Built from the factors that actually fired, so it can never contradict the
 * detail below it. Written as prose rather than a bullet list because the point
 * is to give a reviewer the gist in one read.
 */
function buildSummary(args: {
  factors: RiskFactorDraft[];
  riskScore: number;
  riskLevel: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  features: FeatureVector;
  pullRequest: { number: number; authorLogin: string; title: string };
  scoredBy: "MODEL" | "HEURISTIC";
  degradedReasons: string[];
}): string {
  const { factors, riskScore, riskLevel, features, scoredBy, degradedReasons } = args;

  const drivers = factors.filter((f) => f.direction === "INCREASES_RISK").slice(0, 3);
  const protective = factors.filter((f) => f.direction === "DECREASES_RISK").slice(0, 2);

  const parts: string[] = [];

  parts.push(
    `${LEVEL_OPENING[riskLevel] ?? ""} BugDNA scores it ${Math.round(riskScore)} out of 100 (${riskLevel.toLowerCase()} risk).`,
  );

  // --- size framing, always useful context ---------------------------------
  const churn = Math.round(features.total_churn ?? 0);
  const filesChanged = Math.round(features.files_changed ?? 0);
  const modules = Math.round(features.modules_touched ?? 0);

  parts.push(
    `It changes ${churn.toLocaleString("en-US")} ${churn === 1 ? "line" : "lines"} across ` +
      `${filesChanged} ${filesChanged === 1 ? "file" : "files"}` +
      (modules > 1 ? ` in ${modules} modules.` : modules === 1 ? ` in one module.` : `.`),
  );

  // --- what pushed the score up --------------------------------------------
  if (drivers.length > 0) {
    const phrases = drivers.map((f) => describeFactor(f));
    parts.push(
      `The strongest ${drivers.length === 1 ? "contributor" : "contributors"} to the score ` +
        `${drivers.length === 1 ? "is" : "are"} ${joinWithAnd(phrases)}.`,
    );
  } else {
    parts.push("No individual signal stands out as materially increasing risk.");
  }

  // --- what pulled it down -------------------------------------------------
  if (protective.length > 0) {
    parts.push(
      `Working in its favour: ${joinWithAnd(protective.map((f) => describeFactor(f)))}.`,
    );
  }

  // --- honesty about how it was scored ------------------------------------
  if (scoredBy === "HEURISTIC") {
    parts.push(
      "This score came from BugDNA's transparent rule-based scorer, not a trained model — " +
        "no model artifact is currently loaded, so treat it as a structured heuristic.",
    );
  }

  if (degradedReasons.length > 0) {
    parts.push(
      `One caveat: ${degradedReasons[0]?.replace(/\.$/, "")}.`,
    );
  }

  return parts.join(" ");
}

/**
 * Render a single factor as a clause usable mid-sentence.
 *
 * Boolean features read as statements ("no test changes"), numeric ones carry
 * their value ("43 files changed"), so the sentence stays natural either way.
 */
function describeFactor(factor: RiskFactorDraft): string {
  const spec = getFeatureSpec(factor.key);
  const isBoolean = spec?.type === "boolean";
  const isOn = (factor.value ?? 0) >= 0.5;

  // Hand-written phrasing for the factors that most need to read well.
  const phrasing: Record<string, { on: string; off: string }> = {
    touches_tests: { on: "test changes are included", off: "no test changes are included" },
    has_destructive_sql: {
      on: "the diff contains destructive schema changes",
      off: "the schema changes are non-destructive",
    },
    dependency_manifest_changed: {
      on: "a dependency manifest changed",
      off: "no dependencies changed",
    },
    touches_public_api: {
      on: "a public API surface changed",
      off: "no public API surface changed",
    },
    touches_auth_or_secrets: {
      on: "authentication or secret-handling code is involved",
      off: "no authentication code is involved",
    },
    removes_error_handling: {
      on: "error handling was removed",
      off: "error handling is intact",
    },
    docs_only_change: {
      on: "the change is documentation only",
      off: "the change includes code",
    },
    cross_module_change: {
      on: "the change spans multiple modules",
      off: "the change stays within one module",
    },
    has_description: { on: "the pull request is described", off: "the pull request has no description" },
    is_draft: { on: "it is still a draft", off: "it is marked ready for review" },
    adds_todo_markers: { on: "new TODO markers were added", off: "no TODO markers were added" },
  };

  const custom = phrasing[factor.key];
  if (custom) return isOn ? custom.on : custom.off;

  if (isBoolean) {
    return isOn
      ? (spec?.label ?? factor.label).toLowerCase()
      : `no ${(spec?.label ?? factor.label).toLowerCase()}`;
  }

  const display = factor.displayValue ?? String(Math.round(factor.value ?? 0));

  const numericPhrasing: Record<string, string> = {
    files_changed: `${display} changed`,
    total_churn: `${display} of churn`,
    lines_added: `${display} added`,
    lines_deleted: `${display} removed`,
    modules_touched: `${display} affected`,
    migration_files_changed: `${display} of database migrations`,
    test_files_changed: `${display} of tests changed`,
    review_comments_count: `${display} of review discussion`,
    churn_vs_repo_median: `a change ${formatMultiple(factor.value ?? 1)} the size of a typical pull request here`,
    module_incident_history: `${display} of past incidents in this repository involved these modules`,
    author_module_familiarity: `the author has worked in ${display} of these modules before`,
    author_pr_count_90d: `${display} from this author here recently`,
    lockfile_churn: `${display} of lockfile churn`,
    repo_deployment_failure_rate_90d: `a ${display} deployment failure rate in this repository`,
    max_module_concentration: `${display} of the churn concentrated in one module`,
    pr_age_hours: `an age of ${display}`,
  };

  return numericPhrasing[factor.key] ?? `${(spec?.label ?? factor.label).toLowerCase()} of ${display}`;
}

function formatMultiple(ratio: number): string {
  if (ratio >= 10) return `over ten times`;
  if (ratio >= 2) return `${Math.round(ratio)}x`;
  if (ratio >= 1.2) return `somewhat larger than`;
  return `around`;
}

function joinWithAnd(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] as string;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
