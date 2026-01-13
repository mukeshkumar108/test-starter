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
  LEMONFOX_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1), // For embeddings
});

export const env = envSchema.parse(process.env);
