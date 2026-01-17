// Central model configuration
// All model names must be defined here to avoid hardcoding across services

export const MODELS = {
  // Chat models per persona
  CHAT: {
    MENTOR: "allenai/olmo-3.1-32b-think",
    SUPPORTIVE: "allenai/olmo-3.1-32b-think", 
    COACH: "allenai/olmo-3.1-32b-think",
    CREATIVE: "allenai/olmo-3.1-32b-think",
    ANALYTICAL: "allenai/olmo-3.1-32b-think",
  },
  
  // Cheap model for shadow processing/judging
  JUDGE: "openai/gpt-4o-mini",
  
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
