import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip,
  XAxis, YAxis, LabelList,
} from "recharts";
import type { Driver, FeatureSpec, Metrics } from "../lib/api";
import { num, pct } from "../lib/format";
import { useChartColors } from "../lib/theme";

/** Bar-end label drawn as plain SVG text: recharts' default wraps it to the bar's width on short bars. */
function endLabel(fill: string, format: (v: number, i: number) => string) {
  return (props: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown; index?: number }) => {
    const x = Number(props.x ?? 0), w = Number(props.width ?? 0), y = Number(props.y ?? 0), h = Number(props.height ?? 0);
    const v = Number(props.value ?? 0);
    const left = Math.min(x, x + w), right = Math.max(x, x + w);
    return (
      <text x={v < 0 ? left - 6 : right + 6} y={y + h / 2} dominantBaseline="central" textAnchor={v < 0 ? "end" : "start"}
        fill={fill} fontSize={12} style={{ fontVariantNumeric: "tabular-nums" }}>
        {format(v, props.index ?? 0)}
      </text>
    );
  };
}

const axisProps = (c: ReturnType<typeof useChartColors>) => ({
  stroke: c["--axis"],
  tickLine: false,
  tick: { fill: c["--muted"], fontSize: 12 },
});

/** Step-interpolate a monotone curve onto a fixed x grid so two curves share one tooltip. */
function onGrid(points: [number, number][], xs: number[]): number[] {
  const out: number[] = [];
  let j = 0;
  for (const x of xs) {
    while (j + 1 < points.length && points[j + 1][0] <= x) j++;
    const [x0, y0] = points[j];
    const next = points[j + 1];
    if (!next || next[0] === x0) out.push(y0);
    else out.push(y0 + ((next[1] - y0) * (x - x0)) / (next[0] - x0));
  }
  return out;
}

export function RocChart({ metrics }: { metrics: Metrics }) {
  const c = useChartColors();
  const xs = Array.from({ length: 101 }, (_, i) => i / 100);
  const model = onGrid(metrics.curves.roc, xs);
  const size = onGrid(metrics.curves.roc_size_only, xs);
  const data = xs.map((x, i) => ({ fpr: x, model: model[i], size: size[i] }));
  const op = metrics.curves.operating_point;
  const hr = metrics.curves.operating_point_high_recall;
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
          <CartesianGrid stroke={c["--grid"]} vertical={false} />
          <XAxis dataKey="fpr" type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} {...axisProps(c)}
            tickFormatter={(v) => pct(v)} label={{ value: "False-positive rate", position: "insideBottom", offset: -10, fill: c["--muted"], fontSize: 12 }} />
          <YAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} {...axisProps(c)} tickFormatter={(v) => pct(v)} width={44} />
          <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke={c["--axis"]} strokeWidth={1} ifOverflow="hidden" />
          <Tooltip cursor={{ stroke: c["--axis"], strokeWidth: 1 }} content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="tooltip">
                <div className="t">False-positive rate {pct(payload[0].payload.fpr)}</div>
                <div className="r">XGBoost recall {pct(payload[0].payload.model, 1)}</div>
                <div className="r">Size-only recall {pct(payload[0].payload.size, 1)}</div>
              </div>
            ) : null} />
          <Line dataKey="size" stroke={c["--series-2"]} strokeWidth={2} dot={false} isAnimationActive={false} name="Size only" />
          <Line dataKey="model" stroke={c["--series-1"]} strokeWidth={2} dot={false} isAnimationActive={false} name="XGBoost"
            activeDot={{ r: 5, stroke: c["--surface"], strokeWidth: 2 }} />
          <ReferenceDot x={op.fpr} y={op.recall} r={5} fill={c["--series-1"]} stroke={c["--surface"]} strokeWidth={2}
            label={{ value: `Balanced: ${pct(op.recall)} caught`, position: "right", fill: c["--ink-2"], fontSize: 12 }} />
          {hr && (
            <ReferenceDot x={hr.fpr} y={hr.recall} r={5} fill={c["--surface"]} stroke={c["--series-1"]} strokeWidth={2}
              label={{ value: `High recall: ${pct(hr.recall)} caught`, position: "right", fill: c["--ink-2"], fontSize: 12 }} />
          )}
        </LineChart>
      </ResponsiveContainer>
      <div className="legend">
        <span><span className="key" style={{ background: c["--series-1"] }} />XGBoost · AUC {metrics.test.roc_auc.toFixed(3)}</span>
        <span><span className="key" style={{ background: c["--series-2"] }} />Lines changed only · AUC {metrics.baselines.size_only_roc_auc.toFixed(3)}</span>
        <span><span className="key" style={{ background: c["--axis"], height: 1 }} />Chance</span>
      </div>
      <details className="table-view">
        <summary>Table view</summary>
        <div className="table-wrap"><table><thead><tr><th className="num">FPR</th><th className="num">XGBoost TPR</th><th className="num">Size-only TPR</th></tr></thead>
          <tbody>{data.filter((_, i) => i % 10 === 0).map((d) => <tr key={d.fpr}><td className="num">{pct(d.fpr)}</td><td className="num">{pct(d.model, 1)}</td><td className="num">{pct(d.size, 1)}</td></tr>)}</tbody></table></div>
      </details>
    </div>
  );
}

