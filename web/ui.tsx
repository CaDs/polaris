import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

export type TokenSummary = { tokens_total: number; tokens_in: number; input_uncached: number; tokens_out: number; tokens_cached: number; tokens_cache_write: number; partial: number; unavailable: number; cost_usd: number; unknown_price: number; subscription_calls: number; local_calls: number };

export type Status = "todo" | "running" | "review" | "done" | "failed";
export const COLUMNS: Status[] = ["todo", "running", "review", "done", "failed"];
export type Ticket = {
  id: string; number: number; key: string; title: string; spec: string; test_command: string | null; status: Status;
  provider_id: string | null; model: string | null; run_model: string | null; run_auth: string | null;
  run_status: string | null; run_count: number; tokens_in: number; tokens_out: number; tokens_cached: number; cost_usd: number;
  tokens_total?: number; tokens_background?: number;
  eval_case_id: string | null;
  mined_class: string | null; // M12: drafted by failure mining from this failure class
  // M7: epic = planned by a planner; children have parent_id. handoff: a child's handoff, an epic's summary or failure reason.
  kind: "task" | "epic"; parent_id: string | null; parent_key: string | null; handoff: string | null; child_count: number; child_done: number;
  // M9: the "Split:" epic that replaced this ticket, and the ticket a "Split:" epic replaced.
  escalated_key: string | null; split_from_key: string | null;
  // M11 tracker. priority: 0 none, 1 urgent … 4 low.
  priority: number; estimate: number | null; due_date: string | null; created_at: number; updated_at: number;
  labels: { id: string; name: string; color: string }[]; project_id: string; project: { id: string; name: string; key: string }; milestone: { id: string; name: string } | null;
  cycle: { id: string; number: number; name: string } | null; assignee: { id: string; name: string; email: string } | null;
};
// GET /api/tickets/:id of an epic: every descendant with its state label (as the planner sees it) and dependency keys.
export type Child = Ticket & { label: string; depends_keys: string[] };
export type Run = {
  id: string; ticket_id: string; model: string; provider_id: string | null; auth_type: string | null; attempt: number; status: string;
  tokens_in: number; tokens_out: number; tokens_cached: number; cost_usd: number; started_at: number | null; ended_at: number | null;
  prompt_version: number | null; eval_run_id: string | null; role: "worker" | "planner" | "wiki";
  usage?: TokenSummary; background_usage?: TokenSummary; tokens_cache_write?: number;
  metrics?: RunMetrics | null; // once finished; the same object is the payload of its run_metrics event
};
// turns_pct / minutes_pct: share (0–100) of the attempt's turn and time budget; minutes_pct is null without a time limit.
export type RunMetrics = {
  turns: number; tool_calls: number; tool_errors: number; repeated_calls: number; repeated_reads: number; compactions: number;
  first_edit_turn: number | null; files_changed: number | null; turns_pct: number; minutes_pct: number | null;
  input: number; output: number; cache_read: number; stuck: null | { turn: number; signal: string; action: "nudge" | "stop" };
};

export type Provider = {
  id: string; name: string; kind: "anthropic" | "openai" | "ollama" | "openrouter" | "litellm"; auth_type: "api_key" | "oauth" | "none"; base_url: string | null;
  options: { data_collection?: "deny" | "allow" };
  account?: { email?: string; label: string; status: string; welcomed: boolean };
  context_window: number; has_secret: boolean; secret_last4: string | null; login: "pending" | "error" | null; login_error: string | null;
};

// Every API error is JSON {error}: a code or a sentence. Thrown as an Error whose message is ready to show (errorText).
export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error("Can't reach the Polaris server. Check that it is running, then try again.");
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(data, res.status));
  return data;
}

const CODES: Record<string, string> = {
  forbidden_origin: "Refused: the request did not come from this Polaris page. Open Polaris at its own address and try again.",
  not_found: "Not found: it may have been deleted. Reload the page.",
  unauthorized: "Your session has ended. Sign in again.",
  no_workspace: "Create a workspace first.",
  "internal error": "Something went wrong on the server. Try again; if it keeps happening, check the server log.",
  "ticket already has a running run": "This ticket already has a run in progress. Wait for it or cancel it first.",
};
// The one place an error body becomes a sentence for people (API errors here; auth-client errors in App.tsx).
export function errorText(data: any, status = 0) {
  const e: string = typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : "";
  if (e === "invalid_transition")
    return `A ${data.from} ticket can't be set to ${data.to} by hand. Only todo, done and failed can be set by hand (review only back to todo), and not while a run is queued or running; Run, Cancel, Approve and Reject do the rest.`;
  const s = CODES[e] ?? (e || (status >= 500 || !status ? CODES["internal error"] : `The request failed (HTTP ${status}).`));
  return s.replace(/^[a-z][a-z-]*(?=[\s:,])/, (w) => w[0].toUpperCase() + w.slice(1)); // "cancel the run first" → "Cancel …"; leaves "a/b.md …"
}

