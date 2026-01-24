import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser } from "./regress/helpers";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function run() {
  const user = await createQaUser("qa_rollsum_");
  const personaId = await getPersonaIdBySlug("creative");

  try {
    for (let i = 1; i <= 4; i += 1) {
      const userMessage = `Rolling summary test user turn ${i}`;
      const assistantResponse = `Rolling summary test assistant turn ${i}`;

      await prisma.message.create({
        data: { userId: user.id, personaId, role: "user", content: userMessage },
      });
      await prisma.message.create({
        data: { userId: user.id, personaId, role: "assistant", content: assistantResponse },
      });

      const sessionState = await prisma.sessionState.findUnique({
        where: { userId_personaId: { userId: user.id, personaId } },
        select: { state: true },
      });

      await processShadowPath({
        userId: user.id,
        personaId,
        userMessage,
        assistantResponse,
        currentSessionState: sessionState?.state,
      });
    }

    const updatedState = await prisma.sessionState.findUnique({
      where: { userId_personaId: { userId: user.id, personaId } },
      select: { rollingSummary: true, state: true },
    });

    const state = (updatedState?.state ?? {}) as Record<string, unknown>;
    assert(typeof updatedState?.rollingSummary === "string" && updatedState.rollingSummary.length > 0,
      "Expected rollingSummary to be set after 4 turns");
    assert(Boolean(state.lastRollingSuccessAt), "Expected lastRollingSuccessAt to be set");
    assert(Boolean(state.lastRollingAttemptAt), "Expected lastRollingAttemptAt to be set");

    console.log("PASS: rolling summary success path");
    console.log({
      rollingSummary: updatedState?.rollingSummary,
      diagnostics: {
        lastRollingAttemptAt: state.lastRollingAttemptAt,
        lastRollingSuccessAt: state.lastRollingSuccessAt,
        lastRollingError: state.lastRollingError ?? null,
      },
    });
  } finally {
    await cleanupQaUser(user.id);
  }
}

run().catch((error) => {
  console.error("FAIL: rolling summary success path");
  console.error(error);
  process.exitCode = 1;
});
