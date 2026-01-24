import "dotenv/config";
import { prisma } from "@/lib/prisma";

async function main() {
  process.env.FEATURE_JUDGE_TEST_MODE = "true";
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to generate embeddings.");
  }

  const { processShadowPath } = await import("@/lib/services/memory/shadowJudge");
  const { searchMemories } = await import("@/lib/services/memory/memoryStore");
  const { createQaUser, getPersonaIdBySlug, cleanupQaUser } = await import("./regress/helpers");

  const user = await createQaUser("qa_synth_embed_");
  const personaId = await getPersonaIdBySlug("creative");

  try {
    await processShadowPath({
      userId: user.id,
      personaId,
      userMessage: "My name is Mukesh.",
      assistantResponse: "Got it.",
    });

    const latestMemory = await prisma.memory.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { id: true, content: true, createdAt: true },
    });

    const embeddingCheck = latestMemory
      ? await prisma.$queryRaw<Array<{ has_embedding: boolean }>>`
        SELECT embedding IS NOT NULL AS has_embedding
        FROM "Memory"
        WHERE id = ${latestMemory.id}
      `
      : [];

    const retrieved = await searchMemories(user.id, personaId, "Mukesh", 5);

    const hasEmbedding = Boolean(embeddingCheck[0]?.has_embedding);
    const retrievedCount = retrieved.length;

    console.log("=== Shadow Judge Embedding Synth ===");
    console.log(`latestMemoryId: ${latestMemory?.id ?? "none"}`);
    console.log(`latestMemoryContent: ${latestMemory?.content ?? "none"}`);
    console.log(`hasEmbedding: ${hasEmbedding}`);
    console.log(`searchMemoriesCount: ${retrievedCount}`);
    if (!hasEmbedding || retrievedCount === 0) {
      throw new Error("Embedding pipeline verification failed.");
    }
    console.log("[PASS] Shadow Judge embeddings are retrievable.");
  } finally {
    await cleanupQaUser(user.id);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
