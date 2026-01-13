// Central model configuration
// All model names must be defined here to avoid hardcoding across services

export const MODELS = {
  // Chat models per persona
  CHAT: {
    MENTOR: "sao10k/l3.1-euryale-70b",
    SUPPORTIVE: "sao10k/l3.1-euryale-70b", 
    COACH: "sao10k/l3.1-euryale-70b",
    CREATIVE: "sao10k/l3.1-euryale-70b",
    ANALYTICAL: "sao10k/l3.1-euryale-70b",
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
