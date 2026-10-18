import { useEffect, useState, type FormEvent } from "react";
import { Providers } from "./Providers.tsx";
import { api } from "./ui.tsx";

type WorkspaceSettings = {
  repo_path: string; base_branch: string; setup_command: string; test_command: string; protected_paths: string; image: string;
  compact_at_tokens: number; configured: boolean; updated_at?: number; default_provider_id: string | null; default_model: string | null;
  auto_approve_children: number; model_review: number; auto_split: number; child_size_hint: string; triage_model: string; wiki: number;
};

export function Settings() {
  const [s, setS] = useState<WorkspaceSettings | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => void api<WorkspaceSettings>("/api/settings").then(setS, (e) => setError(e.message)), []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setSaved(false);
    try {
      const f = new FormData(e.currentTarget);
      setS(await api<WorkspaceSettings>("/api/settings", "PUT", { ...Object.fromEntries(f), model_review: f.has("model_review"), auto_split: f.has("auto_split"), wiki: f.has("wiki") }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!s) return <p className="muted pad">{error || "Loading…"}</p>;
  // key: re-mount after a save so server-filled values (e.g. the default base branch) show up.
  return (
    <div className="settings">
    <form onSubmit={submit} key={s.updated_at ?? 0}>
      <h2>Repository</h2>
      <p className="muted">Each run gets its own branch and git worktree of this repository, and works in a Docker sandbox.</p>
      <label>
        Repository path
        <input name="repo_path" defaultValue={s.repo_path} placeholder="/Users/me/code/project" required spellCheck={false} />
        <span className="hint">Absolute path on the server to the root of a git repository.</span>
      </label>
      <label>
        Base branch
        <input name="base_branch" defaultValue={s.base_branch} placeholder="Current branch" spellCheck={false} />
        <span className="hint">Runs branch from it; approved changes are merged into it.</span>
      </label>

      <h2>Sandbox</h2>
      <label>
        Setup command
        <input name="setup_command" className="mono" defaultValue={s.setup_command} spellCheck={false} />
        <span className="hint">Runs in the sandbox before the agent starts. Leave empty to skip.</span>
      </label>
      <label>
        Test command
        <input name="test_command" className="mono" defaultValue={s.test_command} spellCheck={false} />
        <span className="hint">The gate: a run passes only if this exits 0. Failures are retried up to 3 attempts.</span>
      </label>
      <label>
        Protected paths
        <input name="protected_paths" className="mono" defaultValue={s.protected_paths} spellCheck={false} />
        <span className="hint">Comma-separated, read-only to agents. Changes there fail the run.</span>
      </label>
      <label>
        Sandbox image
        <input name="image" className="mono" defaultValue={s.image} spellCheck={false} />
        <span className="hint">The default image is built automatically on first use.</span>
      </label>

      <h2>Context</h2>
      <label>
        Compact at (tokens)
        <input name="compact_at_tokens" type="number" min={1000} step={1} defaultValue={s.compact_at_tokens} required />
        <span className="hint">A run summarizes and starts a fresh conversation when its context passes this, or 70% of the provider's context window if that is lower.</span>
      </label>

      <h2>Review</h2>
      <label className="check">
        <input type="checkbox" name="model_review" defaultChecked={!!s.model_review} /> Model review before human review
      </label>
      <span className="hint">
        After the tests pass, the run's own model reviews the change; its findings go back to the agent to fix (up to 3 rounds) before you see it.
        Costs extra tokens per run. If the reviewer itself fails, the change goes to you anyway.
      </span>

      <h2>Project wiki</h2>
      <label className="check">
        <input type="checkbox" name="wiki" defaultChecked={!!s.wiki} /> Keep a project wiki
      </label>
      <span className="hint">
        Every run starts with the wiki's index (pages flagged when their source files changed) and a read-only copy of its pages. After you approve
        a ticket, a maintainer agent updates the wiki from the merged change. Off: no wiki section, no snapshot, no ingest.
      </span>

      <h2>Planner</h2>
      <label className="check">
        <input type="checkbox" name="auto_approve_children" defaultChecked={!!s.auto_approve_children} /> Auto-approve child tickets
      </label>
      <span className="hint">
        Children of an epic whose run passes the test gate are merged right away, so an epic runs to its own review without clicks. Faster, but
        only the gate checks each change. Off: you approve each child, which also moves the epic forward.
      </span>
      <label className="check">
        <input type="checkbox" name="auto_split" defaultChecked={!!s.auto_split} /> Split tickets that fail into smaller ones
      </label>
      <span className="hint">
        A ticket that fails its last attempt is replaced by a "Split:" epic with the same spec and what the attempt left behind; its planner breaks
        it into smaller tickets. Not for children of a sub-epic (depth limit).
      </span>
      <label>
        Child size hint
        <input name="child_size_hint" defaultValue={s.child_size_hint} spellCheck={false} />
        <span className="hint">The ticket size the worker model reliably finishes. Planners make every child at most this size. Empty: no hint.</span>
      </label>
      <label>
        Triage model
        <input name="triage_model" className="mono" defaultValue={s.triage_model} placeholder="Off" spellCheck={false} />
        <span className="hint">
          A System One decision model on the default Ollama provider. With splitting on, it scores a new ticket's size before its first run; large
          tickets are split instead of run. Empty: off. Errors never block the run.
        </span>
      </label>

      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button className="btn primary">Save settings</button>
        {saved && <span className="muted" role="status">Saved</span>}
        {!s.configured && !saved && <span className="muted">Not configured yet — agents can't run until this is saved.</span>}
      </div>
    </form>
    <Providers defaults={s} />
    </div>
  );
}
