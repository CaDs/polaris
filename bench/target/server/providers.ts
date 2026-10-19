import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { db } from "./db.ts";
import { anthropic, DEFAULT_MODEL } from "./agent/providers/anthropic.ts";
import { openai } from "./agent/providers/openai.ts";
import { chatgptBase, logins, refreshTokens, startLogin, type Tokens } from "./oauth.ts";
import { decrypt, encrypt, SecretKeyError } from "./secrets.ts";
import { AgentError, type Provider } from "./agent/types.ts";

export type ProviderRow = {
  id: string; workspace_id: string; name: string; kind: "anthropic" | "openai" | "ollama"; auth_type: "api_key" | "oauth" | "none";
  encrypted_secret: string | null; base_url: string | null; context_window: number; created_at: number;
};

// Default context window (tokens) by kind; editable per provider.
export const CONTEXT_WINDOW: Record<ProviderRow["kind"], number> = { anthropic: 1_000_000, openai: 400_000, ollama: 32_768 };

const AUTH: Record<ProviderRow["kind"], ProviderRow["auth_type"][]> = { anthropic: ["api_key"], openai: ["api_key", "oauth"], ollama: ["none"] };
const OLLAMA_URL = "http://localhost:11434";
const ANTHROPIC_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const OPENAI_MODELS = ["gpt-5-codex", "gpt-5", "gpt-5-mini", "gpt-4.1"]; // fallback when GET /v1/models is unavailable
const openaiBase = (p: ProviderRow) => (p.base_url || process.env.OPENAI_BASE_URL || "https://api.openai.com").replace(/\/$/, "");

export const providerById = (id: string) => db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as ProviderRow | undefined;

// The secret is never returned: only whether one is stored and, for API keys, its last 4 chars.
function view(p: ProviderRow) {
  let last4: string | null = null;
  if (p.encrypted_secret && p.auth_type === "api_key")
    try {
      last4 = decrypt(p.encrypted_secret).slice(-4);
    } catch {} // key rotated or missing: still has_secret, just unmasked
  const login = logins.get(p.id);
  return {
    id: p.id, name: p.name, kind: p.kind, auth_type: p.auth_type, base_url: p.base_url, context_window: p.context_window, created_at: p.created_at,
    has_secret: !!p.encrypted_secret, secret_last4: last4, login: login?.status ?? null, login_error: login?.error ?? null,
  };
}

// ChatGPT OAuth tokens live encrypted in the secret column; refreshed a minute before expiry. Concurrent runs share one refresh
// (refresh tokens rotate, so two parallel refreshes would invalidate each other).
const refreshing = new Map<string, Promise<Tokens>>();
async function freshTokens(p: ProviderRow): Promise<Tokens> {
  if (!p.encrypted_secret) throw new AgentError("ProviderError", `provider "${p.name}" is not signed in`);
  const cur = JSON.parse(decrypt(p.encrypted_secret)) as Tokens;
  if (cur.expires - Date.now() > 60_000) return cur;
  let job = refreshing.get(p.id);
  if (!job) {
    job = refreshTokens(cur.refresh).then((t) => {
      db.prepare("UPDATE providers SET encrypted_secret = ? WHERE id = ?").run(encrypt(JSON.stringify(t)), p.id);
      return t;
    });
    refreshing.set(p.id, job);
    job.then(() => refreshing.delete(p.id), () => refreshing.delete(p.id));
  }
  return job.catch((e) => {
    throw new AgentError("ProviderError", `ChatGPT token refresh failed (sign in again in Settings): ${e.message}`);
  });
}

