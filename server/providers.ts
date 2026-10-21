import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { db } from "./db.ts";
import { anthropic, DEFAULT_MODEL } from "./agent/providers/anthropic.ts";
import { openai } from "./agent/providers/openai.ts";
import { chatCompletions } from "./agent/providers/chat.ts";
import { checkUrl, EgressError, providerFetch, scrub } from "./egress.ts";
import { cancelLogin, logins, OAuthError, openaiPlanBase, PLAN_SCOPE, refreshTokens, registration, revoke, startLogin, withoutTokens, type Tokens } from "./oauth.ts";
import { metered } from "./usage.ts";
import { decrypt, encrypt, SecretKeyError } from "./secrets.ts";
import { AgentError, type Provider } from "./agent/types.ts";

export type ProviderRow = {
  id: string; workspace_id: string; name: string; kind: "anthropic" | "openai" | "ollama" | "openrouter" | "litellm"; auth_type: "api_key" | "oauth" | "none";
  encrypted_secret: string | null; base_url: string | null; context_window: number; options: string; created_at: number;
};
// options (JSON). OpenRouter: data_collection "deny" (the default: route only to providers that neither store nor train on
// prompts) or "allow".
type Options = { data_collection?: "deny" | "allow" };
const optionsOf = (p: ProviderRow): Options => { try { return JSON.parse(p.options || "{}"); } catch { return {}; } };

// Default context window (tokens) by kind; editable per provider. Ollama and OpenRouter at their default: detected per model.
export const CONTEXT_WINDOW: Record<ProviderRow["kind"], number> = { anthropic: 1_000_000, openai: 400_000, ollama: 32_768, openrouter: 128_000, litellm: 128_000 };

