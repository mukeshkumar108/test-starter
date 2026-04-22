import { buildVoiceTurnEvent } from "./buildTurnEvent";
import type { LocalTimeContext, TurnAudioInput, TurnEvent } from "./contracts";
import {
  LEGACY_DECISION_SIGNALS_METADATA_KEY,
  type LegacyTurnDecisionSignals,
} from "./decideTurn";

export type BuildTurnEventFromChatRouteInputParams = {
  userId: string;
  personaId: string;
  sessionId: string;
  transcript: string;
  timestampUtc: string;
  timezone: string;
  localTime: LocalTimeContext;
  audio?: TurnAudioInput;
  requestId: string;
  legacyDecisionSignals?: LegacyTurnDecisionSignals;
};

export function buildTurnEventFromChatRouteInput(
  params: BuildTurnEventFromChatRouteInputParams
): TurnEvent {
  // TODO(vNext): this adapter is voice-route-specific while /api/chat remains
  // audio-first. Text and attachment routes should get their own boundary
  // adapters before any shared multimodal endpoint work.
  return buildVoiceTurnEvent({
    userId: params.userId,
    personaId: params.personaId,
    sessionId: params.sessionId,
    transcript: params.transcript,
    timestampUtc: params.timestampUtc,
    timezone: params.timezone,
    localTime: params.localTime,
    audio: params.audio,
    routeMetadata: {
      requestId: params.requestId,
      source: "chat_route_vnext_prepare_only",
    },
    metadata: params.legacyDecisionSignals
      ? {
          [LEGACY_DECISION_SIGNALS_METADATA_KEY]: params.legacyDecisionSignals,
        }
      : undefined,
  });
}
