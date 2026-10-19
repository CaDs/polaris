import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Providers } from "./Providers.tsx";
import { LabelSettings } from "./tracker.tsx";
import { Caps, type Usage } from "./Usage.tsx";
import { Alert, Loading, ModelPicker, api, useApi, useProviders } from "./ui.tsx";

type WorkspaceSettings = {
  repo_path: string; base_branch: string; setup_command: string; test_command: string; protected_paths: string; image: string;
  compact_at_tokens: number; configured: boolean; updated_at?: number; default_provider_id: string | null; default_model: string | null;
  auto_approve_children: number; model_review: number; auto_split: number; child_size_hint: string; triage_model: string; wiki: number; max_turns: number; max_minutes: number;
  monthly_cap_usd: number | null; monthly_cap_tokens: number | null; review_provider_id: string | null; review_model: string | null;
};

// One page per concern, in setup order: the repository first (every other tab needs it saved), then models.
const TABS = [["general", "General"], ["models", "Models"], ["automation", "Automation"], ["limits", "Limits"], ["labels", "Labels"]] as const;

export function Settings({ tab = "general", go }: { tab?: string; go: (to: string) => void }) {
  const [s, setS] = useState<WorkspaceSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void api<WorkspaceSettings>("/api/settings").then(setS, (e) => setError(e.message)), []);
  const link = (to: string, label: string, active = false) => (
    <a key={to} href={to} className={active ? "active" : undefined} aria-current={active ? "page" : undefined} onClick={(e) => (e.preventDefault(), go(to))}>{label}</a>
  );
  if (!s) return <Loading error={error} />;
  const needsRepo = !s.configured && tab !== "general" && tab !== "labels";
  return (
    <div className="settings">
      <nav className="tabs" aria-label="Settings sections">{TABS.map(([t, label]) => link(`/settings/${t}`, label, t === tab))}</nav>
      <div key={tab}>
        {tab === "models" && <ModelsTab s={s} saved={setS} />}
        {needsRepo ? (
          <p className="muted">Set up the repository on the {link("/settings/general", "General")} tab first; the settings here are saved with it.</p>
        ) : tab === "automation" ? (
          <AutomationTab s={s} saved={setS} />
        ) : tab === "limits" ? (
          <LimitsTab s={s} saved={setS} go={go} />
        ) : tab === "labels" ? (
          <LabelSettings />
        ) : tab === "general" ? (
          <GeneralTab s={s} saved={setS} />
        ) : null}
      </div>
    </div>
  );
}