const AUTH: Record<ProviderRow["kind"], ProviderRow["auth_type"][]> = {
  anthropic: ["api_key"], openai: ["api_key", "oauth"], ollama: ["none"], openrouter: ["api_key"], litellm: ["api_key", "none"],
};
export const OLLAMA_URL = "http://localhost:11434";
// OpenRouter is only ever its official endpoint (no base URL field: the key is not sent anywhere else); LiteLLM is the
// user's proxy. POLARIS_OPENROUTER_URL: tests only (operator-set, still under the egress policy).
export const OPENROUTER_URL = process.env.POLARIS_OPENROUTER_URL ?? "https://openrouter.ai/api/v1";
const OPENROUTER_HEADERS = { "HTTP-Referer": "https://github.com/CaDs/polaris", "X-Title": "Polaris" }; // OpenRouter's app attribution
const litellmBase = (p: ProviderRow) => (p.base_url ?? "").replace(/\/+$/, "").replace(/\/v1$/, "");
const ANTHROPIC_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const OPENAI_MODELS = ["gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-4.1"]; // fallback when GET /v1/models is unavailable
const openaiBase = (p: ProviderRow) => (p.base_url || process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");

export const providerById = (id: string) => db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;

// The secret is never returned: only whether one is stored and, for API keys, its last 4 chars.
export function oauthRegistration(p: ProviderRow) {
  try { return p.encrypted_secret ? registration(decrypt(p.encrypted_secret)) : undefined; } catch { return undefined; }
}
function view(p: ProviderRow) {
  let last4: string | null = null;
  if (p.encrypted_secret && p.auth_type === "api_key")
    try {
      const key = decrypt(p.encrypted_secret);
      if (key.length >= 16) last4 = key.slice(-4); // a short key (a LiteLLM "sk-1234") would be mostly revealed
    } catch {} // key rotated or missing: still has_secret, just unmasked
  let account: { email?: string; label: string; status: string; welcomed: boolean } | undefined;
  if (p.auth_type === "oauth") {
    try {
      const t = oauthRegistration(p);
      account = { email: t?.email, label: t?.email ? `${p.name} · ${t.email}` : p.name,
        status: !t ? (p.encrypted_secret ? "reconnect_required" : "signed_out") : !t.access ? "signed_out" : !t.scopes.includes(PLAN_SCOPE) ? "plan_disabled" : t.blocked_code ? "usage_limited" : "connected", welcomed: t?.welcomed ?? false };
    } catch { account = { label: p.name, status: "reconnect_required", welcomed: false }; }
  }
  const login = logins.get(p.id);
  return {
    id: p.id, name: p.name, kind: p.kind, auth_type: p.auth_type, base_url: p.base_url, context_window: p.context_window, options: optionsOf(p), created_at: p.created_at,
    account, has_secret: p.auth_type === "oauth" ? ["connected", "plan_disabled", "usage_limited"].includes(account?.status ?? "") : !!p.encrypted_secret, secret_last4: last4, login: login?.status ?? null, login_error: login?.error ?? null,
  };
}

// ChatGPT OAuth tokens live encrypted in the secret column; refreshed a minute before expiry. Concurrent runs share one refresh
// (refresh tokens rotate, so two parallel refreshes would invalidate each other).
const refreshing = new Map<string, Promise<Tokens>>();
export async function freshTokens(p: ProviderRow): Promise<Tokens> {
  const latest = providerById(p.id);
  if (!latest || latest.auth_type !== "oauth") throw new AgentError("ProviderError", "ChatGPT provider was removed or changed");
  const cur = oauthRegistration(latest);
  if (!cur?.access || !cur.refresh) throw new AgentError("ProviderError", "Reconnect your ChatGPT account in Settings");
  if (cur.blocked_code) {
    const e = new AgentError("ProviderError", "ChatGPT plan usage is paused. Manage usage in ChatGPT settings, then use Test to explicitly check again, or choose Ollama.");
    e.code = cur.blocked_code;
    throw e;
  }
  if (!cur.scopes.includes(PLAN_SCOPE)) throw new AgentError("ProviderError", "Enable ChatGPT plan usage in Settings before running this provider");
  if ((cur.expires ?? 0) - Date.now() > 60_000) return cur;
  let job = refreshing.get(p.id);
  if (!job) {
    const saved = latest.encrypted_secret;
    job = refreshTokens(cur).then(async (t) => {
      const now = providerById(p.id);
      const active = now?.auth_type === "oauth" ? oauthRegistration(now) : undefined;
      const sameSession = active?.refresh === cur.refresh && active?.access === cur.access && active?.client_id === cur.client_id && active?.subject === cur.subject;
      // Preserve UI acknowledgements or a concurrent quota pause, but never overwrite a changed login session.
      const next = { ...t, welcomed: active?.welcomed, blocked_code: active?.blocked_code };
      const r = sameSession ? db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=? AND encrypted_secret=?").run(encrypt(JSON.stringify(next)), p.id, now!.encrypted_secret) : { changes: 0 };
      if (!r.changes) {
        await revoke(t).catch(() => {}); // discard and revoke a rotation that lost a race with logout/reconnection
        throw new Error("ChatGPT connection changed while refreshing; retry with the current connection");
      }
      return next;
    }).catch((e) => {
      if (e instanceof OAuthError && /^(invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused)$/.test(e.code))
        db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=? AND encrypted_secret=?").run(encrypt(JSON.stringify(withoutTokens(cur))), p.id, saved);
      throw e;
    });
    refreshing.set(p.id, job);
    job.then(() => refreshing.delete(p.id), () => refreshing.delete(p.id));
  }
  const next = await job.catch(() => { throw new AgentError("ProviderError", "ChatGPT token refresh failed. Retry later, or reconnect in Settings if the session expired."); });
  if (!next.scopes.includes(PLAN_SCOPE)) throw new AgentError("ProviderError", "Enable ChatGPT plan usage in Settings before running this provider");
  if (next.blocked_code) throw new AgentError("ProviderError", "ChatGPT plan usage is paused. Manage usage in ChatGPT settings, then use Test to explicitly check again.");
  return next;
}

// All callers share request accounting. Credentials stay on the server; tools run in the existing sandbox.
export function adapterFor(p: ProviderRow): Provider {
  try {
    const secret = p.auth_type === "api_key" ? (p.encrypted_secret ? decrypt(p.encrypted_secret) : "") : "";
    if (p.auth_type === "api_key" && !secret) throw new Error(`provider "${p.name}" has no API key`);
    let provider: Provider;
    if (p.kind === "ollama") provider = anthropic({ apiKey: "ollama", baseUrl: p.base_url || OLLAMA_URL });
    else if (p.kind === "anthropic") provider = anthropic({ apiKey: secret, baseUrl: p.base_url || undefined });
    else if (p.kind === "openrouter")
      provider = chatCompletions({
        url: `${OPENROUTER_URL}/chat/completions`, headers: { authorization: `Bearer ${secret}`, ...OPENROUTER_HEADERS },
        // usage.include: the billed cost comes back with the usage (the ledger records it, caps count it).
        extra: { usage: { include: true }, ...(optionsOf(p).data_collection === "allow" ? {} : { provider: { data_collection: "deny" } }) },
      });
    else if (p.kind === "litellm") provider = chatCompletions({ url: `${litellmBase(p)}/v1/chat/completions`, headers: secret ? { authorization: `Bearer ${secret}` } : {} });
    else if (p.auth_type === "api_key") provider = openai({ url: `${openaiBase(p)}/v1/responses`, headers: async () => ({ authorization: `Bearer ${secret}` }) });
    else provider = openai({ url: `${openaiPlanBase()}/responses`, subscription: true,
      headers: async () => ({ authorization: `Bearer ${(await freshTokens(p)).access}` }) });
    if (p.auth_type === "oauth") {
      const transport = provider;
      provider = { async stream(req, on) {
        try { return await transport.stream(req, on); }
        catch (e) {
          if (e instanceof AgentError && e.code === "subscription_sharing_usage_limit_exceeded") {
            const latest = providerById(p.id);
            const t = latest && oauthRegistration(latest);
            if (t) db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=? AND encrypted_secret=?").run(encrypt(JSON.stringify({ ...t, blocked_code: e.code })), p.id, latest!.encrypted_secret);
          }
          throw e;
        }
      } };
    }
    // An error that echoes the key never leaves here with it (events, transcripts and the UI show error messages).
    const transport = provider;
    provider = { async stream(req, on) {
      try { return await transport.stream(req, on); }
      catch (e) {
        if (e instanceof Error) e.message = scrub(e.message, secret ? [secret] : []);
        throw e;
      }
    } };
    return metered(provider, { id: p.id, name: p.name, kind: p.kind, billing: p.kind === "ollama" ? "local" : p.auth_type === "oauth" ? "subscription" : "api_key" }, p.workspace_id);
  } catch (e) { throw new AgentError("ProviderError", (e as Error).message); }
}

// OpenRouter's catalog (public; the key is sent so account-restricted models show): tool-capable models with their names
// and context lengths. Cached an hour per process.
type CatalogModel = { id: string; name: string; context_length: number };
let catalog: { at: number; models: CatalogModel[] } | undefined;
async function openrouterCatalog(secret?: string) {
  if (catalog && Date.now() - catalog.at < 3_600_000) return catalog.models;
  const res = await providerFetch(`${OPENROUTER_URL}/models`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} }, 15_000);
  if (!res.ok) throw new Error(`OpenRouter answered HTTP ${res.status}`);
  const j = (await res.json()) as { data?: { id: string; name?: string; context_length?: number; supported_parameters?: string[] }[] };
  const models = (j.data ?? []).filter((m) => typeof m.id === "string" && m.supported_parameters?.includes("tools"))
    .map((m) => ({ id: m.id, name: m.name || m.id, context_length: m.context_length ?? 0 })).sort((a, b) => a.id.localeCompare(b.id));
  catalog = { at: Date.now(), models };
  return models;
}

