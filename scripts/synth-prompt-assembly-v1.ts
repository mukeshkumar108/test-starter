/**
 * Synth test for Prompt Assembly v1: No Empty Blocks
 *
 * Verifies:
 * - With SummarySpine disabled (Sophie persona), the context does NOT include summarySpine
 * - The constructed messages array contains no empty blocks
 * - All conditional blocks are properly omitted when empty
 *
 * Run with: pnpm synth:prompt-assembly:v1
 */

import { prisma } from "@/lib/prisma";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser } from "./regress/helpers";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Simulates the messages array construction from route.ts
 * This is a deterministic version that doesn't require LLM calls
 */
function buildMessagesArray(context: Awaited<ReturnType<typeof buildContext>>, userMessage: string): Message[] {
  const realTimeContext = "[REAL-TIME]: Test time context";
  const sessionContext = context.sessionState
    ? `[SESSION STATE] Time Since Last Interaction: unknown Message Count: ${context.sessionState.messageCount ?? "unknown"}`
    : null;

  const foundationMemoryStrings = context.foundationMemories.join("\n");
  const relevantMemoryStrings = context.relevantMemories.join("\n");
  const commitmentStrings = context.commitments.join("\n");
  const threadStrings = context.threads.join("\n");
  const frictionStrings = context.frictions.join("\n");
  const recentWinStrings = context.recentWins.join("\n");
  const rollingSummary = context.rollingSummary ?? "";
  const sessionSummary = context.sessionSummary ?? "";

  const messages: Message[] = [
    { role: "system", content: realTimeContext },
    ...(sessionContext ? [{ role: "system" as const, content: sessionContext }] : []),
    { role: "system", content: context.persona },
    ...(foundationMemoryStrings
      ? [{ role: "system" as const, content: `[FOUNDATION MEMORIES]:\n${foundationMemoryStrings}` }]
      : []),
    ...(relevantMemoryStrings
      ? [{ role: "system" as const, content: `[RELEVANT MEMORIES]:\n${relevantMemoryStrings}` }]
      : []),
    ...(commitmentStrings
      ? [{ role: "system" as const, content: `COMMITMENTS (pending):\n${commitmentStrings}` }]
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
    ...(context.userSeed
      ? [{ role: "system" as const, content: `User context: ${context.userSeed}` }]
      : []),
    ...(context.summarySpine
      ? [{ role: "system" as const, content: `Conversation summary: ${context.summarySpine}` }]
      : []),
    ...(rollingSummary
      ? [{ role: "system" as const, content: `CURRENT SESSION SUMMARY: ${rollingSummary}` }]
      : []),
    ...(sessionSummary
      ? [{ role: "system" as const, content: `LATEST SESSION SUMMARY: ${sessionSummary}` }]
      : []),
    ...context.recentMessages.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  return messages;
}

async function main() {
  const user = await createQaUser("qa_prompt_assembly_");
  // Use Sophie (creative) - has enableSummarySpine = false
  const personaId = await getPersonaIdBySlug("creative");
  const errors: string[] = [];

  console.log("\n=== Prompt Assembly v1 Synth Test ===\n");
  console.log(`User ID: ${user.id}`);
  console.log(`Persona ID: ${personaId} (Sophie - SummarySpine disabled)`);

  try {
    // Verify Sophie has SummarySpine disabled
    const persona = await prisma.personaProfile.findUnique({
      where: { id: personaId },
      select: { slug: true, enableSummarySpine: true },
    });
    console.log(`Persona config: ${persona?.slug}, enableSummarySpine=${persona?.enableSummarySpine}`);

    if (persona?.enableSummarySpine !== false) {
      errors.push("Test setup error: Sophie should have enableSummarySpine=false");
      console.log("[FAIL] Sophie should have enableSummarySpine=false");
    }

    // Create a SummarySpine record (should be ignored for Sophie)
    await prisma.summarySpine.create({
      data: {
        userId: user.id,
        conversationId: "default",
        version: 1,
        content: "PROFILE:\n- Test user\nPROJECTS:\n- Test project",
        messageCount: 10,
      },
    });
    console.log("  - Created SummarySpine (should be ignored for Sophie)");

    // Build context
    console.log("\nBuilding context...");
    const context = await buildContext(user.id, personaId, "Hello, how are you?");

    // Test 1: SummarySpine should be undefined for Sophie
    console.log("\n--- Test 1: SummarySpine omitted when disabled ---");
    if (context.summarySpine !== undefined) {
      errors.push(`SummarySpine should be undefined for Sophie, got: "${context.summarySpine}"`);
      console.log(`[FAIL] SummarySpine not undefined: "${context.summarySpine}"`);
    } else {
      console.log("[PASS] SummarySpine is undefined (correctly omitted)");
    }

    // Test 2: Build messages array and check for empty blocks
    console.log("\n--- Test 2: No empty blocks in messages array ---");
    const messages = buildMessagesArray(context, "Hello, how are you?");

    console.log(`Messages array has ${messages.length} entries:`);
    let hasEmptyBlock = false;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const preview = msg.content.slice(0, 60).replace(/\n/g, " ");
      const isEmpty = msg.content.trim() === "" ||
        msg.content.trim() === "[FOUNDATION MEMORIES]:" ||
        msg.content.trim() === "[RELEVANT MEMORIES]:" ||
        msg.content.trim() === "COMMITMENTS (pending):" ||
        msg.content.trim() === "ACTIVE THREADS:" ||
        msg.content.trim() === "FRICTIONS / PATTERNS:" ||
        msg.content.trim() === "Recent wins:" ||
        msg.content.trim() === "User context:" ||
        msg.content.trim() === "Conversation summary:" ||
        msg.content.trim() === "CURRENT SESSION SUMMARY:" ||
        msg.content.trim() === "LATEST SESSION SUMMARY:";

      if (isEmpty) {
        hasEmptyBlock = true;
        console.log(`  [${i}] [${msg.role}] EMPTY: "${preview}..."`);
      } else {
        console.log(`  [${i}] [${msg.role}] ${preview}...`);
      }
    }

    if (hasEmptyBlock) {
      errors.push("Messages array contains empty or header-only blocks");
      console.log("[FAIL] Found empty blocks in messages array");
    } else {
      console.log("[PASS] No empty blocks in messages array");
    }

    // Test 3: Verify no "Conversation summary:" block exists
    console.log("\n--- Test 3: No SummarySpine block in messages ---");
    const hasSummarySpineBlock = messages.some((m) =>
      m.content.startsWith("Conversation summary:")
    );
    if (hasSummarySpineBlock) {
      errors.push("Messages array should not contain 'Conversation summary:' block for Sophie");
      console.log("[FAIL] Found 'Conversation summary:' block");
    } else {
      console.log("[PASS] No 'Conversation summary:' block (correctly omitted)");
    }

    // Test 4: isSessionStart should be true for new user
    console.log("\n--- Test 4: isSessionStart flag ---");
    if (context.isSessionStart !== true) {
      errors.push("isSessionStart should be true for new user with no messages");
      console.log("[FAIL] isSessionStart should be true");
    } else {
      console.log("[PASS] isSessionStart is true for new session");
    }

    // Summary
    console.log("\n=== Summary ===\n");
    console.log(`Messages array length: ${messages.length}`);
    console.log(`SummarySpine: ${context.summarySpine === undefined ? "undefined (correct)" : context.summarySpine}`);
    console.log(`isSessionStart: ${context.isSessionStart}`);

    if (errors.length > 0) {
      console.log(`\n[FAIL] Prompt Assembly v1 Test FAILED with ${errors.length} error(s):`);
      for (const error of errors) {
        console.log(`  - ${error}`);
      }
      process.exitCode = 1;
    } else {
      console.log("\n[PASS] Prompt Assembly v1 Test PASSED");
    }
  } finally {
    await cleanupQaUser(user.id);
    console.log("\nCleanup complete.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
