import { test } from "node:test";
import assert from "node:assert/strict";

// POL-15: the operator's ANTHROPIC_API_KEY fallback belongs to the first account's workspaces, not to every registrant.
const seen: (string | undefined)[] = [];
const { call, configure, fileTicket, listen, reply, tempRepo, until, user, wsOf, db } = await import("./helpers.ts");
const { srv, url } = await listen((req, res) => {
  seen.push(req.headers["x-api-key"] as string | undefined);
  res.writeHead(200, { "content-type": "text/event-stream" }).end(reply({ text: "All done." }));
});
process.env.ANTHROPIC_API_KEY = "sk-ant-operator-key-0000";
process.env.ANTHROPIC_BASE_URL = url;

const alice = await user("alice");
const bob = await user("bob");
const carol = await user("carol");

const ticket = async (who: string) => {
  await configure(who, { repo_path: tempRepo(), setup_command: "", test_command: "true" });
  return (await fileTicket(who, { title: "t", spec: "d" })).body.id as string;
};

test("a second account's workspace without a provider cannot spend the env key; the first account's can", async () => {
  const b = await ticket(bob);
  const refused = await call("POST", `/api/tickets/${b}/runs`, bob);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /add a provider in Settings/);
  assert.deepEqual(seen, [], "no request carried the env key");

  const a = await ticket(alice);
  assert.equal((await call("POST", `/api/tickets/${a}/runs`, alice)).status, 201);
  await until("the env key to be used", () => seen.length > 0);
  assert.equal(seen[0], "sk-ant-operator-key-0000");
});

test("POLARIS_ENV_PROVIDER_WORKSPACES opens the fallback to a listed workspace", async () => {
  const c = await ticket(carol);
  assert.equal((await call("POST", `/api/tickets/${c}/runs`, carol)).status, 400);
  process.env.POLARIS_ENV_PROVIDER_WORKSPACES = `x, ${wsOf("carol")}`;
  try {
    assert.equal((await call("POST", `/api/tickets/${c}/runs`, carol)).status, 201);
  } finally {
    delete process.env.POLARIS_ENV_PROVIDER_WORKSPACES;
  }
});

test.after(() => (srv.closeAllConnections(), srv.close()));
