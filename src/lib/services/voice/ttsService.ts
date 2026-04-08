import { env } from "@/env";
import { put } from "@vercel/blob";

export interface TTSResult {
  audioUrl: string;
  duration_ms: number;
  synthesis_ms: number;
  upload_ms: number;
  text_chars: number;
  model_id: string;
}

type TTSOptions = {
  localHour?: number;
};

type VoiceSettings = {
  stability: number;
  similarity_boost: number;
  style: number;
  use_speaker_boost: boolean;
};

const DEFAULT_TTS_MODEL = "eleven_turbo_v2_5";
const MAX_TTS_SENTENCES = 3;
const MAX_TTS_CHARS = 420;

function stripUrls(text: string) {
  return text.replace(/https?:\/\/\S+/gi, "");
}

function stripReadoutSections(text: string) {
  return text
    .replace(/\bSources:[\s\S]*$/i, "")
    .replace(/\bSource:[\s\S]*$/i, "");
}

function limitSentences(text: string, maxSentences: number) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  if (sentences.length <= maxSentences) return text.trim();
  return sentences.slice(0, maxSentences).join(" ").trim();
}

function capVoiceText(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  const capped = text.slice(0, maxChars);
  const lastBoundary = Math.max(capped.lastIndexOf("."), capped.lastIndexOf("!"), capped.lastIndexOf("?"));
  if (lastBoundary > 120) {
    return capped.slice(0, lastBoundary + 1).trim();
  }
  return `${capped.trim()}...`;
}

function sanitizeForVoice(text: string): string {
  const withoutReadouts = stripReadoutSections(text);
  const withoutUrls = stripUrls(withoutReadouts);
  const normalized = withoutUrls
    .replace(/[*_`#\[\]]/g, "")
    .replace(/^[\-\u2022]\s+/gm, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const sentenceLimited = limitSentences(normalized, MAX_TTS_SENTENCES);
  return capVoiceText(sentenceLimited, MAX_TTS_CHARS);
}

function isNightVoiceWindow(localHour?: number) {
  if (typeof localHour !== "number" || !Number.isFinite(localHour)) return false;
  return localHour >= 23 || localHour < 5;
}

function resolveVoiceSettings(params: {
  text: string;
  localHour?: number;
}): VoiceSettings {
  const hasLaugh = /\bhaha\b/i.test(params.text);
  const baseline: VoiceSettings = {
    stability: 0.56,
    similarity_boost: 0.76,
    style: hasLaugh ? 0.32 : 0.16,
    use_speaker_boost: true,
  };
  if (isNightVoiceWindow(params.localHour)) {
    return {
      // Extra-soft night mode on top of the new calmer baseline.
      stability: 0.62,
      similarity_boost: 0.76,
      style: hasLaugh ? 0.26 : 0.12,
      use_speaker_boost: true,
    };
  }
  return baseline;
}

export async function synthesizeSpeech(
  text: string,
  voiceId: string,
  options: TTSOptions = {}
): Promise<TTSResult> {
  const startTime = Date.now();
  const ttsText = sanitizeForVoice(text);
  const voiceSettings = resolveVoiceSettings({
    text: ttsText,
    localHour: options.localHour,
  });
  const modelId = env.ELEVENLABS_TTS_MODEL_ID?.trim() || DEFAULT_TTS_MODEL;
  
  try {
    const synthStartedAt = Date.now();
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: ttsText,
        model_id: modelId,
        voice_settings: voiceSettings,
      }),
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      console.warn("[tts.response.html]", {
        provider: "elevenlabs",
        status: response.status,
      });
    }

    // Get audio blob
    const audioBlob = await response.blob();
    const synthesisMs = Math.max(0, Date.now() - synthStartedAt);
    
    // Upload to Vercel blob storage
    const uploadStartedAt = Date.now();
    const filename = `tts-${Date.now()}.mp3`;
    const blob = await put(filename, audioBlob, {
      access: "public",
      contentType: "audio/mpeg",
    });
    const uploadMs = Math.max(0, Date.now() - uploadStartedAt);

    console.log(
      "[tts.trace]",
      JSON.stringify({
        provider: "elevenlabs",
        model_id: modelId,
        text_chars: ttsText.length,
        synthesis_ms: synthesisMs,
        upload_ms: uploadMs,
        total_ms: Math.max(0, Date.now() - startTime),
      })
    );

    return {
      audioUrl: blob.url,
      duration_ms: Date.now() - startTime,
      synthesis_ms: synthesisMs,
      upload_ms: uploadMs,
      text_chars: ttsText.length,
      model_id: modelId,
    };
  } catch (error) {
    console.error("TTS Service Error:", error);
    throw new Error("Speech synthesis failed");
  }
}

export const __test__isNightVoiceWindow = isNightVoiceWindow;
export const __test__resolveVoiceSettings = resolveVoiceSettings;
export const __test__sanitizeForVoice = sanitizeForVoice;
