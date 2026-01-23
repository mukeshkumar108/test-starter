-- Add persona scoping for memories
ALTER TABLE "Memory" ADD COLUMN IF NOT EXISTS "personaId" TEXT;

-- Index for persona-scoped retrieval
CREATE INDEX IF NOT EXISTS "Memory_userId_personaId_type_idx"
ON "Memory" ("userId", "personaId", "type");
