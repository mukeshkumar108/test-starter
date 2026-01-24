import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { MemoryType } from "@prisma/client";
import { storeMemory } from "@/lib/services/memory/memoryStore";
import { createQaUser, cleanupQaUser } from "./regress/helpers";

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

async function run() {
  const user = await createQaUser("qa_memory_hygiene_");
  try {
    await storeMemory(
      user.id,
      MemoryType.PROFILE,
      "Name is Mukesh",
      {
        subtype: { entityType: "person", factType: "fact" },
        entityRefs: ["person:mukesh"],
        importance: 3,
      }
    );

    await storeMemory(
      user.id,
      MemoryType.PROFILE,
      "My name is Makesh",
      {
        subtype: { entityType: "person", factType: "fact" },
        entityRefs: ["person:makesh"],
        importance: 2,
      }
    );

    const memories = await prisma.memory.findMany({
      where: { userId: user.id },
      select: { id: true, memoryKey: true, metadata: true, content: true },
    });

    assert(memories.length === 1, `Expected 1 memory row, found ${memories.length}`);
    const memory = memories[0];
    const metadata = (memory.metadata ?? {}) as Record<string, unknown>;
    const refs = Array.isArray(metadata.entityRefs) ? (metadata.entityRefs as string[]) : [];

    assert(refs.includes("person:mukesh"), "Expected canonical entityRef person:mukesh");
    assert(!refs.includes("person:makesh"), "Did not expect person:makesh to remain");
    assert(metadata.importance === 3, `Expected importance 3, got ${metadata.importance}`);
    assert(metadata.mentionCount === 2, `Expected mentionCount 2, got ${metadata.mentionCount}`);

    console.log("PASS: memory hygiene dedupe + canonicalization");
    console.log({
      id: memory.id,
      memoryKey: memory.memoryKey,
      content: memory.content,
      metadata,
    });
  } finally {
    await cleanupQaUser(user.id);
  }
}

run().catch((error) => {
  console.error("FAIL: memory hygiene dedupe + canonicalization");
  console.error(error);
  process.exitCode = 1;
});
