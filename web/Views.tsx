import { useCallback, useEffect, useState } from "react";
import { api } from "./ui.tsx";

type View = { id: string; name: string; filters: Record<string, string>; sort: string; layout: "board" | "list"; shared: boolean; mine: boolean; owner: string };

// A saved view is a board/list query: opening one navigates to it, so it can be refined and saved again.
export const viewUrl = (v: View) => {
  const p = new URLSearchParams(v.filters);
  if (v.sort !== "manual") p.set("sort", v.sort);
  if (v.layout === "list") p.set("layout", "list");
  return `/?${p}`;
};

export function Views({ go }: { go: (to: string) => void }) {
  const [views, setViews] = useState<View[] | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(() => api<View[]>("/api/views").then(setViews, (e) => setError(e.message)), []);
  useEffect(() => void reload(), [reload]);
  const remove = (v: View) => api(`/api/views/${v.id}`, "DELETE").then(reload, (e) => setError(e.message));
  return (
    <div className="page">
      {error && <p className="error" role="alert">{error}</p>}
      {views?.length === 0 && <p className="muted">No saved views. Filter the board or list, then press Save view.</p>}
      <ul className="plist" aria-label="Views">
        {views?.map((v) => (
          <li key={v.id} className="row" aria-label={v.name}>
            <button className="link" onClick={() => go(viewUrl(v))}>{v.name}</button>
            <span className="badge">{v.layout}</span>
            <span className="muted">{v.shared ? `shared${v.mine ? "" : ` by ${v.owner}`}` : "personal"}</span>
            <span className="muted mono grow">{decodeURIComponent(viewUrl(v).slice(2)) || "all tickets"}</span>
            {v.mine && <button className="btn danger" aria-label={`Delete view ${v.name}`} onClick={() => remove(v)}>Delete</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
