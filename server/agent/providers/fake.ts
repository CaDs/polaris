import type { Block, Provider, ProviderRequest, Usage } from "../types.ts";

// Scripted provider for tests and replays: returns the scripted assistant turns in order
// and records (a snapshot of) every request it received.
export type Turn = Block[] | ((req: ProviderRequest) => Block[]) | { blocks: Block[]; stopReason: string };

// usage may depend on the request (e.g. grow with the conversation, to drive compaction).
export function fakeProvider(script: Turn[], usage: Usage | ((req: ProviderRequest) => Usage) = { input: 10, output: 5, cache_read: 0, cache_write: 0 }) {
  const requests: ProviderRequest[] = [];
  const provider: Provider = {
    async stream(req, onEvent) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const turn = script[requests.length - 1];
      if (!turn) throw new Error(`fake provider: script has no turn ${requests.length}`);
      const content = typeof turn === "function" ? turn(req) : "blocks" in turn ? turn.blocks : turn;
      for (const b of content) {
        if (b.type === "reasoning" && typeof (b.data as { thinking?: unknown })?.thinking === "string") onEvent({ type: "reasoning", text: (b.data as { thinking: string }).thinking });
        if (b.type === "text") onEvent({ type: "text", text: b.text });
        if (b.type === "tool_use") onEvent({ type: "tool_use", id: b.id, name: b.name });
      }
      const stopReason = !Array.isArray(turn) && typeof turn === "object" ? turn.stopReason : content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
      return { message: { role: "assistant", content }, usage: typeof usage === "function" ? usage(req) : usage, stopReason };
    },
  };
  return { provider, requests };
}
