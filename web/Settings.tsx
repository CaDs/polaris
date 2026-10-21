import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Providers } from "./Providers.tsx";
import { SkillsTab } from "./Skills.tsx";
import { LabelSettings } from "./tracker.tsx";
import { Caps, type Usage } from "./Usage.tsx";
import { Alert, Loading, ModelPicker, PALETTES, api, when, useApi, useAppearance, useProviders } from "./ui.tsx";

type WorkspaceSettings = {
  compact_at_tokens: number; updated_at?: number; default_provider_id: string | null; default_model: string | null;
  auto_approve_children: number; model_review: number; auto_split: number; child_size_hint: string; triage_model: string; wiki: number; max_turns: number; max_minutes: number; max_tokens: number;
  monthly_cap_usd: number | null; monthly_cap_tokens: number | null; review_provider_id: string | null; review_model: string | null;
} & Record<`${Phase}_provider_id` | `${Phase}_model`, string | null>;

// M14: phases with their own model; "Default" is the fallback named here.
const PHASES = [
  ["planner", "Planner", "Plans epics into child tickets. Default: the workspace default."],
  ["chat", "Chat", "Answers in the chat panel and proposes tickets. Default: the workspace default."],
  ["wiki", "Wiki", "Keeps the project wiki up to date after each approval. Default: the model of the run it documents."],
] as const;
type Phase = (typeof PHASES)[number][0];

// One page per concern, in setup order; Appearance is the caller's own. A project's repository and commands are on its
// Overview page.
const TABS = [["models", "Models"], ["automation", "Automation"], ["limits", "Limits"], ["labels", "Labels"], ["skills", "Skills"], ["appearance", "Appearance"], ["account", "Account"]] as const;