export const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
// ChatGPT-subscription runs have no per-token price.
export const cost = (usd: number, auth?: string | null) => (auth === "oauth" ? "ChatGPT plan" : usd > 0 ? `$${usd.toFixed(usd < 0.01 ? 4 : 2)}` : "—"); // 0 = price unknown
// Share of prompt tokens served from the provider's cache: cached / (uncached in incl. cache writes + cached).
export const hitRate = (tokens_in: number, tokens_cached: number) => (tokens_in + tokens_cached ? `${Math.round((100 * tokens_cached) / (tokens_in + tokens_cached))}%` : "—");
// An epic between planner rounds: its last round finished and it waits for children to settle.
export const waiting = (t: Ticket) => t.kind === "epic" && t.status === "running" && t.run_status !== "queued" && t.run_status !== "running";
export const duration = (r: Run) => (r.started_at ? `${(((r.ended_at ?? Date.now()) - r.started_at) / 1000).toFixed(1)}s` : "—");

// UI glyphs: outline only (1.5px stroke, currentColor, 24-unit grid), never emoji or filled shapes. Decorative: the
// control around one carries the accessible name.
const GLYPHS = {
  bell: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0",
  plus: "M12 5v14M5 12h14",
  check: "M20 6 9 17l-5-5",
  x: "M18 6 6 18M6 6l12 12",
  alert: "M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01",
  up: "M12 19V5M5 12l7-7 7 7",
  down: "M12 5v14M19 12l-7 7-7-7",
  more: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z",
  // Navigation and actions.
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  review: "M18 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v12M13 6h3a2 2 0 0 1 2 2v7",
  chat: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  box: "M21 8 12 3 3 8v8l9 5 9-5ZM3 8l9 5 9-5M12 13v8",
  layers: "M12 2 2 7l10 5 10-5ZM2 17l10 5 10-5M2 12l10 5 10-5",
  views: "M3 3h7v7H3ZM14 3h7v7h-7ZM14 14h7v7h-7ZM3 14h7v7H3Z",
  chart: "M3 3v18h18M7 16v-4M12 16V8M17 16v-7",
  bulb: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z",
  board: "M4 4h4v16H4ZM10 4h4v11h-4ZM16 4h4v14h-4Z",
  cycle: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5ZM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5",
  home: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM21 21l-4.3-4.3",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  bolt: "M13 2 3 14h9l-1 8 10-12h-9Z",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  code: "m16 18 6-6-6-6M8 6l-6 6 6 6",
  chevrons: "m7 15 5 5 5-5M7 9l5-5 5 5",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6",
  gear: "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
};
export type IconName = keyof typeof GLYPHS;
export const Icon = ({ name, size = 16 }: { name: IconName; size?: number }) => (
  <svg className="glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={GLYPHS[name]} />
  </svg>
);

