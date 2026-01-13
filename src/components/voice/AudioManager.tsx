"use client";

import { useState, useRef, useCallback } from "react";

interface AudioManagerProps {
  onRecordingComplete: (audioBlob: Blob) => void;
  onError: (error: string) => void;
}

export function AudioManager({ onRecordingComplete, onError }: AudioManagerProps) {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Initialize audio context for iOS Safari
  const initializeAudioContext = useCallback(async () => {
    if (audioContextRef.current) return true;

    try {
      // Create AudioContext and unlock it with user gesture
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      
      audioContextRef.current = audioContext;
      return true;
    } catch (error) {
      console.error("Audio context initialization failed:", error);
      onError("Audio initialization failed");
      return false;
    }
  }, [onError]);

  const startRecording = useCallback(async () => {
    try {
      // Initialize audio context first (iOS Safari requirement)
      const audioInitialized = await initializeAudioContext();
      if (!audioInitialized) return;

      // Get microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 44100,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Setup MediaRecorder
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") 
          ? "audio/webm;codecs=opus" 
          : "audio/mp4",
      });

      chunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(chunksRef.current, { 
          type: mediaRecorder.mimeType 
        });
        onRecordingComplete(audioBlob);
        
        // Cleanup
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);

    } catch (error) {
      console.error("Recording start failed:", error);
      onError("Could not access microphone");
    }
  }, [initializeAudioContext, onRecordingComplete, onError]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  return {
    isRecording,
    startRecording,
    stopRecording,
  };
}

// Hook for easier usage
export function useAudioManager() {
  const [audioManager, setAudioManager] = useState<ReturnType<typeof AudioManager> | null>(null);
  
  const createAudioManager = useCallback((
    onRecordingComplete: (audioBlob: Blob) => void,
    onError: (error: string) => void
  ) => {
    const manager = AudioManager({ onRecordingComplete, onError });
    setAudioManager(manager);
    return manager;
  }, []);

  return {
    audioManager,
    createAudioManager,
  };
}