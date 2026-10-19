import { useEffect, useState, type FormEvent } from "react";
import { List, useTicketList } from "./List.tsx";
import { Alert, Confirm, DateField, Loading, api, useApi, type Ticket } from "./ui.tsx";
import { Bar, ByStatus, useTracker, type Member, type Progress } from "./tracker.tsx";

type Milestone = { id: string; name: string; target_date: string | null; position: number; progress: Progress };
type Project = {
  id: string; name: string; description: string; status: string; lead: Member | null; target_date: string | null; progress: Progress; milestones: Milestone[];
};
const STATUSES = ["planned", "started", "paused", "completed", "canceled"];

export function Projects({ go }: { go: (to: string) => void }) {
  const { data, error, setError, reload } = useApi<Project[]>("/api/projects");
  const { reload: reloadTracker } = useTracker();
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    try {
      await api("/api/projects", "POST", { name: f.get("name"), target_date: f.get("target_date") || null });
      form.reset();
      reload();
      reloadTracker();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="page">
      <form className="row" onSubmit={create}>
        <input name="name" aria-label="Project name" placeholder="New project" required maxLength={100} className="grow narrow" />
        <input name="target_date" type="date" aria-label="Target date" className="narrow" />
        <button className="btn primary">Create project</button>
      </form>
      <Alert error={error} />
      {data?.length === 0 && <p className="muted">No projects yet. A project groups tickets toward one outcome, with milestones along the way.</p>}
      {!!data?.length && (
        <div className="table-wrap">
          <table aria-label="Projects">
            <thead><tr><th>Name</th><th>Status</th><th>Lead</th><th>Target</th><th>Progress</th><th>Milestones</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td><button className="link" onClick={() => go(`/projects/${p.id}`)}>{p.name}</button></td>
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

export function ProjectPage({ id, go, open, tick }: { id: string; go: (to: string) => void; open: (n: number) => void; tick: unknown }) {
  const { data: p, error, setError, reload } = useApi<Project>(`/api/projects/${id}`);
  const { tracker, reload: reloadTracker } = useTracker();
  const tickets = useTicketList(`project=${id}`, tick);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState<Milestone | null>(null);
  useEffect(() => void reload(), [tick]); // progress follows ticket changes

  const call = async (path: string, method: string, body?: object) => {
    setError("");
    try {
      await api(path, method, body);
      reload();
      reloadTracker();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const patch = (b: object) => call(`/api/projects/${id}`, "PATCH", b);
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
      <input className="h-input" aria-label="Project name" defaultValue={p.name} maxLength={100} onBlur={(e) => e.target.value.trim() && e.target.value !== p.name && patch({ name: e.target.value })} />
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
            <button className="btn" aria-label={`Move ${m.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
            <button className="btn" aria-label={`Move ${m.name} down`} disabled={i === p.milestones.length - 1} onClick={() => move(i, 1)}>↓</button>
            <button className="btn danger" aria-label={`Delete milestone ${m.name}`} onClick={() => setDeleting(m)}>Delete</button>
          </li>
        ))}
      </ul>
      <form className="row" onSubmit={addMilestone}>
        <input name="name" aria-label="New milestone" placeholder="New milestone" required maxLength={100} className="grow narrow" />
        <input name="target_date" type="date" aria-label="Milestone target date" className="narrow" />
        <button className="btn">Add milestone</button>
      </form>

      <h3>Tickets</h3>
      <List tickets={tickets} group="status" open={(t: Ticket) => open(t.number)} />
      {deleting && (
        <Confirm title="Delete milestone?" onConfirm={() => (setDeleting(null), call(`/api/milestones/${deleting.id}`, "DELETE"))} onClose={() => setDeleting(null)}>
          The milestone {deleting.name} is deleted. Its tickets stay in {p.name}, without a milestone.
        </Confirm>
      )}
      {confirming && (
        <Confirm title="Delete project?" onConfirm={() => call(`/api/projects/${id}`, "DELETE").then(() => go("/projects"))} onClose={() => setConfirming(false)}>
          {p.name} and its milestones are deleted. Its tickets stay, without a project.
        </Confirm>
      )}
    </div>
  );
}
