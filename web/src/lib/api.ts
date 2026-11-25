export type Band = "HIGH" | "MEDIUM" | "LOW";
export type Outcome = "tp" | "fp" | "fn" | "tn";

export interface FeatureSpec {
  name: string;
  group: string;
  label: string;
  description: string;
}

export interface BinaryMetrics {
  n: number;
  positives: number;
  base_rate: number;
  roc_auc: number;
  pr_auc: number;
  precision: number;
  recall: number;
  f1: number;
  flagged_share: number;
  precision_at_top10pct: number;
  recall_at_top20pct: number;
}

export interface Metrics {
  dataset: {
    prs: number;
    repos: number;
    defect_rate: number;
    features: number;
    split_sizes: Record<"train" | "val" | "test", number>;
    split_dates: Record<string, [string, string]>;
  };
  model: {
    algorithm: string;
    max_depth: number;
    min_child_weight: number;
    lambda: number;
    eta: number;
    trees: number;
    validation_roc_auc: number;
  };
  threshold: number;
  test: BinaryMetrics;
  validation: BinaryMetrics;
  baselines: {
    size_only_roc_auc: number;
    size_only_pr_auc: number;
    logistic_regression_roc_auc: number;
    logistic_regression_pr_auc: number;
  };
  cross_project: { folds: number; roc_auc_mean: number; roc_auc_std: number; fold_roc_aucs: number[] };
  importance: { feature: string; mean_abs_shap: number }[];
  per_repo: { repo: string; test_prs: number; test_positives: number; roc_auc: number | null; recall: number }[];
  curves: {
    roc: [number, number][];
    pr: [number, number][];
    roc_size_only: [number, number][];
    operating_point: { fpr: number; recall: number; precision: number };
  };
  feature_specs: FeatureSpec[];
  shap_max_abs_diff_vs_shap_package: number | null;
}

export interface RepoRow {
  repo: string;
  prs: number;
  defect_rate: number;
  first_merged: string;
  last_merged: string;
  fix_commits: number | null;
  test: { test_prs: number; test_positives: number; roc_auc: number | null; recall: number } | null;
}

export interface PrSummary {
  repo: string;
  number: number;
  title: string;
  merged_at: string;
  split: "train" | "val" | "test";
  label: 0 | 1;
  prob: number;
  percentile: number;
  band: Band;
  flagged: boolean;
  outcome: Outcome;
  fixed_by: string;
}

export interface Factor {
  feature: string;
  label: string;
  value: number | null;
  median: number | null;
  shap: number;
  finding: string;
  remediation: string;
}

export interface Score {
  probability: number;
  percentile: number;
  band: Band;
  flagged: boolean;
  base_value: number;
  contributions: Record<string, number>;
  factors: Factor[];
}

export interface PrDetail {
  pr: PrSummary & { url: string };
  features: Record<string, number | null>;
  context: { top_files: string[]; subsystems: string[] };
  score: Score;
}

export interface AnalyzeResult {
  pr: {
    repo: string;
    number: number;
    title: string;
    author: string | null;
    state: string;
    url: string;
    created_at: string;
    merged_at: string | null;
    base: string;
    scored_as_of: string;
  };
  features: Record<string, number | null>;
  context: { top_files: string[]; subsystems: string[]; history_files: string[] };
  github: { requests: number; rate_remaining: number | null; authenticated: boolean };
  warnings: string[];
  score: Score;
  cached: boolean;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") message = body.detail;
    } catch {
      /* not JSON */
    }
    throw new ApiError(message, res.status);
  }
  return res.json() as Promise<T>;
}

export const api = {
  metrics: () => request<Metrics>("/api/metrics"),
  repos: () => request<RepoRow[]>("/api/repos"),
  prs: (params: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") q.set(k, String(v));
    return request<{ total: number; items: PrSummary[] }>(`/api/prs?${q}`);
  },
  pr: (repo: string, number: number) => request<PrDetail>(`/api/prs/${repo}/${number}`),
  analyze: (url: string) => request<AnalyzeResult>("/api/analyze", { method: "POST", body: JSON.stringify({ url }) }),
};
