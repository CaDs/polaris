import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "./Filters.tsx";
import { Alert, COLUMNS, Confirm, Dialog, Icon, ModelPicker, StatusIcon, api, cost, duration, fmt, hitRate, useProviders, useWorkspaceEvents, waiting, type Child, type Run, type RunMetrics, type Status, type Ticket, type TokenSummary } from "./ui.tsx";

// spent (epics): what its spending caps measure, the whole tree's runs incl. cached tokens.
type Detail = Ticket & { usage?: TokenSummary; background_usage?: TokenSummary; runs: Run[]; children?: Child[]; cap_usd: number | null; cap_tokens: number | null; spent?: { usd: number; tokens: number } };
type Ev = { seq: number; type: string; payload: any; created_at?: number };
// A running model call's output, sent live and never stored (server/agent/events.ts liveStream).
type LivePart = { kind: "text" | "reasoning"; text: string } | { kind: "tool"; id: string; name: string };

export function TicketView({ ticket, reload, close, open }: { ticket: Ticket; reload: () => void; close: () => void; open: (key: string) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [title, setTitle] = useState(ticket.title);
  const [spec, setSpec] = useState(ticket.spec);
  const [testCommand, setTestCommand] = useState(ticket.test_command ?? "");
  const [projectTest, setProjectTest] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState<Run | null>(null);
  const [validating, setValidating] = useState(false);
  const [providers] = useProviders();

  const load = () => api<Detail>(`/api/tickets/${ticket.id}`).then(setDetail, () => {});
  useEffect(() => {
    setTitle(ticket.title);
    setSpec(ticket.spec);
    setTestCommand(ticket.test_command ?? "");
    setSelected(null);
  }, [ticket.id]);
  useEffect(() => void api<{ test_command: string }>(`/api/projects/${ticket.project_id}`).then((p) => setProjectTest(p.test_command), () => {}), [ticket.project_id]);
  useEffect(() => void load(), [ticket.id, ticket.status, ticket.run_count, ticket.tokens_out, ticket.run_status]);
  // What changes while the ticket itself does not (an epic's children, a wiki run after approval) pings the workspace stream.
  useWorkspaceEvents("ticket", useCallback(() => void load(), [ticket.id]));

  async function patch(body: object) {
    setError("");
    try {
      await api(`/api/tickets/${ticket.id}`, "PATCH", body);
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const dirty = testCommand.trim() !== (ticket.test_command ?? "");
  const save = () => {
    if (title.trim() && (title.trim() !== ticket.title || spec !== ticket.spec || dirty)) patch({ title, spec, test_command: testCommand.trim() || null });
    else setTitle(ticket.title);
  };

  async function run(choice?: { provider_id: string | null; model: string | null }) {
    setError("");
    try {
      await api<Run>(`/api/tickets/${ticket.id}/runs`, "POST", choice);
      setSelected(null); // follow the latest run, including automatic retries
      reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    try {
      await api(`/api/tickets/${ticket.id}`, "DELETE");
      reload();
      close();
    } catch (e) {
      setConfirming(false);
      setError((e as Error).message);
    }
  }

  // M6: an approved ticket becomes an eval case, if its test command fails at the run's base commit (checked server-side).
  async function addToEvals() {
    setError("");
    setValidating(true);
    try {
      await api("/api/evals/cases", "POST", { ticket_id: ticket.id });
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setValidating(false);
    }
  }

  const runs = detail?.runs ?? [];
  const current = runs.find((r) => r.id === selected) ?? runs.findLast((r) => r.role !== "wiki") ?? runs.at(-1); // M10: a wiki ingest after approval is listed, not the default
  const running = ticket.status === "running";
  const epic = ticket.kind === "epic";
  const link = (key: string) => <button className="link mono" onClick={() => open(key)}>{key}</button>;

  return (
    <div className="ticket-view">
      <div className="crumbs muted">
        <button className="link" onClick={close}>Board</button> /{" "}
        {ticket.parent_key && <>{link(ticket.parent_key)} /{" "}</>}
        <span className="mono">{ticket.key}</span>
        {epic && <span className="badge epic">Epic</span>}
      </div>
      {/* A textarea so a long title wraps instead of clipping; it stays one line of text (Enter saves). */}
      <textarea className="h-input" aria-label="Title" rows={1} value={title} onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))} onBlur={save} maxLength={200}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), e.currentTarget.blur())} />
      <div className="row">
        {waiting(ticket) && <span className="muted" role="status">waiting for children</span>}
        {ticket.escalated_key && <span className="muted">Escalated to {link(ticket.escalated_key)}</span>}
        {ticket.split_from_key && <span className="muted">Split from {link(ticket.split_from_key)}</span>}
        {ticket.mined_class && <span className="badge" title="Drafted by failure mining (Learning page)">mined from {ticket.mined_class}</span>}
        <span className="grow" />
        {providers && <ModelPicker providers={providers} provider_id={ticket.provider_id} model={ticket.model} onChange={patch} />}
        {ticket.status === "done" && !epic &&
          (ticket.eval_case_id ? <span className="badge">In evals</span> : (
            <button className="btn" onClick={addToEvals} disabled={validating}>{validating ? "Validating…" : "Add to evals"}</button>
          ))}
        <button className="btn primary" onClick={() => run()} disabled={running}>{epic ? "Run planner" : "Run agent"}</button>
        {/* Destructive actions live behind the overflow menu, away from Run agent. */}
        <span className="menu-anchor end">
          <button className="btn icon-btn" aria-label="More actions" aria-expanded={menu} onClick={() => setMenu((m) => !m)}><Icon name="more" /></button>
          {menu && (
            <Popover close={() => setMenu(false)}>
              <button className="item danger" onClick={() => (setMenu(false), setConfirming(true))}>Delete ticket</button>
            </Popover>
          )}
        </span>
      </div>
      <Alert error={error} />
      {/* Wide screens: the ticket on the left, its work (review, runs, the live transcript) beside it, not below. */}
      <div className="ticket-body">
      <div className="ticket-about">
      <textarea className="spec" aria-label="Spec" placeholder="Describe what the agent should do…" rows={5} value={spec} onChange={(e) => setSpec(e.target.value)} onBlur={save} />
      <label>
        Test command <input aria-label="Test command" className="mono" value={testCommand} placeholder={projectTest} spellCheck={false} onChange={(e) => setTestCommand(e.target.value)} onBlur={save} />
        <span className="hint">Overrides the project's for this ticket; empty = project default. Runs: <span className="mono">{testCommand.trim() || projectTest || "(no test command)"}</span></span>
      </label>
      <div className="row">
        <button className="btn" onClick={save} disabled={title.trim() === ticket.title && spec === ticket.spec && !dirty}>Save</button>
      </div>
      <Comments ticketId={ticket.id} />
      {epic && detail?.children && <Epic ticket={ticket} detail={detail} items={detail.children} open={open} patch={(b) => patch(b).then(load)} />}
      </div>
      <div className="ticket-work">
      {ticket.status === "review" && <Review ticket={ticket} reload={reload} />}

      {detail?.usage && <p className="muted" aria-label="Ticket token usage">{fmt(detail.usage.tokens_total)} total processed tokens · {fmt(detail.background_usage?.tokens_total ?? 0)} background{epic && " · includes descendants"}. Input {fmt(detail.usage.input_uncached)} · output {fmt(detail.usage.tokens_out)} · cache read {fmt(detail.usage.tokens_cached)} · cache write {fmt(detail.usage.tokens_cache_write)}{(detail.usage.partial > 0 || detail.usage.unavailable > 0) && " · some request usage is incomplete"}</p>}
      <h3>{epic ? "Planner rounds" : "Runs"}</h3>
      {runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="runs">
            <thead>
              <tr><th>{epic ? "Round" : "Attempt"}</th><th>Model</th><th>Status</th><th>Tokens</th><th>Cache hit</th><th>Cost</th><th>Time</th><th>Turns</th><th></th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={r.id === current?.id ? "sel" : ""}>
                  <td><button className="link" onClick={() => setSelected(r.id)} aria-label={r.role === "wiki" ? "Show wiki run" : `Show run #${r.attempt}`}>{r.role === "wiki" ? "wiki" : `#${r.attempt}`}</button></td>
                  <td className="mono">{r.model}</td>
                  <td><StatusIcon status={r.status === "passed" ? "review" : r.status === "cancelled" ? "todo" : r.status} /> {r.status}</td>
                  {/* The split (input, output, cache read/write) is the hover title and the transcript header: the table stays scannable. */}
                  <td title={`input ${fmt(r.usage?.input_uncached ?? r.tokens_in)} · output ${fmt(r.usage?.tokens_out ?? r.tokens_out)} · cache read ${fmt(r.usage?.tokens_cached ?? r.tokens_cached)} · cache write ${fmt(r.usage?.tokens_cache_write ?? r.tokens_cache_write ?? 0)}`}>
                    {fmt(r.usage?.tokens_total ?? r.tokens_in + r.tokens_out + r.tokens_cached)}{r.usage && (r.usage.partial > 0 || r.usage.unavailable > 0) && <span title="Some request usage is partial or unavailable"> *</span>}
                  </td><td>{hitRate(r.usage?.tokens_in ?? r.tokens_in, r.usage?.tokens_cached ?? r.tokens_cached)}</td>
                  <td>{r.usage ? <>{r.usage.subscription_calls > 0 && "ChatGPT plan · "}{r.usage.local_calls > 0 && "Local · "}{cost(r.cost_usd)}{r.usage.unknown_price > 0 && " (price unknown)"}</> : cost(r.cost_usd, r.auth_type)}</td><td>{duration(r)}</td>
                  {/* ponytail: the full line is the hover title, so the table stays narrow at phone width */}
                  <td title={r.metrics ? metricsLine(r.metrics, r) : undefined}>
                    {r.metrics ? <>{plural(r.metrics.turns, "turn")} · {r.metrics.tool_errors} err{r.metrics.stuck && <span className="warn-text"> · stuck</span>}</> : "—"}
                  </td>
                  <td>{!epic && r.role !== "wiki" && r.status !== "queued" && r.status !== "running" && <button className="link nowrap" disabled={running} onClick={() => setRetrying(r)}>Retry with…</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* Keyed on the status too: an approve or reject lands on a finished run's log, so the transcript replays it. */}
      {current && <Transcript key={`${current.id}-${ticket.status}`} run={current} onFinish={() => (reload(), load())} />}
      </div>
      </div>

      {retrying && providers && (
        <RetryDialog run={retrying} providers={providers} close={() => setRetrying(null)} go={(c) => (setRetrying(null), run(c))} />
      )}
      {confirming && (
        <Confirm title="Delete ticket?" onConfirm={remove} onClose={() => setConfirming(false)}>
          {ticket.key} and all of its runs will be permanently deleted.
        </Confirm>
      )}
    </div>
  );
}

