/**
 * Synth test for Memory B extraction (Stage 1-2)
 * Verifies:
 * - entityRefs are extracted and normalized correctly
 * - subtype fields are populated
 * - importance scoring works
 * - Entity key normalization follows slug rules
 *
 * Run with: pnpm tsx scripts/synth-shadow-memory-b-v2.ts
 */

import { prisma } from "@/lib/prisma";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser } from "./regress/helpers";
import { normalizeEntityKey, slugify } from "@/lib/services/memory/entityNormalizer";

interface MemoryBMetadata {
  source?: string;
  confidence?: number;
  subtype?: {
    entityType?: string;
    factType?: string;
  };
  entityRefs?: string[];
  entityLabel?: string;
  importance?: number;
}

async function runExtraction(
  userId: string,
  personaId: string,
  messages: string[]
) {
  await prisma.message.createMany({
    data: messages.map((content) => ({
      userId,
      personaId,
      role: "user" as const,
      content,
    })),
  });

  await processShadowPath({
    userId,
    personaId,
    userMessage: messages[messages.length - 1],
    assistantResponse: "I understand.",
  });
}

async function main() {
  const user = await createQaUser("qa_memory_b_");
  const personaId = await getPersonaIdBySlug("creative");
  const errors: string[] = [];

  try {
    // IMPORTANT: Disable test mode to use real LLM extraction
    process.env.FEATURE_JUDGE_TEST_MODE = "false";

    console.log("\n=== Memory B Extraction Test ===\n");

    // Test 1: Person entity with relationship
    console.log("Test 1: Person entity extraction...");
    await runExtraction(user.id, personaId, [
      "My cofounder Sarah is handling all the design work.",
    ]);

    // Test 2: Place entity
    console.log("Test 2: Place entity extraction...");
    await runExtraction(user.id, personaId, [
      "I just moved to San Francisco last month.",
    ]);

    // Test 3: Organization entity
    console.log("Test 3: Organization entity extraction...");
    await runExtraction(user.id, personaId, [
      "I'm the CTO at TechCorp Industries.",
    ]);

    // Test 4: Preference (no entityType)
    console.log("Test 4: Preference extraction...");
    await runExtraction(user.id, personaId, [
      "I strongly prefer working late at night.",
    ]);

    // Wait a moment for async writes
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Fetch all memories
    const memories = await prisma.memory.findMany({
      where: { userId: user.id },
      select: {
        type: true,
        content: true,
        metadata: true,
      },
      orderBy: { createdAt: "asc" },
    });

    console.log("\n=== Extracted Memories ===\n");
    for (const memory of memories) {
      const meta = memory.metadata as MemoryBMetadata | null;
      console.log(`Type: ${memory.type}`);
      console.log(`Content: ${memory.content}`);
      console.log(`Metadata: ${JSON.stringify(meta, null, 2)}`);
      console.log("---");
    }

    // Validation
    console.log("\n=== Validation ===\n");

    // Check 1: At least some memories have Memory B fields
    const memoriesWithSubtype = memories.filter((m) => {
      const meta = m.metadata as MemoryBMetadata | null;
      return meta?.subtype !== undefined;
    });

    if (memoriesWithSubtype.length === 0) {
      errors.push("No memories have subtype field");
    } else {
      console.log(`[PASS] ${memoriesWithSubtype.length} memories have subtype field`);
    }

    // Check 2: Entity refs are properly normalized
    const memoriesWithEntityRefs = memories.filter((m) => {
      const meta = m.metadata as MemoryBMetadata | null;
      return meta?.entityRefs && meta.entityRefs.length > 0;
    });

    if (memoriesWithEntityRefs.length === 0) {
      errors.push("No memories have entityRefs");
    } else {
      console.log(`[PASS] ${memoriesWithEntityRefs.length} memories have entityRefs`);

      // Validate entity key format
      for (const memory of memoriesWithEntityRefs) {
        const meta = memory.metadata as MemoryBMetadata;
        for (const ref of meta.entityRefs || []) {
          const validFormat = /^(person|place|org|project):[a-z0-9_]+$/.test(ref);
          if (!validFormat) {
            errors.push(`Invalid entityRef format: ${ref}`);
          }
        }
      }
    }

    // Check 3: Importance field is present
    const memoriesWithImportance = memories.filter((m) => {
      const meta = m.metadata as MemoryBMetadata | null;
      return typeof meta?.importance === "number";
    });

    if (memoriesWithImportance.length === 0) {
      errors.push("No memories have importance field");
    } else {
      console.log(`[PASS] ${memoriesWithImportance.length} memories have importance field`);
    }

    // Check 4: Verify normalization function
    console.log("\n=== Normalization Verification ===\n");
    const normTests = [
      { input: "Sarah", expected: "person:sarah" },
      { input: "San Francisco", expected: "place:san_francisco" },
      { input: "TechCorp Industries", expected: "org:techcorp_industries" },
      { input: "Dr. Jane O'Brien", expected: "person:dr_jane_o_brien" },
    ];

    for (const test of normTests) {
      const type = test.expected.split(":")[0] as "person" | "place" | "org" | "project";
      const result = normalizeEntityKey(type, test.input);
      if (result === test.expected) {
        console.log(`[PASS] normalizeEntityKey("${type}", "${test.input}") = "${result}"`);
      } else {
        errors.push(`Normalization failed: expected "${test.expected}", got "${result}"`);
        console.log(`[FAIL] normalizeEntityKey("${type}", "${test.input}") = "${result}" (expected "${test.expected}")`);
      }
    }

    // Check 5: Slugify edge cases
    console.log("\n=== Slugify Edge Cases ===\n");
    const slugTests = [
      { input: "Hello World", expected: "hello_world" },
      { input: "  spaces  ", expected: "spaces" },
      { input: "hyphen-ated", expected: "hyphen_ated" },
      { input: "v2.0.1", expected: "v2_0_1" },
      { input: "O'Brien", expected: "o_brien" },
    ];

    for (const test of slugTests) {
      const result = slugify(test.input);
      if (result === test.expected) {
        console.log(`[PASS] slugify("${test.input}") = "${result}"`);
      } else {
        errors.push(`Slugify failed: expected "${test.expected}", got "${result}"`);
        console.log(`[FAIL] slugify("${test.input}") = "${result}" (expected "${test.expected}")`);
      }
    }

    // Summary
    console.log("\n=== Summary ===\n");
    console.log(`Total memories extracted: ${memories.length}`);
    console.log(`Memories with subtype: ${memoriesWithSubtype.length}`);
    console.log(`Memories with entityRefs: ${memoriesWithEntityRefs.length}`);
    console.log(`Memories with importance: ${memoriesWithImportance.length}`);

    if (errors.length > 0) {
      console.log("\n[FAIL] Memory B Extraction Test FAILED");
      console.log("Errors:");
      for (const error of errors) {
        console.log(`  - ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n[PASS] Memory B Extraction Test PASSED");
    }
  } finally {
    await cleanupQaUser(user.id);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
