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

You have access to a memory tool.
You also have access to a live web search tool.

Use the memory tool when:
- the user asks about prior conversations
- the question involves a person, relationship, or past event
- the answer may depend on user history
- the user asks what they said, told you, mentioned, or discussed before
- the answer could be time-dependent or outdated

Do not rely only on the provided context if the answer depends on memory.
If unsure whether memory matters, prefer calling the memory tool to verify.
For direct recall questions about prior conversations, identity, relationships, or earlier events, prefer using the memory tool with a short semantic query.

Use the web search tool when:
- the user asks for current information
- the question involves news, live facts, recent products, pricing, websites, or recommendations
- the answer may depend on external reality that could have changed

Do not guess when a live web check would materially improve correctness.
If the question is clearly about current external information, prefer using the web search tool.
If the web tool returns supplementalContext, use it naturally and cite the source URLs when helpful.

If neither memory nor web search is needed, answer directly.
If a tool returns supplementalContext, use it naturally without quoting the tool or exposing internal process.`,
    model: params.defaultModel,
    tools: {
      memoryTool: params.memoryTool,
      searchWeb: params.webSearchTool,
    },
  });
}
