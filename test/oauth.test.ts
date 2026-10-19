import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";

// ChatGPT OAuth against local mock servers only: nothing here talks to OpenAI.
const { call, db, listen, user } = await import("./helpers.ts");
const jwt = (claims: object) => ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "unsigned"].join(".");
const idToken = (account: string) => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: account } });

const authReqs: URLSearchParams[] = [];
const backendReqs: { url?: string; headers: Record<string, any>; body: any }[] = [];
let issued = 0;
const readBody = async (req: AsyncIterable<Buffer>) => {
  let b = "";
  for await (const c of req) b += c;
  return b;
};

const auth = await listen(async (req, res) => {
  const form = new URLSearchParams(await readBody(req));
  authReqs.push(form);
  if (req.url !== "/oauth/token") return void res.writeHead(404).end();
  if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") !== "refresh-0") return void res.writeHead(400).end('{"error":"invalid_grant"}');
  issued++;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id_token: idToken("acct-42"), access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 }));
});
const backend = await listen(async (req, res) => {
  backendReqs.push({ url: req.url, headers: req.headers, body: JSON.parse(await readBody(req)) });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] } })}\n\n`);
});

process.env.POLARIS_OPENAI_AUTH_URL = auth.url;
process.env.POLARIS_CHATGPT_BASE_URL = backend.url;
process.env.POLARIS_OAUTH_PORT = "0"; // any free port instead of 1455
const oauth = await import("../server/oauth.ts");
const { decrypt, encrypt } = await import("../server/secrets.ts");

test("PKCE challenge is the S256 of the verifier; authorize URL carries the Codex parameters", () => {
  const { verifier, challenge } = oauth.pkce();
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  const u = new URL(oauth.authorizeUrl({ state: "st", challenge, redirectUri: "http://localhost:1455/auth/callback" }));
  assert.equal(u.origin + u.pathname, `${auth.url}/oauth/authorize`);
  const q = Object.fromEntries(u.searchParams);
  assert.deepEqual([q.client_id, q.response_type, q.code_challenge_method, q.code_challenge, q.state], [oauth.CLIENT_ID, "code", "S256", challenge, "st"]);
  assert.equal(q.redirect_uri, "http://localhost:1455/auth/callback");
  assert.match(q.scope, /offline_access/);
});

test("account id comes from the id_token claims; token exchange and refresh hit the token endpoint", async () => {
  assert.equal(oauth.accountId(idToken("acct-7")), "acct-7");
  assert.equal(oauth.accountId("garbage"), undefined);
  authReqs.length = 0;
  const t = await oauth.exchangeCode("the-code", "the-verifier", "http://localhost:1455/auth/callback");
  assert.deepEqual([t.account_id, t.access, t.refresh], ["acct-42", "access-1", "refresh-1"]);
  assert.ok(t.expires > Date.now() + 3_000_000);
  assert.deepEqual(Object.fromEntries(authReqs[0]), {
    client_id: oauth.CLIENT_ID, grant_type: "authorization_code", code: "the-code", redirect_uri: "http://localhost:1455/auth/callback", code_verifier: "the-verifier",
  });
  const r = await oauth.refreshTokens("refresh-0");
  assert.equal(r.access, "access-2");
  assert.equal(authReqs[1].get("grant_type"), "refresh_token");
  await assert.rejects(oauth.refreshTokens("revoked"), /invalid_grant/);
});

test("browser login via the temporary listener, then Codex backend requests with refresh", async () => {
  const cookie = await user("oa");
  assert.equal((await call("POST", "/api/providers", cookie, { name: "bad", kind: "openai", auth_type: "oauth", api_key: "k" })).status, 400);
  const p = (await call("POST", "/api/providers", cookie, { name: "ChatGPT", kind: "openai", auth_type: "oauth" })).body;
  assert.equal(p.has_secret, false);

  authReqs.length = 0;
  const { url } = (await call("POST", `/api/providers/${p.id}/oauth/start`, cookie)).body;
  const authz = new URL(url);
  assert.equal((oauth.listener!.address() as AddressInfo).address, "127.0.0.1", "callback listener is loopback-only");
  assert.equal((await call("GET", "/api/providers", cookie)).body[0].login, "pending");
  const redirect = authz.searchParams.get("redirect_uri")!;
  // A wrong state is refused and signs nobody in.
  assert.equal((await fetch(`${redirect}?code=x&state=wrong`)).status, 400);
  const back = await fetch(`${redirect}?code=abc&state=${authz.searchParams.get("state")}`);
  assert.equal(back.status, 200);
  assert.match(await back.text(), /Signed in/);
  // The code was exchanged with the verifier matching the challenge from the authorize URL.
  const ex = authReqs[0];
  assert.equal(ex.get("code"), "abc");
  assert.equal(createHash("sha256").update(ex.get("code_verifier")!).digest("base64url"), authz.searchParams.get("code_challenge"));
  const listed = (await call("GET", "/api/providers", cookie)).body[0];
  assert.deepEqual([listed.has_secret, listed.login, listed.secret_last4], [true, null, null]);
  await assert.rejects(fetch(redirect), "listener closes after login"); // port is released

  const { adapterFor, providerById } = await import("../server/providers.ts");
  const stream = () => adapterFor(providerById(p.id)!).stream(
    { system: [{ type: "text", text: "sys" }], tools: [], model: "gpt-5-codex", maxTokens: 99, messages: [{ role: "user", content: [{ type: "text", text: "go" }] }] }, () => {},
  );
  const r = await stream();
  assert.deepEqual(r.message.content, [{ type: "text", text: "hi" }]);
  const first = backendReqs[0];
  assert.equal(first.url, "/codex/responses");
  assert.equal(first.headers.authorization, "Bearer access-3");
  assert.equal(first.headers["chatgpt-account-id"], "acct-42");
  assert.equal(first.headers["openai-beta"], "responses=experimental");
  assert.equal(first.headers.originator, "codex_cli_rs");
  assert.equal(first.body.store, false);
  assert.equal(first.body.stream, true);
  assert.equal(first.body.instructions, "sys");
  assert.equal(first.body.max_output_tokens, undefined);

  // Expired access token: refreshed before the request and the new tokens are stored encrypted.
  const stored = JSON.parse(decrypt((db.prepare("SELECT encrypted_secret FROM providers WHERE id = ?").get(p.id) as any).encrypted_secret));
  db.prepare("UPDATE providers SET encrypted_secret = ? WHERE id = ?").run(encrypt(JSON.stringify({ ...stored, refresh: "refresh-0", expires: Date.now() - 1 })), p.id);
  const before = issued;
  await Promise.all([stream(), stream()]); // concurrent runs share one refresh
  assert.equal(issued, before + 1);
  assert.equal(backendReqs.at(-1)!.headers.authorization, `Bearer access-${issued}`);
  assert.equal(JSON.parse(decrypt((db.prepare("SELECT encrypted_secret FROM providers WHERE id = ?").get(p.id) as any).encrypted_secret)).access, `access-${issued}`);
});

test.after(() => (auth.srv.close(), backend.srv.close()));
