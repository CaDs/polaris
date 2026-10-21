// npm run reset-password -- you@x.dev
// Polaris runs on your machine and sends no email, so a forgotten password is reset here: whoever can run commands where
// Polaris runs (and so read its database) owns it anyway. Asks for the new password without echoing it (or reads it from
// stdin when piped), never prints it and never takes it as an argument (shell history, ps), then signs the account out
// everywhere.
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { auth } from "../auth.ts";
import { db } from "../db.ts";

export async function resetPassword(email: string, password: string) {
  if (password.length < 8) throw new Error("the password must be at least 8 characters");
  const u = db.prepare("SELECT id FROM user WHERE email = ? COLLATE NOCASE").get(email.trim()) as { id: string } | undefined;
  if (!u) throw new Error(`no account ${email}`);
  const ctx = await auth.$context;
  if (!(await ctx.internalAdapter.findCredentialAccount(u.id))) throw new Error(`${email} has no password sign-in`);
  await ctx.internalAdapter.updatePassword(u.id, await ctx.password.hash(password));
  await ctx.internalAdapter.deleteUserSessions(u.id); // API tokens (npm run token) are sessions too: mint new ones
}

// A line from stdin; on a terminal the typing is echoed to nowhere.
async function secret(prompt: string) {
  const tty = process.stdin.isTTY;
  const rl = createInterface({ input: process.stdin, output: new Writable({ write: (_c, _e, done) => done() }), terminal: tty });
  if (tty) process.stderr.write(prompt);
  const line = await rl.question("");
  rl.close();
  if (tty) process.stderr.write("\n");
  return line;
}

if (import.meta.main) {
  const email = process.argv[2];
  if (!email || process.argv.length > 3) {
    console.error("usage: npm run reset-password -- you@x.dev   (asks for the new password)");
    process.exit(1);
  }
  try {
    const password = await secret("New password: ");
    if (process.stdin.isTTY && (await secret("Again: ")) !== password) throw new Error("the passwords differ");
    await resetPassword(email, password);
    console.log(`Password reset for ${email}. Its sessions and API tokens are revoked: sign in again.`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
