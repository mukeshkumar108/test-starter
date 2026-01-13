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

export async function ensureUserByClerkId(clerkUserId: string) {
  const existing = await prisma.user.findUnique({
    where: { clerkUserId },
  });

  if (existing) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[api/chat] ensured user", {
        clerkId: clerkUserId,
        createdOrFound: "found",
      });
    }
    return existing;
  }

  try {
    const created = await prisma.user.create({
      data: { clerkUserId },
    });

    if (process.env.NODE_ENV !== "production") {
      console.log("[api/chat] ensured user", {
        clerkId: clerkUserId,
        createdOrFound: "created",
      });
    }

    return created;
  } catch (error) {
    const fallback = await prisma.user.findUnique({
      where: { clerkUserId },
    });
    if (fallback) {
      if (process.env.NODE_ENV !== "production") {
        console.log("[api/chat] ensured user", {
          clerkId: clerkUserId,
          createdOrFound: "found",
        });
      }
      return fallback;
    }
    throw error;
  }
}
