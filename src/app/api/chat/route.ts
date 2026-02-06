import { NextRequest, NextResponse } from "next/server";
import { auth, verifyToken } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { transcribeAudio } from "@/lib/services/voice/sttService";
import { generateResponse } from "@/lib/services/voice/llmService";
import { synthesizeSpeech } from "@/lib/services/voice/ttsService";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
import { autoCurateMaybe } from "@/lib/services/memory/memoryCurator";
import { ensureUserByClerkId } from "@/lib/user";
import { env } from "@/env";
import { getChatModelForPersona } from "@/lib/providers/models";
import { closeStaleSessionIfAny, ensureActiveSession } from "@/lib/services/session/sessionService";
import * as synapseClient from "@/lib/services/synapseClient";

export const runtime = "nodejs";

interface ChatRequestBody {
  personaId: string;
  audioBlob: File;
}

const WEATHER_CACHE = new Map<
  string,
  { fetchedAt: number; weather: string; coordsKey: string }
>();
const WEATHER_TTL_MS = 30 * 60 * 1000;
const WEATHER_TIMEOUT_MS = 1500;
const LIBRARIAN_TOTAL_TIMEOUT_MS = 800;

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function getRequestTimeZone(request: NextRequest) {
  return (
    request.headers.get("x-timezone") ||
    request.headers.get("x-user-timezone") ||
    request.headers.get("x-client-timezone") ||
    undefined
  );
}

function getRequestCoords(request: NextRequest) {
  const latRaw =
    request.headers.get("x-geo-latitude") ||
    request.headers.get("x-client-lat") ||
    request.headers.get("x-latitude");
  const lonRaw =
    request.headers.get("x-geo-longitude") ||
    request.headers.get("x-client-lon") ||
    request.headers.get("x-longitude");
  const lat = latRaw ? Number.parseFloat(latRaw) : NaN;
  const lon = lonRaw ? Number.parseFloat(lonRaw) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function formatLocalDateTime(now: Date, timeZone: string) {
  const dateParts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "2-digit",
  }).formatToParts(now);
  const weekday = dateParts.find((part) => part.type === "weekday")?.value ?? "";
  const month = dateParts.find((part) => part.type === "month")?.value ?? "";
  const day = dateParts.find((part) => part.type === "day")?.value ?? "";
  const dateString = normalizeWhitespace(`${weekday} ${month} ${day}`);

  const timeString = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  return `${dateString}, ${timeString}`;
}

function getLocalHour(now: Date, timeZone: string) {
  const hourString = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hour12: false,
  }).format(now);
  const hour = Number.parseInt(hourString, 10);
  return Number.isNaN(hour) ? null : hour;
}

