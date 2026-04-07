import { Mastra } from "@mastra/core/mastra";

import { createAssistantAgent } from "@/mastra/agents/assistant";
import { createMemoryTool } from "@/mastra/tools/memory";

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

  const assistant = createAssistantAgent({
    instructions: params.instructions,
    defaultModel: params.model,
    memoryTool,
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
