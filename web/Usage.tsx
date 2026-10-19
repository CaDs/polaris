import { useEffect, useState } from "react";
import { Loading, api, cost, fmt, hitRate, useApi } from "./ui.tsx";

type Row = { runs: number; tokens_in: number; tokens_out: number; tokens_cached: number; cost_usd: number };
type Usage = {
  totals: Row;
  days: (Row & { day: string })[];
  models: (Row & { model: string })[];
  tickets: (Row & { id: string; key: string; title: string })[];
};

// "In" is uncached prompt tokens (incl. cache writes), "Cached" cache reads; the bar is the cache hit rate.
function Cells({ r }: { r: Row }) {
  const share = r.tokens_in + r.tokens_cached ? (100 * r.tokens_cached) / (r.tokens_in + r.tokens_cached) : 0;
  return (
    <>
      <td>{r.runs}</td><td>{fmt(r.tokens_in)}</td><td>{fmt(r.tokens_out)}</td><td>{fmt(r.tokens_cached)}</td>
      <td><span className="bar" aria-hidden="true"><span style={{ width: `${share}%` }} /></span> {hitRate(r.tokens_in, r.tokens_cached)}</td>
      <td>{cost(r.cost_usd)}</td>
    </>
  );
}

function Table({ label, first, rows }: { label: string; first: string; rows: { key: string; cell: React.ReactNode; row: Row }[] }) {
  return (
    <section aria-label={label}>
      <h3>{label}</h3>
      <div className="table-wrap">
        <table>
          <thead><tr><th>{first}</th><th>Runs</th><th>In</th><th>Out</th><th>Cached</th><th>Cache hit</th><th>Cost</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={r.key}><td>{r.cell}</td><Cells r={r.row} /></tr>)}
            {rows.length === 0 && <tr><td colSpan={7} className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// GET /api/metrics: one row per UTC day × model. stuck is a subset of failed; measured = runs with a run_metrics event;
// the sums let the table aggregate days exactly.
type MetricsRow = {
  day: string; model: string; runs: number; passed: number; failed: number; cancelled: number; stuck: number; measured: number;
  sum_turns_pct: number; tool_calls: number; tool_errors: number; mean_files_changed: number | null;
};
type Count = "runs" | "passed" | "failed" | "cancelled" | "stuck" | "measured" | "sum_turns_pct" | "tool_calls" | "tool_errors";
const sum = (rows: MetricsRow[], k: Count) => rows.reduce((a, r) => a + r[k], 0);
const ratio = (a: number, b: number) => (b ? a / b : null);
const pctText = (n: number | null, digits = 0) => (n === null ? "—" : `${n.toFixed(digits)}%`);
const STATUSES = ["passed", "failed", "stuck", "cancelled"] as const;

// Runs by status per day (stacked bars, failed excludes stuck), then quality per model.
function Runs() {
  const { data, error } = useApi<{ rows: MetricsRow[] }>("/api/metrics?days=14");
  if (!data) return <section aria-label="Runs"><h3>Runs</h3><Loading error={error} /></section>;
  const days = Array.from({ length: 14 }, (_, i) => new Date(Date.now() - (13 - i) * 86_400_000).toISOString().slice(0, 10));
  const perDay = days.map((day) => {
    const rows = data.rows.filter((d) => d.day === day);
    const stuck = sum(rows, "stuck");
    return { day, passed: sum(rows, "passed"), failed: sum(rows, "failed") - stuck, stuck, cancelled: sum(rows, "cancelled") };
  });
  const max = Math.max(1, ...perDay.map((d) => d.passed + d.failed + d.stuck + d.cancelled));
  const models = [...Map.groupBy(data.rows, (d) => d.model)];
  return (
    <section aria-label="Runs">
      <h3>Runs <span className="muted">last 14 days</span></h3>
      <div className="spark" role="img" aria-label="Runs per day by status, last 14 days">
        {perDay.map((d) => (
          <div key={d.day} title={`${d.day}: ${STATUSES.map((s) => `${d[s]} ${s}`).join(", ")}`}>
            {STATUSES.map((s) => d[s] > 0 && <span key={s} className={s} style={{ height: `${(90 * d[s]) / max}%` }} />)}
          </div>
        ))}
      </div>
      <p className="legend muted">
        <span className="mono">{days[0]}</span> – <span className="mono">{days[13]}</span>
        {STATUSES.map((s) => <span key={s}><i className={s} /> {s}</span>)}
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Model</th><th>Runs</th><th>Pass rate</th><th>Stuck</th><th>Mean turns</th><th>Tool errors</th><th>Mean files</th></tr></thead>
          <tbody>
            {models.map(([model, rows]) => {
              const runs = sum(rows, "runs");
              const withFiles = rows.filter((r) => r.mean_files_changed !== null);
              const files = ratio(withFiles.reduce((a, r) => a + r.mean_files_changed! * r.measured, 0), sum(withFiles, "measured"));
              const errors = ratio(sum(rows, "tool_errors"), sum(rows, "tool_calls"));
              const turns = ratio(sum(rows, "sum_turns_pct"), sum(rows, "measured"));
              const pass = ratio(100 * sum(rows, "passed"), sum(rows, "passed") + sum(rows, "failed")); // cancelled runs are neither
              return (
                <tr key={model}>
                  <td className="mono">{model}</td><td>{runs}</td><td>{pctText(pass)}</td><td>{sum(rows, "stuck")}</td>
                  <td>{pctText(turns)}</td><td>{pctText(errors === null ? null : 100 * errors, 1)}</td><td>{files === null ? "—" : files.toFixed(1)}</td>
                </tr>
              );
            })}
            {models.length === 0 && <tr><td colSpan={7} className="muted">No runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function UsagePage() {
  const [u, setU] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void api<Usage>("/api/usage").then(setU, (e) => setError(e.message)), []);
  if (!u) return <Loading error={error} />;
  const t = u.totals;
  const stats: [string, string][] = [
    ["Tokens in", fmt(t.tokens_in)], ["Tokens out", fmt(t.tokens_out)], ["Cached", fmt(t.tokens_cached)],
    ["Cost", cost(t.cost_usd)], ["Cache hit rate", hitRate(t.tokens_in, t.tokens_cached)],
  ];
  return (
    <div className="usage">
      <section className="stats" aria-label="Totals">
        {stats.map(([k, v]) => <div key={k}><span className="muted">{k}</span><strong>{v}</strong></div>)}
      </section>
      <Runs />
      <Table label="Per day" first="Day (UTC)" rows={u.days.map((d) => ({ key: d.day, cell: <span className="mono">{d.day}</span>, row: d }))} />
      <Table label="Per model" first="Model" rows={u.models.map((m) => ({ key: m.model, cell: <span className="mono">{m.model}</span>, row: m }))} />
      <Table label="Top tickets" first="Ticket" rows={u.tickets.map((k) => ({ key: k.id, cell: <><span className="mono">{k.key}</span> {k.title}</>, row: k }))} />
    </div>
  );
}
