"""Transparent fallback scorer.

Why this exists
---------------
BugDNA's intended scorer is a trained XGBoost model. But a deployment can
legitimately have no model artifact: a fresh install before any training run, a
rolled-back model, an operator who has not yet supplied labelled data. The
options in that situation are to fail every analysis, or to score with something
honest and clearly labelled.

This is that something. It is an **additive linear model over normalised
features**, which has two properties that matter here:

  1. **It is exactly explainable.** Because the model is a sum of per-feature
     terms, those terms *are* its attributions — there is no approximation. They
     are returned in the same shape as SHAP values, so the explanation layer
     downstream needs no special case, and `method` is reported as
     `heuristic_weights` so the UI can say where the number came from.

  2. **Its weights are stated, not learned.** They come from the shared feature
     contract (`heuristicWeight`), which means they are visible in a committed
     JSON file rather than buried in a binary. They encode ordinary engineering
     judgement — a destructive migration is riskier than a docs typo — and they
     are explicitly *not* a claim about measured predictive importance.

What this is not
----------------
It is not trained, validated, or calibrated against outcomes. Every response it
produces is labelled `engine: "heuristic"`, the backend records
`scoredBy: HEURISTIC` on the analysis, and the UI states it on the page. It is a
structured heuristic standing in for a model, and it says so at every layer.
"""

from __future__ import annotations

import math

from .features import CONTRACT, AlignedFeatures, FeatureContract

# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------
# Counted features are unbounded, so they are compressed logarithmically against
# a reference scale before being weighted. Without this, one 20,000-line
# generated-file diff would dominate every other signal.
#
# Each scale is the value that normalises to ~1.0 — the point past which "bigger"
# stops carrying much extra information.

REFERENCE_SCALE: dict[str, float] = {
    "lines": 1_000.0,  # a 1000-line change is already very large
    "count": 40.0,  # 40 files/modules/comments
    "hours": 720.0,  # 30 days
}

# Prior log-odds for a change with no notable signals. Chosen so that an
# unremarkable small PR lands in the LOW band rather than at zero — a score of 0
# would imply certainty no product can honestly claim.
BASE_LOG_ODDS = -1.90

# Calibration scale applied to the summed weights before the sigmoid.
#
# Why this is needed: the raw weighted sum for a genuinely alarming pull request
# reaches roughly +27 log-odds, and the sigmoid is numerically saturated beyond
# about +6. Without scaling, every high-risk change collapses to exactly 100 and
# all resolution at the top of the range is lost — which breaks the product's
# central loop, because a developer who acts on the recommendations would see the
# score stay pinned at 100.
#
# Dividing by this constant maps the observed range (about -4 to +27) onto a
# usable sigmoid input (about -2.4 to +4.1), so a CRITICAL pull request scores in
# the high 80s or 90s and *still moves* when its worst signals are addressed.
#
# It is a presentation constant, not a learned parameter: it changes the spread
# of scores, never their order.
LOG_ODDS_SCALE = 4.5


def _normalise(value: float, feature_type: str) -> float:
    """Compress a raw feature value into a comparable magnitude."""
    if feature_type == "boolean":
        return 1.0 if value >= 0.5 else 0.0

    if feature_type == "ratio":
        return max(0.0, min(1.0, value))

    scale = REFERENCE_SCALE.get(feature_type, REFERENCE_SCALE["count"])
    if value <= 0:
        return 0.0
    return min(1.0, math.log1p(value) / math.log1p(scale))


def _sigmoid(x: float) -> float:
    # Clamped to avoid overflow warnings on extreme inputs.
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-min(x, 60.0)))
    exp_x = math.exp(max(x, -60.0))
    return exp_x / (1.0 + exp_x)


def attribute(
    values_by_key: dict[str, float],
    contract: FeatureContract | None = None,
) -> tuple[list[tuple[str, float, float]], float]:
    """Compute the per-feature attributions and their sum.

    The scale is applied to each attribution individually rather than to the
    total, which keeps the additive identity exact:

        BASE_LOG_ODDS + sum(attributions) == logit(probability)

    Shared with training/generate_bootstrap_dataset.py so the synthetic labels
    and the fallback scorer can never disagree about what the weights mean.

    Returns (contributions, total) where each contribution is
    ``(key, scaled_attribution, raw_feature_value)``.
    """
    active = contract or CONTRACT

    contributions: list[tuple[str, float, float]] = []
    total = 0.0

    for key, raw_value in values_by_key.items():
        spec = active.spec(key)
        if spec is None or spec.heuristic_weight == 0.0:
            # No stated weight means the feature is carried for the model's
            # benefit but has no role in the heuristic. Recording a zero
            # attribution keeps the vector complete without inventing a signal.
            contributions.append((key, 0.0, raw_value))
            continue

        normalised = _normalise(raw_value, spec.type)
        attribution = (normalised * spec.heuristic_weight) / LOG_ODDS_SCALE

        contributions.append((key, attribution, raw_value))
        total += attribution

    return contributions, total


def heuristic_logit(
    values_by_key: dict[str, float],
    contract: FeatureContract | None = None,
) -> float:
    """The heuristic's log-odds for a feature dict."""
    _, total = attribute(values_by_key, contract)
    return BASE_LOG_ODDS + total


class HeuristicResult:
    """Score plus exact per-feature attributions."""

    def __init__(
        self,
        probability: float,
        base_value: float,
        contributions: list[tuple[str, float, float]],
        notes: list[str],
    ) -> None:
        self.probability = probability
        self.base_value = base_value
        # (key, attribution_in_log_odds, raw_feature_value)
        self.contributions = contributions
        self.notes = notes


def score(
    aligned: AlignedFeatures,
    contract: FeatureContract | None = None,
) -> HeuristicResult:
    """Score an aligned feature vector.

    Returns attributions in log-odds space, matching the SHAP convention:

        base_value + sum(attributions) == logit(probability)

    which holds exactly here, because the model is the sum.
    """
    active = contract or CONTRACT
    notes: list[str] = [
        "Scored by BugDNA's transparent rule-based scorer, not a trained model. "
        "Weights are declared in contracts/feature-spec.json and reflect "
        "engineering judgement rather than measured predictive importance."
    ]

    contributions, total = attribute(dict(zip(aligned.keys, aligned.values, strict=True)), active)

    logit = BASE_LOG_ODDS + total
    probability = _sigmoid(logit)

    if not active.loaded:
        notes.append(
            "No feature contract was loaded, so no weights could be applied and "
            "this score reflects only the base rate."
        )

    return HeuristicResult(
        probability=probability,
        base_value=BASE_LOG_ODDS,
        contributions=contributions,
        notes=notes,
    )


def confidence_from_logit(probability: float) -> float:
    """Rough confidence: distance from the 0.5 decision boundary.

    Reported as a confidence signal rather than a calibrated probability
    interval, and documented as such. A prediction at 0.5 is maximally uncertain;
    one at 0.05 or 0.95 is a clear call given the inputs — which is a statement
    about the decisiveness of the signals, not about the model being right.
    """
    return round(min(1.0, abs(probability - 0.5) * 2.0), 4)