async function fetchWeather(lat: number, lon: number) {
  const apiKey = process.env.WEATHERAPI_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEATHER_TIMEOUT_MS);
  try {
    const response = await fetch(
      `https://api.weatherapi.com/v1/current.json?key=${apiKey}&q=${lat},${lon}`,
      { signal: controller.signal }
    );
    if (!response.ok) return null;
    const data = await response.json();
    const temp = typeof data?.current?.temp_c === "number" ? Math.round(data.current.temp_c) : null;
    const description =
      typeof data?.current?.condition?.text === "string"
        ? data.current.condition.text
        : null;
    if (temp === null || !description) return null;
    const formattedDesc = description
      .split(" ")
      .map((word: string) =>
        word.length > 0 ? `${word[0].toUpperCase()}${word.slice(1)}` : word
      )
      .join(" ");
    return `${temp}°C, ${formattedDesc}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getCurrentContext(params: {
  lastMessageAt?: Date | null;
  userId: string;
  timeZone?: string;
  coords?: { lat: number; lon: number } | null;
  userTimeZone?: string | null;
}) {
  const now = new Date();
  const serverTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timeZone =
    params.userTimeZone ||
    params.timeZone ||
    serverTimeZone ||
    "Europe/London";

  const formatted = formatLocalDateTime(now, timeZone);
  const localHour = getLocalHour(now, timeZone);
  const lateNightFlag =
    localHour !== null && localHour >= 22
      ? " [CONTEXT]: It is very late at night for the user."
      : "";

  let sessionGap = "";
  if (params.lastMessageAt) {
    const diffMs = now.getTime() - params.lastMessageAt.getTime();
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
    if (diffMinutes > 15) {
      const hours = Math.floor(diffMinutes / 60);
      const minutes = diffMinutes % 60;
      const parts = [];
      if (hours > 0) parts.push(`${hours}h`);
      parts.push(`${minutes}m`);
      sessionGap = ` Session gap: ${parts.join(" ")}`;
    }
  }

  const coords = params.coords;
  const coordsKey = coords ? `${coords.lat.toFixed(4)},${coords.lon.toFixed(4)}` : "";
  const cached = WEATHER_CACHE.get(params.userId);
  const isFresh =
    cached &&
    cached.coordsKey === coordsKey &&
    now.getTime() - cached.fetchedAt < WEATHER_TTL_MS;

  let weather = "Weather: unavailable";
  if (isFresh) {
    weather = `Weather: ${cached.weather}`;
  } else if (coords) {
    void (async () => {
      const result = await fetchWeather(coords.lat, coords.lon);
      if (!result) return;
      WEATHER_CACHE.set(params.userId, {
        fetchedAt: Date.now(),
        weather: result,
        coordsKey,
      });
    })();
  }

  return `[REAL-TIME]: ${formatted}. ${weather}.${sessionGap}${lateNightFlag}`;
}

function getSessionContext(sessionState?: any) {
  if (!sessionState) return null;

  const lastInteractionIso = sessionState.lastInteraction as string | undefined;
  let timeSince = "unknown";
  if (lastInteractionIso) {
    const last = new Date(lastInteractionIso);
    if (!Number.isNaN(last.getTime())) {
      const diffMs = Date.now() - last.getTime();
      const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
      if (diffMinutes < 60) {
        timeSince = `${diffMinutes} minutes`;
      } else if (diffMinutes < 1440) {
        const diffHours = Math.floor(diffMinutes / 60);
        timeSince = `${diffHours} hours`;
      } else {
        const diffDays = Math.floor(diffMinutes / 1440);
        timeSince = `${diffDays} days`;
      }
    }
  }

  const messageCount =
    typeof sessionState.messageCount === "number"
      ? sessionState.messageCount
      : "unknown";

  return `[SESSION STATE] Time Since Last Interaction: ${timeSince} Message Count: ${messageCount}`;
}

type BouncerResult = {
  action: "memory_query" | "none";
  search_string: string | null;
  confidence: number;
};

type MemoryQueryResponse = {
  facts?: Array<{ text?: string; relevance?: number | null; source?: string }>;
  entities?: Array<{ summary?: string; type?: string; uuid?: string }>;
  metadata?: { query?: string; facts?: number; entities?: number };
};

function buildRecallSheet(params: {
  query: string;
  facts: string[];
  entities: string[];
}) {
  const lines: string[] = [];
  lines.push(`Recall Sheet (query: ${params.query})`);
  if (params.facts.length > 0) {
    lines.push("Facts:");
    for (const fact of params.facts.slice(0, 5)) {
      lines.push(`- ${fact}`);
    }
  }
  if (params.entities.length > 0) {
    lines.push("Entities:");
    for (const entity of params.entities.slice(0, 5)) {
      lines.push(`- ${entity}`);
    }
  }
  return lines.join("\n");
}

function sanitizeSearchString(input: string) {
  const cleaned = input.replace(/[^a-zA-Z0-9\s]+/g, " ").trim();
  const collapsed = cleaned.replace(/\s+/g, " ");
  if (!collapsed) return null;
  const words = collapsed.split(" ").slice(0, 4);
  if (words.length < 3) return null;
  const truncated = words.join(" ").slice(0, 48).trim();
  return truncated || null;
}

function extractLastTwoTurns(
  messages: Array<{ role: "user" | "assistant"; content: string }>
) {
  return messages.slice(-4);
}

async function runLibrarianReflex(params: {
  requestId: string;
  userId: string;
  transcript: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  now: Date;
}) {
  const { requestId, userId, transcript, recentMessages, now } = params;
  if (!env.OPENROUTER_API_KEY || !env.SYNAPSE_BASE_URL || !env.SYNAPSE_TENANT_ID) {
    return null;
  }

  const deadline = Date.now() + LIBRARIAN_TOTAL_TIMEOUT_MS;
  const remaining = () => Math.max(0, deadline - Date.now());

  const lastTurns = extractLastTwoTurns(recentMessages)
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n");
  const bouncerPrompt = `You are a Senior Search Engineer. Your goal is to rewrite user intent into optimized search queries for a vector database.

Return ONLY valid JSON:
{"action":"memory_query"|"none","search_string":"keywords or null","confidence":0-1}

RULES:
1. Identify if the user is asking about past events, facts, or previously mentioned people/items.
2. If YES: Extract only the 2-3 most \"High-Entropy\" keywords (Nouns/Proper Nouns).
3. ABSOLUTELY STRIP: Pronouns (my, I, me), prepositions (about, with, for), and temporal filler (when, was, is, the).
4. If the user is just chatting or talking about the present/future, return \"none\".

FEW-SHOT EXAMPLES:
- \"What did I say about my walk when I was in London?\" -> {\"action\":\"memory_query\",\"search_string\":\"London walk\",\"confidence\":1.0}
- \"Remind me about that diet with chicken thighs\" -> {\"action\":\"memory_query\",\"search_string\":\"diet chicken thighs\",\"confidence\":1.0}
- \"Who was that person Ashley I mentioned?\" -> {\"action\":\"memory_query\",\"search_string\":\"Ashley\",\"confidence\":0.9}
- \"Hey Sophie, how's your day?\" -> {\"action\":\"none\",\"search_string\":null,\"confidence\":1.0}

Recent conversation:
${lastTurns}

Current user message:
${transcript}`;

  const bouncerController = new AbortController();
  const bouncerTimeout = setTimeout(
    () => bouncerController.abort(),
    remaining()
  );

  let bouncerResult: BouncerResult | null = null;
  try {
    if (remaining() <= 0) return null;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    };
    if (env.OPENROUTER_APP_URL) {
      headers["HTTP-Referer"] = env.OPENROUTER_APP_URL;
    }
    if (env.OPENROUTER_APP_NAME) {
      headers["X-Title"] = env.OPENROUTER_APP_NAME;
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "meta-llama/llama-3.1-8b-instruct",
        messages: [{ role: "user", content: bouncerPrompt }],
        max_tokens: 80,
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: bouncerController.signal,
    });

    if (!response.ok) {
      console.warn("[librarian.bouncer] request failed", {
        requestId,
        status: response.status,
      });
      return null;
    }

    const data = await response.json();
    const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!content) return null;
    try {
      const parsed = JSON.parse(content) as Partial<BouncerResult>;
      bouncerResult = {
        action: parsed.action === "memory_query" ? "memory_query" : "none",
        search_string:
          typeof parsed.search_string === "string" ? parsed.search_string : null,
        confidence:
          typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
            ? parsed.confidence
            : 0,
      };
    } catch {
      return null;
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("[librarian.bouncer] timeout", { requestId });
      return null;
    }
    console.warn("[librarian.bouncer] error", { requestId, error });
    return null;
  } finally {
    clearTimeout(bouncerTimeout);
  }

  if (!bouncerResult || bouncerResult.action !== "memory_query") return null;
  if (bouncerResult.confidence <= 0.6) return null;

  const sanitized = bouncerResult.search_string
    ? sanitizeSearchString(bouncerResult.search_string)
    : null;
  if (!sanitized) return null;
  if (remaining() <= 0) return null;

  const queryController = new AbortController();
  const queryTimeout = setTimeout(() => queryController.abort(), remaining());
  try {
    const response = await fetch(`${env.SYNAPSE_BASE_URL}/memory/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: env.SYNAPSE_TENANT_ID,
        userId,
        query: sanitized,
        limit: 10,
        referenceTime: now.toISOString(),
      }),
      signal: queryController.signal,
    });
    if (!response.ok) {
      console.warn("[librarian.query] failed", {
        requestId,
        status: response.status,
      });
      return null;
    }
    const data = (await response.json()) as MemoryQueryResponse;
    const facts = Array.isArray(data.facts)
      ? data.facts
          .map((fact) =>
            typeof fact?.text === "string" ? fact.text.trim() : ""
          )
          .filter(Boolean)
      : [];
    const entities = Array.isArray(data.entities)
      ? data.entities
          .map((entity) =>
            typeof entity?.summary === "string" ? entity.summary.trim() : ""
          )
          .filter(Boolean)
      : [];

    if (facts.length === 0 && entities.length === 0) {
      return `No matching memories found for "${sanitized}".`;
    }
    return buildRecallSheet({ query: sanitized, facts, entities });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      console.warn("[librarian.query] timeout", { requestId });
      return null;
    }
    console.warn("[librarian.query] error", { requestId, error });
    return null;
  } finally {
    clearTimeout(queryTimeout);
  }
}

