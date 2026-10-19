import { useEffect, useState } from "react";
import { Transcript } from "./TicketView.tsx";
import { Alert, Confirm, Dialog, Loading, api, cost, fmt, useApi, when, type Run } from "./ui.tsx";

// M6: the three self-improvement loops, all visible and reversible. Lessons apply to the next run at once (so Restore is
// one click); a prompt version only applies once a human promotes it, and only when its eval beats the active one.
type LessonsVersion = {
  id: string; version: number; body: string; source: "reflection" | "human" | "restore"; author: string | null; restored_from: number | null;
  run_attempt: number | null; ticket_key: string | null; created_at: number;
};
type EvalRun = {
  id: string; prompt_id: string; prompt_version: number; lessons_version: number | null; case_ids: string[]; model: string; status: "running" | "done";
  passed: number | null; total: number | null; mean_tokens: number | null; started_at: number; current?: boolean;
  results?: (Run & { case_passed: number | null; case_title: string | null; turns: number | null; duration_ms: number | null })[];
};
type PromptVersion = {
  id: string; version: number; body: string; active: number; source: "seed" | "human" | "proposal"; author: string | null; rationale: string | null;
  created_at: number; evals: EvalRun[]; promotion: { ok: boolean; reason: string };
};
type EvalCase = { id: string; key: string; title: string; base_sha: string; test_command: string; created_at: number };
type Data = {
  lessons: { max: number; versions: LessonsVersion[] };
  prompts: { max: number; case_count: number; versions: PromptVersion[] };
  evals: { cases: EvalCase[]; runs: EvalRun[] };
};

// A section's intro: one line always visible, the mechanics folded away until asked for.
function About({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <div className="about">
      <p className="muted">{summary}</p>
      <details><summary>How it works</summary><p className="muted">{children}</p></details>
    </div>
  );
}

const score = (e: EvalRun) => (e.status === "done" ? `${e.passed}/${e.total}` : `running, ${e.results?.filter((r) => r.case_passed !== null).length ?? 0}/${e.case_ids.length} done`);

// M12 failure mining: GET /api/failures (classes of the last `days`, runs per day and class) and POST /api/failures/mine.
type Failures = {
  days: number;
  classes: {
    class: string; description: string; runs: number; tickets: number; mined: { id: string; key: string; status: string } | null;
    examples: { run_id: string; ticket_key: string; title: string; reason: string | null; model: string }[];
  }[];
  rows: { day: string; class: string; runs: number }[];
};
type Mining = {
  created: { class: string; ticket_id: string; key: string; title: string; confidence: number }[];
  lessons: { class: string; version: number; lesson: string }[];
  skipped: { class: string; why: string }[];
};

