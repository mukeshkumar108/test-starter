import { env } from "@/env";

export interface STTResult {
  transcript: string;
  confidence: number;
  duration_ms: number;
}

export async function transcribeAudio(audioBlob: Blob): Promise<STTResult> {
  const startTime = Date.now();
  
  try {
    const formData = new FormData();
    formData.append("audio", audioBlob);
    formData.append("model", "whisper-1");
    
    const response = await fetch("https://api.lemonfox.ai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.LEMONFOX_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`LemonFox STT failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      transcript: data.text || "",
      confidence: data.confidence || 0.9,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error("STT Service Error:", error);
    throw new Error("Speech transcription failed");
  }
}