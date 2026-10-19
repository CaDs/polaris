import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

export const CLIENT_ID = "dynamic_agent_client";
export const RESOURCE = "https://api.openai.com/v1";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
const authBase = () => (process.env.POLARIS_OPENAI_AUTH_URL ?? "https://auth.openai.com").replace(/\/$/, "");
// Test transport override; production plan credentials never use a provider-supplied base URL.
export const openaiPlanBase = () => (process.env.POLARIS_OPENAI_PLAN_URL ?? RESOURCE).replace(/\/$/, "");
const loginPort = () => Number(process.env.POLARIS_OAUTH_PORT ?? 1455);

export type Tokens = {
  version: 2; client_id: string; host_id: string; issuer?: string; subject?: string; email?: string;
  access?: string; refresh?: string; id_token?: string; expires?: number; scopes: string[]; welcomed?: boolean; blocked_code?: string;
};
export const registration = (text: string | null): Tokens | undefined => {
  if (!text) return;
  const v = JSON.parse(text);
  return v?.version === 2 && typeof v.client_id === "string" && v.client_id !== CLIENT_ID && typeof v.host_id === "string" && Array.isArray(v.scopes) ? v : undefined;
};
export function hostId() {
  const root = resolve(process.env.POLARIS_DATA_DIR ?? "data");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = join(root, "openai-host-id");
  try { writeFileSync(file, `urn:uuid:${randomUUID()}\n`, { flag: "wx", mode: 0o600 }); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const id = readFileSync(file, "utf8").trim();
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(id)) throw new Error("invalid Polaris OpenAI host ID");
  return id;
}
const b64url = (b: Buffer) => b.toString("base64url");
export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}
export function authorizeUrl(o: { state: string; nonce: string; challenge: string; redirectUri: string; host: string; current?: Tokens; consent?: boolean }) {
  const u = new URL(`${authBase()}/api/accounts/authorize`);
  const q: Record<string, string> = {
    response_type: "code", client_id: o.current?.client_id ?? CLIENT_ID, redirect_uri: o.redirectUri, scope: SCOPES, resource: RESOURCE,
    code_challenge: o.challenge, code_challenge_method: "S256", state: o.state, nonce: o.nonce, ext_agent_host_id: o.host,
    ...(!o.current ? { agent_name_hint: "Polaris" } : {}),
    ...(o.current?.id_token ? { id_token_hint: o.current.id_token } : {}),
    ...(o.current?.email ? { login_hint: o.current.email } : {}),
    ...(o.consent ? { prompt: "consent" } : {}),
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}
const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
async function discovery() {
  const base = authBase();
  const res = await fetch(`${base}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`OpenAI discovery failed (HTTP ${res.status})`);
  const d = await res.json() as { issuer: string; jwks_uri: string; revocation_endpoint?: string };
  if (d.issuer !== base || new URL(d.jwks_uri).origin !== new URL(base).origin) throw new Error("invalid OpenAI identity configuration");
  return d;
}
async function identity(token: string, clientId: string, nonce: string | undefined) {
  const d = await discovery();
  let keys = jwks.get(d.jwks_uri);
  if (!keys) jwks.set(d.jwks_uri, (keys = createRemoteJWKSet(new URL(d.jwks_uri))));
  const { payload } = await jwtVerify(token, keys, { issuer: d.issuer, audience: clientId, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
  if (nonce !== undefined && payload.nonce !== nonce) throw new Error("OpenAI ID token nonce did not match");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("OpenAI ID token has no subject");
  return { issuer: d.issuer, subject: payload.sub, ...(typeof payload.email === "string" ? { email: payload.email } : {}) };
}
export class OAuthError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(`${authBase()}/api/accounts/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body), signal: AbortSignal.timeout(30_000) });
  const j = await res.json().catch(() => null) as Record<string, any> | null;
  if (!res.ok || !j?.access_token) throw new OAuthError(typeof j?.error === "string" ? j.error : "token_error", `OpenAI token request failed (HTTP ${res.status}; ${typeof j?.error === "string" ? j.error : "invalid response"})`);
  if (j.token_type?.toLowerCase() !== "bearer" || typeof j.expires_in !== "number" || !Number.isFinite(j.expires_in) || j.expires_in <= 0) throw new Error("invalid OpenAI token response");
  return j;
}
export async function exchangeCode(code: string, verifier: string, redirectUri: string, current: Tokens, nonce: string): Promise<Tokens> {
  const j = await tokenRequest({ grant_type: "authorization_code", client_id: current.client_id, code, redirect_uri: redirectUri, code_verifier: verifier, resource: RESOURCE });
  if (typeof j.id_token !== "string" || typeof j.refresh_token !== "string" || typeof j.scope !== "string") throw new Error("OpenAI token response is missing identity, refresh token or scopes");
  const who = await identity(j.id_token, current.client_id, nonce);
  if (current.subject && (current.subject !== who.subject || current.issuer !== who.issuer)) throw new Error("A different ChatGPT account was selected. Add a separate provider for that account.");
  return { ...current, ...who, access: j.access_token, refresh: j.refresh_token, id_token: j.id_token, expires: Date.now() + j.expires_in * 1000, scopes: j.scope.split(/\s+/).filter(Boolean), blocked_code: undefined };
}
export async function refreshTokens(current: Tokens): Promise<Tokens> {
  if (!current.refresh) throw new OAuthError("invalid_refresh_token", "ChatGPT session needs reconnecting");
  const j = await tokenRequest({ grant_type: "refresh_token", client_id: current.client_id, refresh_token: current.refresh, resource: RESOURCE });
  if (typeof j.refresh_token !== "string") throw new Error("OpenAI did not return a replacement refresh token");
  let who = {};
  if (j.id_token) {
    who = await identity(j.id_token, current.client_id, undefined);
    if ((who as Tokens).subject !== current.subject || (who as Tokens).issuer !== current.issuer) throw new Error("OpenAI refresh returned a different identity");
  }
  return { ...current, ...who, access: j.access_token, refresh: j.refresh_token, id_token: j.id_token ?? current.id_token,
    expires: Date.now() + j.expires_in * 1000, scopes: typeof j.scope === "string" ? j.scope.split(/\s+/).filter(Boolean) : current.scopes };
}
export const withoutTokens = (t: Tokens): Tokens => ({ version: 2, client_id: t.client_id, host_id: t.host_id, issuer: t.issuer, subject: t.subject, email: t.email, scopes: [], welcomed: t.welcomed });
export async function revoke(t: Tokens) {
  if (!t.refresh) return true;
  const d = await discovery();
  if (!d.revocation_endpoint || new URL(d.revocation_endpoint).origin !== new URL(authBase()).origin) throw new Error("OpenAI revocation endpoint is unavailable");
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(d.revocation_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: t.refresh, token_type_hint: "refresh_token", client_id: t.client_id }), signal: AbortSignal.timeout(10_000) });
      if (res.ok) return true;
      if (res.status < 500 || attempt === 2) throw new Error(`OpenAI revocation failed (HTTP ${res.status})`);
    } catch (e) { if (attempt === 2) throw e; }
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
}

