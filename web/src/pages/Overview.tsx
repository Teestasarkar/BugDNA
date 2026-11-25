import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { compact, pct } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { ImportanceChart, PrCurveChart, RocChart } from "../components/charts";
import { CheckIcon, ErrorNote, Loading, StatTile } from "../components/ui";

export default function Overview() {
  const m = useAsync(api.metrics, []);
  const repos = useAsync(api.repos, []);
  const drivers = useAsync(() => api.drivers("flagged"), []);
  const navigate = useNavigate();

  if (m.error) return <ErrorNote message={m.error} />;
  if (!m.data) return <Loading label="Loading model results" />;
  const d = m.data;
  const t = d.test;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <section className="hero">
        <div className="card" style={{ padding: 24 }}>
          <h1>Which pull requests will need a fix later?</h1>
          <p className="lede">
            PR Risk Radar scores a GitHub pull request before it merges, explains the score with SHAP, and says what
            to do about the top three risk factors. The model learned from {d.dataset.prs.toLocaleString()} real merged
            PRs across {d.dataset.repos} open-source repositories, labelled by tracing later bug fixes back to the
            lines that caused them.
          </p>
          <div className="cta">
            <Link className="btn primary" to="/analyze">Analyze a PR</Link>
            <Link className="btn" to="/prs?outcome=tp">See caught defects</Link>
            <Link className="btn" to="/methodology">How it works</Link>
          </div>
        </div>
        <div className="card" style={{ padding: 20 }}>
          <h3 style={{ marginBottom: 12 }}>Pipeline</h3>
          <ol className="pipeline">
            <li><span className="n">1</span><span><b>Mine</b> first-parent git history of {d.dataset.repos} repos (squash-merged PRs)</span></li>
            <li><span className="n">2</span><span><b>Label</b> with SZZ: blame the lines each later bug fix changed</span></li>
            <li><span className="n">3</span><span><b>Featurize</b> {d.dataset.features} signals known at merge time: churn, diffusion, file history, author experience</span></li>
            <li><span className="n">4</span><span><b>Train</b> XGBoost on each repo's past, test on its future</span></li>
            <li><span className="n">5</span><span><b>Explain</b> every score with exact TreeSHAP and remediation rules</span></li>
          </ol>
        </div>
      </section>

      <section>
        <div className="tiles">
          <StatTile label="ROC-AUC (held-out test)" value={t.roc_auc.toFixed(3)}
            note={`Lines-changed baseline: ${d.baselines.size_only_roc_auc.toFixed(3)}`} />
          <StatTile label="Defect-causing PRs caught" value={pct(t.recall)}
            note={`${Math.round(t.recall * t.positives)} of ${t.positives} defect-inducing PRs caught`} />
          <StatTile label="Precision (balanced mode)" value={pct(t.precision)}
            note={`Base rate ${pct(t.base_rate, 1)}; flags ${pct(t.flagged_share)} of PRs`} />
          <StatTile label="PR-AUC" value={t.pr_auc.toFixed(3)} note={`Random would score ${t.base_rate.toFixed(3)}`} />
          <StatTile label="Pull requests" value={compact(d.dataset.prs)} note={`${d.dataset.split_sizes.test.toLocaleString()} in the test split`} />
          <StatTile label="Repositories" value={d.dataset.repos} note="Public, squash-merge workflows" />
          <StatTile label="Defect-inducing" value={pct(d.dataset.defect_rate, 1)} note="Share of PRs a later fix traced to" />
          <StatTile label="Unseen repositories" value={d.cross_project.roc_auc_mean.toFixed(3)}
            note={`ROC-AUC, leave-repos-out (±${d.cross_project.roc_auc_std.toFixed(3)})`} />
        </div>
      </section>

      <section className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>ROC curve</h2></div>
          <p className="card-sub">Test split: the newest 20% of PRs in every repository, never seen during training or tuning.</p>
          <RocChart metrics={d} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Precision vs recall</h2></div>
          <p className="card-sub">Dots are the two operating thresholds, both fixed on the validation split: balanced (max F1, filled) and high recall (hollow).</p>
          <PrCurveChart metrics={d} />
        </div>
      </section>

      <section className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>What drives risk</h2></div>
          <p className="card-sub">Mean absolute SHAP value over the test split (top 12 of {d.dataset.features}).</p>
          <ImportanceChart metrics={d} />
        </div>
        <div className="card">
          <div className="card-head"><h2>Against baselines</h2></div>
          <p className="card-sub">Same test split, same labels.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Model</th><th className="num">ROC-AUC</th><th className="num">PR-AUC</th></tr></thead>
              <tbody>
                <tr><td>Random</td><td className="num">0.500</td><td className="num">{t.base_rate.toFixed(3)}</td></tr>
                <tr><td>Lines changed (bigger = riskier)</td><td className="num">{d.baselines.size_only_roc_auc.toFixed(3)}</td><td className="num">{d.baselines.size_only_pr_auc.toFixed(3)}</td></tr>
                <tr><td>Logistic regression, same {d.dataset.features} features</td><td className="num">{d.baselines.logistic_regression_roc_auc.toFixed(3)}</td><td className="num">{d.baselines.logistic_regression_pr_auc.toFixed(3)}</td></tr>
                <tr><td><b>XGBoost, {d.dataset.features} features</b></td><td className="num"><b>{t.roc_auc.toFixed(3)}</b></td><td className="num"><b>{t.pr_auc.toFixed(3)}</b></td></tr>
              </tbody>
            </table>
          </div>
          <h3 style={{ margin: "18px 0 8px" }}>Two operating modes</h3>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Mode (threshold set on validation)</th><th className="num">Caught</th><th className="num">Precision</th><th className="num">PRs flagged</th></tr></thead>
              <tbody>
                <tr><td>Balanced (max F1)</td><td className="num">{pct(t.recall)}</td><td className="num">{pct(t.precision)}</td><td className="num">{pct(t.flagged_share)}</td></tr>
                {d.high_recall && (
                  <tr><td>High recall (≥{pct(d.high_recall.target_recall)} on validation)</td><td className="num">{pct(d.high_recall.test.recall)}</td><td className="num">{pct(d.high_recall.test.precision)}</td><td className="num">{pct(d.high_recall.test.flagged_share)}</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <h3 style={{ margin: "18px 0 8px" }}>Effort-aware view</h3>
          <p className="muted small">
            Reviewing only the riskiest 20% of PRs would have covered <b style={{ color: "var(--ink)" }}>{pct(t.recall_at_top20pct)}</b> of
            the defect-inducing ones; among the riskiest 10%, <b style={{ color: "var(--ink)" }}>{pct(t.precision_at_top10pct)}</b> were defect-inducing
            ({(t.precision_at_top10pct / t.base_rate).toFixed(1)}× the base rate).
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h2>What drives risk in flagged PRs</h2><Link to="/drivers" className="small">All drivers and populations →</Link></div>
        <p className="card-sub">
          Average share of each flagged test PR's risk (from SHAP), and the fix to apply when that driver is present.
        </p>
        {drivers.error && <ErrorNote message={drivers.error} />}
        {drivers.data ? (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Driver</th><th className="num">Avg share of risk</th><th className="num">#1 driver in</th><th>Recommended fix</th></tr></thead>
              <tbody>
                {drivers.data.drivers.slice(0, 6).map((r) => (
                  <tr key={r.feature}>
                    <td><b>{r.label}</b></td>
                    <td className="num"><span className="share-pill">{r.mean_share.toFixed(1)}%</span></td>
                    <td className="num">{r.prs_top1 > 0 ? <Link to={`/prs?factor=${r.feature}`}>{r.prs_top1} {r.prs_top1 === 1 ? "PR" : "PRs"}</Link> : "–"}</td>
                    <td><div className="rec" style={{ display: "flex", gap: 8 }}><span style={{ color: "var(--good-ink)", flex: "none", marginTop: 2 }}><CheckIcon /></span>{r.recommendation}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !drivers.error && <Loading />}
      </section>

      <section className="card">
        <div className="card-head"><h2>Repositories</h2><span className="muted small">Click a row to explore its PRs</span></div>
        <p className="card-sub">Defect rate is over all mined PRs; test columns cover each repository's newest 20%.</p>
        {repos.error && <ErrorNote message={repos.error} />}
        {repos.data ? (
          <div className="table-wrap" style={{ maxHeight: 520 }}>
            <table>
              <thead><tr><th>Repository</th><th className="num">PRs</th><th>Merged</th><th className="num">Defect rate</th><th className="num">Test PRs</th><th className="num">Test AUC</th><th className="num">Test recall</th></tr></thead>
              <tbody>
                {repos.data.map((r) => (
                  <tr key={r.repo} className="clickable" onClick={() => navigate(`/prs?repo=${encodeURIComponent(r.repo)}`)}>
                    <td><Link to={`/prs?repo=${encodeURIComponent(r.repo)}`} onClick={(e) => e.stopPropagation()}>{r.repo}</Link></td>
                    <td className="num">{r.prs}</td>
                    <td className="muted small" style={{ whiteSpace: "nowrap" }}>{r.first_merged.slice(0, 7)} → {r.last_merged.slice(0, 7)}</td>
                    <td className="num">{pct(r.defect_rate, 1)}</td>
                    <td className="num">{r.test?.test_prs ?? "–"}</td>
                    <td className="num">{r.test?.roc_auc != null ? r.test.roc_auc.toFixed(2) : "–"}</td>
                    <td className="num">{r.test && r.test.test_positives ? pct(r.test.recall) : "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : !repos.error && <Loading />}
      </section>
    </div>
  );
}
