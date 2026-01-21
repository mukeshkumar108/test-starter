import { prisma } from "@/lib/prisma";
import { ensureActiveSession, closeStaleSessionIfAny, getLatestSessionSummary } from "@/lib/services/session/sessionService";

async function main() {
  const clerkUserId = `qa_session_${Date.now()}`;
  const user = await prisma.user.create({ data: { clerkUserId } });
  const persona = await prisma.personaProfile.findFirst({
    where: { slug: "creative" },
    orderBy: { createdAt: "asc" },
  });
  if (!persona) {
    throw new Error("No persona profiles found");
  }

  const failures: string[] = [];

  try {
    const now = new Date();
    await closeStaleSessionIfAny(user.id, persona.id, now);
    const first = await ensureActiveSession(user.id, persona.id, now);
    const second = await ensureActiveSession(user.id, persona.id, new Date(now.getTime() + 5 * 60 * 1000));

    if (first.id !== second.id) {
      failures.push("Expected same session within 5 minutes.");
    }
    if (second.turnCount !== first.turnCount + 1) {
      failures.push("Expected turnCount to increment.");
    }

    await prisma.session.update({
      where: { id: first.id },
      data: { lastActivityAt: new Date(now.getTime() - 31 * 60 * 1000) },
    });

    const third = await ensureActiveSession(user.id, persona.id, new Date());
    const closed = await prisma.session.findFirst({
      where: { userId: user.id, personaId: persona.id, endedAt: { not: null } },
    });

    if (!closed) {
      failures.push("Expected stale session to be closed.");
    }
    if (third.id === first.id) {
      failures.push("Expected new session after inactivity.");
    }

    const summary = await getLatestSessionSummary(user.id, persona.id);
    if (summary) {
      failures.push("SessionSummary should be null when FEATURE_SESSION_SUMMARY is off.");
    }

    if (failures.length === 0) {
      console.log("PASS");
    } else {
      console.log("FAIL");
      failures.forEach((line) => console.log(line));
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
  }
}

main()
  .catch((error) => {
    console.error("Session synth failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
