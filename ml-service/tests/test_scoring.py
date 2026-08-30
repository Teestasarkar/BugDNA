"""Tests for the risk service.

These assert the properties the product actually depends on, rather than
restating the implementation:

  * a docs-only change scores lower than a destructive migration — if this ever
    stops holding, the risk signal is broken regardless of what any metric says;
  * attributions are *additive*, so an explanation genuinely accounts for the
    score rather than being a decorative bar chart;
  * a malformed or partial feature vector degrades with a warning instead of
    producing a confident wrong answer;
  * the API contract the Node backend relies on does not drift.
"""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.features import CONTRACT, align
from app.heuristic import score as heuristic_score
from app.main import app


def _auth_headers() -> dict[str, str]:
    """The internal shared secret, when this deployment configures one.

    The service is internal-only and authenticates callers with a shared token
    (see app/deps.py). Tests go through the same door as the real client rather
    than disabling the check, so the auth path is exercised too.
    """
    if not settings.service_token:
        return {}
    return {"x-internal-token": settings.service_token}


@pytest.fixture(scope="module")
def client() -> TestClient:
    with TestClient(app, headers=_auth_headers()) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# Fixtures: representative pull requests
# ---------------------------------------------------------------------------


def _base_features() -> dict[str, float]:
    """A neutral vector using each feature's documented fallback."""
    return {spec.key: spec.fallback for spec in CONTRACT.features}


def docs_only_change() -> dict[str, float]:
    features = _base_features()
    features.update(
        {
            "lines_added": 3,
            "lines_deleted": 1,
            "total_churn": 4,
            "files_changed": 2,
            "commits_count": 1,
            "docs_only_change": 1,
            "has_description": 1,
            "description_length": 120,
            "modules_touched": 1,
            "max_module_concentration": 1.0,
            "languages_touched": 1,
            "avg_changes_per_file": 2,
            "max_file_churn": 3,
        }
    )
    return features


def destructive_migration() -> dict[str, float]:
    features = _base_features()
    features.update(
        {
            "lines_added": 620,
            "lines_deleted": 410,
            "total_churn": 1030,
            "files_changed": 34,
            "commits_count": 12,
            "avg_changes_per_file": 30,
            "max_file_churn": 210,
            "deletion_ratio": 0.4,
            "files_removed": 4,
            "source_files_changed": 30,
            "test_files_changed": 0,
            "touches_tests": 0,
            "test_to_source_ratio": 0,
            "migration_files_changed": 2,
            "has_destructive_sql": 1,
            "touches_public_api": 1,
            "public_api_files_changed": 6,
            "touches_auth_or_secrets": 1,
            "removes_error_handling": 1,
            "modules_touched": 8,
            "cross_module_change": 1,
            "max_module_concentration": 0.3,
            "languages_touched": 3,
            "has_description": 1,
            "description_length": 400,
            "review_comments_count": 0,
            "churn_vs_repo_median": 6.4,
            "module_incident_history": 0.6,
            "author_module_familiarity": 0.1,
            "repo_deployment_failure_rate_90d": 0.3,
        }
    )
    return features


def well_tested_feature() -> dict[str, float]:
    features = _base_features()
    features.update(
        {
            "lines_added": 180,
            "lines_deleted": 40,
            "total_churn": 220,
            "files_changed": 6,
            "commits_count": 4,
            "avg_changes_per_file": 36,
            "max_file_churn": 90,
            "source_files_changed": 3,
            "test_files_changed": 2,
            "touches_tests": 1,
            "test_to_source_ratio": 0.8,
            "modules_touched": 1,
            "max_module_concentration": 0.9,
            "languages_touched": 1,
            "has_description": 1,
            "description_length": 620,
            "review_comments_count": 7,
            "churn_vs_repo_median": 1.1,
            "author_module_familiarity": 0.95,
            "author_pr_count_90d": 22,
        }
    )
    return features


