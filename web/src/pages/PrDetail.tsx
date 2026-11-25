import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { date, fixLinks, outcomeLabel } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { ScorePanel } from "../components/ScorePanel";
import { ErrorNote, Loading, OutcomeBadge } from "../components/ui";

export default function PrDetail() {
  const { owner = "", name = "", number = "0" } = useParams();
  const repo = `${owner}/${name}`;
  const detail = useAsync(() => api.pr(repo, Number(number)), [repo, number]);
  const metrics = useAsync(api.metrics, []);

  if (detail.error) return <ErrorNote message={detail.error} />;
  if (!detail.data || !metrics.data) return <Loading label="Scoring pull request" />;
  const { pr, features, score, context } = detail.data;
  const fixes = fixLinks(pr.repo, pr.fixed_by);

  const outcome = (
    <div className="card">
      <div className="card-head"><h3>What actually happened</h3><OutcomeBadge label={pr.label} /></div>
      <p className="small" style={{ color: "var(--ink-2)", marginTop: 6 }}>{outcomeLabel[pr.outcome]}.</p>
      {fixes.length > 0 ? (
        <p className="small" style={{ marginTop: 8 }}>
          Later bug fix{fixes.length > 1 ? "es" : ""} changed lines this PR wrote:{" "}
          {fixes.map((l, i) => <span key={l.href}>{i > 0 && ", "}<a href={l.href} target="_blank" rel="noreferrer">{l.label}</a></span>)}
        </p>
      ) : (
        <p className="muted small" style={{ marginTop: 8 }}>No later bug fix was traced to this PR's lines.</p>
      )}
      <p className="muted small" style={{ marginTop: 8 }}>
        This PR is in the <b>{pr.split}</b> split{pr.split === "test" ? ", so the model never saw its outcome" : ", so the model was fitted on its outcome"}.
      </p>
    </div>
  );

  return (
    <div>
      <div className="page-head">
        <div className="small"><Link to={`/prs?repo=${encodeURIComponent(pr.repo)}`}>{pr.repo}</Link> · <a href={pr.url} target="_blank" rel="noreferrer">#{pr.number} on GitHub ↗</a></div>
        <h1>{pr.title}</h1>
        <p className="muted small">Merged {date(pr.merged_at)}{context.top_files.length > 0 && <> · largest changes in {context.top_files.map((f, i) => <span key={f}>{i > 0 && ", "}<code>{f}</code></span>)}</>}</p>
      </div>
      <ScorePanel score={score} features={features} specs={metrics.data.feature_specs} threshold={metrics.data.threshold} aside={outcome} />
    </div>
  );
}
