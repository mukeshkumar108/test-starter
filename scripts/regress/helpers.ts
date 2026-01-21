import { prisma } from "@/lib/prisma";
import { storeMemory } from "@/lib/services/memory/memoryStore";
import { MemoryType, TodoKind, TodoStatus } from "@prisma/client";

const QA_PREFIX = "qa_regress_";

export async function createQaUser(prefix: string = QA_PREFIX) {
  const clerkUserId = `${prefix}${Date.now()}`;
  const user = await prisma.user.create({
    data: {
      clerkUserId,
    },
  });
  return user;
}

export async function getPersonaIdBySlug(slug: string) {
  const persona = await prisma.personaProfile.findUnique({
    where: { slug },
    select: { id: true },
  });
  if (!persona) {
    throw new Error(`Persona not found for slug: ${slug}`);
  }
  return persona.id;
}

export async function seedMemory(
  userId: string,
  type: MemoryType,
  content: string,
  metadata?: Record<string, unknown>
) {
  await storeMemory(userId, type, content, metadata);
}

export async function seedTodo(
  userId: string,
  personaId: string,
  content: string,
  status: TodoStatus = "PENDING",
  kind: TodoKind = "COMMITMENT"
) {
  return prisma.todo.create({
    data: {
      userId,
      personaId,
      content,
      status,
      kind,
    },
  });
}

export async function cleanupQaUser(userId: string) {
  await prisma.sessionSummary.deleteMany({ where: { userId } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.sessionState.deleteMany({ where: { userId } });
  await prisma.summarySpine.deleteMany({ where: { userId } });
  await prisma.todo.deleteMany({ where: { userId } });
  await prisma.memory.deleteMany({ where: { userId } });
  await prisma.message.deleteMany({ where: { userId } });
  await prisma.userSeed.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
}

export function isQaClerkId(clerkUserId: string) {
  return clerkUserId.startsWith(QA_PREFIX);
}
