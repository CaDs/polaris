// Deterministic, local-only SIWC fixture for the browser suite. Real-model runs use server/index.ts directly.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
const keys = await generateKeyPair("RS256");
const jwk = { ...await exportJWK(keys.publicKey), kid: "browser-test", alg: "RS256", use: "sig" };
const codes = new Map<string, string>();
const frame = (e: object) => `data: ${JSON.stringify(e)}\n\n`;
let origin = "";
const mock = createServer(async (req, res) => {
  const u = new URL(req.url!, origin);
  if (u.pathname === "/.well-known/openid-configuration") return void res.end(JSON.stringify({ issuer: origin, jwks_uri: `${origin}/jwks`, revocation_endpoint: `${origin}/revoke` }));
  if (u.pathname === "/jwks") return void res.end(JSON.stringify({ keys: [jwk] }));
  if (u.pathname === "/revoke") return void res.end();
  if (u.pathname === "/api/accounts/authorize") {
    const code = randomUUID();
    codes.set(code, u.searchParams.get("nonce")!);
    const redirect = new URL(u.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", u.searchParams.get("state")!);
    redirect.searchParams.set("client_id", "oaiapp_polaris_browser");
    return void res.writeHead(302, { location: redirect.toString() }).end();
  }
  let raw = "";
  for await (const c of req) raw += c;
  if (u.pathname === "/api/accounts/oauth/token") {
    const b = new URLSearchParams(raw);
    const id_token = await new SignJWT({ nonce: codes.get(b.get("code")!), email: "browser@example.com" }).setProtectedHeader({ alg: "RS256", kid: "browser-test" })
      .setIssuer(origin).setAudience("oaiapp_polaris_browser").setSubject("browser-person").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
    return void res.end(JSON.stringify({ access_token: "browser-access", refresh_token: "browser-refresh", id_token, token_type: "Bearer", expires_in: 3600, scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" }));
  }
  if (u.pathname === "/v1/models") return void res.end(JSON.stringify({ models: [{ slug: "gpt-browser", display_name: "GPT Browser", visibility: "list" }] }));
  if (u.pathname === "/api/tags") return void res.end(JSON.stringify({ models: [{ name: "local-browser" }] }));
  if (u.pathname === "/api/ps" || u.pathname === "/api/show") return void res.end(JSON.stringify({}));
  const b = JSON.parse(raw || "{}");
  if (u.pathname === "/v1/responses") {
    const tools = b.tools?.[0]?.tools ?? b.tools ?? [];
    const names = tools.map((t: any) => t.name);
    let item: any = { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] };
    const tool = (name: string, input: object) => ({ type: "function_call", namespace: "polaris", call_id: randomUUID(), name, arguments: JSON.stringify(input) });
    if (names.includes("echo")) item = tool("echo", { text: "ping" });
    else if (names.includes("submit_review")) item = tool("submit_review", { verdict: "approve", findings: [] });
    else if (names.includes("apply_patch") && !b.input.some((i: any) => i.type === "function_call_output")) item = tool("apply_patch", { patch: "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    // Match live SIWC streaming: completed may omit items already sent in output_item.done.
    return void res.end(frame({ type: "response.output_item.done", output_index: 0, item }) + frame({ type: "response.completed", response: { output: [], usage: { input_tokens: 15, output_tokens: 3, input_tokens_details: { cached_tokens: 5 } } } }));
  }
  if (u.pathname === "/v1/messages") {
    const names = (b.tools ?? []).map((t: any) => t.name);
    let content: any = { type: "text", text: "Done." };
    const tool = (name: string, input: object) => ({ type: "tool_use", id: randomUUID(), name, input });
    if (names.includes("echo")) content = tool("echo", { text: "ping" });
    else if (names.includes("submit_review")) content = tool("submit_review", { verdict: "approve", findings: [] });
    else if (names.includes("shell") && b.messages.at(-1).content[0].type !== "tool_result") content = tool("shell", { command: "printf 'hello\\n' > note.txt" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    return void res.end(frame({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5 } } }) + frame({ type: "content_block_start", index: 0, content_block: content.type === "tool_use" ? { ...content, input: {} } : content }) + (content.type === "tool_use" ? frame({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(content.input) } }) : "") + frame({ type: "content_block_stop", index: 0 }) + frame({ type: "message_delta", delta: { stop_reason: content.type === "tool_use" ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }));
  }
  res.writeHead(404).end();
});
await new Promise<void>((done) => mock.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
process.env.POLARIS_OPENAI_AUTH_URL = origin;
process.env.POLARIS_OPENAI_PLAN_URL = `${origin}/v1`;
// The tests discover this fixture's Ollama URL without exposing secrets or a production endpoint override.
process.env.POLARIS_E2E_OLLAMA_URL = origin;
const { app } = await import("../server/app.ts");
app.get("/api/e2e/ollama", (c) => c.json({ url: origin }));
await import("../server/index.ts");
