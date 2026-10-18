import { useCallback, useEffect, useState, type FormEvent } from "react";
import { List, useTicketList } from "./List.tsx";
import { api, type Ticket } from "./ui.tsx";
import { Bar, ByStatus, cycleName, useTracker, type CycleRef, type Progress } from "./tracker.tsx";

type Cycle = CycleRef & { progress: Progress; added_after_start: number };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function Scope({ c }: { c: Cycle }) {
  return (
    <span className="muted">
      {c.progress.total} {c.progress.total === 1 ? "ticket" : "tickets"}{c.progress.points > 0 && ` · ${c.progress.points} points`}
      {c.added_after_start > 0 && <span className="warn-text" title="Tickets added after the cycle started"> · +{c.added_after_start} scope</span>}
    </span>
  );
}

export function Cycles({ go }: { go: (to: string) => void }) {
  const [cycles, setCycles] = useState<Cycle[] | null>(null);
  const [error, setError] = useState("");
  const { reload: reloadTracker } = useTracker();
  const reload = useCallback(() => api<Cycle[]>("/api/cycles").then(setCycles, (e) => setError(e.message)), []);
  useEffect(() => void reload(), [reload]);
  // Defaults: two weeks starting the day after the last cycle ends (or today).
  const last = cycles?.at(-1)?.ends_at;
  const today = new Date().toISOString().slice(0, 10);
  const start = last && last >= today ? addDays(last, 1) : today;

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api("/api/cycles", "POST", { name: f.get("name"), starts_at: f.get("starts_at"), ends_at: f.get("ends_at") });
      setError("");
      reload();
      reloadTracker();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const section = (state: string, title: string, list: Cycle[]) =>
    list.length > 0 && (
      <section aria-label={title}>
        <h3>{title}</h3>
        <ul className="plist">
          {list.map((c) => (
            <li key={c.id} className="row">
              <button className="link" onClick={() => go(`/cycles/${c.id}`)}>{cycleName(c)}</button>
              {c.name && <span className="muted">Cycle {c.number}</span>}
              <span className="muted mono">{c.starts_at} → {c.ends_at}</span>
              <span className="grow" />
              <Scope c={c} />
              {state !== "upcoming" && <Bar p={c.progress} />}
            </li>
          ))}
        </ul>
      </section>
    );

  return (
    <div className="page">
      <form className="row" onSubmit={create} key={start}>
        <input name="name" aria-label="Cycle name" placeholder="Name (optional)" maxLength={100} className="grow narrow" />
        <input name="starts_at" type="date" aria-label="Starts" defaultValue={start} required className="narrow" />
        <input name="ends_at" type="date" aria-label="Ends" defaultValue={addDays(start, 13)} required className="narrow" />
        <button className="btn primary">Create cycle</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {cycles?.length === 0 && <p className="muted">No cycles yet. A cycle is a time box (usually 1–2 weeks) with a set of tickets to finish in it.</p>}
      {cycles && section("current", "Current", cycles.filter((c) => c.state === "current"))}
      {cycles && section("upcoming", "Upcoming", cycles.filter((c) => c.state === "upcoming"))}
      {cycles && section("past", "Past", cycles.filter((c) => c.state === "past").reverse())}
    </div>
  );
}

// One cycle ("current" = whichever cycle includes today): progress, scope, its tickets, and moving what is unfinished on.
export function CyclePage({ id, open, tick }: { id: string; open: (n: number) => void; tick: unknown }) {
  const [c, setC] = useState<Cycle | null | undefined>(undefined);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const { reload: reloadTracker } = useTracker();
  const reload = useCallback(() => api<Cycle>(`/api/cycles/${id}`).then(setC, () => setC(null)), [id]);
  useEffect(() => void reload(), [reload, tick]);
  const tickets = useTicketList(`cycle=${c?.id ?? "none"}`, `${tick}${msg}`);

  const call = async (path: string, method: string, body?: object) => {
    setError("");
    try {
      const r = await api(path, method, body);
      reload();
      reloadTracker();
      return r;
    } catch (e) {
      setError((e as Error).message);
    }
  };
  async function moveUnfinished() {
    const r = await call(`/api/cycles/${c!.id}/move-unfinished`, "POST");
    if (r) setMsg(`Moved ${r.moved} unfinished ticket${r.moved === 1 ? "" : "s"} to ${cycleName(r.to)}.`);
  }

  if (c === undefined) return <p className="muted pad">Loading…</p>;
  if (c === null) return <p className="muted pad">{id === "current" ? "No cycle includes today. Create one under Cycles." : "Cycle not found."}</p>;
  const unfinished = c.progress.total - c.progress.done;
  return (
    <div className="page" key={c.id}>
      <div className="row">
        <h2 className="cycle-title">{cycleName(c)}</h2>
        <span className={`badge cs-${c.state}`}>{c.state}</span>
        <input aria-label="Cycle name" placeholder="Name (optional)" defaultValue={c.name} maxLength={100} className="narrow" onBlur={(e) => e.target.value !== c.name && call(`/api/cycles/${c.id}`, "PATCH", { name: e.target.value })} />
        <input type="date" aria-label="Starts" className="narrow" value={c.starts_at} onChange={(e) => e.target.value && call(`/api/cycles/${c.id}`, "PATCH", { starts_at: e.target.value })} />
        <input type="date" aria-label="Ends" className="narrow" value={c.ends_at} onChange={(e) => e.target.value && call(`/api/cycles/${c.id}`, "PATCH", { ends_at: e.target.value })} />
      </div>
      <section aria-label="Progress" className="row">
        <Bar p={c.progress} /> <ByStatus p={c.progress} /> <Scope c={c} />
        <span className="grow" />
        {c.state !== "upcoming" && (
          <button className="btn" disabled={!unfinished} onClick={moveUnfinished}>Move unfinished to next cycle</button>
        )}
      </section>
      {msg && <p className="muted">{msg}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <h3>Tickets</h3>
      <List tickets={tickets} group="status" open={(t: Ticket) => open(t.number)} />
    </div>
  );
}
