"use client";

import { UserButton } from "@clerk/nextjs";
import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { VoiceOrb, VoiceState } from "@/components/voice/VoiceOrb";
import { useAudioManager } from "@/components/voice/AudioManager";

export default function AppPage() {
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
      
      const formData = new FormData();
      formData.append("personaId", personaId);
      formData.append("audioBlob", audioBlob);
      
      const response = await fetch("/api/chat", {
        method: "POST",
        body: formData,
      });
      
      if (!response.ok) {
        if (response.status === 400) {
          const data = await response.json().catch(() => null);
          if (data?.error === "Empty audio") {
            setError("No audio captured. Try speaking a bit longer.");
            setVoiceState("idle");
            return;
          }
          if (data?.error === "Audio too short") {
            setError("Try holding the mic a bit longer.");
            setVoiceState("idle");
            return;
          }
          if (data?.error === "No speech detected") {
            setError("I couldn’t hear you—try again in a quieter spot.");
            setVoiceState("idle");
            return;
          }
        }
        throw new Error("Chat request failed");
      }
      
      const data = await response.json();
      
      // Play response audio
      if (data.audioUrl) {
        setVoiceState("speaking");
        const audio = new Audio(data.audioUrl);
        audio.onended = () => setVoiceState("idle");
        audio.onerror = () => {
          setVoiceState("idle");
          setError("Audio playback failed");
        };
        await audio.play();
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

  const audioManager = useAudioManager({
    onRecordingComplete: handleRecordingComplete,
    onError: handleError,
  });

  const handleStartRecording = () => {
    setVoiceState("listening");
    audioManager.startRecording();
  };

  const handleStopRecording = () => {
    audioManager.stopRecording();
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
          onStartRecording={handleStartRecording}
          onStopRecording={handleStopRecording}
          disabled={voiceState === "thinking" || voiceState === "speaking"}
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
