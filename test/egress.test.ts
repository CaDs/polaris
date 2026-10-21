import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

// Provider egress (server/egress.ts): where a key may be sent, no redirects, a header deadline, capped error bodies,
// and secrets scrubbed from text.
const { cappedText, checkEndpoint, checkUrl, EgressError, providerFetch, scrub } = await import("../server/egress.ts");

const refused = (url: string, re: RegExp) => assert.throws(() => checkUrl(url), (e: Error) => e instanceof EgressError && re.test(e.message), url);

test("base URLs: https anywhere; http only to this machine or a private network; never metadata, credentials or other schemes", () => {
  for (const ok of ["https://api.example.com/v1", "http://localhost:4000", "http://127.0.0.1:11434", "http://[::1]:4000", "http://192.168.1.20:4000",
    "http://10.0.0.5", "http://172.20.0.3:4000", "http://litellm:4000", "http://gpu-box.local:11434", "http://proxy.internal", "http://100.101.102.103:4000"])
    assert.doesNotThrow(() => checkUrl(ok), ok);
  refused("http://api.example.com", /unencrypted/);
  refused("http://8.8.8.8:4000", /unencrypted/);
  refused("http://169.254.169.254/latest/meta-data", /metadata/);
  refused("https://169.254.169.254", /metadata/);
  refused("http://[::ffff:169.254.169.254]/", /metadata/); // the same address in IPv6 clothes
  refused("http://[fe80::1]:4000", /link-local/);
  refused("http://0.0.0.0:4000", /unspecified/);
  refused("https://user:pass@api.example.com", /credentials/);
  refused("ftp://api.example.com", /http\(s\)/);
  refused("not a url", /http\(s\)/);
  process.env.POLARIS_ALLOW_HTTP_PROVIDERS = "1";
  try {
    assert.doesNotThrow(() => checkUrl("http://api.example.com"));
    refused("http://169.254.169.254", /metadata/); // the override never opens metadata
  } finally {
    delete process.env.POLARIS_ALLOW_HTTP_PROVIDERS;
  }
});

test("checkEndpoint resolves names: localhost passes, an unresolvable name fails", async () => {
  assert.equal((await checkEndpoint("http://localhost:1/x")).hostname, "localhost");
  await assert.rejects(checkEndpoint("https://no-such-host.invalid"), /cannot resolve/);
});

test("providerFetch refuses redirects (the key would follow) and gives up on silent servers; error bodies are capped", async () => {
  const srv = createServer((req, res) => {
    if (req.url === "/redirect") return void res.writeHead(302, { location: "https://elsewhere.example/steal" }).end();
    if (req.url === "/big") return void res.writeHead(500).end("x".repeat(200_000));
    if (req.url === "/silent") return; // never answers
    res.end("ok");
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    assert.equal(await (await providerFetch(`${base}/`)).text(), "ok");
    await assert.rejects(providerFetch(`${base}/redirect`, { headers: { authorization: "Bearer sk-test" } }), (e: Error) => e instanceof EgressError && /redirect/.test(e.message));
    await assert.rejects(providerFetch(`${base}/silent`, {}, 200), (e: Error) => e instanceof EgressError && /no response within/.test(e.message));
    assert.equal((await cappedText(await providerFetch(`${base}/big`), 1000)).length, 1000);
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
});

test("scrub removes key shapes, bearer tokens and the given secrets", () => {
  assert.equal(scrub("Incorrect API key provided: sk-or-v1-0123456789abcdef0123"), "Incorrect API key provided: [redacted]");
  assert.equal(scrub("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"), "Authorization: Bearer [redacted]");
  assert.equal(scrub("key mysecretkey rejected", ["mysecretkey"]), "key [redacted] rejected");
  assert.equal(scrub("short keys like abc stay", ["abc"]), "short keys like abc stay"); // too short to scrub safely
});
