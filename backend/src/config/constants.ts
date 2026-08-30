/**
 * Cross-cutting constants.
 *
 * Anything a reviewer might reasonably want to tune lives here rather than
 * being scattered as magic numbers through the pipeline.
 */

/**
 * Version of the feature-extraction contract. Bump whenever the meaning or set
 * of emitted features changes, so historical analyses stay interpretable and a
 * retrained model can be matched to the extractor that fed it.
 *
 * The feature *set itself* is declared in modules/analysis/features/registry.ts.
 */
export const FEATURE_SET_VERSION = "1.0.0";

/**
 * Risk-score bands (0-100 inclusive lower bound).
 *
 * These are a **product decision**, not a model output: the model returns a
 * probability, and this table is how the product chooses to talk about it.
 * They are documented in docs/ML_MODEL.md and deliberately kept in one place so
 * changing the vocabulary cannot drift between API and UI.
 */
export const RISK_BANDS = [
  { level: "LOW", min: 0, max: 34 },
  { level: "MODERATE", min: 35, max: 59 },
  { level: "HIGH", min: 60, max: 79 },
  { level: "CRITICAL", min: 80, max: 100 },
] as const;

export type RiskLevelName = (typeof RISK_BANDS)[number]["level"];

/** Map a 0-100 score onto its band. */
export function scoreToRiskLevel(score: number): RiskLevelName {
  const clamped = Math.max(0, Math.min(100, score));
  for (const band of RISK_BANDS) {
    if (clamped >= band.min && clamped <= band.max) return band.level;
  }
  return "CRITICAL";
}

