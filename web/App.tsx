import { useCallback, useEffect, useState, type FormEvent } from "react";
import { authClient } from "./auth-client.ts";
import { CyclePage, Cycles } from "./Cycles.tsx";
import { Issues } from "./Filters.tsx";
import { Improvement } from "./Improvement.tsx";
import { Palette } from "./Palette.tsx";
import { ProjectPage, Projects } from "./Projects.tsx";
import { Properties } from "./Properties.tsx";
import { Settings } from "./Settings.tsx";
import { TicketView } from "./TicketView.tsx";
import { UsagePage } from "./Usage.tsx";
import { Views } from "./Views.tsx";
import { Wiki } from "./Wiki.tsx";
import { Dialog, api, useTheme, type Ticket, type Theme } from "./ui.tsx";
import { cycleName, ESTIMATES, PRIORITIES, PRIORITY_ORDER, TrackerProvider, useTracker } from "./tracker.tsx";

export function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <p className="center muted">Loading…</p>;
  if (!session) return <AuthForm />;
  if (!session.session.activeOrganizationId) return <CreateWorkspace />;
  return (
    <TrackerProvider>
      <Dashboard email={session.user.email} />
    </TrackerProvider>
  );
}

function fields(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
}

function AuthForm() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    const f = fields(e);
    const { error } =
      mode === "up"
        ? await authClient.signUp.email({ name: f.name, email: f.email, password: f.password })
        : await authClient.signIn.email({ email: f.email, password: f.password });
    setError(error?.message ?? "");
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>{mode === "in" ? "Sign in" : "Create account"}</h1>
      {mode === "up" && (
        <label>
          Name <input name="name" required autoComplete="name" />
        </label>
      )}
      <label>
        Email <input name="email" type="email" required autoComplete="email" />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete={mode === "in" ? "current-password" : "new-password"}
        />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button>{mode === "in" ? "Sign in" : "Create account"}</button>
      <button
        type="button"
        className="link"
        onClick={() => {
          setMode(mode === "in" ? "up" : "in");
          setError("");
        }}
      >
        {mode === "in" ? "No account? Create one" : "Have an account? Sign in"}
      </button>
    </form>
  );
}

function CreateWorkspace() {
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    const { name } = fields(e);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const { error } = await authClient.organization.create({ name, slug });
    setError(error?.message ?? "");
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Create a workspace</h1>
      <p className="muted">Tickets, runs and provider keys live in a workspace.</p>
      <label>
        Name <input name="name" required autoFocus />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <button>Create</button>
    </form>
  );
}