function RetryDialog({ run, providers, close, go }: {
  run: Run; providers: ReturnType<typeof useProviders>[0] & {}; close: () => void; go: (c: { provider_id: string | null; model: string | null }) => void;
}) {
  const [pick, setPick] = useState({ provider_id: run.provider_id, model: run.model as string | null });
  return (
    <Dialog title="Retry with…" onClose={close}>
      <p className="muted">Starts a new attempt from the ticket, with the provider and model chosen here.</p>
      <div className="row">
        <ModelPicker providers={providers} {...pick} onChange={setPick} />
      </div>
      <div className="row end">
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!pick.provider_id && !pick.model} onClick={() => go(pick)}>Retry</button>
      </div>
    </Dialog>
  );
}

// Mirrors gateFailure in server/improve.ts.
const gateFailure = (p: any) =>
  p.protected.length ? `modified protected path ${p.protected.join(", ")}` : p.nested ? `nested git repository ${p.nested.join(", ")}` :`\`${p.command}\` ${p.timed_out ? "timed out" : `exited with code ${p.code}`}`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const pct = (n: number | null) => (n === null ? "" : ` (${Math.round(n)}%)`);
// "34 turns (28%) · 41 tool calls · 2 errors · 3 repeated · first edit at turn 6 · 5 files · 12 min (20%)"; minutes from the run row.
const secs = (s: number) => (s < 60 ? `${s} s` : `${Math.round(s / 6) / 10} min`);
function metricsLine(m: RunMetrics, r: Run) {
  const min = r.started_at ? ((r.ended_at ?? Date.now()) - r.started_at) / 60_000 : null;
  return [
    plural(m.turns, "turn") + pct(m.turns_pct),
    plural(m.tool_calls, "tool call"),
    plural(m.tool_errors, "error"),
    `${m.repeated_calls} repeated`,
    m.first_edit_turn === null ? "no edits" : `first edit at turn ${m.first_edit_turn}`,
    m.files_changed !== null && plural(m.files_changed, "file"),
    min !== null && `${min < 1 ? "<1" : Math.round(min)} min${pct(m.minutes_pct)}`,
    m.model_secs !== undefined && `model ${secs(m.model_secs)} · tools ${secs(m.tool_secs ?? 0)} (shell ${secs(m.shell_secs ?? 0)})`,
    m.stuck && `stuck at turn ${m.stuck.turn}: ${m.stuck.signal}, ${m.stuck.action === "stop" ? "stopped" : "nudged"}`,
  ].filter(Boolean).join(" · ");
}

