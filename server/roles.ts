import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "./db.ts";

// Workspace roles are Better Auth's member.role ("owner", "admin", "member"; several may be comma-separated). The creator of a
// workspace is its owner. Owners and admins change what runs code or spends money: providers, settings, prompts and lessons,
// a project's repository and commands, ticket test commands and caps, approvals. Members keep reads, tickets, comments, runs, chat.
export const isAdmin = (c: Context<any>) => {
  const m = db.prepare("SELECT role FROM member WHERE userId = ? AND organizationId = ?").get(c.get("userId"), c.get("workspaceId")) as { role: string } | undefined;
  return !!m?.role.split(",").some((r) => r === "owner" || r === "admin");
};

// Throws 403 (an {error} JSON through app.onError) unless the caller is an owner or admin of the active workspace.
export function requireRole(c: Context<any>) {
  if (!isAdmin(c)) throw new HTTPException(403, { message: "only workspace owners and admins can do this" });
}
