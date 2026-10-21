import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "./auth-client.ts";
import { Chat, ChatsPage, type ChatContext, type ChatInfo } from "./Chat.tsx";
import { CyclePage, Cycles } from "./Cycles.tsx";
import { Issues, Popover } from "./Filters.tsx";
import { List } from "./List.tsx";
import { Improvement } from "./Improvement.tsx";
import { Palette } from "./Palette.tsx";
import { ProjectPage, Projects } from "./Projects.tsx";
import { Properties } from "./Properties.tsx";
import { Settings } from "./Settings.tsx";
import { TicketView } from "./TicketView.tsx";
import { UsagePage } from "./Usage.tsx";
import { Views } from "./Views.tsx";
import { Wiki } from "./Wiki.tsx";
import { Alert, AppearanceProvider, DateInput, Dialog, Icon, Loading, Mark, api, errorText, useAppearance, useWorkspaceEvents, type IconName, type Ticket } from "./ui.tsx";
import { cycleName, ESTIMATES, PRIORITIES, PRIORITY_ORDER, TrackerProvider, useTracker, type ProjectRef } from "./tracker.tsx";

export function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <p className="center muted">Loading…</p>;
  if (!session) return <AuthForm />;
  if (!session.session.activeOrganizationId) return <CreateWorkspace />;
  return (
    <AppearanceProvider>
      <TrackerProvider>
        <Dashboard email={session.user.email} />
      </TrackerProvider>
    </AppearanceProvider>
  );
}

function fields(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
}

// Unauthenticated screens: the brand over the form, on the night sky.
function Landing({ children }: { children: ReactNode }) {
  return (
    // data-palette re-declares the palette's tokens here, where color-scheme is dark: tokens resolved at the root would stay light.
    <div className="landing" data-palette={document.documentElement.dataset.palette || "black"}>
      <div className="aurora" aria-hidden="true" />
      <div className="stars" aria-hidden="true" />
      <div className="landing-col">
        <Mark />
        <div className="wordmark">Polaris</div>
        <p className="tagline">A fixed point while your agents work: tickets in, reviewed diffs out.</p>
        {children}
      </div>
    </div>
  );
}

function AuthForm() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState("");
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState("");

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
          Email <input name="email" type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
        {mode === "in" && (forgot ? (
          // Polaris runs on your machine and sends no email: whoever can run commands where it runs resets the password.
          <p className="forgot muted" role="status">
            On the machine running Polaris, in its folder, run <code>npm run reset-password -- {email || "you@example.com"}</code>. It asks for a new
            password and signs that account out everywhere.
          </p>
        ) : <button type="button" className="link" onClick={() => setForgot(true)}>Forgot your password?</button>)}
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
        <p className="muted">Projects, their tickets, and provider keys live in a workspace.</p>
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
function Bell({ open }: { open: (key: string) => void }) {
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
            <button key={n.id} className={`item notif ${n.kind}`} onClick={() => (setShown(false), read([n.id]), open(n.key))}>
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
// The sidebar's header: the current project (and the workspace under it); the menu switches to another project's board or
// starts a new one.
function ProjectSwitcher({ current, workspace, go }: { current: ProjectRef | undefined; workspace: string; go: (to: string) => void }) {
  const { tracker } = useTracker();
  const [shown, setShown] = useState(false);
  const to = (path: string) => (setShown(false), go(path));
  return (
    <span className="menu-anchor switcher">
      <button className="ws" aria-label="Switch project" aria-expanded={shown} onClick={() => setShown(!shown)}>
        <Mark />
        <span className="grow">
          <strong>{current?.name ?? "No project yet"}</strong>
          <span className="muted">{workspace}</span>
        </span>
        <Icon name="chevrons" size={14} />
      </button>
      {shown && (
        <Popover close={() => setShown(false)}>
          {tracker?.projects.map((p) => (
            <button key={p.id} className="item" aria-current={p.id === current?.id || undefined} onClick={() => to(`/p/${p.key}`)}>
              <span className="key mono muted">{p.key}</span><span className="grow">{p.name}</span>{p.id === current?.id && <Icon name="check" size={14} />}
            </button>
          ))}
          <button className="item" onClick={() => to("/projects?new")}><Icon name="plus" size={14} /> New project</button>
        </Popover>
      )}
    </span>
  );
}

function Account({ email }: { email: string }) {
  const { appearance, set } = useAppearance();
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
                <button key={t} aria-pressed={appearance.mode === t} onClick={() => (set({ mode: t }), setShown(false))}>{t[0].toUpperCase() + t.slice(1)}</button>
              ))}
            </span>
          </div>
          <button className="item" onClick={() => authClient.signOut()}>Sign out</button>
        </Popover>
      )}
    </span>
  );
}

