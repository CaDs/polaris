import { useEffect, useRef, useState, type FormEvent } from "react";
import { Board } from "./Board.tsx";
import { GROUPS, List, type Group } from "./List.tsx";
import { Alert, COLUMNS, DateInput, Dialog, Icon, api, type Ticket } from "./ui.tsx";
import { cycleName, PRIORITIES, useTracker, type Tracker } from "./tracker.tsx";
import type { View } from "./Views.tsx";

// Board/list with a filter bar. All state lives in the URL query (shareable, bookmarkable, a saved view is just a query):
// the API's filter params plus sort, layout and group, which the API ignores. base: the page's path; scope: the query it
// always adds (a project board: project=<id>), so `all` is already scoped and a saved view keeps it.
type Field = { key: string; name: string; options?: (t: Tracker, tickets: Ticket[]) => [string, string][]; date?: boolean };
const FIELDS: Field[] = [
  { key: "status", name: "Status", options: () => COLUMNS.map((s) => [s, s]) },
  { key: "priority", name: "Priority", options: () => [1, 2, 3, 4, 0].map((p) => [String(p), PRIORITIES[p]]) },
  { key: "label", name: "Labels", options: (t) => t.labels.map((l) => [l.id, l.name]) },
  { key: "assignee", name: "Assignee", options: (t) => [["me", "Me"], ["none", "No assignee"], ...t.members.map((m): [string, string] => [m.id, m.name])] },
  { key: "project", name: "Project", options: (t) => t.projects.map((p): [string, string] => [p.id, p.name]) },
  { key: "milestone", name: "Milestone", options: (t) => [["none", "No milestone"], ...t.projects.flatMap((p) => p.milestones.map((m): [string, string] => [m.id, `${p.name} › ${m.name}`]))] },
  { key: "cycle", name: "Cycle", options: (t) => [["current", "Current cycle"], ["none", "No cycle"], ...t.cycles.map((c): [string, string] => [c.id, cycleName(c)])] },
  { key: "kind", name: "Type", options: () => [["task", "Task"], ["epic", "Epic"]] },
  { key: "parent", name: "Parent epic", options: (_, ts) => [["none", "No parent"], ...ts.filter((x) => x.kind === "epic").map((x): [string, string] => [x.id, `${x.key} ${x.title}`])] },
  { key: "due_before", name: "Due before", date: true },
  { key: "due_after", name: "Due after", date: true },
];
const SORTS: [string, string][] = [["manual", "Manual"], ["priority", "Priority"], ["updated", "Last updated"], ["created", "Created"], ["due", "Due date"]];
const VIEW_ONLY = ["sort", "layout", "group", "view", "edit"]; // view: the saved view this came from; edit: open its dialog

export function Issues({ base, scope, search, go, all, open }: {
  base: string; scope: string; search: string; go: (to: string, replace?: boolean) => void; all: Ticket[] | null; open: (key: string) => void;
}) {
  const params = new URLSearchParams(search);
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState("");
  const layout = params.get("layout") === "list" ? "list" : "board";
  const group = (GROUPS as readonly string[]).includes(params.get("group") ?? "") ? (params.get("group") as Group) : "status";
  const filtered = [...params.keys()].some((k) => !["layout", "group", "view", "edit"].includes(k));

  // Re-fetch when the query changes and whenever the full list does (it polls while runs are active).
  useEffect(() => {
    if (!filtered) return setTickets(all), setError("");
    let live = true;
    api<Ticket[]>(`/api/tickets?${params}${scope && `&${scope}`}`).then((t) => live && (setTickets(t), setError("")), (e) => live && setError(e.message));
    return () => void (live = false);
  }, [search, all]);

  const set = (mut: (p: URLSearchParams) => void, replace = false) => {
    const p = new URLSearchParams(search);
    mut(p);
    const qs = p.toString();
    go(qs ? `${base}?${qs}` : base, replace);
  };

  return (
    <>
      <FilterBar params={params} scope={scope} set={set} all={all ?? []} open={open} error={error} />
      {layout === "list" ? (
        <List tickets={tickets} group={group} open={(t) => open(t.key)} />
      ) : (
        <>
          <Board tickets={tickets} open={(t) => open(t.key)} />
          {tickets?.length === 0 && <p className="center muted">{filtered ? "No matching tickets." : "No tickets yet. Press C to create one."}</p>}
        </>
      )}
    </>
  );
}

