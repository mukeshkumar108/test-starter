import { env } from "@/env";
import { put } from "@vercel/blob";

export interface TTSResult {
  audioUrl: string;
  duration_ms: number;
}

export async function synthesizeSpeech(
  text: string, 
  voiceId: string
): Promise<TTSResult> {
  const startTime = Date.now();
  
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": env.ELEVENLABS_API_KEY,
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`ElevenLabs TTS failed: ${response.status} ${response.statusText}`);
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