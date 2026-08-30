/**
 * Client for the Python risk service.
 *
 * Deliberately thin. The backend's job is to send a feature vector and receive a
 * score plus contributions; it holds no model logic of its own. That separation
 * is what allows the model to be retrained or swapped without touching this
 * codebase — and it is why there is **no** shadow scorer here. If the risk
 * service cannot answer, the analysis is retried and, if it still cannot answer,
 * marked FAILED with a clear reason. Quietly substituting a different scoring
 * method in the product backend would make the reported risk untraceable.
 *
 * The transparent heuristic fallback lives inside the ML service (see
 * ml-service/app/heuristic.py), so a fallback score is still produced by the
 * component that owns scoring, and is always labelled as such.
 */
import { env } from "../../config/env";
import { scoped } from "../../lib/logger";
import { request, HttpNetworkError, HttpTimeoutError } from "../../lib/http";
import { mlInvalidResponse, mlTimeout, mlUnavailable, AppError } from "../../lib/errors";
import type {
  MlHealthResponse,
  MlPredictRequest,
  MlPredictResponse,
} from "./ml.types";

const log = scoped("ml-client");

const BASE = env.ML_SERVICE_URL.replace(/\/+$/, "");

function internalHeaders(): Record<string, string> {
  return {
    accept: "application/json",
    ...(env.ML_SERVICE_TOKEN ? { "x-internal-token": env.ML_SERVICE_TOKEN } : {}),
  };
}

/**
 * Score a feature vector.
 *
 * Retries are bounded by ML_MAX_RETRIES with jittered backoff, because the most
 * common failure is a cold container rather than a broken model.
 */
export async function predict(input: MlPredictRequest): Promise<MlPredictResponse> {
  const started = Date.now();

  let response;
  try {
    response = await request<MlPredictResponse>(`${BASE}/v1/predict`, {
      method: "POST",
      headers: internalHeaders(),
      body: input,
      timeoutMs: env.ML_REQUEST_TIMEOUT_MS,
      retries: env.ML_MAX_RETRIES,
      retryDelayMs: 600,
      retryOn: (status) => status >= 500 || status === 429,
      label: "ml-predict",
    });
  } catch (e) {
    if (e instanceof HttpTimeoutError) throw mlTimeout(env.ML_REQUEST_TIMEOUT_MS);
    if (e instanceof HttpNetworkError) throw mlUnavailable(e);
    throw e;
  }

  if (response.status === 422) {
    // The service rejected our feature vector — a contract mismatch, which is
    // our bug, not a transient failure. Surfaced as non-retryable.
    throw new AppError(
      500,
      "The risk service rejected the extracted features. This usually means the " +
        "feature set and the deployed model are out of step.",
      {
        code: "ML_INVALID_RESPONSE",
        retryable: false,
        details: response.data,
        context: { featureSetVersion: input.feature_set_version },
      },
    );
  }

  if (response.status === 503) {
    throw mlUnavailable(new Error("risk service reported no model available"));
  }

  if (!response.ok) {
    throw mlUnavailable(
      new Error(`risk service returned ${response.status}: ${response.raw.slice(0, 300)}`),
    );
  }

  const data = response.data;
  assertValidPrediction(data);

  log.debug(
    {
      engine: data.model.engine,
      modelVersion: data.model.version,
      riskScore: data.prediction.risk_score,
      contributions: data.explanation.contributions.length,
      roundTripMs: Date.now() - started,
      serviceLatencyMs: data.latency_ms,
    },
    "prediction received",
  );

  if (data.warnings.length > 0) {
    log.warn({ warnings: data.warnings }, "risk service reported warnings");
  }

  return data;
}

/**
 * Validate the response shape before anything downstream trusts it.
 *
 * A malformed score would otherwise be persisted and shown to a user as
 * authoritative. Cheap to check, and it turns a confusing NaN in the UI into a
 * precise error in the logs.
 */
function assertValidPrediction(data: unknown): asserts data is MlPredictResponse {
  // The explicit variable annotation is required for TypeScript to treat calls
  // to `fail` as never-returning, which is what narrows `d` below.
  const fail: (why: string) => never = (why) => {
    throw mlInvalidResponse({ reason: why });
  };

  if (typeof data !== "object" || data === null) fail("response was not an object");

  const d = data as Partial<MlPredictResponse>;

  if (!d.model || typeof d.model.version !== "string") fail("missing model.version");
  if (!d.prediction) fail("missing prediction");

  const p = d.prediction;
  if (typeof p.probability !== "number" || !Number.isFinite(p.probability)) {
    fail("prediction.probability is not a finite number");
  }
  if (typeof p.risk_score !== "number" || !Number.isFinite(p.risk_score)) {
    fail("prediction.risk_score is not a finite number");
  }
  if (p.risk_score < 0 || p.risk_score > 100) {
    fail(`prediction.risk_score ${p.risk_score} is outside 0-100`);
  }
  if (!["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(p.risk_level as string)) {
    fail(`prediction.risk_level "${p.risk_level}" is not a known level`);
  }

  if (!d.explanation || !Array.isArray(d.explanation.contributions)) {
    fail("missing explanation.contributions");
  }

  for (const c of d.explanation.contributions) {
    if (typeof c.key !== "string" || typeof c.shap_value !== "number") {
      fail("a contribution is missing key or shap_value");
    }
  }

  if (!Array.isArray(d.warnings)) (data as MlPredictResponse).warnings = [];
}

/** Liveness/readiness probe, used by the system health endpoint. */
export async function checkMlService(): Promise<{
  ok: boolean;
  latencyMs?: number;
  engine?: string;
  modelVersion?: string | null;
  error?: string;
}> {
  const started = Date.now();
  try {
    const response = await request<MlHealthResponse>(`${BASE}/health`, {
      method: "GET",
      headers: internalHeaders(),
      timeoutMs: 5_000,
      retries: 0,
      label: "ml-health",
    });

    if (!response.ok) {
      return { ok: false, error: `risk service returned ${response.status}` };
    }

    return {
      ok: response.data.status === "ok",
      latencyMs: Date.now() - started,
      engine: response.data.engine,
      modelVersion: response.data.model_version,
      ...(response.data.status !== "ok" ? { error: response.data.detail } : {}),
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Model metadata, surfaced in the UI so users know what scored their PR. */
export async function getModelInfo(): Promise<MlPredictResponse["model"] | null> {
  try {
    const response = await request<MlPredictResponse["model"]>(`${BASE}/v1/model/info`, {
      method: "GET",
      headers: internalHeaders(),
      timeoutMs: 5_000,
      retries: 1,
      label: "ml-model-info",
    });
    return response.ok ? response.data : null;
  } catch {
    return null;
  }
}