// Small status glyphs, all static: circle = todo, half-filled circle = running, ring with dot = review, check = done, x = failed.
// label: the glyph is the only place the status shows (list rows, palette), so screen readers get it as an image.
// The Polaris mark, "circumpolar": a fixed point with two star trails turning around it (Polaris holds still while the
// agents work). One stroke weight on a 32-unit grid, drawn in currentColor: monochrome, no tile, no glow (DESIGN.md).
export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M9.42 18.39A7 7 0 0 1 22.06 12.5" />
      <path d="M27.75 20.28A12.5 12.5 0 1 1 11.72 4.25" />
      <circle cx="16" cy="16" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function StatusIcon({ status, label = false }: { status: string; label?: boolean }) {
  const c = { fill: "none", stroke: "currentColor", strokeWidth: 1.5 };
  return (
    <svg className={`icon s-${status}`} width="14" height="14" viewBox="0 0 14 14" {...(label ? { role: "img", "aria-label": status } : { "aria-hidden": true })}>
      {status === "running" ? (
        <>
          <circle cx="7" cy="7" r="5.5" {...c} />
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7Z" fill="currentColor" />
        </>
      ) : (
        <circle cx="7" cy="7" r="5.5" {...c} fill={status === "done" ? "currentColor" : "none"} />
      )}
      {status === "review" && <circle cx="7" cy="7" r="2.5" fill="currentColor" />}
      {status === "done" && <path d="M4.5 7.2l1.8 1.8 3.2-3.6" fill="none" stroke="var(--bg)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
      {status === "failed" && <path d="M5 5l4 4M9 5l-4 4" {...c} strokeLinecap="round" />}
    </svg>
  );
}

export type Theme = "system" | "light" | "dark";
// The palettes in web/style.css, default first; GET/PUT /api/me/preferences validates the same ids.
export const PALETTES = [
  { id: "black", name: "Black + Blue", hint: "True black, neutral greys, one steel blue. The default." },
  { id: "graphite", name: "Graphite", hint: "Linear-style monochrome: color only for status." },
  { id: "stone", name: "Stone & Ink", hint: "Warm monochrome, paper and ink." },
  { id: "polar", name: "Polar Night", hint: "Navy ink with a north-blue accent." },
  { id: "ember", name: "Ember", hint: "Warm charcoal with an orange accent." },
  { id: "teal", name: "Deep Teal", hint: "Black pearl and Boston blue." },
] as const;
type Appearance = { mode: Theme; palette: string };

// Applies an appearance to the page and keeps a copy for the next load (index.html applies it before first paint).
function apply(a: Appearance) {
  const root = document.documentElement;
  if (a.mode === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = a.mode;
  if (a.palette === PALETTES[0].id) root.removeAttribute("data-palette");
  else root.dataset.palette = a.palette;
  try {
    if (a.mode === "system") localStorage.removeItem("theme");
    else localStorage.setItem("theme", a.mode);
    localStorage.setItem("palette", a.palette);
  } catch {}
}

// The signed-in user's appearance, saved on the server (the same in every browser); the page shows the local copy until
// it loads. set() applies at once and saves.
const AppearanceCtx = createContext<{ appearance: Appearance; set: (a: Partial<Appearance>) => void } | null>(null);
export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    const root = document.documentElement;
    return { mode: (root.dataset.theme as Theme | undefined) ?? "system", palette: root.dataset.palette ?? PALETTES[0].id };
  });
  useEffect(() => void api<Appearance>("/api/me/preferences").then((a) => (apply(a), setAppearance(a)), () => {}), []);
  const set = (change: Partial<Appearance>) => {
    const next = { ...appearance, ...change };
    apply(next);
    setAppearance(next);
    api("/api/me/preferences", "PUT", change).catch(() => {}); // ponytail: a failed save keeps the local choice; the next load shows the saved one
  };
  return <AppearanceCtx.Provider value={{ appearance, set }}>{children}</AppearanceCtx.Provider>;
}
export const useAppearance = () => useContext(AppearanceCtx)!;

