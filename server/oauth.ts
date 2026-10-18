import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// ChatGPT-subscription login for OpenAI providers. UNOFFICIAL and experimental: it reuses the public client id and
// PKCE flow of OpenAI's open-source Codex CLI (github.com/openai/codex, codex-rs/login) and talks to the ChatGPT Codex
// backend the same way (see also github.com/numman-ali/opencode-openai-codex-auth). It can break any time.
// All URLs are read at call time so tests can point them at local mock servers.
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const authBase = () => (process.env.POLARIS_OPENAI_AUTH_URL ?? "https://auth.openai.com").replace(/\/$/, "");
export const chatgptBase = () => (process.env.POLARIS_CHATGPT_BASE_URL ?? "https://chatgpt.com/backend-api").replace(/\/$/, "");
const loginPort = () => Number(process.env.POLARIS_OAUTH_PORT ?? 1455);

export type Tokens = { access: string; refresh: string; expires: number; account_id: string };

const b64url = (b: Buffer) => b.toString("base64url");
export function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export function authorizeUrl(o: { state: string; challenge: string; redirectUri: string }) {
  const u = new URL(`${authBase()}/oauth/authorize`);
  const q = {
    response_type: "code", client_id: CLIENT_ID, redirect_uri: o.redirectUri, scope: "openid profile email offline_access",
    code_challenge: o.challenge, code_challenge_method: "S256", state: o.state,
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "codex_cli_rs",
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
}

const claims = (jwt: string): Record<string, any> => {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
  } catch {
    return {};
  }
};
// Unverified decode: the token came straight from the token endpoint over TLS; we only read claims.
export const accountId = (idToken: string): string | undefined => claims(idToken)["https://api.openai.com/auth"]?.chatgpt_account_id;

async function tokenRequest(body: Record<string, string>, fallbackRefresh?: string): Promise<Tokens> {
  const res = await fetch(`${authBase()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const j = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok || !j?.access_token) throw new Error(`token request failed: HTTP ${res.status} ${JSON.stringify(j?.error_description ?? j?.error ?? "").slice(0, 200)}`);
  const refresh = j.refresh_token ?? fallbackRefresh;
  const id = accountId(j.id_token ?? j.access_token) ?? accountId(j.access_token);
  if (!refresh || !id) throw new Error("token response is missing the refresh token or the ChatGPT account id");
  const exp = typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : (claims(j.access_token).exp ?? 0) * 1000 || Date.now() + 3600_000;
  return { access: j.access_token, refresh, expires: exp, account_id: id };
}

export const exchangeCode = (code: string, verifier: string, redirectUri: string) =>
  tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
export const refreshTokens = (refresh: string) => tokenRequest({ grant_type: "refresh_token", refresh_token: refresh, scope: "openid profile email" }, refresh);

// Login state per provider id, polled by the UI through GET /api/providers.
export const logins = new Map<string, { status: "pending" | "error"; error?: string }>();
const pending = new Map<string, { providerId: string; verifier: string; redirectUri: string; save: (t: Tokens) => void; timer: NodeJS.Timeout }>();
export let listener: Server | undefined;

const page = (msg: string) => `<!doctype html><meta charset=utf-8><title>Polaris</title><body style="font:16px system-ui;margin:3rem">${msg}`;

function stop(state: string) {
  clearTimeout(pending.get(state)?.timer);
  pending.delete(state);
  if (!pending.size) (listener?.close(), (listener = undefined)); // the port is only held while a login is open
}

// Starts the temporary callback listener (port 1455) and returns the URL to open in a browser.
// `save` persists the tokens; it runs once, when the browser comes back with a valid state.
export async function startLogin(providerId: string, save: (t: Tokens) => void) {
  if (!listener) {
    const srv = createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://localhost");
      const p = u.pathname === "/auth/callback" ? pending.get(u.searchParams.get("state") ?? "") : undefined;
      res.setHeader("content-type", "text/html");
      if (!p) return void res.writeHead(400).end(page("Unknown or expired login. Start again from the harness Settings."));
      const state = u.searchParams.get("state")!;
      try {
        const code = u.searchParams.get("code");
        if (!code) throw new Error(u.searchParams.get("error_description") ?? "no authorization code returned");
        p.save(await exchangeCode(code, p.verifier, p.redirectUri));
        logins.delete(p.providerId);
        res.writeHead(200).end(page("Signed in. You can close this tab and return to the harness."));
      } catch (e) {
        logins.set(p.providerId, { status: "error", error: (e as Error).message });
        res.writeHead(400).end(page(`Sign-in failed: ${(e as Error).message.replace(/</g, "&lt;")}`));
      }
      stop(state);
    });
    await new Promise<void>((ok, fail) => srv.once("error", fail).listen(loginPort(), "127.0.0.1", ok)).catch((e) => {
      throw new Error(e.code === "EADDRINUSE" ? `port ${loginPort()} is busy (another Codex login running?); close it and retry` : e.message);
    });
    listener = srv;
  }
  const redirectUri = `http://localhost:${(listener.address() as AddressInfo).port}/auth/callback`;
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const timer = setTimeout(() => (logins.set(providerId, { status: "error", error: "login timed out" }), stop(state)), 5 * 60_000).unref();
  pending.set(state, { providerId, verifier, redirectUri, save, timer });
  logins.set(providerId, { status: "pending" });
  return authorizeUrl({ state, challenge, redirectUri });
}
