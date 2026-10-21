import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// POL-26: calls that bypass providerFetch (OAuth, plan models, the Slack webhook) refuse redirects and have a deadline.
process.env.POLARIS_SLACK_TIMEOUT_MS = "200";
process.env.POLARIS_PROVIDER = "fake";
const { call, listen, project, user, fileTicket, wsOf, until } = await import("./helpers.ts");
const { notify } = await import("../server/tracker.ts");

test("every bare fetch in oauth.ts and tracker.ts says redirect: \"error\" and has a timeout; providers.ts has none (providerFetch)", () => {
  assert.equal([...readFileSync(new URL("../server/providers.ts", import.meta.url), "utf8").matchAll(/(?<![\w.])fetch\(/g)].length, 0);
  for (const f of ["oauth", "tracker"]) {
    const src = readFileSync(new URL(`../server/${f}.ts`, import.meta.url), "utf8");
    const calls = [...src.matchAll(/(?<![\w.])fetch\(/g)];
    assert.ok(calls.length > 0, f);
    for (const m of calls) {
      const call = src.slice(m.index, src.indexOf(");", m.index) + 2);
      assert.match(call, /redirect: "error"/, `${f}: ${call}`);
      assert.match(call, /AbortSignal\.timeout/, `${f}: ${call}`);
    }
  }
});

test("a Slack webhook that hangs is cut off at the deadline; one that redirects is not followed", async () => {
  const alice = await user("slacker");
  await project(alice, "slacker");
  const t = (await fileTicket(alice, { title: "t", spec: "s" })).body.id as string;
  let closed = false;
  let hits = 0;
  const trap = await listen((_q, res) => (hits++, void res.end()));
  let mode: "hang" | "redirect" = "hang";
  const hook = await listen((req, res) => {
    if (mode === "redirect") return void res.writeHead(307, { location: `${trap.url}/x` }).end();
    req.on("close", () => (closed = true)); // never answers
  });
  process.env.POLARIS_SLACK_WEBHOOK = hook.url;
  try {
    notify(wsOf("slacker"), t, "failed", "run failed");
    await until("the hanging webhook to be dropped", () => closed, 3000);
    mode = "redirect";
    notify(wsOf("slacker"), t, "failed", "run failed");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(hits, 0);
  } finally {
    delete process.env.POLARIS_SLACK_WEBHOOK;
    for (const s of [hook, trap]) (s.srv.closeAllConnections(), s.srv.close());
  }
});
