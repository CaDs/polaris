import type { Provider, ProviderRequest, ProviderResponse, TextBlock, ToolUseBlock } from "../types.ts";
import { fakeProvider } from "./fake.ts";

// POLARIS_PROVIDER=fake: deterministic demo run with a delay per turn so streaming is visible.
// Tasks containing "slow" run `sleep 30` instead, so cancel can be tested. 4 turns, usage 100/20/10/0 each.
// Tasks containing "compact" run a long session instead: a 4000-line shell output (spilled to a file), an edit, then usage
// that grows with the conversation (400 tokens per message, 75% cached) so a small compaction threshold triggers a
// compaction after turn 2 and a fresh conversation finishes the work.
// Retries (task contains "Previous attempt failed" or "... was stopped") also create ok.txt, so a `test -f ok.txt` gate fails attempt 1 only.
// M12: STUCK-LOOP in a ticket makes attempt 1 read README.md over and over (the stuck monitor stops it); a retry works normally.
// So does a system prompt containing ALWAYS-CREATE-OK (M6: eval scores differ between prompt versions).
// "slow"/"compact" are matched in the ticket part only (after "# Task"), so lessons naming such a ticket don't leak.
// Requests without tools are M6 meta calls (reflection, prompt proposal), answered at once by demoMeta; M12 failure mining
// (submit_mined_ticket) by demoMine.
// M7: requests with create_ticket are planner rounds (plannerScript); a task asking for a "## Handoff" is a child of an epic
// (childScript).
// M8: requests with submit_review are the model reviewer (reviewScript): it looks at `git status --short`, approves, but a
// ticket containing REVIEW-ONCE gets one round of changes until fixed.txt exists. A worker resumed with review findings
// ("# Model review") writes fixed.txt (fixScript).
// A worker resumed with a failed gate ("# Tests failed", the gate fix round) creates ok.txt when its ticket contains
// GATE-FIX-ONCE (the first finish leaves a `test -f ok.txt` gate failing), else changes nothing: FAIL-GATE and a plain
// failing gate still fail every attempt (gateFixScript).
// M9: a ticket containing SPLIT-ME also writes tests/broken.txt (a protected path), so every attempt fails the gate and the
// harness splits it; the "Split:" epic (its spec still says SPLIT-ME) plans part1.txt and part2.txt with their own test
// commands. EPIC-GATE-FAIL plans only a.txt; the test sets a workspace test command that also needs fix.txt, so the epic
// gate refuses the first complete_epic and the planner creates "Fix: create fix.txt". SPLIT-CHILD passes SPLIT-ME on to a.txt.
// M10: a system prompt starting "You maintain a project wiki" is the wiki maintainer (wikiScript). A bootstrap writes
// overview.md, a lint re-verifies its first stale page; each also lists the page in index.md. A page that exists is updated
// line by line (sources, verified, updated). WIKI-BAD / WIKI-FIXME in the wiki's index.md make the maintainer produce an
// invalid wiki that it never fixes / fixes in the first fix round.
// WIKI-WRITE in a ticket makes a worker write .polaris/wiki/x with the shell (the gate must fail it); WIKI-NOTES adds a
// "## Wiki notes" section to its final reply.
// Project memory: a request with submit_memory (demoMemory) proposes one decision per "REMEMBER: <title>" line of the
// ticket, superseding the entry named by a "SUPERSEDE: <path>" line; else nothing.
// M13: requests with propose_ticket are chat turns (chatScript), one step per request: read README.md, propose a ticket
// titled after the user's message, then reply. A message containing NO-PROPOSAL only replies; REPLACE-P<n> replaces P<n>.
const use = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id, name, input });
const say = (text: string): TextBlock => ({ type: "text", text });
const lastResult = (req: ProviderRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])).join("\n");

