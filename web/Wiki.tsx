import { useEffect, useState, type ReactNode } from "react";
import { Transcript } from "./TicketView.tsx";
import { api, type Run } from "./ui.tsx";

// M10: the project wiki. The index with stale flags, a page viewer/editor, the wiki repo's history, and the maintainer runs.
type PageInfo = { path: string; title: string; summary: string; stale: string | null; verified: string; updated: string };
type WikiRun = {
  id: string; wiki_op: "ingest" | "bootstrap" | "lint"; status: string; started_at: number | null; ticket_key: string | null; ticket_number: number | null;
  result: { commit?: string; unchanged?: boolean; problems?: string[] } | null;
};
type Data = { enabled: boolean; configured: boolean; index: string; pages: PageInfo[]; log: string; problems: string[]; runs: WikiRun[] };
type Commit = { sha: string; subject: string; date: string };

const when = (iso: string | number) => new Date(iso).toLocaleString();
const resolvePath = (from: string, to: string) => {
  const parts = from.split("/").slice(0, -1);
  for (const p of to.split("/")) p === ".." ? parts.pop() : p !== "." && parts.push(p);
  return parts.join("/");
};

// A small markdown subset (headings, bullets, code fences, `code`, **bold**, links): internal .md links open the page.
function Markdown({ path, text, open }: { path: string; text: string; open: (path: string) => void }) {
  const inline = (s: string): ReactNode[] =>
    s.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/).map((t, i) => {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t);
      if (t.startsWith("`") && t.endsWith("`") && t.length > 1) return <code key={i}>{t.slice(1, -1)}</code>;
      if (t.startsWith("**") && t.endsWith("**") && t.length > 4) return <strong key={i}>{t.slice(2, -2)}</strong>;
      if (!link) return t;
      return /^https?:\/\//.test(link[2])
        ? <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>
        : <button key={i} className="link" onClick={() => open(resolvePath(path, link[2]))}>{link[1]}</button>;
    });
  const out: ReactNode[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (list.length) out.push(<ul key={out.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      flush();
      if (code) out.push(<pre key={out.length} className="body">{code.join("\n")}</pre>);
      code = code ? null : [];
    } else if (code) code.push(line);
    else if (/^\s*[-*] /.test(line)) list.push(line.replace(/^\s*[-*] /, ""));
    else {
      flush();
      const h = /^(#{1,4}) (.*)$/.exec(line);
      if (h) out.push(<h4 key={out.length}>{inline(h[2])}</h4>);
      else if (line.trim()) out.push(<p key={out.length}>{inline(line)}</p>);
    }
  }
  flush();
  if (code) out.push(<pre key={out.length} className="body">{code.join("\n")}</pre>);
  return <div className="md">{out}</div>;
}

function PageView({ path, open, reload }: { path: string; open: (path: string) => void; reload: () => Promise<void> }) {
  const [body, setBody] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setBody(null);
    setDraft(null);
    setError("");
    api<{ body: string }>(`/api/wiki/page?path=${encodeURIComponent(path)}`).then((r) => setBody(r.body), (e) => setError(e.message));
  }, [path]);
  async function save() {
    setError("");
    try {
      await api("/api/wiki/page", "PUT", { path, body: draft });
      setBody(draft);
      setDraft(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const fm = body !== null ? /^---\n([\s\S]*?)\n---\n?/.exec(body) : null;
  return (
    <section aria-label="Page">
      <div className="row">
        <h3 className="grow mono">{path}</h3>
        {body !== null && draft === null && <button className="btn" onClick={() => setDraft(body)}>Edit</button>}
      </div>
      {error && <p className="error" role="alert" style={{ whiteSpace: "pre-wrap" }}>{error}</p>}
      {draft !== null ? (
        <>
          <textarea aria-label="Page text" className="mono" rows={18} value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} />
          <div className="row">
            <button className="btn primary" onClick={save} disabled={draft === body}>Save</button>
            <button className="btn" onClick={() => (setDraft(null), setError(""))}>Cancel</button>
            <span className="muted">Checked like the maintainer's output (frontmatter, index links, size) and committed as an edit.</span>
          </div>
        </>
      ) : body !== null ? (
        <>
          {fm && <pre className="body muted">{fm[1]}</pre>}
          <Markdown path={path} text={fm ? body.slice(fm[0].length) : body} open={open} />
        </>
      ) : !error && <p className="muted">Loading…</p>}
    </section>
  );
}

function History({ commits }: { commits: Commit[] }) {
  const [sha, setSha] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  useEffect(() => {
    setDiff("");
    if (sha) api<{ diff: string }>(`/api/wiki/diff?sha=${sha}`).then((r) => setDiff(r.diff), (e) => setDiff(e.message));
  }, [sha]);
  return (
    <section aria-label="History">
      <h3>History</h3>
      <ul className="plain">
        {commits.map((c) => (
          <li key={c.sha}>
            <button className="link" aria-expanded={sha === c.sha} onClick={() => setSha(sha === c.sha ? null : c.sha)}>{c.subject}</button>{" "}
            <span className="muted mono">{c.sha.slice(0, 8)} · {when(c.date)}</span>
            {sha === c.sha && <pre className="body diff">{diff || "Loading…"}</pre>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Wiki() {
  const [d, setD] = useState<Data | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [path, setPath] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState("");
  const [linted, setLinted] = useState(false);
  const load = async () => {
    try {
      const [wiki, history] = await Promise.all([api<Data>("/api/wiki"), api<Commit[]>("/api/wiki/history")]);
      setD(wiki);
      setCommits(history);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => void load(), []);
  const active = d?.runs.some((r) => r.status === "queued" || r.status === "running");
  useEffect(() => {
    if (!active) return;
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [active]);

  // Starts a maintainer run; errors show at the top.
  const start = async (what: "bootstrap" | "lint") => {
    setError("");
    try {
      const r = await api<Run>(`/api/wiki/${what}`, "POST");
      setRun(r);
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
  };

  if (!d) return <p className="muted pad">{error || "Loading…"}</p>;
  const stale = d.pages.filter((p) => p.stale);
  return (
    <div className="wiki">
      {!d.enabled && <p className="warn">The project wiki is off (Settings): runs get no wiki and approved work is not ingested. What is here stays readable.</p>}
      <div className="row">
        <button className="btn primary" onClick={() => start("bootstrap")} disabled={!d.enabled || !d.configured || !!active}>Build wiki</button>
        <button className="btn" onClick={() => start("lint")} disabled={!d.enabled || !d.configured || !!active || !stale.length}>Refresh stale pages</button>
        <button className="btn" onClick={() => (load(), setLinted(true))}>Lint</button>
        {linted && (d.problems.length ? <span className="error" role="status">{d.problems.length} problem{d.problems.length === 1 ? "" : "s"}</span> : <span className="ok-text" role="status">Lint passed</span>)}
        {active && <span className="muted" role="status">A wiki run is working…</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {linted && d.problems.length > 0 && <ul aria-label="Lint problems">{d.problems.map((p) => <li key={p} className="error">{p}</li>)}</ul>}

      <section aria-label="Index">
        <h3>Index</h3>
        {d.pages.length === 0 ? (
          <p className="muted">No pages yet. Build the wiki from the code, or approve a ticket: the maintainer writes the first pages from it.</p>
        ) : (
          <ul className="plain">
            {d.pages.map((p) => (
              <li key={p.path}>
                <button className="link" aria-current={p.path === path} onClick={() => setPath(p.path)}>{p.title}</button>
                {p.summary && <span className="muted"> — {p.summary}</span>}
                {p.stale && <span className="warn" title="Source files changed since the page was verified"> ⚠ may be stale: {p.stale}</span>}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          Other pages: <button className="link" onClick={() => setPath("SCHEMA.md")}>SCHEMA.md</button>,{" "}
          <button className="link" onClick={() => setPath("index.md")}>index.md</button>,{" "}
          <button className="link" onClick={() => setPath("log.md")}>log.md</button>
        </p>
      </section>

      {path && <PageView path={path} open={setPath} reload={load} />}
      <History commits={commits} />

      <section aria-label="Wiki runs">
        <h3>Maintainer runs</h3>
        {d.runs.length === 0 ? <p className="muted">None yet.</p> : (
          <ul className="plain">
            {d.runs.map((r) => (
              <li key={r.id}>
                <button className="link" onClick={() => api<Run>(`/api/runs/${r.id}`).then(setRun, (e) => setError(e.message))}>
                  {r.wiki_op}{r.ticket_key ? ` ${r.ticket_key}` : ""}
                </button>{" "}
                <span className="muted">{r.status}{r.started_at ? ` · ${when(r.started_at)}` : ""}</span>
                {r.result?.commit && <span className="muted mono"> · commit {r.result.commit.slice(0, 8)}</span>}
                {r.result?.unchanged && <span className="muted"> · no change</span>}
                {r.result?.problems && <span className="error"> · rejected: {r.result.problems.join("; ")}</span>}
              </li>
            ))}
          </ul>
        )}
        {run && <Transcript key={run.id} run={run} onFinish={load} />}
      </section>
    </div>
  );
}