function buildChatMessages(params: {
  persona: string;
  situationalContext?: string;
  supplementalContext?: string | null;
  rollingSummary?: string;
  recentMessages: Array<{ role: "user" | "assistant"; content: string }>;
  transcript: string;
}) {
  const situationalContext = params.situationalContext ?? "";
  const rollingSummary = params.rollingSummary ?? "";
  return [
    { role: "system" as const, content: params.persona },
    ...(situationalContext
      ? [{ role: "system" as const, content: `SITUATIONAL_CONTEXT:\n${situationalContext}` }]
      : []),
    ...(params.supplementalContext
      ? [
          {
            role: "system" as const,
            content: `[SUPPLEMENTAL_CONTEXT]\n${params.supplementalContext}`,
          },
        ]
      : []),
    ...(rollingSummary
      ? [{ role: "system" as const, content: `CURRENT SESSION SUMMARY: ${rollingSummary}` }]
      : []),
    ...params.recentMessages,
    { role: "user" as const, content: params.transcript },
  ];
}

export async function POST(request: NextRequest) {
  const requestId = crypto.randomUUID();
  const traceId = request.headers.get("x-trace-id") || crypto.randomUUID();
  const totalStartTime = Date.now();
  
  try {
    // Auth check
    const { userId: cookieUserId } = await auth();
    let clerkUserId = cookieUserId;

    if (!clerkUserId) {
      const authHeader =
        request.headers.get("authorization") || request.headers.get("Authorization");
      const bearerToken = authHeader?.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

      if (bearerToken) {
        try {
          const verified = await verifyToken(bearerToken, {
            secretKey: env.CLERK_SECRET_KEY,
          });
          clerkUserId = verified?.sub ?? null;
        } catch (error) {
          console.warn("Bearer token verification failed:", error);
        }
      }
    }

    if (!clerkUserId) {
      return NextResponse.json(
        { error: "Unauthorized", requestId },
        { status: 401 }
      );
    }

    // Get user from database
    let user;
    try {
      user = await ensureUserByClerkId(clerkUserId);
    } catch (error) {
      console.error("User upsert failed:", { requestId, error });
      return NextResponse.json(
        { error: "User upsert failed", requestId },
        { status: 500 }
      );
    }

    // Parse multipart form data
    const formData = await request.formData();
    const personaId = formData.get("personaId") as string;
    const audioFile = formData.get("audioBlob") as File;
    const preferredLanguage = formData.get("language") as string | null;

    if (!personaId || !audioFile) {
      return NextResponse.json(
        { error: "Missing personaId or audioBlob", requestId },
        { status: 400 }
      );
    }
    if (audioFile.size === 0) {
      return NextResponse.json(
        { error: "Empty audio", requestId },
        { status: 400 }
      );
    }
    const minAudioBytes = parseInt(process.env.MIN_AUDIO_BYTES ?? "8000", 10);
    if (audioFile.size < minAudioBytes) {
      return NextResponse.json(
        { error: "Audio too short", requestId },
        { status: 400 }
      );
    }

    // Verify persona exists
    const persona = await prisma.personaProfile.findUnique({
      where: { id: personaId },
    });
    if (!persona) {
      return NextResponse.json(
        { error: "Persona not found", requestId },
        { status: 404 }
      );
    }

    // FAST PATH: STT → Context → LLM → TTS
    let stt_ms = 0;
    let llm_ms = 0; 
    let tts_ms = 0;

    // Step 1: Speech-to-Text
    const sttResult = await transcribeAudio(audioFile, preferredLanguage || undefined);
    stt_ms = sttResult.duration_ms;

    if (!sttResult.transcript || sttResult.transcript.trim().length < 2) {
      return NextResponse.json(
        { error: "No speech detected", requestId },
        { status: 400 }
      );
    }

    const now = new Date();
    await closeStaleSessionIfAny(user.id, personaId, now);
    const session = await ensureActiveSession(user.id, personaId, now);

    // Step 2: Build conversation context
    const context = await buildContext(user.id, personaId, sttResult.transcript);

    // Step 3: Generate LLM response
    const rollingSummary = context.rollingSummary ?? "";
    const situationalContext = context.situationalContext ?? "";
    const supplementalContext = await runLibrarianReflex({
      requestId,
      userId: user.id,
      transcript: sttResult.transcript,
      recentMessages: context.recentMessages,
      now,
    });
    const model = getChatModelForPersona(persona.slug);

    const messages = buildChatMessages({
      persona: context.persona,
      situationalContext,
      supplementalContext,
      rollingSummary,
      recentMessages: context.recentMessages,
      transcript: sttResult.transcript,
    });

    const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
    if (totalChars > 20000) {
      console.warn(
        "[chat.prompt.warn]",
        JSON.stringify({
          trace_id: traceId,
          userId: user.id,
          personaId,
          totalChars,
          messageCount: messages.length,
          counts: {
            recentMessages: context.recentMessages.length,
            situationalContext: situationalContext ? 1 : 0,
            supplementalContext: supplementalContext ? 1 : 0,
            rollingSummary: rollingSummary ? 1 : 0,
          },
          model,
        })
      );
    }

    console.log(
      "[chat.trace]",
      JSON.stringify({
        trace_id: traceId,
        userId: user.id,
        personaId,
        model,
        token_usage: null,
        counts: {
          recentMessages: context.recentMessages.length,
          situationalContext: situationalContext ? 1 : 0,
          supplementalContext: supplementalContext ? 1 : 0,
          rollingSummary: rollingSummary ? 1 : 0,
        },
      })
    );

    const debugEnabled =
      env.FEATURE_CONTEXT_DEBUG === "true" &&
      request.headers.get("x-debug-context") === "1";

    let debugPayload: Record<string, unknown> | undefined;
    if (debugEnabled) {
      debugPayload = {
        contextBlocks: {
          persona: context.persona,
          situationalContext,
          supplementalContext,
          rollingSummary,
        },
      };
    }

    const llmResponse = await generateResponse(messages, persona.slug);
    llm_ms = llmResponse.duration_ms;

    // Step 4: Text-to-Speech
    const ttsResult = await synthesizeSpeech(llmResponse.content, persona.ttsVoiceId);
    tts_ms = ttsResult.duration_ms;

    const total_ms = Date.now() - totalStartTime;

    // Step 5: Store message with timing metadata
    await prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "user",
        content: sttResult.transcript,
        metadata: {
          stt_confidence: sttResult.confidence,
          stt_ms,
          total_ms,
          request_id: requestId,
        },
      },
    });

    await prisma.message.create({
      data: {
        userId: user.id,
        personaId,
        role: "assistant", 
        content: llmResponse.content,
        audioUrl: ttsResult.audioUrl,
        metadata: {
          llm_ms,
          tts_ms,
          total_ms,
          request_id: requestId,
        },
      },
    });

    if (
      env.FEATURE_SYNAPSE_INGEST === "true" &&
      env.FEATURE_SYNAPSE_SESSION_INGEST !== "true"
    ) {
      fireAndForgetSynapseIngest({
        requestId,
        userId: user.id,
        personaId,
        sessionId: session.id,
        transcript: sttResult.transcript,
        assistantText: llmResponse.content,
      });
    }

    runShadowJudgeIfEnabled({
      userId: user.id,
      personaId,
      userMessage: sttResult.transcript,
      assistantResponse: llmResponse.content,
      currentSessionState: undefined,
    });

    autoCurateMaybe(user.id, personaId).catch((error) => {
      console.warn("[curator.auto.err]", { userId: user.id, personaId, error });
    });

    // Return fast response
    return NextResponse.json({
      transcript: sttResult.transcript,
      response: llmResponse.content,
      audioUrl: ttsResult.audioUrl,
      timing: {
        stt_ms,
        llm_ms,
        tts_ms,
        total_ms,
      },
      requestId,
      ...(debugPayload ? { debug: debugPayload } : {}),
    });

  } catch (error) {
    console.error("Chat API Error:", { requestId, traceId, error });
    return NextResponse.json(
      { 
        error: error instanceof Error ? error.message : "Internal server error",
        requestId 
      },
      { status: 500 }
    );
  }
}

