import { useState } from "react";
import { Alert, Confirm, api, useApi } from "./ui.tsx";

export type View = { id: string; name: string; filters: Record<string, string>; sort: string; layout: "board" | "list"; shared: boolean; mine: boolean; owner: string };

// A saved view is a board/list query: opening one navigates to it (view=id), so it can be refined and saved again.
const query = (v: View) => {
  const p = new URLSearchParams(v.filters);
  if (v.sort !== "manual") p.set("sort", v.sort);
  if (v.layout === "list") p.set("layout", "list");
  return p;
};
const viewUrl = (v: View) => `/?${query(v)}&view=${v.id}`;

export function Views({ go }: { go: (to: string) => void }) {
  const { data: views, error, setError, reload } = useApi<View[]>("/api/views");
  const [deleting, setDeleting] = useState<View | null>(null);
  const remove = (v: View) => api(`/api/views/${v.id}`, "DELETE").then(reload, (e) => setError(e.message)).finally(() => setDeleting(null));
  return (
    <div className="page">
      <Alert error={error} />
      {views?.length === 0 && <p className="muted">No saved views. Filter the board or list, then press Save view.</p>}
      <ul className="plist" aria-label="Views">
        {views?.map((v) => (
          <li key={v.id} className="row" aria-label={v.name}>
            <button className="link" onClick={() => go(viewUrl(v))}>{v.name}</button>
            <span className="badge">{v.layout}</span>
            <span className="muted">{v.shared ? `shared${v.mine ? "" : ` by ${v.owner}`}` : "personal"}</span>
            <span className="muted mono grow">{decodeURIComponent(String(query(v))) || "all tickets"}</span>
            {v.mine && <button className="btn" aria-label={`Edit view ${v.name}`} onClick={() => go(`${viewUrl(v)}&edit=1`)}>Edit</button>}
            {v.mine && <button className="btn danger" aria-label={`Delete view ${v.name}`} onClick={() => setDeleting(v)}>Delete</button>}
          </li>
        ))}
      </ul>
      {deleting && (
        <Confirm title="Delete view?" onConfirm={() => remove(deleting)} onClose={() => setDeleting(null)}>
          The saved view {deleting.name} is deleted{deleting.shared ? " for everyone in the workspace" : ""}. Tickets are not changed.
        </Confirm>
      )}
    </div>
  );
}