// open: a ticket by number; changed: mining made tickets or lessons (the board and the Lessons section reload).
export function Improvement({ open, changed }: { open: (n: number) => void; changed: () => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    Promise.all([api("/api/lessons"), api("/api/prompts"), api("/api/evals")]).then(([lessons, prompts, evals]) => setD({ lessons, prompts, evals }), (e) => setError(e.message));
  useEffect(() => void load(), []);
  const running = d?.evals.runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [running]);

  // Runs an action; errors show at the top of the page.
  const act = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  if (!d) return <Loading error={error} />;
  return (
    <div className="improve">
      <Alert error={error} />
      <FailureClasses open={open} changed={() => (changed(), load())} />
      <Lessons data={d.lessons} act={act} />
      <Prompts data={d.prompts} runs={d.evals.runs} act={act} />
      <Evals data={d.evals} act={act} />
    </div>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<void>;

function FailureClasses({ open, changed }: { open: (n: number) => void; changed: () => void }) {
  const { data, error, setError, reload } = useApi<Failures>("/api/failures?days=30");
  const [mining, setMining] = useState(false);
  const [result, setResult] = useState<Mining | null>(null);
  const link = (key: string) => <button className="link mono" onClick={() => open(Number(key.split("-").at(-1)))}>{key}</button>;
  const mine = async () => {
    setMining(true);
    setError("");
    try {
      setResult(await api<Mining>("/api/failures/mine", "POST"));
      changed();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMining(false);
    }
  };
  if (!data) return <section aria-label="Failures"><h2>Failures</h2><Loading error={error} /></section>;
  const days = Array.from({ length: data.days }, (_, i) => new Date(Date.now() - (data.days - 1 - i) * 86_400_000).toISOString().slice(0, 10));
  return (
    <section aria-label="Failures">
      <div className="row">
        <h2 className="grow">Failures</h2>
        <button className="btn" disabled={mining} onClick={mine}>{mining ? "Mining…" : "Mine failures"}</button>
      </div>
      <About summary={`Why worker runs failed in the last ${data.days} days, grouped by cause.`}>
        Classified from the runs' events (runs of tickets labelled mined are left out). Mine failures asks the workspace's model, once per
        class with at least 2 runs and no open mined ticket, for a ticket that would stop it (at most 5), or for a lesson when the cause is
        the harness. Mined tickets wait in todo until you read and run them.
      </About>
      <Alert error={error} />
      {result && (
        <ul className="checks" aria-label="Mining result">
          {result.created.map((c) => (
            <li key={c.ticket_id}>Created {link(c.key)} {c.title} <span className="muted">· from {c.class} · confidence {c.confidence.toFixed(2)}</span></li>
          ))}
          {result.lessons.map((l) => <li key={l.class}>Lesson added (v{l.version}) for {l.class}: {l.lesson}</li>)}
          {result.skipped.map((s) => <li key={s.class} className="muted">Skipped {s.class}: {s.why}</li>)}
          {!result.created.length && !result.lessons.length && !result.skipped.length && <li className="muted">No failures to mine.</li>}
        </ul>
      )}
      <div className="table-wrap">
        <table className="failures" aria-label="Failure classes">
          <thead><tr><th>Class</th><th>Runs</th><th>Tickets</th><th>Per day</th><th>Examples</th></tr></thead>
          <tbody>
            {data.classes.map((c) => {
              const per = days.map((d) => data.rows.find((r) => r.day === d && r.class === c.class)?.runs ?? 0);
              const max = Math.max(1, ...per);
              return (
                <tr key={c.class} aria-label={c.class}>
                  <td><span className="mono">{c.class}</span><div className="muted">{c.description}</div>{c.mined && <div>mined: {link(c.mined.key)}</div>}</td>
                  <td>{c.runs}</td>
                  <td>{c.tickets}</td>
                  <td>
                    <div className="spark mini" role="img" aria-label={`${c.class}: runs per day, last ${data.days} days`}>
                      {per.map((n, i) => <div key={days[i]} title={`${days[i]}: ${n}`}>{n > 0 && <span className="failed" style={{ height: `${(100 * n) / max}%` }} />}</div>)}
                    </div>
                  </td>
                  <td>
                    <ul className="checks">
                      {c.examples.map((e) => <li key={e.run_id}>{link(e.ticket_key)} <span className="muted">{e.model}</span> {e.reason}</li>)}
                    </ul>
                  </td>
                </tr>
              );
            })}
            {data.classes.length === 0 && <tr><td colSpan={5} className="muted">No failed runs in the last {data.days} days.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Lessons({ data, act }: { data: Data["lessons"]; act: Act }) {
  const current = data.versions[0];
  const [draft, setDraft] = useState(current?.body ?? "");
  useEffect(() => setDraft(current?.body ?? ""), [current?.id]);
  const by = (v: LessonsVersion) =>
    v.source === "reflection" ? `reflection on ${v.ticket_key ?? "a deleted ticket"}${v.run_attempt ? ` (run #${v.run_attempt})` : ""}`
    : v.source === "restore" ? `restore of v${v.restored_from} by ${v.author}` : `edited by ${v.author}`;
  return (
    <section aria-label="Lessons">
      <h2>Lessons</h2>
      <About summary="Notes about this repository that every new run starts with.">
        Written by a reflection after each finished ticket, or by you. The active (latest) version goes into the first message of every
        new run, right away. Never into the system prompt.
      </About>
      <textarea aria-label="Lessons" className="mono" rows={8} value={draft} maxLength={data.max} onChange={(e) => setDraft(e.target.value)} placeholder="No lessons yet." />
      <div className="row">
        <button className="btn primary" disabled={draft.trim() === (current?.body ?? "")} onClick={() => act(() => api("/api/lessons", "PUT", { body: draft }))}>Save lessons</button>
        <span className="muted">{draft.length} / {data.max} chars</span>
      </div>
      <h3>History</h3>
      {data.versions.length === 0 && <p className="muted">No versions yet.</p>}
      <ul className="plist" aria-label="Lessons history">
        {data.versions.map((v, i) => (
          <li key={v.id} aria-label={`Lessons v${v.version}`}>
            <div className="row">
              <strong>v{v.version}</strong>
              {i === 0 && <span className="badge">active</span>}
              <span className="muted grow">{by(v)} · {when(v.created_at)} · {v.body.length} chars</span>
              {i > 0 && <button className="btn" onClick={() => act(() => api(`/api/lessons/${v.id}/restore`, "POST"))}>Restore</button>}
            </div>
            <details>
              <summary className="muted">Diff vs {data.versions[i + 1] ? `v${data.versions[i + 1].version}` : "empty"}</summary>
              <LineDiff from={data.versions[i + 1]?.body ?? ""} to={v.body} />
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ponytail: set-based line diff (fine for bullet lists); an LCS diff if lessons ever become prose.
function LineDiff({ from, to }: { from: string; to: string }) {
  const a = from ? from.split("\n") : [];
  const b = to ? to.split("\n") : [];
  const rows = [...a.filter((l) => !b.includes(l)).map((l) => ["del", `-${l}`]), ...b.map((l) => (a.includes(l) ? ["", ` ${l}`] : ["add", `+${l}`]))];
  return (
    <div className="diff">
      <pre className="mono">{rows.map(([c, l], i) => <div key={i} className={c || undefined}>{l}</div>)}</pre>
    </div>
  );
}

function Prompts({ data, runs, act }: { data: Data["prompts"]; runs: EvalRun[]; act: Act }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const live = (e: EvalRun) => runs.find((r) => r.id === e.id) ?? e; // results come from /api/evals
  return (
    <section aria-label="Prompt versions">
      <div className="row">
        <h2 className="grow">Prompt versions</h2>
        <button className="btn" disabled={proposing} onClick={() => (setProposing(true), act(() => api("/api/prompts/propose", "POST")).finally(() => setProposing(false)))}>
          {proposing ? "Proposing…" : "Propose improvement"}
        </button>
      </div>
      <About summary="The worker's system prompt. A new version applies only after it wins an eval and you promote it.">
        The active version is the system prompt of every new run (a running run keeps its own). New and proposed versions stay inactive
        until you promote them, which needs a finished eval on the current {data.case_count} case{data.case_count === 1 ? "" : "s"} that beats
        the active version's: more cases passed, or as many with at least 10% fewer mean tokens. Nothing is promoted automatically.
      </About>
      {data.versions.map((p) => (
        <article key={p.id} className="pcard" aria-label={`Prompt v${p.version}`}>
          <div className="row">
            <strong>v{p.version}</strong>
            {!!p.active && <span className="badge">active</span>}
            <span className="muted grow">
              {p.source === "seed" ? "seeded from prompts/worker.md" : p.source === "proposal" ? `proposed by ${p.author}` : `written by ${p.author}`} · {when(p.created_at)}
            </span>
            <button className="btn" onClick={() => act(() => api(`/api/prompts/${p.id}/evals`, "POST"))}>Run eval</button>
            <button className="btn" onClick={() => setEditing(p.body)}>New version</button>
            {!p.active && (
              <button className="btn primary" disabled={!p.promotion.ok} title={p.promotion.reason} onClick={() => act(() => api(`/api/prompts/${p.id}/promote`, "POST"))}>Promote</button>
            )}
          </div>
          {p.rationale && <p><span className="muted">Rationale:</span> {p.rationale}</p>}
          {!p.active && <p className={p.promotion.ok ? "ok-text" : "muted"} aria-label="Promotion">{p.promotion.reason}</p>}
          <details>
            <summary className="muted">Prompt ({p.body.length} chars)</summary>
            <pre className="body mono">{p.body}</pre>
          </details>
          <ul className="checks" aria-label="Evals">
            {p.evals.map((e) => {
              const x = live(e);
              return (
                <li key={e.id}>
                  Eval {score(x)} passed{x.mean_tokens !== null && ` · ${fmt(Math.round(x.mean_tokens))} mean tokens`} · {x.model}
                  {x.lessons_version ? ` · lessons v${x.lessons_version}` : ""} · {e.current ? "current cases" : <span className="muted">older case set</span>}
                </li>
              );
            })}
            {p.evals.length === 0 && <li className="muted">No evals yet.</li>}
          </ul>
        </article>
      ))}
      {editing !== null && <NewVersion body={editing} max={data.max} close={() => setEditing(null)} save={(body) => act(() => api("/api/prompts", "POST", { body })).then(() => setEditing(null))} />}
    </section>
  );
}

function NewVersion({ body, max, close, save }: { body: string; max: number; close: () => void; save: (body: string) => void }) {
  const [text, setText] = useState(body);
  return (
    <Dialog title="New prompt version" onClose={close}>
      <p className="muted">Saved as a new inactive version. It applies to runs only after an eval and a promotion.</p>
      <label>
        Prompt <textarea className="mono" rows={14} value={text} maxLength={max} onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="row end">
        <button className="btn" onClick={close}>Cancel</button>
        <button className="btn primary" disabled={!text.trim() || text === body} onClick={() => save(text)}>Save version</button>
      </div>
    </Dialog>
  );
}

function Evals({ data, act }: { data: Data["evals"]; act: Act }) {
  const [shown, setShown] = useState<string | null>(null);
  const [removing, setRemoving] = useState<EvalCase | null>(null);
  const all = data.runs.flatMap((e) => e.results ?? []);
  const run = all.find((r) => r.id === shown);
  return (
    <section aria-label="Evals">
      <h2>Eval cases</h2>
      <About summary={'Approved tickets, frozen, that score prompt versions. Add one with "Add to evals" on a done ticket.'}>
        Replayed from the commit their run started from, in a fresh worktree and sandbox, with the commands and protected paths saved with
        the case. A case must fail its test command at that commit.
      </About>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Ticket</th><th>Base</th><th>Test command</th><th></th></tr></thead>
          <tbody>
            {data.cases.map((c) => (
              <tr key={c.id}>
                <td><span className="mono">{c.key}</span> {c.title}</td><td className="mono">{c.base_sha.slice(0, 8)}</td><td className="mono">{c.test_command}</td>
                <td><button className="btn danger" aria-label={`Remove ${c.key} from evals`} onClick={() => setRemoving(c)}>Remove</button></td>
              </tr>
            ))}
            {data.cases.length === 0 && <tr><td colSpan={4} className="muted">No eval cases yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <h3>Eval runs</h3>
      <div className="table-wrap">
        <table aria-label="Eval runs">
          <thead><tr><th>Prompt</th><th>Case</th><th>Result</th><th>Turns</th><th>Tokens</th><th>Cost</th><th>Time</th><th></th></tr></thead>
          <tbody>
            {data.runs.flatMap((e) =>
              (e.results ?? []).map((r) => (
                <tr key={r.id} className={r.id === shown ? "sel" : ""}>
                  <td>v{e.prompt_version}</td><td>{r.case_title ?? "(removed case)"}</td>
                  <td>{r.case_passed === null ? r.status : r.case_passed ? "passed" : "failed"}</td>
                  <td>{r.turns ?? "—"}</td><td>{fmt(r.tokens_in + r.tokens_out)}</td><td>{cost(r.cost_usd)}</td><td>{r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
                  <td><button className="link" onClick={() => setShown(r.id === shown ? null : r.id)}>Transcript</button></td>
                </tr>
              )),
            )}
            {data.runs.length === 0 && <tr><td colSpan={8} className="muted">No eval runs yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {run && <Transcript key={run.id} run={run} onFinish={() => {}} />}
      {removing && (
        <Confirm title="Remove eval case?" action="Remove" onConfirm={() => (setRemoving(null), act(() => api(`/api/evals/cases/${removing.id}`, "DELETE")))} onClose={() => setRemoving(null)}>
          {removing.key} is no longer replayed by evals. Past eval runs keep their results; the ticket is not changed.
        </Confirm>
      )}
    </section>
  );
}
