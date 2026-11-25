import { Link, useSearchParams } from "react-router-dom";
import { api, type Population } from "../lib/api";
import { num, pct } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { DriversChart } from "../components/charts";
import { CheckIcon, ErrorNote, Loading } from "../components/ui";

const POPULATIONS: { v: Population; label: string; help: string }[] = [
  { v: "flagged", label: "Flagged PRs", help: "PRs the model flags for extra review (balanced mode)" },
  { v: "defects", label: "Defect-causing PRs", help: "PRs a later bug fix was traced back to" },
  { v: "caught", label: "Caught", help: "Defect-causing PRs the model flagged" },
  { v: "missed", label: "Missed", help: "Defect-causing PRs the model did not flag" },
  { v: "all", label: "All PRs", help: "Every PR in the split" },
];

export default function Drivers() {
  const [params, setParams] = useSearchParams();
  const population = (params.get("population") ?? "flagged") as Population;
  const repo = params.get("repo") ?? "";
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };
  const repos = useAsync(api.repos, []);
  const d = useAsync(() => api.drivers(population, repo || undefined), [population, repo]);
  const active = POPULATIONS.find((p) => p.v === population)!;

  return (
    <div>
      <div className="page-head">
        <h1>Risk drivers</h1>
        <p>
          For every PR, SHAP splits the model's risk estimate into per-feature contributions. Here those contributions
          are added up across a group of affected PRs: what share of their risk each feature accounts for on average,
          how often it is the single biggest driver, and what to do when it is. Numbers cover the held-out test split.
        </p>
      </div>

      <div className="filters">
        <div className="seg" role="group" aria-label="Which PRs">
          {POPULATIONS.map((p) => (
            <button key={p.v} aria-pressed={population === p.v} title={p.help} onClick={() => set("population", p.v === "flagged" ? "" : p.v)}>
              {p.label}
            </button>
          ))}
        </div>
        <select aria-label="Repository" value={repo} onChange={(e) => set("repo", e.target.value)}>
          <option value="">All repositories</option>
          {repos.data?.map((r) => <option key={r.repo} value={r.repo}>{r.repo}</option>)}
        </select>
      </div>

      {d.error && <ErrorNote message={d.error} />}
      {!d.data && !d.error && <Loading label="Aggregating SHAP values" />}
      {d.data && (d.data.prs === 0 ? (
        <p className="muted">No PRs in this group.</p>
      ) : (
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>{active.label}: average share of risk by feature</h2>
            </div>
            <p className="card-sub">
              {d.data.prs.toLocaleString()} PRs{d.data.defect_rate !== null && ` · ${pct(d.data.defect_rate, 1)} actually defect-causing`}.
              Each bar is the mean, across these PRs, of the feature's share of everything pushing a PR's risk up.
            </p>
            <DriversChart drivers={d.data.drivers} />
          </div>

          <div className="card">
            <div className="card-head"><h2>What to do about each driver</h2></div>
            <p className="card-sub">Sorted by average share of risk. "Typical value" is the median among these PRs, next to the median across all training PRs.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Driver</th>
                    <th className="num">Avg share of risk</th>
                    <th className="num">#1 driver in</th>
                    <th className="num">In top 3 for</th>
                    <th className="num">Typical value</th>
                    <th>Recommended fix</th>
                  </tr>
                </thead>
                <tbody>
                  {d.data.drivers.map((r) => (
                    <tr key={r.feature}>
                      <td>
                        <div className="driver-cell">
                          <b>{r.label}</b>
                          <span className="sub">{r.description}</span>
                        </div>
                      </td>
                      <td className="num"><span className="share-pill">{r.mean_share.toFixed(1)}%</span></td>
                      <td className="num">
                        {r.prs_top1 > 0 ? (
                          <Link to={`/prs?factor=${r.feature}${repo ? `&repo=${encodeURIComponent(repo)}` : ""}`}>{r.prs_top1.toLocaleString()} {r.prs_top1 === 1 ? "PR" : "PRs"}</Link>
                        ) : "–"}
                      </td>
                      <td className="num">{r.prs_top3.toLocaleString()} {r.prs_top3 === 1 ? "PR" : "PRs"}</td>
                      <td className="num">{num(r.median_value)} <span className="muted small">vs {num(r.dataset_median)}</span></td>
                      <td><div className="rec" style={{ display: "flex", gap: 8 }}><span style={{ color: "var(--good-ink)", flex: "none", marginTop: 2 }}><CheckIcon /></span>{r.recommendation}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
