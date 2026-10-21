import { test } from "node:test";
import assert from "node:assert/strict";

// npm run reset-password: a forgotten password on a local install, reset from the machine it runs on.
const { call, user } = await import("./helpers.ts");
const { resetPassword } = await import("../server/cli/reset-password.ts");
const signIn = (password: string) => call("POST", "/api/auth/sign-in/email", "", { email: "rosa@x.dev", password });

test("reset-password sets a new password and signs the account out everywhere", async () => {
  const old = await user("rosa");
  assert.equal((await call("GET", "/api/tracker", old)).status, 200);
  const fresh = await resetPassword("ROSA@x.dev"); // emails match whatever the case
  assert.ok(fresh.length >= 16);
  assert.equal((await call("GET", "/api/tracker", old)).status, 401); // the old session is gone
  assert.equal((await signIn("password-123")).status, 401);
  assert.equal((await signIn(fresh)).status, 200);
  await resetPassword("rosa@x.dev", "chosen-password");
  assert.equal((await signIn("chosen-password")).status, 200);
  await assert.rejects(resetPassword("rosa@x.dev", "short"), /at least 8/);
  await assert.rejects(resetPassword("nobody@x.dev"), /no account/);
});
