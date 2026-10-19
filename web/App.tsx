import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "./auth-client.ts";
import { CyclePage, Cycles } from "./Cycles.tsx";
import { Issues, Popover } from "./Filters.tsx";
import { Improvement } from "./Improvement.tsx";
import { Palette } from "./Palette.tsx";
import { ProjectPage, Projects } from "./Projects.tsx";
import { Properties } from "./Properties.tsx";
import { Settings } from "./Settings.tsx";
import { TicketView } from "./TicketView.tsx";
import { UsagePage } from "./Usage.tsx";
import { Views } from "./Views.tsx";
import { Wiki } from "./Wiki.tsx";
import { Alert, DateInput, Dialog, Icon, Loading, api, errorText, useApi, useTheme, useWorkspaceEvents, type Ticket } from "./ui.tsx";
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

// The north-star mark: long cardinal rays, short diagonals, on a north-blue tile. Inline so it needs no asset.
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        {/* ponytail: fixed id, only one Mark is ever on screen (landing or sidebar) */}
        <linearGradient id="polaris-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#5b86ff" />
          <stop offset="1" stopColor="#2f5bea" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#polaris-mark)" />
      <path d="M16 10.4 17.3 14.7 21.6 16 17.3 17.3 16 21.6 14.7 17.3 10.4 16 14.7 14.7Z" fill="var(--star)" opacity=".55" transform="rotate(45 16 16)" />
      <path d="M16 4 17.6 14.4 28 16 17.6 17.6 16 28 14.4 17.6 4 16 14.4 14.4Z" fill="var(--star)" />
    </svg>
  );
}

// Unauthenticated screens: brand panel + the form.
function Landing({ children }: { children: ReactNode }) {
  return (
    <div className="landing">
      <div className="brand">
        <div className="aurora" aria-hidden="true" />
        <div className="stars" aria-hidden="true" />
        <Mark />
        <div className="wordmark">Polaris</div>
        <p className="tagline">A fixed point while your agents work: tickets in, reviewed diffs out.</p>
        <div className="brand-rule" aria-hidden="true" />
      </div>
      {children}
    </div>
  );
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
    setError(error ? errorText(error, error.status) : ""); // e.g. "Sign-up is closed: this Polaris already has an owner (…)"
  }

  return (
    <Landing>
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
        <Alert error={error} />
        <button className="btn primary">{mode === "in" ? "Sign in" : "Create account"}</button>
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
    </Landing>
  );
}

function CreateWorkspace() {
  const [error, setError] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    const { name } = fields(e);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const { error } = await authClient.organization.create({ name, slug });
    setError(error ? errorText(error, error.status) : "");
  }

  return (
    <Landing>
      <form className="card" onSubmit={submit}>
        <h1>Create a workspace</h1>
        <p className="muted">Tickets, runs and provider keys live in a workspace.</p>
        <label>
          Name <input name="name" required autoFocus />
        </label>
        <Alert error={error} />
        <button className="btn primary">Create</button>
      </form>
    </Landing>
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
  // Every ticket change in the workspace (a run starting or ending, a planner's new child, the CLI, another tab) pings the
  // stream; a focus reload covers a stream that was down meanwhile.
  useWorkspaceEvents("ticket", reload);
  useEffect(() => {
    addEventListener("focus", reload);
    return () => removeEventListener("focus", reload);
  }, [reload]);
  return [tickets, reload] as const;
}

// Unread notifications (runs that need review or failed, others' comments); a click opens the ticket and reads that one.
type Notification = { id: string; kind: "review" | "failed" | "comment"; text: string; created_at: number; number: number; key: string };
function Bell({ open }: { open: (n: number) => void }) {
  const [list, setList] = useState<Notification[]>([]);
  const [shown, setShown] = useState(false);
  const reload = useCallback(() => api<Notification[]>("/api/notifications").then(setList, () => {}), []);
  useEffect(() => void reload(), [reload]);
  useWorkspaceEvents("notification", reload);
  const read = (ids?: string[]) => api("/api/notifications/read", "POST", ids ? { ids } : {}).then(reload, () => {});
  return (
    <span className="menu-anchor">
      <button className="btn icon-btn" aria-label={`Notifications${list.length ? ` (${list.length} unread)` : ""}`} aria-expanded={shown} onClick={() => setShown((s) => !s)}>
        <Icon name="bell" />{list.length > 0 && <span className="count">{list.length > 9 ? "9+" : list.length}</span>}
      </button>
      {shown && (
        <Popover close={() => setShown(false)}>
          {list.length === 0 && <p className="muted item">Nothing new.</p>}
          {list.map((n) => (
            <button key={n.id} className={`item notif ${n.kind}`} onClick={() => (setShown(false), read([n.id]), open(n.number))}>
              <span className={`dot ${n.kind}`} aria-hidden="true" /> <span>{n.text}</span>
            </button>
          ))}
          {list.length > 0 && <button className="item muted" onClick={() => (setShown(false), read())}>Mark all read</button>}
        </Popover>
      )}
    </span>
  );
}