// The context window OpenRouter lists for a model, for a provider left at the default. undefined: unknown.
export async function openrouterWindow(model: string) {
  const m = (await openrouterCatalog().catch(() => [])).find((x) => x.id === model);
  return m?.context_length ? { window: m.context_length, source: "OpenRouter catalog" } : undefined;
}

// The context the Ollama server actually serves (it is the server's num_ctx, not the model's maximum): the loaded
// model's context_length from /api/ps, else the model's trained maximum from /api/show. undefined: could not tell.
export async function ollamaWindow(base: string | null, model: string) {
  const url = (base || OLLAMA_URL).replace(/\/$/, "");
  const get = async (path: string, body?: unknown) => {
    const res = await providerFetch(url + path, { method: body ? "POST" : "GET", body: body ? JSON.stringify(body) : undefined }, 5_000);
    return res.ok ? ((await res.json()) as any) : undefined;
  };
  const ok = (n: unknown) => (Number.isInteger(n) && (n as number) > 0 ? (n as number) : undefined);
  try {
    const ps = ((await get("/api/ps"))?.models ?? []).find((m: any) => m.name === model || m.model === model);
    if (ok(ps?.context_length)) return { window: ps.context_length as number, source: "ollama /api/ps" };
    const info = (await get("/api/show", { model }))?.model_info ?? {};
    const key = Object.keys(info).find((k) => k.endsWith(".context_length"));
    if (key && ok(info[key])) return { window: info[key] as number, source: "ollama /api/show" };
  } catch {}
}

