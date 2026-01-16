import { env } from "@/env";

export interface STTResult {
  transcript: string;
  confidence: number;
  duration_ms: number;
}

export async function transcribeAudio(
  audioBlob: Blob,
  preferredLanguage?: string
): Promise<STTResult> {
  const startTime = Date.now();
  
  try {
    const audioBuffer = await audioBlob.arrayBuffer().catch(() => null);
    const audioBytes = audioBuffer ? new Uint8Array(audioBuffer) : null;
    const signature = audioBytes
      ? Array.from(audioBytes.slice(0, 8))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ")
      : "<no buffer>";

    console.log("[stt] input", {
      mimeType: audioBlob.type || "<unknown>",
      bytes: audioBlob.size,
      signature,
    });

    const formData = new FormData();
    formData.append("audio", audioBlob);
    formData.append("file", audioBlob, "audio.webm");
    const model = "whisper-1";
    const language = preferredLanguage || "en";
    formData.append("model", model);
    formData.append("language", language);
    
    const response = await fetch("https://api.lemonfox.ai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.LEMONFOX_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "<no body>");
      const truncated = errText.length > 2000 ? `${errText.slice(0, 2000)}…` : errText;
      console.error("[stt] LemonFox error", {
        status: response.status,
        statusText: response.statusText,
        errText: truncated,
        requestContentType: "multipart/form-data",
        audioBytes: audioBlob.size,
        model,
      });
      throw new Error(`LemonFox STT failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const sanitized = sanitizeTranscript(data.text || "");
    
    return {
      transcript: sanitized,
      confidence: data.confidence || 0.9,
      duration_ms: Date.now() - startTime,
    };
  } catch (error) {
    console.error("STT Service Error:", error);
    throw new Error("Speech transcription failed");
  }
}

function sanitizeTranscript(text: string) {
  if (!text) return text;

  const asciiLetters = (text.match(/[A-Za-z]/g) || []).length;
  const nonAscii = (text.match(/[^\x00-\x7F]/g) || []).length;
  let cleaned = text;

  if (asciiLetters >= nonAscii) {
    cleaned = cleaned.replace(/[\u0080-\uFFFF]+/g, " ");
  } else {
    cleaned = cleaned.replace(/([\u0080-\uFFFF]{2,})\1+/g, "$1");
  }

  return cleaned.replace(/\s+/g, " ").trim();
}
