import { NextRequest, NextResponse } from "next/server";
import { auth, verifyToken } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";
import { transcribeAudio } from "@/lib/services/voice/sttService";
import { generateResponse } from "@/lib/services/voice/llmService";
import { synthesizeSpeech } from "@/lib/services/voice/ttsService";
import { buildContext } from "@/lib/services/memory/contextBuilder";
import { processShadowPath } from "@/lib/services/memory/shadowJudge";
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

function getCurrentContext(params: { lastMessageAt?: Date | null }) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const formatted = formatter.format(now);
  const location = "Cambridge, UK";
  const weather = "Grey/Overcast"; // TODO: wire real weather API

  let lastInteraction = "No prior messages";
  if (params.lastMessageAt) {
    const diffMs = now.getTime() - params.lastMessageAt.getTime();
    const diffMinutes = Math.max(0, Math.floor(diffMs / 60000));
    if (diffMinutes < 60) {
      lastInteraction = `${diffMinutes} minutes ago`;
    } else {
      const diffHours = Math.floor(diffMinutes / 60);
      lastInteraction = `${diffHours} hours ago`;
    }
  }

  return `[REAL-TIME CONTEXT] Time: ${formatted} Location: ${location} Weather: ${weather} Last Interaction: ${lastInteraction}`;
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
    const context = await buildContext(user.id, personaId, sttResult.transcript);
    const lastMessage = await prisma.message.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    // Step 3: Generate LLM response
    const foundationMemoryStrings = context.foundationMemories.join("\n");
    const relevantMemoryStrings = context.relevantMemories.join("\n");
    const sessionContext = getSessionContext(context.sessionState);
    const activeTodos = context.activeTodos;
    const activeTodoStrings = activeTodos.join("\n");
    const recentWins = context.recentWins;
    const recentWinStrings = recentWins.join("\n");
    const model = getChatModelForPersona(persona.slug);
    const messages = [
      { role: "system" as const, content: getCurrentContext({ lastMessageAt: lastMessage?.createdAt }) },
      ...(sessionContext ? [{ role: "system" as const, content: sessionContext }] : []),
      { role: "system" as const, content: context.persona },
      ...(foundationMemoryStrings
        ? [{ role: "system" as const, content: `[FOUNDATION MEMORIES]:\n${foundationMemoryStrings}` }]
        : []),
      ...(relevantMemoryStrings
        ? [{ role: "system" as const, content: `[RELEVANT MEMORIES]:\n${relevantMemoryStrings}` }]
        : []),
      ...(activeTodoStrings
        ? [
            {
              role: "system" as const,
              content: `OPEN LOOPS (pending):\n${activeTodoStrings}`,
            },
          ]
        : []),
      ...(recentWinStrings
        ? [{ role: "system" as const, content: `Recent wins:\n${recentWinStrings}` }]
        : []),
      ...(context.userSeed ? [{ role: "system" as const, content: `User context: ${context.userSeed}` }] : []),
      ...(context.summarySpine ? [{ role: "system" as const, content: `Conversation summary: ${context.summarySpine}` }] : []),
      ...(context.sessionSummary
        ? [
            {
              role: "system" as const,
              content: `LATEST SESSION SUMMARY: ${context.sessionSummary}`,
            },
          ]
        : []),
      ...context.recentMessages,
      { role: "user" as const, content: sttResult.transcript },
    ];

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
          pendingTodos: context.activeTodos.length,
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
          realTime: getCurrentContext({ lastMessageAt: lastMessage?.createdAt }),
          session: sessionContext,
          persona: context.persona,
          foundationMemories: foundationMemoryStrings,
          relevantMemories: relevantMemoryStrings,
          pendingTodos: activeTodoStrings,
          recentWins: recentWinStrings,
          userSeed: context.userSeed,
          summarySpine: context.summarySpine,
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