export function Settings({ tab = "models", go }: { tab?: string; go: (to: string) => void }) {
  const [s, setS] = useState<WorkspaceSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => void api<WorkspaceSettings>("/api/settings").then(setS, (e) => setError(e.message)), []);
  const link = (to: string, label: string, active = false) => (
    <a key={to} href={to} className={active ? "active" : undefined} aria-current={active ? "page" : undefined} onClick={(e) => (e.preventDefault(), go(to))}>{label}</a>
  );
  if (!s) return <Loading error={error} />;
  return (
    <div className="settings">
      <nav className="tabs" aria-label="Settings sections">{TABS.map(([t, label]) => link(`/settings/${t}`, label, t === tab))}</nav>
      <div key={tab}>
        {tab === "models" ? (
          <ModelsTab s={s} saved={setS} />
        ) : tab === "automation" ? (
          <AutomationTab s={s} saved={setS} />
        ) : tab === "limits" ? (
          <LimitsTab s={s} saved={setS} go={go} />
        ) : tab === "labels" ? (
          <LabelSettings />
        ) : tab === "skills" ? (
          <SkillsTab />
        ) : tab === "appearance" ? (
          <AppearanceTab />
        ) : tab === "account" ? (
          <AccountTab />
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
      {/* key: re-mount after a save so server-normalized values show up */}
      <div key={s.updated_at ?? 0}>{children}</div>
      <Alert error={error} />
      <div className="row">
        <button className="btn primary">Save settings</button>
        {ok && <span className="muted" role="status">Saved</span>}
      </div>
    </form>
  );
}

type Tab = { s: WorkspaceSettings; saved: (s: WorkspaceSettings) => void };

// Providers save from their own dialogs; the model choices below them save with the tab's form.
function ModelsTab({ s, saved }: Tab) {
  const [providers, reload] = useProviders();
  const [pick, setPick] = useState({ provider_id: s.default_provider_id, model: s.default_model });
  const [reviewer, setReviewer] = useState({ provider_id: s.review_provider_id, model: s.review_model });
  const [review, setReview] = useState(!!s.model_review);
  const [phases, setPhases] = useState(() => Object.fromEntries(PHASES.map(([p]) => [p, { provider_id: s[`${p}_provider_id`], model: s[`${p}_model`] }])));
  const also = () => Promise.all([
    api("/api/settings/default-provider", "PUT", pick), api("/api/settings/review-provider", "PUT", reviewer),
    ...PHASES.map(([p]) => api(`/api/settings/${p}-provider`, "PUT", phases[p])),
  ]);
  return (
    <>
      <Providers providers={providers} reload={reload} />
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
        <h2>Models per phase</h2>
        <p className="muted">Give a phase its own model, e.g. a smaller local model for chat and the wiki and your strongest one for the worker.</p>
        {PHASES.map(([p, name, hint]) => (
          <div key={p}>
            <div className="row"><strong className="phase-name">{name}</strong>{providers && <ModelPicker providers={providers} prefix={`${name} `} {...phases[p]} onChange={(v) => setPhases({ ...phases, [p]: v })} />}</div>
            <span className="hint">{hint}</span>
          </div>
        ))}
      </Form>
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
        Max tokens per attempt
        <input name="max_tokens" type="number" min={100000} max={20000000} step={1} defaultValue={s.max_tokens} required />
        <span className="hint">Uncached input + cache writes + output, fix rounds included. It stops runaway loops; a model whose prompt cache misses spends it fastest. ChatGPT-plan calls are not billed per token.</span>
      </label>
      <label>
        Compact at (tokens)
        <input name="compact_at_tokens" type="number" min={1000} step={1} defaultValue={s.compact_at_tokens} required />
        <span className="hint">A run summarizes and starts a fresh conversation when its context passes this, or 70% of the provider's context window if that is lower.</span>
      </label>
    </Form>
  );
}

// Yours alone, in every workspace and browser: saved on the server the moment you pick. Each card previews its palette
// (data-palette scopes the tokens to the card) in the current light or dark mode.
// Your sign-ins and API tokens (npm run token -- --name x). Revoking one signs it out at once.
type SessionRow = { id: string; token: boolean; name: string; current: boolean; createdAt: string; updatedAt: string; expiresAt: string };
function AccountTab() {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [error, setError] = useState("");
  const load = () => api<SessionRow[]>("/api/me/sessions").then(setRows, (e) => setError(e.message));
  useEffect(() => void load(), []);
  if (!rows) return <Loading error={error} />;
  return (
    <section aria-label="Sessions and tokens">
      <h2>Sessions and API tokens</h2>
      <p className="muted">Tokens come from <code>npm run token -- --name claude-code</code> and last 30 days by default. Revoke one you no longer use or that may have leaked.</p>
      <Alert error={error} />
      <div className="table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.token ? r.name : "Browser sign-in"}{r.current && " (this one)"}</td>
                <td>{when(r.createdAt)}</td>
                <td>{when(r.updatedAt)}</td>
                <td>{when(r.expiresAt)}</td>
                <td><button className="btn danger" aria-label={`Revoke ${r.token ? r.name : "browser sign-in"}`} onClick={() => api(`/api/me/sessions/${r.id}`, "DELETE").then(load, (e) => setError(e.message))}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AppearanceTab() {
  const { appearance, set } = useAppearance();
  return (
    <section aria-label="Appearance">
      <h2>Mode</h2>
      <span className="seg" role="group" aria-label="Mode">
        {(["system", "light", "dark"] as const).map((m) => (
          <button key={m} aria-pressed={appearance.mode === m} onClick={() => set({ mode: m })}>{m[0].toUpperCase() + m.slice(1)}</button>
        ))}
      </span>
      <h2>Palette</h2>
      <p className="muted">Only for you; everyone in the workspace picks their own.</p>
      <div className="palettes" role="radiogroup" aria-label="Palette">
        {PALETTES.map((p) => (
          <button key={p.id} role="radio" aria-checked={appearance.palette === p.id} className="palette-card" data-palette={p.id} onClick={() => set({ palette: p.id })}>
            <span className="pc-preview" aria-hidden="true">
              <span className="pc-side"><i /><i /><i /></span>
              <span className="pc-main">
                <span className="pc-row"><i className="s-running" /><i className="s-review" /><i className="s-done" /><i className="s-failed" /></span>
                <span className="pc-card" /><span className="pc-card" />
                <span className="pc-btn" />
              </span>
            </span>
            <span className="pc-name">{p.name}</span>
            <span className="pc-hint">{p.hint}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
