import { prisma } from "@/lib/prisma";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser, isQaClerkId } from "./regress/helpers";
import { ensureActiveSession } from "@/lib/services/session/sessionService";
import { buildContext } from "@/lib/services/memory/contextBuilder";

async function main() {
  const user = await createQaUser("qa_regress_v1_3_");
  if (!isQaClerkId(user.clerkUserId)) {
    throw new Error(`Refusing to run on non-QA user: ${user.clerkUserId}`);
  }
  const personaId = await getPersonaIdBySlug("creative");

  try {
    const session = await ensureActiveSession(user.id, personaId, new Date());

    const startedAt = new Date(Date.now() - 45 * 60 * 1000);
    const lastActivityAt = new Date(Date.now() - 31 * 60 * 1000);

    await prisma.session.update({
      where: { id: session.id },
      data: { startedAt, lastActivityAt },
    });

    const messages = [
      { role: "user" as const, content: "Text Ashley about the fight." },
      { role: "assistant" as const, content: "Ok." },
      { role: "user" as const, content: "Tomorrow 7:30am walk." },
      { role: "assistant" as const, content: "Locked." },
      { role: "user" as const, content: "Feeling tense but motivated." },
      { role: "assistant" as const, content: "Heard." },
    ];

    for (let i = 0; i < messages.length; i += 1) {
      await prisma.message.create({
        data: {
          userId: user.id,
          personaId,
          role: messages[i].role,
          content: messages[i].content,
          createdAt: new Date(Date.now() - (44 - i) * 60 * 1000),
        },
      });
    }

    await ensureActiveSession(user.id, personaId, new Date());

    const summary = await prisma.sessionSummary.findUnique({
      where: { sessionId: session.id },
    });
    const context = await buildContext(user.id, personaId, "hey");

    console.log("SessionSummary row:");
    console.log(JSON.stringify(summary, null, 2));
    console.log("Injected LATEST SESSION SUMMARY:");
    console.log(context.sessionSummary ?? "<none>");
  } finally {
    await cleanupQaUser(user.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
