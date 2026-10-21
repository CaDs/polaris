// Models write markdown in slightly different dialects; this evens them out before rendering (web/Wiki.tsx Markdown), so
// every model's reply looks the same. Pure text in, CommonMark + GFM out. Code blocks are left exactly as written.
export function normalizeMarkdown(src: string) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | null = null; // the open fence's marker, while inside a code block
  for (let line of lines) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (f && f[0] === fence[0] && f.length >= fence.length && !line.trim().slice(f.length).trim()) fence = null;
      out.push(line);
      continue;
    }
    if (f) {
      if (out.length && out.at(-1)!.trim()) out.push(""); // a fence glued to a paragraph
      fence = f;
      out.push(line);
      continue;
    }
    line = line
      .replace(/^(\s*)[•●▪◦‣∙·]\s*/, "$1- ") // typographic bullets
      .replace(/^(\s*)[–—]\s+/, "$1- ") // dash bullets
      .replace(/^(\s*)(\d{1,3})\)\s+/, "$1$2. ") // "1)" numbering
      .replace(/^(#{1,6})([^#\s])/, "$1 $2"); // "##Heading"
    const prev = out.at(-1)?.trim() ?? "";
    const block = /^\s*([-*+]\s|\d{1,3}\.\s|#{1,6}\s|>|\|)/.test(line);
    const prevBlock = /^\s*([-*+]\s|\d{1,3}\.\s|>|\|)/.test(prev);
    // A list, heading, quote or table needs a blank line after a paragraph line (some renderers, and some models, skip it).
    if (block && prev && !prevBlock && !/^#{1,6}\s/.test(prev)) out.push("");
    out.push(line);
  }
  if (fence) out.push(fence); // still streaming, or the model forgot: close the block instead of swallowing the rest
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Whether a link's visible text hides where it goes: true unless the text is the address itself (autolinks, bare URLs).
// The renderer then appends the host, so "[Re-authenticate Polaris](https://evil.example)" shows "(evil.example)".
export function linkHost(children: unknown, url: URL): boolean {
  const text = (Array.isArray(children) ? children : [children]).every((c) => typeof c === "string") ? [children].flat().join("") : null;
  const bare = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return text === null || (bare(text) !== bare(url.href));
}