export function PrCurveChart({ metrics }: { metrics: Metrics }) {
  const c = useChartColors();
  const data = metrics.curves.pr.map(([recall, precision]) => ({ recall, precision }));
  const op = metrics.curves.operating_point;
  const hr = metrics.curves.operating_point_high_recall;
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 18, left: 0 }}>
          <CartesianGrid stroke={c["--grid"]} vertical={false} />
          <XAxis dataKey="recall" type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} {...axisProps(c)}
            tickFormatter={(v) => pct(v)} label={{ value: "Recall (defect-inducing PRs caught)", position: "insideBottom", offset: -10, fill: c["--muted"], fontSize: 12 }} />
          <YAxis type="number" domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} {...axisProps(c)} tickFormatter={(v) => pct(v)} width={44} />
          <ReferenceLine y={metrics.test.base_rate} stroke={c["--axis"]} strokeWidth={1}
            label={{ value: `Base rate ${pct(metrics.test.base_rate, 1)}`, position: "insideTopRight", fill: c["--muted"], fontSize: 12 }} />
          <Tooltip cursor={{ stroke: c["--axis"], strokeWidth: 1 }} content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="tooltip">
                <div className="t">Recall {pct(payload[0].payload.recall, 1)}</div>
                <div className="r">Precision {pct(payload[0].payload.precision, 1)}</div>
              </div>
            ) : null} />
          <Line dataKey="precision" stroke={c["--series-1"]} strokeWidth={2} dot={false} isAnimationActive={false}
            activeDot={{ r: 5, stroke: c["--surface"], strokeWidth: 2 }} />
          <ReferenceDot x={op.recall} y={op.precision} r={5} fill={c["--series-1"]} stroke={c["--surface"]} strokeWidth={2}
            label={{ value: `Balanced: ${pct(op.precision)} precision`, position: "top", fill: c["--ink-2"], fontSize: 12 }} />
          {hr && (
            <ReferenceDot x={hr.recall} y={hr.precision} r={5} fill={c["--surface"]} stroke={c["--series-1"]} strokeWidth={2}
              label={{ value: `High recall: ${pct(hr.precision)}`, position: "bottom", fill: c["--ink-2"], fontSize: 12 }} />
          )}
        </LineChart>
      </ResponsiveContainer>
      <details className="table-view">
        <summary>Table view</summary>
        <div className="table-wrap"><table><thead><tr><th className="num">Recall</th><th className="num">Precision</th></tr></thead>
          <tbody>{data.filter((_, i) => i % 8 === 0).map((d, i) => <tr key={i}><td className="num">{pct(d.recall, 1)}</td><td className="num">{pct(d.precision, 1)}</td></tr>)}</tbody></table></div>
      </details>
    </div>
  );
}

