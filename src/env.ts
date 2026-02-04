import { z } from "zod";

// Env module: centralizes boot-time validation so config errors fail fast.
// Keep all process.env access here so other modules use typed values only.
// To add a new variable, declare it in the schema below and in .env.example.

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  POSTGRES_PRISMA_URL: z.string().min(1),
  POSTGRES_URL_NON_POOLING: z.string().min(1),
  BLOB_READ_WRITE_TOKEN: z.string().min(1),
  CLERK_WEBHOOK_SECRET: z.string().min(1),
  
  // Voice pipeline
  OPENROUTER_API_KEY: z.string().min(1),
  ELEVENLABS_API_KEY: z.string().min(1),
  ELEVENLABS_DEFAULT_VOICE_ID: z.string().min(1),
  ELEVENLABS_VOICE_WILLIAM: z.string().min(1).optional(),
  ELEVENLABS_VOICE_ISABELLA: z.string().min(1).optional(),
  ELEVENLABS_VOICE_SOPHIE: z.string().min(1).optional(),
  ELEVENLABS_VOICE_ALEXANDER: z.string().min(1).optional(),
  LEMONFOX_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1), // For embeddings
  SYNAPSE_BASE_URL: z.string().min(1).optional(),
  SYNAPSE_TENANT_ID: z.string().min(1).optional(),
  SYNAPSE_TIMEOUT_MS: z.string().optional(),
  ADMIN_SECRET: z.string().min(1).optional(),
  FEATURE_MEMORY_CURATOR: z.string().optional(),
  FEATURE_CONTEXT_DEBUG: z.string().optional(),
  FEATURE_SESSION_SUMMARY: z.string().optional(),
  FEATURE_SUMMARY_TEST_STALL: z.string().optional(),
  FEATURE_JUDGE_TEST_MODE: z.string().optional(),
  FEATURE_SUMMARY_SPINE_GLOBAL: z.string().optional(),
  FEATURE_ENTITY_PIPELINE: z.string().optional(),
  FEATURE_SYNAPSE_BRIEF: z.string().optional(),
  FEATURE_SYNAPSE_INGEST: z.string().optional(),
  SUMMARY_TIMEOUT_MS: z.string().optional(),
});

export const env = envSchema.parse(process.env);
