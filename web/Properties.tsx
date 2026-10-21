import { useEffect, useRef, useState, type FormEvent } from "react";
import { Popover } from "./Filters.tsx";
import { Alert, DateField, api, statusName, type Status, type Ticket } from "./ui.tsx";
import { COLORS, cycleName, ESTIMATES, LabelChip, PRIORITIES, PRIORITY_ORDER, useTracker } from "./tracker.tsx";

const MANUAL: string[] = ["todo", "done", "failed", "wont_do"];

// The ticket's properties sidebar. Native selects keep it keyboard-friendly; on the ticket page s / p / a open status,
// priority and assignee, l the label picker. The agent run controls stay in TicketView.
export function Properties({ ticket, tickets, reload }: { ticket: Ticket; tickets: Ticket[]; reload: () => void }) {
  const { tracker, reload: reloadTracker } = useTracker();
  const [error, setError] = useState("");
  const [labels, setLabels] = useState(false);
  const status = useRef<HTMLSelectElement>(null);
  const priority = useRef<HTMLSelectElement>(null);
  const assignee = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    const keys: Record<string, React.RefObject<HTMLSelectElement | null>> = { s: status, p: priority, a: assignee };
    const k = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role=dialog], .popover")) return;
      if (e.key === "l") return e.preventDefault(), setLabels(true);
      const el = keys[e.key]?.current;
      if (!el) return;
      e.preventDefault();
      el.focus();
      try {
        el.showPicker();
      } catch {} // not every browser opens a select's picker from script
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  async function patch(body: object) {
    setError("");
    try {
      await api(`/api/tickets/${ticket.id}`, "PATCH", body);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const t = tracker;
  // The moves the server allows by hand (moveTicket in runs.ts): between todo, done, failed and won't do, and review back to todo; none
  // while a run is queued or running. Running and review otherwise belong to Run, Cancel, Approve and Reject.
  const active = ticket.run_status === "queued" || ticket.run_status === "running";
  const moves = active ? [] : ticket.status === "review" ? ["todo"] : MANUAL.includes(ticket.status) ? MANUAL.filter((s) => s !== ticket.status) : [];
  const milestones = t?.projects.find((p) => p.id === ticket.project_id)?.milestones ?? [];
  // Moving between epics by hand: only a todo task without runs (the server enforces the rest of the planner's rules).
  const movable = ticket.kind === "task" && ticket.status === "todo" && !ticket.run_count;
  const epics = tickets.filter((x) => x.kind === "epic" && x.project_id === ticket.project_id && (x.id === ticket.parent_id || ((x.status === "todo" || x.status === "running") && x.id !== ticket.id)));
  const prop = (name: string, control: React.ReactNode, hint?: string) => (
    <div className="prop">
      <span className="muted" title={hint}>{name}</span>
      {control}
    </div>
  );

  return (
    <aside className="props-panel" aria-label="Properties">
      {prop("Status", (
        <select ref={status} aria-label="Status" value={ticket.status} disabled={!moves.length} title={moves.length ? undefined : "Set by its runs: Run, Cancel, Approve or Reject"}
          onChange={(e) => patch({ status: e.target.value as Status })}>
          {[ticket.status, ...moves].map((s) => <option key={s} value={s}>{statusName(s)}</option>)}
        </select>
      ), "s")}
      {prop("Priority", (
        <select ref={priority} aria-label="Priority" value={ticket.priority} onChange={(e) => patch({ priority: Number(e.target.value) })}>
          {[0, ...PRIORITY_ORDER.slice(0, 4)].map((p) => <option key={p} value={p}>{PRIORITIES[p]}</option>)}
        </select>
      ), "p")}
      {prop("Assignee", (
        <select ref={assignee} aria-label="Assignee" value={ticket.assignee?.id ?? ""} onChange={(e) => patch({ assignee_id: e.target.value || null })}>
          <option value="">No assignee</option>
          {t?.members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.id === t.me ? " (me)" : ""}</option>)}
        </select>
      ), "a")}
      {prop("Labels", (
        <span className="menu-anchor labels">
          {ticket.labels.map((l) => <LabelChip key={l.id} label={l} />)}
          <button className="link" aria-label="Edit labels" title="l" onClick={() => setLabels(!labels)}>{ticket.labels.length ? "Edit" : "Add labels"}</button>
          {labels && t && <LabelPicker ticket={ticket} all={t.labels} close={() => setLabels(false)} patch={patch} created={reloadTracker} />}
        </span>
      ))}
      {prop("Project", <span title="A ticket stays in the project (repository) it was created in">{ticket.project.name}</span>)}
      {prop("Milestone", (
        <select aria-label="Milestone" value={ticket.milestone?.id ?? ""} onChange={(e) => patch({ milestone_id: e.target.value || null })}>
          <option value="">No milestone</option>
          {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      ))}
      {prop("Cycle", (
        <select aria-label="Cycle" value={ticket.cycle?.id ?? ""} onChange={(e) => patch({ cycle_id: e.target.value || null })}>
          <option value="">No cycle</option>
          {t?.cycles.filter((c) => c.project_id === ticket.project_id).map((c) => <option key={c.id} value={c.id}>{cycleName(c)}{c.state === "past" ? "" : ` (${c.state})`}</option>)}
        </select>
      ))}
      {prop("Estimate", (
        <select aria-label="Estimate" value={ticket.estimate ?? ""} onChange={(e) => patch({ estimate: e.target.value ? Number(e.target.value) : null })}>
          <option value="">No estimate</option>
          {ESTIMATES.map((n) => <option key={n} value={n}>{n} {n === 1 ? "point" : "points"}</option>)}
        </select>
      ))}
      {prop("Due date", <DateField aria-label="Due date" value={ticket.due_date} onSave={(due_date) => patch({ due_date })} />)}
      {prop("Parent epic", (
        <select aria-label="Parent epic" value={ticket.parent_id ?? ""} disabled={!movable} title={movable ? undefined : "Only a todo task without runs can be moved between epics"}
          onChange={(e) => patch({ parent_id: e.target.value || null })}>
          <option value="">No parent</option>
          {epics.map((x) => <option key={x.id} value={x.id}>{x.key} {x.title}</option>)}
        </select>
      ))}
      <Alert error={error} />
    </aside>
  );
}

