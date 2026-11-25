"""Train on a small synthetic dataset, then exercise the HTTP API against that model."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

pytest.importorskip("xgboost")
pytest.importorskip("fastapi")

from fastapi.testclient import TestClient  # noqa: E402

from riskradar.features import FEATURE_NAMES  # noqa: E402


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> TestClient:
    tmp = tmp_path_factory.mktemp("api")
    rng = np.random.default_rng(0)
    rows = []
    for r in range(6):
        for i in range(120):
            f = {n: float(rng.integers(0, 20)) for n in FEATURE_NAMES}
            f["lines_added"] = float(rng.lognormal(3, 1.5))
            f["mean_file_age_days"] = math.nan if i % 7 == 0 else float(rng.integers(1, 400))
            risk = 1 / (1 + math.exp(-(math.log1p(f["lines_added"]) - 5)))
            rows.append({"repo": f"org/r{r}", "number": i + 1, "sha": f"{r}{i:039d}",
                         "merged_at": f"2024-{1 + i // 12:02d}-{1 + i % 12:02d}T00:00:00Z", "author_hash": "x",
                         "title": f"Change {i}", "top_files": "src/a.py;src/b.py",
                         "label": int(rng.random() < risk), "fixed_by": "#999" if rng.random() < risk else "", **f})
    data = tmp / "prs.csv.gz"
    pd.DataFrame(rows).to_csv(data, index=False, compression="gzip")

    from training.train import main as train

    out = tmp / "artifacts"
    assert train(["--data", str(data), "--out", str(out), "--quick"]) == 0

    mp = pytest.MonkeyPatch()
    mp.setenv("RISKRADAR_ARTIFACTS", str(out))
    from api import main as api_main

    for fn in (api_main.model, api_main.metrics, api_main.predictions):
        fn.cache_clear()
    yield TestClient(api_main.app)
    for fn in (api_main.model, api_main.metrics, api_main.predictions):
        fn.cache_clear()
    mp.undo()


def test_health_and_metrics(client: TestClient) -> None:
    assert client.get("/api/health").json()["status"] == "ok"
    m = client.get("/api/metrics").json()
    assert m["dataset"]["prs"] == 720 and m["dataset"]["features"] == 28
    assert 0.5 < m["test"]["roc_auc"] <= 1.0          # the synthetic label depends on size
    assert m["shap_max_abs_diff_vs_shap_package"] in (None,) or m["shap_max_abs_diff_vs_shap_package"] < 1e-4


def test_list_and_detail(client: TestClient) -> None:
    page = client.get("/api/prs", params={"limit": 5}).json()
    assert page["total"] > 0 and len(page["items"]) == 5
    probs = [p["prob"] for p in page["items"]]
    assert probs == sorted(probs, reverse=True)
    first = page["items"][0]
    detail = client.get(f"/api/prs/{first['repo']}/{first['number']}").json()
    score = detail["score"]
    assert len(score["contributions"]) == 28
    assert len(score["factors"]) <= 3 and all(f["shap"] > 0 for f in score["factors"])
    # SHAP contributions plus the base value reproduce the model's log-odds.
    logit = math.log(score["probability"] / (1 - score["probability"]))
    assert sum(score["contributions"].values()) + score["base_value"] == pytest.approx(logit, abs=1e-3)


def test_errors(client: TestClient) -> None:
    assert client.get("/api/prs/no/such/1").status_code == 404
    assert client.post("/api/score", json={"features": {"bogus": 1}}).status_code == 422
    assert client.post("/api/analyze", json={"url": "https://example.com/x"}).status_code == 422


def test_partial_features_never_explain_unknown_values(client: TestClient) -> None:
    s = client.post("/api/score", json={"features": {"lines_added": 5000}}).json()
    assert {f["feature"] for f in s["factors"]} <= {"lines_added"}
