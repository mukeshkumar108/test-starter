"use client";

import { useState, useRef } from "react";

export type VoiceState = "idle" | "listening" | "thinking" | "speaking";

interface VoiceOrbProps {
  state: VoiceState;
  onTap: () => void;
  disabled?: boolean;
  isPriming?: boolean;
}

export function VoiceOrb({ 
  state, 
  onTap, 
  disabled = false,
  isPriming = false
}: VoiceOrbProps) {
  const handleClick = () => {
    if (disabled || state === "thinking" || isPriming) return;
    onTap();
  };

  const getOrbStyle = () => {
    const base = "w-32 h-32 rounded-full transition-all duration-300 ease-out cursor-pointer";
    
    if (isPriming) {
      return `${base} bg-yellow-500 shadow-lg shadow-yellow-500/50 scale-105 animate-pulse`;
    }
    
    switch (state) {
      case "listening":
        return `${base} bg-red-500 shadow-lg shadow-red-500/50 scale-110 animate-pulse`;
      case "thinking":
        return `${base} bg-blue-500 shadow-lg shadow-blue-500/50 scale-105 animate-spin cursor-wait`;
      case "speaking":
        return `${base} bg-green-500 shadow-lg shadow-green-500/50 scale-105 animate-pulse`;
      default:
        return `${base} bg-gray-600 hover:bg-gray-500 ${!disabled ? "hover:scale-105" : "cursor-not-allowed"}`;
    }
  };

  const getStateText = () => {
    if (isPriming) {
      return "Starting... (tap to cancel)";
    }
    
    switch (state) {
      case "listening":
        return "Tap to send";
      case "thinking":
        return "Absorbing...";
      case "speaking":
        return "Tap to stop";
      default:
        return "Tap to speak";
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <button
        className={`${getOrbStyle()} select-none`}
        onClick={handleClick}
        onContextMenu={(event) => event.preventDefault()}
        disabled={disabled || state === "thinking" || isPriming}
        style={{ touchAction: "manipulation", userSelect: "none" }}
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
