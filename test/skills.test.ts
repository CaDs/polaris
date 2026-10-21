import { test } from "node:test";
import assert from "node:assert/strict";

// M17 skills: workspace skills (API, validation, isolation), the composer's list (repo + workspace), runs that see them
// without committing them, and skills attached to a chat message.
process.env.POLARIS_PROVIDER = "fake";
const { call, db, sh, task, until, workspace } = await import("./helpers.ts");

const w = await workspace("skl", { test_command: "test -f notes.txt", model_review: false, wiki: false });
sh(w.repo, `mkdir -p .polaris/skills && printf -- '---\\nname: Release notes\\ndescription: How we write release notes\\nphases: chat\\n---\\n\\nUse past tense. Group by area.\\n' > .polaris/skills/release.md && git add -A && git -c user.name=t -c user.email=t@t commit -qm skills`);
const skill = { name: "Small diffs", description: "Keep every change under 50 lines", body: "Split the work; one concern per change.", phases: ["worker", "chat"] };

test("workspace skills: validated, unique per workspace, isolated", async () => {
  for (const [bad, re] of [[{ ...skill, name: "" }, /name/], [{ ...skill, description: "" }, /description/], [{ ...skill, body: " " }, /instructions/], [{ ...skill, phases: [] }, /phases/], [{ ...skill, phases: ["boss"] }, /phases/]] as const)
    assert.match((await call("POST", "/api/skills", w.cookie, bad)).body.error, re);
  const made = await call("POST", "/api/skills", w.cookie, skill);
  assert.equal(made.status, 201);
  assert.deepEqual([made.body.name, made.body.phases, made.body.author], ["Small diffs", ["worker", "chat"], "skl@x.dev"]);
  assert.match((await call("POST", "/api/skills", w.cookie, { ...skill, name: "small DIFFS" })).body.error, /already exists/);
  const other = await workspace("sko");
  assert.deepEqual((await call("GET", "/api/skills", other.cookie)).body, []);
  assert.equal((await call("PATCH", `/api/skills/${made.body.id}`, other.cookie, { name: "x" })).status, 404);
  assert.equal((await call("GET", `/api/projects/${w.project.id}/skills`, other.cookie)).status, 404);
  assert.equal((await call("PATCH", `/api/skills/${made.body.id}`, w.cookie, { description: "Keep changes small" })).body.description, "Keep changes small");
});

test("the composer lists the repo's skills (base branch, no checkout) and the workspace's", async () => {
  const list = (await call("GET", `/api/projects/${w.project.id}/skills`, w.cookie)).body;
  assert.deepEqual(list.map((k: any) => [k.id.replace(/ws:.*/, "ws:…"), k.name, k.source]), [["repo:release.md", "Release notes", "repo"], ["ws:…", "Small diffs", "workspace"]]);
});

test("a worker run is offered workspace skills as files it can read, and never commits them", async () => {
  const t = await w.create({ title: "Write notes" });
  await call("POST", `/api/tickets/${t.id}/runs`, w.cookie);
  const done = await w.is(t.id, "review");
  const first = task(done.runs[0].id);
  assert.match(first, /Small diffs — Keep changes small — \.polaris\/workspace-skills\/small-diffs-[0-9a-f]{8}\.md/);
  assert.doesNotMatch(first, /Release notes/); // a chat-only repo skill is not the worker's
  assert.deepEqual(sh(w.repo, `git show --name-only --format= ${done.runs[0].branch}`).split("\n"), ["notes.txt"]);
});

test("skills attached to a chat message go with it in full; the message shows them", async () => {
  const id = (db.prepare("SELECT id FROM skills WHERE name = 'Small diffs'").get() as { id: string }).id;
  const body = { message: "NO-PROPOSAL draft the notes", project_id: w.project.id, skills: ["repo:release.md", `ws:${id}`, "repo:../../etc/passwd", "ws:nope"], skill_names: [["repo:release.md", "Release notes"], [`ws:${id}`, "Small diffs"]] };
  const c = (await call("POST", "/api/chats", w.cookie, body)).body;
  const done = await until("chat turn", async () => {
    const x = (await call("GET", `/api/chats/${c.id}`, w.cookie)).body;
    return !x.busy && x.events.some((e: any) => e.type === "turn_finished") && x;
  });
  assert.deepEqual(done.events[0].payload.skills.slice(0, 2), [{ id: "repo:release.md", name: "Release notes" }, { id: `ws:${id}`, name: "Small diffs" }]);
  const sent = JSON.parse((db.prepare("SELECT messages FROM chats WHERE id = ?").get(c.id) as { messages: string }).messages)[0].content[0].text as string;
  assert.match(sent, /# Skills the user attached[\s\S]*## Release notes\n\nUse past tense\. Group by area\.[\s\S]*## Small diffs\n\nSplit the work; one concern per change\.[\s\S]*# Message\n\nNO-PROPOSAL draft the notes$/);
  assert.doesNotMatch(sent, /passwd|nope/); // unknown or unsafe ids are left out
});
