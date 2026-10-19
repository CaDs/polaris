import { COLUMNS, StatusIcon, cost, fmt, waiting, type Ticket } from "./ui.tsx";
import { Avatar, LabelChip, PriorityIcon } from "./tracker.tsx";

export function Board({ tickets, open }: { tickets: Ticket[] | null; open: (t: Ticket) => void }) {
  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const list = tickets?.filter((t) => t.status === col) ?? [];
        return (
          <section key={col} aria-label={col}>
            <h2>
              <StatusIcon status={col} /> {col} <span className="muted">{list.length}</span>
            </h2>
            {list.map((t) => (
              <button key={t.id} className={t.status === "running" ? "ticket running" : "ticket"} onClick={() => open(t)}>
                <span className="id mono">
                  {t.key}
                  {t.parent_key && <span title="Parent epic"> · {t.parent_key}</span>}
                  {t.kind === "epic" && <span className="badge epic">Epic</span>}
                </span>
                <span className="title">{t.title}</span>
                {(t.priority > 0 || t.labels.length > 0 || t.due_date || t.assignee) && (
                  <span className="props">
                    {t.priority > 0 && <PriorityIcon p={t.priority} />}
                    {t.labels.map((l) => <LabelChip key={l.id} label={l} />)}
                    {t.due_date && <span className="muted" title="Due date">{t.due_date}</span>}
                    {t.assignee && <Avatar user={t.assignee} />}
                  </span>
                )}
                {t.kind === "epic" && t.child_count > 0 && <span className="meta muted">{t.child_done}/{t.child_count} done</span>}
                {t.run_status && (
                  <span className="meta muted">
                    {waiting(t) ? "waiting for children" : t.run_status} · {t.run_model && <span className="mono">{t.run_model} · </span>}{fmt(t.tokens_in + t.tokens_out)} tok{(t.cost_usd > 0 || t.run_auth === "oauth") && ` · ${cost(t.cost_usd, t.run_auth)}`}
                  </span>
                )}
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}