function FilterBar({ params, scope, set, all, open, error }: {
  params: URLSearchParams; scope: string; set: (mut: (p: URLSearchParams) => void, replace?: boolean) => void; all: Ticket[]; open: (key: string) => void; error: string;
}) {
  const { tracker } = useTracker();
  const [menu, setMenu] = useState<string | null>(null); // "fields" or a field key
  const [saving, setSaving] = useState(params.has("edit"));
  const viewId = params.get("view");
  const [savedView, setSavedView] = useState<View | null | undefined>(null); // undefined: loading
  useEffect(() => {
    setSavedView(viewId ? undefined : null);
    if (viewId) api<View>(`/api/views/${viewId}`).then(setSavedView, () => setSavedView(null));
  }, [viewId]);
  const [q, setQ] = useState(params.get("q") ?? "");
  const searchRef = useRef<HTMLInputElement>(null);
  const qParam = params.get("q") ?? "";
  useEffect(() => setQ(qParam), [qParam]); // back/forward, Clear

  // "/" focuses the search box unless the user is typing somewhere.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  const values = (key: string) => (params.get(key) ?? "").split(",").filter(Boolean);
  const toggle = (key: string, v: string) =>
    set((p) => {
      const cur = values(key);
      const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
      if (next.length) p.set(key, next.join(","));
      else p.delete(key), key === "label" && p.delete("label_mode");
    });
  const active = FIELDS.filter((f) => params.get(f.key));
  const name = (f: Field, v: string) => (tracker && f.options?.(tracker, all).find(([id]) => id === v)?.[1]) ?? v;
  const view = (v: string, dflt: string) => params.get(v) ?? dflt;

  // Enter on an exact key ("ABC-12") opens that ticket.
  function submit(e: FormEvent) {
    e.preventDefault();
    const t = all.find((x) => x.key.toLowerCase() === q.trim().toLowerCase());
    if (t) open(t.key);
  }

  return (
    <div className="filterbar">
      <form role="search" onSubmit={submit}>
        <input
          ref={searchRef} type="search" aria-label="Search" placeholder="Search…  /" value={q}
          onChange={(e) => (setQ(e.target.value), set((p) => (e.target.value ? p.set("q", e.target.value) : p.delete("q")), true))}
          onKeyDown={(e) => e.key === "Escape" && e.currentTarget.blur()}
        />
      </form>
      {active.map((f) => (
        <span key={f.key} className="chip filter">
          <button className="link" onClick={() => setMenu(f.key)}>
            <b>{f.name}</b> {f.date ? params.get(f.key) : values(f.key).map((v) => name(f, v)).join(", ")}
          </button>
          {f.key === "label" && values("label").length > 1 && (
            <button className="link" onClick={() => set((p) => p.set("label_mode", p.get("label_mode") === "all" ? "any" : "all"))}>
              {params.get("label_mode") === "all" ? "all of" : "any of"}
            </button>
          )}
          <button className="link x" aria-label={`Remove ${f.name} filter`} onClick={() => set((p) => (p.delete(f.key), f.key === "label" && p.delete("label_mode")))}>×</button>
        </span>
      ))}
      <span className="menu-anchor">
        <button className="btn" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : "fields")}><Icon name="plus" size={14} /> Filter</button>
        {menu && tracker && (
          <Popover key={menu} close={() => setMenu(null)}>
            {menu === "fields" ? (
              FIELDS.map((f) => <button key={f.key} className="item" onClick={() => setMenu(f.key)}>{f.name}</button>)
            ) : (
              <FieldMenu field={FIELDS.find((f) => f.key === menu)!} options={FIELDS.find((f) => f.key === menu)!.options?.(tracker, all) ?? []} values={values(menu)} toggle={(v) => toggle(menu, v)}
                setDate={(v) => set((p) => (v ? p.set(menu, v) : p.delete(menu)))} date={params.get(menu) ?? ""} back={() => setMenu("fields")} />
            )}
          </Popover>
        )}
      </span>
      {active.length > 0 && <button className="link" onClick={() => set((p) => [...p.keys()].filter((k) => !VIEW_ONLY.includes(k)).forEach((k) => p.delete(k)))}>Clear</button>}
      <span className="grow" />
      <select aria-label="Sort" value={view("sort", "manual")} onChange={(e) => set((p) => (e.target.value === "manual" ? p.delete("sort") : p.set("sort", e.target.value)))}>
        {SORTS.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
      </select>
      <span className="seg" role="group" aria-label="Layout">
        {(["board", "list"] as const).map((l) => (
          <button key={l} aria-pressed={view("layout", "board") === l} onClick={() => set((p) => (l === "board" ? p.delete("layout") : p.set("layout", l)))}>{l === "board" ? "Board" : "List"}</button>
        ))}
      </span>
      {view("layout", "board") === "list" && (
        <select aria-label="Group by" value={view("group", "status")} onChange={(e) => set((p) => (e.target.value === "status" ? p.delete("group") : p.set("group", e.target.value)))}>
          {GROUPS.map((g) => <option key={g} value={g}>Group: {g}</option>)}
        </select>
      )}
      <button className="btn" onClick={() => setSaving(true)}>{savedView?.mine ? `Edit view: ${savedView.name}` : "Save view"}</button>
      <Alert error={error} />
      {saving && savedView !== undefined && (
        <SaveView params={params} scope={scope} view={savedView?.mine ? savedView : null} close={() => (setSaving(false), params.has("edit") && set((p) => p.delete("edit"), true))}
          saved={(v) => (setSaving(false), setSavedView(v), set((p) => (p.set("view", v.id), p.delete("edit")), true))} />
      )}
    </div>
  );
}