async function listModels(p: ProviderRow): Promise<string[]> {
  if (p.kind === "anthropic") return ANTHROPIC_MODELS;
  if (p.kind === "ollama") {
    const res = await providerFetch(`${(p.base_url || OLLAMA_URL).replace(/\/$/, "")}/api/tags`, {}, 10_000);
    if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);
    return ((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name);
  }
  if (p.auth_type === "oauth") return (await planModels(p)).map((m) => m.id);
  const key = p.encrypted_secret ? decrypt(p.encrypted_secret) : "";
  if (p.kind === "openrouter") return (await openrouterCatalog(key)).map((m) => m.id);
  if (p.kind === "litellm") {
    // The proxy's model aliases (its config.yaml model_list), as the key is allowed to see them.
    const res = await providerFetch(`${litellmBase(p)}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} }, 10_000);
    if (!res.ok) throw new Error(`LiteLLM answered HTTP ${res.status}${res.status === 401 ? " (check the key)" : ""}`);
    return (((await res.json()) as { data?: { id: string }[] }).data ?? []).map((m) => m.id).filter((id) => typeof id === "string").sort();
  }
  if (!p.encrypted_secret) return OPENAI_MODELS;
  try {
    const res = await providerFetch(`${openaiBase(p)}/v1/models`, { headers: { authorization: `Bearer ${key}` } }, 10_000);
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id);
    const chat = ids.filter((id) => /^(gpt-|o\d|codex-)/.test(id) && !/embed|whisper|tts|image|audio|realtime|transcribe|moderation|search|instruct/.test(id)).sort();
    return chat.length ? chat : OPENAI_MODELS;
  } catch {
    return OPENAI_MODELS;
  }
}

async function planModels(p: ProviderRow) {
  const t = await freshTokens(p);
  const res = await fetch(`${openaiPlanBase()}/models`, { headers: { authorization: `Bearer ${t.access}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new AgentError("ProviderError", `ChatGPT model discovery failed (HTTP ${res.status}). Check your connection and plan permission.`);
  const j = await res.json() as { models?: { slug: string; display_name: string; visibility: string }[] };
  if (!Array.isArray(j.models)) throw new Error("ChatGPT returned no model catalog");
  return j.models.filter((m) => m.visibility === "list" && typeof m.slug === "string").map((m) => ({ id: m.slug, name: m.display_name || m.slug }));
}

const echo = { name: "echo", description: "Echo a string back.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

type Env = { Variables: { workspaceId: string } };
export const providerRoutes = new Hono<Env>();

const own = (ws: string, id: string) => db.prepare("SELECT * FROM providers WHERE id = ? AND workspace_id = ?").get(id, ws) as ProviderRow | undefined;

providerRoutes.get("/", (c) =>
  c.json((db.prepare("SELECT * FROM providers WHERE workspace_id = ? ORDER BY created_at, rowid").all(c.get("workspaceId")) as ProviderRow[]).map(view)),
);

// Validated create/patch body. Secrets only with a configured POLARIS_SECRET_KEY.
async function parse(c: { req: { json: () => Promise<any> } }, cur?: ProviderRow) {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "body must be a JSON object" };
  const name = b.name !== undefined ? b.name : cur?.name;
  const kind = cur?.kind ?? b.kind;
  const auth_type = b.auth_type ?? cur?.auth_type ?? AUTH[kind as ProviderRow["kind"]]?.[0];
  const base_url = b.base_url !== undefined ? b.base_url : cur?.base_url;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) return { error: "name is required (1-100 chars)" };
  if (!(kind in AUTH)) return { error: `kind must be one of ${Object.keys(AUTH).join(", ")}` };
  if (cur && b.kind !== undefined && b.kind !== cur.kind) return { error: "kind cannot be changed" };
  if (!AUTH[kind as ProviderRow["kind"]].includes(auth_type)) return { error: `${kind} supports auth type ${AUTH[kind as ProviderRow["kind"]].join(" or ")}` };
  if (kind === "openai" && auth_type === "oauth" && base_url) return { error: "ChatGPT plan connections use the official OpenAI endpoint; clear the base URL" };
  if (kind === "openrouter" && base_url) return { error: `OpenRouter is always ${OPENROUTER_URL}; clear the base URL` };
  if (kind === "litellm" && !base_url) return { error: "base URL is required: your LiteLLM proxy, e.g. http://localhost:4000" };
  if (base_url) {
    try {
      if (typeof base_url !== "string") throw new EgressError("base URL must be an http(s) URL");
      checkUrl(base_url); // scheme, no credentials, no metadata address, https unless local (egress.ts)
    } catch (e) {
      if (e instanceof EgressError) return { error: e.message };
      throw e;
    }
  }
  let options = cur ? optionsOf(cur) : {};
  if (b.options !== undefined) {
    const dc = b.options?.data_collection;
    if (kind !== "openrouter" || (dc !== undefined && dc !== "deny" && dc !== "allow")) return { error: 'options: only OpenRouter takes options, data_collection "deny" or "allow"' };
    options = { ...options, ...(dc ? { data_collection: dc } : {}) };
  }
  const context_window = b.context_window ?? cur?.context_window ?? CONTEXT_WINDOW[kind as ProviderRow["kind"]];
  if (!Number.isInteger(context_window) || context_window < 1000 || context_window > 100_000_000) return { error: "context window must be a whole number of tokens (1000 to 100000000)" };
  let secret: string | null | undefined; // undefined = keep
  if (b.api_key !== undefined && b.api_key !== "") {
    // Printable, no spaces or line breaks: a key is sent as a header value (no header injection, no pasted junk).
    if (typeof b.api_key !== "string" || b.api_key.trim().length > 500 || !/^[\x21-\x7e]+$/.test(b.api_key.trim())) return { error: "api_key must be printable text without spaces (at most 500 chars)" };
    if (auth_type !== "api_key") return { error: "this auth type has no API key" };
    try {
      secret = encrypt(b.api_key.trim());
    } catch (e) {
      if (e instanceof SecretKeyError) return { error: e.message };
      throw e;
    }
  } else if (cur && (auth_type !== cur.auth_type || (base_url || null) !== cur.base_url)) secret = null; // a new auth type or endpoint drops the old credential (it would be sent there)
  return { v: { name: name.trim(), kind, auth_type, base_url: base_url || null, context_window: context_window as number, secret, options: JSON.stringify(options) } };
}

providerRoutes.post("/", async (c) => {
  const p = await parse(c);
  if ("error" in p) return c.json(p, 400);
  const id = randomUUID();
  const v = p.v;
  db.prepare("INSERT INTO providers (id, workspace_id, name, kind, auth_type, encrypted_secret, base_url, context_window, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, c.get("workspaceId"), v.name, v.kind, v.auth_type, v.secret ?? null, v.base_url, v.context_window, v.options,
  );
  return c.json(view(providerById(id)!), 201);
});

providerRoutes.patch("/:id", async (c) => {
  const cur = own(c.get("workspaceId"), c.req.param("id"));
  if (!cur) return c.json({ error: "not_found" }, 404);
  const p = await parse(c, cur);
  if ("error" in p) return c.json(p, 400);
  const v = p.v;
  if (v.auth_type !== cur.auth_type || v.base_url !== cur.base_url) cancelLogin(cur.id);
  db.prepare("UPDATE providers SET name = ?, auth_type = ?, base_url = ?, context_window = ?, encrypted_secret = ?, options = ? WHERE id = ?").run(
    v.name, v.auth_type, v.base_url, v.context_window, v.secret === undefined ? cur.encrypted_secret : v.secret, v.options, cur.id,
  );
  return c.json(view(providerById(cur.id)!));
});

// Tickets/runs/workspace defaults pointing at it fall back (ON DELETE SET NULL).
providerRoutes.delete("/:id", async (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  cancelLogin(p.id);
  if (p.auth_type === "oauth") { const t = oauthRegistration(p); if (t) await revoke(t).catch(() => {}); }
  db.prepare("DELETE FROM providers WHERE id = ?").run(p.id);
  return c.body(null, 204);
});

providerRoutes.get("/:id/models", async (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  try {
    if (p.auth_type === "oauth") {
      const model_details = await planModels(p);
      return c.json({ models: model_details.map((m) => m.id), model_details });
    }
    if (p.kind === "openrouter") {
      const models = await openrouterCatalog(p.encrypted_secret ? decrypt(p.encrypted_secret) : undefined);
      return c.json({ models: models.map((m) => m.id), model_details: models.map(({ id, name }) => ({ id, name })) });
    }
    return c.json({ models: await listModels(p) });
  } catch (e) {
    return c.json({ error: `could not list models: ${scrub((e as Error).message)}` }, 502);
  }
});

// Connection + tool-calling smoke test for one model: a tiny request with one trivial tool.
providerRoutes.post("/:id/test", async (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json().catch(() => null);
  if (p.auth_type === "oauth") {
    const t = oauthRegistration(p);
    if (t?.blocked_code) db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=?").run(encrypt(JSON.stringify({ ...t, blocked_code: undefined })), p.id);
  }
  const model = typeof b?.model === "string" && b.model ? b.model : p.kind === "anthropic" ? DEFAULT_MODEL : (await listModels(p).catch(() => []))[0];
  if (!model) return c.json({ error: "choose a model to test" }, 400);
  const t0 = Date.now();
  try {
    const r = await adapterFor(p).stream(
      {
        system: [{ type: "text", text: "You are a connection test." }], tools: [echo], model, maxTokens: 512, signal: AbortSignal.timeout(120_000),
        messages: [{ role: "user", content: [{ type: "text", text: 'Call the echo tool with text "ping". Do not answer in prose.' }] }],
      },
      () => {},
    );
    const calls = r.message.content.filter((x) => x.type === "tool_use");
    if (calls.some((x) => x.name !== "echo" || x.input.text !== "ping")) throw new Error("model returned an unexpected test tool call");
    if (calls.length) await adapterFor(p).stream({ system: [{ type: "text", text: "You are a connection test." }], tools: [], model, maxTokens: 512, signal: AbortSignal.timeout(120_000),
      messages: [{ role: "user", content: [{ type: "text", text: 'Call the echo tool with text "ping". Do not answer in prose.' }] }, r.message,
        { role: "user", content: calls.map((x) => ({ type: "tool_result", tool_use_id: x.id, content: "ping", ...(x.namespace ? { namespace: x.namespace } : {}) })) }] }, () => {});
    return c.json({ model, ok: true, tool_call: calls.length > 0, latency_ms: Date.now() - t0 });
  } catch (e) {
    return c.json({ model, ok: false, tool_call: false, latency_ms: Date.now() - t0, error: (e as Error).message });
  }
});

// New sign-in attempts never replace the active registration until identity validation completes.
providerRoutes.post("/:id/oauth/start", async (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  if (p.kind !== "openai" || p.auth_type !== "oauth") return c.json({ error: "provider does not use ChatGPT sign-in" }, 400);
  try {
    encrypt("");
    const current = oauthRegistration(p);
    const b = await c.req.json().catch(() => ({}));
    return c.json({ url: await startLogin(p.id, (t) => {
      const latest = providerById(p.id);
      if (!latest || latest.auth_type !== "oauth") throw new Error("provider was removed or changed");
      db.prepare("UPDATE providers SET encrypted_secret=?,base_url=NULL WHERE id=?").run(encrypt(JSON.stringify(t)), p.id);
    }, current, b?.consent === true) });
  } catch (e) { return c.json({ error: (e as Error).message }, e instanceof SecretKeyError ? 400 : 409); }
});
providerRoutes.post("/:id/oauth/cancel", (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  cancelLogin(p.id);
  return c.json({ ok: true });
});
providerRoutes.post("/:id/oauth/logout", async (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  if (p.auth_type !== "oauth") return c.json({ error: "provider does not use ChatGPT sign-in" }, 400);
  cancelLogin(p.id);
  const t = oauthRegistration(p);
  let revoked = true;
  // Clear locally before awaiting revocation so a concurrent refresh cannot resurrect the old session.
  db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=?").run(t ? encrypt(JSON.stringify(withoutTokens(t))) : null, p.id);
  if (t) revoked = await revoke(t).catch(() => false);
  return c.json({ ok: true, revoked, ...(revoked ? {} : { warning: "Signed out locally. Remote revocation was not confirmed; disconnect Polaris in ChatGPT settings." }) });
});
providerRoutes.post("/:id/oauth/acknowledge", (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  if (p.auth_type !== "oauth") return c.json({ error: "provider does not use ChatGPT sign-in" }, 400);
  const t = oauthRegistration(p);
  if (t) db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=?").run(encrypt(JSON.stringify({ ...t, welcomed: true })), p.id);
  return c.json({ ok: true });
});