def _predict(client: TestClient, features: dict[str, float]) -> dict:
    response = client.post(
        "/v1/predict",
        json={
            "feature_set_version": CONTRACT.feature_set_version,
            "features": features,
            "max_contributions": 20,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Contract
# ---------------------------------------------------------------------------


def test_feature_contract_is_loaded() -> None:
    """Without the contract, every score is meaningless. Fail loudly."""
    assert CONTRACT.loaded, (
        "contracts/feature-spec.json was not found. "
        "Run `npm run contracts:generate` in backend/."
    )
    assert len(CONTRACT.features) > 20
    assert len(set(CONTRACT.keys)) == len(CONTRACT.keys), "duplicate feature keys"


def test_health_reports_engine(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200

    body = response.json()
    assert body["status"] in {"ok", "degraded"}
    assert body["engine"] in {"xgboost", "heuristic"}
    assert body["feature_set_version"] == CONTRACT.feature_set_version
    # A heuristic-backed service must say so rather than presenting as healthy.
    if body["engine"] == "heuristic":
        assert body["status"] == "degraded"
        assert body["detail"]


def test_predict_response_shape(client: TestClient) -> None:
    """The exact shape backend/src/modules/ml/ml.client.ts validates."""
    body = _predict(client, well_tested_feature())

    assert set(body) >= {"model", "prediction", "explanation", "warnings", "latency_ms"}
    assert set(body["model"]) >= {"name", "version", "engine", "feature_set_version"}
    assert set(body["prediction"]) == {
        "probability",
        "risk_score",
        "risk_level",
        "confidence",
    }
    assert set(body["explanation"]) >= {"base_value", "contributions", "method"}

    prediction = body["prediction"]
    assert 0.0 <= prediction["probability"] <= 1.0
    assert 0.0 <= prediction["risk_score"] <= 100.0
    assert prediction["risk_level"] in {"LOW", "MODERATE", "HIGH", "CRITICAL"}

    for contribution in body["explanation"]["contributions"]:
        assert set(contribution) == {"key", "shap_value", "feature_value", "contribution"}
        assert math.isfinite(contribution["shap_value"])


# ---------------------------------------------------------------------------
# Behaviour that matters to the product
# ---------------------------------------------------------------------------


def test_risky_change_scores_above_safe_change(client: TestClient) -> None:
    """The single most important property of the whole system."""
    safe = _predict(client, docs_only_change())["prediction"]
    risky = _predict(client, destructive_migration())["prediction"]

    assert risky["risk_score"] > safe["risk_score"], (
        f"a destructive migration with no tests scored {risky['risk_score']}, "
        f"below a documentation typo at {safe['risk_score']}"
    )
    # Not merely ordered — meaningfully separated.
    assert risky["risk_score"] - safe["risk_score"] > 20


def test_docs_only_change_is_low_risk(client: TestClient) -> None:
    prediction = _predict(client, docs_only_change())["prediction"]
    assert prediction["risk_level"] == "LOW"


def test_destructive_migration_is_elevated(client: TestClient) -> None:
    prediction = _predict(client, destructive_migration())["prediction"]
    assert prediction["risk_level"] in {"HIGH", "CRITICAL"}


def test_adding_tests_reduces_risk(client: TestClient) -> None:
    """The product's central promise: acting on advice changes the assessment."""
    without = destructive_migration()

    with_tests = dict(without)
    with_tests.update(
        {
            "touches_tests": 1,
            "test_files_changed": 8,
            "test_to_source_ratio": 0.65,
        }
    )

    before = _predict(client, without)["prediction"]["risk_score"]
    after = _predict(client, with_tests)["prediction"]["risk_score"]

    assert after < before, (
        f"adding test coverage did not reduce the score ({before} -> {after})"
    )


def test_explanation_identifies_the_real_drivers(client: TestClient) -> None:
    """The explanation must name the causes, not arbitrary features."""
    body = _predict(client, destructive_migration())

    increasing = [
        c["key"] for c in body["explanation"]["contributions"] if c["shap_value"] > 0
    ]

    # At least one of the genuinely alarming signals should be surfaced.
    expected = {
        "has_destructive_sql",
        "migration_files_changed",
        "touches_tests",
        "total_churn",
        "files_changed",
        "touches_auth_or_secrets",
        "module_incident_history",
    }
    assert expected & set(increasing[:8]), (
        f"top risk drivers were {increasing[:8]}, none of which are the "
        f"destructive migration, missing tests, or change size"
    )


def test_protective_factors_are_reported(client: TestClient) -> None:
    """A low score needs visible reasons, or it reads as arbitrary."""
    body = _predict(client, well_tested_feature())
    decreasing = [
        c["key"] for c in body["explanation"]["contributions"] if c["shap_value"] < 0
    ]
    assert decreasing, "no risk-reducing factors were reported for a well-tested PR"


# ---------------------------------------------------------------------------
# Explanation integrity
# ---------------------------------------------------------------------------


def test_heuristic_attributions_are_exactly_additive() -> None:
    """base + sum(attributions) == logit(probability).

    The heuristic is a linear model, so this is an identity, not an
    approximation. If it ever fails, the explanation is not describing the score.
    """
    aligned = align(destructive_migration())
    result = heuristic_score(aligned)

    total = sum(value for _, value, _ in result.contributions)
    logit = result.base_value + total
    reconstructed = 1.0 / (1.0 + math.exp(-logit))

    assert reconstructed == pytest.approx(result.probability, abs=1e-9)


def test_contributions_are_ranked_by_influence(client: TestClient) -> None:
    body = _predict(client, destructive_migration())
    magnitudes = [abs(c["shap_value"]) for c in body["explanation"]["contributions"]]
    assert magnitudes == sorted(magnitudes, reverse=True)


def test_contribution_shares_are_percentages(client: TestClient) -> None:
    body = _predict(client, destructive_migration())
    for contribution in body["explanation"]["contributions"]:
        assert 0.0 <= contribution["contribution"] <= 100.0


# ---------------------------------------------------------------------------
# Degradation and error handling
# ---------------------------------------------------------------------------


def test_missing_features_use_fallbacks_and_warn(client: TestClient) -> None:
    """A partial vector must degrade visibly, not silently."""
    response = client.post(
        "/v1/predict",
        json={
            "feature_set_version": CONTRACT.feature_set_version,
            "features": {"total_churn": 500, "files_changed": 20},
        },
    )
    assert response.status_code == 200

    body = response.json()
    assert body["warnings"], "a partial feature vector produced no warning"
    assert any("not supplied" in w for w in body["warnings"])
    assert math.isfinite(body["prediction"]["risk_score"])


def test_unknown_features_are_ignored_with_a_warning(client: TestClient) -> None:
    features = docs_only_change()
    features["a_feature_that_does_not_exist"] = 42.0

    body = _predict(client, features)
    assert any("unrecognised" in w for w in body["warnings"])


def test_feature_set_version_mismatch_is_reported(client: TestClient) -> None:
    response = client.post(
        "/v1/predict",
        json={"feature_set_version": "0.0.1-ancient", "features": docs_only_change()},
    )
    assert response.status_code == 200
    assert any("0.0.1-ancient" in w for w in response.json()["warnings"])


def test_empty_features_are_rejected(client: TestClient) -> None:
    response = client.post(
        "/v1/predict",
        json={"feature_set_version": CONTRACT.feature_set_version, "features": {}},
    )
    assert response.status_code == 422


def test_non_finite_feature_is_handled(client: TestClient) -> None:
    """NaN would propagate into a meaningless score; it must be caught."""
    aligned = align({**docs_only_change(), "total_churn": float("nan")})
    assert all(math.isfinite(v) for v in aligned.values)
    assert any("finite" in w for w in aligned.warnings)


def test_malformed_body_is_a_422(client: TestClient) -> None:
    response = client.post("/v1/predict", json={"features": "not-a-dict"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"


# ---------------------------------------------------------------------------
# Honesty guarantees
# ---------------------------------------------------------------------------


def test_no_metrics_are_claimed_without_real_evaluation(client: TestClient) -> None:
    """A synthetic or absent model must not report accuracy numbers."""
    response = client.get("/v1/model/info")
    assert response.status_code == 200

    info = response.json()
    if info["engine"] == "heuristic":
        assert info["metrics"] is None, (
            "the heuristic fallback reported evaluation metrics, which it cannot have"
        )


def test_heuristic_scoring_is_labelled(client: TestClient) -> None:
    body = _predict(client, docs_only_change())
    method = body["explanation"]["method"]
    engine = body["model"]["engine"]

    assert (engine == "heuristic") == (method == "heuristic_weights"), (
        "the engine and the explanation method disagree about how this was scored"
    )

    if engine == "heuristic":
        assert body["explanation"]["notes"], "fallback scoring produced no disclosure note"
        assert any("not a trained model" in n for n in body["explanation"]["notes"])


def test_scoring_is_deterministic(client: TestClient) -> None:
    """The same commit must always produce the same score."""
    features = destructive_migration()
    first = _predict(client, features)["prediction"]
    second = _predict(client, features)["prediction"]
    assert first["risk_score"] == second["risk_score"]
    assert first["probability"] == second["probability"]


# ---------------------------------------------------------------------------
# Internal authentication
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not settings.service_token,
    reason="no ML_SERVICE_TOKEN configured, so the check is intentionally disabled",
)
def test_predict_requires_the_internal_token() -> None:
    """The scoring endpoint must not be callable without the shared secret."""
    with TestClient(app) as anonymous:
        response = anonymous.post(
            "/v1/predict",
            json={
                "feature_set_version": CONTRACT.feature_set_version,
                "features": docs_only_change(),
            },
        )
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "INVALID_INTERNAL_TOKEN"


@pytest.mark.skipif(
    not settings.service_token,
    reason="no ML_SERVICE_TOKEN configured, so the check is intentionally disabled",
)
def test_wrong_internal_token_is_rejected() -> None:
    with TestClient(app, headers={"x-internal-token": "not-the-token"}) as wrong:
        response = wrong.post(
            "/v1/predict",
            json={
                "feature_set_version": CONTRACT.feature_set_version,
                "features": docs_only_change(),
            },
        )
    assert response.status_code == 403


def test_health_does_not_require_a_token() -> None:
    """Orchestrators and the backend probe must reach /health unauthenticated."""
    with TestClient(app) as anonymous:
        assert anonymous.get("/health").status_code == 200
