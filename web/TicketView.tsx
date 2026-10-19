import { useEffect, useState } from "react";
import { Alert, COLUMNS, Confirm, Dialog, ModelPicker, StatusIcon, api, cost, duration, fmt, hitRate, useProviders, waiting, type Child, type Run, type Status, type Ticket } from "./ui.tsx";

type Detail = Ticket & { runs: Run[]; children?: Child[] };
type Ev = { seq: number; type: string; payload: any };

export function TicketView({ ticket, reload, close, open }: { ticket: Ticket; reload: () => void; close: () => void; open: (number: number) => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [title, setTitle] = useState(ticket.title);
  const [spec, setSpec] = useState(ticket.spec);
  const [testCommand, setTestCommand] = useState(ticket.test_command ?? "");
  const [workspaceTest, setWorkspaceTest] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
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
  useEffect(() => void api<{ test_command: string }>("/api/settings").then((s) => setWorkspaceTest(s.test_command), () => {}), []);
  useEffect(() => void load(), [ticket.id, ticket.status, ticket.run_count, ticket.tokens_out, ticket.run_status]);
  // An epic's children change while the epic itself does not.
  useEffect(() => {
    if (ticket.kind !== "epic" || ticket.status === "done") return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [ticket.id, ticket.kind, ticket.status]);

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
  const link = (key: string) => <button className="link mono" onClick={() => open(Number(key.split("-").at(-1)))}>{key}</button>;

  return (
    <div className="ticket-view">
      <div className="crumbs muted">
        <button className="link" onClick={close}>Board</button> /{" "}
        {ticket.parent_key && <>{link(ticket.parent_key)} /{" "}</>}
        <span className="mono">{ticket.key}</span>
        {epic && <span className="badge epic">Epic</span>}
      </div>
      <input className="h-input" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={save} maxLength={200} />
      <div className="row">
        {waiting(ticket) && <span className="muted" role="status">waiting for children</span>}
        {ticket.escalated_key && <span className="muted">Escalated to {link(ticket.escalated_key)}</span>}
        {ticket.split_from_key && <span className="muted">Split from {link(ticket.split_from_key)}</span>}
        <span className="grow" />
        {providers && <ModelPicker providers={providers} provider_id={ticket.provider_id} model={ticket.model} onChange={patch} />}
        {ticket.status === "done" && !epic &&
          (ticket.eval_case_id ? <span className="badge">In evals</span> : (
            <button className="btn" onClick={addToEvals} disabled={validating}>{validating ? "Validating…" : "Add to evals"}</button>
          ))}
        <button className="btn primary" onClick={() => run()} disabled={running}>{epic ? "Run planner" : "Run agent"}</button>
        <button className="btn danger" onClick={() => setConfirming(true)}>Delete ticket</button>
      </div>
      <Alert error={error} />
      <textarea aria-label="Spec" placeholder="Describe what the agent should do…" rows={5} value={spec} onChange={(e) => setSpec(e.target.value)} onBlur={save} />
      <label>
        Test command <input aria-label="Test command" className="mono" value={testCommand} placeholder={workspaceTest} spellCheck={false} onChange={(e) => setTestCommand(e.target.value)} onBlur={save} />
        <span className="hint">Overrides the workspace's for this ticket; empty = workspace default. Runs: <span className="mono">{testCommand.trim() || workspaceTest || "(no test command)"}</span></span>
      </label>
      <div className="row">
        <button className="btn" onClick={save} disabled={title.trim() === ticket.title && spec === ticket.spec && !dirty}>Save</button>
      </div>
      {ticket.status === "review" && <Review ticket={ticket} reload={reload} />}
      {epic && detail?.children && <Epic ticket={ticket} items={detail.children} open={open} />}

      <h3>{epic ? "Planner rounds" : "Runs"}</h3>
      {runs.length === 0 ? (
        <p className="muted">No runs yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="runs">
            <thead>
              <tr><th>{epic ? "Round" : "Attempt"}</th><th>Model</th><th>Status</th><th>In</th><th>Out</th><th>Cached</th><th>Cache hit</th><th>Cost</th><th>Time</th><th></th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className={r.id === current?.id ? "sel" : ""}>
                  <td><button className="link" onClick={() => setSelected(r.id)} aria-label={r.role === "wiki" ? "Show wiki run" : `Show run #${r.attempt}`}>{r.role === "wiki" ? "wiki" : `#${r.attempt}`}</button></td>
                  <td className="mono">{r.model}</td>
                  <td><StatusIcon status={r.status === "passed" ? "review" : r.status === "cancelled" ? "todo" : r.status} /> {r.status}</td>
                  <td>{fmt(r.tokens_in)}</td><td>{fmt(r.tokens_out)}</td><td>{fmt(r.tokens_cached)}</td><td>{hitRate(r.tokens_in, r.tokens_cached)}</td>
                  <td>{cost(r.cost_usd, r.auth_type)}</td><td>{duration(r)}</td>
                  <td>{!epic && r.role !== "wiki" && r.status !== "queued" && r.status !== "running" && <button className="link" disabled={running} onClick={() => setRetrying(r)}>Retry with…</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {current && <Transcript key={current.id} run={current} onFinish={() => (reload(), load())} />}

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
  p.protected.length ? `modified protected path ${p.protected.join(", ")}` : `\`${p.command}\` ${p.timed_out ? "timed out" : `exited with code ${p.code}`}`;

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

export function Transcript({ run, onFinish }: { run: Run; onFinish: () => void }) {
  const [events, setEvents] = useState<Ev[]>([]);

  useEffect(() => {
    const es = new EventSource(`/api/runs/${run.id}/events`);
    let done = false;
    es.onmessage = (m) => {
      const e: Ev = JSON.parse(m.data);
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

  const usage = events.filter((e) => e.type === "usage").reduce(
    (a, e) => ({ in: a.in + e.payload.input + e.payload.cache_write, out: a.out + e.payload.output, cached: a.cached + e.payload.cache_read }),
    { in: 0, out: 0, cached: 0 },
  );
  const finished = events.find((e) => e.type === "run_finished");
  const skills = events.find((e) => e.type === "setup" && e.payload.step === "skills")?.payload.skills as any[] | undefined;

  return (
    <section className="transcript" aria-label="Transcript">
      <div className="row">
        <h3 className="grow">
          {run.eval_run_id ? "Eval run" : run.role === "planner" ? `Planner round #${run.attempt}` : run.role === "wiki" ? "Wiki run" : `Run #${run.attempt}`} <span className="muted">{finished ? finished.payload.status : run.status}</span>
          {run.prompt_version && <span className="muted mono"> · prompt v{run.prompt_version}</span>}
        </h3>
        <span className="tokens mono" role="status" aria-label="Token usage">in {fmt(usage.in)} · out {fmt(usage.out)} · cached {fmt(usage.cached)} · cache hit {hitRate(usage.in, usage.cached)}</span>
        {!finished && (run.status === "running" || run.status === "queued") && (
          <button className="btn" onClick={() => api(`/api/runs/${run.id}/cancel`, "POST").catch(() => {})}>Cancel</button>
        )}
      </div>
      {skills && (
        <p className="muted" aria-label="Skills offered">
          Skills offered: {skills.length ? skills.map((k: any) => <span key={k.path} className="mono" title={`${k.description} (${k.path})`}>{k.name} </span>) : "none"}
        </p>
      )}
      {events.map((e) => {
        const p = e.payload;
        if (e.type === "run_started") return <Prompt key={e.seq} text={p.task} />;
        if (e.type === "assistant_message")
          return p.message.content.filter((b: any) => b.type === "text" && b.text).map((b: any, i: number) => <p key={`${e.seq}-${i}`} className="msg">{b.text}</p>);
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
          return "error" in p
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
        if (e.type === "model_review_started") return <div key={e.seq} className="divider" role="separator">Model review round {p.round} {p.budget && <span className="muted">(budget {p.budget} turns for {p.lines} changed lines)</span>}</div>;
        if (e.type === "model_review")
          return (
            <div key={e.seq} className="note">
              <strong>{p.verdict === "approve" ? "Approved by model review" : p.verdict === "error" ? `Model review failed: ${p.message}` : "Model review requested changes"}</strong>
              {p.findings.length > 0 && (
                <ul>{p.findings.map((f: any, i: number) => <li key={i}><span className="mono">{f.file}{f.line ? `:${f.line}` : ""}</span> — {f.problem} → {f.fix}</li>)}</ul>
              )}
            </div>
          );
        if (e.type === "error") return <p key={e.seq} className={p.retrying ? "warn" : "error"}>{p.kind}: {p.message}</p>;
        if (e.type === "run_finished") return <p key={e.seq} className="muted">Run {p.status}{p.reason && p.reason !== p.status ? ` (${p.reason})` : ""} after {p.turns} turns.</p>;
        return null;
      })}
      {!finished && <p className="muted">{run.status === "queued" && !events.length ? "Queued, waiting for a free slot…" : "Waiting for events…"}</p>}
    </section>
  );
}

type DiffInfo = { branch: string; base_branch: string; diff: string };

// Review queue: diff of the latest passed run; approve merges it into the base branch, reject sends the ticket back to todo
// (a child of an epic: counts as failed for its planner). An epic has no diff: its children were merged one by one.
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
function Epic({ ticket, items, open }: { ticket: Ticket; items: Child[]; open: (number: number) => void }) {
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
      {items.length ? <Children parent={ticket.id} items={items} open={open} /> : <p className="muted">No children yet: the planner creates them in its first round.</p>}
    </section>
  );
}

function Children({ parent, items, open }: { parent: string; items: Child[]; open: (number: number) => void }) {
  return (
    <ul className="children" aria-label="Children">
      {items.filter((c) => c.parent_id === parent).map((c) => (
        <li key={c.id} aria-label={c.key}>
          <div className="child">
            <StatusIcon status={c.status} />
            <button className="link mono" onClick={() => open(c.number)}>{c.key}</button>
            <span className="grow">{c.title} {c.kind === "epic" && <span className="badge epic">Epic</span>}</span>
            {c.depends_keys.length > 0 && <span className="muted" title="Dependencies">← {c.depends_keys.join(", ")}</span>}
            <span className="muted">{c.label}</span>
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
