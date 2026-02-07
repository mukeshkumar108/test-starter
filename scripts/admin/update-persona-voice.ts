import { prisma } from "../../src/lib/prisma";
import { env } from "../../src/env";

async function run() {
  const slug = process.env.PERSONA_SLUG || "creative";
  const fallback = env.ELEVENLABS_DEFAULT_VOICE_ID;

  let voiceId = fallback;
  if (slug === "creative" && env.ELEVENLABS_VOICE_SOPHIE) {
    voiceId = env.ELEVENLABS_VOICE_SOPHIE;
  } else if (slug === "mentor" && env.ELEVENLABS_VOICE_WILLIAM) {
    voiceId = env.ELEVENLABS_VOICE_WILLIAM;
  } else if (slug === "supportive" && env.ELEVENLABS_VOICE_ISABELLA) {
    voiceId = env.ELEVENLABS_VOICE_ISABELLA;
  } else if (slug === "coach" && env.ELEVENLABS_VOICE_ALEXANDER) {
    voiceId = env.ELEVENLABS_VOICE_ALEXANDER;
  }

  const updated = await prisma.personaProfile.update({
    where: { slug },
    data: { ttsVoiceId: voiceId },
    select: { slug: true, name: true, ttsVoiceId: true },
  });

  console.log("Updated persona voice:", updated);
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
