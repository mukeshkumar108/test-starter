/*
  Warnings:

  - You are about to drop the column `updatedAt` on the `Todo` table. All the data in the column will be lost.
  - The `status` column on the `Todo` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "public"."TodoStatus" AS ENUM ('PENDING', 'COMPLETED', 'SKIPPED');

-- AlterTable
ALTER TABLE "public"."Memory" ADD COLUMN     "pinned" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "public"."PersonaProfile" ADD COLUMN     "enableSummarySpine" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "public"."SessionState" ADD COLUMN     "rollingSummary" TEXT;

-- AlterTable
ALTER TABLE "public"."Todo" DROP COLUMN "updatedAt",
ADD COLUMN     "completedAt" TIMESTAMP(3),
DROP COLUMN "status",
ADD COLUMN     "status" "public"."TodoStatus" NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "Todo_userId_personaId_status_idx" ON "public"."Todo"("userId", "personaId", "status");

-- CreateIndex
CREATE INDEX "Todo_userId_personaId_kind_status_dedupeKey_idx" ON "public"."Todo"("userId", "personaId", "kind", "status", "dedupeKey");
