import { useState, type FormEvent } from "react";
import { Alert, Confirm, DateField, DateInput, Icon, Loading, api, useApi } from "./ui.tsx";
import { Bar, ByStatus, useTracker, type Member, type Progress } from "./tracker.tsx";

type Milestone = { id: string; name: string; target_date: string | null; position: number; progress: Progress };
type Repo = { repo_path: string; base_branch: string; setup_command: string; test_command: string; protected_paths: string; image: string };
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

// The repository a project works in; the server checks it (a repo root with commits, the base branch exists).
function RepoFields({ r }: { r?: Repo }) {
  return (
    <>
      <label>
        Repository path
        <input name="repo_path" defaultValue={r?.repo_path} placeholder="/Users/me/code/project" required spellCheck={false} />
        <span className="hint">Absolute path on the server to the root of a git repository. Each run gets its own branch and worktree of it, in a Docker sandbox.</span>
      </label>
      <label>
        Base branch
        <input name="base_branch" defaultValue={r?.base_branch} placeholder="Current branch" spellCheck={false} />
        <span className="hint">Runs branch from it; approved changes are merged into it.</span>
      </label>
      <label>
        Setup command
        <input name="setup_command" className="mono" defaultValue={r?.setup_command ?? "npm ci"} spellCheck={false} />
        <span className="hint">Runs in the sandbox before the agent starts. Leave empty to skip.</span>
      </label>
      <label>
        Test command
        <input name="test_command" className="mono" defaultValue={r?.test_command ?? "npm test"} spellCheck={false} />
        <span className="hint">The gate: a run passes only if this exits 0. Failures are retried up to 3 attempts.</span>
      </label>
      <details className="advanced">
        <summary>Advanced</summary>
        <label>
          Protected paths
          <input name="protected_paths" className="mono" defaultValue={r?.protected_paths ?? "tests/,evals/"} spellCheck={false} />
          <span className="hint">Comma-separated, read-only to agents. Changes there fail the run.</span>
        </label>
        <label>
          Sandbox image
          <input name="image" className="mono" defaultValue={r?.image} placeholder="polaris-sandbox:1" spellCheck={false} />
          <span className="hint">The default image is built automatically on first use.</span>
        </label>
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
