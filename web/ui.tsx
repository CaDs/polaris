import { useEffect, useState } from "react";

export type Status = "todo" | "running" | "review" | "done" | "failed";
export const COLUMNS: Status[] = ["todo", "running", "review", "done", "failed"];
export type Ticket = {
  id: string; number: number; key: string; title: string; spec: string; test_command: string | null; status: Status;
  provider_id: string | null; model: string | null; run_model: string | null; run_auth: string | null;
  run_status: string | null; run_count: number; tokens_in: number; tokens_out: number; tokens_cached: number; cost_usd: number;
  eval_case_id: string | null;
  // M7: epic = planned by a planner; children have parent_id. handoff: a child's handoff, an epic's summary or failure reason.
  kind: "task" | "epic"; parent_id: string | null; parent_key: string | null; handoff: string | null; child_count: number; child_done: number;
  // M9: the "Split:" epic that replaced this ticket, and the ticket a "Split:" epic replaced.
  escalated_key: string | null; split_from_key: string | null;
  // M11 tracker. priority: 0 none, 1 urgent … 4 low.
  priority: number; estimate: number | null; due_date: string | null; created_at: number; updated_at: number;
  labels: { id: string; name: string; color: string }[]; project: { id: string; name: string } | null; milestone: { id: string; name: string } | null;
  cycle: { id: string; number: number; name: string } | null; assignee: { id: string; name: string; email: string } | null;
};
// GET /api/tickets/:id of an epic: every descendant with its state label (as the planner sees it) and dependency keys.
export type Child = Ticket & { label: string; depends_keys: string[] };
export type Run = {
  id: string; ticket_id: string; model: string; provider_id: string | null; auth_type: string | null; attempt: number; status: string;
  tokens_in: number; tokens_out: number; tokens_cached: number; cost_usd: number; started_at: number | null; ended_at: number | null;
  prompt_version: number | null; eval_run_id: string | null; role: "worker" | "planner" | "wiki";
};

export type Provider = {
  id: string; name: string; kind: "anthropic" | "openai" | "ollama"; auth_type: "api_key" | "oauth" | "none"; base_url: string | null;
  context_window: number; has_secret: boolean; secret_last4: string | null; login: "pending" | "error" | null; login_error: string | null;
};

export async function api<T = any>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? res.statusText);
  return data;
}

export const fmt = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
// ChatGPT-subscription runs have no per-token price.
export const cost = (usd: number, auth?: string | null) => (auth === "oauth" ? "subscription" : usd > 0 ? `$${usd.toFixed(usd < 0.01 ? 4 : 2)}` : "—"); // 0 = price unknown
// Share of prompt tokens served from the provider's cache: cached / (uncached in incl. cache writes + cached).
export const hitRate = (tokens_in: number, tokens_cached: number) => (tokens_in + tokens_cached ? `${Math.round((100 * tokens_cached) / (tokens_in + tokens_cached))}%` : "—");
// An epic between planner rounds: its last round finished and it waits for children to settle.
export const waiting = (t: Ticket) => t.kind === "epic" && t.status === "running" && t.run_status !== "queued" && t.run_status !== "running";
export const duration = (r: Run) => (r.started_at ? `${(((r.ended_at ?? Date.now()) - r.started_at) / 1000).toFixed(1)}s` : "—");

// Small status glyphs: circle = todo, spinning arc = running, ring with dot = review, check = done, x = failed.
export function StatusIcon({ status }: { status: string }) {
  const c = { fill: "none", stroke: "currentColor", strokeWidth: 1.5 };
  return (
    <svg className={`icon s-${status}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {status === "running" ? (
        <>
          <circle cx="7" cy="7" r="5.5" {...c} opacity=".3" />
          <path className="spin" d="M7 1.5a5.5 5.5 0 0 1 5.5 5.5" {...c} strokeLinecap="round" />
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
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem("theme");
      return t === "light" || t === "dark" ? t : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = theme;
    try {
      if (theme === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", theme);
    } catch {}
  }, [theme]);
  return [theme, setTheme] as const;
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

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
  const [error, setError] = useState("");
  useEffect(() => {
    setModels([]);
    setError("");
    if (!provider_id) return;
    let live = true;
    api<{ models: string[] }>(`/api/providers/${provider_id}/models`).then(
      (r) => {
        if (!live) return;
        setModels(r.models);
        if (!model && r.models[0]) onChange({ provider_id, model: r.models[0] });
      },
      (e) => live && setError(e.message),
    );
    return () => void (live = false);
  }, [provider_id]);
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
          {options.map((m) => <option key={m}>{m}</option>)}
        </select>
      )}
      {error && <span className="error">{error}</span>}
    </>
  );
}