/** Ordering helper for sorting/comparison. */
export const RISK_LEVEL_ORDER: Record<RiskLevelName, number> = {
  LOW: 0,
  MODERATE: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * Coarse progress percentages attached to each pipeline stage, so the UI can
 * render a determinate progress bar for an inherently variable-length job.
 */
export const STAGE_PROGRESS: Record<string, number> = {
  NORMALIZING: 10,
  FETCHING_DIFF: 30,
  EXTRACTING_FEATURES: 50,
  PREDICTING: 70,
  EXPLAINING: 82,
  RECOMMENDING: 92,
  PERSISTING: 97,
  DONE: 100,
};

/** Redis key namespaces. Centralised so we never collide or orphan keys. */
export const CACHE_KEYS = {
  githubUserRepos: (userId: string, page: number, perPage: number, q: string) =>
    `cache:gh:repos:${userId}:${page}:${perPage}:${q || "-"}`,
  githubPulls: (repoId: string, state: string, page: number) =>
    `cache:gh:pulls:${repoId}:${state}:${page}`,
  githubPullDetail: (repoId: string, number: number) =>
    `cache:gh:pull:${repoId}:${number}`,
  githubPullFiles: (repoId: string, number: number, sha: string) =>
    `cache:gh:files:${repoId}:${number}:${sha}`,
  repoAnalytics: (repoId: string, days: number) =>
    `cache:analytics:repo:${repoId}:${days}`,
  teamAnalytics: (teamId: string, days: number) =>
    `cache:analytics:team:${teamId}:${days}`,
  dashboardOverview: (userId: string) => `cache:dashboard:${userId}`,
  /** Transient live state for an in-flight analysis (see analysis.state.ts). */
  analysisState: (analysisId: string) => `state:analysis:${analysisId}`,
  /** Guards against queueing duplicate analyses for the same PR head SHA. */
  analysisLock: (pullRequestId: string, sha: string) =>
    `lock:analysis:${pullRequestId}:${sha}`,
  /** Conditional-request ETags for GitHub responses. */
  githubEtag: (url: string) => `etag:gh:${url}`,
  oauthState: (state: string) => `oauth:state:${state}`,
} as const;

/** How long a queued/running analysis keeps its transient Redis state. */
export const ANALYSIS_STATE_TTL_SECONDS = 60 * 60; // 1 hour

/** OAuth `state` parameter lifetime. */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Pagination guardrails applied by the validation layer. */
export const PAGINATION = {
  defaultPage: 1,
  defaultPerPage: 20,
  maxPerPage: 100,
} as const;

/**
 * Path-classification patterns used by the feature extractor. Kept as data so
 * new ecosystems can be supported without touching extraction logic.
 */
export const PATH_PATTERNS = {
  test: [
    /(^|\/)tests?\//i,
    /(^|\/)__tests__\//,
    /(^|\/)spec\//i,
    /\.(test|spec)\.[jt]sx?$/,
    /_test\.(go|py|rb)$/,
    /Test[s]?\.(java|kt|cs)$/,
    /(^|\/)test_[^/]+\.py$/,
    /\.feature$/,
  ],
  dependencyManifest: [
    /(^|\/)package\.json$/,
    /(^|\/)package-lock\.json$/,
    /(^|\/)pnpm-lock\.yaml$/,
    /(^|\/)yarn\.lock$/,
    /(^|\/)requirements[^/]*\.txt$/,
    /(^|\/)Pipfile(\.lock)?$/,
    /(^|\/)poetry\.lock$/,
    /(^|\/)pyproject\.toml$/,
    /(^|\/)go\.(mod|sum)$/,
    /(^|\/)Cargo\.(toml|lock)$/,
    /(^|\/)Gemfile(\.lock)?$/,
    /(^|\/)pom\.xml$/,
    /(^|\/)build\.gradle(\.kts)?$/,
    /(^|\/)composer\.(json|lock)$/,
  ],
  migration: [
    /(^|\/)migrations?\//i,
    /(^|\/)prisma\/migrations\//,
    /(^|\/)alembic\//,
    /(^|\/)db\/migrate\//,
    /\.sql$/,
    /(^|\/)schema\.prisma$/,
  ],
  config: [
    /(^|\/)\.env/,
    /\.(ya?ml|toml|ini|conf|cfg|properties)$/,
    /(^|\/)(tsconfig|jsconfig)[^/]*\.json$/,
    /(^|\/)(webpack|vite|rollup|babel|jest|vitest|eslint|prettier)[^/]*\.(js|ts|mjs|cjs|json)$/,
    /(^|\/)next\.config\.[jt]s$/,
    /(^|\/)nginx[^/]*\.conf$/,
  ],
  infra: [
    /(^|\/)Dockerfile/,
    /(^|\/)docker-compose[^/]*\.ya?ml$/,
    /(^|\/)\.github\/workflows\//,
    /(^|\/)(terraform|infra|deploy|k8s|kubernetes|helm|charts)\//i,
    /\.tf$/,
  ],
  docs: [/\.(md|mdx|rst|txt|adoc)$/i, /(^|\/)docs?\//i, /(^|\/)LICENSE$/],
  generated: [
    /(^|\/)dist\//,
    /(^|\/)build\//,
    /\.min\.(js|css)$/,
    /\.(lock|snap)$/,
    /(^|\/)generated\//i,
    /\.pb\.(go|ts|js)$/,
    /(^|\/)node_modules\//,
  ],
} as const;

/**
 * Diff-content signals. These look at the patch text rather than the path, so
 * they can spot a schema change inside an otherwise ordinary file.
 */
export const PATCH_PATTERNS = {
  publicApi: [
    /^\+\s*export\s+(default\s+)?(async\s+)?(function|class|const|interface|type|enum)\b/m,
    /^-\s*export\s+/m,
    /^\+\s*public\s+(static\s+)?[\w<>[\]]+\s+\w+\s*\(/m,
    /^[+-]\s*@(Get|Post|Put|Patch|Delete|RequestMapping|app\.(get|post|put|patch|delete))/m,
    /^[-+]\s*(router|app)\.(get|post|put|patch|delete)\s*\(/m,
  ],
  destructiveSql: [
    /\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|SCHEMA)\b/i,
    /\bTRUNCATE\b/i,
    /\bALTER\s+TABLE\b[\s\S]*\bDROP\b/i,
    /\bDELETE\s+FROM\b(?![\s\S]{0,80}WHERE)/i,
    /\bNOT\s+NULL\b(?![\s\S]{0,60}DEFAULT)/i,
  ],
  authSensitive: [
    /\b(password|secret|token|credential|api[_-]?key|private[_-]?key)\b/i,
    /\b(authenticate|authorize|permission|role|jwt|oauth|session)\b/i,
    /\b(crypto|encrypt|decrypt|hash|bcrypt|argon2)\b/i,
  ],
  errorHandlingRemoved: [
    /^-\s*(try\s*\{|catch\s*\(|except\b|rescue\b)/m,
    /^-\s*if\s*\(\s*(err|error)\s*(!==?\s*null)?\s*\)/m,
  ],
  todoMarkers: [/^\+.*\b(TODO|FIXME|HACK|XXX|WIP)\b/im],
} as const;

/** Extensions we treat as source code for churn ratios. */
export const SOURCE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java", "kt", "kts", "scala",
  "rb", "php", "cs", "swift", "m", "mm",
  "c", "h", "cc", "cpp", "hpp", "cxx",
  "vue", "svelte", "sql", "sh", "bash", "ps1",
]);

/** Extension -> display language. */
export const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", js: "JavaScript", jsx: "JavaScript",
  mjs: "JavaScript", cjs: "JavaScript", py: "Python", go: "Go", rs: "Rust",
  java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala", rb: "Ruby",
  php: "PHP", cs: "C#", swift: "Swift", c: "C", h: "C", cc: "C++",
  cpp: "C++", hpp: "C++", cxx: "C++", vue: "Vue", svelte: "Svelte",
  sql: "SQL", sh: "Shell", bash: "Shell", ps1: "PowerShell",
  yml: "YAML", yaml: "YAML", json: "JSON", toml: "TOML", md: "Markdown",
  css: "CSS", scss: "SCSS", html: "HTML", prisma: "Prisma", tf: "Terraform",
};
