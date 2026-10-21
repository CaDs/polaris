import { useEffect, useState, type FormEvent } from "react";
import { Alert, Confirm, Dialog, api } from "./ui.tsx";

// M17: workspace skills (instructions agents load when relevant, or that a member attaches to a chat message). Made here
// and in the chat composer; the repo's own .polaris/skills/ files are listed in the composer but edited in the repo.
export type WorkspaceSkill = { id: string; name: string; description: string; body: string; phases: string[]; author: string | null };
const PHASES = [["worker", "Worker"], ["planner", "Planner"], ["reviewer", "Reviewer"], ["chat", "Chat"]] as const;

export function SkillDialog({ skill, close, saved }: { skill: WorkspaceSkill | null; close: () => void; saved: (s: WorkspaceSkill) => void }) {
  const [error, setError] = useState("");
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      const body = { name: f.get("name"), description: f.get("description"), body: f.get("body"), phases: f.getAll("phases") };
      saved(await api<WorkspaceSkill>(skill ? `/api/skills/${skill.id}` : "/api/skills", skill ? "PATCH" : "POST", body));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Dialog title={skill ? "Edit skill" : "Create skill"} onClose={close} className="wide">
      <form onSubmit={submit}>
        <label>Name <input name="name" required maxLength={60} defaultValue={skill?.name} autoFocus /></label>
        <label>
          Description <input name="description" required maxLength={300} defaultValue={skill?.description} />
          <span className="hint">When to use it. Agents see this line and read the instructions only when it fits the task.</span>
        </label>
        <label>
          Instructions <textarea name="body" required rows={10} maxLength={20000} className="mono" defaultValue={skill?.body} spellCheck={false} />
          <span className="hint">Markdown. Steps, conventions, commands, pitfalls: what an agent should do when this skill applies.</span>
        </label>
        <fieldset className="label-pick">
          <legend className="muted">Offered to</legend>
          {PHASES.map(([p, label]) => (
            <label key={p} className="check"><input type="checkbox" name="phases" value={p} defaultChecked={(skill?.phases ?? ["worker", "planner"]).includes(p)} /> {label}</label>
          ))}
        </fieldset>
        <Alert error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn primary">{skill ? "Save skill" : "Create skill"}</button>
        </div>
      </form>
    </Dialog>
  );
}

// Settings → Skills.
export function SkillsTab() {
  const [skills, setSkills] = useState<WorkspaceSkill[] | null>(null);
  const [editing, setEditing] = useState<WorkspaceSkill | "new" | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceSkill | null>(null);
  const [error, setError] = useState("");
  const load = () => api<WorkspaceSkill[]>("/api/skills").then(setSkills, (e) => setError(e.message));
  useEffect(() => void load(), []);
  return (
    <section aria-label="Skills">
      <h2>Skills</h2>
      <p className="muted">
        Instructions agents load when a task calls for them, for every project in the workspace. Each run lists them next to the repository's own
        <span className="mono"> .polaris/skills/</span>; in the chat you can attach one to a message.
      </p>
      <Alert error={error} />
      <ul className="plist">
        {skills?.map((s) => (
          <li key={s.id} className="row">
            <span className="grow">
              <strong>{s.name}</strong> <span className="muted">— {s.description}</span>
              <br /><span className="hint">Offered to {s.phases.join(", ")}</span>
            </span>
            <button className="btn" onClick={() => setEditing(s)}>Edit</button>
            <button className="btn danger" onClick={() => setDeleting(s)}>Delete</button>
          </li>
        ))}
        {skills?.length === 0 && <li className="muted">No workspace skills yet.</li>}
      </ul>
      <button className="btn" onClick={() => setEditing("new")}>Create skill</button>
      {editing && <SkillDialog skill={editing === "new" ? null : editing} close={() => setEditing(null)} saved={() => (setEditing(null), load())} />}
      {deleting && (
        <Confirm title="Delete skill?" onConfirm={() => api(`/api/skills/${deleting.id}`, "DELETE").then(load, (e) => setError(e.message)).finally(() => setDeleting(null))} onClose={() => setDeleting(null)}>
          {deleting.name} is deleted; runs that start from now on no longer get it.
        </Confirm>
      )}
    </section>
  );
}
