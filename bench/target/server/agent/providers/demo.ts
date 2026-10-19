import type { Provider, ProviderRequest, ProviderResponse, TextBlock, ToolUseBlock } from "../types.ts";
import { fakeProvider } from "./fake.ts";

// HARNESS_PROVIDER=fake: deterministic demo run with a delay per turn so streaming is visible.
// Tasks containing "slow" run `sleep 30` instead, so cancel can be tested. 4 turns, usage 100/20/10/0 each.
// Tasks containing "compact" run a long session instead: a 4000-line shell output (spilled to a file), an edit, then usage
// that grows with the conversation (400 tokens per message, 75% cached) so a small compaction threshold triggers a
// compaction after turn 2 and a fresh conversation finishes the work.
// Retries (task contains "Previous attempt failed") also create ok.txt, so a `test -f ok.txt` gate fails attempt 1 only.
// So does a system prompt containing ALWAYS-CREATE-OK (M6: eval scores differ between prompt versions).
// "slow"/"compact" are matched in the ticket part only (after "# Task"), so lessons naming such a ticket don't leak.
// Requests without tools are M6 meta calls (reflection, prompt proposal), answered at once by demoMeta.
// M7: requests with create_ticket are planner rounds (plannerScript); a task asking for a "## Handoff" is a child of an epic
// (childScript).
const use = (id: string, name: string, input: Record<string, unknown>): ToolUseBlock => ({ type: "tool_use", id, name, input });
const say = (text: string): TextBlock => ({ type: "text", text });
const lastResult = (req: ProviderRequest) => req.messages.at(-1)!.content.flatMap((b) => (b.type === "tool_result" ? [b.content] : [])).join("\n");

// Round 1 (no children yet): read README.md, create A ("Create a.txt"), then B ("Create b.txt", depends on A unless the
// epic says PARALLEL), finish_round. FAIL-GATE in the epic is passed on to B's spec. Later rounds: list_children; anything
// open → finish_round; a failed child without a follow-up → create "Follow-up: <its title>", finish_round; else complete_epic.
function plannerScript(task: string) {
  const epic = task.slice(task.indexOf("# Epic"), task.indexOf("# Children"));
  const usage = { input: 100, output: 20, cache_read: 10, cache_write: 0 };
  if (task.includes("# Children\n\n(none yet)"))
    return fakeProvider([
      [say("Reading the repository before planning."), use("p1", "read_file", { path: "README.md" })],
      [use("p2", "create_ticket", { title: "Create a.txt", spec: "Create the file a.txt at the repository root containing the line `a`.\n\nAcceptance: the test gate passes." })],
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
    const kids = [...lastResult(req).matchAll(/^## (\S+) (.+?) — (\S+)/gm)].map(([, key, title, state]) => ({ key, title, state }));
    if (kids.some((k) => !["done", "failed", "blocked"].includes(k.state))) return [use(id, "finish_round", { notes: "Waiting for the open children." })];
    const failed = kids.find((k) => k.state === "failed");
    if (failed && !kids.some((k) => k.title.startsWith("Follow-up")))
      return [say(`${failed.key} failed; creating a follow-up.`), use(id, "create_ticket", { title: `Follow-up: ${failed.title}`, spec: `${failed.title} at the repository root. The earlier ticket ${failed.key} failed the gate.` })];
    const done = kids.filter((k) => k.state === "done").map((k) => `${k.key} ${k.title}`);
    return [use(id, "complete_epic", { summary: `Done: ${done.join("; ")}.${failed ? ` ${failed.key} failed and was replaced by a follow-up.` : ""}` })];
  };
  const relist = (id: string) => (req: ProviderRequest) =>
    lastResult(req).includes("no child ticket is open") ? [use(id, "list_children", {})] : [use(id, "finish_round", { notes: "Created a follow-up for the failed ticket." })];
  return fakeProvider([[say("Checking the children."), use("p1", "list_children", {})], decide("p2"), relist("p3"), decide("p4")], usage).provider;
}

// Creates the first *.txt file its ticket names and ends with a handoff. FAIL-GATE in the ticket: it also writes
// tests/broken.txt (a protected path), so every attempt fails the gate.
function childScript(ticket: string) {
  const file = /(\w[\w-]*\.txt)/.exec(ticket)?.[1] ?? "notes.txt";
  return fakeProvider([
    [
      say(`Creating ${file}.`),
      use("1", "edit_file", { path: file, old_string: "", new_string: `${file.slice(0, -4)}\n` }),
      ...(ticket.includes("FAIL-GATE") ? [use("1b", "shell", { command: "mkdir -p tests && echo broken > tests/broken.txt" })] : []),
    ],
    [say(`Created ${file}.\n\n## Handoff\n- Results: created ${file} at the repository root.\n- Concerns: none.\n- Findings: nothing else in the repository needed to change.`)],
  ], { input: 100, output: 20, cache_read: 10, cache_write: 0 }).provider;
}

// Reflection: the current lessons plus one bullet naming the ticket and its outcome (deduped).
// Proposal: the current prompt plus the ALWAYS-CREATE-OK marker, with a rationale.
export function demoMeta(req: ProviderRequest): ProviderResponse {
  const msg = req.messages[0].content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const tag = (name: string) => new RegExp(`<${name}>\\n?([\\s\\S]*?)\\n?</${name}>`).exec(msg)?.[1] ?? "";
  let text: string;
  if (msg.includes("<current_prompt>"))
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

// The scripted turns. ok: also create ok.txt; why says so in the first turn's text.
function script(task: string, ok: boolean, why: string) {
  const ticket = task.includes("# Task") ? task.slice(task.lastIndexOf("# Task")) : task;
  if (task.includes('"## Handoff"')) return childScript(ticket);
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
          ],
          [use("2", "shell", { command: "ls" })],
          [use("3", "read_file", { path: "notes.txt" })],
          [{ type: "text", text: "Wrote notes.txt, listed the directory and read it back." }],
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
      const retry = task.includes("Previous attempt failed");
      const always = req.system.some((b) => b.type === "text" && b.text.includes("ALWAYS-CREATE-OK"));
      scripted ??= req.tools.some((t) => t.name === "create_ticket") ? plannerScript(task) : script(task, retry || always, retry ? "the previous attempt failed" : "the system prompt says so");
      await new Promise((resolve) => {
        const t = setTimeout(resolve, delayMs);
        req.signal?.addEventListener("abort", () => (clearTimeout(t), resolve(0)), { once: true });
      });
      if (req.signal?.aborted) throw new Error("aborted");
      return scripted.stream(req, onEvent);
    },
  };
}
