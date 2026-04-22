import type { TurnDecision, TurnExecutionResult, TurnPacket } from "./contracts";

export type TurnExecutionAdapter = {
  name: string;
  mode: NonNullable<TurnExecutionResult["execution"]>["mode"];
  execute: (packet: TurnPacket, decision: TurnDecision) => Promise<TurnExecutionResult>;
};

function getPlaceholderText(packet: TurnPacket): string {
  return packet.dialogue.currentTurn
    ? "vNext runtime skeleton is not wired to generation yet."
    : "vNext runtime skeleton received an empty turn.";
}

function summarizePacket(packet: TurnPacket) {
  return {
    sectionCount: packet.context.sections.length,
    sectionKeys: packet.context.sections.map((section) => section.key),
    recentTurnCount: packet.dialogue.recentTurns.length,
    hasCurrentTurn: Boolean(packet.dialogue.currentTurn),
  };
}

const stubExecutionAdapter: TurnExecutionAdapter = {
  name: "vnext.stubExecutionAdapter",
  mode: "stub",
  async execute(packet, decision) {
    return {
      text: getPlaceholderText(packet),
      execution: {
        mode: "stub",
        backend: "none",
        status: "placeholder",
        isPlaceholder: true,
      },
      model: {
        tier: decision.modelTier,
        reasoningEffort: decision.reasoningEffort,
      },
      tools: {
        calls: [],
        results: [],
      },
      actionsRequested: [],
      trace: {
        source: "adapter",
        adapter: this.name,
        status: "placeholder",
        decision: {
          intent: decision.intent,
          sensitivity: decision.sensitivity,
          toolNeed: decision.toolNeed,
          modelTier: decision.modelTier,
          responseMode: decision.responseMode,
        },
        packet: summarizePacket(packet),
        notes: [
          "no_live_generation",
          "no_prompt_assembly",
          "future_backends_direct_model_tool_enabled_legacy_mastra",
        ],
      },
    };
  },
};

export async function executeTurn(
  packet: TurnPacket,
  decision: TurnDecision
): Promise<TurnExecutionResult> {
  // TODO(vNext): select a real backend adapter here after packet/prompt parity is proven.
  return stubExecutionAdapter.execute(packet, decision);
}

export const __test__ = {
  getPlaceholderText,
  summarizePacket,
  stubExecutionAdapter,
};
