import { useCallback, useEffect, useState, type FormEvent } from "react";
import { authClient } from "./auth-client.ts";
import { Board } from "./Board.tsx";
import { Improvement } from "./Improvement.tsx";
import { Settings } from "./Settings.tsx";
import { TicketView } from "./TicketView.tsx";
import { UsagePage } from "./Usage.tsx";
import { Dialog, api, useTheme, type Ticket, type Theme } from "./ui.tsx";

export function App() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <p className="center muted">Loading…</p>;
  if (!session) return <AuthForm />;
  if (!session.session.activeOrganizationId) return <CreateWorkspace />;
  return <Dashboard email={session.user.email} />;
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

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const go = (to: string) => {
    history.pushState(null, "", to);
    setPath(to);
  };
  return [path, go] as const;
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

function Dashboard({ email }: { email: string }) {
  const { data: workspace } = authClient.useActiveOrganization();
  const [theme, setTheme] = useTheme();
  const [path, go] = usePath();
  const [tickets, reload] = useTickets();
  const [creating, setCreating] = useState(false);

  // "C" opens the new-ticket dialog unless the user is typing or a dialog is open.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key.toLowerCase() !== "c" || e.metaKey || e.ctrlKey || e.altKey || t.closest("input, textarea, select, [contenteditable], [role=dialog]")) return;
      e.preventDefault();
      setCreating(true);
    };
    addEventListener("keydown", k);
    return () => removeEventListener("keydown", k);
  }, []);

  const number = /^\/t\/(\d+)$/.exec(path)?.[1];
  const ticket = number ? tickets?.find((t) => t.number === Number(number)) : undefined;
  const name = workspace?.name ?? "…";
  const settings = path === "/settings";
  const usage = path === "/usage";
  const improve = path === "/improvement";

  return (
    <div className="shell">
      <aside>
        <header className="ws">
          <span className="avatar" aria-hidden="true">{name[0]?.toUpperCase()}</span>
          <strong>{name}</strong>
        </header>
        <nav aria-label="Main">
          <a href="/" className={number || settings || usage || improve ? "" : "active"} onClick={(e) => (e.preventDefault(), go("/"))}>Board</a>
          <a href="/usage" className={usage ? "active" : ""} onClick={(e) => (e.preventDefault(), go("/usage"))}>Usage</a>
          <a href="/improvement" className={improve ? "active" : ""} onClick={(e) => (e.preventDefault(), go("/improvement"))}>Improvement</a>
          <a href="/settings" className={settings ? "active" : ""} onClick={(e) => (e.preventDefault(), go("/settings"))}>Settings</a>
        </nav>
        <div className="side-bottom">
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
          <h1>{number ? (ticket?.key ?? "Ticket") : settings ? "Settings" : usage ? "Usage" : improve ? "Improvement" : "Board"}</h1>
          <button className="btn primary" onClick={() => setCreating(true)}>New ticket</button>
        </div>
        <main>
          {settings ? (
            <Settings />
          ) : usage ? (
            <UsagePage />
          ) : improve ? (
            <Improvement />
          ) : number ? (
            ticket ? <TicketView ticket={ticket} reload={reload} close={() => go("/")} open={(n) => go(`/t/${n}`)} /> : <p className="muted pad">{tickets ? "Ticket not found." : "Loading…"}</p>
          ) : (
            <>
              <Board tickets={tickets} open={(t) => go(`/t/${t.number}`)} />
              {tickets?.length === 0 && <p className="center muted">No tickets yet. Press C to create one.</p>}
            </>
          )}
        </main>
      </div>
      {creating && <NewTicket close={() => setCreating(false)} created={() => (reload(), setCreating(false))} />}
    </div>
  );
}

function NewTicket({ close, created }: { close: () => void; created: () => void }) {
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    const f = fields(e);
    try {
      await api("/api/tickets", "POST", { title: f.title, spec: f.spec, kind: f.kind });
      created();
    } catch (e) {
      setError((e as Error).message);
    }
  }
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
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn primary">Create ticket</button>
        </div>
      </form>
    </Dialog>
  );
}
