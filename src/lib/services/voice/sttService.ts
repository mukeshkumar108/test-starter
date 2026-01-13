import { env } from "@/env";

export interface STTResult {
  transcript: string;
  confidence: number;
  duration_ms: number;
}

export async function transcribeAudio(audioBlob: Blob): Promise<STTResult> {
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
    formData.append("model", model);
    
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
