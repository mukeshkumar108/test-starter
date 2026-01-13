"use client";

import { useState, useRef, useCallback, useMemo } from "react";

interface AudioManagerOptions {
  onRecordingComplete: (audioBlob: Blob) => void;
  onError: (error: string) => void;
}

export function useAudioManager({ onRecordingComplete, onError }: AudioManagerOptions) {
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const chunksRef = useRef<Blob[]>([]);

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

  const startRecording = useCallback(async () => {
    try {
      // Unlock audio context on user gesture (iOS Safari requirement).
      const audioInitialized = await initializeAudioContext();
      if (!audioInitialized) return;

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
        const audioBlob = new Blob(chunksRef.current, {
          type: mediaRecorder.mimeType,
        });
        onRecordingComplete(audioBlob);
        stream.getTracks().forEach((track) => track.stop());
      };

      mediaRecorderRef.current = mediaRecorder;
      mediaRecorder.start(100);
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

  return useMemo(
    () => ({
      isRecording,
      startRecording,
      stopRecording,
    }),
    [isRecording, startRecording, stopRecording]
  );
}
