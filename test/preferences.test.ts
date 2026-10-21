import { test } from "node:test";
import assert from "node:assert/strict";

// Settings → Appearance: a palette and light/dark/system per user, the same in every workspace.
const { call, user } = await import("./helpers.ts");

test("preferences: defaults, validated, merged, per user", async () => {
  const ann = await user("ann");
  const ben = await user("ben");
  assert.deepEqual((await call("GET", "/api/me/preferences", ann)).body, { palette: "black", mode: "system" });
  assert.deepEqual((await call("PUT", "/api/me/preferences", ann, { palette: "graphite" })).body, { palette: "graphite", mode: "system" });
  assert.deepEqual((await call("PUT", "/api/me/preferences", ann, { mode: "dark" })).body, { palette: "graphite", mode: "dark" }); // omitted = kept
  for (const bad of [{ palette: "neon" }, { mode: "dim" }, { palette: 5 }])
    assert.equal((await call("PUT", "/api/me/preferences", ann, bad)).status, 400, JSON.stringify(bad));
  assert.deepEqual((await call("GET", "/api/me/preferences", ann)).body, { palette: "graphite", mode: "dark" });
  assert.deepEqual((await call("GET", "/api/me/preferences", ben)).body, { palette: "black", mode: "system" }); // someone else's are untouched
  assert.equal((await call("GET", "/api/me/preferences")).status, 401);
});

// The sidebar's project switcher: the current project per member and workspace, set by creating or opening a project.
test("current project: a new project becomes current; switching is validated and per member", async () => {
  const { project } = await import("./helpers.ts");
  const cy = await user("cy");
  const current = async (cookie: string) => (await call("GET", "/api/tracker", cookie)).body.current;
  assert.equal(await current(cy), null);
  const eno = await project(cy, "Enotec");
  const amr = await project(cy, "Amra RPG");
  assert.equal(await current(cy), amr.id); // the newest one
  assert.equal((await call("PUT", "/api/me/project", cy, { project_id: eno.id })).status, 200);
  assert.equal(await current(cy), eno.id);
  const dee = await user("dee");
  const other = await project(dee, "Other");
  assert.equal((await call("PUT", "/api/me/project", cy, { project_id: other.id })).status, 400); // another workspace's
  assert.equal((await call("PUT", "/api/me/project", cy, {})).status, 400);
  assert.equal(await current(dee), other.id);
  await call("DELETE", `/api/projects/${eno.id}`, cy);
  assert.equal(await current(cy), null); // a deleted project is no one's current one
});
