import { useEffect, useState } from "react";
import { Transcript } from "./TicketView.tsx";
import { Alert, Dialog, Loading, api, cost, fmt, when, type Run } from "./ui.tsx";

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

const score = (e: EvalRun) => (e.status === "done" ? `${e.passed}/${e.total}` : `running, ${e.results?.filter((r) => r.case_passed !== null).length ?? 0}/${e.case_ids.length} done`);

export function Improvement() {
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
      <Lessons data={d.lessons} act={act} />
      <Prompts data={d.prompts} runs={d.evals.runs} act={act} />
      <Evals data={d.evals} act={act} />
    </div>
  );
}

type Act = (fn: () => Promise<unknown>) => Promise<void>;

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
      <p className="muted">
        Short notes about this repository and harness, written by a reflection after each finished ticket (or by you). The active (latest)
        version goes into the first message of every new run, right away. Never into the system prompt.
      </p>
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
      <p className="muted">
        The active version is the system prompt of every new run (a running run keeps its own). New and proposed versions stay inactive
        until you promote them, which needs a finished eval on the current {data.case_count} case{data.case_count === 1 ? "" : "s"} that beats
        the active version's: more cases passed, or as many with at least 10% fewer mean tokens. Nothing is promoted automatically.
      </p>
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
  const all = data.runs.flatMap((e) => e.results ?? []);
  const run = all.find((r) => r.id === shown);
  return (
    <section aria-label="Evals">
      <h2>Eval cases</h2>
      <p className="muted">
        Approved tickets, frozen: replayed from the commit their run started from, in a fresh worktree and sandbox, with the commands and
        protected paths saved with the case. Add one with "Add to evals" on a done ticket; it must fail its test command at that commit.
      </p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Ticket</th><th>Base</th><th>Test command</th><th></th></tr></thead>
          <tbody>
            {data.cases.map((c) => (
              <tr key={c.id}>
                <td><span className="mono">{c.key}</span> {c.title}</td><td className="mono">{c.base_sha.slice(0, 8)}</td><td className="mono">{c.test_command}</td>
                <td><button className="link" onClick={() => act(() => api(`/api/evals/cases/${c.id}`, "DELETE"))}>Remove</button></td>
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
    </section>
  );
}
