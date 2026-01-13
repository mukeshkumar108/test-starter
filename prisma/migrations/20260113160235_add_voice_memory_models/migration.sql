-- CreateEnum
CREATE TYPE "public"."MessageRole" AS ENUM ('user', 'assistant');

-- CreateEnum
CREATE TYPE "public"."MemoryType" AS ENUM ('PROFILE', 'PEOPLE', 'PROJECT', 'OPEN_LOOP');

-- CreateTable
CREATE TABLE "public"."PersonaProfile" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "promptPath" TEXT NOT NULL,
    "llmModel" TEXT NOT NULL,
    "ttsVoiceId" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonaProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."UserSeed" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserSeed_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SessionState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personaId" TEXT NOT NULL,
    "state" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Message" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personaId" TEXT,
    "role" "public"."MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "audioUrl" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Memory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "public"."MemoryType" NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1536),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SummarySpine" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL DEFAULT 'default',
    "version" INTEGER NOT NULL DEFAULT 1,
    "content" TEXT NOT NULL,
    "messageCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SummarySpine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PersonaProfile_slug_key" ON "public"."PersonaProfile"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "UserSeed_userId_key" ON "public"."UserSeed"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionState_userId_personaId_key" ON "public"."SessionState"("userId", "personaId");

-- CreateIndex
CREATE INDEX "Message_userId_createdAt_idx" ON "public"."Message"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Memory_userId_type_idx" ON "public"."Memory"("userId", "type");

-- CreateIndex
CREATE INDEX "SummarySpine_userId_conversationId_idx" ON "public"."SummarySpine"("userId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "SummarySpine_userId_conversationId_version_key" ON "public"."SummarySpine"("userId", "conversationId", "version");

-- AddForeignKey
ALTER TABLE "public"."UserSeed" ADD CONSTRAINT "UserSeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SessionState" ADD CONSTRAINT "SessionState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SessionState" ADD CONSTRAINT "SessionState_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "public"."PersonaProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Memory" ADD CONSTRAINT "Memory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SummarySpine" ADD CONSTRAINT "SummarySpine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
