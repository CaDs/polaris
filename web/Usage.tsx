import { useEffect, useState } from "react";
import { api, cost, fmt, hitRate } from "./ui.tsx";

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

export function UsagePage() {
  const [u, setU] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void api<Usage>("/api/usage").then(setU, (e) => setError(e.message)), []);
  if (!u) return <p className="muted pad">{error || "Loading…"}</p>;
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
      <Table label="Per day" first="Day (UTC)" rows={u.days.map((d) => ({ key: d.day, cell: <span className="mono">{d.day}</span>, row: d }))} />
      <Table label="Per model" first="Model" rows={u.models.map((m) => ({ key: m.model, cell: <span className="mono">{m.model}</span>, row: m }))} />
      <Table label="Top tickets" first="Ticket" rows={u.tickets.map((k) => ({ key: k.id, cell: <><span className="mono">{k.key}</span> {k.title}</>, row: k }))} />
    </div>
  );
}
