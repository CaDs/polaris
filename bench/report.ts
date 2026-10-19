// node bench/report.ts <results.jsonl> [more.jsonl ...]
// One markdown row per level, one column group per tag (in file order): passes/runs, mean turns, mean wall minutes.
import { readFileSync } from "node:fs";

type Row = { tag: string; level: string; pass: boolean; turns: number; wall_secs: number };
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function report(files: string[]) {
  const rows: Row[] = files.flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const tags = [...new Set(rows.map((r) => r.tag))];
  const levels = [...new Set(rows.map((r) => r.level))].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const cell = (rs: Row[]) =>
    rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length} | ${Math.round(mean(rs.map((r) => r.turns)))} | ${(mean(rs.map((r) => r.wall_secs)) / 60).toFixed(1)}` : "– | – | –";
  return [
    `| level | ${tags.map((t) => `${t} pass | ${t} turns | ${t} min`).join(" | ")} |`,
    `|---|${tags.map(() => "---:|---:|---:").join("|")}|`,
    ...[...levels, "all"].map((l) => `| ${l} | ${tags.map((t) => cell(rows.filter((r) => r.tag === t && (l === "all" || r.level === l)))).join(" | ")} |`),
  ].join("\n");
}

if (import.meta.main) {
  const files = process.argv.slice(2);
  if (!files.length) throw new Error("usage: node bench/report.ts <results.jsonl> [more.jsonl ...]");
  console.log(report(files));
}
