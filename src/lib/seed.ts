import { prisma } from "./prisma";
import { env } from "@/env";
import { MODELS } from "./providers/models";

export async function seedPersonaProfiles() {
  const personas = [
    {
      slug: "mentor",
      name: "William",
      description: "A sharp, grounded mentor with a billionaire's edge and a protective dad vibe.",
      promptPath: "/prompts/persona-mentor.md",
      llmModel: MODELS.CHAT.MENTOR,
      ttsVoiceId: env.ELEVENLABS_VOICE_WILLIAM ?? env.ELEVENLABS_DEFAULT_VOICE_ID,
      language: "en",
    },
    {
      slug: "supportive", 
      name: "Isabella",
      description: "A posh, elite confidante who is warm but direct and holds you to high standards.",
      promptPath: "/prompts/persona-supportive.md",
      llmModel: MODELS.CHAT.SUPPORTIVE,
      ttsVoiceId: env.ELEVENLABS_VOICE_ISABELLA ?? env.ELEVENLABS_DEFAULT_VOICE_ID,
      language: "en",
    },
    {
      slug: "coach",
      name: "Alexander", 
      description: "A strategic power-broker who teaches leverage, discipline, and control.",
      promptPath: "/prompts/persona-coach.md",
      llmModel: MODELS.CHAT.COACH,
      ttsVoiceId: env.ELEVENLABS_VOICE_ALEXANDER ?? env.ELEVENLABS_DEFAULT_VOICE_ID,
      language: "en",
    },
    {
      slug: "creative",
      name: "Sophie",
      description: "An upbeat all-American athlete-model who cheers you on with flirty, fun energy.",
      promptPath: "/prompts/persona-creative.md", 
      llmModel: MODELS.CHAT.CREATIVE,
      ttsVoiceId: env.ELEVENLABS_VOICE_SOPHIE ?? env.ELEVENLABS_DEFAULT_VOICE_ID,
      language: "en",
    },
  ];

  try {
    for (const persona of personas) {
      await prisma.personaProfile.upsert({
        where: { slug: persona.slug },
        update: persona,
        create: persona,
      });
      console.log(`Seeded persona: ${persona.name}`);
    }
    
    console.log("Persona profiles seeded successfully");
  } catch (error) {
    console.error("Error seeding persona profiles:", error);
    throw error;
  }
}

// Run seed if called directly
if (require.main === module) {
  seedPersonaProfiles()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
