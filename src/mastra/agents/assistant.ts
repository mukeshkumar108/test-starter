import { Agent } from "@mastra/core/agent";

export function createAssistantAgent(params: {
  instructions: string;
  defaultModel: string;
  memoryTool: ReturnType<typeof import("@/mastra/tools/memory").createMemoryTool>;
  webSearchTool: ReturnType<typeof import("@/mastra/tools/web").createWebSearchTool>;
}) {
  return new Agent({
    id: "sophie-assistant",
    name: "Sophie Assistant",
    instructions: `${params.instructions}

You have access to a memory tool and a web search tool.

Call the memory tool when the question depends on past conversations, people, relationships, or facts that could not be known from this session alone. Use a short semantic query that captures what needs to be recalled.

Call the web search tool when the answer requires current external information — news, live facts, prices, weather, or anything that may have changed.

Answer directly when neither tool is needed.

When a tool returns results, use them naturally. Do not quote tool names, expose internal structure, or explain that you used a tool.`,
    model: params.defaultModel,
    tools: {
      memoryTool: params.memoryTool,
      searchWeb: params.webSearchTool,
    },
  });
}
