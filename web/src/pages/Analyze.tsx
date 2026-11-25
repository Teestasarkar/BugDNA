import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type AnalyzeResult } from "../lib/api";
import { date } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { ScorePanel } from "../components/ScorePanel";
import { ErrorNote } from "../components/ui";

const EXAMPLES = [
  "https://github.com/fastify/fastify/pull/7217",
  "https://github.com/tokio-rs/tokio/pull/8826",
  "https://github.com/facebook/react/pull/38368",
];

export default function Analyze() {
  const [params, setParams] = useSearchParams();
  const [url, setUrl] = useState(params.get("url") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const metrics = useAsync(api.metrics, []);

  async function run(target: string) {
    setBusy(true);
    setError(null);
    setResult(null);
    setParams(target ? { url: target } : {}, { replace: true });
    try {
      setResult(await api.analyze(target));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // A shared /analyze?url=... link runs once on arrival.
  const started = useRef(false);
  useEffect(() => {
    const initial = params.get("url");
    if (initial && !started.current) {
      started.current = true;  // StrictMode mounts twice in development
      run(initial);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (url.trim()) run(url.trim());
  };

  return (
    <div>
      <div className="page-head">
        <h1>Analyze a pull request</h1>
        <p>
          Paste any public GitHub PR. The server reads its diff and the base branch's history through the GitHub API,
          computes the same 28 features with the same code used in training, and explains the score. Open PRs are
          scored as of now; merged PRs as of the moment before they merged.
        </p>
      </div>

      <form className="card" onSubmit={submit} style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo/pull/123"
          aria-label="Pull request URL" style={{ flex: "1 1 320px" }} />
        <button className="btn primary" disabled={busy} type="submit">
          {busy ? <><span className="spinner" aria-hidden="true" /> Analyzing</> : "Analyze"}
        </button>
        <div className="small muted" style={{ flexBasis: "100%" }}>
          Try:{" "}
          {EXAMPLES.map((ex, i) => (
            <span key={ex}>{i > 0 && " · "}<a href={`?url=${encodeURIComponent(ex)}`} onClick={(e) => { e.preventDefault(); setUrl(ex); run(ex); }}>{ex.replace("https://github.com/", "")}</a></span>
          ))}
        </div>
      </form>

      <div style={{ marginTop: 16 }} className="stack">
        {busy && <div className="callout" role="status">Reading the PR and up to 10 files' history from GitHub, about 20 API requests…</div>}
        {error && <ErrorNote message={error} />}
        {result && metrics.data && (
          <>
            <div className="page-head" style={{ marginBottom: 0 }}>
              <div className="small"><a href={result.pr.url} target="_blank" rel="noreferrer">{result.pr.repo} #{result.pr.number} ↗</a> · {result.pr.state} · by {result.pr.author ?? "unknown"}</div>
              <h2 style={{ fontSize: 22 }}>{result.pr.title}</h2>
              <p className="muted small">
                Scored as of {date(result.pr.scored_as_of)} against <code>{result.pr.base}</code> · {result.github.requests} GitHub requests
                {result.cached ? " (cached)" : ""}{result.github.rate_remaining !== null && ` · ${result.github.rate_remaining} left this hour`}
              </p>
            </div>
            {result.warnings.map((w) => <div key={w} className="callout warn">{w}</div>)}
            <ScorePanel score={result.score} features={result.features} specs={metrics.data.feature_specs} threshold={metrics.data.threshold} />
          </>
        )}
      </div>
    </div>
  );
}
