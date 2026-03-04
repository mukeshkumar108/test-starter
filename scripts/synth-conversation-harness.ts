import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import {
  __test__buildChatMessages,
  __test__buildContextGovernorSelection,
  __test__buildDeferredProfileContextLines,
  __test__buildSessionStartSituationalContext,
  __test__buildStartbriefInjection,
  __test__runLibrarianReflex,
  __test__shouldInjectSignalPack,
} from "@/app/api/chat/route";
import { prisma } from "@/lib/prisma";
import { getChatModelForTurn, getTurnTierForSignals } from "@/lib/providers/models";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { loadOverlay } from "@/lib/services/memory/overlayLoader";
import { selectOverlay } from "@/lib/services/memory/overlaySelector";
import { generateResponse } from "@/lib/services/voice/llmService";

type ScriptTurn = {
  userMessage: string;
};

type ConversationScript = {
  name: string;
  userId: string;
  personaId?: string;
  turns: ScriptTurn[];
};

type HarnessOptions = {
  scriptPath: string;
  dryRun: boolean;
  modelOverride: string | null;
  personaIdOverride: string | null;
};

type PromptPacket = {
  turnIndex: number;
  transcript: string;
  userId: string;
  personaId: string;
  sessionId: string;
  model: {
    tier: string;
    selected: string;
    override: string | null;
    routingReason: string;
  };
  memoryQuery: {
    intent: string;
    riskLevel: string;
    posture: string;
    pressure: string;
    isUrgent: boolean;
    isDirectRequest: boolean;
    gateAction: "memory_query" | "none";
    gateConfidence: number;
    triage: unknown;
    triageSource: string;
    routerRunReason: string;
    routerOutput: unknown;
    supplementalContext: string | null;
  };
  overlay: {
    stance: string;
    tactic: string;
    triggerReason: string | null;
    suppressionReason: string | null;
  };
  blocks: {
    situationalContext: string | null;
    userNarrative: string | null;
    handover: string | null;
    bridge: string | null;
    userContext: string | null;
    signalPack: string | null;
    stanceOverlay: string | null;
    tacticOverlay: string | null;
  };
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
};

type TurnResult = {
  turnIndex: number;
  userMessage: string;
  promptPacket: PromptPacket;
  modelResponse: {
    skipped: boolean;
    text: string | null;
    durationMs: number | null;
    error: string | null;
  };
};

function parseArgs(argv: string[]): HarnessOptions {
  let scriptPath = "";
  let dryRun = false;
  let modelOverride: string | null = null;
  let personaIdOverride: string | null = null;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--script") {
      scriptPath = argv[i + 1] ?? "";
      i += 1;
      continue;
    }
    if (arg === "--model") {
      modelOverride = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (arg === "--persona-id") {
      personaIdOverride = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (!arg.startsWith("--") && !scriptPath) {
      scriptPath = arg;
    }
  }

  if (!scriptPath) {
    throw new Error(
      "Missing script path. Usage: pnpm tsx scripts/synth-conversation-harness.ts --script test-scripts/<file>.json [--dry-run] [--model <model>] [--persona-id <id>]"
    );
  }

  return {
    scriptPath,
    dryRun,
    modelOverride,
    personaIdOverride,
  };
}

function resolveScriptPath(inputPath: string) {
  if (path.isAbsolute(inputPath)) return inputPath;
  if (inputPath.endsWith(".json") && inputPath.startsWith("test-scripts/")) {
    return path.join(process.cwd(), inputPath);
  }
  if (inputPath.endsWith(".json")) {
    return path.join(process.cwd(), "test-scripts", path.basename(inputPath));
  }
  return path.join(process.cwd(), "test-scripts", `${inputPath}.json`);
}

