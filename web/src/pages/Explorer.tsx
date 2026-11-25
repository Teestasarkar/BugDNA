import { useNavigate, useSearchParams, Link } from "react-router-dom";
import { api, type Band, type Outcome } from "../lib/api";
import { date, fixLinks, outcomeLabel } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { BandBadge, ErrorNote, Loading, MiniMeter, OutcomeBadge } from "../components/ui";

const PAGE = 50;
const OUTCOMES: { v: Outcome | "all"; label: string }[] = [
  { v: "all", label: "All" },
  { v: "tp", label: "Caught" },
  { v: "fn", label: "Missed" },
  { v: "fp", label: "False alarm" },
  { v: "tn", label: "Clean" },
];

export default function Explorer() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const repo = params.get("repo") ?? "";
  const split = params.get("split") ?? "test";
  const outcome = (params.get("outcome") ?? "all") as Outcome | "all";
  const band = (params.get("band") ?? "all") as Band | "all";
  const q = params.get("q") ?? "";
  const sort = params.get("sort") ?? "prob";
  const offset = Number(params.get("offset") ?? 0);

  const set = (patch: Record<string, string | number | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === "all") next.delete(k);
      else next.set(k, String(v));
    }
    if (!("offset" in patch)) next.delete("offset");
    setParams(next, { replace: true });
  };

  const repos = useAsync(api.repos, []);
  const list = useAsync(
    () => api.prs({ repo, split, outcome, band, q, sort, order: "desc", limit: PAGE, offset }),
    [repo, split, outcome, band, q, sort, offset],
  );

  return (
    <div>
      <div className="page-head">
        <h1>PR explorer</h1>
        <p>
          Every mined pull request with its risk score and what actually happened. "Fix traced" means SZZ found a later
          bug fix that changed lines this PR wrote. The test split is the model's honest track record; train and
          validation PRs are shown for context.
        </p>
      </div>

      <div className="filters">
        <select aria-label="Repository" value={repo} onChange={(e) => set({ repo: e.target.value })}>
          <option value="">All repositories</option>
          {repos.data?.map((r) => <option key={r.repo} value={r.repo}>{r.repo}</option>)}
        </select>
        <select aria-label="Split" value={split} onChange={(e) => set({ split: e.target.value === "test" ? null : e.target.value })}>
          <option value="test">Test split</option>
          <option value="val">Validation split</option>
          <option value="train">Training split</option>
          <option value="all">All splits</option>
        </select>
        <select aria-label="Risk band" value={band} onChange={(e) => set({ band: e.target.value })}>
          <option value="all">Any risk</option>
          <option value="HIGH">High risk (flagged)</option>
          <option value="MEDIUM">Medium</option>
          <option value="LOW">Low</option>
        </select>
        <select aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value === "prob" ? null : e.target.value })}>
          <option value="prob">Riskiest first</option>
          <option value="merged_at">Newest first</option>
        </select>
        <input type="search" placeholder="Search titles" defaultValue={q} aria-label="Search titles"
          onKeyDown={(e) => { if (e.key === "Enter") set({ q: (e.target as HTMLInputElement).value }); }}
          onBlur={(e) => { if (e.target.value !== q) set({ q: e.target.value }); }} />
      </div>
      <div className="filters">
        <div className="seg" role="group" aria-label="Outcome">
          {OUTCOMES.map((o) => (
            <button key={o.v} aria-pressed={outcome === o.v} onClick={() => set({ outcome: o.v })}
              title={o.v === "all" ? "All outcomes" : outcomeLabel[o.v]}>{o.label}</button>
          ))}
        </div>
      </div>

      {list.error && <ErrorNote message={list.error} />}
      {!list.data && !list.error && <Loading label="Loading pull requests" />}
      {list.data && (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Pull request</th><th>Risk score</th><th>Band</th><th>What happened</th><th>Merged</th></tr>
              </thead>
              <tbody>
                {list.data.items.map((p) => {
                  const href = `/prs/${p.repo}/${p.number}`;
                  return (
                    <tr key={`${p.repo}#${p.number}`} className="clickable" onClick={() => navigate(href)}>
                      <td className="title-cell">
                        <Link to={href} onClick={(e) => e.stopPropagation()}>{p.title}</Link>
                        <div className="sub">{p.repo} #{p.number}{split === "all" ? ` · ${p.split}` : ""}</div>
                      </td>
                      <td><MiniMeter value={p.percentile} band={p.band} /></td>
                      <td><BandBadge band={p.band} /></td>
                      <td>
                        <OutcomeBadge label={p.label} />
                        {p.label === 1 && (
                          <div className="sub small muted" style={{ marginTop: 4 }}>
                            fixed by {fixLinks(p.repo, p.fixed_by).slice(0, 3).map((l, i) => (
                              <span key={l.href}>{i > 0 && ", "}<a href={l.href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{l.label}</a></span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="muted small" style={{ whiteSpace: "nowrap" }}>{date(p.merged_at)}</td>
                    </tr>
                  );
                })}
                {list.data.items.length === 0 && (
                  <tr><td colSpan={5} className="muted">No pull requests match these filters.</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span>{list.data.total.toLocaleString()} PRs{list.data.total > 0 && ` · showing ${offset + 1}–${Math.min(offset + PAGE, list.data.total)}`}</span>
            <span className="row">
              <button className="btn" disabled={offset === 0} onClick={() => set({ offset: Math.max(0, offset - PAGE) })}>Previous</button>
              <button className="btn" disabled={offset + PAGE >= list.data.total} onClick={() => set({ offset: offset + PAGE })}>Next</button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
