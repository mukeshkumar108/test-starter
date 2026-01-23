-- Ensure Todo table exists (for shadow DB replay)
CREATE TABLE IF NOT EXISTS "public"."Todo" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "personaId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Todo_pkey" PRIMARY KEY ("id")
);

-- Optional: basic indexes
CREATE INDEX IF NOT EXISTS "Todo_userId_personaId_status_idx"
  ON "public"."Todo" ("userId", "personaId", "status");

-- Optional: FKs (only if your schema expects them)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Todo_userId_fkey') THEN
    ALTER TABLE "public"."Todo"
      ADD CONSTRAINT "Todo_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "public"."User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Todo_personaId_fkey') THEN
    ALTER TABLE "public"."Todo"
      ADD CONSTRAINT "Todo_personaId_fkey"
      FOREIGN KEY ("personaId") REFERENCES "public"."PersonaProfile"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
-- Create TodoKind enum type

DO $$
BEGIN
  CREATE TYPE "public"."TodoKind" AS ENUM ('OPEN_LOOP', 'COMMITMENT', 'HABIT', 'REMINDER');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "public"."Todo"
ADD COLUMN IF NOT EXISTS "kind" "public"."TodoKind" NOT NULL DEFAULT 'OPEN_LOOP';