export function ImportanceChart({ metrics, top = 12 }: { metrics: Metrics; top?: number }) {
  const c = useChartColors();
  const specs = Object.fromEntries(metrics.feature_specs.map((f) => [f.name, f]));
  const data = metrics.importance.slice(0, top).map((r) => ({ ...r, label: specs[r.feature]?.label ?? r.feature }));
  const rowH = 30;
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={data.length * rowH + 24}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 48, bottom: 0, left: 0 }} barCategoryGap={8}>
          <CartesianGrid stroke={c["--grid"]} horizontal={false} />
          <XAxis type="number" {...axisProps(c)} tickFormatter={(v) => v.toFixed(2)} />
          <YAxis type="category" dataKey="label" width={190} {...axisProps(c)} tick={{ fill: c["--ink-2"], fontSize: 12.5 }} />
          <Tooltip cursor={{ fill: c["--wash-1"] }} content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="tooltip">
                <div className="t">{payload[0].payload.label}</div>
                <div className="r">Mean |SHAP| {Number(payload[0].payload.mean_abs_shap).toFixed(3)} (log-odds)</div>
                <div className="r">{specs[payload[0].payload.feature]?.description}</div>
              </div>
            ) : null} />
          <Bar dataKey="mean_abs_shap" fill={c["--series-1"]} radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}>
            <LabelList dataKey="mean_abs_shap" content={endLabel(c["--ink-2"], (v) => v.toFixed(3))} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ShapChart({ contributions, values, specs, shares = {}, top = 12 }: {
  contributions: Record<string, number>;
  values: Record<string, number | null>;
  shares?: Record<string, number>;
  specs: FeatureSpec[];
  top?: number;
}) {
  const c = useChartColors();
  const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
  const data = Object.entries(contributions)
    .filter(([, v]) => Math.abs(v) > 1e-6)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, top)
    .map(([name, v]) => ({
      name, v, label: `${byName[name]?.label ?? name} = ${num(values[name])}`,
      tag: v > 0 && shares[name] ? `+${v.toFixed(2)} · ${shares[name].toFixed(0)}%` : v > 0 ? `+${v.toFixed(2)}` : v.toFixed(2),
    }));
  if (!data.length) return <p className="muted small">No feature moved this score away from the baseline.</p>;
  const rowH = 30;
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={data.length * rowH + 24}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 96, bottom: 0, left: 0 }} barCategoryGap={8}>
          <CartesianGrid stroke={c["--grid"]} horizontal={false} />
          <XAxis type="number" {...axisProps(c)} tickFormatter={(v) => (v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1))} />
          <YAxis type="category" dataKey="label" width={260} {...axisProps(c)} tick={{ fill: c["--ink-2"], fontSize: 12 }} />
          <ReferenceLine x={0} stroke={c["--axis"]} />
          <Tooltip cursor={{ fill: c["--wash-1"] }} content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="tooltip">
                <div className="t">{byName[payload[0].payload.name]?.label}</div>
                <div className="r">Value {num(values[payload[0].payload.name])}</div>
                <div className="r">{payload[0].payload.v > 0 ? "Raises" : "Lowers"} risk by {Math.abs(payload[0].payload.v).toFixed(3)} log-odds</div>
                {payload[0].payload.v > 0 && shares[payload[0].payload.name] !== undefined && (
                  <div className="r">{shares[payload[0].payload.name].toFixed(1)}% of this PR's risk</div>
                )}
              </div>
            ) : null} />
          <Bar dataKey="v" radius={4} maxBarSize={18} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.name} fill={d.v > 0 ? c["--risk-up"] : c["--risk-down"]} />)}
            <LabelList dataKey="v" content={endLabel(c["--ink-2"], (_, i) => data[i]?.tag ?? "")} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      <div className="legend">
        <span><span className="key sq" style={{ background: c["--risk-up"] }} />Raises risk</span>
        <span><span className="key sq" style={{ background: c["--risk-down"] }} />Lowers risk</span>
        <span className="muted">SHAP values in log-odds (they sum with the baseline to the model's output); % = share of this PR's risk.</span>
      </div>
    </div>
  );
}

