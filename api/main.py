"""HTTP API for PR Risk Radar, and the built web app when it exists.

    uvicorn api.main:app --reload --port 8000
"""

from __future__ import annotations

import json
import math
import os
import threading
from collections import OrderedDict
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from riskradar import paths
from riskradar.dataset import read_prs
from riskradar.explain import recommendation
from riskradar.features import FEATURE_NAMES, SPEC_BY_NAME
from riskradar.scoring import RiskModel, artifacts_dir

from .github import GitHubError, analyze_pr

ROOT = Path(__file__).resolve().parent.parent
WEB_DIST = ROOT / "web" / "dist"

app = FastAPI(title="PR Risk Radar", version="1.0.0",
              description="Pre-merge defect risk for GitHub pull requests: XGBoost + TreeSHAP.")
app.add_middleware(CORSMiddleware, allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
                   allow_methods=["GET", "POST"], allow_headers=["*"])


@lru_cache(maxsize=1)
def model() -> RiskModel:
    return RiskModel()


@lru_cache(maxsize=1)
def metrics() -> dict:
    return json.loads((artifacts_dir() / "metrics.json").read_text())


@lru_cache(maxsize=1)
def repos_meta() -> list[dict]:
    p = ROOT / "data" / "repos.json"
    return json.loads(p.read_text()) if p.exists() else []


@lru_cache(maxsize=1)
def predictions() -> pd.DataFrame:
    df = read_prs(artifacts_dir() / "predictions.csv.gz").reset_index(drop=True)
    m = model()
    df["percentile"] = [round(m.percentile(p), 1) for p in df["prob"]]
    df["flagged"] = df["prob"] >= m.threshold
    df["high_recall_flagged"] = df["prob"] >= m.high_recall_threshold
    df["band"] = [m.band(p, q) for p, q in zip(df["prob"], df["percentile"])]
    df["outcome"] = [("tp" if y else "fp") if f else ("fn" if y else "tn") for f, y in zip(df["flagged"], df["label"])]
    # Risk shares per PR: positive SHAP of features with a known value, as % of the positive total.
    x = df[list(FEATURE_NAMES)].to_numpy(dtype=np.float64)
    pos = np.where(np.isnan(x), 0.0, np.clip(m.contributions(x).astype(np.float64), 0.0, None))
    total = pos.sum(axis=1, keepdims=True)
    shares = np.divide(100.0 * pos, total, out=np.zeros_like(pos), where=total > 0)
    top = shares.argmax(axis=1)
    df["top_factor"] = [FEATURE_NAMES[j] if total[i, 0] > 0 else "" for i, j in enumerate(top)]
    df["top_share"] = np.round(shares[np.arange(len(df)), top], 1)
    df.attrs["shares"] = shares
    return df


def _clean(v):
    if isinstance(v, float) and math.isnan(v):
        return None
    return v.item() if hasattr(v, "item") else v


def _row_summary(r: pd.Series) -> dict:
    return {k: _clean(r[k]) for k in ("repo", "number", "title", "merged_at", "split", "label", "prob",
                                      "percentile", "band", "flagged", "high_recall_flagged", "outcome",
                                      "fixed_by", "top_factor", "top_share")}


def _context(top_files: str) -> dict:
    files = [f for f in top_files.split(";") if f]
    subs = []
    for f in files:
        s = paths.subsystem(f)
        if s and s not in subs:
            subs.append(s)
    return {"top_files": files, "subsystems": subs}


# -- routes ----------------------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    try:
        m = model()
        return {"status": "ok", "model": {"trees": m.meta["trees"], "threshold": m.threshold}}
    except Exception as exc:  # noqa: BLE001 - health must answer, not crash
        return {"status": "degraded", "error": str(exc)}


@app.get("/api/metrics")
def get_metrics() -> dict:
    return metrics()


@app.get("/api/features")
def get_features() -> list[dict]:
    return metrics()["feature_specs"]


@app.get("/api/repos")
def get_repos() -> list[dict]:
    df = predictions()
    per_repo = {r["repo"]: r for r in metrics()["per_repo"]}
    meta = {r["repo"]: r for r in repos_meta()}
    out = []
    for repo, g in df.groupby("repo"):
        m = meta.get(repo, {})
        out.append({"repo": repo, "prs": int(len(g)), "defect_rate": round(float(g.label.mean()), 4),
                    "first_merged": str(g.merged_at.min())[:10], "last_merged": str(g.merged_at.max())[:10],
                    "test": per_repo.get(repo), "fix_commits": m.get("fix_commits_after_window_start")})
    return sorted(out, key=lambda r: r["repo"].lower())


