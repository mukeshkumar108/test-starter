/**
 * Unit tests for startbrief-v2 prompt stack ordering and exclusions.
 * Run with: pnpm tsx src/app/api/__tests__/promptStackV2.test.ts
 */

import {
  __test__applyOpsSupplementalMutualExclusion,
  __test__buildChatMessages,
  __test__buildStartbriefInjection,
} from "../chat/route";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toContain(expected: string) {
      if (typeof actual !== "string" || !actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`);
      }
    },
    notToContain(expected: string) {
      if (typeof actual === "string" && actual.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(actual)} not to contain ${JSON.stringify(expected)}`);
      }
    },
  };
}

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  await runTest("message order follows final prompt stack", () => {
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      overlayBlock: "[OVERLAY]\nOverlay behavior",
      bridgeBlock: "BRIDGE",
      handoverBlock: "HANDOVER VERBATIM",
      opsSnippetBlock: "One useful thread to anchor on is walk daily.",
      supplementalContext: "FACTS:\n- follow-up",
      recentMessages: [{ role: "assistant", content: "prev" }],
      transcript: "current user turn",
    });
    const contents = messages.map((message) => message.content);
    expect(contents[0]).toBe("PERSONA");
    expect(contents[1].startsWith("[CONVERSATION_POSTURE]")).toBe(true);
    expect(contents[2].startsWith("[OVERLAY]")).toBe(true);
    expect(contents[3]).toBe("BRIDGE");
    expect(contents[4]).toBe("HANDOVER VERBATIM");
    expect(contents[5]).toBe("One useful thread to anchor on is walk daily.");
    expect(contents[6].startsWith("[SUPPLEMENTAL_CONTEXT]")).toBe(true);
    expect(contents[7]).toBe("prev");
    expect(contents[8]).toBe("current user turn");
  });

  await runTest("legacy orientation blocks never appear in composed messages", () => {
    const messages = __test__buildChatMessages({
      persona: "PERSONA",
      overlayBlock: "[OVERLAY]\nOverlay behavior",
      recentMessages: [],
      transcript: "hello",
    });
    const joined = messages.map((message) => message.content).join("\n");
    expect(joined).notToContain("SITUATIONAL_CONTEXT:");
    expect(joined).notToContain("[CONTINUITY]");
    expect(joined).notToContain("SESSION FACTS:");
  });

  await runTest("handover is injected verbatim", () => {
    const verbatim = "Keep this line exactly as authored by startbrief.";
    const injection = __test__buildStartbriefInjection({
      packet: {
        handover_text: verbatim,
        handover_depth: "today",
        resume: { use_bridge: false, bridge_text: null },
        time_context: { gap_minutes: 15 },
      },
      userTurnsSeen: 0,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    expect(injection.handoverBlock ?? "").toBe(verbatim);
  });

  await runTest("bridge only on turn1 when use_bridge is true", () => {
    const packet = {
      handover_text: "handover",
      handover_depth: "today" as const,
      resume: { use_bridge: true, bridge_text: "bridge" },
      time_context: { gap_minutes: 30 },
    };
    const turn1 = __test__buildStartbriefInjection({
      packet,
      userTurnsSeen: 0,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    const turn2 = __test__buildStartbriefInjection({
      packet,
      userTurnsSeen: 1,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    expect(turn1.bridgeBlock ?? "").toBe("bridge");
    expect(turn2.bridgeBlock).toBe(null);
  });

  await runTest("turn2 handover conditional and no handover on turn3+", () => {
    const packet = {
      handover_text: "handover",
      handover_depth: "today" as const,
      resume: { use_bridge: false, bridge_text: null },
      time_context: { gap_minutes: 30 },
    };
    const turn2No = __test__buildStartbriefInjection({
      packet,
      userTurnsSeen: 1,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    const turn2Yes = __test__buildStartbriefInjection({
      packet: { ...packet, time_context: { gap_minutes: 180 } },
      userTurnsSeen: 1,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    const turn3 = __test__buildStartbriefInjection({
      packet,
      userTurnsSeen: 2,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
    });
    expect(turn2No.handoverBlock).toBe(null);
    expect(turn2Yes.handoverBlock).toBe("handover");
    expect(turn3.handoverBlock).toBe(null);
  });

  await runTest("supplemental context suppresses ops snippet", () => {
    const withSupplemental = __test__applyOpsSupplementalMutualExclusion(
      "One useful thread is walk daily.",
      "FACTS:\n- reminder"
    );
    const withoutSupplemental = __test__applyOpsSupplementalMutualExclusion(
      "One useful thread is walk daily.",
      null
    );
    expect(withSupplemental).toBe(null);
    expect(withoutSupplemental).toBe("One useful thread is walk daily.");
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nPrompt stack v2 tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }
  console.log("Prompt stack v2 tests passed.");
}

main();
