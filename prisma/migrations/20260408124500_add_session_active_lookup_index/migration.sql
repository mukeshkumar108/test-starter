-- CreateIndex
CREATE INDEX "Session_userId_personaId_endedAt_lastActivityAt_idx"
ON "public"."Session"("userId", "personaId", "endedAt", "lastActivityAt");