// Workspace-wide pages; Settings sits apart at the bottom. The route stays /improvement.
const PAGES: Record<string, string> = {
  "my-issues": "My issues", reviews: "Reviews", agent: "Agent", chats: "Chats", issues: "All issues", projects: "Projects", views: "Views", usage: "Usage", improvement: "Learning", settings: "Settings",
};
// A project's pages: /p/KEY (the board), /p/KEY/cycles[/id|current], /p/KEY/wiki, /p/KEY/overview.
const PROJECT_PAGES: [string, string, IconName][] = [["", "Board", "board"], ["cycles", "Cycles", "cycle"], ["wiki", "Wiki", "book"], ["overview", "Overview", "home"]];
const PAGE_ICONS: Record<string, IconName> = { projects: "box", issues: "layers", views: "views", usage: "chart", improvement: "bulb" };

function Dashboard({ email }: { email: string }) {
  const { data: workspace } = authClient.useActiveOrganization();
  const { tracker, reload: reloadTracker } = useTracker();
  const [loc, go] = usePath();
  const [tickets, reload] = useTickets();
  const [creating, setCreating] = useState(false);
  const [palette, setPalette] = useState(false);
  const [chat, setChat] = useState(() => {
    try {
      return localStorage.getItem("chat-open") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("chat-open", chat ? "1" : "0");
    } catch {}
  }, [chat]);
  // The chat the panel has open in each project (the Agent page's is in the URL, and becomes the panel's too).
  const [panelChats, setPanelChats] = useState<Record<string, string | null>>(() => {
    try {
      return JSON.parse(localStorage.getItem("chats") ?? "{}");
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("chats", JSON.stringify(panelChats));
    } catch {}
  }, [panelChats]);

  // "C" opens the new-ticket dialog unless the user is typing or a dialog is open; Cmd/Ctrl+K the command palette and
  // Cmd/Ctrl+J the chat panel (Notion's AI shortcut), anywhere.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") return e.preventDefault(), setPalette((p) => !p);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") return e.preventDefault(), setChat((c) => !c);
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
  const [, section = "", sub, rest] = path.split("/");
  const pageChat = section === "agent" ? (sub ?? null) : null;
  useEffect(reloadTracker, [path]); // pickers pick up labels/projects/cycles made elsewhere (e.g. by a planner)
  useEffect(() => void (tracker && reload()), [tracker]); // a renamed or deleted label, project or cycle shows on the cards
  const ticket = section === "t" && sub ? tickets?.find((t) => t.key === sub.toUpperCase()) : undefined;
  // The project the page is about: the route's, or the open ticket's.
  const project = section === "p" ? tracker?.projects.find((p) => p.key === sub?.toUpperCase()) : ticket ? tracker?.projects.find((p) => p.id === ticket.project_id) : undefined;
  const page = section === "p" ? (rest ?? "") : undefined;
  // The project the member works in (the switcher's): the one whose page is open, else the last one opened (saved per
  // workspace), else the first. Pages that belong to no project (My issues, Agent…) keep it.
  // Opening a chat (its URL, or the panel's picker) makes the chat's project current too.
  const [opened, setOpened] = useState<string | null>(null);
  const current = tracker?.projects.find((p) => p.id === (project?.id ?? opened ?? tracker.current)) ?? tracker?.projects[0];
  const makeCurrent = (id: string) => {
    if (id === (opened ?? tracker?.current)) return;
    setOpened(id);
    api("/api/me/project", "PUT", { project_id: id }).catch(() => {}); // ponytail: unsaved, it is still current in this tab
  };
  useEffect(() => void (project && makeCurrent(project.id)), [project?.id]);
  const chatOpened = (chatId: string, projectId: string) => {
    makeCurrent(projectId);
    setPanelChats((m) => (m[projectId] === chatId ? m : { ...m, [projectId]: chatId }));
  };
  const panelChat = (current && panelChats[current.id]) ?? null;
  // The current project's chats, newest first: the sidebar's recent ones, the Chats page and the panel's picker.
  const [chatList, setChatList] = useState<{ project: string; list: ChatInfo[] }>();
  const listChats = useCallback(() => {
    const id = current?.id;
    if (id) void api<ChatInfo[]>(`/api/chats?project_id=${id}`).then((list) => setChatList({ project: id, list }), () => {});
  }, [current?.id]);
  useEffect(listChats, [listChats]);
  const chats = chatList && chatList.project === current?.id ? chatList.list : [];
  // "/": the current project's board, or Projects to create one.
  useEffect(() => {
    if (path === "/" && tracker) go(current ? `/p/${current.key}` : "/projects", true);
  }, [path, tracker]);
  const name = workspace?.name ?? "…";
  const open = (key: string) => go(`/t/${key}`);
  const currentCycle = project && tracker?.cycles.find((c) => c.project_id === project.id && c.state === "current");
  const cycleId = page === "cycles" ? (path.split("/")[4] === "current" ? currentCycle?.id : path.split("/")[4]) : undefined;
  const cycle = cycleId ? tracker?.cycles.find((c) => c.id === cycleId) : undefined;
  // New tickets start in the page's project (and cycle), else the current one.
  const defaults = { project_id: project?.id ?? current?.id, cycle_id: cycle?.id };
  // What the chat knows you're looking at: the ticket, cycle or project page.
  const chatContext: ChatContext = ticket ? { ticket: ticket.key } : cycle ? { cycle: cycle.id } : project ? { project: project.id } : {};
  const chatLabel = ticket ? ticket.key : cycle ? cycleName(cycle) : project ? project.name : null;
  const reviews = tickets?.filter((t) => t.status === "review") ?? [];
  const title = ticket ? ticket.key : section === "t" ? "Ticket" : project && page !== undefined
    ? `${project.name} · ${page === "cycles" && path.split("/")[4] ? (cycle ? cycleName(cycle) : "Cycle") : PROJECT_PAGES.find(([p]) => p === page)?.[1] ?? ""}`
    : pageChat ? (chats.find((c) => c.id === pageChat)?.title ?? "Agent") : section === "chats" && current ? `${current.name} · Chats` : (PAGES[section] ?? "");
  const link = (to: string, label: ReactNode, active: boolean, cls = "", icon?: IconName) => (
    <a key={to} href={to} className={`${cls}${active ? " active" : ""}`.trim()} aria-current={active ? "page" : undefined} onClick={(e) => (e.preventDefault(), go(to))}>
      {icon && <Icon name={icon} size={15} />}{label}
    </a>
  );

  return (
    <div className={`shell${chat && section !== "agent" ? " chat-open" : ""}`}>
      <aside>
        <ProjectSwitcher current={current} workspace={name} go={go} />
        <button className="btn palette-btn" onClick={() => setPalette(true)}><Icon name="search" size={14} /> Search or jump… <kbd>⌘K</kbd></button>
        <nav aria-label="Main">
          {link("/my-issues", "My issues", section === "my-issues", "", "user")}
          {link("/reviews", <>Reviews{reviews.length > 0 && <span className="count">{reviews.length}</span>}</>, section === "reviews", "", "review")}
          {link("/agent", "Agent", section === "agent" && !pageChat, "", "chat")}
          {chats.slice(0, 5).map((c) => link(`/agent/${c.id}`, <span className="ellipsis" title={c.title}>{c.title}</span>, pageChat === c.id, "sub recent"))}
          {chats.length > 0 && link("/chats", "All chats", section === "chats", "sub recent")}
          <div className="nav-group">Workspace</div>
          {(["projects", "issues", "views"] as const).map((p) => link(`/${p}`, PAGES[p], section === p, "", PAGE_ICONS[p]))}
          <details className="nav-more" open={section === "usage" || section === "improvement" || undefined}>
            <summary>More</summary>
            {(["usage", "improvement"] as const).map((p) => link(`/${p}`, PAGES[p], section === p, "sub", PAGE_ICONS[p]))}
          </details>
          <div className="nav-group">Your projects</div>
          {tracker?.projects.map((p) => (
            <details key={p.id} className="nav-project" open={p.id === current?.id || undefined}>
              <summary><span className="key mono">{p.key}</span> {p.name}</summary>
              {PROJECT_PAGES.map(([pg, label, icon]) => [
                link(`/p/${p.key}${pg && `/${pg}`}`, label, section === "p" && p.id === project?.id && page === pg && !(pg === "cycles" && path.split("/")[4] === "current"), "sub", icon),
                pg === "cycles" && tracker.cycles.some((c) => c.project_id === p.id && c.state === "current") &&
                  link(`/p/${p.key}/cycles/current`, "Current cycle", section === "p" && p.id === project?.id && path.split("/")[4] === "current", "sub sub2", "clock"),
              ])}
            </details>
          ))}
          {tracker && !tracker.projects.length && link("/projects", "Create a project", false, "sub muted", "plus")}
        </nav>
        <div className="side-bottom">
          <Account email={email} />
          <a href="/settings" className={`settings-link${section === "settings" ? " active" : ""}`} aria-label="Settings" title="Settings" aria-current={section === "settings" ? "page" : undefined}
            onClick={(e) => (e.preventDefault(), go("/settings"))}><Icon name="gear" /></a>
        </div>
      </aside>
      <div className="main">
        <div className="topbar">
          <h1>{title}</h1>
          <span className="grow" />
          <Bell open={open} />
          {pageChat && <button className="btn with-icon" onClick={() => go("/agent")}><Icon name="plus" size={14} /> New chat</button>}
          {!chat && section !== "agent" && <button className="btn with-icon" onClick={() => setChat(true)} title="⌘J"><Icon name="chat" size={14} /> Ask Polaris</button>}
          <button className="btn primary with-icon" onClick={() => setCreating(true)} disabled={!tracker?.projects.length} title={tracker?.projects.length ? "New ticket (C)" : "Create a project first"}><Icon name="edit" size={14} /> New ticket</button>
        </div>
        <main>
          {section === "settings" ? (
            <Settings tab={sub} go={go} />
          ) : section === "usage" ? (
            <UsagePage />
          ) : section === "improvement" ? (
            <Improvement open={open} changed={reload} />
          ) : section === "agent" ? (
            // The same conversations as the ⌘J panel, with the room to read them.
            <Chat variant="page" id={pageChat} pick={(c) => go(c ? `/agent/${c}` : "/agent", !c)} opened={chatOpened} chats={chats} listed={listChats}
              context={{}} label={null} project={current} tickets={tickets ?? []} go={go} filed={reload} />
          ) : section === "chats" ? (
            <ChatsPage chats={chats} listed={listChats} go={go} />
          ) : section === "projects" ? (
            <Projects go={go} creating={search === "new"} />
          ) : section === "views" ? (
            <Views go={go} />
          ) : section === "my-issues" ? (
            <Issues base="/my-issues" scope="assignee=me" search={search} go={go} all={tickets && tracker && tickets.filter((t) => t.assignee?.id === tracker.me)} open={open} />
          ) : section === "issues" ? (
            <Issues base="/issues" scope="" search={search} go={go} all={tickets} open={open} />
          ) : section === "reviews" ? (
            <>
              {tickets && !reviews.length && <p className="center muted">Nothing waits for review.</p>}
              {reviews.length > 0 && <List tickets={reviews} group="project" open={(t) => open(t.key)} />}
            </>
          ) : section === "p" ? (
            !tracker ? <Loading /> : !project ? <p className="muted pad">Project not found.</p>
            : page === "" ? <Issues key={project.id} base={`/p/${project.key}`} scope={`project=${project.id}`} search={search} go={go} all={tickets && tickets.filter((t) => t.project_id === project.id)} open={open} />
            : page === "cycles" ? (path.split("/")[4]
              ? <CyclePage id={path.split("/")[4] === "current" ? (currentCycle?.id ?? "") : path.split("/")[4]} project={project} go={go} open={open} tick={tickets} />
              : <Cycles key={project.id} project={project} go={go} />)
            : page === "wiki" ? <Wiki key={project.id} project={project} />
            : page === "overview" ? <ProjectPage key={project.id} id={project.id} go={go} />
            : <p className="muted pad">Page not found.</p>
          ) : section === "t" ? (
            ticket ? (
              <div className="ticket-page">
                <TicketView ticket={ticket} reload={reload} close={() => go(`/p/${ticket.project.key}`)} open={open} />
                <Properties ticket={ticket} tickets={tickets ?? []} reload={reload} />
              </div>
            ) : tickets ? <p className="muted pad">Ticket not found.</p> : <Loading />
          ) : null}
        </main>
      </div>
      {chat && section !== "agent" && <Chat id={panelChat} pick={(c) => current && setPanelChats((m) => ({ ...m, [current.id]: c }))} opened={chatOpened} chats={chats} listed={listChats} context={chatContext} label={chatLabel} project={current} tickets={tickets ?? []} go={go} filed={reload} close={() => setChat(false)} />}
      {creating && !!tracker?.projects.length && <NewTicket tickets={tickets ?? []} defaults={{ ...defaults, project_id: defaults.project_id ?? tracker.projects[0].id }} close={() => setCreating(false)} created={() => (reload(), setCreating(false))} />}
      {palette && <Palette tickets={tickets ?? []} go={go} create={() => setCreating(true)} close={() => setPalette(false)} />}
    </div>
  );
}

