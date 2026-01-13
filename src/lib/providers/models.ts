// Central model configuration
// All model names must be defined here to avoid hardcoding across services

export const MODELS = {
  // Chat models per persona
  CHAT: {
    MENTOR: "anthropic/claude-3-5-sonnet",
    SUPPORTIVE: "anthropic/claude-3-5-sonnet", 
    COACH: "anthropic/claude-3-5-sonnet",
    CREATIVE: "anthropic/claude-3-5-sonnet",
    ANALYTICAL: "anthropic/claude-3-5-sonnet",
  },
  
  // Cheap model for shadow processing/judging
  JUDGE: "anthropic/claude-3-haiku",
  
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