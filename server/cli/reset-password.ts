// npm run reset-password -- you@x.dev [--password <new>]
// Polaris runs on your machine and sends no email, so a forgotten password is reset here: whoever can run commands where
// Polaris runs (and so read its database) owns it anyway. Sets a new password (a generated one unless --password is
// given), prints it, and signs the account out everywhere.
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { auth } from "../auth.ts";
import { db } from "../db.ts";

export async function resetPassword(email: string, password = randomBytes(12).toString("base64url")) {
  if (password.length < 8) throw new Error("the password must be at least 8 characters");
  const u = db.prepare("SELECT id FROM user WHERE email = ? COLLATE NOCASE").get(email.trim()) as { id: string } | undefined;
  if (!u) throw new Error(`no account ${email}`);
  const ctx = await auth.$context;
  if (!(await ctx.internalAdapter.findCredentialAccount(u.id))) throw new Error(`${email} has no password sign-in`);
  await ctx.internalAdapter.updatePassword(u.id, await ctx.password.hash(password));
  await ctx.internalAdapter.deleteUserSessions(u.id); // API tokens (npm run token) are sessions too: mint new ones
  return password;
}

if (import.meta.main) {
  const { values: opt, positionals } = parseArgs({ allowPositionals: true, options: { password: { type: "string" } } });
  if (!positionals[0]) {
    console.error("usage: npm run reset-password -- you@x.dev [--password <new>]");
    process.exit(1);
  }
  try {
    const password = await resetPassword(positionals[0], opt.password);
    console.log(opt.password ? `Password reset for ${positionals[0]}.` : `New password for ${positionals[0]}: ${password}`);
    console.log("Its sessions and API tokens are revoked; sign in again (and change it in your password manager).");
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
