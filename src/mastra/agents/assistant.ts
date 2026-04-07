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

You have access to a memory tool.

Use the memory tool when:
- the user asks about prior conversations
- the question involves a person, relationship, or past event
- the answer may depend on user history
- the user asks what they said, told you, mentioned, or discussed before
- the answer could be time-dependent or outdated

Do not rely only on the provided context if the answer depends on memory.
If unsure whether memory matters, prefer calling the memory tool to verify.
For direct recall questions about prior conversations, identity, relationships, or earlier events, prefer using the memory tool with a short semantic query.

If memory is not needed, answer directly.
If the tool returns supplementalContext, use it naturally without quoting the tool or exposing internal process.`,
    model: params.defaultModel,
    tools: {
      memoryTool: params.memoryTool,
    },
  });
}
