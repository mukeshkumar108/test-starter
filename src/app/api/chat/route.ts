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
import { searchMemories } from "@/lib/services/memory/memoryStore";
import { closeStaleSessionIfAny, ensureActiveSession } from "@/lib/services/session/sessionService";

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
    if (diffMinutes > 30) {
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
    await ensureActiveSession(user.id, personaId, now);

    // Step 2: Build conversation context
    const requestTimeZone = getRequestTimeZone(request);
    const requestCoords = getRequestCoords(request);
    const context = await buildContext(user.id, personaId, sttResult.transcript);
    const lastMessage = await prisma.message.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    // Step 3: Generate LLM response
    const sessionContext = getSessionContext(context.sessionState);
    const commitmentStrings = context.commitments.join("\n");
    let threadStrings = context.threads.join("\n");
    const frictionStrings = context.frictions.join("\n");
    const recentWins = context.recentWins;
    const recentWinStrings = recentWins.join("\n");
    const rollingSummary = context.rollingSummary ?? "";
    let sessionSummary = context.sessionSummary ?? "";
    let relevantMemoryStrings = context.relevantMemories.join("\n");
    const nonPinnedFoundationStrings = "";
    const foundationMemoryStrings = context.foundationMemories.join("\n");
    const model = getChatModelForPersona(persona.slug);
    const realTimeContext = getCurrentContext({
      lastMessageAt: lastMessage?.createdAt,
      userId: user.id,
      timeZone: requestTimeZone,
      coords: requestCoords,
    });
    const MAX_CONTEXT_TOKENS = 1200;
    const estimateTokens = (value: string) => Math.ceil(value.length / 4);
    const estimateMessageTokens = () => {
      let total = 0;
      total += estimateTokens(realTimeContext);
      if (sessionContext) total += estimateTokens(sessionContext);
      total += estimateTokens(context.persona);
      if (foundationMemoryStrings) total += estimateTokens(foundationMemoryStrings);
      if (relevantMemoryStrings) total += estimateTokens(relevantMemoryStrings);
      if (commitmentStrings) total += estimateTokens(commitmentStrings);
      if (threadStrings) total += estimateTokens(threadStrings);
      if (frictionStrings) total += estimateTokens(frictionStrings);
      if (recentWinStrings) total += estimateTokens(recentWinStrings);
      if (context.userSeed) total += estimateTokens(context.userSeed);
      if (context.summarySpine) total += estimateTokens(context.summarySpine);
      if (rollingSummary) total += estimateTokens(rollingSummary);
      if (sessionSummary) total += estimateTokens(sessionSummary);
      total += context.recentMessages.reduce(
        (sum, message) => sum + estimateTokens(message.content),
        0
      );
      total += estimateTokens(sttResult.transcript);
      return total;
    };

    let estimatedTokens = estimateMessageTokens();
    const dropOrder = [
      () => {
        relevantMemoryStrings = "";
      },
      () => {
        sessionSummary = "";
      },
      () => {
        threadStrings = "";
      },
      () => {
        // Placeholder for non-pinned foundation overflow (pinned-only foundation is kept).
      },
    ];
    for (const drop of dropOrder) {
      if (estimatedTokens <= MAX_CONTEXT_TOKENS) break;
      drop();
      estimatedTokens = estimateMessageTokens();
    }

    const messages = [
      {
        role: "system" as const,
        content: realTimeContext,
      },
      ...(sessionContext ? [{ role: "system" as const, content: sessionContext }] : []),
      { role: "system" as const, content: context.persona },
      ...(foundationMemoryStrings
        ? [{ role: "system" as const, content: `[FOUNDATION MEMORIES]:\n${foundationMemoryStrings}` }]
        : []),
      ...(relevantMemoryStrings
        ? [{ role: "system" as const, content: `[RELEVANT MEMORIES]:\n${relevantMemoryStrings}` }]
        : []),
      ...(commitmentStrings
        ? [
            {
              role: "system" as const,
              content: `COMMITMENTS (pending):\n${commitmentStrings}`,
            },
          ]
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
      ...(context.userSeed ? [{ role: "system" as const, content: `User context: ${context.userSeed}` }] : []),
      ...(context.summarySpine ? [{ role: "system" as const, content: `Conversation summary: ${context.summarySpine}` }] : []),
      ...(rollingSummary
        ? [
            {
              role: "system" as const,
              content: `CURRENT SESSION SUMMARY: ${rollingSummary}`,
            },
          ]
        : []),
      ...(sessionSummary
        ? [
            {
              role: "system" as const,
              content: `LATEST SESSION SUMMARY: ${sessionSummary}`,
            },
          ]
        : []),
      ...context.recentMessages,
      { role: "user" as const, content: sttResult.transcript },
    ];

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
            foundation: context.foundationMemories.length,
            relevant: context.relevantMemories.length,
            commitments: context.commitments.length,
            threads: context.threads.length,
            frictions: context.frictions.length,
            wins: context.recentWins.length,
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
          foundationMemories: context.foundationMemories.length,
          relevantMemories: context.relevantMemories.length,
          commitments: context.commitments.length,
          threads: context.threads.length,
          frictions: context.frictions.length,
          recentWins: context.recentWins.length,
        },
      })
    );

    const debugEnabled =
      env.FEATURE_CONTEXT_DEBUG === "true" &&
      request.headers.get("x-debug-context") === "1";

    let debugPayload: Record<string, unknown> | undefined;
    if (debugEnabled) {
      const rawRetrieval = await searchMemories(user.id, sttResult.transcript, 12);
      debugPayload = {
        contextBlocks: {
          realTime: realTimeContext,
          session: sessionContext,
          persona: context.persona,
          foundationMemories: foundationMemoryStrings,
          relevantMemories: relevantMemoryStrings,
          commitments: commitmentStrings,
          threads: threadStrings,
          frictions: frictionStrings,
          recentWins: recentWinStrings,
          userSeed: context.userSeed,
          summarySpine: context.summarySpine,
          rollingSummary,
          sessionSummary,
        },
        retrieval: {
          query: sttResult.transcript,
          results: rawRetrieval,
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

    // SHADOW PATH: Process memory updates asynchronously
    // Note: In production, use waitUntil() from @vercel/functions
    // For v0.1, using Promise without await to simulate non-blocking
    processShadowPath({
      userId: user.id,
      personaId,
      userMessage: sttResult.transcript,
      assistantResponse: llmResponse.content,
      currentSessionState: context.sessionState,
    }).catch(error => {
      console.error("Shadow path failed (non-blocking):", error);
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
