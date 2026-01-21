import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser } from "./regress/helpers";

async function runPair(
  userId: string,
  personaId: string,
  first: string,
  second: string
) {
  await prisma.message.createMany({
    data: [
      { userId, personaId, role: "user", content: first },
      { userId, personaId, role: "user", content: second },
    ],
  });

  await processShadowPath({
    userId,
    personaId,
    userMessage: second,
    assistantResponse: "ok",
  });
}

async function main() {
  const user = await createQaUser("qa_shadow_dedupe_");
  const personaId = await getPersonaIdBySlug("creative");

  try {
    process.env.FEATURE_JUDGE_TEST_MODE = "false";
    await runPair(
      user.id,
      personaId,
      "We need to cut costs across the product.",
      "Reducing expenditure needs to happen soon."
    );
    await runPair(
      user.id,
      personaId,
      "I'm burnt out lately.",
      "My bandwidth is exhausted right now."
    );
    await runPair(
      user.id,
      personaId,
      "Let's simplify the UI and remove clutter.",
      "We should trim the fat in the interface."
    );

    const todos = await prisma.todo.findMany({
      where: { userId: user.id, personaId },
      select: { content: true, kind: true, status: true, dedupeKey: true },
      orderBy: { createdAt: "asc" },
    });

    console.log("Dedupe key QA todos:");
    console.log(JSON.stringify(todos, null, 2));

    const expectedKeys = [
      "cut_costs_reduce_spend",
      "burnout_low_bandwidth",
      "simplify_ui_clutter",
    ];
    const missingKeys = expectedKeys.filter(
      (key) => !todos.some((todo) => todo.dedupeKey === key)
    );
    const uniqueKeys = new Set(todos.map((todo) => todo.dedupeKey ?? todo.content));
    const hasDuplicates = todos.length !== uniqueKeys.size;

    if (missingKeys.length > 0 || hasDuplicates) {
      console.error("Dedupe key QA FAILED:", {
        missingKeys,
        hasDuplicates,
        totalTodos: todos.length,
      });
      process.exitCode = 1;
    } else {
      console.log("Dedupe key QA PASSED");
    }
  } finally {
    await cleanupQaUser(user.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
