import type {
  AttachmentKind,
  LocalTimeContext,
  TurnAttachment,
  TurnAudioInput,
  TurnEvent,
  TurnModality,
} from "./contracts";

type BuildTurnEventParams = {
  userId: string;
  personaId: string;
  sessionId?: string;
  modality: TurnModality;
  text?: string;
  transcript?: string;
  timestampUtc: string;
  timezone?: string;
  localTime?: LocalTimeContext;
  audio?: TurnAudioInput;
  attachments?: TurnAttachment[];
  routeMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type BuildVoiceTurnEventParams = {
  userId: string;
  personaId: string;
  sessionId?: string;
  transcript: string;
  timestampUtc: string;
  timezone?: string;
  localTime?: LocalTimeContext;
  audio?: TurnAudioInput;
  routeMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

type BuildTextTurnEventParams = {
  userId: string;
  personaId: string;
  sessionId?: string;
  text: string;
  timestampUtc: string;
  timezone?: string;
  localTime?: LocalTimeContext;
  attachments?: TurnAttachment[];
  routeMetadata?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export function buildTurnEvent(params: BuildTurnEventParams): TurnEvent {
  const metadata =
    params.routeMetadata || params.metadata
      ? {
          ...(params.metadata ?? {}),
          ...(params.routeMetadata ? { route: params.routeMetadata } : {}),
        }
      : undefined;

  // TODO(vNext): attachments are metadata-only until the route accepts
  // multimodal upload payloads as first-class inputs.
  return {
    userId: params.userId,
    personaId: params.personaId,
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    modality: params.modality,
    ...(params.text ? { text: params.text } : {}),
    ...(params.transcript ? { transcript: params.transcript } : {}),
    ...(params.audio ? { audio: params.audio } : {}),
    ...(params.attachments?.length ? { attachments: params.attachments } : {}),
    timestampUtc: params.timestampUtc,
    ...(params.timezone ? { timezone: params.timezone } : {}),
    ...(params.localTime ? { localTime: params.localTime } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function buildVoiceTurnEvent(params: BuildVoiceTurnEventParams): TurnEvent {
  return buildTurnEvent({
    ...params,
    modality: "voice",
  });
}

export function buildTextTurnEvent(params: BuildTextTurnEventParams): TurnEvent {
  return buildTurnEvent({
    ...params,
    modality: params.attachments?.length ? "multimodal" : "text",
  });
}

export function toTurnAttachment(params: {
  id?: string;
  kind: AttachmentKind;
  mimeType?: string;
  filename?: string;
  sizeBytes?: number;
  url?: string;
  metadata?: Record<string, unknown>;
}): TurnAttachment {
  return params;
}
