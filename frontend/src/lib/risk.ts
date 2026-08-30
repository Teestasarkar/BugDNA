/**
 * Risk vocabulary.
 *
 * One place that decides how a risk level looks and reads, so a CRITICAL badge,
 * a CRITICAL chart segment and a CRITICAL gauge are visibly the same thing
 * everywhere in the product. Colour is reserved for risk throughout the design
 * system (see globals.css), which only works if it is applied consistently.
 */
import type {
  Effort,
  FactorCategory,
  MergeDecisionType,
  Priority,
  RecommendationCategory,
  RiskLevel,
} from "@/types/api";

export interface RiskPresentation {
  level: RiskLevel;
  label: string;
  /** One line a developer can act on. */
  summary: string;
  /** Tailwind utility applying the band's text/bg/border together. */
  className: string;
  /** Text colour alone, for numbers and icons. */
  textClass: string;
  /** Background fill alone, for bars and chart cells. */
  bgClass: string;
  /** The CSS variable, for Recharts and inline SVG which cannot take classes. */
  cssVar: string;
  range: [number, number];
}

export const RISK_PRESENTATION: Record<RiskLevel, RiskPresentation> = {
  LOW: {
    level: "LOW",
    label: "Low risk",
    summary: "Nothing stands out. Safe to merge on the usual review.",
    className: "risk-low",
    textClass: "text-risk-low",
    bgClass: "bg-risk-low",
    cssVar: "var(--risk-low)",
    range: [0, 34],
  },
  MODERATE: {
    level: "MODERATE",
    label: "Moderate risk",
    summary: "Worth a careful read before merging.",
    className: "risk-moderate",
    textClass: "text-risk-moderate",
    bgClass: "bg-risk-moderate",
    cssVar: "var(--risk-moderate)",
    range: [35, 59],
  },
  HIGH: {
    level: "HIGH",
    label: "High risk",
    summary: "Needs attention before it is merged.",
    className: "risk-high",
    textClass: "text-risk-high",
    bgClass: "bg-risk-high",
    cssVar: "var(--risk-high)",
    range: [60, 79],
  },
  CRITICAL: {
    level: "CRITICAL",
    label: "Critical risk",
    summary: "High chance of causing a production problem.",
    className: "risk-critical",
    textClass: "text-risk-critical",
    bgClass: "bg-risk-critical",
    cssVar: "var(--risk-critical)",
    range: [80, 100],
  },
};

export const RISK_LEVELS: RiskLevel[] = ["LOW", "MODERATE", "HIGH", "CRITICAL"];

/** Map a score onto its band. Mirrors the backend's RISK_BANDS exactly. */
export function scoreToLevel(score: number | null | undefined): RiskLevel | null {
  if (score === null || score === undefined || Number.isNaN(score)) return null;
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped >= 80) return "CRITICAL";
  if (clamped >= 60) return "HIGH";
  if (clamped >= 35) return "MODERATE";
  return "LOW";
}

export function riskPresentation(level: RiskLevel | null | undefined): RiskPresentation | null {
  return level ? RISK_PRESENTATION[level] : null;
}

/** Ordering for sorts and comparisons. */
export const RISK_ORDER: Record<RiskLevel, number> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  CRITICAL: 3,
};

export function isElevated(level: RiskLevel | null | undefined): boolean {
  return level === "HIGH" || level === "CRITICAL";
}

// ---------------------------------------------------------------------------
// Factor categories
// ---------------------------------------------------------------------------

export const FACTOR_CATEGORY_LABEL: Record<FactorCategory, string> = {
  CHANGE_SHAPE: "Change size",
  CHANGE_TYPE: "Change type",
  BLAST_RADIUS: "Blast radius",
  DEPENDENCY: "Dependencies",
  DATA_LAYER: "Data layer",
  API_CONTRACT: "API surface",
  REPOSITORY_HISTORY: "Repository history",
  AUTHOR_CONTEXT: "Author context",
  PROCESS: "Review process",
};

/** Short explanation of what a category covers, for tooltips. */
export const FACTOR_CATEGORY_HINT: Record<FactorCategory, string> = {
  CHANGE_SHAPE: "How large and concentrated the change is.",
  CHANGE_TYPE: "What kind of code is being touched — tests, config, generated files.",
  BLAST_RADIUS: "How many modules and languages the change spans.",
  DEPENDENCY: "Third-party packages and lockfiles.",
  DATA_LAYER: "Schema migrations and destructive SQL.",
  API_CONTRACT: "Exported symbols, routes and security-sensitive surfaces.",
  REPOSITORY_HISTORY: "How this repository has behaved in the past.",
  AUTHOR_CONTEXT: "The author's familiarity with the code being changed.",
  PROCESS: "Review coverage and pull request hygiene.",
};

