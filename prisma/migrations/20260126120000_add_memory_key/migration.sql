-- Add deterministic memoryKey for dedupe
ALTER TABLE "Memory" ADD COLUMN IF NOT EXISTS "memoryKey" TEXT;

-- Unique per user to prevent duplicates
CREATE UNIQUE INDEX IF NOT EXISTS "Memory_userId_memoryKey_key"
ON "Memory" ("userId", "memoryKey");
