import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { touch } from "./agent/events.ts";
import { AgentError, noUsage, type Provider, type RequestUsage, type Usage } from "./agent/types.ts";

export type BillingMode = "local" | "subscription" | "api_key" | "unknown";
export type UsageContext = { workspaceId: string; ticketId?: string; runId?: string; purpose: string; background?: boolean; uncapped?: boolean };
export type UsageProvider = { id?: string; name: string; kind: string; billing: BillingMode };
const context = new AsyncLocalStorage<UsageContext>();
export const withUsage = <T>(c: UsageContext, fn: () => T): T => context.run(c, fn);
export const usagePurpose = <T>(purpose: string, fn: () => T): T => {
  const c = context.getStore();
  return c && purpose ? withUsage({ ...c, purpose }, fn) : fn();
};

// Existing verified price estimates. Unknown prices stay unknown; local/plan use is never API-priced.
const PRICES: Record<string, { input: number; output: number; cache_read: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2 },
};
export function usageCost(model: string, u: Usage, billing: BillingMode): number | null {
  if (billing === "local" || billing === "subscription") return 0;
  const p = PRICES[model];
  return p ? ((u.input + u.cache_write) * p.input + u.output * p.output + u.cache_read * p.cache_read) / 1e6 : null;
}
export const normalized = (u: Partial<Usage> = {}): Usage => Object.fromEntries(Object.keys(noUsage()).map((k) => {
  const n = u[k as keyof Usage];
  return [k, typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0];
})) as Usage;

