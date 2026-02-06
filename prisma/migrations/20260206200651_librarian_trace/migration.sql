-- CreateTable
CREATE TABLE "public"."LibrarianTrace" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "sessionId" TEXT,
    "requestId" TEXT,
    "kind" TEXT NOT NULL,
    "transcript" TEXT,
    "bouncer" JSONB,
    "memoryQuery" JSONB,
    "memoryResponse" JSONB,
    "supplementalContext" TEXT,
    "brief" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibrarianTrace_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LibrarianTrace_userId_personaId_createdAt_idx" ON "public"."LibrarianTrace"("userId", "personaId", "createdAt");

-- CreateIndex
CREATE INDEX "LibrarianTrace_sessionId_idx" ON "public"."LibrarianTrace"("sessionId");

-- AddForeignKey
ALTER TABLE "public"."LibrarianTrace" ADD CONSTRAINT "LibrarianTrace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."LibrarianTrace" ADD CONSTRAINT "LibrarianTrace_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "public"."PersonaProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
