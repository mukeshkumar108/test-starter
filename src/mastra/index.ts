import { Mastra } from "@mastra/core/mastra";

import { createAssistantAgent } from "@/mastra/agents/assistant";
import { createMemoryTool } from "@/mastra/tools/memory";
import { createWebSearchTool } from "@/mastra/tools/web";

export function createMastraRuntime(params: {
  userId: string;
  requestId: string;
  now: Date;
  instructions: string;
  model: string;
}) {
  const memoryTool = createMemoryTool({
    userId: params.userId,
    requestId: params.requestId,
    now: params.now,
  });
  const webSearchTool = createWebSearchTool({
    requestId: params.requestId,
  });

  const assistant = createAssistantAgent({
    instructions: params.instructions,
    defaultModel: params.model,
    memoryTool,
    webSearchTool,
  });

  const mastra = new Mastra({
    agents: {
      assistant,
    },
  });

  return {
    mastra,
    assistant,
  };
}