function FieldMenu({ field, options, values, toggle, date, setDate, back }: {
  field: Field; options: [string, string][]; values: string[]; toggle: (v: string) => void; date: string; setDate: (v: string) => void; back: () => void;
}) {
  return (
    <div role="group" aria-label={`${field.name} filter`}>
      <button className="item muted" onClick={back}>‹ {field.name}</button>
      {field.date ? (
        <DateInput aria-label={field.name} value={date} onChange={(e) => setDate(e.target.value)} />
      ) : options.length ? (
        options.map(([v, n]) => (
          <label key={v} className="check item">
            <input type="checkbox" checked={values.includes(v)} onChange={() => toggle(v)} /> {n}
          </label>
        ))
      ) : (
        <p className="muted item">Nothing to filter by yet.</p>
      )}
    </div>
  );
}

// A small anchored panel: Esc or a click outside closes it; focus moves into it when it mounts (key it to re-focus).
export function Popover({ close, children }: { close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, button")?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), closeRef.current());
    const click = (e: MouseEvent) => !ref.current?.parentElement?.contains(e.target as Node) && closeRef.current();
    addEventListener("keydown", key, true);
    addEventListener("mousedown", click);
    return () => (removeEventListener("keydown", key, true), removeEventListener("mousedown", click));
  }, []);
  return <div ref={ref} className="popover">{children}</div>;
}

// New view, or (view: one of mine this board came from) update it in place: name, sharing, and the board's current query.
function SaveView({ params, scope, view, saved, close }: { params: URLSearchParams; scope: string; view: View | null; saved: (v: View) => void; close: () => void }) {
  const [error, setError] = useState("");
  async function save(form: HTMLFormElement, asNew: boolean) {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const update = view && !asNew;
    const filters = Object.fromEntries([...params, ...new URLSearchParams(scope)].filter(([k]) => !["sort", "layout", "view", "edit"].includes(k)));
    try {
      const body = { name: f.get("name"), filters, sort: params.get("sort") ?? "manual", layout: params.get("layout") ?? "board", shared: f.has("shared") };
      saved(await api<View>(update ? `/api/views/${view.id}` : "/api/views", update ? "PATCH" : "POST", body));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog title={view ? "Edit view" : "Save view"} onClose={close}>
      <form onSubmit={(e) => (e.preventDefault(), save(e.currentTarget, false))}>
        <label>
          View name <input name="name" required maxLength={100} autoFocus defaultValue={view?.name} />
        </label>
        <label className="check"><input type="checkbox" name="shared" defaultChecked={view?.shared} /> Share with the workspace</label>
        <p className="muted">{view ? "Saves the current filters, search, sort and layout into this view." : "Saves the current filters, search, sort and layout. Open it from Views."}</p>
        <Alert error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          {view && <button type="button" className="btn" onClick={(e) => save(e.currentTarget.form!, true)}>Save as new view</button>}
          <button className="btn primary">{view ? "Update view" : "Save"}</button>
        </div>
      </form>
    </Dialog>
  );
}