// Personal preferences and sign-out: one menu at the foot of the sidebar instead of always-on controls.
function Account({ email }: { email: string }) {
  const [theme, setTheme] = useTheme();
  const [shown, setShown] = useState(false);
  return (
    <span className="menu-anchor account">
      <button className="btn account-btn" aria-label="Account" aria-expanded={shown} onClick={() => setShown((s) => !s)}>
        <span className="avatar" aria-hidden="true">{email[0]?.toUpperCase()}</span>
        <span className="email">{email}</span>
      </button>
      {shown && (
        <Popover close={() => setShown(false)}>
          <p className="item muted email" title={email}>{email}</p>
          <div className="item">
            Theme <span className="grow" />
            <span className="seg" role="group" aria-label="Theme">
              {(["system", "light", "dark"] as const).map((t) => (
                <button key={t} aria-pressed={theme === t} onClick={() => (setTheme(t), setShown(false))}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </span>
          </div>
          <button className="item" onClick={() => authClient.signOut()}>Sign out</button>
        </Popover>
      )}
    </span>
  );
}

// Until the repository is saved no agent can run: say so on the board, with the way there.
function SetupBanner({ go }: { go: (to: string) => void }) {
  const { data } = useApi<{ configured: boolean }>("/api/settings");
  if (!data || data.configured) return null;
  const link = (to: string, label: string) => <a href={to} onClick={(e) => (e.preventDefault(), go(to))}>{label}</a>;
  return (
    <p className="setup-banner">
      <strong>Finish setup</strong> to let agents run: 1. {link("/settings/general", "Repository and test command")} 2. {link("/settings/models", "Model")}
    </p>
  );
}

// Daily work first, then what the agents do; Settings sits apart at the bottom. The route stays /improvement.
const NAV: { label?: string; pages: [string, string][] }[] = [
  { pages: [["", "Board"], ["projects", "Projects"], ["cycles", "Cycles"], ["views", "Views"], ["wiki", "Wiki"]] },
  { label: "Agents", pages: [["usage", "Usage"], ["improvement", "Learning"]] },
];
const PAGES = [...NAV.flatMap((g) => g.pages), ["settings", "Settings"]];

function Dashboard({ email }: { email: string }) {
  const { data: workspace } = authClient.useActiveOrganization();
  const { tracker, reload: reloadTracker } = useTracker();
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
  useEffect(() => void (tracker && reload()), [tracker]); // a renamed or deleted label, project or cycle shows on the cards
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
          <Mark />
          <strong>{name}</strong>
        </header>
        <button className="btn palette-btn" onClick={() => setPalette(true)}>Search or jump… <kbd>⌘K</kbd></button>
        <nav aria-label="Main">
          {NAV.map((g, i) => [
            g.label && <div key={`g${i}`} className="nav-group">{g.label}</div>,
            g.pages.map(([p, label]) => [
              link(`/${p}`, label, section === p && !(p === "cycles" && sub === "current")),
              p === "cycles" && current && link("/cycles/current", "Current cycle", section === "cycles" && sub === "current", "sub"),
            ]),
          ])}
        </nav>
        <div className="side-bottom">
          <nav aria-label="Workspace">{link("/settings", "Settings", section === "settings")}</nav>
          <Account email={email} />
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <h1>{number ? (ticket?.key ?? "Ticket") : sub && section === "projects" ? "Project" : sub && section === "cycles" ? (sub === "current" ? "Current cycle" : "Cycle") : (page ?? "Board")}</h1>
          <span className="grow" />
          <Bell open={open} />
          <button className="btn primary" onClick={() => setCreating(true)}>New ticket</button>
        </div>
        <main>
          {section === "settings" ? (
            <Settings tab={sub} go={go} />
          ) : section === "usage" ? (
            <UsagePage />
          ) : section === "improvement" ? (
            <Improvement open={open} changed={reload} />
          ) : section === "wiki" ? (
            <Wiki />
          ) : section === "projects" ? (
            sub ? <ProjectPage id={sub} go={go} open={open} tick={tickets} /> : <Projects go={go} />
          ) : section === "cycles" ? (
            sub ? <CyclePage id={sub} go={go} open={open} tick={tickets} /> : <Cycles go={go} />
          ) : section === "views" ? (
            <Views go={go} />
          ) : number ? (
            ticket ? (
              <div className="ticket-page">
                <TicketView ticket={ticket} reload={reload} close={() => go("/")} open={open} />
                <Properties ticket={ticket} tickets={tickets ?? []} reload={reload} />
              </div>
            ) : tickets ? <p className="muted pad">Ticket not found.</p> : <Loading />
          ) : (
            <>
              <SetupBanner go={go} />
              <Issues search={search} go={go} all={tickets} open={open} />
            </>
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
        title: f.title, spec: f.spec, kind: f.kind, test_command: f.test_command?.trim() || null, priority: Number(f.priority ?? 0), estimate: f.estimate ? Number(f.estimate) : null, due_date: f.due_date || null,
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
        <label>
          Test command (optional) <input name="test_command" className="mono" spellCheck={false} maxLength={2000} />
          <span className="hint">Overrides the workspace's for this ticket; empty = workspace default.</span>
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
          <DateInput name="due_date" aria-label="Due date" title="Due date" placeholder="Due date" />
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
        <Alert error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn primary">Create ticket</button>
        </div>
      </form>
    </Dialog>
  );
}
