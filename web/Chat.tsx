import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { matchTickets } from "./Palette.tsx";
import { Markdown } from "./Wiki.tsx";
import { PRIORITIES, useTracker, type ProjectRef } from "./tracker.tsx";
import { Popover } from "./Filters.tsx";
import { SkillDialog } from "./Skills.tsx";
import { Alert, Confirm, Icon, Mark, StatusIcon, api, when, type IconName, type Ticket } from "./ui.tsx";

// M13: the chat (Cmd/Ctrl+J panel, or the full-width Agent page: variant "page"). Talks with a project's agent about the
// page you're on; the agent proposes tickets as cards and you file them into that project. A new chat starts in the page's
// project (or the one picked). Skills (M17) can be attached to a message: their full text goes with it. One chat at a time is open; its stored events replay over SSE, then live ones and the
// reply's text as it streams. Which chat is open is the caller's: the page's URL (/agent/<id>), or the panel's remembered one.
// Past chats are listed in the sidebar (recent ones) and on the Chats page (all of them).
export type ChatContext = { ticket?: string; project?: string; cycle?: string };
type Ev = { seq: number; type: string; payload: any };
type Draft = { title: string; spec: string; kind: string; test_command: string | null; priority: number; estimate: number | null };
type Proposal = { id: string; number: number; status: "open" | "filed" | "dismissed" | "superseded"; payload: Draft; ticket_key: string | null };
export type ChatInfo = { id: string; title: string; project_key?: string; updated_at?: number };
type SkillRef = { id: string; name: string };
// The Agent page's starting points: they fill the composer, the member finishes the sentence.
const EXAMPLES: { icon: IconName; title: string; text: string; prompt: string }[] = [
  { icon: "list", title: "Plan a feature", text: "Turn an idea into scoped tickets", prompt: "I want to add … Ask me what's unclear, then propose tickets." },
  { icon: "code", title: "Explain the code", text: "How a part of the repository works", prompt: "How does … work in this repository? Point me to the files." },
  { icon: "layers", title: "Groom the backlog", text: "Stale, duplicated or oversized tickets", prompt: "Which open tickets look stale, duplicated or too large to finish in one run? Suggest what to split or close." },
];

// Read-only tool calls become the turn's "sources": what the agent looked at to answer.
const SOURCE: Record<string, (i: any) => string> = {
  read_file: (i) => String(i.path),
  search: (i) => `“${i.pattern}”${i.path ? ` in ${i.path}` : ""}`,
  read_ticket: (i) => String(i.key),
  list_tickets: (i) => `tickets${i.status ? ` (${i.status})` : ""}${i.query ? ` “${i.query}”` : ""}`,
};