function tsForFilename(date: Date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hour}${minute}${second}Z`;
}

function sanitizeFileStem(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "synthetic-conversation";
}

function installNoWriteGuard() {
  const client = prisma as unknown as Record<string, unknown>;
  const delegateNames = [
    "session",
    "sessionSummary",
    "user",
    "personaProfile",
    "userSeed",
    "sessionState",
    "todo",
    "message",
    "memory",
    "summarySpine",
    "librarianTrace",
    "synapseIngestTrace",
  ];
  const writeMethods = [
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
  ];
  for (const name of delegateNames) {
    const delegate = client[name] as Record<string, unknown> | undefined;
    if (!delegate || typeof delegate !== "object") continue;
    for (const method of writeMethods) {
      if (typeof delegate[method] === "function") {
        delegate[method] = async () => null;
      }
    }
  }
  if (typeof client.$executeRaw === "function") {
    client.$executeRaw = async () => 0;
  }
  if (typeof client.$executeRawUnsafe === "function") {
    client.$executeRawUnsafe = async () => 0;
  }
  if (typeof client.$queryRaw === "function") {
    client.$queryRaw = async () => [];
  }
  if (typeof client.$queryRawUnsafe === "function") {
    client.$queryRawUnsafe = async () => [];
  }
}

async function resolvePersonaId(params: {
  userId: string;
  scriptPersonaId?: string;
  cliPersonaId?: string | null;
}) {
  if (params.cliPersonaId) return params.cliPersonaId;
  if (params.scriptPersonaId) return params.scriptPersonaId;

  const activeSession = await prisma.session.findFirst({
    where: { userId: params.userId, endedAt: null },
    orderBy: { lastActivityAt: "desc" },
    select: { personaId: true },
  });
  if (activeSession?.personaId) return activeSession.personaId;

  const latestMessage = await prisma.message.findFirst({
    where: { userId: params.userId },
    orderBy: { createdAt: "desc" },
    select: { personaId: true },
  });
  if (latestMessage?.personaId) return latestMessage.personaId;

  throw new Error("Unable to resolve personaId. Provide it in the script or via --persona-id.");
}

async function resolveSessionId(userId: string, personaId: string) {
  const activeSession = await prisma.session.findFirst({
    where: { userId, personaId, endedAt: null },
    orderBy: { lastActivityAt: "desc" },
    select: { id: true },
  });
  if (activeSession?.id) return activeSession.id;

  const latestSession = await prisma.session.findFirst({
    where: { userId, personaId },
    orderBy: { lastActivityAt: "desc" },
    select: { id: true },
  });
  if (latestSession?.id) return latestSession.id;

  return `synthetic-${crypto.randomUUID()}`;
}

function combineRecentMessages(
  base: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }>,
  synthetic: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }>
) {
  const merged = [...base, ...synthetic];
  return merged.slice(-20);
}

async function runHarness(options: HarnessOptions) {
  installNoWriteGuard();

  const absoluteScriptPath = resolveScriptPath(options.scriptPath);
  const raw = await readFile(absoluteScriptPath, "utf8");
  const script = JSON.parse(raw) as ConversationScript;

  if (!script?.name || !script?.userId || !Array.isArray(script?.turns)) {
    throw new Error("Invalid script JSON. Expected { name, userId, turns: [{ userMessage }] }.");
  }

  const personaId = await resolvePersonaId({
    userId: script.userId,
    scriptPersonaId: script.personaId,
    cliPersonaId: options.personaIdOverride,
  });
  const sessionId = await resolveSessionId(script.userId, personaId);

  const syntheticHistory: Array<{ role: "user" | "assistant"; content: string; createdAt?: Date }> = [];
  const results: TurnResult[] = [];

  for (let i = 0; i < script.turns.length; i += 1) {
    const turn = script.turns[i];
    const now = new Date();
    const transcript = String(turn.userMessage ?? "").trim();
    if (!transcript) {
      throw new Error(`Turn ${i + 1} is missing userMessage.`);
    }

    const context = await buildContext(script.userId, personaId, transcript);
    const recentMessages = combineRecentMessages(context.recentMessages, syntheticHistory);

    const librarian = await __test__runLibrarianReflex({
      requestId: `synthetic-${crypto.randomUUID()}`,
      userId: script.userId,
      personaId,
      sessionId,
      transcript,
      recentMessages,
      relationshipNames: context.deferredProfileContext?.relationshipNames ?? [],
      now,
      shouldTrace: false,
    });

    const intent = librarian?.intent ?? "companion";
    const posture = librarian?.posture ?? "COMPANION";
    const pressure = librarian?.pressure ?? "LOW";
    const riskLevel = librarian?.riskLevel ?? "LOW";
    const isDirectRequest = librarian?.isDirectRequest ?? false;
    const isUrgent = librarian?.isUrgent ?? false;

    const startbrief = __test__buildStartbriefInjection({
      packet: context.startbriefPacket,
      userTurnsSeen: i,
      firstUserMsgLowSignal: false,
      allowSemanticReinjection: false,
      now,
      timeZone: "Europe/Zagreb",
    });

    const situationalContext = context.isSessionStart
      ? __test__buildSessionStartSituationalContext({
          handoff: context.sessionStartHandoff,
          intent,
          isDirectRequest,
        })
      : null;

    const deferredProfileLines = __test__buildDeferredProfileContextLines({
      isSessionStart: context.isSessionStart,
      profile: context.deferredProfileContext,
      posture,
      intent,
      isDirectRequest,
      transcript,
      avoidanceOrDrift: librarian?.avoidanceOrDrift ?? false,
    });

    const userContextBlock =
      deferredProfileLines.length > 0
        ? `[USER_CONTEXT]\n${deferredProfileLines.map((line) => `- ${line}`).join("\n")}`
        : null;

    const signalPackBlock = __test__shouldInjectSignalPack({
      signalPackBlock: context.signalPackBlock ?? null,
      isSessionStart: context.isSessionStart,
      intent,
      posture,
      pressure,
      stance: "none",
      riskLevel,
      isUrgent,
    })
      ? context.signalPackBlock ?? null
      : null;

    let stanceOverlayType: "none" | "witness" | "excavator" | "repair_and_forward" | "high_standards_friend" = "none";
    let tacticOverlayType: "none" | "curiosity_spiral" | "accountability_tug" | "daily_focus" | "daily_review" | "weekly_compass" | "entity_intro" = "none";
    let overlayTriggerReason: string | null = null;
    let overlaySuppressionReason: string | null = null;

    if (riskLevel === "HIGH" || riskLevel === "CRISIS") {
      stanceOverlayType = "witness";
      overlayTriggerReason = "safety_risk_override";
    } else {
      const decision = selectOverlay({
        transcript,
        posture,
        intent,
        explicitTopicShift: librarian?.gateExplicitTopicShift ?? false,
        avoidanceOrDrift: librarian?.avoidanceOrDrift ?? false,
        openLoops: context.overlayContext?.openLoops,
        commitments: context.overlayContext?.commitments,
        recentUserMessages: recentMessages
          .filter((entry) => entry.role === "user")
          .map((entry) => entry.content)
          .slice(-3),
        hasHighPriorityLoop: context.overlayContext?.hasHighPriorityLoop,
        overlayUsed: {},
        dailyFocusEligible: false,
        dailyReviewEligible: false,
        weeklyCompassEligible: false,
        hasTodayFocus: false,
        hasDailyReviewToday: false,
        hasWeeklyCompass: false,
        conflictSignals: {
          pressure,
          riskLevel,
          mood: librarian?.userState?.mood,
          tone: librarian?.userState?.tone,
        },
        userLastTugAt: null,
        tugBackoff: undefined,
        now,
      });
      stanceOverlayType = decision.stanceOverlay;
      tacticOverlayType = decision.tacticOverlay;
      overlayTriggerReason = decision.triggerReason;
      overlaySuppressionReason = decision.suppressionReason ?? null;
    }

    const stanceOverlayBlock =
      stanceOverlayType === "none" ? null : `[STANCE_OVERLAY]\n${await loadOverlay(stanceOverlayType)}`;
    const tacticOverlayBlock =
      tacticOverlayType === "none" ? null : `[OVERLAY]\n${await loadOverlay(tacticOverlayType)}`;

    const governed = __test__buildContextGovernorSelection({
      userContextBlock,
      signalPackBlock,
      bridgeBlock: startbrief.bridgeBlock,
      handoverBlock: startbrief.handoverBlock,
      opsSnippetBlock: null,
      intent,
      posture,
      pressure,
      stance: stanceOverlayType,
      riskLevel,
    });

    const tierDecision = getTurnTierForSignals({
      riskLevel,
      posture,
      pressure,
      stanceSelected: stanceOverlayType,
      intent,
      isDirectRequest,
      isUrgent,
    });
    const selectedModel = options.modelOverride ?? getChatModelForTurn({ tier: tierDecision.tier });

    const messages = __test__buildChatMessages({
      persona: context.persona,
      userContextBlock: governed.userContextBlock,
      signalPackBlock: governed.signalPackBlock,
      stanceOverlayBlock,
      tacticOverlayBlock,
      bridgeBlock: governed.bridgeBlock,
      userNarrativeBlock: startbrief.userNarrativeBlock,
      handoverBlock: governed.handoverBlock,
      supplementalContext: librarian?.supplementalContext ?? null,
      rollingSummary: context.rollingSummary ?? "",
      recentMessages,
      transcript,
      posture,
      pressure,
      userState: librarian?.userState ?? null,
    });

    if (situationalContext) {
      messages.splice(1, 0, { role: "system", content: situationalContext });
    }

    const promptPacket: PromptPacket = {
      turnIndex: i + 1,
      transcript,
      userId: script.userId,
      personaId,
      sessionId,
      model: {
        tier: tierDecision.tier,
        selected: selectedModel,
        override: options.modelOverride,
        routingReason: tierDecision.reason,
      },
      memoryQuery: {
        intent,
        riskLevel,
        posture,
        pressure,
        isUrgent,
        isDirectRequest,
        gateAction: librarian?.gateAction ?? "none",
        gateConfidence: librarian?.gateConfidence ?? 0,
        triage: librarian?.triage ?? null,
        triageSource: librarian?.triageSource ?? "fallback",
        routerRunReason: librarian?.routerRunReason ?? "skipped",
        routerOutput: librarian?.routerOutput ?? null,
        supplementalContext: librarian?.supplementalContext ?? null,
      },
      overlay: {
        stance: stanceOverlayType,
        tactic: tacticOverlayType,
        triggerReason: overlayTriggerReason,
        suppressionReason: overlaySuppressionReason,
      },
      blocks: {
        situationalContext,
        userNarrative: startbrief.userNarrativeBlock,
        handover: governed.handoverBlock,
        bridge: governed.bridgeBlock,
        userContext: governed.userContextBlock,
        signalPack: governed.signalPackBlock,
        stanceOverlay: stanceOverlayBlock,
        tacticOverlay: tacticOverlayBlock,
      },
      messages,
    };

    let responseText: string | null = null;
    let responseDuration: number | null = null;
    let responseError: string | null = null;

    if (!options.dryRun) {
      try {
        const llm = await generateResponse(messages, "creative", selectedModel);
        responseText = llm.content;
        responseDuration = llm.duration_ms;
      } catch (error) {
        responseError = error instanceof Error ? error.message : String(error);
      }
    }

    results.push({
      turnIndex: i + 1,
      userMessage: transcript,
      promptPacket,
      modelResponse: {
        skipped: options.dryRun,
        text: responseText,
        durationMs: responseDuration,
        error: responseError,
      },
    });

    syntheticHistory.push({ role: "user", content: transcript, createdAt: now });
    if (responseText) {
      syntheticHistory.push({ role: "assistant", content: responseText, createdAt: new Date() });
    }
  }

  const timestamp = tsForFilename(new Date());
  const scriptStem = sanitizeFileStem(script.name || path.basename(absoluteScriptPath, ".json"));
  const outputDir = path.join(process.cwd(), "test-runs");
  const outputPath = path.join(outputDir, `${scriptStem}-${timestamp}.md`);

  await mkdir(outputDir, { recursive: true });

  const lines: string[] = [];
  lines.push(`# Synthetic Conversation Run`);
  lines.push("");
  lines.push(`- Script: \`${absoluteScriptPath}\``);
  lines.push(`- Script name: \`${script.name}\``);
  lines.push(`- User: \`${script.userId}\``);
  lines.push(`- Persona: \`${personaId}\``);
  lines.push(`- Session: \`${sessionId}\``);
  lines.push(`- Dry run: \`${options.dryRun}\``);
  lines.push(`- Model override: \`${options.modelOverride ?? "none"}\``);
  lines.push(`- Executed at: \`${new Date().toISOString()}\``);
  lines.push("");

  for (const result of results) {
    lines.push(`## Turn ${result.turnIndex}`);
    lines.push("");
    lines.push(`**User**`);
    lines.push("");
    lines.push(result.userMessage);
    lines.push("");
    lines.push(`**Prompt Packet (JSON)**`);
    lines.push("");
    lines.push("```json");
    lines.push(JSON.stringify(result.promptPacket, null, 2));
    lines.push("```");
    lines.push("");
    lines.push(`**Model Response**`);
    lines.push("");
    if (result.modelResponse.skipped) {
      lines.push("Skipped (`--dry-run`).");
    } else if (result.modelResponse.error) {
      lines.push(`Error: ${result.modelResponse.error}`);
    } else {
      lines.push(result.modelResponse.text ?? "");
      lines.push("");
      lines.push(`Duration: \`${result.modelResponse.durationMs ?? 0}\` ms`);
    }
    lines.push("");
  }

  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");

  console.log(`Saved run output: ${outputPath}`);
}

(async () => {
  try {
    const options = parseArgs(process.argv);
    await runHarness(options);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
