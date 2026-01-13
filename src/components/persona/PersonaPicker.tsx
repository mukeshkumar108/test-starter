"use client";

import { useState, useEffect } from "react";
import { PersonaCard } from "./PersonaCard";

interface PersonaProfile {
  id: string;
  slug: string;
  name: string;
  description: string;
  language: string;
}

interface PersonaPickerProps {
  onPersonaSelect: (personaId: string) => void;
  selectedPersonaId?: string;
}

export function PersonaPicker({ onPersonaSelect, selectedPersonaId }: PersonaPickerProps) {
  const [personas, setPersonas] = useState<PersonaProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchPersonas();
  }, []);

  const fetchPersonas = async () => {
    try {
      const response = await fetch("/api/personas");
      if (!response.ok) {
        throw new Error("Failed to fetch personas");
      }
      const data = await response.json();
      setPersonas(data.personas || []);
    } catch (error) {
      console.error("Error fetching personas:", error);
      setError("Failed to load personas");
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-8">
        <p className="text-red-400">{error}</p>
        <button 
          onClick={fetchPersonas}
          className="mt-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h2 className="text-2xl font-semibold text-center mb-6 text-white">
        Choose Your Companion
      </h2>
      <p className="text-center mb-8 text-gray-400">
        Select a persona that matches your conversation style and goals.
      </p>
      
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {personas.map((persona) => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            isSelected={selectedPersonaId === persona.id}
            onSelect={() => onPersonaSelect(persona.id)}
          />
        ))}
      </div>
    </div>
  );
}