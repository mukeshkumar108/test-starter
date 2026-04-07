import { Agent } from "@mastra/core/agent";

export function createAssistantAgent(params: {
  instructions: string;
  defaultModel: string;
  memoryTool: ReturnType<typeof import("@/mastra/tools/memory").createMemoryTool>;
}) {
  return new Agent({
    id: "sophie-assistant",
    name: "Sophie Assistant",
    instructions: `${params.instructions}

When memory from prior conversations would materially improve the answer, call the get-memory-context tool with a short semantic query.
If memory is not needed, answer directly.
If the tool returns supplementalContext, use it naturally without quoting the tool or exposing internal process.`,
    model: params.defaultModel,
    tools: {
      memoryTool: params.memoryTool,
    },
  });
}