function fireAndForgetSynapseIngest(params: {
  requestId: string;
  userId: string;
  personaId: string;
  sessionId: string;
  transcript: string;
  assistantText: string;
}) {
  const { requestId, userId, personaId, sessionId, transcript, assistantText } = params;
  const basePayload = {
    tenantId: env.SYNAPSE_TENANT_ID,
    userId,
    personaId,
    sessionId,
    metadata: { sessionId },
  };

  const getIngest = () => {
    const override = (globalThis as { __synapseIngestOverride?: typeof synapseClient.ingest })
      .__synapseIngestOverride;
    return typeof override === "function" ? override : synapseClient.ingest;
  };

  const ingestOne = (
    role: "user" | "assistant",
    text: string
  ) => {
    const start = Date.now();
    getIngest()({
        ...basePayload,
        role,
        text,
        timestamp: new Date().toISOString(),
      })
      .then((result) => {
        const ms = Date.now() - start;
        const status =
          result && typeof (result as { status?: number }).status === "number"
            ? (result as { status?: number }).status
            : null;
        console.log("[synapse.ingest]", {
          requestId,
          role,
          ms,
          status,
        });
      })
      .catch((error) => {
        console.warn("[synapse.ingest.error]", {
          requestId,
          role,
          error,
        });
      });
  };

  ingestOne("user", transcript);
  ingestOne("assistant", assistantText);
}

export const __test__fireAndForgetSynapseIngest = fireAndForgetSynapseIngest;

function getShadowJudge() {
  const override = (globalThis as { __processShadowPathOverride?: typeof processShadowPath })
    .__processShadowPathOverride;
  return typeof override === "function" ? override : processShadowPath;
}

function runShadowJudgeIfEnabled(params: Parameters<typeof processShadowPath>[0]) {
  const override = (globalThis as { __shadowJudgeFlagOverride?: boolean })
    .__shadowJudgeFlagOverride;
  const enabled =
    typeof override === "boolean" ? override : env.FEATURE_SHADOW_JUDGE !== "false";
  if (!enabled) return;
  // SHADOW PATH: Process memory updates asynchronously
  // Note: In production, use waitUntil() from @vercel/functions
  // For v0.1, using Promise without await to simulate non-blocking
  getShadowJudge()(params).catch((error) => {
    console.error("Shadow path failed (non-blocking):", error);
  });
}

export const __test__runShadowJudgeIfEnabled = runShadowJudgeIfEnabled;
export const __test__runLibrarianReflex = runLibrarianReflex;
export const __test__buildChatMessages = buildChatMessages;
