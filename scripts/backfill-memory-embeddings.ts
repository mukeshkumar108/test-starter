import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { MODELS } from "@/lib/providers/models";

const BATCH_SIZE = Number.parseInt(
  process.env.BACKFILL_BATCH_SIZE ?? "50",
  10
);
const LIMIT = Number.parseInt(process.env.BACKFILL_LIMIT ?? "0", 10);
const CONFIRM = process.env.BACKFILL_CONFIRM === "true";

async function generateEmbedding(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required to backfill embeddings.");
  }

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODELS.EMBEDDINGS,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(`Embedding API failed: ${response.status}`);
    }

    const data = await response.json();
    return data.data?.[0]?.embedding || null;
  } catch (error) {
    console.error("Embedding generation failed:", error);
    return null;
  }
}

async function main() {
  const totalMissing = await prisma.$queryRaw<
    Array<{ count: number }>
  >`SELECT COUNT(*)::int AS count FROM "Memory" WHERE embedding IS NULL;`;
  const total = totalMissing[0]?.count ?? 0;

  console.log("=== Memory Embedding Backfill ===");
  console.log(`missingEmbeddings: ${total}`);
  console.log(`batchSize: ${BATCH_SIZE}`);
  console.log(`limit: ${LIMIT > 0 ? LIMIT : "none"}`);

  if (!CONFIRM) {
    console.log("Dry run only. Set BACKFILL_CONFIRM=true to apply.");
    return;
  }

  let processed = 0;
  let updated = 0;
  let skipped = 0;

  while (true) {
    if (LIMIT > 0 && processed >= LIMIT) break;
    const remainingLimit = LIMIT > 0 ? LIMIT - processed : BATCH_SIZE;
    const take = Math.min(BATCH_SIZE, remainingLimit);

    const rows = await prisma.$queryRaw<
      Array<{ id: string; content: string }>
    >`
      SELECT id, content
      FROM "Memory"
      WHERE embedding IS NULL
      ORDER BY "createdAt" ASC
      LIMIT ${take}
    `;

    if (rows.length === 0) break;

    for (const row of rows) {
      processed += 1;
      const embedding = await generateEmbedding(row.content);
      if (!embedding) {
        skipped += 1;
        continue;
      }
      const embeddingLiteral = `[${embedding.join(",")}]`;
      await prisma.$executeRaw`
        UPDATE "Memory"
        SET embedding = ${embeddingLiteral}::vector
        WHERE id = ${row.id}
      `;
      updated += 1;
    }
  }

  console.log(`processed: ${processed}`);
  console.log(`updated: ${updated}`);
  console.log(`skipped: ${skipped}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
