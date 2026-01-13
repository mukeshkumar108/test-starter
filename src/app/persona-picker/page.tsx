"use client";

import { PersonaPicker } from "@/components/persona/PersonaPicker";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

function PersonaPickerContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const handlePersonaSelect = (personaId: string) => {
    // Redirect to main app with selected persona
    router.push(`/app?personaId=${personaId}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 p-6">
      <div className="max-w-6xl mx-auto py-12">
        <PersonaPicker 
          onPersonaSelect={handlePersonaSelect}
          selectedPersonaId={searchParams.get("personaId") ?? undefined}
        />
      </div>
    </div>
  );
}

export default function PersonaPickerPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-900" />}>
      <PersonaPickerContent />
    </Suspense>
  );
}
