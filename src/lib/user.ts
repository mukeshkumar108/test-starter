import { prisma } from "./prisma";

export async function getUserByClerkId(clerkUserId: string) {
  return prisma.user.findUnique({
    where: { clerkUserId },
  });
}

export async function upsertUser(params: {
  clerkUserId: string;
  email?: string | null;
}) {
  const { clerkUserId, email } = params;

  return prisma.user.upsert({
    where: { clerkUserId },
    update: { email: email ?? undefined },
    create: { clerkUserId, email: email ?? undefined },
  });
}