export function recordUsage(c: UsageContext, p: UsageProvider, model: string, request: RequestUsage, historical = false, costOverride?: number) {
  const u = normalized(request.usage);
  const usd = costOverride ?? usageCost(model, u, p.billing);
  db.exec("SAVEPOINT usage_record");
  let added = false;
  try {
    added = !!db.prepare(`INSERT OR IGNORE INTO usage_ledger
      (id,workspace_id,ticket_id,run_id,provider_id,provider_name,provider_kind,model,billing_mode,purpose,background,started_at,recorded_at,outcome,completeness,input,output,cache_read,cache_write,cost_usd,historical)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(request.id, c.workspaceId, c.ticketId ?? null, c.runId ?? null, p.id ?? null, p.name, p.kind, model, p.billing, c.purpose, c.background ? 1 : 0,
      request.started_at, Date.now(), request.outcome, request.status, u.input, u.output, u.cache_read, u.cache_write, usd, historical ? 1 : 0).changes;
    if (added && c.runId && !c.background && !historical)
      db.prepare(`UPDATE runs SET tokens_in=tokens_in+?,tokens_out=tokens_out+?,tokens_cached=tokens_cached+?,tokens_cache_write=tokens_cache_write+?,cost_usd=cost_usd+? WHERE id=?`)
        .run(u.input + u.cache_write, u.output, u.cache_read, u.cache_write, usd ?? 0, c.runId);
    db.exec("RELEASE usage_record");
  } catch (e) {
    db.exec("ROLLBACK TO usage_record; RELEASE usage_record");
    throw e;
  }
  if (added) {
    touch(c.workspaceId, { type: "usage", id: request.id });
    if (c.ticketId) touch(c.workspaceId, { type: "ticket", id: c.ticketId });
  }
}

// A provider is decorated once, but the owning operation is bound asynchronously per invocation. Each transport
// retry emits its own measurement. Scripted/custom providers without transport telemetry get one measurement.
const measuredErrors = new WeakSet<object>();
export function metered(provider: Provider, p: UsageProvider, workspaceId?: string): Provider {
  return { async stream(req, onEvent) {
    const current = context.getStore();
    const c = current ?? (workspaceId ? { workspaceId, purpose: "connection_test", background: true } : undefined);
    if (!c) return provider.stream(req, onEvent);
    if (c.background && !c.uncapped) checkUsageCaps(c);
    let attempts = 0;
    const id = randomUUID();
    const started_at = Date.now();
    try {
      const r = await provider.stream({ ...req, metering: true }, (e) => {
        if (e.type === "request_usage") {
          attempts++;
          recordUsage(c, p, req.model, e.request);
        } else onEvent(e);
      });
      if (!attempts && !r.metered) recordUsage(c, p, req.model, { id, started_at, outcome: "completed", usage: r.usage, status: r.usageStatus ?? "reported" });
      return { ...r, metered: true };
    } catch (e) {
      const alreadyMeasured = typeof e === "object" && e !== null && measuredErrors.has(e);
      if (!attempts && !alreadyMeasured && !(e instanceof AgentError && e.requestSent === false)) recordUsage(c, p, req.model, { id, started_at, outcome: req.signal?.aborted ? "cancelled" : "failed", usage: e instanceof AgentError ? e.usage ?? noUsage() : noUsage(), status: e instanceof AgentError ? e.usageStatus ?? "unavailable" : "unavailable" });
      if (typeof e === "object" && e !== null) measuredErrors.add(e);
      throw e;
    }
  } };
}

export function ledgerSpend(where: string, ...params: (string | number)[]) {
  const r = db.prepare(`SELECT COALESCE(SUM(cost_usd),0) usd, COALESCE(SUM(input+output+cache_read+cache_write),0) tokens FROM usage_ledger WHERE ${where}`).get(...params) as { usd: number; tokens: number };
  return r;
}
export const monthSpend = (ws: string) => {
  backfillUsage();
  const month = new Date().toISOString().slice(0, 7);
  return { month, ...ledgerSpend("workspace_id=? AND started_at>=?", ws, Date.parse(`${month}-01T00:00:00Z`)) };
};
const DESCENDANTS = "WITH RECURSIVE d(id) AS (SELECT ? UNION ALL SELECT t.id FROM tickets t JOIN d ON t.parent_id=d.id) SELECT id FROM d";
export const treeSpend = (id: string) => { backfillUsage(); return ledgerSpend(`ticket_id IN (${DESCENDANTS})`, id); };
export function usageCaps(c: UsageContext) {
  const s = db.prepare("SELECT monthly_cap_usd,monthly_cap_tokens FROM workspace_settings WHERE workspace_id=?").get(c.workspaceId) as { monthly_cap_usd: number | null; monthly_cap_tokens: number | null } | undefined;
  const caps: { which: string; used: number; cap: number; usd: boolean }[] = [];
  const push = (name: string, limits: { usd: number | null; tokens: number | null }, used: { usd: number; tokens: number }) => {
    if (limits.usd !== null) caps.push({ which: `${name} cost`, cap: limits.usd, used: used.usd, usd: true });
    if (limits.tokens !== null) caps.push({ which: `${name} tokens`, cap: limits.tokens, used: used.tokens, usd: false });
  };
  if (s) {
    const m = monthSpend(c.workspaceId);
    push(`workspace ${m.month}`, { usd: s.monthly_cap_usd, tokens: s.monthly_cap_tokens }, m);
  }
  if (c.ticketId) {
    const ancestors = db.prepare(`WITH RECURSIVE a(id) AS (SELECT ? UNION ALL SELECT t.parent_id FROM tickets t JOIN a ON t.id=a.id WHERE t.parent_id IS NOT NULL)
      SELECT t.id,t.cap_usd usd,t.cap_tokens tokens,(SELECT key FROM projects WHERE id=t.project_id)||'-'||t.number AS key FROM tickets t
      WHERE t.id IN (SELECT id FROM a) AND t.workspace_id=? AND (t.cap_usd IS NOT NULL OR t.cap_tokens IS NOT NULL)`).all(c.ticketId, c.workspaceId) as { id: string; key: string; usd: number | null; tokens: number | null }[];
    for (const a of ancestors) push(a.key, a, treeSpend(a.id));
  }
  return caps;
}
export const capText = (c: { which: string; used: number; cap: number; usd: boolean }) => `${c.which} ${c.usd ? `$${Number(c.used.toFixed(4))}/$${Number(c.cap.toFixed(4))}` : `${c.used}/${c.cap}`}`;
export function checkUsageCaps(c: UsageContext) {
  const over = usageCaps(c).find((v) => v.used >= v.cap);
  if (over) throw new AgentError("SpendingCap", `spending cap reached: ${capText(over)}`);
}

// Backfill only evidence that actually exists. Older background work cannot be reconstructed. Stable source IDs make
// this safe to repeat, and metered events are never imported a second time. No run counters are changed here.
export function backfillUsage() {
  const rows = db.prepare(`SELECT e.run_id,e.seq,e.type,e.payload,e.created_at,r.model,r.provider_id,r.role,r.ticket_id,t.workspace_id,p.name,p.kind,p.auth_type,
    (SELECT json_extract(payload,'$.model') FROM events prior WHERE prior.run_id=e.run_id AND prior.seq<e.seq AND prior.type='run_started' ORDER BY seq DESC LIMIT 1) AS actual_model
    FROM events e JOIN runs r ON r.id=e.run_id JOIN tickets t ON t.id=r.ticket_id LEFT JOIN providers p ON p.id=r.provider_id
    WHERE e.type IN ('usage','reflection') AND json_extract(e.payload,'$.metered') IS NOT 1 AND json_extract(e.payload,'$.accounted') IS NOT 1 AND NOT EXISTS (SELECT 1 FROM usage_ledger l WHERE l.id='event:'||e.run_id||':'||e.seq)`).all() as Record<string, any>[];
  for (const r of rows) {
    const body = JSON.parse(r.payload);
    if (body.metered || (r.type === "reflection" && body.accounted)) continue;
    const u = r.type === "reflection" ? body.usage : body;
    if (!u) continue;
    const sameModel = !r.actual_model || r.actual_model === r.model || r.type === "reflection";
    recordUsage({ workspaceId: r.workspace_id, ticketId: r.ticket_id, runId: r.run_id, purpose: r.type === "reflection" ? "reflection" : sameModel ? r.role : "reviewer", background: r.type === "reflection" },
      { id: sameModel ? r.provider_id : undefined, name: sameModel ? r.name ?? "Environment" : "Historical reviewer", kind: sameModel ? r.kind ?? "unknown" : "unknown", billing: !sameModel ? "unknown" : r.kind === "ollama" ? "local" : r.auth_type === "oauth" ? "subscription" : "api_key" },
      r.type === "reflection" ? r.model : r.actual_model ?? r.model,
      { id: `event:${r.run_id}:${r.seq}`, usage: u, status: "reported", outcome: "completed", started_at: r.created_at }, true);
  }
  const old = db.prepare(`SELECT r.*,t.workspace_id,p.name,p.kind,p.auth_type FROM runs r JOIN tickets t ON t.id=r.ticket_id LEFT JOIN providers p ON p.id=r.provider_id
    WHERE r.started_at IS NOT NULL AND r.tokens_in+r.tokens_out+r.tokens_cached>0 AND NOT EXISTS (SELECT 1 FROM usage_ledger l WHERE l.run_id=r.id AND l.background=0)
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.type='usage')`).all() as Record<string, any>[];
  for (const r of old) recordUsage({ workspaceId: r.workspace_id, ticketId: r.ticket_id, runId: r.id, purpose: r.role },
    { id: r.provider_id, name: r.name ?? "Historical environment", kind: r.kind ?? "unknown", billing: r.kind === "ollama" ? "local" : r.auth_type === "oauth" ? "subscription" : "api_key" }, r.model,
    { id: `run:${r.id}`, started_at: r.started_at ?? Date.now(), outcome: r.status === "passed" ? "completed" : "failed", status: "reported", usage: { input: r.tokens_in, output: r.tokens_out, cache_read: r.tokens_cached, cache_write: 0 } }, true, r.cost_usd > 0 ? r.cost_usd : undefined);

}

const SUMS = `COUNT(*) calls,COUNT(DISTINCT run_id) runs,COALESCE(SUM(input),0) input_uncached,COALESCE(SUM(input+cache_write),0) tokens_in,
  COALESCE(SUM(output),0) tokens_out,COALESCE(SUM(cache_read),0) tokens_cached,COALESCE(SUM(cache_write),0) tokens_cache_write,
  COALESCE(SUM(input+output+cache_read+cache_write),0) tokens_total,COALESCE(SUM(cost_usd),0) cost_usd,
  COALESCE(SUM(completeness='reported'),0) reported,COALESCE(SUM(completeness='partial'),0) partial,COALESCE(SUM(completeness='unavailable'),0) unavailable,
  COALESCE(SUM(cost_usd IS NULL),0) unknown_price,COALESCE(SUM(billing_mode='subscription'),0) subscription_calls,COALESCE(SUM(billing_mode='local'),0) local_calls`;
const rates = (r: Record<string, any>): Record<string, any> => ({ ...r, cache_hit_rate: r.tokens_in + r.tokens_cached ? r.tokens_cached / (r.tokens_in + r.tokens_cached) : null });
export function usageSummary(ws: string) {
  backfillUsage();
  const q = (extra = "", where = "", params: (string | number)[] = []) => db.prepare(`SELECT ${extra}${SUMS} FROM usage_ledger l WHERE l.workspace_id=? ${where}`).all(ws, ...params) as Record<string, any>[];
  const totals = rates(q()[0]);
  const days = Array.from({ length: 14 }, (_, i) => {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    return { day, ...rates(q("", "AND l.started_at>=? AND l.started_at<?", [Date.parse(day), Date.parse(day) + 86_400_000])[0]) };
  });
  const models = q("provider_id,provider_name,provider_kind,model,billing_mode,", "GROUP BY provider_id,provider_name,provider_kind,model,billing_mode ORDER BY SUM(input+output+cache_read+cache_write) DESC").map(rates);
  const purposes = q("purpose,background,", "GROUP BY purpose,background ORDER BY background,purpose").map(rates);
  const tickets = db.prepare(`SELECT t.id,(SELECT key FROM projects WHERE id=t.project_id)||'-'||t.number AS key,t.title,${SUMS}
    FROM usage_ledger l JOIN tickets t ON t.id=l.ticket_id WHERE l.workspace_id=? AND t.hidden=0
    GROUP BY t.id ORDER BY SUM(input+output+cache_read+cache_write) DESC LIMIT 10`).all(ws).map((r) => rates(r as Record<string, any>));
  return { totals, execution: rates(q("", "AND background=0")[0]), background: rates(q("", "AND background=1")[0]), days, models, purposes, tickets,
    completeness: { complete_since: (db.prepare("SELECT complete_since FROM usage_accounting WHERE id=1").get() as { complete_since: number }).complete_since,
      historical_incomplete: !!db.prepare("SELECT 1 FROM runs r JOIN tickets t ON t.id=r.ticket_id WHERE t.workspace_id=? AND r.started_at < (SELECT complete_since FROM usage_accounting WHERE id=1) LIMIT 1").get(ws),
      partial: totals.partial ?? 0, unavailable: totals.unavailable ?? 0 } };
}

export function attributedUsage(column: "ticket_id" | "run_id", id: string, background?: boolean) {
  return rates(db.prepare(`SELECT ${SUMS} FROM usage_ledger WHERE ${column}=? ${background === undefined ? "" : "AND background=" + (background ? 1 : 0)}`).get(id) as Record<string, any>);
}

export function treeUsage(id: string, background?: boolean) {
  return rates(db.prepare(`SELECT ${SUMS} FROM usage_ledger WHERE ticket_id IN (${DESCENDANTS}) ${background === undefined ? "" : "AND background=" + (background ? 1 : 0)}`).get(id) as Record<string, any>);
}
