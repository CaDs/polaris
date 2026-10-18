import { readFileSync } from "node:fs";
import { reviewTools, type Tool } from "./agent/tools.ts";
import { AgentError, type Finding } from "./agent/types.ts";

// M8 model review (see SPEC "Model review (M8)"): after the test gate, the run's own model reviews the change with a
// read-only toolset plus submit_review. The orchestration (rounds, fixing, fail-open) lives in runs.ts.

export const MAX_REVIEW_ROUNDS = 3;
// Not versioned like the worker prompt, same as the planner's.
export const REVIEWER_PROMPT = readFileSync(new URL("./agent/prompts/reviewer.md", import.meta.url), "utf8");

export type Review = { verdict: "approve" | "request_changes"; findings: Finding[] };

export const findingsText = (findings: Finding[]) => findings.map((f) => `- ${f.file}${f.line ? `:${f.line}` : ""} — ${f.problem} → ${f.fix}`).join("\n");

export function reviewTask(t: { title: string; spec: string }, o: { base_sha: string; test: string; wiki?: string }) {
  return [
    ...(o.wiki ? [o.wiki] : []),
    `# Ticket\n\n# ${t.title}${t.spec ? `\n\n${t.spec}` : ""}`,
    `# Change under review\n\nThe worker's change is uncommitted in the working directory, on top of commit ${o.base_sha}. The test gate${o.test.trim() ? ` (\`${o.test}\`)` : ""} passed. Inspect it with \`git status --short\` and \`git diff\`, and read the new files.`,
  ].join("\n\n");
}

const str = (v: unknown, what: string, max = 5000) => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new AgentError("InvalidArguments", `${what} must be a non-empty string of at most ${max} chars`);
  return v.trim();
};

// Fills `out`, which ends the reviewer's loop (runAgent's finished check).
export function submitReview(out: { review?: Review }): Tool {
  return {
    def: {
      name: "submit_review",
      description: "Submit your verdict and end the review. Call it exactly once, after inspecting the change.",
      input_schema: {
        type: "object",
        properties: {
          verdict: { type: "string", enum: ["approve", "request_changes"] },
          findings: {
            type: "array",
            description: "Required (at least one) for request_changes; leave empty to approve",
            items: {
              type: "object",
              properties: {
                file: { type: "string" },
                line: { type: "integer", description: "Line number, when known" },
                problem: { type: "string", description: "What is wrong, and the input or path that triggers it" },
                fix: { type: "string", description: "What the worker should change" },
              },
              required: ["file", "problem", "fix"],
            },
          },
        },
        required: ["verdict"],
      },
    },
    async run(input) {
      const { verdict } = input;
      if (verdict !== "approve" && verdict !== "request_changes") throw new AgentError("InvalidArguments", '"verdict" must be "approve" or "request_changes"');
      const raw = input.findings ?? [];
      if (!Array.isArray(raw)) throw new AgentError("InvalidArguments", '"findings" must be an array of {file, line?, problem, fix}');
      if (verdict === "request_changes" && !raw.length) throw new AgentError("InvalidArguments", 'request_changes needs at least one finding: {file, line?, problem, fix}. If you found no real bug, approve.');
      const findings = raw.map((f: Record<string, unknown>, i) => {
        if (!f || typeof f !== "object") throw new AgentError("InvalidArguments", `findings[${i}] must be an object {file, line?, problem, fix}`);
        if (f.line !== undefined && !Number.isInteger(f.line)) throw new AgentError("InvalidArguments", `findings[${i}].line must be an integer`);
        return { file: str(f.file, `findings[${i}].file`, 500), ...(f.line === undefined ? {} : { line: f.line as number }), problem: str(f.problem, `findings[${i}].problem`), fix: str(f.fix, `findings[${i}].fix`) };
      });
      out.review = { verdict, findings: verdict === "approve" ? [] : findings };
      return "Review submitted.";
    },
  };
}

export const reviewerTools = (out: { review?: Review }): Tool[] => [...reviewTools, submitReview(out)];
