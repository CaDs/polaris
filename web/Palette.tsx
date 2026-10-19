import { useEffect, useState } from "react";
import { Dialog, StatusIcon, type Ticket } from "./ui.tsx";

// Cmd/Ctrl+K: jump to a ticket by key or title, create a ticket, go to a page. Arrow keys move, Enter runs, Esc closes.
type Item = { id: string; name: string; hint?: string; ticket?: Ticket; run: () => void };

export function Palette({ tickets, go, create, close }: { tickets: Ticket[]; go: (to: string) => void; create: () => void; close: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const s = q.trim().toLowerCase();
  const commands: Item[] = [
    { id: "new", name: "Create ticket", hint: "C", run: create },
    ...([["Board", "/"], ["Projects", "/projects"], ["Cycles", "/cycles"], ["Current cycle", "/cycles/current"], ["Views", "/views"], ["Usage", "/usage"], ["Wiki", "/wiki"], ["Settings", "/settings"]] as const).map(
      ([name, to]): Item => ({ id: to, name: `Go to ${name}`, run: () => go(to) }),
    ),
  ].filter((c) => c.name.toLowerCase().includes(s));
  // Key prefix matches first ("ABC-1" → ABC-1, ABC-12 …), then titles.
  const found = s
    ? [...tickets.filter((t) => t.key.toLowerCase().startsWith(s)), ...tickets.filter((t) => !t.key.toLowerCase().startsWith(s) && t.title.toLowerCase().includes(s))]
    : tickets.slice(-5).reverse();
  const items = [...found.slice(0, 8).map((t): Item => ({ id: t.id, name: t.title, ticket: t, run: () => go(`/t/${t.number}`) })), ...commands];
  const at = Math.min(sel, items.length - 1);
  useEffect(() => setSel(0), [s]);

  function key(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setSel((at + (e.key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(items.length, 1));
    } else if (e.key === "Enter" && items[at]) {
      e.preventDefault();
      close();
      items[at].run();
    }
  }

  return (
    <Dialog title="Command palette" className="palette" heading={false} onClose={close}>
      <input autoFocus aria-label="Command" placeholder="Search tickets or type a command…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={key}
        role="combobox" aria-expanded="true" aria-controls="palette-list" aria-activedescendant={items[at] ? `pi-${items[at].id}` : undefined} />
      <ul id="palette-list" role="listbox" aria-label="Results">
        {items.map((it, i) => (
          <li key={it.id} id={`pi-${it.id}`} role="option" aria-selected={i === at} onMouseEnter={() => setSel(i)} onMouseDown={(e) => (e.preventDefault(), close(), it.run())}>
            {it.ticket ? <><StatusIcon status={it.ticket.status} /><span className="mono muted">{it.ticket.key}</span></> : <span className="muted">›</span>}
            <span className="grow">{it.name}</span>
            {it.hint && <kbd>{it.hint}</kbd>}
          </li>
        ))}
        {!items.length && <li className="muted">No results</li>}
      </ul>
    </Dialog>
  );
}