// The one modal: Esc or a click on the backdrop closes it; focus goes back to where it was. heading=false: the title is only its label.
export function Dialog({ title, onClose, children, className = "", heading = true }: { title: string; onClose: () => void; children: React.ReactNode; className?: string; heading?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.(); // layout cleanup: before the next dialog's autoFocus
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ${className}`.trim()} role="dialog" aria-modal="true" aria-label={title}>
        {heading && <h2>{title}</h2>}
        {children}
      </div>
    </div>
  );
}

// Every destructive action asks through this: what goes, then Cancel or the (focused) danger button.
export function Confirm({ title, children, action = "Delete", onConfirm, onClose }: { title: string; children: React.ReactNode; action?: string; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog title={title} onClose={onClose}>
      <p className="muted">{children}</p>
      <div className="row end">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn danger" autoFocus onClick={onConfirm}>{action}</button>
      </div>
    </Dialog>
  );
}

// Inline error under the control or form that failed; nothing when empty.
export const Alert = ({ error }: { error: string }) => (error ? <p className="error" role="alert">{error}</p> : null);
// A page or panel whose data has not arrived: "Loading…", or why it could not load.
export const Loading = ({ error = "" }: { error?: string }) => (error ? <p className="error pad" role="alert">{error}</p> : <p className="muted pad">Loading…</p>);

// GET path into state; reload refetches (after a change). Errors land in error, for <Loading> or <Alert>.
export function useApi<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => api<T>(path).then(setData, (e) => setError(e.message)), [path]);
  useEffect(() => void reload(), [reload]);
  return { data, error, setError, reload };
}

// A date that saves once, when it is left (blur) or Enter is pressed, not on every keystroke while a date is typed in.
// Keyed on the saved value, so a change from the server shows up.
export function DateField({ value, onSave, required, ...rest }: { value: string | null; onSave: (v: string | null) => void; required?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const save = (el: HTMLInputElement) => {
    if (el.value === (value ?? "")) return;
    if (!el.value && required) el.value = value ?? ""; // a required date can't be cleared
    else onSave(el.value || null);
  };
  return <DateInput key={value ?? ""} {...rest} defaultValue={value ?? ""} onBlur={(e) => save(e.target)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />;
}

// The native date input, dressed like the other controls: an empty one reads "Set date" instead of the browser's
// "yyyy/mm/dd", and the outline calendar glyph stands in for the OS picker icon (a click anywhere opens the picker).
export function DateInput({ placeholder = "Set date", ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  const ref = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState(!!props.defaultValue);
  useEffect(() => {
    const form = ref.current?.form;
    const reset = () => setTyped(false);
    form?.addEventListener("reset", reset);
    return () => form?.removeEventListener("reset", reset);
  }, []);
  const empty = props.value !== undefined ? !props.value : !typed;
  return (
    <span className={`date${empty ? " empty" : ""}`}>
      <input ref={ref} type="date" {...props} onInput={(e) => (setTyped(!!e.currentTarget.value), props.onInput?.(e))} />
      <span className="date-ph" aria-hidden="true">{placeholder}</span>
      <Icon name="calendar" size={14} />
    </span>
  );
}

export const when = (t: string | number) => new Date(t).toLocaleString();

export function useProviders() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const reload = () => api<Provider[]>("/api/providers").then(setProviders, () => {});
  useEffect(() => void reload(), []);
  return [providers, reload] as const;
}

// Provider + model selects. "Default" (empty provider) = the workspace default, then the server's env fallback.
// Picking a provider selects its first model, so the pair is always complete.
export function ModelPicker({ providers, provider_id, model, onChange, prefix = "" }: {
  providers: Provider[]; provider_id: string | null; model: string | null; prefix?: string;
  onChange: (v: { provider_id: string | null; model: string | null }) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    setModels([]);
    setNames({});
    setError("");
    if (!provider_id) return;
    let live = true;
    api<{ models: string[]; model_details?: { id: string; name: string }[] }>(`/api/providers/${provider_id}/models`).then(
      (r) => {
        if (!live) return;
        setModels(r.models);
        setNames(Object.fromEntries((r.model_details ?? []).map((m) => [m.id, m.name])));
        if (!model && r.models[0]) onChange({ provider_id, model: r.models[0] });
      },
      (e) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [provider_id, providers.find((p) => p.id === provider_id)?.account?.status]);
  const options = model && !models.includes(model) ? [model, ...models] : models;
  return (
    <>
      <select aria-label={`${prefix}Provider`} value={provider_id ?? ""} onChange={(e) => onChange({ provider_id: e.target.value || null, model: null })}>
        <option value="">Default</option>
        {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {provider_id && (
        <select aria-label={`${prefix}Model`} value={model ?? ""} onChange={(e) => onChange({ provider_id, model: e.target.value || null })}>
          {!model && <option value="">Model…</option>}
          {options.map((m) => <option key={m} value={m}>{names[m] ?? m}</option>)}
        </select>
      )}
      {providers.find((p) => p.id === provider_id)?.auth_type === "oauth" && <span className="hint">Using ChatGPT plan · <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a></span>}
      {error && <span className="error">{error}</span>}
    </>
  );
}

// The workspace change stream (GET /api/events): one EventSource shared by every subscriber on the page; each ping says
// which ticket or notification changed and the subscriber refetches. Reconnects are the browser's; a fetch on mount covers the gap.
type Change = { type: "ticket" | "notification" | "usage"; id: string };
const changeListeners = new Set<(c: Change) => void>();
let changes: EventSource | null = null;
export function useWorkspaceEvents(type: Change["type"], fn: (c: Change) => void) {
  useEffect(() => {
    const on = (c: Change) => c.type === type && fn(c);
    changeListeners.add(on);
    if (!changes) {
      changes = new EventSource("/api/events");
      for (const t of ["ticket", "notification", "usage"]) changes.addEventListener(t, (m) => changeListeners.forEach((l) => l(JSON.parse((m as MessageEvent).data))));
    }
    return () => {
      changeListeners.delete(on);
      if (!changeListeners.size) (changes?.close(), (changes = null));
    };
  }, [type, fn]);
}
