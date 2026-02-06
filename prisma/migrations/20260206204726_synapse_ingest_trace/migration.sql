-- CreateTable
CREATE TABLE "public"."SynapseIngestTrace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "requestId" TEXT,
    "role" TEXT NOT NULL,
    "status" INTEGER,
    "ms" INTEGER,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SynapseIngestTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SynapseIngestTrace_userId_personaId_createdAt_idx" ON "public"."SynapseIngestTrace"("userId", "personaId", "createdAt");

-- CreateIndex
CREATE INDEX "SynapseIngestTrace_sessionId_createdAt_idx" ON "public"."SynapseIngestTrace"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "SynapseIngestTrace_ok_createdAt_idx" ON "public"."SynapseIngestTrace"("ok", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."SynapseIngestTrace" ADD CONSTRAINT "SynapseIngestTrace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SynapseIngestTrace" ADD CONSTRAINT "SynapseIngestTrace_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "public"."PersonaProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
