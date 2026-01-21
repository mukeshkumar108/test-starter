import { PrismaClient } from "@prisma/client";

export interface RegressContext {
  prisma: PrismaClient;
  userId: string;
  personaId: string;
}

export interface RegressResult {
  name: string;
  ok: boolean;
  evidence: Record<string, unknown>;
}