// ---------------------------------------------------------------------------
// Recommendations
// ---------------------------------------------------------------------------

export const RECOMMENDATION_CATEGORY_LABEL: Record<RecommendationCategory, string> = {
  TESTING: "Testing",
  CODE_REVIEW: "Review",
  DEPENDENCY: "Dependencies",
  DATABASE: "Database",
  API_CONTRACT: "API contract",
  CONFIGURATION: "Configuration",
  SECURITY: "Security",
  OBSERVABILITY: "Observability",
  ROLLOUT: "Rollout",
  SCOPE: "Scope",
  DOCUMENTATION: "Documentation",
};

export const PRIORITY_PRESENTATION: Record<
  Priority,
  { label: string; className: string; order: number }
> = {
  CRITICAL: { label: "Critical", className: "risk-critical", order: 0 },
  HIGH: { label: "High", className: "risk-high", order: 1 },
  MEDIUM: { label: "Medium", className: "risk-moderate", order: 2 },
  LOW: { label: "Low", className: "bg-muted text-muted-foreground border-border", order: 3 },
};

export const EFFORT_LABEL: Record<Effort, string> = {
  LOW: "Quick",
  MEDIUM: "Moderate effort",
  HIGH: "Substantial effort",
};

// ---------------------------------------------------------------------------
// Merge decisions
// ---------------------------------------------------------------------------

export const MERGE_DECISION_PRESENTATION: Record<
  MergeDecisionType,
  { label: string; description: string; className: string }
> = {
  APPROVED_MERGE: {
    label: "Approved",
    description: "Reviewed the assessment and merged.",
    className: "risk-low",
  },
  OVERRIDDEN: {
    label: "Overridden",
    description: "Merged despite an elevated risk assessment, with a recorded reason.",
    className: "risk-high",
  },
  BLOCKED: {
    label: "Blocked",
    description: "Held back until the flagged risks are addressed.",
    className: "risk-critical",
  },
  DEFERRED: {
    label: "Deferred",
    description: "Waiting on something before deciding.",
    className: "risk-moderate",
  },
  CLOSED_WITHOUT_MERGE: {
    label: "Closed",
    description: "Closed without merging.",
    className: "bg-muted text-muted-foreground border-border",
  },
};

// ---------------------------------------------------------------------------
// Analysis status
// ---------------------------------------------------------------------------

export const STAGE_LABEL: Record<string, string> = {
  NORMALIZING: "Reading pull request",
  FETCHING_DIFF: "Retrieving diff from GitHub",
  EXTRACTING_FEATURES: "Extracting risk signals",
  PREDICTING: "Scoring with the risk model",
  EXPLAINING: "Attributing the score",
  RECOMMENDING: "Producing recommendations",
  PERSISTING: "Saving results",
  DONE: "Complete",
};

/** Ordered stages, for rendering the pipeline as a stepper. */
export const PIPELINE_STAGES = [
  "NORMALIZING",
  "FETCHING_DIFF",
  "EXTRACTING_FEATURES",
  "PREDICTING",
  "EXPLAINING",
  "RECOMMENDING",
  "PERSISTING",
  "DONE",
] as const;

/**
 * Colour for a chart series representing a risk level.
 *
 * Recharts takes fill/stroke strings rather than classes, so it needs the CSS
 * variable directly.
 */
export function riskChartColor(level: RiskLevel): string {
  return RISK_PRESENTATION[level].cssVar;
}

/** Non-risk chart colours, for trend lines and categorical series. */
export const CHART_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
] as const;

/**
 * Describe what a score means relative to the deployment's threshold.
 *
 * Used above the merge-decision panel so the number is anchored to something
 * concrete rather than floating on its own.
 */
export function describeScore(
  score: number | null | undefined,
  highRiskThreshold = 70,
): string {
  if (score === null || score === undefined) return "Not yet scored.";
  const rounded = Math.round(score);
  if (rounded >= highRiskThreshold) {
    return `${rounded}/100 — at or above this deployment's high-risk threshold of ${highRiskThreshold}.`;
  }
  return `${rounded}/100 — below this deployment's high-risk threshold of ${highRiskThreshold}.`;
}
