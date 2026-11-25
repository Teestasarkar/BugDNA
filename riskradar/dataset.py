"""Read the mined PR tables with consistent types (features float, text str)."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from .features import FEATURE_NAMES

TEXT_COLUMNS = ("repo", "sha", "merged_at", "author_hash", "title", "top_files", "fixed_by", "split")


def read_prs(path: Path | str) -> pd.DataFrame:
    df = pd.read_csv(path, keep_default_na=False, na_values=[""], dtype={c: str for c in TEXT_COLUMNS})
    for c in TEXT_COLUMNS:
        if c in df:
            df[c] = df[c].fillna("").astype(str)
    for c in FEATURE_NAMES:
        if c in df:
            df[c] = pd.to_numeric(df[c].replace({"nan": None, "NaN": None}), errors="raise").astype(float)
    for c in ("number", "label"):
        if c in df:
            df[c] = df[c].astype(int)
    return df