@app.get("/api/prs")
def list_prs(
    repo: str | None = None,
    split: Literal["train", "val", "test", "all"] = "test",
    outcome: Literal["tp", "fp", "fn", "tn", "all"] = "all",
    band: Literal["HIGH", "MEDIUM", "LOW", "all"] = "all",
    factor: str | None = Query(None, max_length=60, description="only PRs whose #1 risk driver is this feature"),
    q: str | None = Query(None, max_length=200),
    sort: Literal["prob", "merged_at", "number"] = "prob",
    order: Literal["asc", "desc"] = "desc",
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    df = predictions()
    if split != "all":
        df = df[df.split == split]
    if repo:
        df = df[df.repo == repo]
    if outcome != "all":
        df = df[df.outcome == outcome]
    if band != "all":
        df = df[df.band == band]
    if factor:
        df = df[df.top_factor == factor]
    if q:
        df = df[df.title.str.contains(q, case=False, regex=False)]
    df = df.sort_values(sort, ascending=order == "asc", kind="stable")
    page = df.iloc[offset:offset + limit]
    return {"total": int(len(df)), "items": [_row_summary(r) for _, r in page.iterrows()]}


Population = Literal["flagged", "defects", "caught", "missed", "all"]
_POPULATIONS = {
    "flagged": lambda d: d.flagged,
    "defects": lambda d: d.label == 1,
    "caught": lambda d: d.flagged & (d.label == 1),
    "missed": lambda d: ~d.flagged & (d.label == 1),
    "all": lambda d: pd.Series(True, index=d.index),
}


@app.get("/api/drivers")
def drivers(population: Population = "flagged", split: Literal["train", "val", "test", "all"] = "test",
            repo: str | None = None) -> dict:
    """Which features drive risk across a population of PRs, by SHAP share, with the recommended fix."""
    df = predictions()
    mask = _POPULATIONS[population](df)
    if split != "all":
        mask &= df.split == split
    if repo:
        mask &= df.repo == repo
    idx = np.flatnonzero(mask.to_numpy())
    shares = df.attrs["shares"][idx]
    ranks = np.argsort(-shares, axis=1)[:, :3] if len(idx) else np.empty((0, 3), dtype=int)
    medians = model().medians
    sub = df.iloc[idx]
    items = []
    for j, name in enumerate(FEATURE_NAMES):
        col = shares[:, j]
        raising = int((col > 0).sum())
        if raising == 0:
            continue
        spec = SPEC_BY_NAME[name]
        items.append({
            "feature": name, "label": spec.label, "group": spec.group, "description": spec.description,
            "mean_share": round(float(col.mean()), 2),
            "prs_top1": int((sub.top_factor == name).sum()),
            "prs_top3": int(((ranks == j) & (np.take_along_axis(shares, ranks, axis=1) > 0)).any(axis=1).sum()),
            "prs_raising": raising,
            "median_value": _clean(float(sub[name].median())), "dataset_median": medians.get(name),
            "recommendation": recommendation(name),
        })
    items.sort(key=lambda r: -r["mean_share"])
    return {"population": population, "split": split, "repo": repo, "prs": int(len(idx)),
            "defect_rate": round(float(sub.label.mean()), 4) if len(idx) else None, "drivers": items}


@app.get("/api/prs/{owner}/{name}/{number}")
def get_pr(owner: str, name: str, number: int) -> dict:
    df = predictions()
    hit = df[(df.repo == f"{owner}/{name}") & (df.number == number)]
    if hit.empty:
        raise HTTPException(404, "That PR is not in the dataset. Use /api/analyze to score any public PR.")
    r = hit.iloc[0]
    features = {n: _clean(r[n]) for n in FEATURE_NAMES}
    ctx = _context(r["top_files"])
    score = model().score([{n: (math.nan if v is None else v) for n, v in features.items()}], [ctx], k=3)[0]
    return {"pr": {**_row_summary(r), "url": f"https://github.com/{r['repo']}/pull/{int(r['number'])}"},
            "features": features, "context": ctx, "score": score.to_dict()}


class ScoreRequest(BaseModel):
    features: dict[str, float | None] = Field(..., description="All 28 features by name; null = unknown")
    context: dict | None = None


@app.post("/api/score")
def score(req: ScoreRequest) -> dict:
    unknown = set(req.features) - set(FEATURE_NAMES)
    if unknown:
        raise HTTPException(422, f"Unknown features: {sorted(unknown)}")
    row = {n: (math.nan if req.features.get(n) is None else float(req.features[n])) for n in FEATURE_NAMES}
    return model().score([row], [req.context or {}], k=3)[0].to_dict()


class AnalyzeRequest(BaseModel):
    url: str = Field(..., max_length=300, examples=["https://github.com/encode/httpx/pull/3571"])


_cache: OrderedDict[str, dict] = OrderedDict()
_cache_lock = threading.Lock()


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest) -> dict:
    key = req.url.strip().rstrip("/").lower()
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return {**_cache[key], "cached": True}
    try:
        result = analyze_pr(req.url)
    except GitHubError as exc:
        raise HTTPException(exc.status, str(exc)) from exc
    row = {n: (math.nan if v is None else v) for n, v in result["features"].items()}
    result["features"] = {n: _clean(v) for n, v in row.items()}
    result["score"] = model().score([row], [result["context"]], k=3)[0].to_dict()
    with _cache_lock:
        _cache[key] = result
        while len(_cache) > 200:
            _cache.popitem(last=False)
    return {**result, "cached": False}


@app.get("/api/feature/{name}")
def feature_info(name: str) -> dict:
    if name not in SPEC_BY_NAME:
        raise HTTPException(404, "Unknown feature")
    f = SPEC_BY_NAME[name]
    return {"name": f.name, "group": f.group, "label": f.label, "description": f.description,
            "median": model().medians.get(name)}


# -- the built single-page app ------------------------------------------------------------------------
if WEB_DIST.exists():
    app.mount("/assets", StaticFiles(directory=WEB_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str) -> FileResponse:
        if full_path.startswith("api/"):
            raise HTTPException(404, "Not found")
        candidate = (WEB_DIST / full_path).resolve()
        if full_path and candidate.is_file() and WEB_DIST in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(WEB_DIST / "index.html")
