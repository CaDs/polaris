import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Single-user defaults: sign-up closes after the first account, cookie mutations must be same-origin, the API listens on loopback.
delete process.env.POLARIS_OPEN_SIGNUP; // npm test opens sign-up for the multi-user suites
process.env.POLARIS_RATE_LIMIT = "1";
const { call, origin, project, signUp } = await import("./helpers.ts");

test("the first account is the owner; sign-up then closes unless POLARIS_OPEN_SIGNUP=1", async () => {
  assert.equal((await signUp("owner")).status, 200);
  const closed = await signUp("intruder");
  assert.equal(closed.status, 403);
  assert.match(closed.body.message, /sign-up is closed/);
  process.env.POLARIS_OPEN_SIGNUP = "1";
  try {
    assert.equal((await signUp("guest")).status, 200);
  } finally {
    delete process.env.POLARIS_OPEN_SIGNUP;
  }
});

test("cookie-authenticated mutations must come from a trusted origin", async () => {
  const login = await call("POST", "/api/auth/sign-in/email", "", { email: "owner@x.dev", password: "password-123" });
  const cookie = (await call("POST", "/api/auth/organization/create", login.cookie, { name: "own", slug: "own" })).cookie;
  const { id: project_id } = await project(cookie, "own");
  const post = (headers: Record<string, string>) => call("POST", "/api/tickets", cookie, { title: "t", project_id }, headers);
  const evil = await post({ origin: "http://evil.example" });
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error, "forbidden_origin");
  assert.equal((await post({ origin: "http://localhost:3000" })).status, 201); // BETTER_AUTH_URL
  assert.equal((await post({ origin })).status, 201); // WEB_ORIGIN
  assert.equal((await post({ origin: "http://polaris.lan:3000", host: "polaris.lan:3000" })).status, 201); // the request's own host
  assert.equal((await post({ "sec-fetch-site": "same-origin" })).status, 201);
  assert.equal((await post({ "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post({})).status, 403, "a cookie without Origin/Sec-Fetch-Site is refused");
  assert.equal((await call("POST", "/api/tickets", "", { title: "t", project_id }, {})).status, 401, "no cookie: passes on to the session check");
  assert.equal((await call("GET", "/api/tickets", cookie, undefined, { origin: "http://evil.example" })).status, 200, "reads are not gated");
});

test("the API binds to loopback by default", async () => {
  const { HOST, ...env } = process.env;
  const child = spawn(process.execPath, ["server/index.ts"], { env: { ...env, PORT: "0", POLARIS_DATA_DIR: mkdtempSync(join(tmpdir(), "sec-")) } });
  try {
    let out = "";
    while (!/api on \S+/.test(out)) out += (await once(child.stdout, "data"))[0];
    const url = out.match(/api on (\S+)/)![1];
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${url}/api/tickets`)).status, 401);
  } finally {
    child.kill();
  }
});

test("the server refuses to start with an unset, short or placeholder BETTER_AUTH_SECRET", async () => {
  for (const secret of ["change-me-to-32-plus-random-chars", "short", ""]) {
    const child = spawn(process.execPath, ["server/index.ts"], { env: { ...process.env, BETTER_AUTH_SECRET: secret, PORT: "0", POLARIS_DATA_DIR: mkdtempSync(join(tmpdir(), "sec-")) } });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0, `secret "${secret}"`);
    assert.match(err, /BETTER_AUTH_SECRET/);
  }
});

test("sign-in is rate limited per client address without NODE_ENV=production", async () => {
  assert.equal(process.env.NODE_ENV, undefined);
  const attempt = (ip: string) => call("POST", "/api/auth/sign-in/email", "", { email: "owner@x.dev", password: "wrong-password" }, { origin, "x-polaris-client-ip": ip });
  for (let i = 1; i <= 5; i++) assert.equal((await attempt("203.0.113.9")).status, 401, `attempt ${i}`);
  assert.equal((await attempt("203.0.113.9")).status, 429, "6th attempt in the window");
  assert.equal((await attempt("203.0.113.10")).status, 401, "another address has its own bucket");
});

test("a real server limits by socket address and ignores a client-chosen address header", async () => {
  const child = spawn(process.execPath, ["server/index.ts"], { env: { ...process.env, PORT: "0", DB_PATH: ":memory:", POLARIS_DATA_DIR: mkdtempSync(join(tmpdir(), "sec-")) } });
  try {
    let out = "";
    while (!/api on \S+/.test(out)) out += (await once(child.stdout, "data"))[0];
    const url = out.match(/api on (\S+)/)![1];
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${url}/api/auth/sign-in/email`, { method: "POST", headers: { "content-type": "application/json", "x-polaris-client-ip": `198.51.100.${i}` }, body: JSON.stringify({ email: "a@x.dev", password: "wrong-password" }) });
      codes.push(r.status);
    }
    assert.equal(codes[5], 429, codes.join());
  } finally {
    child.kill();
  }
});
