import { env } from "@/env";
import { put } from "@vercel/blob";

export interface TTSResult {
  audioUrl: string;
  duration_ms: number;
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

function sanitizeForVoice(text: string): string {
  return text.replace(/[*_`#\[\]]/g, "").replace(/\s{2,}/g, " ").trim();
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
  if (isNightVoiceWindow(params.localHour)) {
    return {
      // Slightly higher stability + lower style at night to reduce rushed delivery.
      stability: 0.56,
      similarity_boost: 0.76,
      style: hasLaugh ? 0.32 : 0.16,
      use_speaker_boost: true,
    };
  }
  return {
    stability: 0.46,
    similarity_boost: 0.78,
    style: hasLaugh ? 0.4 : 0.24,
    use_speaker_boost: true,
  };
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
  
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text: ttsText,
        model_id: "eleven_monolingual_v1",
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
    
    // Upload to Vercel blob storage
    const filename = `tts-${Date.now()}.mp3`;
    const blob = await put(filename, audioBlob, {
      access: "public",
      contentType: "audio/mpeg",
    });

    return {
      audioUrl: blob.url,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error("TTS Service Error:", error);
    throw new Error("Speech synthesis failed");
  }
}

export const __test__isNightVoiceWindow = isNightVoiceWindow;
export const __test__resolveVoiceSettings = resolveVoiceSettings;