// Adapter for a stored provider. Throws AgentError("ProviderError") when it is unusable (no secret, no key configured).
export function adapterFor(p: ProviderRow): Provider {
  try {
    const secret = p.auth_type === "api_key" ? (p.encrypted_secret ? decrypt(p.encrypted_secret) : "") : "";
    if (p.auth_type === "api_key" && !secret) throw new Error(`provider "${p.name}" has no API key`);
    if (p.kind === "ollama") return anthropic({ apiKey: "ollama", baseUrl: p.base_url || OLLAMA_URL });
    if (p.kind === "anthropic") return anthropic({ apiKey: secret, baseUrl: p.base_url || undefined });
    if (p.auth_type === "api_key") return openai({ url: `${openaiBase(p)}/v1/responses`, headers: async () => ({ authorization: `Bearer ${secret}` }) });
    return openai({
      url: `${p.base_url?.replace(/\/$/, "") || chatgptBase()}/codex/responses`,
      codex: true,
      headers: async () => {
        const t = await freshTokens(p);
        return {
          authorization: `Bearer ${t.access}`, "chatgpt-account-id": t.account_id, "OpenAI-Beta": "responses=experimental",
          originator: "codex_cli_rs", accept: "text/event-stream",
        };
      },
    });
  } catch (e) {
    throw new AgentError("ProviderError", (e as Error).message);
  }
}

