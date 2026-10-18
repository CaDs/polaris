import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

export const db = new DatabaseSync(process.env.DB_PATH ?? "polaris.db");
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

// Our own tables. Better Auth migrates its tables (user, session, organization, member, ...) first.
// Each file in migrations/ runs once, in name order; PRAGMA user_version tracks how many ran.
const dir = new URL("./migrations/", import.meta.url);

export function migrate() {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < files.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(new URL(files[v], dir), "utf8"));
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