// Path and query: the board's filters live in the query (M11). replace: no history entry (typing in the search box).
function usePath() {
  const here = () => location.pathname + location.search;
  const [loc, setLoc] = useState(here);
  useEffect(() => {
    const on = () => setLoc(here());
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const go = (to: string, replace = false) => {
    history[replace ? "replaceState" : "pushState"](null, "", to);
    setLoc(to);
  };
  return [loc, go] as const;
}

function useTickets() {
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const reload = useCallback(() => api<Ticket[]>("/api/tickets").then(setTickets, () => {}), []);
  useEffect(() => void reload(), [reload]);
  const anyRunning = tickets?.some((t) => t.status === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(reload, 2000);
    return () => clearInterval(id);
  }, [anyRunning, reload]);
  return [tickets, reload] as const;
}

const PAGES: [string, string][] = [["", "Board"], ["projects", "Projects"], ["cycles", "Cycles"], ["views", "Views"], ["usage", "Usage"], ["wiki", "Wiki"], ["improvement", "Improvement"], ["settings", "Settings"]];

function Dashboard({ email }: { email: string }) {
  const { data: workspace } = authClient.useActiveOrganization();
  const { tracker, reload: reloadTracker } = useTracker();
  const [theme, setTheme] = useTheme();
  const [loc, go] = usePath();
  const [tickets, reload] = useTickets();
  const [creating, setCreating] = useState(false);
  const [palette, setPalette] = useState(false);

  // "C" opens the new-ticket dialog unless the user is typing or a dialog is open; Cmd/Ctrl+K the command palette, anywhere.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") return e.preventDefault(), setPalette((p) => !p);
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() !== "c" || e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      setCreating(true);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  const q = loc.indexOf("?");
  const path = q < 0 ? loc : loc.slice(0, q);
  const search = q < 0 ? "" : loc.slice(q + 1);
  const [, section = "", sub] = path.split("/");
  useEffect(reloadTracker, [path]); // pickers pick up labels/projects/cycles made elsewhere (e.g. by a planner)
  const number = section === "t" ? sub : undefined;
  const ticket = number ? tickets?.find((t) => t.number === Number(number)) : undefined;
  const page = PAGES.find(([p]) => p === section)?.[1];
  const name = workspace?.name ?? "…";
  const open = (n: number) => go(`/t/${n}`);
  const current = tracker?.cycles.find((c) => c.state === "current");
  // New tickets made on a project or cycle page start in it.
  const defaults = { project_id: section === "projects" ? sub : undefined, cycle_id: section === "cycles" ? (sub === "current" ? current?.id : sub) : undefined };
  const link = (to: string, label: string, active: boolean, cls = "") => (
    <a key={to} href={to} className={`${cls}${active ? " active" : ""}`.trim()} onClick={(e) => (e.preventDefault(), go(to))}>{label}</a>
  );

  return (
    <div className="shell">
      <aside>
        <header className="ws">
          <span className="avatar" aria-hidden="true">{name[0]?.toUpperCase()}</span>
          <strong>{name}</strong>
        </header>
        <nav aria-label="Main">
          {PAGES.map(([p, label]) => [
            link(`/${p}`, label, section === p && !(p === "cycles" && sub === "current")),
            p === "cycles" && current && link("/cycles/current", "Current cycle", section === "cycles" && sub === "current", "sub"),
          ])}
        </nav>
        <div className="side-bottom">
          <button className="btn palette-btn" onClick={() => setPalette(true)}>Search or jump… <kbd>⌘K</kbd></button>
          <label className="inline">
            Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <div className="user">
            <span className="muted" title={email}>{email}</span>
            <button className="link" onClick={() => authClient.signOut()}>Sign out</button>
          </div>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <h1>{number ? (ticket?.key ?? "Ticket") : sub && section === "projects" ? "Project" : sub && section === "cycles" ? (sub === "current" ? "Current cycle" : "Cycle") : (page ?? "Board")}</h1>
          <button className="btn primary" onClick={() => setCreating(true)}>New ticket</button>
        </div>
        <main>
          {section === "settings" ? (
            <Settings />
          ) : section === "usage" ? (
            <UsagePage />
          ) : section === "improvement" ? (
            <Improvement />
          ) : section === "wiki" ? (
            <Wiki />
          ) : section === "projects" ? (
            sub ? <ProjectPage id={sub} go={go} open={open} tick={tickets} /> : <Projects go={go} />
          ) : section === "cycles" ? (
            sub ? <CyclePage id={sub} open={open} tick={tickets} /> : <Cycles go={go} />
          ) : section === "views" ? (
            <Views go={go} />
          ) : number ? (
            ticket ? (
              <div className="ticket-page">
                <TicketView ticket={ticket} reload={reload} close={() => go("/")} open={open} />
                <Properties ticket={ticket} tickets={tickets ?? []} reload={reload} />
              </div>
            ) : <p className="muted pad">{tickets ? "Ticket not found." : "Loading…"}</p>
          ) : (
            <Issues search={search} go={go} all={tickets} open={open} />
          )}
        </main>
      </div>
      {creating && <NewTicket tickets={tickets ?? []} defaults={defaults} close={() => setCreating(false)} created={() => (reload(), setCreating(false))} />}
      {palette && <Palette tickets={tickets ?? []} go={go} create={() => setCreating(true)} close={() => setPalette(false)} />}
    </div>
  );
}

// M11: the tracker fields are optional; empty selects mean "none".
function NewTicket({ tickets, defaults, close, created }: { tickets: Ticket[]; defaults: { project_id?: string; cycle_id?: string }; close: () => void; created: () => void }) {
  const { tracker } = useTracker();
  const [error, setError] = useState("");
  const [project, setProject] = useState(defaults.project_id ?? "");
  async function submit(e: FormEvent<HTMLFormElement>) {
    const labels = new FormData(e.currentTarget).getAll("label_ids");
    const f = fields(e);
    try {
      await api("/api/tickets", "POST", {
        title: f.title, spec: f.spec, kind: f.kind, priority: Number(f.priority ?? 0), estimate: f.estimate ? Number(f.estimate) : null, due_date: f.due_date || null,
        assignee_id: f.assignee_id || null, project_id: f.project_id || null, milestone_id: f.milestone_id || null, cycle_id: f.cycle_id || null, label_ids: labels,
        ...(f.parent_id && { parent_id: f.parent_id }),
      });
      created();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const t = tracker;
  const milestones = t?.projects.find((p) => p.id === project)?.milestones ?? [];
  return (
    <Dialog title="New ticket" onClose={close}>
      <form onSubmit={submit}>
        <div className="kind" role="radiogroup" aria-label="Kind">
          <label><input type="radio" name="kind" value="task" defaultChecked /> Task</label>
          <label><input type="radio" name="kind" value="epic" /> Epic</label>
        </div>
        <label>
          Title <input name="title" required maxLength={200} autoFocus />
        </label>
        <label>
          Spec <textarea name="spec" rows={6} />
          <span className="hint">For an epic: the goal. A planner agent splits it into child tickets and follows their handoffs.</span>
        </label>
        <div className="fields">
          <select name="priority" aria-label="Priority" defaultValue="0">
            {[0, ...PRIORITY_ORDER.slice(0, 4)].map((p) => <option key={p} value={p}>{PRIORITIES[p]}</option>)}
          </select>
          <select name="assignee_id" aria-label="Assignee" defaultValue="">
            <option value="">No assignee</option>
            {t?.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select name="project_id" aria-label="Project" value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">No project</option>
            {t?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {milestones.length > 0 && (
            <select name="milestone_id" aria-label="Milestone" defaultValue="">
              <option value="">No milestone</option>
              {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <select name="cycle_id" aria-label="Cycle" defaultValue={defaults.cycle_id ?? ""}>
            <option value="">No cycle</option>
            {t?.cycles.filter((c) => c.state !== "past").map((c) => <option key={c.id} value={c.id}>{cycleName(c)} ({c.state})</option>)}
          </select>
          <select name="estimate" aria-label="Estimate" defaultValue="">
            <option value="">No estimate</option>
            {ESTIMATES.map((n) => <option key={n} value={n}>{n} {n === 1 ? "point" : "points"}</option>)}
          </select>
          <input type="date" name="due_date" aria-label="Due date" title="Due date" />
          <select name="parent_id" aria-label="Parent epic" defaultValue="">
            <option value="">No parent epic</option>
            {tickets.filter((x) => x.kind === "epic" && (x.status === "todo" || x.status === "running")).map((x) => <option key={x.id} value={x.id}>{x.key} {x.title}</option>)}
          </select>
        </div>
        {!!t?.labels.length && (
          <fieldset className="label-pick">
            <legend className="muted">Labels</legend>
            {t.labels.map((l) => (
              <label key={l.id} className="check"><input type="checkbox" name="label_ids" value={l.id} /> {l.name}</label>
            ))}
          </fieldset>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn primary">Create ticket</button>
        </div>
      </form>
    </Dialog>
  );
}
