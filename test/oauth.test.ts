import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
process.env.POLARIS_OAUTH_PORT = "0";
const { call, db, listen, user, until } = await import("./helpers.ts");
const { decrypt, encrypt } = await import("../server/secrets.ts");
const oauth = await import("../server/oauth.ts");
const { adapterFor, providerById, freshTokens } = await import("../server/providers.ts");
const keys = await generateKeyPair("RS256");
const wrong = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig" };
let nonce = "";
let mode = "ok";
let issued = 0;
let refreshes = 0;
let revoked = 0;
let refreshGate: Promise<void> | undefined;
const authReqs: URLSearchParams[] = [];
let trapHits = 0;
const trap = await listen((_req, res) => (trapHits++, void res.end("trap")));
const auth = await listen(async (req, res) => {
  if (req.url === "/.well-known/openid-configuration") return void res.end(JSON.stringify({ issuer: auth.url, jwks_uri: `${auth.url}/jwks`, revocation_endpoint: `${auth.url}/revoke` }));
  if (req.url === "/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
  let raw = "";
  for await (const c of req) raw += c;
  const b = new URLSearchParams(raw);
  if (req.url === "/revoke") { revoked++; return void res.end(); }
  if (req.url !== "/api/accounts/oauth/token") return void res.writeHead(404).end();
  authReqs.push(b);
  if (mode === "redirect") return void res.writeHead(307, { location: `${trap.url}/steal` }).end();
  if (mode === "bad_shape") return void res.end(JSON.stringify({ access_token: { a: 1 }, token_type: "Bearer", expires_in: 3600 }));
  if (b.get("grant_type") === "refresh_token") { refreshes++; await refreshGate; }
  if (mode === "invalid_grant") return void res.writeHead(400).end(JSON.stringify({ error: "invalid_grant" }));
  const id_token = await new SignJWT({ nonce: mode === "bad_nonce" ? "wrong" : nonce, email: "me@example.com" })
    .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(auth.url).setAudience(mode === "bad_audience" ? "wrong" : "oaiapp_polaris_test")
    .setSubject(mode === "bad_subject" ? "another-person" : "person-1").setIssuedAt().setExpirationTime(mode === "expired" ? "-1h" : "1h")
    .sign(mode === "bad_signature" ? wrong.privateKey : keys.privateKey);
  res.end(JSON.stringify({ access_token: `access-${++issued}`, refresh_token: `refresh-${issued}`, id_token, token_type: "Bearer", expires_in: 3600,
    scope: mode === "no_plan" ? "openid profile email offline_access" : `openid profile email offline_access resource.invoke ${oauth.PLAN_SCOPE}` }));
});
process.env.POLARIS_OPENAI_AUTH_URL = auth.url;
const inference: { url: string; headers: Record<string, any>; body: any }[] = [];
const apiServer = await listen(async (req, res) => {
  if (req.url === "/v1/models") return void res.end(JSON.stringify({ models: [{ slug: "gpt-test", display_name: "GPT test", visibility: "list" }, { slug: "hidden", visibility: "hide" }] }));
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw);
  inference.push({ url: req.url!, headers: req.headers, body });
  if (mode === "quota") return void res.writeHead(429).end(JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "Plan limit" } }));
  const tool = body.tools?.[0]?.tools?.[0];
  const output = tool ? [{ type: "function_call", call_id: "call-1", namespace: "polaris", name: tool.name, arguments: '{"text":"ping"}' }] : [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] }];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ type: "response.completed", response: { output, usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 2 } } } })}\n\n`);
});
process.env.POLARIS_OPENAI_PLAN_URL = `${apiServer.url}/v1`;
const cookie = await user("subscription");
const other = await user("other");
async function make() { return (await call("POST", "/api/providers", cookie, { name: "My ChatGPT", kind: "openai", auth_type: "oauth" })).body; }
async function start(id: string, consent = false) {
  const r = await call("POST", `/api/providers/${id}/oauth/start`, cookie, { consent });
  assert.equal(r.status, 200, r.text);
  const url = new URL(r.body.url);
  nonce = url.searchParams.get("nonce")!;
  return { url, callback: `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=code-1&client_id=oaiapp_polaris_test` };
}
const tokens = (id: string) => JSON.parse(decrypt((db.prepare("SELECT encrypted_secret FROM providers WHERE id=?").get(id) as any).encrypted_secret, `providers:${id}`)) as import("../server/oauth.ts").Tokens;

test("dynamic registration: own client, stable host, exact loopback URI, nonce, scopes and PKCE", async () => {
  const p = await make();
  const { url, callback } = await start(p.id);
  assert.equal(url.pathname, "/api/accounts/authorize");
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "Polaris");
  assert.equal(url.searchParams.get("resource"), oauth.RESOURCE);
  assert.ok(url.searchParams.get("scope")!.includes(oauth.PLAN_SCOPE));
  assert.equal(new URL(url.searchParams.get("redirect_uri")!).hostname, "127.0.0.1");
  assert.equal((oauth.listener!.address() as AddressInfo).address, "127.0.0.1");
  assert.equal((await fetch(callback.replace(url.searchParams.get("state")!, "wrong"))).status, 400);
  assert.equal((await fetch(callback)).status, 200);
  const ex = authReqs.at(-1)!;
  assert.equal(ex.get("client_id"), "oaiapp_polaris_test");
  assert.equal(ex.get("redirect_uri"), url.searchParams.get("redirect_uri"));
  assert.equal(createHash("sha256").update(ex.get("code_verifier")!).digest("base64url"), url.searchParams.get("code_challenge"));
  assert.equal(tokens(p.id).subject, "person-1");
  const list = await call("GET", "/api/providers", cookie);
  assert.ok(!list.text.includes("access_token") && !list.text.includes("access-"));
  assert.equal(list.body.find((x: any) => x.id === p.id).account.status, "connected");
  const next = await start(p.id);
  assert.equal(next.url.searchParams.get("client_id"), "oaiapp_polaris_test");
  assert.equal(next.url.searchParams.get("agent_name_hint"), null);
  assert.equal(next.url.searchParams.get("ext_agent_host_id"), url.searchParams.get("ext_agent_host_id"));
  await call("POST", `/api/providers/${p.id}/oauth/cancel`, cookie);
  await assert.rejects(fetch(next.callback));
});

test("signature, nonce, audience and expiry are verified; a returning account cannot be replaced", async () => {
  for (const bad of ["bad_nonce", "bad_audience", "expired", "bad_signature"]) {
    const p = await make();
    const a = await start(p.id);
    mode = bad;
    assert.equal((await fetch(a.callback)).status, 400, bad);
    assert.equal(tokens(p.id).access, undefined);
  }
  mode = "ok";
  const p = await make();
  assert.equal((await fetch((await start(p.id)).callback)).status, 200);
  const original = tokens(p.id).access;
  const a = await start(p.id);
  mode = "bad_subject";
  assert.equal((await fetch(a.callback)).status, 400);
  assert.equal(tokens(p.id).access, original);
  mode = "ok";
});

test("plan permission, public catalog and namespaced tool/result round trip; tokens remain private", async () => {
  const p = await make();
  const a = await start(p.id);
  mode = "no_plan";
  assert.equal((await fetch(a.callback)).status, 200);
  assert.equal((await call("GET", `/api/providers/${p.id}/models`, cookie)).status, 502);
  mode = "ok";
  const again = await start(p.id, true);
  assert.equal(again.url.searchParams.get("prompt"), "consent");
  assert.equal((await fetch(again.callback)).status, 200);
  const models = (await call("GET", `/api/providers/${p.id}/models`, cookie)).body;
  assert.deepEqual(models, { models: ["gpt-test"], model_details: [{ id: "gpt-test", name: "GPT test" }] });
  const tested = await call("POST", `/api/providers/${p.id}/test`, cookie, { model: "gpt-test" });
  assert.equal(tested.body.ok, true, tested.text);
  assert.equal(tested.body.tool_call, true);
  const r = inference.at(-2)!;
  assert.equal(r.url, "/v1/responses");
  assert.equal(r.headers["chatgpt-account-id"], undefined);
  assert.equal(r.headers.originator, undefined);
  assert.equal(r.body.max_output_tokens, undefined);
  assert.equal(r.body.tools[0].type, "namespace");
  assert.ok(inference.at(-1)!.body.input.some((i: any) => i.type === "function_call_output" && i.namespace === "polaris"));
  const usage = (await call("GET", "/api/usage", cookie)).body;
  assert.ok(usage.models.some((m: any) => m.provider_id === p.id && m.billing_mode === "subscription" && m.tokens_total === 30));
});

test("concurrent refresh rotates once; logout retains registration and prevents use; foreign workspaces are refused", async () => {
  const p = await make();
  await fetch((await start(p.id)).callback);
  db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=?").run(encrypt(JSON.stringify({ ...tokens(p.id), expires: 0 }), `providers:${p.id}`), p.id);
  const before = refreshes;
  await Promise.all([freshTokens(providerById(p.id)!), freshTokens(providerById(p.id)!)]);
  assert.equal(refreshes, before + 1);
  assert.equal(authReqs.at(-1)!.get("scope"), null);
  assert.equal(authReqs.at(-1)!.get("resource"), oauth.RESOURCE);
  for (const route of ["start", "cancel", "logout", "acknowledge"]) assert.equal((await call("POST", `/api/providers/${p.id}/oauth/${route}`, other)).status, 404);
  const beforeRevoked = revoked;
  assert.equal((await call("POST", `/api/providers/${p.id}/oauth/logout`, cookie)).body.revoked, true);
  assert.equal(revoked, beforeRevoked + 1);
  assert.equal(tokens(p.id).client_id, "oaiapp_polaris_test");
  assert.equal(tokens(p.id).access, undefined);
  await assert.rejects(freshTokens(providerById(p.id)!), /Reconnect/);
});

test("legacy credentials need reconnect; callback replay and cancellation cannot save credentials", async () => {
  const p = await make();
  db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=?").run(encrypt(JSON.stringify({ access: "legacy", refresh: "legacy", account_id: "old" }), `providers:${p.id}`), p.id);
  const view = (await call("GET", "/api/providers", cookie)).body.find((x: any) => x.id === p.id);
  assert.equal(view.account.status, "reconnect_required");
  assert.equal(view.has_secret, false);
  const a = await start(p.id);
  const responses = await Promise.all([fetch(a.callback), fetch(a.callback)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 400]);
  const b = await start(p.id);
  const before = tokens(p.id).access;
  await call("POST", `/api/providers/${p.id}/oauth/cancel`, cookie);
  await assert.rejects(fetch(b.callback));
  assert.equal(tokens(p.id).access, before);
});

test("plan usage limits pause inference until the user explicitly tests again", async () => {
  const p = await make();
  await fetch((await start(p.id)).callback);
  mode = "quota";
  const req = { model: "gpt-test", system: [], messages: [], tools: [] };
  const before = inference.length;
  await assert.rejects(adapterFor(providerById(p.id)!).stream(req, () => {}), /usage_limit_exceeded/);
  await assert.rejects(adapterFor(providerById(p.id)!).stream(req, () => {}), /usage is paused/);
  assert.equal(inference.length, before + 1, "quota errors must neither retry nor silently route elsewhere");
  assert.equal((await call("GET", "/api/providers", cookie)).body.find((v: any) => v.id === p.id).account.status, "usage_limited");
  mode = "ok";
  assert.equal((await call("POST", `/api/providers/${p.id}/test`, cookie, { model: "gpt-test" })).body.ok, true);
  assert.equal(tokens(p.id).blocked_code, undefined);
});

test("logout wins over an in-flight refresh and revokes the discarded replacement", async () => {
  const p = await make();
  await fetch((await start(p.id)).callback);
  db.prepare("UPDATE providers SET encrypted_secret=? WHERE id=?").run(encrypt(JSON.stringify({ ...tokens(p.id), expires: 0 }), `providers:${p.id}`), p.id);
  let release!: () => void;
  refreshGate = new Promise<void>((done) => { release = done; });
  const before = refreshes;
  const rotation = freshTokens(providerById(p.id)!);
  const rejected = assert.rejects(rotation, /refresh failed/);
  await until("refresh started", () => refreshes > before);
  const beforeRevoked = revoked;
  await call("POST", `/api/providers/${p.id}/oauth/logout`, cookie);
  release();
  await rejected;
  refreshGate = undefined;
  assert.equal(tokens(p.id).access, undefined);
  assert.equal(revoked, beforeRevoked + 2, "revoke both the old credential and the discarded rotation");
});

test.after(() => { for (const id of oauth.logins.keys()) oauth.cancelLogin(id); auth.srv.close(); apiServer.srv.close(); trap.srv.close(); });

test("token endpoint: a redirect is never followed, and a token of the wrong shape is refused (POL-26)", async () => {
  const cur = { version: 2, client_id: "oaiapp_polaris_test", host_id: "h", issuer: auth.url, subject: "person-1", refresh: "refresh-x", scopes: [] } as any;
  mode = "redirect";
  await assert.rejects(oauth.refreshTokens(cur));
  assert.equal(trapHits, 0, "the refresh token went nowhere else");
  mode = "bad_shape";
  await assert.rejects(oauth.refreshTokens(cur), /OpenAI token request failed/);
  mode = "ok";
});
