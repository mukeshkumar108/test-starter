// Central model configuration
// All model names must be defined here to avoid hardcoding across services

export const MODELS = {
  // Chat models per persona
  CHAT: {
    MENTOR: "nousresearch/hermes-4-70b",
    SUPPORTIVE: "nousresearch/hermes-4-70b", 
    COACH: "nousresearch/hermes-4-70b",
    CREATIVE: "nousresearch/hermes-4-70b",
    ANALYTICAL: "nousresearch/hermes-4-70b",
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
