import { prisma } from "@/lib/prisma";

export interface SummarySpineData {
  content: string;
  messageCount: number;
  version: number;
  createdAt: Date;
}

export async function getLatestSummary(
  userId: string,
  conversationId: string = "default"
): Promise<SummarySpineData | null> {
  try {
    const summary = await prisma.summarySpine.findFirst({
      where: { 
        userId,
        conversationId,
      },
      orderBy: { version: "desc" },
    });

    if (!summary) return null;

    return {
      content: summary.content,
      messageCount: summary.messageCount,
      version: summary.version,
      createdAt: summary.createdAt,
    };
  } catch (error) {
    console.error("Summary retrieval failed:", error);
    return null;
  }
}

export async function createSummaryVersion(
  userId: string,
  content: string,
  messageCount: number,
  conversationId: string = "default"
): Promise<void> {
  try {
    const latestVersion = await prisma.summarySpine.findFirst({
      where: { userId, conversationId },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    const nextVersion = (latestVersion?.version || 0) + 1;

    await prisma.summarySpine.create({
      data: {
        userId,
        conversationId,
        content,
        messageCount,
        version: nextVersion,
      },
    });
  } catch (error) {
    console.error("Summary creation failed:", error);
    throw error;
  }
}

export async function getAllSummaryVersions(
  userId: string,
  conversationId: string = "default"
): Promise<SummarySpineData[]> {
  try {
    const summaries = await prisma.summarySpine.findMany({
      where: { 
        userId,
        conversationId,
      },
      orderBy: { version: "desc" },
    });

    return summaries.map(s => ({
      content: s.content,
      messageCount: s.messageCount,
      version: s.version,
      createdAt: s.createdAt,
    }));
  } catch (error) {
    console.error("Summary versions retrieval failed:", error);
    return [];
  }
}