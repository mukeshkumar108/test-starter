-- Add persona-scoped message history index for contextBuilder
CREATE INDEX IF NOT EXISTS "Message_userId_personaId_createdAt_idx"
ON "Message" ("userId", "personaId", "createdAt");
