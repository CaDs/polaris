import { createContext, useCallback, useContext, useEffect, useState, type FormEvent } from "react";
import { Alert, Confirm, api } from "./ui.tsx";

// M11 tracker: shared types, the picker data (one GET /api/tracker), and the small pieces every tracker view uses.

export type Label = { id: string; name: string; color: string };
export type Member = { id: string; name: string; email: string };
export type Milestone = { id: string; name: string; project_id: string; target_date: string | null };
export type CycleRef = { id: string; number: number; name: string; starts_at: string; ends_at: string; state: "current" | "upcoming" | "past" };
export type Tracker = { me: string; members: Member[]; labels: Label[]; projects: { id: string; name: string; status: string; milestones: Milestone[] }[]; cycles: CycleRef[] };
export type Progress = { total: number; done: number; points: number; points_done: number; by_status: Record<string, number> };

export const PRIORITIES = ["No priority", "Urgent", "High", "Medium", "Low"];
export const PRIORITY_ORDER = [1, 2, 3, 4, 0]; // Linear: none sorts last
export const ESTIMATES = [1, 2, 3, 5, 8];
// The server's palette (tracker.ts COLORS); mid-tone hexes that read on both themes.
export const COLORS: Record<string, string> = {
  gray: "#8a8f98", red: "#eb5757", orange: "#f2994a", yellow: "#e2b203", green: "#4cb782", teal: "#26b5ce", blue: "#4ea7fc", indigo: "#5e6ad2", purple: "#9b51e0", pink: "#e255a1",
};
export const cycleName = (c: { number: number; name: string }) => c.name || `Cycle ${c.number}`;

const Ctx = createContext<{ tracker: Tracker | null; reload: () => void }>({ tracker: null, reload: () => {} });
export const useTracker = () => useContext(Ctx);
export function TrackerProvider({ children }: { children: React.ReactNode }) {
  const [tracker, setTracker] = useState<Tracker | null>(null);
  const reload = useCallback(() => void api<Tracker>("/api/tracker").then(setTracker, () => {}), []);
  useEffect(reload, [reload]);
  return <Ctx.Provider value={{ tracker, reload }}>{children}</Ctx.Provider>;
}

// Linear's glyphs: bars for low → high, an exclamation square for urgent, three dots for none.
export function PriorityIcon({ p }: { p: number }) {
  return (
    <svg className={`icon prio p${p}`} width="14" height="14" viewBox="0 0 14 14" role="img" aria-label={PRIORITIES[p]}>
      <title>{PRIORITIES[p]}</title>
      {p === 1 ? (
        <>
          <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
          <path d="M7 3.8v4M7 10.2v.1" stroke="var(--bg)" strokeWidth="1.6" strokeLinecap="round" />
        </>
      ) : p === 0 ? (
        [3, 7, 11].map((x) => <rect key={x} x={x - 1} y="6.2" width="2" height="1.6" rx=".5" fill="currentColor" opacity=".6" />)
      ) : (
        [0, 1, 2].map((i) => <rect key={i} x={2 + i * 4} y={9 - i * 3} width="2.4" height={3 + i * 3} rx=".6" fill="currentColor" opacity={i < 5 - p ? 1 : 0.25} />)
      )}
    </svg>
  );
}

export const LabelChip = ({ label }: { label: Label }) => (
  <span className="chip label" style={{ "--c": COLORS[label.color] ?? COLORS.gray } as React.CSSProperties}>{label.name}</span>
);

export const Avatar = ({ user }: { user: { name: string; email: string } }) => (
  <span className="avatar person" title={`${user.name} (${user.email})`}>
    {user.name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
  </span>
);

export const Bar = ({ p }: { p: Progress }) => (
  <span className="progress" title={`${p.done} of ${p.total} done`}>
    <span className="bar"><span style={{ width: `${p.total ? (100 * p.done) / p.total : 0}%` }} /></span>
    <span className="muted">{p.done}/{p.total}{p.total ? ` · ${Math.round((100 * p.done) / p.total)}%` : ""}</span>
  </span>
);

// Status counts, e.g. "2 todo · 1 review".
export const ByStatus = ({ p }: { p: Progress }) => (
  <span className="muted">{Object.entries(p.by_status).filter(([, n]) => n).map(([s, n]) => `${n} ${s}`).join(" · ") || "no tickets"}</span>
);

// Settings: the workspace's labels. New labels can also be made from a ticket's label picker.
export function LabelSettings() {
  const { tracker, reload } = useTracker();
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<Label | null>(null);
  const run = (p: Promise<unknown>) => p.then(() => (setError(""), reload()), (e) => setError(e.message));
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await run(api("/api/labels", "POST", { name: f.get("name"), color: f.get("color") }).then(() => form.reset()));
  }
  return (
    <section className="label-settings" aria-label="Labels">
      <h2>Labels</h2>
      <p className="muted">Tag tickets to filter and group them. Agents see a ticket's labels; planners may add new ones.</p>
      <ul className="plist">
        {tracker?.labels.map((l) => (
          <li key={l.id} className="row">
            <LabelChip label={l} />
            <input aria-label={`Rename ${l.name}`} defaultValue={l.name} maxLength={40} className="grow narrow" onBlur={(e) => e.target.value.trim() !== l.name && run(api(`/api/labels/${l.id}`, "PATCH", { name: e.target.value }))} />
            <ColorSelect value={l.color} label={`Color of ${l.name}`} onChange={(color) => run(api(`/api/labels/${l.id}`, "PATCH", { color }))} />
            <button className="btn danger" aria-label={`Delete label ${l.name}`} onClick={() => setDeleting(l)}>Delete</button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={add}>
        <input name="name" aria-label="New label" placeholder="New label" required maxLength={40} className="grow narrow" />
        <ColorSelect value="blue" label="New label color" />
        <button className="btn">Add label</button>
      </form>
      <Alert error={error} />
      {deleting && (
        <Confirm title="Delete label?" onConfirm={() => (setDeleting(null), run(api(`/api/labels/${deleting.id}`, "DELETE")))} onClose={() => setDeleting(null)}>
          The label {deleting.name} is deleted and taken off every ticket that has it.
        </Confirm>
      )}
    </section>
  );
}

export const ColorSelect = ({ value, label, onChange }: { value: string; label: string; onChange?: (c: string) => void }) => (
  <select name="color" aria-label={label} defaultValue={value} onChange={onChange && ((e) => onChange(e.target.value))}>
    {Object.keys(COLORS).map((c) => <option key={c}>{c}</option>)}
  </select>
);
