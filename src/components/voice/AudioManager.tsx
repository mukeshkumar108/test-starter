"use client";

import { useState, useRef, useCallback, useMemo } from "react";

interface AudioManagerOptions {
  onRecordingComplete: (audioBlob: Blob) => void;
  onError: (error: string) => void;
  onAutoplaySuccess?: () => void;
  onAutoplayFailed?: () => void;
}

// Silent 0.1s MP3 (Base64) to prime iOS audio
const SILENT_MP3 = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAABIADAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA//tQxAAOAAAGkAAAAIAAANIAAAARMQU1FMy4xMDSqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqg==";

export function useAudioManager({ onRecordingComplete, onError, onAutoplaySuccess, onAutoplayFailed }: AudioManagerOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const [isPriming, setIsPriming] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const persistentAudioRef = useRef<HTMLAudioElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isAudioPrimedRef = useRef(false);
  const recordingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const initializeAudioContext = useCallback(async () => {
    if (audioContextRef.current) return true;

    try {
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

  const primeAudioForSession = useCallback(async () => {
    if (isAudioPrimedRef.current) return;
    
    setIsPriming(true);
    
    try {
      // Initialize audio context
      await initializeAudioContext();
      
      // Create persistent audio element during user gesture
      if (!persistentAudioRef.current) {
        const audio = new Audio();
        audio.preload = "auto";
        audio.muted = true; // Start muted for silent prime
        persistentAudioRef.current = audio;
      }

      // Silent prime: Play silent audio during gesture to unlock iOS autoplay
      const audio = persistentAudioRef.current;
      audio.src = SILENT_MP3;
      audio.muted = true;
      
      try {
        await audio.play();
        isAudioPrimedRef.current = true;
        console.log("[AudioManager] iOS audio primed successfully");
      } catch (error) {
        console.warn("[AudioManager] Silent prime failed:", error);
        // Continue anyway - might still work
      }
      
      // Unmute for future playback
      audio.muted = false;
    } catch (error) {
      console.error("[AudioManager] Audio priming failed:", error);
      onError("Audio initialization failed");
    } finally {
      setIsPriming(false);
    }
  }, [initializeAudioContext, onError]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 44100,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

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
        if (recordingTimeoutRef.current) {
          clearTimeout(recordingTimeoutRef.current);
          recordingTimeoutRef.current = null;
        }
        
        const audioBlob = new Blob(chunksRef.current, {
          type: mediaRecorder.mimeType,
        });
        onRecordingComplete(audioBlob);
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(100);
      setIsRecording(true);
      
      // Safety timeout: auto-stop after 90 seconds
      recordingTimeoutRef.current = setTimeout(() => {
        if (mediaRecorderRef.current && isRecording) {
          console.log("[AudioManager] Auto-stopping recording after 90s");
          mediaRecorderRef.current.stop();
        }
      }, 90000);
      
    } catch (error) {
      console.error("Recording start failed:", error);
      onError("Could not access microphone");
    }
  }, [onRecordingComplete, onError]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  }, [isRecording]);

  const playResponseAudio = useCallback(async (audioUrl: string) => {
    try {
      const audio = persistentAudioRef.current;
      if (!audio) {
        console.error("[AudioManager] No persistent audio element available");
        onAutoplayFailed?.();
        return false;
      }

      // Use the gesture-primed audio element
      audio.src = audioUrl;
      audio.load();
      
      await audio.play();
      onAutoplaySuccess?.();
      
      return true;
    } catch (error) {
      console.error("[AudioManager] Autoplay failed:", error);
      onAutoplayFailed?.();
      return false;
    }
  }, [onAutoplaySuccess, onAutoplayFailed]);

  const interruptPlayback = useCallback(() => {
    if (persistentAudioRef.current) {
      persistentAudioRef.current.pause();
      persistentAudioRef.current.currentTime = 0;
    }
  }, []);

  const resetAudio = useCallback(() => {
    if (persistentAudioRef.current) {
      persistentAudioRef.current.pause();
      persistentAudioRef.current.src = "";
    }
    if (recordingTimeoutRef.current) {
      clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
    isAudioPrimedRef.current = false;
    setIsPriming(false);
  }, []);

  return useMemo(
    () => ({
      isRecording,
      isPriming,
      primeAudioForSession,
      startRecording,
      stopRecording,
      playResponseAudio,
      interruptPlayback,
      resetAudio,
      persistentAudio: persistentAudioRef.current,
    }),
    [isRecording, isPriming, primeAudioForSession, startRecording, stopRecording, playResponseAudio, interruptPlayback, resetAudio]
  );
}
