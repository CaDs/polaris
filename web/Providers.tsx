import { useEffect, useState, type FormEvent } from "react";
import { Dialog, ModelPicker, api, useProviders, type Provider } from "./ui.tsx";

type Check = { model: string; ok: boolean; tool_call: boolean; latency_ms: number; error?: string };
const KINDS = { anthropic: ["api_key"], openai: ["api_key", "oauth"], ollama: ["none"] } as const;
const CONTEXT_WINDOW = { anthropic: 1_000_000, openai: 400_000, ollama: 32_768 };
const AUTH_LABEL = { api_key: "API key", oauth: "ChatGPT sign-in", none: "No auth" };

export function Providers({ defaults }: { defaults: { default_provider_id: string | null; default_model: string | null; configured: boolean } }) {
  const [providers, reload] = useProviders();
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [checks, setChecks] = useState<Record<string, Check[] | string>>({}); // by provider id; string = error or "Testing…"
  const [pick, setPick] = useState({ provider_id: defaults.default_provider_id, model: defaults.default_model });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  // Sign-in happens in another tab: poll until the provider has tokens (or the login failed).
  const waiting = providers?.some((p) => p.login === "pending");
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(reload, 1500);
    return () => clearInterval(id);
  }, [waiting]);

  async function test(p: Provider) {
    setChecks((c) => ({ ...c, [p.id]: "Testing…" }));
    try {
      // Ollama: every installed model (tool support varies per model). Others: the default model only.
      const models = p.kind === "ollama" ? (await api<{ models: string[] }>(`/api/providers/${p.id}/models`)).models : [undefined];
      if (!models.length) throw new Error("no models installed");
      const out: Check[] = [];
      for (const model of models) {
        out.push(await api<Check>(`/api/providers/${p.id}/test`, "POST", { model }));
        setChecks((c) => ({ ...c, [p.id]: [...out] }));
      }
    } catch (e) {
      setChecks((c) => ({ ...c, [p.id]: (e as Error).message }));
    }
  }

  async function signIn(p: Provider) {
    setError("");
    const w = window.open("about:blank", "_blank"); // opened synchronously so the popup blocker allows it
    try {
      const { url } = await api<{ url: string }>(`/api/providers/${p.id}/oauth/start`, "POST");
      if (w) w.location.href = url;
      else setError(`Popup blocked. Open this link: ${url}`);
      reload();
    } catch (e) {
      w?.close();
      setError((e as Error).message);
    }
  }

  async function saveDefault() {
    setMsg("");
    setError("");
    try {
      await api("/api/settings/default-provider", "PUT", pick);
      setMsg("Default saved");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(p: Provider) {
    await api(`/api/providers/${p.id}`, "DELETE").catch((e) => setError(e.message));
    setDeleting(null);
    reload();
  }

  return (
    <section className="providers" aria-label="Providers">
      <h2>Providers</h2>
      <p className="muted">Models the agents can run on. Keys and tokens are encrypted at rest and never shown again.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="plist">
        {providers?.map((p) => {
          const c = checks[p.id];
          return (
            <li key={p.id}>
              <div className="row">
                <strong className="grow">{p.name}</strong>
                <span className="muted">{p.kind} · {AUTH_LABEL[p.auth_type]}</span>
                {p.auth_type === "api_key" && <span className="mono muted">{p.has_secret ? `••••${p.secret_last4 ?? ""}` : "no key"}</span>}
                {p.auth_type === "oauth" && (
                  <>
                    <span className="muted" role="status">{p.login === "pending" ? "Waiting for sign-in…" : p.has_secret ? "Signed in" : "Not signed in"}</span>
                    <button className="btn" onClick={() => signIn(p)}>Sign in with ChatGPT</button>
                  </>
                )}
                <button className="btn" onClick={() => test(p)}>Test</button>
                <button className="btn" onClick={() => setEditing(p)}>Edit</button>
                <button className="btn danger" onClick={() => setDeleting(p)}>Delete</button>
              </div>
              {p.login === "error" && <p className="error">Sign-in failed: {p.login_error}</p>}
              {p.auth_type === "oauth" && <span className="hint">Experimental and unofficial: uses your ChatGPT subscription through the Codex login. Personal use only; it may break at any time.</span>}
              {typeof c === "string" && <p className="muted">{c}</p>}
              {Array.isArray(c) && (
                <ul className="checks mono" aria-label={`Test results for ${p.name}`}>
                  {c.map((r) => (
                    <li key={r.model} className={r.ok && r.tool_call ? "ok" : "err"}>
                      {r.ok && r.tool_call ? "✓" : "✗"} {r.model} <span className="muted">{r.ok ? (r.tool_call ? `tool calling works · ${r.latency_ms} ms` : "answered without calling the tool") : r.error}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {providers?.length === 0 && <li className="muted">No providers yet.</li>}
      </ul>
      <button className="btn" onClick={() => setEditing("new")}>Add provider</button>

      <h2>Default model</h2>
      <p className="muted">Used by tickets that don't pick their own. Without one, the server falls back to its environment (ANTHROPIC_API_KEY …).</p>
      <div className="row">
        {providers && <ModelPicker providers={providers} prefix="Default " {...pick} onChange={setPick} />}
        <button className="btn" onClick={saveDefault}>Save default</button>
        {msg && <span className="muted" role="status">{msg}</span>}
      </div>

      {editing && <ProviderDialog p={editing === "new" ? null : editing} close={() => setEditing(null)} saved={() => (setEditing(null), reload())} />}
      {deleting && (
        <Dialog title="Delete provider?" onClose={() => setDeleting(null)}>
          <p className="muted">{deleting.name} and its stored credentials are deleted. Tickets that use it fall back to the default.</p>
          <div className="row end">
            <button className="btn" onClick={() => setDeleting(null)}>Cancel</button>
            <button className="btn danger" autoFocus onClick={() => remove(deleting)}>Delete</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}

function ProviderDialog({ p, close, saved }: { p: Provider | null; close: () => void; saved: () => void }) {
  const [kind, setKind] = useState<Provider["kind"]>(p?.kind ?? "anthropic");
  const [auth, setAuth] = useState<Provider["auth_type"]>(p?.auth_type ?? "api_key");
  const [error, setError] = useState("");
  const [window, setWindow] = useState(p ? String(p.context_window) : kind === "ollama" ? "" : String(CONTEXT_WINDOW[kind]));
  const pickKind = (k: Provider["kind"]) => (setKind(k), setAuth(KINDS[k][0]), setWindow(k === "ollama" ? "" : String(CONTEXT_WINDOW[k])));

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body = { name: f.name, kind, auth_type: auth, base_url: f.base_url || null, api_key: f.api_key || undefined, context_window: Number(f.context_window) || CONTEXT_WINDOW[kind] };
    try {
      await api(p ? `/api/providers/${p.id}` : "/api/providers", p ? "PATCH" : "POST", body);
      saved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Dialog title={p ? "Edit provider" : "Add provider"} onClose={close}>
      <form onSubmit={submit}>
        <label>
          Name <input name="name" defaultValue={p?.name} required maxLength={100} autoFocus />
        </label>
        <label>
          Kind
          <select value={kind} disabled={!!p} onChange={(e) => pickKind(e.target.value as Provider["kind"])}>
            <option value="anthropic">anthropic</option>
            <option value="openai">openai</option>
            <option value="ollama">ollama</option>
          </select>
        </label>
        <label>
          Auth type
          <select value={auth} onChange={(e) => setAuth(e.target.value as Provider["auth_type"])}>
            {KINDS[kind].map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
          </select>
          {auth === "oauth" && <span className="hint">Experimental, unofficial: sign in with your ChatGPT subscription from the provider's row after saving.</span>}
        </label>
        <label>
          Base URL
          <input name="base_url" className="mono" defaultValue={p?.base_url ?? ""} spellCheck={false}
            placeholder={kind === "ollama" ? "http://localhost:11434" : kind === "openai" ? "https://api.openai.com" : "https://api.anthropic.com"} />
        </label>
        <label>
          Context window (tokens)
          <input name="context_window" type="number" min={1000} step={1} value={window} onChange={(e) => setWindow(e.target.value)} required={kind !== "ollama"} placeholder={kind === "ollama" ? "auto" : undefined} />
          <span className="hint">Runs compact their conversation at 70% of this (and never above the workspace cap in Settings).{kind === "ollama" && " Leave empty (or 32768) to detect what Ollama serves."}</span>
        </label>
        {auth === "api_key" && (
          <label>
            API key
            <input name="api_key" type="password" autoComplete="off" spellCheck={false} placeholder={p?.has_secret ? "Leave empty to keep the stored key (a new base URL clears it)" : ""} />
            <span className="hint">Write-only: stored encrypted, only its last 4 characters are ever shown.</span>
          </label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row end">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn primary">{p ? "Save provider" : "Add provider"}</button>
        </div>
      </form>
    </Dialog>
  );
}
