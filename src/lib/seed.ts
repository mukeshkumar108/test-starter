import { prisma } from "./prisma";
import { env } from "@/env";
import { MODELS } from "./providers/models";

export async function seedPersonaProfiles() {
  const personas = [
    {
      slug: "mentor",
      name: "Wise Mentor",
      description: "A thoughtful guide who helps you think through decisions with patience and wisdom.",
      promptPath: "/prompts/persona-mentor.md",
      llmModel: MODELS.CHAT.MENTOR,
      ttsVoiceId: env.ELEVENLABS_DEFAULT_VOICE_ID,
      language: "en",
    },
    {
      slug: "supportive", 
      name: "Supportive Companion",
      description: "A warm, empathetic listener who provides emotional support and encouragement.",
      promptPath: "/prompts/persona-supportive.md",
      llmModel: MODELS.CHAT.SUPPORTIVE,
      ttsVoiceId: env.ELEVENLABS_DEFAULT_VOICE_ID,
      language: "en",
    },
    {
      slug: "coach",
      name: "Performance Coach", 
      description: "An energetic motivator focused on helping you achieve goals and maximize potential.",
      promptPath: "/prompts/persona-coach.md",
      llmModel: MODELS.CHAT.COACH,
      ttsVoiceId: env.ELEVENLABS_DEFAULT_VOICE_ID,
      language: "en",
    },
    {
      slug: "creative",
      name: "Creative Catalyst",
      description: "An imaginative partner who helps you explore ideas and think outside the box.",
      promptPath: "/prompts/persona-creative.md", 
      llmModel: MODELS.CHAT.CREATIVE,
      ttsVoiceId: env.ELEVENLABS_DEFAULT_VOICE_ID,
      language: "en",
    },
    {
      slug: "analytical",
      name: "Analytical Thinker",
      description: "A logical problem-solver who excels at breaking down complex issues systematically.",
      promptPath: "/prompts/persona-analytical.md",
      llmModel: MODELS.CHAT.ANALYTICAL, 
      ttsVoiceId: env.ELEVENLABS_DEFAULT_VOICE_ID,
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