// M11: the tracker fields are optional (empty selects mean "none"); the project is not: it is the repository the agents work in.
function NewTicket({ tickets, defaults, close, created }: { tickets: Ticket[]; defaults: { project_id: string; cycle_id?: string }; close: () => void; created: () => void }) {
  const { tracker } = useTracker();
  const [error, setError] = useState("");
  const [project, setProject] = useState(defaults.project_id);
  async function submit(e: FormEvent<HTMLFormElement>) {
    const labels = new FormData(e.currentTarget).getAll("label_ids");
    const f = fields(e);
    try {
      await api("/api/tickets", "POST", {
        title: f.title, spec: f.spec, kind: f.kind, test_command: f.test_command?.trim() || null, priority: Number(f.priority ?? 0), estimate: f.estimate ? Number(f.estimate) : null, due_date: f.due_date || null,
        assignee_id: f.assignee_id || null, project_id: f.project_id, milestone_id: f.milestone_id || null, cycle_id: f.cycle_id || null, label_ids: labels,
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
          <span className="hint">Overrides the project's for this ticket; empty = project default.</span>
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
            {t?.projects.map((p) => <option key={p.id} value={p.id}>{p.key} {p.name}</option>)}
          </select>
          {milestones.length > 0 && (
            <select name="milestone_id" aria-label="Milestone" defaultValue="">
              <option value="">No milestone</option>
              {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <select key={project} name="cycle_id" aria-label="Cycle" defaultValue={defaults.cycle_id ?? ""}>
            <option value="">No cycle</option>
            {t?.cycles.filter((c) => c.project_id === project && c.state !== "past").map((c) => <option key={c.id} value={c.id}>{cycleName(c)} ({c.state})</option>)}
          </select>
          <select name="estimate" aria-label="Estimate" defaultValue="">
            <option value="">No estimate</option>
            {ESTIMATES.map((n) => <option key={n} value={n}>{n} {n === 1 ? "point" : "points"}</option>)}
          </select>
          <DateInput name="due_date" aria-label="Due date" title="Due date" placeholder="Due date" />
          <select key={`e${project}`} name="parent_id" aria-label="Parent epic" defaultValue="">
            <option value="">No parent epic</option>
            {tickets.filter((x) => x.project_id === project && x.kind === "epic" && (x.status === "todo" || x.status === "running")).map((x) => <option key={x.id} value={x.id}>{x.key} {x.title}</option>)}
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
