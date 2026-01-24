import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser } from "./regress/helpers";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function run() {
  const user = await createQaUser("qa_rollsum_fail_");
  const personaId = await getPersonaIdBySlug("creative");

  try {
    await prisma.sessionState.upsert({
      where: { userId_personaId: { userId: user.id, personaId } },
      update: {
        rollingSummary: "seed rolling summary",
        state: { messageCount: 0 },
      },
      create: {
        userId: user.id,
        personaId,
        rollingSummary: "seed rolling summary",
        state: { messageCount: 0 },
      },
    });

    for (let i = 1; i <= 4; i += 1) {
      const userMessage = `Rolling summary fail user turn ${i}`;
      const assistantResponse = `Rolling summary fail assistant turn ${i}`;

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
    assert(updatedState?.rollingSummary === "seed rolling summary",
      "Expected rollingSummary to remain unchanged on failure");
    assert(Boolean(state.lastRollingAttemptAt), "Expected lastRollingAttemptAt to be set");
    assert(state.lastRollingError !== undefined, "Expected lastRollingError to be set");

    console.log("PASS: rolling summary failure path");
    console.log({
      rollingSummary: updatedState?.rollingSummary,
      diagnostics: {
        lastRollingAttemptAt: state.lastRollingAttemptAt,
        lastRollingSuccessAt: state.lastRollingSuccessAt ?? null,
        lastRollingError: state.lastRollingError ?? null,
      },
    });
  } finally {
    await cleanupQaUser(user.id);
  }
}

run().catch((error) => {
  console.error("FAIL: rolling summary failure path");
  console.error(error);
  process.exitCode = 1;
});
