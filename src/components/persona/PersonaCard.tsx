"use client";

interface PersonaProfile {
  id: string;
  slug: string;
  name: string;
  description: string;
  language: string;
}

interface PersonaCardProps {
  persona: PersonaProfile;
  isSelected: boolean;
  onSelect: () => void;
}

export function PersonaCard({ persona, isSelected, onSelect }: PersonaCardProps) {
  const getPersonaIcon = (slug: string) => {
    switch (slug) {
      case "mentor":
        return "🧙‍♂️";
      case "supportive":
        return "💙";
      case "coach":
        return "🚀";
      case "creative":
        return "🎨";
      case "analytical":
        return "🔬";
      default:
        return "💭";
    }
  };

  const getPersonaColor = (slug: string) => {
    switch (slug) {
      case "mentor":
        return "from-purple-500 to-purple-700";
      case "supportive":
        return "from-blue-500 to-blue-700";
      case "coach":
        return "from-orange-500 to-orange-700";
      case "creative":
        return "from-pink-500 to-pink-700";
      case "analytical":
        return "from-green-500 to-green-700";
      default:
        return "from-gray-500 to-gray-700";
    }
  };

  return (
    <button
      onClick={onSelect}
      className={`
        relative p-6 rounded-xl text-left transition-all duration-300
        ${isSelected 
          ? "ring-2 ring-white scale-105 shadow-lg" 
          : "hover:scale-102 hover:shadow-md"
        }
        bg-gradient-to-br ${getPersonaColor(persona.slug)}
      `}
    >
      <div className="flex items-start gap-4">
        <div className="text-3xl">
          {getPersonaIcon(persona.slug)}
        </div>
        
        <div className="flex-1">
          <h3 className="text-lg font-semibold text-white mb-2">
            {persona.name}
          </h3>
          
          <p className="text-sm text-white/80 leading-relaxed">
            {persona.description}
          </p>
          
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs bg-white/20 text-white px-2 py-1 rounded">
              {persona.language.toUpperCase()}
            </span>
            {isSelected && (
              <span className="text-xs bg-white text-gray-800 px-2 py-1 rounded font-medium">
                Selected
              </span>
            )}
          </div>
        </div>
      </div>
      
      {isSelected && (
        <div className="absolute inset-0 bg-white/10 rounded-xl pointer-events-none" />
      )}
    </button>
  );
}