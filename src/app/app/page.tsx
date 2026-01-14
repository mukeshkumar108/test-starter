"use client";

import { UserButton } from "@clerk/nextjs";
import { useState, useEffect, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { VoiceOrb, VoiceState } from "@/components/voice/VoiceOrb";
import { useAudioManager } from "@/components/voice/AudioManager";

function AppContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const personaId = searchParams.get("personaId");
  
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [currentPersona, setCurrentPersona] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  
  // Redirect to persona picker if no persona selected
  useEffect(() => {
    if (!personaId) {
      router.push("/persona-picker");
      return;
    }
    
    // Fetch persona details
    fetchPersona(personaId);
  }, [personaId, router]);

  const fetchPersona = async (id: string) => {
    try {
      const response = await fetch(`/api/personas`);
      const data = await response.json();
      const persona = data.personas?.find((p: any) => p.id === id);
      
      if (persona) {
        setCurrentPersona(persona);
      } else {
        router.push("/persona-picker");
      }
    } catch (error) {
      console.error("Error fetching persona:", error);
      setError("Failed to load persona");
    }
  };

  const handleRecordingComplete = useCallback(async (audioBlob: Blob) => {
    if (!personaId) return;
    
    try {
      setVoiceState("thinking");

      console.log("[chat] outgoing audio", {
        mimeType: audioBlob.type || "<unknown>",
        bytes: audioBlob.size,
      });
      
      const formData = new FormData();
      formData.append("personaId", personaId);
      formData.append("audioBlob", audioBlob);
      
      const response = await fetch("/api/chat", {
        method: "POST",
        body: formData,
      });
      
      if (!response.ok) {
        let payload: any = null;
        let text = "";
        try {
          payload = await response.json();
        } catch {
          text = await response.text().catch(() => "");
        }

        const status = response.status;
        const error = payload?.error || (text ? text.slice(0, 200) : "Unknown error");
        const requestId = payload?.requestId;

        console.error("[chat] request failed", {
          status,
          error,
          requestId,
          clerkReason: response.headers.get("x-clerk-auth-reason"),
        });

        if (status === 400) {
          if (payload?.error === "Empty audio") {
            setError("No audio captured. Try speaking a bit longer.");
            setVoiceState("idle");
            return;
          }
          if (payload?.error === "Audio too short") {
            setError("Try holding the mic a bit longer.");
            setVoiceState("idle");
            return;
          }
          if (payload?.error === "No speech detected") {
            setError("I couldn’t hear you—try again in a quieter spot.");
            setVoiceState("idle");
            return;
          }
        }

        const details = requestId ? `${error} (requestId: ${requestId})` : error;
        setError(`Request failed (${status}): ${details}`);
        setVoiceState("idle");
        return;
      }
      
      let data: any = null;
      try {
        data = await response.json();
      } catch {
        const details = response.headers.get("x-request-id");
        const requestId = details ? ` (requestId: ${details})` : "";
        setError(`Request failed (${response.status}): Invalid JSON response${requestId}`);
        setVoiceState("idle");
        return;
      }
      
      // Play response audio using gesture-primed audio element
      if (data.audioUrl) {
        setVoiceState("speaking");
        const success = await audioManager.playResponseAudio(data.audioUrl);
        if (!success) {
          setError("Audio playback failed - try again");
        }
      } else {
        setVoiceState("idle");
      }
      
    } catch (error) {
      console.error("Chat error:", error);
      setError("Conversation failed");
      setVoiceState("idle");
    }
  }, [personaId]);

  const handleError = useCallback((errorMessage: string) => {
    setError(errorMessage);
    setVoiceState("idle");
  }, []);

  const [recordingStartTime, setRecordingStartTime] = useState<number | null>(null);

  const audioManager = useAudioManager({
    onRecordingComplete: handleRecordingComplete,
    onError: handleError,
    onAutoplaySuccess: () => {
      // Set up audio end handler for seamless voice loop
      if (audioManager.persistentAudio) {
        audioManager.persistentAudio.onended = () => setVoiceState("idle");
        audioManager.persistentAudio.onerror = () => {
          setVoiceState("idle");
          setError("Audio playback interrupted");
        };
      }
    },
    onAutoplayFailed: () => {
      setVoiceState("idle");
      setError("Autoplay failed - iOS may require manual interaction");
    },
  });

  const handleVoiceOrbTap = () => {
    const now = Date.now();
    
    switch (voiceState) {
      case "idle":
        // First tap: Prime audio and start recording
        audioManager.primeAudioForSession();
        setVoiceState("listening");
        setRecordingStartTime(now);
        // Start recording after priming completes
        setTimeout(() => {
          audioManager.startRecording();
        }, 100);
        break;
        
      case "listening":
        // Second tap: Stop recording (with debounce)
        if (recordingStartTime && (now - recordingStartTime) < 400) {
          // Too soon - ignore tap to prevent MediaRecorder errors
          return;
        }
        audioManager.stopRecording();
        setRecordingStartTime(null);
        break;
        
      case "speaking":
        // Interrupt tap: Stop audio and return to idle
        audioManager.interruptPlayback();
        setVoiceState("idle");
        break;
        
      case "thinking":
        // No-op: taps disabled during processing
        break;
    }
  };

  if (!currentPersona) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-white"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800">
      <header className="p-6">
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-4">
            <button
              onClick={() => router.push("/persona-picker")}
              className="px-4 py-2 bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors"
            >
              Change Persona
            </button>
            <div className="text-white">
              <h1 className="text-lg font-semibold">{currentPersona.name}</h1>
              <p className="text-sm text-gray-400">{currentPersona.description}</p>
            </div>
          </div>
          <UserButton />
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 pb-20">
        <div className="text-center mb-12">
          <h2 className="text-3xl font-bold text-white mb-4">
            Voice Companion
          </h2>
          <p className="text-gray-400 max-w-md">
            Hold the button and speak. Release when you're done. 
            Your companion will respond with voice.
          </p>
        </div>

        <VoiceOrb
          state={voiceState}
          onTap={handleVoiceOrbTap}
          isPriming={audioManager.isPriming}
        />

        {error && (
          <div className="mt-6 p-4 bg-red-900/50 border border-red-500 rounded-lg">
            <p className="text-red-200 text-center">{error}</p>
            <button
              onClick={() => setError(null)}
              className="mt-2 w-full px-4 py-2 bg-red-700 text-white rounded hover:bg-red-600"
            >
              Dismiss
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

export default function AppPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-900" />}>
      <AppContent />
    </Suspense>
  );
}
