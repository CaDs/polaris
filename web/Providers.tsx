import { useEffect, useState, type FormEvent } from "react";
import { Alert, Confirm, Dialog, Icon, api, type Provider } from "./ui.tsx";

type Check = { model: string; ok: boolean; tool_call: boolean; latency_ms: number; error?: string };
const KINDS = { anthropic: ["api_key"], openai: ["api_key", "oauth"], ollama: ["none"], openrouter: ["api_key"], litellm: ["api_key", "none"] } as const;
const KIND_LABEL = { anthropic: "Anthropic", openai: "OpenAI", ollama: "Ollama", openrouter: "OpenRouter", litellm: "LiteLLM proxy" };
const CONTEXT_WINDOW = { anthropic: 1_000_000, openai: 400_000, ollama: 32_768, openrouter: 128_000, litellm: 128_000 };
const AUTO_WINDOW = ["ollama", "openrouter"]; // left empty (or at the default): detected per model
const BASE_URL_HINT = {
  anthropic: ["https://api.anthropic.com", "Leave empty for Anthropic's API."],
  openai: ["https://api.openai.com", "Leave empty for OpenAI's API."],
  ollama: ["http://localhost:11434", "Leave empty for Ollama on this machine."],
  litellm: ["http://localhost:4000", "Your LiteLLM proxy (litellm --config config.yaml). Models are the proxy's model_list aliases."],
} as const;
const AUTH_LABEL = { api_key: "API key", oauth: "ChatGPT sign-in", none: "No auth" };
// Many models behind one key: the Test button checks the model picked next to it.
const PICK_TEST_MODEL = ["openrouter", "litellm"];