// A tab's form: sends only its own fields (PUT /api/settings keeps the ones it omits), plus `also` for the model endpoints.
function Form({ s, saved, also, children }: { s: WorkspaceSettings; saved: (s: WorkspaceSettings) => void; also?: () => Promise<unknown>; children: ReactNode }) {
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    setOk(false);
    try {
      // Unchecked boxes are missing from FormData: send every checkbox's state.
      const form = e.currentTarget;
      const toggles = [...form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].map((c) => [c.name, c.checked]);
      await api("/api/settings", "PUT", { ...Object.fromEntries(new FormData(form)), ...Object.fromEntries(toggles) });
      await also?.();
      saved(await api<WorkspaceSettings>("/api/settings"));
      setOk(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <form onSubmit={submit}>
      {/* key: re-mount after a save so server-filled values (e.g. the default base branch) show up */}
      <div key={s.updated_at ?? 0}>{children}</div>
      <Alert error={error} />
      <div className="row">
        <button className="btn primary">Save settings</button>
        {ok && <span className="muted" role="status">Saved</span>}
        {!s.configured && !ok && <span className="muted">Not configured yet — agents can't run until this is saved.</span>}
      </div>
    </form>
  );
}

type Tab = { s: WorkspaceSettings; saved: (s: WorkspaceSettings) => void };

function GeneralTab({ s, saved }: Tab) {
  return (
    <Form s={s} saved={saved}>
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
      <h2>Commands</h2>
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
      <details className="advanced">
        <summary>Advanced</summary>
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
      </details>
    </Form>
  );
}

// Providers save from their own dialogs; the model choices below them save with the tab's form.
function ModelsTab({ s, saved }: Tab) {
  const [providers, reload] = useProviders();
  const [pick, setPick] = useState({ provider_id: s.default_provider_id, model: s.default_model });
  const [reviewer, setReviewer] = useState({ provider_id: s.review_provider_id, model: s.review_model });
  const [review, setReview] = useState(!!s.model_review);
  const also = () => Promise.all([api("/api/settings/default-provider", "PUT", pick), api("/api/settings/review-provider", "PUT", reviewer)]);
  return (
    <>
      <Providers providers={providers} reload={reload} />
      {s.configured && (
        <Form s={s} saved={saved} also={also}>
          <h2>Default model</h2>
          <p className="muted">Used by tickets that don't pick their own. Without one, the server falls back to its environment (ANTHROPIC_API_KEY …).</p>
          <div className="row">{providers && <ModelPicker providers={providers} prefix="Default " {...pick} onChange={setPick} />}</div>
          <h2>Review</h2>
          <label className="check">
            <input type="checkbox" name="model_review" checked={review} onChange={(e) => setReview(e.target.checked)} /> Model review before human review
          </label>
          <span className="hint">
            After the tests pass, a model reviews the change; its findings go back to the agent to fix (up to 3 rounds) before you see it.
            Costs extra tokens per run. If the reviewer itself fails, the change goes to you anyway.
          </span>
          {review && (
            <>
              <h2>Reviewer model</h2>
              <p className="muted">"Default" means the model the run itself used; a stronger or cheaper model is the usual pick.</p>
              <div className="row">{providers && <ModelPicker providers={providers} prefix="Reviewer " {...reviewer} onChange={setReviewer} />}</div>
            </>
          )}
        </Form>
      )}
    </>
  );
}

function AutomationTab({ s, saved }: Tab) {
  const [split, setSplit] = useState(!!s.auto_split);
  // Triage runs on the workspace's default provider, which must be Ollama (server/runs.ts triageTicket).
  const [providers] = useProviders();
  const ollama = providers?.find((p) => p.id === s.default_provider_id && p.kind === "ollama");
  const [models, setModels] = useState<string[]>([]);
  useEffect(() => void (ollama && api<{ models: string[] }>(`/api/providers/${ollama.id}/models`).then((r) => setModels(r.models), () => {})), [ollama?.id]);
  const options = s.triage_model && !models.includes(s.triage_model) ? [s.triage_model, ...models] : models;
  return (
    <Form s={s} saved={saved}>
      <h2>Epics and planner</h2>
      <label className="check">
        <input type="checkbox" name="auto_approve_children" defaultChecked={!!s.auto_approve_children} /> Auto-approve child tickets
      </label>
      <span className="hint">
        Children of an epic whose run passes the test gate are merged right away, so an epic runs to its own review without clicks. Faster, but
        only the gate checks each change. Off: you approve each child, which also moves the epic forward.
      </span>
      <label className="check">
        <input type="checkbox" name="auto_split" checked={split} onChange={(e) => setSplit(e.target.checked)} /> Split tickets that fail into smaller ones
      </label>
      <span className="hint">
        A ticket that fails its last attempt is replaced by a "Split:" epic with the same spec and what the attempt left behind; its planner breaks
        it into smaller tickets. Not for children of a sub-epic (depth limit).
      </span>
      <label>
        Triage model
        <select name="triage_model" defaultValue={s.triage_model} disabled={!split || !ollama}>
          <option value="">Off</option>
          {options.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span className="hint">
          {!split ? "Needs splitting on. " : !ollama ? "Needs an Ollama provider as the default model (Models tab). " : ""}
          Scores a new ticket's size before its first run; large tickets are split instead of run. Errors never block the run.
        </span>
      </label>
      <label>
        Child size hint
        <input name="child_size_hint" defaultValue={s.child_size_hint} spellCheck={false} />
        <span className="hint">The ticket size the worker model reliably finishes. Planners make every child at most this size. Empty: no hint.</span>
      </label>
      <h2>Project wiki</h2>
      <label className="check">
        <input type="checkbox" name="wiki" defaultChecked={!!s.wiki} /> Keep a project wiki
      </label>
      <span className="hint">
        Every run starts with the wiki's index (pages flagged when their source files changed) and a read-only copy of its pages. After you approve
        a ticket, a maintainer agent updates the wiki from the merged change. Off: no wiki section, no snapshot, no ingest.
      </span>
    </Form>
  );
}

function LimitsTab({ s, saved, go }: Tab & { go: (to: string) => void }) {
  const { data: usage } = useApi<Usage>("/api/usage");
  return (
    <Form s={s} saved={saved}>
      <h2>Spending caps</h2>
      {usage && <Caps cap={usage.cap} />}
      <label>
        Monthly cap (USD)
        <input name="monthly_cap_usd" type="number" min={0} step="any" defaultValue={s.monthly_cap_usd ?? ""} placeholder="No cap" />
        <span className="hint">
          Spend of every run this UTC calendar month, priced as on the <a href="/usage" onClick={(e) => (e.preventDefault(), go("/usage"))}>Usage</a> page
          (models without a price count $0). Once reached, no new run starts and a running one stops before its next model call. Empty: no cap.
        </span>
      </label>
      <label>
        Monthly cap (tokens)
        <input name="monthly_cap_tokens" type="number" min={0} step={1} defaultValue={s.monthly_cap_tokens ?? ""} placeholder="No cap" />
        <span className="hint">The same for tokens (in + out + cached, every model, Ollama included). A warning is logged on a run at 80%. Epics can have their own cap.</span>
      </label>
      <h2>Per attempt</h2>
      <label>
        Max turns per attempt
        <input name="max_turns" type="number" min={10} max={500} step={1} defaultValue={s.max_turns} required />
        <span className="hint">Model calls the worker may make in one go (the first run and each fix round count separately).</span>
      </label>
      <label>
        Max minutes per attempt
        <input name="max_minutes" type="number" min={5} max={600} step={1} defaultValue={s.max_minutes} required />
        <span className="hint">Wall-clock limit for the whole attempt, fix rounds included. Fast models run out of turns first; slow ones out of minutes.</span>
      </label>
      <label>
        Compact at (tokens)
        <input name="compact_at_tokens" type="number" min={1000} step={1} defaultValue={s.compact_at_tokens} required />
        <span className="hint">A run summarizes and starts a fresh conversation when its context passes this, or 70% of the provider's context window if that is lower.</span>
      </label>
    </Form>
  );
}