const SLOTS = ["--series-1", "--series-2", "--series-3", "--series-4", "--series-5"] as const;

/** One PR's risk as a whole (100%), split into its largest drivers plus "Other". Tall segmented bar. */
export function RiskComposition({ shares, specs, top = 5 }: {
  shares: Record<string, number>;
  specs: FeatureSpec[];
  top?: number;
}) {
  const c = useChartColors();
  const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
  const entries = Object.entries(shares).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <p className="muted small">No feature raises this PR's risk above the baseline.</p>;
  const head = entries.slice(0, top);
  const rest = entries.slice(top).reduce((s, [, v]) => s + v, 0);
  const parts = head.map(([name, v], i) => ({ name, label: byName[name]?.label ?? name, v, color: c[SLOTS[i]], dark: i === 3, ink: false }));
  if (rest >= 0.5) parts.push({ name: "other", label: `Other (${entries.length - top} features)`, v: rest, color: c["--axis"], dark: false, ink: true });
  return (
    <div>
      <div className="composition" role="img"
        aria-label={`Risk composition: ${parts.map((p) => `${p.label} ${p.v.toFixed(0)}%`).join(", ")}`}>
        {parts.map((p) => (
          <div key={p.name} className={`seg${p.dark ? " dark-text" : ""}${p.ink ? " ink-text" : ""}`} style={{ flex: `${p.v} 1 0`, background: p.color }}
            title={`${p.label}: ${p.v.toFixed(1)}% of this PR's risk`}>
            {p.v >= 9 ? `${Math.round(p.v)}%` : ""}
          </div>
        ))}
      </div>
      <div className="composition-legend">
        {parts.map((p) => (
          <span key={p.name}><span className="sw" style={{ background: p.color }} />{p.label} <b className="share-pill">{p.v.toFixed(0)}%</b></span>
        ))}
      </div>
    </div>
  );
}

/** Average share of risk each feature carries across a population of PRs. Single series. */
export function DriversChart({ drivers, top = 12 }: { drivers: Driver[]; top?: number }) {
  const c = useChartColors();
  const data = drivers.slice(0, top).map((d) => ({ ...d, v: d.mean_share }));
  const rowH = 30;
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={data.length * rowH + 24}>
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 52, bottom: 0, left: 0 }} barCategoryGap={8}>
          <CartesianGrid stroke={c["--grid"]} horizontal={false} />
          <XAxis type="number" {...axisProps(c)} tickFormatter={(v) => `${v}%`} />
          <YAxis type="category" dataKey="label" width={210} {...axisProps(c)} tick={{ fill: c["--ink-2"], fontSize: 12.5 }} />
          <Tooltip cursor={{ fill: c["--wash-1"] }} content={({ active, payload }) =>
            active && payload?.length ? (
              <div className="tooltip">
                <div className="t">{payload[0].payload.label}</div>
                <div className="r">{Number(payload[0].payload.mean_share).toFixed(1)}% of these PRs' risk on average</div>
                <div className="r">#1 driver for {payload[0].payload.prs_top1} PRs, top 3 for {payload[0].payload.prs_top3}</div>
              </div>
            ) : null} />
          <Bar dataKey="v" fill={c["--series-1"]} radius={[0, 4, 4, 0]} maxBarSize={18} isAnimationActive={false}>
            <LabelList dataKey="v" content={endLabel(c["--ink-2"], (v) => `${v.toFixed(1)}%`)} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
