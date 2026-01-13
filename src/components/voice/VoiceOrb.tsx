"use client";

import { useState, useRef } from "react";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

interface VoiceOrbProps {
  state: VoiceState;
  onStartRecording: () => void;
  onStopRecording: () => void;
  disabled?: boolean;
}

export function VoiceOrb({ 
  state, 
  onStartRecording, 
  onStopRecording, 
  disabled = false 
}: VoiceOrbProps) {
  const [isPressed, setIsPressed] = useState(false);
  const pressTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handlePressStart = () => {
    if (disabled || state !== "idle") return;
    
    setIsPressed(true);
    
    // Small delay to ensure user intends to record
    pressTimeoutRef.current = setTimeout(() => {
      onStartRecording();
    }, 150);
  };

  const handlePressEnd = () => {
    if (pressTimeoutRef.current) {
      clearTimeout(pressTimeoutRef.current);
    }
    
    setIsPressed(false);
    
    if (state === "listening") {
      onStopRecording();
    }
  };

  const getOrbStyle = () => {
    const base = "w-32 h-32 rounded-full transition-all duration-300 ease-out";
    
    switch (state) {
      case "listening":
        return `${base} bg-red-500 shadow-lg shadow-red-500/50 scale-110 animate-pulse`;
      case "thinking":
        return `${base} bg-blue-500 shadow-lg shadow-blue-500/50 scale-105 animate-spin`;
      case "speaking":
        return `${base} bg-green-500 shadow-lg shadow-green-500/50 scale-105 animate-pulse`;
      default:
        return `${base} bg-gray-600 hover:bg-gray-500 ${!disabled ? "hover:scale-105" : ""} ${
          isPressed ? "scale-95" : ""
        }`;
    }
  };

  const getStateText = () => {
    switch (state) {
      case "listening":
        return "Listening...";
      case "thinking":
        return "Thinking...";
      case "speaking":
        return "Speaking...";
      default:
        return "Hold to talk";
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <button
        className={getOrbStyle()}
        onMouseDown={handlePressStart}
        onMouseUp={handlePressEnd}
        onMouseLeave={handlePressEnd}
        onTouchStart={handlePressStart}
        onTouchEnd={handlePressEnd}
        disabled={disabled}
        style={{ touchAction: "manipulation" }}
      >
        <div className="w-full h-full flex items-center justify-center">
          <div className="w-8 h-8 bg-white rounded-full opacity-80" />
        </div>
      </button>
      
      <p className="text-center text-sm text-gray-400">
        {getStateText()}
      </p>
    </div>
  );
}