// The list is the Models tab's (Settings), which shares it with its model pickers so a new provider shows there at once.
export function Providers({ providers, reload }: { providers: Provider[] | null; reload: () => void }) {
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [deleting, setDeleting] = useState<Provider | null>(null);
  const [checks, setChecks] = useState<Record<string, Check[] | string>>({}); // by provider id; string = error or "Testing…"
  const [testModel, setTestModel] = useState<Record<string, string>>({});
  const [catalogs, setCatalogs] = useState<Record<string, { id: string; name: string }[] | string>>({}); // string = error
  const catalog = (p: Provider) => {
    if (catalogs[p.id]) return;
    setCatalogs((c) => ({ ...c, [p.id]: [] }));
    api<{ models: string[]; model_details?: { id: string; name: string }[] }>(`/api/providers/${p.id}/models`).then(
      (r) => setCatalogs((c) => ({ ...c, [p.id]: r.model_details ?? r.models.map((id) => ({ id, name: id })) })),
      (e) => setCatalogs((c) => ({ ...c, [p.id]: e.message })),
    );
  };
  useEffect(() => providers?.filter((p) => PICK_TEST_MODEL.includes(p.kind) && (p.has_secret || p.auth_type === "none")).forEach(catalog), [providers]);
  const [error, setError] = useState("");
  const [welcomeClosed, setWelcomeClosed] = useState(false);
  const welcome = providers?.find((p) => p.account?.status === "connected" && !p.account.welcomed);

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
      // Ollama: every installed model (tool support varies per model). OpenRouter, LiteLLM: the picked one. Others: the default.
      const models = p.kind === "ollama" ? (await api<{ models: string[] }>(`/api/providers/${p.id}/models`)).models
        : PICK_TEST_MODEL.includes(p.kind) ? [testModel[p.id] || (Array.isArray(catalogs[p.id]) ? (catalogs[p.id] as { id: string }[])[0]?.id : undefined)] : [undefined];
      if (!models.length) throw new Error("no models installed");
      const out: Check[] = [];
      for (const model of models) {
        out.push(await api<Check>(`/api/providers/${p.id}/test`, "POST", { model }));
        setChecks((c) => ({ ...c, [p.id]: [...out] }));
      }
    } catch (e) {
      setChecks((c) => ({ ...c, [p.id]: (e as Error).message }));
    } finally { reload(); }
  }

  async function signIn(p: Provider, consent = false) {
    setError("");
    const w = window.open("about:blank", "_blank"); // opened synchronously so the popup blocker allows it
    try {
      const { url } = await api<{ url: string }>(`/api/providers/${p.id}/oauth/start`, "POST", { consent });
      if (w) w.location.href = url;
      else setError("Popup blocked. Allow popups for Polaris and try Continue with ChatGPT again.");
      reload();
    } catch (e) {
      w?.close();
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
      <Alert error={error} />
      {welcome && !welcomeClosed && <Dialog title="You're using your ChatGPT plan" onClose={() => void api(`/api/providers/${welcome.id}/oauth/acknowledge`, "POST").then(() => (setWelcomeClosed(true), reload()))}>
        <p>Eligible AI requests from this provider use your ChatGPT plan. You can manage Polaris access and usage in ChatGPT settings.</p>
        <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">Manage usage</a>
        <button className="btn primary" onClick={() => void api(`/api/providers/${welcome.id}/oauth/acknowledge`, "POST").then(() => (setWelcomeClosed(true), reload()))}>Got it</button>
      </Dialog>}
      <ul className="plist">
        {providers?.map((p) => {
          const c = checks[p.id];
          return (
            <li key={p.id}>
              <div className="row">
                <strong className="grow">{p.name}</strong>
                <span className="muted">{KIND_LABEL[p.kind]} · {AUTH_LABEL[p.auth_type]}{p.kind === "openrouter" && (p.options.data_collection === "allow" ? " · any provider" : " · no data collection")}</span>
                {p.auth_type === "api_key" && <span className="mono muted">{p.has_secret ? `••••${p.secret_last4 ?? ""}` : "no key"}</span>}
                {p.auth_type === "oauth" && (
                  <>
                    <span className="muted" role="status">{p.login === "pending" ? "Waiting for sign-in…" : p.account?.status === "connected" ? `Connected · ${p.account.label}` : p.account?.status === "usage_limited" ? "Plan usage paused · Manage usage, then Test to retry" : p.account?.status === "plan_disabled" ? "Plan usage not enabled" : p.account?.status === "reconnect_required" ? "Reconnect required" : "Not signed in"}</span>
                    <button className="btn" onClick={() => signIn(p, p.account?.status === "plan_disabled")}>Continue with ChatGPT</button>
                    {p.login === "pending" && <button className="btn" onClick={() => void api(`/api/providers/${p.id}/oauth/cancel`, "POST").then(reload)}>Cancel sign-in</button>}
                    {p.has_secret && <button className="btn" onClick={() => void api<{ warning?: string }>(`/api/providers/${p.id}/oauth/logout`, "POST").then((r) => (setError(r.warning ?? ""), reload()))}>Disconnect ChatGPT</button>}
                  </>
                )}
                {PICK_TEST_MODEL.includes(p.kind) && Array.isArray(catalogs[p.id]) && (catalogs[p.id] as unknown[]).length > 0 && (
                  <select aria-label={`Model to test on ${p.name}`} value={testModel[p.id] ?? ""} onChange={(e) => setTestModel((m) => ({ ...m, [p.id]: e.target.value }))}>
                    {(catalogs[p.id] as { id: string; name: string }[]).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                )}
                <button className="btn" onClick={() => test(p)}>Test</button>
                <button className="btn" onClick={() => setEditing(p)}>Edit</button>
                <button className="btn danger" onClick={() => setDeleting(p)}>Delete</button>
              </div>
              {p.login === "error" && <p className="error">Sign-in failed: {p.login_error}</p>}
              {typeof catalogs[p.id] === "string" && <p className="error">{catalogs[p.id] as string}</p>}
              {p.auth_type === "oauth" && <span className="hint">Eligible requests use your ChatGPT plan. Token usage is tracked like local and API-key models.</span>}
              {typeof c === "string" && <p className="muted">{c}</p>}
              {Array.isArray(c) && (
                <ul className="checks mono" aria-label={`Test results for ${p.name}`}>
                  {c.map((r) => (
                    <li key={r.model} className={r.ok && r.tool_call ? "ok" : "err"}>
                      <Icon name={r.ok && r.tool_call ? "check" : "x"} size={13} /> {r.model} <span className="muted">{r.ok ? (r.tool_call ? `tool calling works · ${r.latency_ms} ms` : "answered without calling the tool") : r.error}</span>
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

      {editing && <ProviderDialog p={editing === "new" ? null : editing} close={() => setEditing(null)} saved={() => (setEditing(null), reload())} />}
      {deleting && (
        <Confirm title="Delete provider?" onConfirm={() => remove(deleting)} onClose={() => setDeleting(null)}>
          {deleting.name} and its stored credentials are deleted. Tickets that use it fall back to the default.
        </Confirm>
      )}
    </section>
  );
}

function ProviderDialog({ p, close, saved }: { p: Provider | null; close: () => void; saved: () => void }) {
  const [kind, setKind] = useState<Provider["kind"]>(p?.kind ?? "anthropic");
  const [auth, setAuth] = useState<Provider["auth_type"]>(p?.auth_type ?? "api_key");
  const [error, setError] = useState("");
  // Empty = auto: a new Ollama/OpenRouter provider, or one still at the default (the server treats that as auto).
  const [window, setWindow] = useState(AUTO_WINDOW.includes(kind) && (!p || p.context_window === CONTEXT_WINDOW[kind]) ? "" : String(p?.context_window ?? CONTEXT_WINDOW[kind]));
  const pickKind = (k: Provider["kind"]) => (setKind(k), setAuth(KINDS[k][0]), setWindow(AUTO_WINDOW.includes(k) ? "" : String(CONTEXT_WINDOW[k])));
  const [share, setShare] = useState(p?.options.data_collection === "allow");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body = {
      name: f.name, kind, auth_type: auth, base_url: f.base_url || null, api_key: f.api_key || undefined, context_window: Number(f.context_window) || CONTEXT_WINDOW[kind],
      ...(kind === "openrouter" ? { options: { data_collection: share ? "allow" : "deny" } } : {}),
    };
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
            {(Object.keys(KINDS) as Provider["kind"][]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          {kind === "openrouter" && <span className="hint">Hundreds of models behind one key, at <span className="mono">openrouter.ai</span>. Billed per request; the cost OpenRouter reports goes into Usage and spending caps.</span>}
        </label>
        <label>
          Auth type
          <select value={auth} onChange={(e) => setAuth(e.target.value as Provider["auth_type"])}>
            {KINDS[kind].map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
          </select>
          {auth === "oauth" && <span className="hint">Connect your ChatGPT account from the provider row after saving. No API key is needed.</span>}
        </label>
        {auth !== "oauth" && kind !== "openrouter" && <label>
          Base URL
          <input name="base_url" className="mono" defaultValue={p?.base_url ?? ""} spellCheck={false} required={kind === "litellm"} placeholder={BASE_URL_HINT[kind][0]} />
          <span className="hint">{BASE_URL_HINT[kind][1]} https is required except on this machine or a private network, so a key never crosses the internet unencrypted.</span>
        </label>}
        {kind === "openrouter" && (
          <>
            <label className="check">
              <input type="checkbox" checked={share} onChange={(e) => setShare(e.target.checked)} /> Allow providers that may store or train on prompts
            </label>
            <span className="hint">Off (recommended): OpenRouter routes only to providers that neither retain nor train on your code. Some models are then unavailable.</span>
          </>
        )}
        <label>
          Context window (tokens)
          <input name="context_window" type="number" min={1000} step={1} value={window} onChange={(e) => setWindow(e.target.value)} required={!AUTO_WINDOW.includes(kind)} placeholder={AUTO_WINDOW.includes(kind) ? "auto" : undefined} />
          <span className="hint">Runs compact their conversation at 70% of this (and never above the cap in Settings → Limits).{kind === "ollama" && " Leave empty (or 32768) to detect what Ollama serves."}{kind === "openrouter" && " Leave empty to use each model's context length from OpenRouter's catalog."}</span>
        </label>
        {auth === "api_key" && (
          <label>
            API key
            <input name="api_key" type="password" autoComplete="off" spellCheck={false} placeholder={p?.has_secret ? "Leave empty to keep the stored key (a new base URL clears it)" : ""} />
            <span className="hint">Write-only: stored encrypted, only its last 4 characters are ever shown (none for short keys). {kind === "litellm" ? "A LiteLLM master or virtual key; pick No auth if the proxy has none." : ""}</span>
          </label>
        )}
        <Alert error={error} />
        <div className="row end">
          <button type="button" className="btn" onClick={close}>Cancel</button>
          <button className="btn primary">{p ? "Save provider" : "Add provider"}</button>
        </div>
      </form>
    </Dialog>
  );
}
