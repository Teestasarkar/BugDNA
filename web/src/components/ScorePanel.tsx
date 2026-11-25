import type { ReactNode } from "react";
import type { FeatureSpec, Score } from "../lib/api";
import { bandLabel, num, pct, score as scoreOf } from "../lib/format";
import { ShapChart } from "./charts";
import { BandBadge, CheckIcon } from "./ui";

export function ScoreSummary({ score, threshold }: { score: Score; threshold: number }) {
  const band = score.band.toLowerCase();
  return (
    <div className="card">
      <div className="card-head"><h3>Risk score</h3><BandBadge band={score.band} /></div>
      <div className="score-big" style={{ marginTop: 8 }}>
        <span className="num">{scoreOf(score.percentile)}</span>
        <span className="of">/ 100</span>
      </div>
      <div className={`meter ${band}`} style={{ marginTop: 10 }} role="img" aria-label={`${bandLabel[score.band]}, risk score ${scoreOf(score.percentile)} of 100`}>
        <span style={{ width: `${Math.max(2, score.percentile)}%` }} />
      </div>
      <dl className="kv">
        <dt>Meaning</dt>
        <dd>Riskier than {scoreOf(score.percentile)}% of validation PRs</dd>
        <dt>Model probability</dt>
        <dd>{pct(score.probability, 1)} <span className="muted">(flag threshold {pct(threshold, 1)})</span></dd>
        <dt>Decision</dt>
        <dd>{score.flagged ? "Flagged for extra review" : "Not flagged"}</dd>
      </dl>
    </div>
  );
}

export function Factors({ score }: { score: Score }) {
  return (
    <div className="card">
      <div className="card-head"><h3>Top risk factors and what to do</h3></div>
      <p className="card-sub">The features that push this PR's risk up the most, ranked by SHAP contribution.</p>
      {score.factors.length === 0 ? (
        <p className="muted">Nothing in this PR raises its risk above the model's baseline.</p>
      ) : (
        score.factors.map((f, i) => (
          <div className="factor" key={f.feature}>
            <div className="rank" aria-hidden="true">{i + 1}</div>
            <div>
              <div className="finding">{f.finding}</div>
              <div className="fix"><CheckIcon /><span>{f.remediation}</span></div>
              <div className="meta">{f.label} · +{f.shap.toFixed(3)} log-odds</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

export function FeatureTable({ features, contributions, specs }: {
  features: Record<string, number | null>;
  contributions: Record<string, number>;
  specs: FeatureSpec[];
}) {
  return (
    <details className="card">
      <summary style={{ cursor: "pointer" }}><h3 style={{ display: "inline" }}>All 28 feature values</h3></summary>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table>
          <thead><tr><th>Feature</th><th>Group</th><th className="num">Value</th><th className="num">SHAP</th></tr></thead>
          <tbody>
            {specs.map((s) => (
              <tr key={s.name}>
                <td><div>{s.label}</div><div className="muted small">{s.description}</div></td>
                <td className="muted">{s.group}</td>
                <td className="num">{num(features[s.name])}</td>
                <td className="num">{(contributions[s.name] ?? 0) > 0 ? "+" : ""}{(contributions[s.name] ?? 0).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

export function ScorePanel({ score, features, specs, threshold, aside }: {
  score: Score;
  features: Record<string, number | null>;
  specs: FeatureSpec[];
  threshold: number;
  aside?: ReactNode;
}) {
  return (
    <div className="stack">
      <div className="score-head">
        <div className="stack">
          <ScoreSummary score={score} threshold={threshold} />
          {aside}
        </div>
        <Factors score={score} />
      </div>
      <div className="card">
        <div className="card-head"><h3>Why this score</h3></div>
        <p className="card-sub">Each bar is one feature's exact TreeSHAP contribution for this PR (largest 12 shown).</p>
        <ShapChart contributions={score.contributions} values={features} specs={specs} />
      </div>
      <FeatureTable features={features} contributions={score.contributions} specs={specs} />
    </div>
  );
}
