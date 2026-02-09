import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { __test__buildChatMessages } from "@/app/api/chat/route";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type FixtureScenario = {
  id: string;
  name: string;
  situationalContext: string;
  supplementalContext: string | null;
  sessionFacts: string | null;
  posture: "COMPANION" | "MOMENTUM" | "REFLECTION" | "RELATIONSHIP" | "IDEATION" | "RECOVERY" | "PRACTICAL";
  pressure: "LOW" | "MED" | "HIGH";
  conversation: Array<{ role: "user" | "assistant"; content: string }>;
};

type Fixture = {
  scenarios: FixtureScenario[];
  models: string[];
};

type PlaybackResult = {
  model: string;
  turns: Array<{ user: string; assistant: string }>;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

type ScenarioResult = {
  id: string;
  name: string;
  results: PlaybackResult[];
};

function getModels(fixture: Fixture): string[] {
  const envModels = process.env.MODELS?.split(",").map((m) => m.trim()).filter(Boolean);
  if (envModels && envModels.length > 0) return envModels;
  return fixture.models;
}

function getPersonaPrompt(): Promise<string> {
  return readFile(join(process.cwd(), "prompts", "persona-creative.md"), "utf8");
}

async function callOpenRouter(
  model: string,
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (process.env.OPENROUTER_APP_URL) headers["HTTP-Referer"] = process.env.OPENROUTER_APP_URL;
  if (process.env.OPENROUTER_APP_NAME) headers["X-Title"] = process.env.OPENROUTER_APP_NAME;

  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      temperature: 1.0,
      top_p: 0.93,
      top_k: 40,
      repetition_penalty: 1.05,
      presence_penalty: 0.1,
      max_tokens: 350,
      stream: false,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  return String(data?.choices?.[0]?.message?.content ?? "").trim();
}

async function run() {
  const fixtureRaw = await readFile(join(process.cwd(), "fixtures", "prompt-playback.json"), "utf8");
  const fixture = JSON.parse(fixtureRaw) as Fixture;
  const persona = await getPersonaPrompt();
  const models = getModels(fixture);

  const scenarioResults: ScenarioResult[] = [];

  for (const scenario of fixture.scenarios) {
    const results: PlaybackResult[] = [];
    for (const model of models) {
      const history: Array<{ role: "user" | "assistant"; content: string }> = [];
      const turns: Array<{ user: string; assistant: string }> = [];

      for (const turn of scenario.conversation) {
        if (turn.role === "assistant") {
          history.push(turn);
          continue;
        }

        const messages = __test__buildChatMessages({
          persona,
          situationalContext: scenario.situationalContext,
          supplementalContext: scenario.supplementalContext,
          rollingSummary: scenario.sessionFacts ?? "",
          recentMessages: history,
          transcript: turn.content,
          posture: scenario.posture,
          pressure: scenario.pressure,
        });

        const response = await callOpenRouter(model, messages);
        history.push({ role: "user", content: turn.content });
        history.push({ role: "assistant", content: response });
        turns.push({ user: turn.content, assistant: response });
      }

      const finalMessages = __test__buildChatMessages({
        persona,
        situationalContext: scenario.situationalContext,
        supplementalContext: scenario.supplementalContext,
        rollingSummary: scenario.sessionFacts ?? "",
        recentMessages: history,
        transcript: "",
        posture: scenario.posture,
        pressure: scenario.pressure,
      });

      results.push({ model, turns, messages: finalMessages });

      console.log(`\n[${scenario.name}] (${model})`);
      for (const turn of turns) {
        console.log(`User: ${turn.user}`);
        console.log(`Sophie: ${turn.assistant}\n`);
      }
    }

    scenarioResults.push({ id: scenario.id, name: scenario.name, results });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(process.cwd(), "outputs", `prompt-playback-${stamp}.json`);
  await writeFile(outputPath, JSON.stringify({
    runAt: new Date().toISOString(),
    models,
    scenarios: scenarioResults,
  }, null, 2));

  console.log(`\nSaved results to ${outputPath}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
