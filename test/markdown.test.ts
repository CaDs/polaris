import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeMarkdown } from "../web/markdown.ts";

// The model-markdown normalizer (web/markdown.ts): one dialect for every model's reply.
test("normalizeMarkdown evens out model dialects and leaves code alone", () => {
  assert.equal(normalizeMarkdown("Steps:\r\n• one\r\n• two"), "Steps:\n\n- one\n- two"); // bullets, CRLF, blank line before a list
  assert.equal(normalizeMarkdown("Plan\n1) read\n2) write"), "Plan\n\n1. read\n2. write");
  assert.equal(normalizeMarkdown("— dash item\n– en dash"), "- dash item\n- en dash");
  assert.equal(normalizeMarkdown("##Heading\ntext"), "## Heading\ntext");
  assert.equal(normalizeMarkdown("Results:\n| a | b |\n|---|---|\n| 1 | 2 |"), "Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |"); // a table after a paragraph
  assert.equal(normalizeMarkdown("a\n\n\n\nb"), "a\n\nb");
  assert.equal(normalizeMarkdown("Run this:\n```sh\n• not a bullet\n1) not a list\n```\nafter"), "Run this:\n\n```sh\n• not a bullet\n1) not a list\n```\nafter");
  assert.equal(normalizeMarkdown("Partial:\n```ts\nconst x = 1;"), "Partial:\n\n```ts\nconst x = 1;\n```"); // streaming: an open fence is closed
  assert.equal(normalizeMarkdown("- a\n  - nested\n- b"), "- a\n  - nested\n- b"); // already fine: untouched
  assert.equal(normalizeMarkdown("## Title\n- item"), "## Title\n- item");
});
