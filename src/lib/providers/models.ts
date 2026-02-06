// Central model configuration
// All model names must be defined here to avoid hardcoding across services

export const MODELS = {
  // Chat models per persona
  CHAT: {
    MENTOR: "meta-llama/llama-4-maverick",
    SUPPORTIVE: "meta-llama/llama-4-maverick", 
    COACH: "meta-llama/llama-4-maverick",
    CREATIVE: "meta-llama/llama-4-maverick",
    ANALYTICAL: "meta-llama/llama-4-maverick",
  },
  
  // Cheap model for shadow processing/judging
  JUDGE: "xiaomi/mimo-v2-flash",

  // Session summaries
  SUMMARY: "amazon/nova-micro-v1",
  
  // Embeddings model
  EMBEDDINGS: "text-embedding-3-small",
} as const;

// Type helpers
export type ChatModel = typeof MODELS.CHAT[keyof typeof MODELS.CHAT];
export type JudgeModel = typeof MODELS.JUDGE;
export type SummaryModel = typeof MODELS.SUMMARY;
export type EmbeddingsModel = typeof MODELS.EMBEDDINGS;

// Get chat model for persona
export function getChatModelForPersona(personaSlug: string): ChatModel {
  const slug = personaSlug.toUpperCase() as keyof typeof MODELS.CHAT;
  return MODELS.CHAT[slug] || MODELS.CHAT.MENTOR;
}
