import { useEffect, useState } from "react";
import { COLUMNS, Loading, StatusIcon, api, statusName, type Ticket } from "./ui.tsx";
import { Avatar, cycleName, LabelChip, PRIORITIES, PRIORITY_ORDER, PriorityIcon } from "./tracker.tsx";

export const GROUPS = ["status", "priority", "project", "assignee", "cycle", "label"] as const;
export type Group = (typeof GROUPS)[number];
type Bucket = { key: string; name: string; icon?: React.ReactNode; items: Ticket[] };

// Buckets in display order; "none" buckets last. A ticket with several labels is listed under each.
function buckets(tickets: Ticket[], group: Group): Bucket[] {
  const by = new Map<string, Bucket>();
  const put = (key: string, name: string, t: Ticket, icon?: React.ReactNode) => {
    if (!by.has(key)) by.set(key, { key, name, icon, items: [] });
    by.get(key)!.items.push(t);
  };
  for (const t of tickets) {
    if (group === "status") put(t.status, statusName(t.status), t, <StatusIcon status={t.status} />);
    else if (group === "priority") put(String(t.priority), PRIORITIES[t.priority], t, <PriorityIcon p={t.priority} />);
    else if (group === "project") put(t.project?.id ?? "", t.project?.name ?? "No project", t);
    else if (group === "assignee") put(t.assignee?.id ?? "", t.assignee?.name ?? "No assignee", t);
    else if (group === "cycle") put(t.cycle ? String(t.cycle.number).padStart(6, "0") : "", t.cycle ? cycleName(t.cycle) : "No cycle", t);
    else if (t.labels.length) for (const l of t.labels) put(l.id, l.name, t, <LabelChip label={l} />);
    else put("", "No labels", t);
  }
  const rank = (b: Bucket) =>
    group === "status" ? COLUMNS.indexOf(b.key as Ticket["status"]) : group === "priority" ? PRIORITY_ORDER.indexOf(Number(b.key)) : b.key === "" ? Infinity : 0;
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || (group === "cycle" ? a.key.localeCompare(b.key) : a.name.localeCompare(b.name)));
}

// Dense Linear-style rows, grouped. Each row is one button (opens the ticket); the server's sort order is kept inside a group.
export function List({ tickets, group, open }: { tickets: Ticket[] | null; group: Group; open: (t: Ticket) => void }) {
  if (!tickets) return <Loading />;
  return (
    <div className="list">
      {buckets(tickets, group).map((b) => (
        <section key={b.key} aria-label={b.name}>
          <h2 className="group">{b.icon} {b.name} <span className="muted">{b.items.length}</span></h2>
          {b.items.map((t) => (
            <button key={t.id} className="lrow" onClick={() => open(t)}>
              <PriorityIcon p={t.priority} />
              <span className="mono muted key">{t.key}</span>
              <StatusIcon status={t.status} label />
              <span className="title">
                {t.title}
                {t.kind === "epic" && <span className="badge epic">Epic{t.child_count > 0 && ` ${t.child_done}/${t.child_count}`}</span>}
                {t.parent_key && <span className="muted mono" title="Parent epic"> ← {t.parent_key}</span>}
              </span>
              <span className="cell labels">{t.labels.map((l) => <LabelChip key={l.id} label={l} />)}</span>
              {t.project && <span className="cell muted" title="Project">{t.project.name}</span>}
              {t.cycle && <span className="cell muted" title="Cycle">{cycleName(t.cycle)}</span>}
              {t.due_date && <span className="muted due" title="Due date">{t.due_date}</span>}
              {t.assignee ? <Avatar user={t.assignee} /> : <span className="avatar none" />}
            </button>
          ))}
        </section>
      ))}
      {tickets.length === 0 && <p className="center muted">No matching tickets.</p>}
    </div>
  );
}

// The tickets matching a filter query (project and cycle pages). dep: refetch when it changes (the polled full list).
export function useTicketList(query: string, dep: unknown) {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  useEffect(() => {
    let live = true;
    api<Ticket[]>(`/api/tickets?${query}`).then((t) => live && setTickets(t), () => {});
    return () => void (live = false);
  }, [query, dep]);
  return tickets;
}
