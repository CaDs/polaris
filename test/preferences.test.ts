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
