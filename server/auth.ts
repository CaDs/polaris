import { APIError, betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import { db } from "./db.ts";

// Workspaces are Better Auth organizations; users join them through `member` rows.
const options = {
  database: db,
  emailAndPassword: { enabled: true },
  plugins: [organization()],
  trustedOrigins: [process.env.WEB_ORIGIN ?? "http://localhost:5173"],
  databaseHooks: {
    user: {
      create: {
        // Single-owner by default: the first account is the owner, later sign-ups need POLARIS_OPEN_SIGNUP=1.
        before: async () => {
          if (process.env.POLARIS_OPEN_SIGNUP !== "1" && db.prepare("SELECT 1 FROM user LIMIT 1").get())
            throw new APIError("FORBIDDEN", { message: "sign-up is closed: this Polaris already has an owner (set POLARIS_OPEN_SIGNUP=1 to allow more accounts)" });
        },
      },
    },
    session: {
      create: {
        // New sessions start in the user's oldest workspace instead of none.
        before: async (session) => {
          const m = db
            .prepare("SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt LIMIT 1")
            .get(session.userId) as { organizationId: string } | undefined;
          return { data: { ...session, activeOrganizationId: m?.organizationId ?? null } };
        },
      },
    },
  },
} satisfies BetterAuthOptions;

// Migrate before constructing, so Better Auth's startup schema check sees its tables.
await (await getMigrations(options)).runMigrations();
export const auth = betterAuth(options);
