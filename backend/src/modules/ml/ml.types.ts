/**
 * Wire contract with the Python risk service.
 *
 * This file and `ml-service/app/schemas.py` are two views of the same contract.
 * It is intentionally narrow — features in, score and contributions out — so the
 * model can be retrained, re-tuned or replaced entirely without any change to
 * the product backend. Nothing about XGBoost or SHAP leaks across this boundary
 * beyond a label saying which produced the answer.
 */

/** Snake_case on the wire: it is a Python service, and this avoids a mapping layer. */
export interface MlPredictRequest {
  feature_set_version: string;
  features: Record<string, number>;
  /** Context is logged by the ML service for traceability; never used as a feature. */
  context?: {
    analysis_id: string;
    repository: string;
    pull_request_number: number;
  };
  /** Cap on how many contributions to return. */
  max_contributions?: number;
}

export interface MlModelInfo {
  name: string;
  version: string;
  /** `xgboost` when a trained artifact is serving; `heuristic` for the fallback. */
  engine: "xgboost" | "heuristic";
  feature_set_version: string;
  trained_at: string | null;
  /**
   * Present only if the operator supplied evaluation metrics at training time.
   * BugDNA never fabricates these — an untrained/bootstrap model reports null.
   */
  metrics: Record<string, number> | null;
  feature_count: number;
}

export interface MlPrediction {
  /** Raw model probability in [0, 1]. */
  probability: number;
  /** 0-100 presentation score. */
  risk_score: number;
  risk_level: "LOW" | "MODERATE" | "HIGH" | "CRITICAL";
  /**
   * Confidence in [0, 1]. For the bootstrap model this reflects distance from
   * the decision boundary, not a calibrated uncertainty estimate.
   */
  confidence: number;
}

export interface MlContribution {
  key: string;
  /** SHAP value in the model's log-odds space. Sign carries direction. */
  shap_value: number;
  /** The feature value that produced it, echoed back for display. */
  feature_value: number;
  /** Normalised 0-100 share of total absolute contribution. */
  contribution: number;
}

export interface MlExplanation {
  /** SHAP base value (expected model output over the training set). */
  base_value: number;
  contributions: MlContribution[];
  /** `shap_tree` for a real TreeExplainer; `heuristic_weights` for the fallback. */
  method: "shap_tree" | "heuristic_weights";
  /** Non-fatal notes, e.g. that the fallback scorer was used. */
  notes: string[];
}

export interface MlPredictResponse {
  model: MlModelInfo;
  prediction: MlPrediction;
  explanation: MlExplanation;
  /** Features the service did not recognise, or expected and did not receive. */
  warnings: string[];
  latency_ms: number;
}

export interface MlHealthResponse {
  status: "ok" | "degraded";
  model_loaded: boolean;
  engine: "xgboost" | "heuristic";
  model_version: string | null;
  feature_set_version: string;
  /** Present when the service is running on the heuristic fallback. */
  detail?: string;
}
