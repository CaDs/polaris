import { useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, Confirm, DateField, DateInput, Icon, Loading, api, useApi } from "./ui.tsx";
import { Bar, ByStatus, useTracker, type Member, type Progress } from "./tracker.tsx";

type Milestone = { id: string; name: string; target_date: string | null; position: number; progress: Progress };
type Repo = { repo_path: string; base_branch: string; setup_command: string; test_command: string; protected_paths: string; protected_mode: string; image: string; sandbox_cpus: number; sandbox_memory_gb: number; sandbox_network: string };
type Project = Repo & {
  updated_at: number; id: string; key: string; name: string; description: string; status: string; lead: Member | null; target_date: string | null; progress: Progress; milestones: Milestone[];
};
// A key suggested from the name: its first letters, as the server allows (2-5 capitals or digits, a capital first).
const keyFor = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 3);
const STATUSES = ["planned", "started", "paused", "completed", "canceled"];

export function Projects({ go, creating = false }: { go: (to: string) => void; creating?: boolean }) {
  const { data, error, setError, reload } = useApi<Project[]>("/api/projects");
  const { reload: reloadTracker } = useTracker();
  const [key, setKey] = useState<string | null>(null); // null: follows the name
  const [name, setName] = useState("");
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      const p = await api<Project>("/api/projects", "POST", f);
      reloadTracker();
      go(`/p/${p.key}`);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="page">
      {data?.length === 0 && <p className="muted">No projects yet. A project is one git repository: its board, cycles and wiki, and the tickets agents work on in it.</p>}
      {/* Rendered once the list is in, so "open" is settled before anyone can click it. */}
      {data && <details className="new-project" open={data.length === 0 || creating || undefined}>
        <summary className="btn primary">New project</summary>
        <form onSubmit={create}>
          <div className="row">
            <label className="grow">Name <input name="name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>Key <input name="key" required className="mono narrow" maxLength={5} pattern="[A-Za-z][A-Za-z0-9]{1,4}" value={key ?? keyFor(name)} onChange={(e) => setKey(e.target.value.toUpperCase())} /></label>
          </div>
          <span className="hint">The key prefixes its tickets (KEY-12): 2-5 letters or digits.</span>
          <RepoFields />
          <Alert error={error} />
          <button className="btn primary">Create project</button>
        </form>
      </details>}
      {!!data?.length && (
        <div className="table-wrap">
          <table aria-label="Projects">
            <thead><tr><th>Name</th><th>Key</th><th>Status</th><th>Lead</th><th>Target</th><th>Progress</th><th>Milestones</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td><button className="link" onClick={() => go(`/p/${p.key}`)}>{p.name}</button></td>
                  <td className="mono muted">{p.key}</td>
                  <td><span className={`badge ps-${p.status}`}>{p.status}</span></td>
                  <td>{p.lead?.name ?? <span className="muted">—</span>}</td>
                  <td>{p.target_date ?? <span className="muted">—</span>}</td>
                  <td><Bar p={p.progress} /></td>
                  <td className="muted">{p.milestones.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// What POST /api/projects/inspect answers (server/inspect.ts): a state for the folder and, once it is a usable repository, its
// branches, protected-path candidates and command suggestions read from the base branch.
type Branch = { name: string; current: boolean; committed_at: number; subject: string };
type Candidate = { path: string; files: number; pattern: string | null; suggested: boolean };
type Suggestion = { value: string; why: string } | null;
type Inspect = {
  state: "not_found" | "not_a_repo" | "inside_repo" | "no_commits" | "ok"; root?: string; branches?: Branch[]; base_branch?: string; base_exists?: boolean;
  missing?: string[]; protected?: Candidate[]; setup_command?: Suggestion; test_command?: Suggestion;
};
async function inspect(repo_path: string, base_branch: string, check_paths: string[]): Promise<Inspect> {
  const res = await fetch("/api/projects/inspect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repo_path, base_branch, check_paths }) });
  const data = await res.json().catch(() => null);
  if (!data?.state) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}
const NOT_OK = {
  not_found: "This folder does not exist on the server. Check the path.",
  not_a_repo: "This folder is not a git repository. Run git init there, or pick the repository's folder.",
  no_commits: "This folder has no commits yet: commit something first.",
};
const ago = (t: number) => {
  const days = Math.round((t - Date.now()) / 86_400_000);
  if (Math.abs(days) < 1) return "today";
  return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(days, "day");
};
const OTHER = "\0other";
const listOf = (s: string) => s.split(",").map((p) => p.trim()).filter(Boolean);

// The repository a project works in; the server checks it (a repo root with commits, the base branch exists). Detects the
// repository as soon as the folder is set and reads suggestions (commands, protected paths) from the base branch, so the rest
// of the section waits for a usable repository. r: the saved project (its values are never overwritten, only suggested).
function RepoFields({ r }: { r?: Repo }) {
  const [path, setPath] = useState(r?.repo_path ?? "");
  const [branch, setBranch] = useState(r?.base_branch ?? ""); // "" = the checked-out branch
  const [other, setOther] = useState(false);
  const [info, setInfo] = useState<Inspect | null>(null);
  const [failed, setFailed] = useState("");
  const [setup, setSetup] = useState(r?.setup_command ?? "");
  const [test, setTest] = useState(r?.test_command ?? "");
  const [paths, setPaths] = useState(listOf(r?.protected_paths ?? ""));
  const [mode, setMode] = useState(r?.protected_mode ?? "add_only");
  const [adding, setAdding] = useState("");
  const typed = useRef({ setup: !!r, test: !!r, paths: !!r }); // a new project's fields follow the suggestions until typed in
  const seq = useRef(0);
  const joined = paths.join(",");

  const run = async (p: string, b: string) => {
    const n = ++seq.current;
    if (!p.trim()) return setInfo(null);
    try {
      const res = await inspect(p.trim(), b, listOf(joined));
      if (n !== seq.current) return;
      setInfo(res);
      setFailed("");
      if (res.state !== "ok") return;
      if (!typed.current.setup) setSetup(res.setup_command?.value ?? "");
      if (!typed.current.test) setTest(res.test_command?.value ?? "");
      if (!typed.current.paths) setPaths(res.protected!.filter((c) => c.suggested).map((c) => c.path));
    } catch (e) {
      if (n === seq.current) setFailed((e as Error).message);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => run(path, branch), 350);
    return () => clearTimeout(t);
  }, [path, branch, joined]);

  const ok = info?.state === "ok";
  const base = branch || info?.base_branch || "";
  const candidates = info?.protected ?? [];
  const shown = [...candidates, ...paths.filter((p) => !candidates.some((c) => c.path === p)).map((path) => ({ path, files: 0, pattern: null, suggested: false }))];
  const toggle = (p: string) => (typed.current.paths = true, setPaths(paths.includes(p) ? paths.filter((x) => x !== p) : [...paths, p]));
  const addPath = () => {
    const p = adding.trim();
    if (p && !paths.includes(p)) (typed.current.paths = true), setPaths([...paths, p]);
    setAdding("");
  };
  const warnings = ok
    ? [
        ...(info.missing ?? []).map((p) => `${p} isn't in this repository: it protects nothing.`),
        ...(!paths.length ? ["No protected paths: agents can change the tests that judge them."] : []),
        ...(!test.trim() ? ["No test command: every run passes the gate."] : []),
        ...(branch && info.base_exists === false ? [`The base branch ${branch} no longer exists in this repository.`] : []),
      ]
    : [];
  const suggest = (s: Suggestion | undefined, value: string, use: (v: string) => void, field: "setup" | "test") =>
    s && (r ? s.value !== value && <span className="hint">Suggested: <code>{s.value}</code> ({s.why}) · <button type="button" className="link" onClick={() => (typed.current[field] = true, use(s.value))}>Use</button></span>
      : s.value === value && <span className="hint">from {s.why}</span>);
  return (
    <>
      <label>
        Repository path
        <input name="repo_path" value={path} onChange={(e) => setPath(e.target.value)} onBlur={() => run(path, branch)} onPaste={(e) => { const el = e.currentTarget; setTimeout(() => run(el.value, branch)); }}
          placeholder="/Users/me/code/project" required spellCheck={false} />
        <span className="hint">Absolute path on the server to the root of a git repository. Each run gets its own branch and worktree of it, in a Docker sandbox.</span>
      </label>
      <div role="status" className="hint repo-state">
        {ok && <><Icon name="check" size={13} /> git repository · {info.branches!.length} branch{info.branches!.length === 1 ? "" : "es"}{info.branches!.find((b) => b.current) ? ` · on ${info.branches!.find((b) => b.current)!.name}` : " · HEAD is detached"}</>}
        {info && info.state !== "ok" && info.state !== "inside_repo" && NOT_OK[info.state]}
        {info?.state === "inside_repo" && <>This folder is inside the repository at <code>{info.root}</code>. <button type="button" className="btn" onClick={() => setPath(info.root!)}>Use the root</button></>}
        {failed && `Could not check this folder: ${failed}`}
      </div>
      <input type="hidden" name="base_branch" value={base} />
      <input type="hidden" name="protected_paths" value={joined} />
      <fieldset className="plain" disabled={!ok}>
        <label>
          Base branch
          <select aria-label="Base branch" value={other ? OTHER : base} onChange={(e) => (e.target.value === OTHER ? setOther(true) : (setOther(false), setBranch(e.target.value)))}>
            {info?.branches?.map((b) => <option key={b.name} value={b.name}>{b.name}{b.current ? " · checked out" : ""} · {ago(b.committed_at)} · {b.subject.slice(0, 60)}</option>)}
            {base && !other && ok && !info.branches!.some((b) => b.name === base) && <option value={base}>{base} (missing)</option>}
            {!ok && base && <option value={base}>{base}</option>}
            <option value={OTHER}>Other…</option>
          </select>
          {other && <input aria-label="Branch name" className="mono" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Branch name" spellCheck={false} />}
          <span className="hint">Runs branch from it; approved changes are merged into it. Suggestions below are read from it.</span>
        </label>
        <label>
          Setup command
          <input name="setup_command" className="mono" value={setup} onChange={(e) => (typed.current.setup = true, setSetup(e.target.value))} spellCheck={false} />
          {suggest(info?.setup_command, setup, setSetup, "setup")}
          <span className="hint">Runs in the sandbox before the agent starts. Leave empty to skip.</span>
        </label>
        <label>
          Test command
          <input name="test_command" className="mono" value={test} onChange={(e) => (typed.current.test = true, setTest(e.target.value))} spellCheck={false} />
          {suggest(info?.test_command, test, setTest, "test")}
          <span className="hint">The gate: a run passes only if this exits 0. Failures are retried up to 3 attempts.</span>
        </label>
        <div role="group" aria-label="Protected paths" className="protected">
          <h4>Protected paths</h4>
          <span className="hint">The tests that judge an agent's work. Agents can't weaken them, so a passing gate means something.</span>
          {shown.map((c) => (
            <label key={c.path} className="check">
              <input type="checkbox" checked={paths.includes(c.path)} onChange={() => toggle(c.path)} />
              <span className="mono">{c.path}</span>
              {c.files > 0 && <span className="muted">{c.files} file{c.files === 1 ? "" : "s"}{c.pattern ? ` · ${c.pattern}` : ""}</span>}
            </label>
          ))}
          <div className="row">
            <input aria-label="Add a path" className="mono grow" value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addPath())} placeholder="Add a path, e.g. spec/" spellCheck={false} />
            <button type="button" className="btn" onClick={addPath}>Add</button>
          </div>
          <label className="check"><input type="radio" name="protected_mode" value="add_only" checked={mode === "add_only"} onChange={() => setMode("add_only")} />Agents may add new files here (recommended)</label>
          <label className="check"><input type="radio" name="protected_mode" value="read_only" checked={mode === "read_only"} onChange={() => setMode("read_only")} />Agents can't touch these paths at all</label>
          <span className="hint">Adding lets an agent write regression tests; it still can't change, delete or rename a file that existed when its run started.</span>
        </div>
      </fieldset>
      {warnings.map((w) => <p key={w} className="note warn" role="note">{w}</p>)}
      <details className="advanced">
        <summary>Advanced</summary>
        <label>
          Sandbox image
          <input name="image" className="mono" defaultValue={r?.image} placeholder="polaris-sandbox:1" spellCheck={false} />
          <span className="hint">The default image is built automatically on first use.</span>
        </label>
        <div className="row">
          <label>
            Sandbox CPUs
            <input name="sandbox_cpus" type="number" min={1} max={32} defaultValue={r?.sandbox_cpus ?? 4} />
          </label>
          <label>
            Sandbox memory (GB)
            <input name="sandbox_memory_gb" type="number" min={1} max={64} defaultValue={r?.sandbox_memory_gb ?? 4} />
          </label>
        </div>
        <label>
          Sandbox network
          <select name="sandbox_network" defaultValue={r?.sandbox_network ?? "setup-only"}>
            <option value="setup-only">During setup only (default)</option>
            <option value="none">None</option>
            <option value="full">Full (agents and tests too)</option>
          </select>
          <span className="hint">Agents run prompt-injectable text; with a network they can send the worktree anywhere or reach services on your machine. The install step (<span className="mono">npm ci</span>) needs the registry; <em>None</em> needs a warm cache.</span>
        </label>
        <span className="hint">Per run. Test runners use the CPU count: <span className="mono">node --test</span> runs one test file per CPU at a time. Docker Desktop's own memory limit caps the total.</span>
      </details>
    </>
  );
}

export function ProjectPage({ id, go }: { id: string; go: (to: string) => void }) {
  const { data: p, error, setError, reload } = useApi<Project>(`/api/projects/${id}`);
  const { tracker, reload: reloadTracker } = useTracker();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState<Milestone | null>(null);
  const [saved, setSaved] = useState(false);

  const call = async (path: string, method: string, body?: object) => {
    setError("");
    try {
      await api(path, method, body);
      reload();
      reloadTracker();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const patch = (b: object) => call(`/api/projects/${id}`, "PATCH", b);
  async function saveRepo(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaved(false);
    setSaved(await patch(Object.fromEntries(new FormData(e.currentTarget))));
  }
  async function addMilestone(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    await call(`/api/projects/${id}/milestones`, "POST", { name: f.get("name"), target_date: f.get("target_date") || null });
    form.reset();
  }
  const move = (i: number, d: number) => {
    const ids = p!.milestones.map((m) => m.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    call(`/api/projects/${id}/milestones/order`, "PUT", { ids });
  };

  if (!p) return <Loading error={error} />;
  return (
    <div className="page" key={p.id}>
      <div className="row">
        <input className="h-input grow" aria-label="Project name" defaultValue={p.name} maxLength={100} onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && patch({ name: e.target.value })} />
        <label className="inline">Key
          <input aria-label="Key" className="mono narrow" defaultValue={p.key} maxLength={5} onBlur={(e) => e.target.value.toUpperCase() !== p.key && patch({ key: e.target.value }).then((ok) => ok && go(`/p/${e.target.value.toUpperCase()}/overview`))} />
        </label>
      </div>
      <div className="row">
        <label className="inline">Status
          <select value={p.status} onChange={(e) => patch({ status: e.target.value })}>{STATUSES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <label className="inline">Lead
          <select value={p.lead?.id ?? ""} onChange={(e) => patch({ lead_id: e.target.value || null })}>
            <option value="">No lead</option>
            {tracker?.members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="inline">Target
          <DateField className="narrow" value={p.target_date} onSave={(target_date) => patch({ target_date })} />
        </label>
        <span className="grow" />
        <button className="btn danger" onClick={() => setConfirming(true)}>Delete project</button>
      </div>
      <textarea aria-label="Description" placeholder="What is this project for?" rows={3} defaultValue={p.description} onBlur={(e) => e.target.value !== p.description && patch({ description: e.target.value })} />
      <Alert error={error} />
      <section aria-label="Progress" className="row">
        <Bar p={p.progress} /> <ByStatus p={p.progress} />
        {p.progress.points > 0 && <span className="muted">{p.progress.points_done}/{p.progress.points} points</span>}
      </section>

      <h3>Milestones</h3>
      <ul className="plist" aria-label="Milestones">
        {p.milestones.map((m, i) => (
          <li key={m.id} className="row" aria-label={m.name}>
            <input aria-label={`Milestone ${m.name}`} defaultValue={m.name} className="grow narrow" maxLength={100} onBlur={(e) => e.target.value.trim() && e.target.value !== m.name && call(`/api/milestones/${m.id}`, "PATCH", { name: e.target.value })} />
            <DateField aria-label={`Target date of ${m.name}`} className="narrow" value={m.target_date} onSave={(target_date) => call(`/api/milestones/${m.id}`, "PATCH", { target_date })} />
            <Bar p={m.progress} />
            <button className="btn" aria-label={`Move ${m.name} up`} disabled={i === 0} onClick={() => move(i, -1)}><Icon name="up" size={14} /></button>
            <button className="btn" aria-label={`Move ${m.name} down`} disabled={i === p.milestones.length - 1} onClick={() => move(i, 1)}><Icon name="down" size={14} /></button>
            <button className="btn danger" aria-label={`Delete milestone ${m.name}`} onClick={() => setDeleting(m)}>Delete</button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={addMilestone}>
        <input name="name" aria-label="New milestone" placeholder="New milestone" required maxLength={100} className="grow narrow" />
        <DateInput name="target_date" aria-label="Milestone target date" placeholder="Target date" className="narrow" />
        <button className="btn">Add milestone</button>
      </form>

      <h3>Repository</h3>
      <form onSubmit={saveRepo} key={p.updated_at}>
        <RepoFields r={p} />
        <div className="row">
          <button className="btn primary">Save repository</button>
          {saved && !error && <span className="muted" role="status">Saved</span>}
        </div>
      </form>
      {deleting && (
        <Confirm title="Delete milestone?" onConfirm={() => (setDeleting(null), call(`/api/milestones/${deleting.id}`, "DELETE"))} onClose={() => setDeleting(null)}>
          The milestone {deleting.name} is deleted. Its tickets stay in {p.name}, without a milestone.
        </Confirm>
      )}
      {confirming && (
        <Confirm title="Delete project?" onConfirm={() => (setConfirming(false), call(`/api/projects/${id}`, "DELETE").then((ok) => ok && go("/projects")))} onClose={() => setConfirming(false)}>
          {p.name}, its milestones, cycles and wiki are deleted. Only a project without tickets can be deleted; the repository itself is not touched.
        </Confirm>
      )}
    </div>
  );
}
