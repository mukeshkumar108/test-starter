CREATE TABLE IF NOT EXISTS "public"."Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "public"."SessionSummary" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "metadata" JSONB,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SessionSummary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "SessionSummary_sessionId_key" ON "public"."SessionSummary"("sessionId");
CREATE INDEX IF NOT EXISTS "Session_userId_personaId_lastActivityAt_idx" ON "public"."Session"("userId", "personaId", "lastActivityAt");
CREATE INDEX IF NOT EXISTS "Session_userId_personaId_startedAt_idx" ON "public"."Session"("userId", "personaId", "startedAt");
CREATE INDEX IF NOT EXISTS "SessionSummary_userId_personaId_createdAt_idx" ON "public"."SessionSummary"("userId", "personaId", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Session_userId_fkey'
  ) THEN
    ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Session_personaId_fkey'
  ) THEN
    ALTER TABLE "public"."Session" ADD CONSTRAINT "Session_personaId_fkey"
    FOREIGN KEY ("personaId") REFERENCES "public"."PersonaProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SessionSummary_sessionId_fkey'
  ) THEN
    ALTER TABLE "public"."SessionSummary" ADD CONSTRAINT "SessionSummary_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "public"."Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SessionSummary_userId_fkey'
  ) THEN
    ALTER TABLE "public"."SessionSummary" ADD CONSTRAINT "SessionSummary_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SessionSummary_personaId_fkey'
  ) THEN
    ALTER TABLE "public"."SessionSummary" ADD CONSTRAINT "SessionSummary_personaId_fkey"
    FOREIGN KEY ("personaId") REFERENCES "public"."PersonaProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
