// Ignore file metadata (---/+++), counting only lines inside unified hunks.
export function diffScope(text: string) {
  const files: { name: string; added: number; removed: number }[] = [];
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files.push({ name: line.replace(/^diff --git a\/.* b\//, ""), added: 0, removed: 0 });
      inHunk = false;
    } else if (line.startsWith("@@")) inHunk = true;
    else if (inHunk && files.length) {
      if (line.startsWith("+")) files.at(-1)!.added++;
      if (line.startsWith("-")) files.at(-1)!.removed++;
    }
  }
  return { files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
}

export function scopeLine(text: string) {
  const s = diffScope(text);
  return `${s.files.length} file${s.files.length === 1 ? "" : "s"} +${s.added} −${s.removed}`;
}

// Test output is a tail, not necessarily the whole log. Never infer success from it;
// the gate's passed flag is authoritative. Use the last summary, not an earlier sub-suite.
export function testCounts(output: string): string | null {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, "");
  const node = [...clean.matchAll(/^[ℹ#]\s*pass\s+(\d+)\s*$/gm)].at(-1);
  if (node) {
    const skipped = [...clean.slice(node.index).matchAll(/^[ℹ#]\s*skipped\s+(\d+)\s*$/gm)].at(-1);
    return `${node[1]} passed${skipped ? `, ${skipped[1]} skipped` : ""}`;
  }
  const jest = [...clean.matchAll(/Tests:\s*([^\n]+)/g)].at(-1);
  const passed = jest?.[1].match(/(\d+)\s+passed/);
  if (passed) {
    const skipped = jest![1].match(/(\d+)\s+skipped/);
    return `${passed[1]} passed${skipped ? `, ${skipped[1]} skipped` : ""}`;
  }
  const pytest = [...clean.matchAll(/(?:^|[=,\s])(\d+) passed\b[^\n]*/gm)].at(-1);
  if (pytest) {
    const skipped = pytest[0].match(/(\d+) skipped/);
    return `${pytest[1]} passed${skipped ? `, ${skipped[1]} skipped` : ""}`;
  }
  return null;
}
