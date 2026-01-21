-- Add dedupeKey column + composite index for todo dedupe
ALTER TABLE "Todo" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
CREATE INDEX IF NOT EXISTS "Todo_userId_personaId_kind_status_dedupeKey_idx"
  ON "Todo" ("userId", "personaId", "kind", "status", "dedupeKey");