export const logins = new Map<string, { status: "pending" | "error"; error?: string }>();
type Attempt = { providerId: string; verifier: string; nonce: string; redirectUri: string; current: Tokens | undefined; save: (t: Tokens) => void; timer: NodeJS.Timeout; claimed: boolean; cancelled: boolean };
const pending = new Map<string, Attempt>();
const generations = new Map<string, number>();
export let listener: Server | undefined;
let starting: Promise<void> | undefined;
const page = (msg: string) => `<!doctype html><meta charset=utf-8><title>Polaris</title><body style="font:16px system-ui;margin:3rem">${msg.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`;
function stop(state: string) {
  const p = pending.get(state);
  if (p) { clearTimeout(p.timer); p.cancelled = true; pending.delete(state); }
  if (!pending.size) { const srv = listener; listener = undefined; srv?.close(); }
}
export function cancelLogin(providerId: string) {
  generations.set(providerId, (generations.get(providerId) ?? 0) + 1);
  for (const [state, p] of pending) if (p.providerId === providerId) stop(state);
  logins.delete(providerId);
}
async function listen() {
  if (listener) return;
  if (starting) return starting;
  starting = (async () => {
    const srv = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      const state = u.searchParams.get("state") ?? "";
      const p = req.method === "GET" && u.pathname === "/auth/callback" ? pending.get(state) : undefined;
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("referrer-policy", "no-referrer");
      if (!p || p.claimed || p.cancelled) return void res.writeHead(400).end(page("Unknown or expired login. Start again from Polaris Settings."));
      p.claimed = true;
      try {
        if (u.searchParams.has("error")) throw new Error(u.searchParams.get("error") === "access_denied" ? "ChatGPT sign-in was declined" : "ChatGPT sign-in failed");
        const code = u.searchParams.get("code");
        if (!code) throw new Error("No authorization code returned");
        const issued = u.searchParams.get("client_id");
        if (p.current && issued && issued !== p.current.client_id) throw new Error("OpenAI returned a different client registration");
        const client = p.current?.client_id ?? issued;
        if (!client || client === CLIENT_ID) throw new Error("OpenAI registration did not return an issued client ID");
        const current = p.current ?? { version: 2 as const, client_id: client, host_id: hostId(), scopes: [] };
        if (!p.current) p.save(current); // retain the registration even if the one-time code exchange fails
        const tokens = await exchangeCode(code, p.verifier, p.redirectUri, current, p.nonce);
        if (p.cancelled) throw new Error("Sign-in was cancelled");
        p.save(tokens);
        logins.delete(p.providerId);
        res.writeHead(200).end(page(tokens.scopes.includes(PLAN_SCOPE) ? "Signed in. Return to Polaris." : "Signed in, but ChatGPT plan usage was not enabled. Return to Polaris Settings."));
      } catch (e) {
        if (!p.cancelled) logins.set(p.providerId, { status: "error", error: (e as Error).message });
        res.writeHead(400).end(page(`Sign-in failed: ${(e as Error).message}`));
      } finally { stop(state); }
    });
    const bind = (port: number) => new Promise<void>((ok, fail) => {
      const error = (e: Error) => { srv.removeListener("listening", ready); fail(e); };
      const ready = () => { srv.removeListener("error", error); ok(); };
      srv.once("error", error).once("listening", ready).listen(port, "127.0.0.1");
    });
    try { await bind(loginPort()); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e; await bind(0); }
    listener = srv;
  })();
  try { await starting; } finally { starting = undefined; }
}
export async function startLogin(providerId: string, save: (t: Tokens) => void, current?: Tokens, consent = false) {
  const host = hostId();
  if (current && current.host_id !== host) throw new Error("This ChatGPT registration belongs to another Polaris installation");
  cancelLogin(providerId);
  const generation = generations.get(providerId);
  await listen();
  if (generation !== generations.get(providerId)) {
    if (!pending.size) { const srv = listener; listener = undefined; srv?.close(); }
    throw new Error("Sign-in was superseded or cancelled");
  }
  const redirectUri = `http://127.0.0.1:${(listener!.address() as AddressInfo).port}/auth/callback`;
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const timer = setTimeout(() => { logins.set(providerId, { status: "error", error: "login timed out" }); stop(state); }, 5 * 60_000).unref();
  pending.set(state, { providerId, verifier, nonce, redirectUri, current, save, timer, claimed: false, cancelled: false });
  logins.set(providerId, { status: "pending" });
  return authorizeUrl({ state, nonce, challenge, redirectUri, host, current, consent });
}