async function listModels(p: ProviderRow): Promise<string[]> {
  if (p.kind === "anthropic") return ANTHROPIC_MODELS;
  if (p.kind === "ollama") {
    const res = await fetch(`${(p.base_url || OLLAMA_URL).replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Ollama answered HTTP ${res.status}`);
    return ((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name);
  }
  if (p.auth_type === "oauth" || !p.encrypted_secret) return OPENAI_MODELS;
  try {
    const res = await fetch(`${openaiBase(p)}/v1/models`, { headers: { authorization: `Bearer ${decrypt(p.encrypted_secret)}` }, signal: AbortSignal.timeout(10_000) });
    const ids = ((await res.json()) as { data: { id: string }[] }).data.map((m) => m.id);
    const chat = ids.filter((id) => /^(gpt-|o\d|codex-)/.test(id) && !/embed|whisper|tts|image|audio|realtime|transcribe|moderation|search|instruct/.test(id)).sort();
    return chat.length ? chat : OPENAI_MODELS;
  } catch {
    return OPENAI_MODELS;
  }
}

const echo = { name: "echo", description: "Echo a string back.", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

type Env = { Variables: { workspaceId: string } };
export const providerRoutes = new Hono<Env>();

const own = (workspaceId: string, id: string) => db.prepare("SELECT * FROM providers WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as ProviderRow | undefined;

providerRoutes.get("/", (c) =>
  c.json((db.prepare("SELECT * FROM providers WHERE workspace_id = ? ORDER BY created_at, rowid").all(c.get("workspaceId")) as ProviderRow[]).map(view)),
);

// Validated create/patch body. Secrets only with a configured HARNESS_SECRET_KEY.
async function parse(c: { req: { json: () => Promise<any> } }, cur?: ProviderRow) {
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "body must be a JSON object" };
  const name = b.name !== undefined ? b.name : cur?.name;
  const kind = cur?.kind ?? b.kind;
  const auth_type = b.auth_type ?? cur?.auth_type ?? AUTH[kind as ProviderRow["kind"]]?.[0];
  const base_url = b.base_url !== undefined ? b.base_url : cur?.base_url;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) return { error: "name is required (1-100 chars)" };
  if (!(kind in AUTH)) return { error: "kind must be anthropic, openai or ollama" };
  if (cur && b.kind !== undefined && b.kind !== cur.kind) return { error: "kind cannot be changed" };
  if (!AUTH[kind as ProviderRow["kind"]].includes(auth_type)) return { error: `${kind} supports auth type ${AUTH[kind as ProviderRow["kind"]].join(" or ")}` };
  if (base_url) {
    try {
      if (typeof base_url !== "string" || !/^https?:$/.test(new URL(base_url).protocol)) throw 0;
    } catch {
      return { error: "base URL must be an http(s) URL" };
    }
  }
  const context_window = b.context_window ?? cur?.context_window ?? CONTEXT_WINDOW[kind as ProviderRow["kind"]];
  if (!Number.isInteger(context_window) || context_window < 1000 || context_window > 100_000_000) return { error: "context window must be a whole number of tokens (1000 to 100000000)" };
  let secret: string | null | undefined; // undefined = keep
  if (b.api_key !== undefined && b.api_key !== "") {
    if (typeof b.api_key !== "string" || b.api_key.length > 500) return { error: "api_key must be a string" };
    if (auth_type !== "api_key") return { error: "this auth type has no API key" };
    try {
      secret = encrypt(b.api_key.trim());
    } catch (e) {
      if (e instanceof SecretKeyError) return { error: e.message };
      throw e;
    }
  } else if (cur && auth_type !== cur.auth_type) secret = null; // switching auth type drops the old credential
  return { v: { name: name.trim(), kind, auth_type, base_url: base_url || null, context_window: context_window as number, secret } };
}

providerRoutes.post("/", async (c) => {
  const p = await parse(c);
  if ("error" in p) return c.json(p, 400);
  const id = randomUUID();
  const v = p.v;
  db.prepare("INSERT INTO providers (id, workspace_id, name, kind, auth_type, encrypted_secret, base_url, context_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, c.get("workspaceId"), v.name, v.kind, v.auth_type, v.secret ?? null, v.base_url, v.context_window,
  );
  return c.json(view(providerById(id)!), 201);
});

providerRoutes.patch("/:id", async (c) => {
  const cur = own(c.get("workspaceId"), c.req.param("id"));
  if (!cur) return c.json({ error: "not_found" }, 404);
  const p = await parse(c, cur);
  if ("error" in p) return c.json(p, 400);
  const v = p.v;
  db.prepare("UPDATE providers SET name = ?, auth_type = ?, base_url = ?, context_window = ?, encrypted_secret = ? WHERE id = ?").run(
    v.name, v.auth_type, v.base_url, v.context_window, v.secret === undefined ? cur.encrypted_secret : v.secret, cur.id,
  );
  return c.json(view(providerById(cur.id)!));
});

// Tickets/runs/workspace defaults pointing at it fall back (ON DELETE SET NULL).
providerRoutes.delete("/:id", (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  db.prepare("DELETE FROM providers WHERE id = ?").run(p.id);
  return c.body(null, 204);
});

providerRoutes.get("/:id/models", async (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  try {
    return c.json({ models: await listModels(p) });
  } catch (e) {
    return c.json({ error: `could not list models: ${(e as Error).message}` }, 502);
  }
});

// Connection + tool-calling smoke test for one model: a tiny request with one trivial tool.
providerRoutes.post("/:id/test", async (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json().catch(() => null);
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
    return c.json({ model, ok: true, tool_call: r.message.content.some((x) => x.type === "tool_use"), latency_ms: Date.now() - t0 });
  } catch (e) {
    return c.json({ model, ok: false, tool_call: false, latency_ms: Date.now() - t0, error: (e as Error).message });
  }
});

// ChatGPT OAuth: returns the authorize URL; the UI opens it in a new tab and polls GET / until has_secret.
providerRoutes.post("/:id/oauth/start", async (c) => {
  const p = own(c.get("workspaceId"), c.req.param("id"));
  if (!p) return c.json({ error: "not_found" }, 404);
  if (p.kind !== "openai" || p.auth_type !== "oauth") return c.json({ error: "provider does not use ChatGPT sign-in" }, 400);
  try {
    encrypt(""); // fail early when there is no secret key
    return c.json({ url: await startLogin(p.id, (t) => db.prepare("UPDATE providers SET encrypted_secret = ? WHERE id = ?").run(encrypt(JSON.stringify(t)), p.id)) });
  } catch (e) {
    return c.json({ error: (e as Error).message }, e instanceof SecretKeyError ? 400 : 409);
  }
});
