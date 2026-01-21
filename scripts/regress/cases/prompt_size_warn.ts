import { prisma } from "@/lib/prisma";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { getChatModelForPersona } from "@/lib/providers/models";
import { RegressContext, RegressResult } from "../types";

function getCurrentContext(params: { lastMessageAt?: Date | null }) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const formatted = formatter.format(now);
  const location = "Cambridge, UK";
  const weather = "Grey/Overcast";

  let lastInteraction = "No prior messages";
  if (params.lastMessageAt) {
    const diffMs = now.getTime() - params.lastMessageAt.getTime();
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
    if (diffMinutes < 60) {
      lastInteraction = `${diffMinutes} minutes ago`;
    } else {
      const diffHours = Math.floor(diffMinutes / 60);
      lastInteraction = `${diffHours} hours ago`;
    }
  }

  return `[REAL-TIME CONTEXT] Time: ${formatted} Location: ${location} Weather: ${weather} Last Interaction: ${lastInteraction}`;
}

function getSessionContext(sessionState?: any) {
  if (!sessionState) return null;
  const lastInteractionIso = sessionState.lastInteraction as string | undefined;
  let timeSince = "unknown";
  if (lastInteractionIso) {
    const last = new Date(lastInteractionIso);
    if (!Number.isNaN(last.getTime())) {
      const diffMs = Date.now() - last.getTime();
      const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
      if (diffMinutes < 60) {
        timeSince = `${diffMinutes} minutes`;
      } else if (diffMinutes < 1440) {
        const diffHours = Math.floor(diffMinutes / 60);
        timeSince = `${diffHours} hours`;
      } else {
        const diffDays = Math.floor(diffMinutes / 1440);
        timeSince = `${diffDays} days`;
      }
    }
  }

  const messageCount =
    typeof sessionState.messageCount === "number"
      ? sessionState.messageCount
      : "unknown";

  return `[SESSION STATE] Time Since Last Interaction: ${timeSince} Message Count: ${messageCount}`;
}

export async function run(ctx: RegressContext): Promise<RegressResult> {
  const name = "prompt_size_warn";
  const context = await buildContext(ctx.userId, ctx.personaId, "hey");
  const lastMessage = await prisma.message.findFirst({
    where: { userId: ctx.userId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });

  const foundationMemoryStrings = context.foundationMemories.join("\n");
  const relevantMemoryStrings = context.relevantMemories.join("\n");
  const sessionContext = getSessionContext(context.sessionState);
  const commitmentStrings = context.commitments.join("\n");
  const threadStrings = context.threads.join("\n");
  const frictionStrings = context.frictions.join("\n");
  const recentWinStrings = context.recentWins.join("\n");
  const model = getChatModelForPersona("creative");

  const messages = [
    { role: "system" as const, content: getCurrentContext({ lastMessageAt: lastMessage?.createdAt }) },
    ...(sessionContext ? [{ role: "system" as const, content: sessionContext }] : []),
    { role: "system" as const, content: context.persona },
    ...(foundationMemoryStrings
      ? [{ role: "system" as const, content: `[FOUNDATION MEMORIES]:\n${foundationMemoryStrings}` }]
      : []),
    ...(relevantMemoryStrings
      ? [{ role: "system" as const, content: `[RELEVANT MEMORIES]:\n${relevantMemoryStrings}` }]
      : []),
    ...(commitmentStrings
      ? [
          {
            role: "system" as const,
            content: `COMMITMENTS (pending):\n${commitmentStrings}`,
          },
        ]
      : []),
    ...(threadStrings
      ? [{ role: "system" as const, content: `ACTIVE THREADS:\n${threadStrings}` }]
      : []),
    ...(frictionStrings
      ? [{ role: "system" as const, content: `FRICTIONS / PATTERNS:\n${frictionStrings}` }]
      : []),
    ...(recentWinStrings
      ? [{ role: "system" as const, content: `Recent wins:\n${recentWinStrings}` }]
      : []),
    ...(context.userSeed ? [{ role: "system" as const, content: `User context: ${context.userSeed}` }] : []),
    ...(context.summarySpine ? [{ role: "system" as const, content: `Conversation summary: ${context.summarySpine}` }] : []),
    ...(context.sessionSummary
      ? [
          {
            role: "system" as const,
            content: `LATEST SESSION SUMMARY: ${context.sessionSummary}`,
          },
        ]
      : []),
    ...context.recentMessages,
    { role: "user" as const, content: "hey" },
  ];

  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const ok = totalChars <= 20_000;

  return {
    name,
    ok,
    evidence: {
      model,
      totalChars,
      messageCount: messages.length,
      warning: ok ? null : "Prompt exceeds 20,000 chars",
    },
  };
}
