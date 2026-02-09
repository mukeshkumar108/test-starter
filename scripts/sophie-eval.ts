import { readdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type PlaybackResult = {
  model: string;
  response: string;
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>;
};

type ScenarioResult = {
  id: string;
  name: string;
  results: PlaybackResult[];
};

type PlaybackFile = {
  runAt: string;
  models: string[];
  scenarios: ScenarioResult[];
};

type EvalScore = {
  cringe: "REAL" | "CRINGE";
  cheerleader: "STRONG" | "WEAK";
  curiosity: "STRONG" | "WEAK";
  spine: "STRONG" | "WEAK" | "NA";
  rationale: string;
};

type EvalResult = {
  model: string;
  scenarioId: string;
  scenarioName: string;
  score: EvalScore;
};

function getLatestPlaybackFileName(files: string[]) {
  const candidates = files.filter((file) => file.startsWith("prompt-playback-") && file.endsWith(".json"));
  if (candidates.length === 0) return null;
  return candidates.sort().pop() ?? null;
}

async function callOpenRouter(prompt: string) {
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
      model: process.env.EVAL_MODEL ?? "openai/gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 220,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
  if (!content) throw new Error("Empty evaluator response");
  return JSON.parse(content) as EvalScore;
}

function buildEvalPrompt(scenarioName: string, userMessage: string, assistantResponse: string) {
  return `You are scoring a Sophie response. Return ONLY JSON.

JSON schema:
{
  "cringe": "REAL"|"CRINGE",
  "cheerleader": "STRONG"|"WEAK",
  "curiosity": "STRONG"|"WEAK",
  "spine": "STRONG"|"WEAK"|"NA",
  "rationale": "one short sentence"
}

Definitions:
- cringe: REAL if it feels like a sharp friend; CRINGE if it feels like AI trying to be a cool girl.
- cheerleader: STRONG if genuine excitement when there's a win; WEAK if just acknowledges. If no win, use WEAK.
- curiosity: STRONG if it asks a specific, human question about the person; WEAK otherwise.
- spine: STRONG if it pushes back on unethical/lazy behavior; WEAK if it lets it slide. NA if scenario doesn't require it.

Scenario: ${scenarioName}
User message: ${userMessage}
Assistant response: ${assistantResponse}`;
}

async function run() {
  const outputsDir = join(process.cwd(), "outputs");
  const files = await readdir(outputsDir);
  const latest = getLatestPlaybackFileName(files);
  if (!latest) {
    throw new Error("No prompt-playback output found. Run scripts/prompt-playback.ts first.");
  }

  const raw = await readFile(join(outputsDir, latest), "utf8");
  const playback = JSON.parse(raw) as PlaybackFile;

  const results: EvalResult[] = [];

  for (const scenario of playback.scenarios) {
    for (const result of scenario.results) {
      const userMessage = scenario.results[0]?.messages.filter((m) => m.role === "user").slice(-1)[0]?.content
        ?? scenario.results[0]?.messages.slice(-1)[0]?.content
        ?? "";
      const prompt = buildEvalPrompt(scenario.name, userMessage, result.response);
      const score = await callOpenRouter(prompt);
      results.push({
        model: result.model,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        score,
      });
      console.log(`\n[${scenario.name}] ${result.model}\n`, score);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(process.cwd(), "outputs", `sophie-eval-${stamp}.json`);
  await writeFile(outPath, JSON.stringify({
    runAt: new Date().toISOString(),
    playbackFile: latest,
    results,
  }, null, 2));

  console.log(`\nSaved eval results to ${outPath}`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
