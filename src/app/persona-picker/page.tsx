import { PersonaPicker } from "@/components/persona/PersonaPicker";
import { redirect } from "next/navigation";

interface PersonaPickerPageProps {
  searchParams: { personaId?: string };
}

export default function PersonaPickerPage({ searchParams }: PersonaPickerPageProps) {
  const handlePersonaSelect = (personaId: string) => {
    // Redirect to main app with selected persona
    redirect(`/app?personaId=${personaId}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-900 to-gray-800 p-6">
      <div className="max-w-6xl mx-auto py-12">
        <PersonaPicker 
          onPersonaSelect={handlePersonaSelect}
          selectedPersonaId={searchParams.personaId}
        />
      </div>
    </div>
  );
}