const compact = (input: Record<string, unknown>) => {
  const s = Object.entries(input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
};

// The run's first user message (environment, wiki index, lessons, task): in the DOM only while open.
function Prompt({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="result" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>First message <span className="muted">{text.length.toLocaleString()} chars</span></summary>
      {open && <pre>{text}</pre>}
    </details>
  );
}

// A model's reasoning: Anthropic and Ollama thinking, an OpenAI reasoning summary. Encrypted-only reasoning has no text.
const reasoningText = (b: any): string =>
  b.provider === "anthropic" ? b.data?.thinking ?? "" : b.provider === "openai" ? (b.data?.summary ?? []).map((s: any) => s.text).join("\n\n") : "";
function Thinking({ text }: { text: string }) {
  return (
    <details className="result thinking">
      <summary>Thinking <span className="muted">{text.trim().split("\n")[0].slice(0, 100)}</span></summary>
      <p className="msg">{text}</p>
    </details>
  );
}

// What a running run is doing now, from its latest event (usage and metrics are bookkeeping) and the live stream.
function activity(events: Ev[], live: LivePart[]): { text: ReactNode; title?: string; since?: number; limit?: number } {
  const last = events.findLast((e) => e.type !== "usage" && e.type !== "run_metrics");
  if (!events.some((e) => e.type === "run_started")) return { text: "Setting up…", since: last?.created_at };
  const p = last!.payload;
  if (last!.type === "tool_call")
    return p.name === "shell" && typeof p.input?.command === "string"
      ? { text: <>Running <span className="mono">{p.input.command}</span></>, title: p.input.command, since: last!.created_at, limit: typeof p.input.timeout === "number" ? p.input.timeout * 1000 : undefined }
      : { text: <>Running <span className="mono">{p.name}</span></>, since: last!.created_at };
  if (last!.type === "assistant_message" && !p.message.content.some((b: any) => b.type === "tool_use")) return { text: "Checking the change…", since: last!.created_at };
  const tail = live.at(-1);
  return { text: tail?.kind === "tool" ? <>Writing a call to <span className="mono">{tail.name}</span>…</> : tail?.kind === "text" ? "Writing…" : "Thinking…", since: last!.created_at };
}
const clock = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}`;

const modelTimeAnchors = new Set(["tool_result", "run_started", "gate_fix", "test_result", "model_review_started", "model_review", "compaction"]);
function runTimes(events: Ev[], until: number | undefined) {
  let model = 0, tools = 0, shell = 0;
  let anchor: number | undefined;
  const pending = new Map<string, { start: number; shell: boolean }>();
  for (const e of events) {
    if (e.created_at === undefined) continue;
    if (e.type === "assistant_message" && anchor !== undefined) model += Math.max(0, e.created_at - anchor);
    if (modelTimeAnchors.has(e.type)) anchor = e.created_at;
    if (e.type === "tool_call") pending.set(e.payload.id, { start: e.created_at, shell: e.payload.name === "shell" });
    if (e.type === "tool_result") {
      const call = pending.get(e.payload.tool_use_id);
      if (call) {
        const elapsed = Math.max(0, e.created_at - call.start);
        tools += elapsed;
        if (call.shell) shell += elapsed;
        pending.delete(e.payload.tool_use_id);
      }
    }
  }
  // An interrupted tool without a result stops at the run's end, never at the viewer's current time.
  if (until !== undefined) for (const call of pending.values()) {
    const elapsed = Math.max(0, until - call.start);
    tools += elapsed;
    if (call.shell) shell += elapsed;
  }
  return { model, tools, shell };
}
const timeSpent = (ms: number, omitMinutes = false) => ms < 60_000
  ? `${Math.round(ms / 1000)} s`
  : `${ms < 600_000 ? (ms / 60_000).toFixed(1) : Math.round(ms / 60_000)}${omitMinutes ? "" : " min"}`;

// The running run's status line, kept at the bottom of the viewport while its transcript is on screen; elapsed time ticks
// here (static text, no looping motion: DESIGN.md). Out of view of the latest, it offers a jump back.
function LiveBar({ run, events, live, unseen, atEnd, jump }: { run: Run; events: Ev[]; live: LivePart[]; unseen: number; atEnd: boolean; jump: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const a = run.status === "queued" && !events.length ? { text: "Queued, waiting for a free slot…" } : activity(events, live);
  const elapsed = a.since ? Math.max(0, now - a.since) : undefined;
  return (
    <div className="live-bar" role="status" aria-label="Run activity">
      <span className="grow ellipsis" title={a.title}>{a.text}</span>
      {elapsed !== undefined && <span className="muted mono nowrap">· {clock(elapsed)}{a.limit ? ` of ${clock(a.limit)}` : ""}</span>}
      {!atEnd && <button className="btn" onClick={jump}>Jump to latest{unseen > 0 && ` · ${unseen} new`}</button>}
    </div>
  );
}

export function Transcript({ run, onFinish }: { run: Run; onFinish: () => void }) {
  const [events, setEvents] = useState<Ev[]>([]);
  const [live, setLive] = useState<LivePart[]>([]);
  const [error, setError] = useState("");
  // Following: while the end of the transcript is in view, new output keeps it there. Scrolled up, the bar counts what
  // arrived since (replayed events are older than the page) and offers a jump back.
  const end = useRef<HTMLDivElement>(null);
  // Only the reader's own scrolling turns following on: opening a page (its transcript still short while the log replays)
  // doesn't carry them away from the ticket.
  const following = useRef(false);
  const [atEnd, setAtEnd] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const opened = useRef(Date.now());
  const jump = () => end.current?.scrollIntoView({ block: "end" });
  const inView = () => (end.current?.getBoundingClientRect().top ?? Infinity) <= innerHeight;
  useEffect(() => {
    const scrolled = () => {
      following.current = inView();
      setAtEnd(following.current);
      if (following.current) setUnseen(0);
    };
    addEventListener("scroll", scrolled, { passive: true });
    return () => removeEventListener("scroll", scrolled);
  }, []);
  useEffect(() => {
    if (following.current) end.current?.scrollIntoView({ block: "end" });
    else setAtEnd(inView());
  }, [events.length, live]);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${run.id}/events`);
    let done = false;
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.type === "live") {
        setLive((cur) => {
          const next = [...cur];
          for (const p of e.parts as LivePart[]) {
            const last = next.at(-1);
            if (p.kind !== "tool" && last?.kind === p.kind) next[next.length - 1] = { ...last, text: last.text + p.text };
            else next.push(p);
          }
          return next;
        });
        return;
      }
      if (e.type === "assistant_message" || e.type === "run_finished") setLive([]); // the stored turn replaces its live output
      if (!following.current && e.created_at > opened.current) setUnseen((n) => n + 1);
      setEvents((all) => (all.some((x) => x.seq === e.seq) ? all : [...all, e])); // reconnects replay; de-dupe by seq
      if (e.type === "run_finished") {
        done = true;
        onFinish();
      }
    };
    // After run_finished the server sends what was stored after it (a reflection on a reject), then closes: don't reconnect.
    es.onerror = () => done && es.close();
    return () => es.close();
  }, [run.id]);

  const projected = events.filter((e) => e.type === "usage").reduce(
    (a, e) => ({ input: a.input + e.payload.input, output: a.output + e.payload.output, cache_read: a.cache_read + e.payload.cache_read, cache_write: a.cache_write + e.payload.cache_write }),
    { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  );
  const usage = run.usage ?? { input_uncached: projected.input, tokens_in: projected.input + projected.cache_write, tokens_out: projected.output, tokens_cached: projected.cache_read,
    tokens_cache_write: projected.cache_write, tokens_total: projected.input + projected.output + projected.cache_read + projected.cache_write, partial: 0, unavailable: 0 };
  const finished = events.find((e) => e.type === "run_finished");
  const running = !finished && (run.status === "running" || run.status === "queued");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const times = runTimes(events, finished?.created_at ?? run.ended_at ?? (running ? now : undefined));
  const skills = events.find((e) => e.type === "setup" && e.payload.step === "skills")?.payload.skills as any[] | undefined;

  return (
    <section className="transcript" aria-label="Transcript">
      <div className="row">
        <h3 className="grow">
          {run.eval_run_id ? "Eval run" : run.role === "planner" ? `Planner round #${run.attempt}` : run.role === "wiki" ? "Wiki run" : `Run #${run.attempt}`} <span className="muted">{finished ? finished.payload.status : run.status}</span>
          {run.prompt_version && <span className="muted mono"> · prompt v{run.prompt_version}</span>}
        </h3>
        <span className="tokens mono" role="status" aria-label="Token usage">in {fmt(usage.input_uncached)} · out {fmt(usage.tokens_out)} · cached {fmt(usage.tokens_cached)} · cache write {fmt(usage.tokens_cache_write)} · total {fmt(usage.tokens_total)} · cache hit {hitRate(usage.tokens_in, usage.tokens_cached)}{(usage.partial > 0 || usage.unavailable > 0) && " · some usage partial/unavailable"}</span>
        <span className="tokens mono" role="status" aria-label="Run timing" title={`model ${(times.model / 1000).toFixed(1)} s · tools ${(times.tools / 1000).toFixed(1)} s (shell ${(times.shell / 1000).toFixed(1)} s)`}>
          model {timeSpent(times.model)} · tools {timeSpent(times.tools)} (shell {timeSpent(times.shell, times.tools >= 60_000)})
        </span>
        {!finished && (run.status === "running" || run.status === "queued") && (
          <button className="btn" onClick={() => api(`/api/runs/${run.id}/cancel`, "POST").catch((e) => setError(e.message))}>Cancel</button>
        )}
      </div>
      <Alert error={error} />
      {skills && (
        <p className="muted" aria-label="Skills offered">
          Skills offered: {skills.length ? skills.map((k: any) => <span key={k.path} className="mono" title={`${k.description} (${k.path})`}>{k.name} </span>) : "none"}
        </p>
      )}
      {events.map((e) => {
        const p = e.payload;
        if (e.type === "run_started") return <Prompt key={e.seq} text={p.task} />;
        if (e.type === "assistant_message")
          return p.message.content.map((b: any, i: number) =>
            b.type === "text" && b.text ? <p key={`${e.seq}-${i}`} className="msg model">{b.text}</p>
            : b.type === "reasoning" && reasoningText(b).trim() ? <Thinking key={`${e.seq}-${i}`} text={reasoningText(b)} />
            : null);
        if (e.type === "tool_call")
          return <div key={e.seq} className="call mono"><span className="name">{p.name}</span> {compact(p.input)}</div>;
        if (e.type === "tool_result")
          return (
            <details key={e.seq} className={`result${p.is_error ? " err" : ""}`}>
              <summary>{p.is_error ? `error${p.error_kind ? `: ${p.error_kind}` : ""}` : "result"} <span className="muted">{p.content.split("\n")[0].slice(0, 100)}</span></summary>
              <pre>{p.content}</pre>
            </details>
          );
        if (e.type === "setup" && p.step === "worktree")
          return p.branch
            ? <p key={e.seq} className="muted">Worktree on branch <span className="mono">{p.branch}</span> from <span className="mono">{p.base_sha.slice(0, 8)}</span></p>
            : run.role === "planner" || run.role === "wiki"
            ? <p key={e.seq} className="muted">Read-only checkout at <span className="mono">{p.base_sha.slice(0, 8)}</span></p>
            : <p key={e.seq} className="muted">Detached worktree at <span className="mono">{p.base_sha.slice(0, 8)}</span> (eval case)</p>;
        if (e.type === "setup" && p.step === "skills") return null; // shown in the header
        if (e.type === "setup" && p.step === "resumed")
          return <div key={e.seq} className="divider" role="separator">Resumed after a server restart: the interrupted run's {p.turns} turns and its worktree are kept</div>;
        if (e.type === "setup" && p.step === "sandbox") return <p key={e.seq} className="muted">Sandbox <span className="mono">{p.sandbox}</span> ready</p>;
        if (e.type === "setup" && p.step === "context")
          return <p key={e.seq} className="muted">Context window <span className="mono">{p.window.toLocaleString()}</span> tokens ({p.source}); compacts at <span className="mono">{p.compact_at.toLocaleString()}</span></p>;
        if (e.type === "setup")
          return (
            <details key={e.seq} className={`result${p.code === 0 ? "" : " err"}`}>
              <summary>setup <span className="mono">{p.command}</span> <span className="muted">exit {p.code ?? "killed"}</span></summary>
              <pre>{p.output || "(no output)"}</pre>
            </details>
          );
        if (e.type === "test_result")
          return (
            <details key={e.seq} className={`gate ${p.passed ? "ok" : "err"}`} open={!p.passed}>
              <summary>{p.passed ? (p.flaky ? "Tests passed on a re-run (flaky)" : "Tests passed") : `Tests failed: ${gateFailure(p)}`}</summary>
              {p.flaky && <pre>First run failed (exit {p.first_failure.timed_out ? "timeout" : p.first_failure.code}):{"\n"}{p.first_failure.output || "(no output)"}</pre>}
              <pre>{p.output || "(no output)"}</pre>
            </details>
          );
        if (e.type === "gate_fix") return <div key={e.seq} className="divider" role="separator">Tests failed — fixing in the same run</div>;
        if (e.type === "epic_gate")
          return (
            <details key={e.seq} className={`gate ${p.passed ? "ok" : "err"}`} open={!p.passed}>
              <summary>
                {p.passed ? "Epic gate passed" : `Epic gate failed (${p.timed_out ? "timed out" : `exit ${p.code}`}), complete_epic refused`}: <span className="mono">{p.command}</span> at{" "}
                <span className="mono">{p.sha.slice(0, 8)}</span>
              </summary>
              <pre>{p.output || "(no output)"}</pre>
            </details>
          );
        if (e.type === "triage")
          return (
            <p key={e.seq} className={p.error ? "warn" : "muted"}>
              Triage (<span className="mono">{p.model}</span>): {p.error ? `failed, ran directly (${p.error})` : `size ${p.score.toFixed(2)} of 4 → ${p.split ? "split into an epic" : "run directly"}`}
            </p>
          );
        if (e.type === "commit") return <p key={e.seq} className="muted">Committed <span className="mono">{p.sha.slice(0, 8)}</span> on <span className="mono">{p.branch}</span></p>;
        if (e.type === "compaction")
          return (
            <div key={e.seq} className="divider" role="separator">
              Context compacted (#{p.n}): {fmt(p.tokens_before)} tokens, {p.summary_chars} char summary · history in <span className="mono">{p.history_path}</span>
            </div>
          );
        if (e.type === "reflection")
          return "skipped" in p
            ? <p key={e.seq} className="muted">Reflection: skipped ({p.skipped === "provider_error" ? "a provider error" : "an environment failure"} teaches nothing about the work)</p>
            : "error" in p
            ? <p key={e.seq} className="warn">Reflection: {p.error}</p>
            : <p key={e.seq} className="muted">Reflection: lessons {p.unchanged ? "unchanged" : "updated"} (v{p.version}, {p.chars} chars)</p>;
        if (e.type === "handoff")
          return (
            <details key={e.seq} className="gate ok" open>
              <summary>Handoff to the planner</summary>
              <pre>{p.text}</pre>
            </details>
          );
        if (e.type === "round_finished")
          return (
            <div key={e.seq} className="note">
              <strong>{p.completed ? "Epic completed" : `Round ${p.round} finished`}</strong>
              <p className="msg">{p.notes}</p>
            </div>
          );
        if (e.type === "model_review_started")
          return (
            <div key={e.seq} className="divider" role="separator">
              Model review round {p.round} {p.model && p.model !== run.model && <>by <span className="mono">{p.model}</span> </>}
              {p.budget && <span className="muted">(budget {p.budget} turns for {p.lines} changed lines)</span>}
            </div>
          );
        if (e.type === "model_review")
          return (
            <div key={e.seq} className="note">
              <strong>{p.verdict === "approve" ? "Approved by model review" : p.verdict === "error" ? `Model review failed: ${p.message}` : "Model review requested changes"}</strong>
              {p.findings.length > 0 && (
                <ul>{p.findings.map((f: any, i: number) => <li key={i}><span className="mono">{f.file}{f.line ? `:${f.line}` : ""}</span> — {f.problem} → {f.fix}</li>)}</ul>
              )}
            </div>
          );
        if (e.type === "review")
          return p.decision === "approved"
            ? <div key={e.seq} className="note ok"><strong>Approved</strong>{p.merge_sha && <> · merged as <span className="mono">{p.merge_sha.slice(0, 8)}</span></>}</div>
            : <div key={e.seq} className="note err"><strong>Rejected</strong>{p.note && <p className="msg">{p.note}</p>}</div>;
        if (e.type === "wiki")
          return p.problems ? (
            <details key={e.seq} className="gate err" open>
              <summary>Wiki {p.op} rejected: {p.problems.length} problem{p.problems.length === 1 ? "" : "s"}, nothing committed</summary>
              <ul>{p.problems.map((x: string) => <li key={x}>{x}</li>)}</ul>
            </details>
          ) : <div key={e.seq} className="note ok"><strong>Wiki {p.op}</strong> · {p.commit ? <>committed <span className="mono">{p.commit.slice(0, 8)}</span></> : "nothing to change"}</div>;
        if (e.type === "error") return <p key={e.seq} className={p.retrying ? "warn" : "error"}>{p.kind}: {p.message}</p>;
        if (e.type === "stuck")
          return (
            <div key={e.seq} className={`note ${p.action === "stop" ? "err" : "warn"}`} role="note" aria-label="Stuck">
              <strong>Stuck at turn {p.turn}, {p.action === "stop" ? "stopped" : "nudged"}</strong> · <span className="mono">{p.signal}</span>
              <p className="msg">{p.detail}</p>
            </div>
          );
        if (e.type === "run_metrics") return <p key={e.seq} className="muted" aria-label="Run metrics">{metricsLine(p, run)}</p>;
        if (e.type === "run_finished") return <p key={e.seq} className="muted">Run {p.status}{p.reason && p.reason !== p.status ? ` (${p.reason})` : ""} after {p.turns} turns. Tokens: input {fmt(p.usage.input)}, output {fmt(p.usage.output)}, cache read/write {fmt(p.usage.cache_read)}/{fmt(p.usage.cache_write)}, total {fmt(p.usage.input + p.usage.output + p.usage.cache_read + p.usage.cache_write)}.</p>;
        return null;
      })}
      {!finished && live.map((p, i) =>
        p.kind === "tool" ? <div key={i} className="call mono"><span className="name">{p.name}</span> <span className="muted">…</span></div>
        : p.kind === "reasoning" ? <div key={i} className="thinking live" aria-label="Thinking"><span className="muted">Thinking</span><p className="msg">{p.text}</p></div>
        : <p key={i} className="msg model">{p.text}</p>)}
      {!finished && <LiveBar run={run} events={events} live={live} unseen={unseen} atEnd={atEnd} jump={jump} />}
      <div ref={end} /> {/* below the bar: scrolled to the end, the bar sits in place under the newest line, not over it */}
    </section>
  );
}

type DiffInfo = { branch: string; base_branch: string; diff: string };

// Review queue: diff of the latest passed run; approve merges it into the base branch, reject sends the ticket back to todo
// (a child of an epic: counts as failed for its planner). An epic has no diff: its children were merged one by one.
// Notes between people on a ticket (the agent does not read them; a reject note is how to steer it). Others' comments
// notify the bell; the list follows the workspace stream.
type Comment = { id: string; body: string; created_at: number; author: string };
function Comments({ ticketId }: { ticketId: string }) {
  const [list, setList] = useState<Comment[] | null>(null);
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => api<Comment[]>(`/api/tickets/${ticketId}/comments`).then(setList, (e) => setError(e.message)), [ticketId]);
  useEffect(() => void load(), [load]);
  useWorkspaceEvents("ticket", useCallback((c: { id: string }) => void (c.id === ticketId && load()), [ticketId, load]));
  async function post() {
    setError("");
    try {
      await api(`/api/tickets/${ticketId}/comments`, "POST", { body });
      setBody("");
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="comments" aria-label="Comments">
      <h3>Comments {list && list.length > 0 && <span className="muted">({list.length})</span>}</h3>
      {list?.map((c) => (
        <div key={c.id} className="comment">
          <div className="muted"><span title={c.author}>{c.author.split("@")[0]}</span> · {new Date(c.created_at).toLocaleString()}</div>
          <p>{c.body}</p>
        </div>
      ))}
      <Alert error={error} />
      <textarea aria-label="New comment" rows={2} placeholder="Leave a comment…" value={body} onChange={(e) => setBody(e.target.value)} />
      <div className="row end"><button className="btn" onClick={post} disabled={!body.trim()}>Comment</button></div>
    </section>
  );
}

function Review({ ticket, reload }: { ticket: Ticket; reload: () => void }) {
  const [d, setD] = useState<DiffInfo | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epic = ticket.kind === "epic";
  useEffect(() => void (!epic && api<DiffInfo>(`/api/tickets/${ticket.id}/diff`).then(setD, (e) => setError(e.message))), [ticket.id, ticket.run_count]);

  async function decide(action: "approve" | "reject", body?: object) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/tickets/${ticket.id}/${action}`, "POST", body);
      setRejecting(false);
      reload();
    } catch (e) {
      setRejecting(false);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="review" aria-label="Review">
      <div className="row">
        <h3 className="grow">Review {d && <span className="muted mono">{d.branch} → {d.base_branch}</span>}</h3>
        <button className="btn" onClick={() => setRejecting(true)} disabled={busy}>Reject</button>
        <button className="btn primary" onClick={() => decide("approve")} disabled={busy || (!epic && !d)}>Approve</button>
      </div>
      <Alert error={error} />
      {epic ? (
        <p className="muted">The planner completed this epic. Its children were merged one by one; approving marks the epic done.</p>
      ) : d ? <Diff text={d.diff} /> : !error && <p className="muted">Loading diff…</p>}
      {rejecting && (
        <Dialog title="Reject changes?" onClose={() => setRejecting(false)}>
          <form onSubmit={(e) => (e.preventDefault(), decide("reject", { note: new FormData(e.currentTarget).get("note") }))}>
            <p className="muted">
              {epic
                ? `${ticket.key} goes back to todo. The note is passed to its next planner round (Run planner).`
                : ticket.parent_key
                ? `The branch is deleted and ${ticket.key} counts as failed for the planner of ${ticket.parent_key}. The note is added to its handoff.`
                : `The branch is deleted and ${ticket.key} goes back to todo. The note is passed to the next run.`}
            </p>
            <label>
              Note <textarea name="note" rows={4} autoFocus />
            </label>
            <div className="row end">
              <button type="button" className="btn" onClick={() => setRejecting(false)}>Cancel</button>
              <button className="btn danger" disabled={busy}>Reject</button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}

// Unified diff split per file: header with the path, then hunks with +/- coloring.
function Diff({ text }: { text: string }) {
  const files: { name: string; lines: string[]; hunks: boolean }[] = [];
  for (const l of text.split("\n")) {
    if (l.startsWith("diff --git ")) files.push({ name: l.replace(/^diff --git a\/.* b\//, ""), lines: [], hunks: false });
    else if (files.length) {
      const f = files.at(-1)!;
      if (l.startsWith("@@")) f.hunks = true;
      if (f.hunks || l.startsWith("Binary files")) f.lines.push(l); // skip index/---/+++ headers
    }
  }
  if (!files.length) return <p className="muted">No changes.</p>;
  return (
    <div className="diff" aria-label="Diff">
      {files.map((f) => (
        <div key={f.name} className="diff-file">
          <div className="diff-head mono">{f.name}</div>
          <pre className="mono">
            {f.lines.map((l, i) => (
              <div key={i} className={l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined}>{l || " "}</div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

// Epic view: the summary (or why it failed), the whole tree of children with their state, dependencies and handoffs,
// and the tokens and cost of everything the epic spent (planner rounds + every descendant's runs).
// Its spending caps (empty = none) cover the same tree, cached tokens included: "spent $x of $y" once one is set.
function Epic({ ticket, detail, items, open, patch }: { ticket: Ticket; detail: Detail; items: Child[]; open: (key: string) => void; patch: (b: object) => void }) {
  const all = [ticket, ...items];
  const tokens = all.reduce((n, t) => n + t.tokens_in + t.tokens_out, 0);
  const usd = all.reduce((n, t) => n + t.cost_usd, 0);
  return (
    <section className="epic" aria-label="Epic">
      {ticket.handoff && (ticket.status === "failed"
        ? <p className="error" role="alert">Epic failed: {ticket.handoff}</p>
        : (
          <div className="summary" aria-label="Summary">
            <strong>Summary</strong>
            <p className="msg">{ticket.handoff}</p>
          </div>
        ))}
      <div className="row">
        <h3 className="grow">Children <span className="muted">{ticket.child_done}/{ticket.child_count} done</span></h3>
        <span className="tokens mono" aria-label="Epic usage">planner + children: {fmt(tokens)} tok · {cost(usd)}</span>
      </div>
      <div className="row" key={`${detail.cap_usd}-${detail.cap_tokens}`}>
        <label className="check">
          Cap $ <input aria-label="Epic cap (USD)" type="number" min={0} step="any" defaultValue={detail.cap_usd ?? ""} placeholder="none" style={{ width: 90 }} onBlur={(e) => e.target.value !== String(detail.cap_usd ?? "") && patch({ cap_usd: e.target.value })} />
        </label>
        <label className="check">
          Cap tokens <input aria-label="Epic cap (tokens)" type="number" min={0} step={1} defaultValue={detail.cap_tokens ?? ""} placeholder="none" style={{ width: 110 }} onBlur={(e) => e.target.value !== String(detail.cap_tokens ?? "") && patch({ cap_tokens: e.target.value })} />
        </label>
        {detail.spent && (detail.cap_usd !== null || detail.cap_tokens !== null) && (
          <span className={`mono${(detail.cap_usd !== null && detail.spent.usd >= detail.cap_usd) || (detail.cap_tokens !== null && detail.spent.tokens >= detail.cap_tokens) ? " error" : ""}`} aria-label="Epic cap">
            spent {[
              detail.cap_usd !== null && `$${detail.spent.usd.toFixed(2)} of $${detail.cap_usd.toFixed(2)}`,
              detail.cap_tokens !== null && `${fmt(detail.spent.tokens)} of ${fmt(detail.cap_tokens)} tokens`,
            ].filter(Boolean).join(" · ")}
          </span>
        )}
      </div>
      {items.length ? <Children parent={ticket.id} items={items} open={open} /> : <p className="muted">No children yet: the planner creates them in its first round.</p>}
    </section>
  );
}

function Children({ parent, items, open }: { parent: string; items: Child[]; open: (key: string) => void }) {
  return (
    <ul className="children" aria-label="Children">
      {items.filter((c) => c.parent_id === parent).map((c) => (
        <li key={c.id} aria-label={c.key}>
          <div className="child">
            <StatusIcon status={c.status} />
            <button className="link mono" onClick={() => open(c.key)}>{c.key}</button>
            <span className="grow">{c.title} {c.kind === "epic" && <span className="badge epic">Epic</span>}</span>
            {c.depends_keys.length > 0 && <span className="muted" title="Dependencies">← {c.depends_keys.join(", ")}</span>}
            <span className="muted">{c.label}</span>
            {c.test_command && <span className="mono muted" title="Test command">{c.test_command}</span>}
            {c.run_model && <span className="mono muted">{c.run_model}</span>}
            <span className="muted">{fmt(c.tokens_in + c.tokens_out)} tok</span>
          </div>
          {c.handoff && (
            <details className="result">
              <summary>{c.kind === "epic" ? "Summary" : "Handoff"} <span className="muted">{c.handoff.split("\n")[0].slice(0, 100)}</span></summary>
              <pre>{c.handoff}</pre>
            </details>
          )}
          {c.kind === "epic" && <Children parent={c.id} items={items} open={open} />}
        </li>
      ))}
    </ul>
  );
}