// Checkboxes over the workspace's labels, plus "create label" by typing a new name.
function LabelPicker({ ticket, all, close, patch, created }: { ticket: Ticket; all: { id: string; name: string; color: string }[]; close: () => void; patch: (b: object) => Promise<void>; created: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const ids = ticket.labels.map((l) => l.id);
  const shown = all.filter((l) => l.name.toLowerCase().includes(name.trim().toLowerCase()));
  async function create(e: FormEvent) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    const hit = all.find((l) => l.name.toLowerCase() === n.toLowerCase());
    try {
      const id = hit?.id ?? (await api<{ id: string }>("/api/labels", "POST", { name: n, color: Object.keys(COLORS)[all.length % 10] })).id;
      if (!hit) created();
      setName("");
      if (!ids.includes(id)) await patch({ label_ids: [...ids, id] });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Popover close={close}>
      <form onSubmit={create}>
        <input aria-label="Find or create label" placeholder="Label…" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
      </form>
      {shown.map((l) => (
        <label key={l.id} className="check item">
          <input type="checkbox" checked={ids.includes(l.id)} onChange={() => patch({ label_ids: ids.includes(l.id) ? ids.filter((x) => x !== l.id) : [...ids, l.id] })} />
          <LabelChip label={l} />
        </label>
      ))}
      {name.trim() && !all.some((l) => l.name.toLowerCase() === name.trim().toLowerCase()) && (
        <button className="item" onClick={create}>Create label “{name.trim()}”</button>
      )}
      {error && <p className="error item">{error}</p>}
    </Popover>
  );
}