export function Chat({ id, pick, chats, listed, context, label, project, tickets, go, filed, close, variant = "panel" }: {
  id: string | null; pick: (id: string | null) => void; chats: ChatInfo[]; listed: () => void;
  context: ChatContext; label: string | null; project: ProjectRef | undefined; tickets: Ticket[]; go: (to: string) => void; filed: () => void; close?: () => void;
  variant?: "panel" | "page";
}) {
  const { tracker } = useTracker();
  const [picked, setPicked] = useState<string | null>(null); // a project chosen for the next new chat
  const projectId = picked ?? project?.id;
  const [events, setEvents] = useState<Ev[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [draft, setDraft] = useState("");
  const [useContext, setUseContext] = useState(true);
  const [error, setError] = useState("");
  const [chatProject, setChatProject] = useState<string | null>(null); // an open chat's own project
  const [skills, setSkills] = useState<SkillRef[]>([]); // attached to the next message
  const end = useRef<HTMLDivElement>(null);

  const load = (chat = id) =>
    chat
      ? api<{ busy: boolean; proposals: Proposal[]; project_id: string }>(`/api/chats/${chat}`).then((c) => (setProposals(c.proposals), setBusy(c.busy), setChatProject(c.project_id)), () => pick(null))
      : Promise.resolve();
  useEffect(() => setUseContext(true), [label]); // a new page is new context
  useEffect(() => {
    setEvents([]), setProposals([]), setStreaming(""), setBusy(false);
    if (!id) return;
    void load(id);
    let last = 0;
    const es = new EventSource(`/api/chats/${id}/stream`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as Ev;
      if (e.seq <= last) return; // a reconnect replays everything
      last = e.seq;
      setEvents((all) => [...all, e]);
      if (e.type === "user_message") setBusy(true);
      if (e.type === "assistant_message" || e.type === "turn_finished") setStreaming("");
      if (e.type === "turn_finished") setBusy(false), listed();
      if (e.type === "proposal") void load(id);
    };
    es.addEventListener("delta", (m) => setStreaming((s) => s + JSON.parse((m as MessageEvent).data).text));
    return () => es.close();
  }, [id]);
  useEffect(() => void end.current?.scrollIntoView({ block: "end" }), [events.length, streaming]); // void: Chromium's scroll methods return a promise, which React would take for a cleanup

  async function send() {
    const message = draft.trim();
    if (!message || busy) return;
    setError("");
    const body = { message, context: useContext ? context : undefined, project_id: projectId, skills: skills.map((k) => k.id), skill_names: skills.map((k) => [k.id, k.name]) };
    try {
      if (id) await api(`/api/chats/${id}/messages`, "POST", body);
      else {
        const c = await api<ChatInfo>("/api/chats", "POST", body);
        pick(c.id);
        listed();
      }
      setDraft("");
      setSkills([]);
      setBusy(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const stop = () => id && api(`/api/chats/${id}/cancel`, "POST").catch((e) => setError(e.message));

  return (
    <section className={`chat chat-${variant}`} aria-label="Chat">
      {variant === "panel" && (
        <header className="chat-head">
          <select aria-label="Conversation" value={id ?? ""} onChange={(e) => pick(e.target.value || null)}>
            <option value="">New chat</option>
            {chats.map((c) => <option key={c.id} value={c.id}>{c.project_key} · {c.title}</option>)}
          </select>
          <button className="icon-btn" aria-label="New chat" title="New chat" onClick={() => pick(null)}><Icon name="plus" /></button>
          {close && <button className="icon-btn" aria-label="Close chat" title="Close (⌘J)" onClick={close}><Icon name="x" /></button>}
        </header>
      )}
      <div className="chat-log" role="log" aria-label="Messages">
        {!id && (
          <div className="chat-empty muted">
            {variant === "page" && <h2 className="chat-hello">Ask Polaris</h2>}
            <p>Ask about the project, or describe a change. Polaris reads the code and the wiki, asks what's unclear and proposes tickets for you to file.</p>
            <p>{variant === "panel" && "It knows the page you're on; "}Type <kbd>@</kbd> to mention a ticket; attach a skill to say how to go about it.</p>
            {variant === "page" && (
              <div className="chat-examples" aria-label="Examples">
                {EXAMPLES.map((x) => (
                  <button key={x.title} className="chat-example" onClick={() => setDraft(x.prompt)}>
                    <Icon name={x.icon} /><strong>{x.title}</strong><span className="muted">{x.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {render(events, proposals, (p) => <ProposalCard key={p.id} p={p} go={go} changed={() => (void load(), filed())} />)}
        {busy && (streaming ? <div className="chat-model working"><Mark /><Markdown text={streaming} /></div> : <p className="chat-model chat-thinking working muted"><Mark />Thinking…</p>)}
        <div ref={end} />
      </div>
      <Alert error={error} />
      <Composer draft={draft} setDraft={setDraft} send={send} tickets={tickets} busy={busy} stop={stop}
        chip={label && useContext ? <span className="chip">On {label}<button aria-label={`Leave out ${label}`} onClick={() => setUseContext(false)}><Icon name="x" size={12} /></button></span> : null}
        tools={<>
          {!id && tracker && tracker.projects.length > 1 && (
            <select aria-label="Project" title="The project a new chat is about" value={projectId ?? ""} onChange={(e) => setPicked(e.target.value)}>
              {tracker.projects.map((p) => <option key={p.id} value={p.id}>{p.key}</option>)}
            </select>
          )}
          {(id ? chatProject : projectId) && <SkillPicker projectId={(id ? chatProject : projectId)!} selected={skills} setSelected={setSkills} />}
        </>} />
    </section>
  );
}

// Events → what the panel shows: user messages, replies, a sources line per run of read-only calls, proposal cards,
// errors and turns that did not finish.
function render(events: Ev[], proposals: Proposal[], card: (p: Proposal) => ReactNode) {
  const out: ReactNode[] = [];
  let sources: string[] = [];
  const flush = () => {
    if (sources.length) out.push(<p key={`s${out.length}`} className="chat-sources muted">Looked at {[...new Set(sources)].join(", ")}</p>);
    sources = [];
  };
  for (const e of events) {
    if (e.type === "tool_call" && SOURCE[e.payload.name]) {
      sources.push(SOURCE[e.payload.name](e.payload.input));
      continue;
    }
    if (e.type === "tool_call" || e.type === "tool_result") continue;
    flush();
    if (e.type === "user_message")
      out.push(
        <div key={e.seq} className="chat-user">
          {e.payload.text}
          {e.payload.skills?.length > 0 && <span className="chat-skills">{e.payload.skills.map((k: SkillRef) => <span key={k.id} className="chip">{k.name}</span>)}</span>}
        </div>,
      );
    else if (e.type === "assistant_message") {
      const text = (e.payload.message.content as any[]).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (text) out.push(<div key={e.seq} className="chat-model"><Mark /><Markdown text={text} /></div>);
    } else if (e.type === "proposal") {
      const p = proposals.find((x) => x.id === e.payload.proposal_id);
      if (p) out.push(card(p));
    } else if (e.type === "error" && !e.payload.retrying) out.push(<p key={e.seq} className="note err">{e.payload.message}</p>);
    else if (e.type === "turn_finished" && e.payload.status !== "passed")
      out.push(<p key={e.seq} className="note warn">{e.payload.status === "cancelled" ? "Stopped." : `This reply did not finish${e.payload.reason ? `: ${e.payload.reason}` : "."}`}</p>);
  }
  flush();
  return out;
}

// Enter sends, Shift+Enter is a new line; "@" plus a key or title picks a ticket (arrows, Enter or Tab).
function Composer({ draft, setDraft, send, tickets, busy, stop, chip, tools }: {
  draft: string; setDraft: (s: string) => void; send: () => void; tickets: Ticket[]; busy: boolean; stop: () => void; chip: ReactNode; tools: ReactNode;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [sel, setSel] = useState(0);
  const at = /(?:^|\s)@([\w-]*)$/.exec(draft.slice(0, caret));
  const found = at ? matchTickets(tickets, at[1], 6) : [];
  const moveTo = useRef<number | null>(null); // the caret after a picked mention, set before the next keystroke
  useEffect(() => setSel(0), [at?.[1]]);
  useLayoutEffect(() => {
    if (moveTo.current === null) return;
    box.current?.setSelectionRange(moveTo.current, moveTo.current);
    setCaret(moveTo.current);
    moveTo.current = null;
  });

  // Keeps the "@": the server expands @KEY into the ticket's details for the agent.
  function mention(t: Ticket) {
    const start = caret - at![1].length;
    moveTo.current = start + t.key.length + 1;
    setDraft(`${draft.slice(0, start)}${t.key} ${draft.slice(caret)}`);
  }
  function key(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (found.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setSel((sel + (e.key === "ArrowDown" ? 1 : found.length - 1)) % found.length);
    } else if (found.length && (e.key === "Enter" || e.key === "Tab")) {
      e.preventDefault();
      mention(found[Math.min(sel, found.length - 1)]);
    } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="chat-compose">
      {found.length > 0 && (
        <ul className="chat-mentions" role="listbox" aria-label="Tickets">
          {found.map((t, i) => (
            <li key={t.id} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), mention(t))}>
              <StatusIcon status={t.status} label /><span className="mono muted">{t.key}</span><span className="grow">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
      {chip}
      <textarea ref={box} autoFocus rows={3} aria-label="Message" placeholder="Ask or describe a change…  @ to mention a ticket" value={draft}
        onChange={(e) => (setDraft(e.target.value), setCaret(e.target.selectionStart))} onSelect={(e) => setCaret(e.currentTarget.selectionStart)} onKeyDown={key} />
      <div className="row">
        {tools}
        <span className="grow" />
        {busy ? <button className="btn" onClick={stop}>Stop</button> : <button className="btn primary" disabled={!draft.trim()} onClick={send}>Send</button>}
      </div>
    </div>
  );
}

// The composer's Skills menu: the project's repo skills and the workspace's, attached to the next message (shown as chips);
// Create skill makes a workspace skill and attaches it.
type SkillOption = SkillRef & { description: string; source: "repo" | "workspace" };
function SkillPicker({ projectId, selected, setSelected }: { projectId: string; selected: SkillRef[]; setSelected: (s: SkillRef[]) => void }) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [options, setOptions] = useState<SkillOption[] | string | null>(null); // string: an error
  const load = () => api<SkillOption[]>(`/api/projects/${projectId}/skills`).then(setOptions, (e) => setOptions(e.message));
  useEffect(() => void (open && load()), [open, projectId]);
  const on = (k: SkillRef) => selected.some((x) => x.id === k.id);
  const toggle = (k: SkillRef) => setSelected(on(k) ? selected.filter((x) => x.id !== k.id) : [...selected, { id: k.id, name: k.name }].slice(0, 5));
  return (
    <>
      <span className="menu-anchor">
        <button className="btn skills-btn with-icon" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="bolt" size={13} /> Skills{selected.length > 0 && ` · ${selected.length}`}</button>
        {open && (
          <Popover close={() => setOpen(false)}>
            {typeof options === "string" && <p className="error item">{options}</p>}
            {Array.isArray(options) && !options.length && <p className="muted item">No skills yet for this project.</p>}
            {Array.isArray(options) && options.map((k) => (
              <label key={k.id} className="check item skill-option" title={k.description}>
                <input type="checkbox" checked={on(k)} onChange={() => toggle(k)} />
                <span className="grow"><span>{k.name}</span>{k.source === "repo" && <span className="badge">repo</span>}<br /><span className="muted">{k.description}</span></span>
              </label>
            ))}
            <button className="item" onClick={() => (setOpen(false), setCreating(true))}><Icon name="plus" size={13} /> Create skill</button>
          </Popover>
        )}
      </span>
      {selected.map((k) => (
        <span key={k.id} className="chip">{k.name}<button aria-label={`Remove skill ${k.name}`} onClick={() => toggle(k)}><Icon name="x" size={12} /></button></span>
      ))}
      {creating && <SkillDialog skill={null} close={() => setCreating(false)} saved={(k) => (setCreating(false), setSelected([...selected, { id: `ws:${k.id}`, name: k.name }].slice(0, 5)))} />}
    </>
  );
}

// A proposed ticket: File (or File and run) creates it with the card's fields, Edit changes them first, Dismiss drops it.
function ProposalCard({ p, go, changed }: { p: Proposal; go: (to: string) => void; changed: () => void }) {
  const [d, setD] = useState<Draft>(p.payload);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const act = async (fn: () => Promise<any>) => {
    setWorking(true), setError("");
    try {
      const r = await fn();
      if (r?.run_error) setError(`Filed, but the run did not start: ${r.run_error}`);
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const file = (run: boolean) => act(() => api(`/api/chats/proposals/${p.id}/file`, "POST", { ...d, test_command: d.test_command || null, run }));
  const name = `P${p.number}`;

  return (
    <article className={`pcard proposal ${p.status}`} aria-label={`Proposal ${name}`}>
      <div className="row">
        <span className="mono muted">{name}</span>
        {d.kind === "epic" && <span className="badge epic">Epic</span>}
        {p.status !== "open" && <span className="badge">{p.status}</span>}
        <span className="grow" />
        {d.priority > 0 && <span className="muted">{PRIORITIES[d.priority]}</span>}
        {d.estimate && <span className="muted">{d.estimate} pt</span>}
      </div>
      {editing && p.status === "open" ? (
        <>
          <input aria-label="Title" value={d.title} maxLength={200} onChange={(e) => setD({ ...d, title: e.target.value })} />
          <textarea aria-label="Spec" rows={8} value={d.spec} onChange={(e) => setD({ ...d, spec: e.target.value })} />
          <input aria-label="Test command" placeholder="Test command (default: the workspace's)" value={d.test_command ?? ""} onChange={(e) => setD({ ...d, test_command: e.target.value })} />
        </>
      ) : (
        <>
          <strong className="proposal-title">{d.title}</strong>
          <details>
            <summary className="muted">Spec{d.test_command ? ` · gate \`${d.test_command}\`` : ""}</summary>
            <Markdown text={d.spec} />
          </details>
        </>
      )}
      <Alert error={error} />
      {p.status === "open" ? (
        <div className="row end">
          <button className="btn" disabled={working} onClick={() => act(() => api(`/api/chats/proposals/${p.id}/dismiss`, "POST"))}>Dismiss</button>
          <button className="btn" disabled={working} onClick={() => setEditing(!editing)}>{editing ? "Done" : "Edit"}</button>
          <button className="btn" disabled={working} onClick={() => file(true)}>File and run</button>
          <button className="btn primary" disabled={working} onClick={() => file(false)}>File</button>
        </div>
      ) : p.status === "filed" && p.ticket_key !== null ? (
        <p className="muted">Filed as <a href={`/t/${p.ticket_key}`} onClick={(e) => (e.preventDefault(), go(`/t/${p.ticket_key}`))}>{p.ticket_key}</a></p>
      ) : null}
    </article>
  );
}

// The Chats page: every past chat (newest first), searchable by title; open one on the Agent page, or delete it.
export function ChatsPage({ chats, listed, go }: { chats: ChatInfo[]; listed: () => void; go: (to: string) => void }) {
  const [q, setQ] = useState("");
  const [deleting, setDeleting] = useState<ChatInfo | null>(null);
  const [error, setError] = useState("");
  const shown = chats.filter((c) => c.title.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <section className="chats-page" aria-label="Chats">
      <div className="row">
        <input type="search" className="grow" aria-label="Search chats" placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn primary with-icon" onClick={() => go("/agent")}><Icon name="plus" size={14} /> New chat</button>
      </div>
      <Alert error={error} />
      <ul className="plist">
        {shown.map((c) => (
          <li key={c.id} className="row">
            <a href={`/agent/${c.id}`} className="grow" onClick={(e) => (e.preventDefault(), go(`/agent/${c.id}`))}>{c.title}</a>
            <span className="mono muted">{c.project_key}</span>
            {c.updated_at && <span className="muted">{when(c.updated_at)}</span>}
            <button className="icon-btn" aria-label={`Delete ${c.title}`} title="Delete" onClick={() => setDeleting(c)}><Icon name="trash" size={14} /></button>
          </li>
        ))}
        {!shown.length && <li className="muted">{chats.length ? "No chat matches." : "No chats yet. Ask Polaris something and it shows up here."}</li>}
      </ul>
      {deleting && (
        <Confirm title="Delete chat?" onConfirm={() => api(`/api/chats/${deleting.id}`, "DELETE").then(listed, (e) => setError(e.message)).finally(() => setDeleting(null))} onClose={() => setDeleting(null)}>
          “{deleting.title}” and its proposals are deleted. Tickets already filed from it stay.
        </Confirm>
      )}
    </section>
  );
}