const chatScript: Provider = {
  async stream(req, onEvent) {
    const at = req.messages.findLastIndex((m) => m.role === "user" && m.content.some((b) => b.type === "text"));
    const said = req.messages[at];
    const text = said.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const message = text.slice(text.lastIndexOf("\n\n") + 2).trim(); // the user's own words come last
    const called = req.messages.at(-2)?.content.find((b) => b.type === "tool_use")?.name;
    const id = `c${req.messages.length}`;
    const content =
      at === req.messages.length - 1 ? [say("Let me look at the code first."), use(id, "read_file", { path: "README.md" })]
      : called === "read_file" && message.includes("NO-PROPOSAL") ? [say(`README.md says: ${lastResult(req).split("\n")[0]}`)]
      : called === "read_file" ? [use(id, "propose_ticket", { title: message.split("\n")[0].slice(0, 60), spec: `${message}\n\nAcceptance: the test gate passes.`, estimate: 2, ...(/REPLACE-(P\d+)/.test(message) ? { replaces: /REPLACE-(P\d+)/.exec(message)![1] } : {}) })]
      : [say(`I proposed a ticket for that. ${lastResult(req).split(".")[0]}. **File** it when it looks right.`)];
    for (const b of content) if (b.type === "text") for (const w of b.text.split(/(?<= )/)) onEvent({ type: "text", text: w }); // word by word, so streaming shows
    return { message: { role: "assistant", content }, usage: { input: 100, output: 20, cache_read: 10, cache_write: 0 }, stopReason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
  },
};

// Round 1 (no children yet): read README.md, create A ("Create a.txt"), then B ("Create b.txt", depends on A unless the
// epic says PARALLEL), finish_round. FAIL-GATE in the epic is passed on to B's spec. Later rounds: list_children; anything
// open → finish_round; a failed child without a follow-up → create "Follow-up: <its title>", finish_round; else complete_epic
// (a refusal by the epic gate → create "Fix: create fix.txt", finish_round).
function plannerScript(task: string) {
  const epic = task.slice(task.indexOf("# Epic"), task.indexOf("# Children"));
  const usage = { input: 100, output: 20, cache_read: 10, cache_write: 0 };
  const first = task.includes("# Children\n\n(none yet)");
  if (first && epic.includes("SPLIT-ME"))
    return fakeProvider([
      [say("Splitting the failed ticket into two small parts, each with its own gate."), use("p1", "create_ticket", { title: "Create part1.txt", spec: "Create part1.txt at the repository root containing `part1`.", test_command: "test -f part1.txt" })],
      [use("p2", "create_ticket", { title: "Create part2.txt", spec: "Create part2.txt at the repository root containing `part2`.", test_command: "test -f part2.txt" })],
      [use("p3", "finish_round", { notes: "Split into part1.txt and part2.txt. Next: complete the epic once both are done." })],
    ], usage).provider;
  if (first && epic.includes("EPIC-GATE-FAIL"))
    return fakeProvider([
      [use("p1", "create_ticket", { title: "Create a.txt", spec: "Create a.txt at the repository root containing `a`.", test_command: "test -f a.txt" })],
      [use("p2", "finish_round", { notes: "Created a.txt. Next: complete the epic." })],
    ], usage).provider;
  if (first)
    return fakeProvider([
      [say("Reading the repository before planning."), use("p1", "read_file", { path: "README.md" })],
      [use("p2", "create_ticket", { title: "Create a.txt", spec: `Create the file a.txt at the repository root containing the line \`a\`.\n\nAcceptance: the test gate passes.${epic.includes("SPLIT-CHILD") ? "\n\nSPLIT-ME" : ""}` })],
      (req) => [
        use("p3", "create_ticket", {
          title: "Create b.txt", spec: `Create the file b.txt at the repository root containing the line \`b\`.\n\nAcceptance: the test gate passes.${epic.includes("FAIL-GATE") ? "\n\nFAIL-GATE" : ""}`,
          ...(epic.includes("PARALLEL") ? {} : { depends_on: [/Created (\S+?)[ .]/.exec(lastResult(req))?.[1]] }),
        }),
      ],
      [use("p4", "finish_round", { notes: "Created a.txt and b.txt tickets. Next: read their handoffs, then complete the epic." })],
    ], usage).provider;
  // decide reads the latest list_children; a finish_round refused because children settled meanwhile lists again.
  const decide = (id: string) => (req: ProviderRequest) => {
    if (lastResult(req).startsWith("Created ")) return [use(id, "finish_round", { notes: "Created a ticket that fixes the epic gate." })];
    const kids = [...lastResult(req).matchAll(/^## (\S+) (.+?) — (\S+)/gm)].map(([, key, title, state]) => ({ key, title, state }));
    if (kids.some((k) => !["done", "failed", "blocked", "split"].includes(k.state))) return [use(id, "finish_round", { notes: "Waiting for the open children." })];
    const failed = kids.find((k) => k.state === "failed");
    if (failed && !kids.some((k) => k.title.startsWith("Follow-up")))
      return [say(`${failed.key} failed; creating a follow-up.`), use(id, "create_ticket", { title: `Follow-up: ${failed.title}`, spec: `${failed.title} at the repository root. The earlier ticket ${failed.key} failed the gate.` })];
    const done = kids.filter((k) => k.state === "done").map((k) => `${k.key} ${k.title}`);
    return [use(id, "complete_epic", { summary: `Done: ${done.join("; ")}.${failed ? ` ${failed.key} failed and was replaced by a follow-up.` : ""}` })];
  };
  const relist = (id: string) => (req: ProviderRequest) =>
    lastResult(req).includes("The epic gate failed")
      ? [say("The epic gate failed; creating a fix."), use(id, "create_ticket", { title: "Fix: create fix.txt", spec: "Create fix.txt at the repository root so the epic gate passes." })]
      : lastResult(req).includes("no child ticket is open")
      ? [use(id, "list_children", {})]
      : [use(id, "finish_round", { notes: "Created a follow-up for the failed ticket." })];
  return fakeProvider([[say("Checking the children."), use("p1", "list_children", {})], decide("p2"), relist("p3"), decide("p4")], usage).provider;
}

// Round 1 (no fixed.txt yet) of a REVIEW-ONCE ticket requests changes; anything else is approved. REVIEW-WRITES: the
// reviewer also writes files (which the harness must undo).
function reviewScript(task: string) {
  return fakeProvider([
    [say("Inspecting the change."), use("r1", "shell", { command: `${task.includes("REVIEW-WRITES") ? "echo junk > reviewer.txt; echo tampered > notes.txt; " : ""}git status --short` })],
    (req) =>
      task.includes("REVIEW-ONCE") && !lastResult(req).includes("fixed.txt")
        ? [use("r2", "submit_review", { verdict: "request_changes", findings: [{ file: "notes.txt", line: 1, problem: "The demo reviewer wants a fixed.txt.", fix: "Create fixed.txt." }] })]
        : [use("r2", "submit_review", { verdict: "approve", findings: [] })],
  ], { input: 60, output: 10, cache_read: 5, cache_write: 0 }).provider;
}

function fixScript(task: string) {
  // REVIEW-FIX-STALL: the review fix round never finishes (it runs out of turns), like GATE-FIX-STALL.
  if (task.slice(task.lastIndexOf("# Task")).includes("REVIEW-FIX-STALL")) return fakeProvider(Array.from({ length: 130 }, (_, i) => [use(`s${i}`, "shell", { command: `echo ${i}` })]), { input: 100, output: 20, cache_read: 10, cache_write: 0 }).provider;
  return fakeProvider([
    [say("Fixing the review findings."), use("f1", "edit_file", { path: "fixed.txt", old_string: "", new_string: "fixed\n" })],
    [say("Created fixed.txt.")],
  ], { input: 100, output: 20, cache_read: 10, cache_write: 0 }).provider;
}

function gateFixScript(task: string) {
  const once = task.slice(task.lastIndexOf("# Task")).includes("GATE-FIX-ONCE");
  const usage = { input: 100, output: 20, cache_read: 10, cache_write: 0 };
  // GATE-FIX-STALL: the fix round never finishes (it runs out of turns), so the attempt falls back to a fresh retry.
  if (task.slice(task.lastIndexOf("# Task")).includes("GATE-FIX-STALL")) return fakeProvider(Array.from({ length: 130 }, (_, i) => [use(`s${i}`, "shell", { command: `echo ${i}` })]), usage).provider;
  if (!once) // changes nothing and repeats its earlier final reply, so a handoff still reads the same
    return fakeProvider([(req) => [say(req.messages.findLast((m) => m.role === "assistant" && m.content.some((b) => b.type === "text") && !m.content.some((b) => b.type === "tool_use"))?.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n") ?? "Done.")]], usage).provider;
  return fakeProvider([[say("Fixing the failing tests."), use("g1", "edit_file", { path: "ok.txt", old_string: "", new_string: "ok\n" })], [say("Created ok.txt.")]], usage).provider;
}

// Creates the first *.txt file its ticket names and ends with a handoff. FAIL-GATE in the ticket: it also writes
// tests/broken.txt (a protected path), so every attempt fails the gate.
function childScript(ticket: string) {
  const file = /(\w[\w-]*\.txt)/.exec(ticket)?.[1] ?? "notes.txt";
  return fakeProvider([
    [
      say(`Creating ${file}.`),
      use("1", "edit_file", { path: file, old_string: "", new_string: `${file.slice(0, -4)}\n` }),
      ...(/FAIL-GATE|SPLIT-ME/.test(ticket) ? [use("1b", "shell", { command: "mkdir -p tests && echo broken > tests/broken.txt" })] : []),
    ],
    [say(`Created ${file}.\n\n## Handoff\n- Results: created ${file} at the repository root.\n- Concerns: none.\n- Findings: nothing else in the repository needed to change.`)],
  ], { input: 100, output: 20, cache_read: 10, cache_write: 0 }).provider;
}

function wikiScript(task: string) {
  const sha = /Commit for `verified`: (\w+)/.exec(task)![1];
  const day = /today is (\S+)/.exec(task)![1];
  const op = /# Task: (build|re-verify)/.exec(task)![1];
  const files = op === "build" ? ["README.md"] : [];
  const page = op === "build" ? "overview.md" : /^- (\S+) — changed/m.exec(task)![1];
  const title = "Overview";
  const usage = { input: 80, output: 15, cache_read: 5, cache_write: 0 };
  const line = (req: ProviderRequest, key: string) => new RegExp(`^\\d+\t(${key}: .*)$`, "m").exec(lastResult(req))?.[1] ?? `${key}: `;
  const first = [say("Reading the index."), use("w1", "read_file", { path: "wiki/index.md" })];
  // WIKI-BAD / WIKI-FIXME in the index: a page without frontmatter and not in the index; the fix rounds leave it (BAD) or repair it (FIXME).
  const bad = /WIKI-(BAD|FIXME)/.exec(task)?.[1];
  if (bad) {
    const page = { path: "wiki/modules/bad.md", old_string: "no frontmatter\n" };
    return fakeProvider([
      [say("Writing a page."), use("b1", "edit_file", { ...page, old_string: "", new_string: page.old_string })],
      [say("Done.")],
      bad === "BAD" ? [say("Still broken.")] : [
        use("b2", "edit_file", { ...page, new_string: `---\ntitle: Bad\nsources: []\nverified: ${sha}\nupdated: ${day}\n---\nfixed\n` }),
        use("b3", "edit_file", { path: "wiki/index.md", old_string: "# Index\n", new_string: "# Index\n- [Bad](modules/bad.md) — fixed after the check\n" }),
      ],
      [say(bad === "BAD" ? "Still broken." : "Fixed.")],
    ], usage).provider;
  }
  if (!task.includes(`](${page})`) && op !== "re-verify")
    return fakeProvider([
      first,
      [
        use("w2", "edit_file", { path: `wiki/${page}`, old_string: "", new_string: `---\ntitle: ${title}\nsources: [${files.join(", ")}]\nverified: ${sha}\nupdated: ${day}\n---\nNotes written by the demo maintainer.\n` }),
        use("w3", "edit_file", { path: "wiki/index.md", old_string: "# Index\n", new_string: `# Index\n- [${title}](${page}) — written by the demo maintainer\n` }),
      ],
      [say(`Wrote ${page}.`)],
    ], usage).provider;
  return fakeProvider([
    first,
    [use("w2", "read_file", { path: `wiki/${page}` })],
    (req) => {
      const old = /\[(.*)\]/.exec(line(req, "sources"))?.[1] ?? "";
      const sources = [...new Set([...old.split(", ").filter(Boolean), ...files])];
      const edit = (id: string, key: string, now: string) => use(id, "edit_file", { path: `wiki/${page}`, old_string: line(req, key), new_string: `${key}: ${now}` });
      return [edit("w3", "sources", `[${sources.join(", ")}]`), edit("w4", "verified", sha), edit("w5", "updated", day)];
    },
    [say(`Updated ${page}.`)],
  ], usage).provider;
}

// Reflection: the current lessons plus one bullet naming the ticket and its outcome (deduped).
// Proposal: the current prompt plus the ALWAYS-CREATE-OK marker, with a rationale.
function demoMeta(req: ProviderRequest): ProviderResponse {
  const msg = req.messages[0].content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const tag = (name: string) => new RegExp(`<${name}>\\n?([\\s\\S]*?)\\n?</${name}>`).exec(msg)?.[1] ?? "";
  let text: string;
  // Triage by a chat model (runs.ts TRIAGE_SYSTEM, "Score the ticket from 0 to 4"): "huge" in the ticket scores 3.4, "BAD-JSON" answers in prose, the rest 0.8.
  if (req.system.some((b) => b.type === "text" && b.text.includes("Score the ticket from 0 to 4")))
    text = msg.includes("BAD-JSON") ? "It is quite large." : JSON.stringify({ score: msg.includes("huge") ? 3.4 : 0.8, reason: "Demo triage." });
  else if (msg.includes("<current_prompt>"))
    text = `<rationale>Demo proposal: the failing evals check for ok.txt, so the prompt now tells the agent to always create it.</rationale>\n<prompt>\n${tag("current_prompt")}\nALWAYS-CREATE-OK\n</prompt>`;
  else {
    const old = tag("lessons").trim();
    const digest = tag("digest");
    const bullet = `- ${/^Ticket: (.*)$/m.exec(digest)?.[1]}: ${/^Final status: (\w+)/m.exec(digest)?.[1]}`;
    const lines = old && old !== "(none yet)" ? old.split("\n") : [];
    text = (lines.includes(bullet) ? lines : [...lines, bullet]).join("\n");
  }
  return { message: { role: "assistant", content: [{ type: "text", text }] }, usage: { input: 50, output: 10, cache_read: 0, cache_write: 0 }, stopReason: "end_turn" };
}

// Project memory (a request with submit_memory): one decision per REMEMBER line of the ticket.
function demoMemory(req: ProviderRequest): ProviderResponse {
  const msg = req.messages[0].content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const ticket = msg.slice(0, msg.indexOf("# Comments"));
  const supersedes = /SUPERSEDE: (memory\/\S+)/.exec(ticket)?.[1];
  const entries = [...ticket.matchAll(/REMEMBER: (.+)/g)].map((m) => ({ kind: "decision", title: m[1].trim(), body: "Recorded by the demo memory proposer.", ...(supersedes ? { supersedes } : {}) }));
  return { message: { role: "assistant", content: [use("mem1", "submit_memory", { entries })] }, usage: { input: 50, output: 10, cache_read: 0, cache_write: 0 }, stopReason: "tool_use" };
}

// M12 failure mining (a request with submit_mined_ticket): a repo verdict naming the dossier's class and count.
function demoMine(req: ProviderRequest): ProviderResponse {
  const msg = req.messages[0].content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const cls = /<class>(\w+)/.exec(msg)?.[1];
  const count = /<count>(.*)<\/count>/.exec(msg)?.[1];
  return {
    message: { role: "assistant", content: [use("m1", "submit_mined_ticket", { verdict: "repo", title: `Stop ${cls} failures`, spec: `Demo draft: change the repository so runs stop failing with ${cls} (${count}).`, confidence: 0.5 })] },
    usage: { input: 50, output: 10, cache_read: 0, cache_write: 0 }, stopReason: "tool_use",
  };
}

// PROT-* in a ticket: what the shell does to tests/ (add-only mode, POL-29). The test repo has tests/existing.txt; OWN edits a
// file the run itself added.
const PROTECTED_CHANGE: Record<string, string> = {
  ADD: "mkdir -p tests && echo new > tests/new.test.ts",
  EDIT: "echo changed >> tests/existing.txt",
  DEL: "rm tests/existing.txt",
  MV: "mv tests/existing.txt tests/moved.txt",
  OWN: "mkdir -p tests && echo a > tests/own.txt && echo b >> tests/own.txt",
};

// The scripted turns. ok: also create ok.txt; why says so in the first turn's text.
function script(task: string, ok: boolean, why: string, model: string) {
  const ticket = task.includes("# Task") ? task.slice(task.lastIndexOf("# Task")) : task;
  if (ticket.includes("STRONG-ONLY")) ok = model.endsWith("strong"); // only a model named *strong creates ok.txt (escalation tests)
  if (task.includes('"## Handoff"')) return childScript(ticket);
  if (ticket.includes("STUCK-LOOP") && !task.includes("Previous attempt"))
    return fakeProvider(Array.from({ length: 30 }, (_, i) => [use(`s${i}`, "read_file", { path: "README.md" })]), { input: 100, output: 20, cache_read: 10, cache_write: 0 }).provider;
  const compact = /\bcompact\b/i.test(ticket);
  return fakeProvider(
    compact
      ? [
          [{ type: "text", text: "Generating a large output." }, use("1", "shell", { command: "seq 1 4000" })],
          [
            { type: "text", text: "Writing notes." },
            use("2", "edit_file", { path: "notes.txt", old_string: "", new_string: "hello from the demo agent\n" }),
            ...(ok ? [use("2b", "edit_file", { path: "ok.txt", old_string: "", new_string: "ok\n" })] : []),
          ],
          [{ type: "text", text: "Summary: printed the numbers 1 to 4000 (output saved to a file) and wrote notes.txt. Left: list the directory and report." }],
          [use("3", "shell", { command: "ls" })],
          [{ type: "text", text: "Compacted once; notes.txt is written." }],
        ]
      : /\bslow\b/i.test(ticket)
      ? [
          [{ type: "text", text: "This will take a while." }, use("1", "shell", { command: "sleep 30" })],
          [{ type: "text", text: "Done sleeping." }],
        ]
      : [
          [
            { type: "text", text: ok ? `Creating a notes file and ok.txt (${why}).` : "Creating a notes file." },
            use("1", "edit_file", { path: "notes.txt", old_string: "", new_string: "hello from the demo agent\n" }),
            ...(ok ? [use("1b", "edit_file", { path: "ok.txt", old_string: "", new_string: "ok\n" })] : []),
            ...(ticket.includes("SPLIT-ME") ? [use("1c", "shell", { command: "mkdir -p tests && echo broken > tests/broken.txt" })] : []),
            ...(PROTECTED_CHANGE[/PROT-(ADD|EDIT|DEL|MV|OWN)/.exec(ticket)?.[1] ?? ""] ? [use("1e", "shell", { command: PROTECTED_CHANGE[/PROT-(ADD|EDIT|DEL|MV|OWN)/.exec(ticket)![1]] })] : []),
            ...(ticket.includes("WIKI-WRITE") ? [use("1d", "shell", { command: "echo tampered > .polaris/wiki/x" })] : []),
          ],
          [use("2", "shell", { command: "ls" })],
          [use("3", "read_file", { path: "notes.txt" })],
          [{ type: "text", text: `Wrote notes.txt, listed the directory and read it back.${ticket.includes("WIKI-NOTES") ? "\n\n## Wiki notes\n- notes.txt is written by the demo agent." : ""}` }],
        ],
    compact
      ? (req) => ({ input: 100 * req.messages.length, output: 20, cache_read: 300 * req.messages.length, cache_write: 0 })
      : { input: 100, output: 20, cache_read: 10, cache_write: 0 },
  ).provider;
}

export function demoProvider(task: string, delayMs = 400): Provider {
  let scripted: Provider | undefined; // built on the first request: it depends on the system prompt
  return {
    async stream(req, onEvent) {
      if (!req.tools.length) return demoMeta(req);
      if (req.tools.some((t) => t.name === "submit_mined_ticket")) return demoMine(req);
      if (req.tools.some((t) => t.name === "submit_memory")) return demoMemory(req);
      const retry = /Previous attempt (failed|was stopped)/.test(task);
      const always = req.system.some((b) => b.type === "text" && b.text.includes("ALWAYS-CREATE-OK"));
      const resumed = req.messages.at(-1)!.content.some((b) => b.type === "text" && b.text.startsWith("# Model review"));
      const gateFix = req.messages.at(-1)!.content.some((b) => b.type === "text" && b.text.startsWith("# Tests failed"));
      scripted ??= req.tools.some((t) => t.name === "propose_ticket") ? chatScript : req.system.some((b) => b.type === "text" && b.text.startsWith("You maintain a project wiki")) ? wikiScript(task) : req.tools.some((t) => t.name === "create_ticket") ? plannerScript(task) : req.tools.some((t) => t.name === "submit_review") ? reviewScript(task) : resumed ? fixScript(task) : gateFix ? gateFixScript(task) : script(task, retry || always, retry ? "the previous attempt failed" : "the system prompt says so", req.model);
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delayMs);
        req.signal?.addEventListener("abort", () => (clearTimeout(t), resolve(0)), { once: true });
      });
      if (req.signal?.aborted) throw new Error("aborted");
      return scripted.stream(req, onEvent);
    },
  };
}
