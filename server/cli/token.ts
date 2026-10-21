// npm run token [-- --email you@x.dev] [--days 30] [--name claude-code]
// Prints an API token for the MCP server and scripts: a Better Auth session sent as `Authorization: Bearer <token>`.
// It starts in the account's oldest workspace, like a sign-in. Settings > Account lists it by --name and revokes it.
import { parseArgs } from "node:util";
import { auth, TOKEN_UA } from "../auth.ts";
import { db } from "../db.ts";

export async function mintToken(email?: string, days = 30, name = "") {
  const u = (email ? db.prepare("SELECT id FROM user WHERE email = ?").get(email) : db.prepare("SELECT id FROM user ORDER BY createdAt LIMIT 1").get()) as
    | { id: string }
    | undefined;
  if (!u) throw new Error(email ? `no account ${email}` : "no account yet: sign up in the dashboard first");
  const expiresAt = new Date(Date.now() + days * 86_400_000);
  return (await (await auth.$context).internalAdapter.createSession(u.id, false, { expiresAt, userAgent: TOKEN_UA + (name || "unnamed") }, true)).token;
}

if (import.meta.main) {
  const { values: opt } = parseArgs({ options: { email: { type: "string" }, days: { type: "string", default: "30" }, name: { type: "string" } } });
  console.log(await mintToken(opt.email, Number(opt.days), opt.name));
}
