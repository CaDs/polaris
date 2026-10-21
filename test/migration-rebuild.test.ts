import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// 003 rebuilds providers (SQLite cannot widen a CHECK). On a database with data, the rows that point at a provider must
// keep pointing at it: the rebuild runs with foreign keys off, so dropping the old table cascades nothing.
const dir = new URL("../server/migrations/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const path = join(mkdtempSync(join(tmpdir(), "polaris-mig-")), "old.db");
{
  const old = new DatabaseSync(path);
  old.exec("PRAGMA foreign_keys = ON; CREATE TABLE organization (id TEXT PRIMARY KEY); CREATE TABLE user (id TEXT PRIMARY KEY);");
  for (const f of files.slice(0, files.indexOf("003_provider_kinds.sql"))) old.exec(readFileSync(new URL(f, dir), "utf8"));
  old.exec(`PRAGMA user_version = ${files.indexOf("003_provider_kinds.sql")};
    INSERT INTO organization VALUES ('w');
    INSERT INTO providers (id, workspace_id, name, kind, auth_type, encrypted_secret) VALUES ('p1', 'w', 'Claude', 'anthropic', 'api_key', 'v1:x');
    INSERT INTO projects (id, workspace_id, key, name, repo_path, base_branch) VALUES ('pr', 'w', 'APP', 'App', '/r', 'main');
    INSERT INTO tickets (id, workspace_id, project_id, title, provider_id) VALUES ('t1', 'w', 'pr', 'uses p1', 'p1');
    INSERT INTO runs (id, ticket_id, model, provider_id) VALUES ('r1', 't1', 'm', 'p1');
    INSERT INTO workspace_settings (workspace_id, default_provider_id, review_provider_id) VALUES ('w', 'p1', 'p1');`);
  old.close();
}
process.env.DB_PATH = path;
const { db, migrate } = await import("../server/db.ts");

test("003 keeps every reference to a provider through the table rebuild, and accepts the new kinds", () => {
  migrate();
  assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, files.length);
  assert.deepEqual({ ...db.prepare("SELECT name, kind, encrypted_secret, options FROM providers WHERE id = 'p1'").get() }, { name: "Claude", kind: "anthropic", encrypted_secret: "v1:x", options: "{}" });
  assert.equal((db.prepare("SELECT provider_id FROM tickets WHERE id = 't1'").get() as { provider_id: string }).provider_id, "p1");
  assert.equal((db.prepare("SELECT provider_id FROM runs WHERE id = 'r1'").get() as { provider_id: string }).provider_id, "p1");
  assert.deepEqual({ ...db.prepare("SELECT default_provider_id, review_provider_id FROM workspace_settings").get() }, { default_provider_id: "p1", review_provider_id: "p1" });
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1); // back on after migrating
  db.prepare("INSERT INTO providers (id, workspace_id, name, kind, auth_type) VALUES ('p2', 'w', 'OR', 'openrouter', 'api_key')").run();
  // Foreign keys still bite: deleting the provider unsets it where it was used (ON DELETE SET NULL).
  db.prepare("DELETE FROM providers WHERE id = 'p1'").run();
  assert.equal((db.prepare("SELECT provider_id FROM tickets WHERE id = 't1'").get() as { provider_id: string | null }).provider_id, null);
});
