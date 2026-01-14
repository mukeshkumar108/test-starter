// Central model configuration
// All model names must be defined here to avoid hardcoding across services

export const MODELS = {
  // Chat models per persona
  CHAT: {
    MENTOR: "gryphe/mythomax-l2-13b",
    SUPPORTIVE: "gryphe/mythomax-l2-13b", 
    COACH: "gryphe/mythomax-l2-13b",
    CREATIVE: "gryphe/mythomax-l2-13b",
    ANALYTICAL: "gryphe/mythomax-l2-13b",
  },
  
  // Cheap model for shadow processing/judging
  JUDGE: "meta-llama/llama-3-8b-instruct",
  
  // Embeddings model
  EMBEDDINGS: "openai/text-embedding-3-small",
} as const;

// Type helpers
export type ChatModel = typeof MODELS.CHAT[keyof typeof MODELS.CHAT];
export type JudgeModel = typeof MODELS.JUDGE;
export type EmbeddingsModel = typeof MODELS.EMBEDDINGS;

// Get chat model for persona
export function getChatModelForPersona(personaSlug: string): ChatModel {
  const slug = personaSlug.toUpperCase() as keyof typeof MODELS.CHAT;
  return MODELS.CHAT[slug] || MODELS.CHAT.MENTOR;
}
