import { spawnSync } from "child_process";

type TestDef = { name: string; command: string[]; optional?: boolean };

const nodeWithTsx = ["node", "--import", "tsx"];
const tests: TestDef[] = [
  { name: "synapseClient", command: [...nodeWithTsx, "src/lib/services/__tests__/synapseClient.test.ts"] },
  { name: "sessionSynapseIngest", command: [...nodeWithTsx, "src/lib/services/session/__tests__/sessionSynapseIngest.test.ts"] },
  { name: "chatSynapseIngest", command: [...nodeWithTsx, "src/app/api/__tests__/chat.synapse-ingest.test.ts"] },
  { name: "chatTrace", command: [...nodeWithTsx, "src/app/api/__tests__/chat.trace.test.ts"] },
  { name: "entityNormalizer", command: [...nodeWithTsx, "src/lib/services/memory/__tests__/entityNormalizer.test.ts"] },
  { name: "queryRouterSynapse", command: [...nodeWithTsx, "src/lib/services/memory/__tests__/queryRouter.synapse.test.ts"] },
  { name: "contextBuilderSynapse", command: [...nodeWithTsx, "src/lib/services/memory/__tests__/contextBuilder.synapse.test.ts"] },
  { name: "modelRouting", command: [...nodeWithTsx, "src/lib/providers/__tests__/models.test.ts"] },
  { name: "overlaySelector", command: [...nodeWithTsx, "src/lib/services/memory/__tests__/overlaySelector.test.ts"] },
  { name: "personaPromptLoader", command: [...nodeWithTsx, "src/lib/prompts/__tests__/personaPromptLoader.test.ts"] },
  { name: "dailyFocusPolicy", command: [...nodeWithTsx, "src/app/api/__tests__/dailyFocusPolicy.test.ts"] },
  { name: "safeCompletionStrip", command: [...nodeWithTsx, "src/lib/llm/__tests__/safeCompletion.strip.test.ts"] },
  { name: "ttsService", command: [...nodeWithTsx, "src/lib/services/voice/__tests__/ttsService.test.ts"] },
  { name: "librarian", command: [...nodeWithTsx, "src/synapse/librarian.test.ts"] },
  { name: "overlayInjection", command: [...nodeWithTsx, "src/app/api/__tests__/overlayInjection.test.ts"] },
  { name: "overlayWarmupPolicy", command: [...nodeWithTsx, "src/app/api/__tests__/overlayWarmupPolicy.test.ts"] },
  { name: "momentumGuardPolicy", command: [...nodeWithTsx, "src/app/api/__tests__/momentumGuardPolicy.test.ts"] },
  { name: "memoryQueryNormalization", command: [...nodeWithTsx, "src/app/api/__tests__/memoryQueryNormalization.test.ts"] },
  { name: "correctionGuards", command: [...nodeWithTsx, "src/app/api/__tests__/correctionGuards.test.ts"] },
  {
    name: "continuityIntegration",
    command: [...nodeWithTsx, "tests/integration/continuity.test.ts"],
    optional: true,
  },
];

const runIntegration =
  process.env.RUN_INTEGRATION === "1" || process.env.RUN_INTEGRATION === "true";

let failed = 0;

for (const test of tests) {
  if (test.optional && !runIntegration) {
    console.log(`- skip ${test.name} (set RUN_INTEGRATION=1 to enable)`);
    continue;
  }
  console.log(`\n[TEST] ${test.name}`);
  const result = spawnSync(test.command[0], test.command.slice(1), {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    failed += 1;
    console.error(`[FAIL] ${test.name}`);
  } else {
    console.log(`[PASS] ${test.name}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
}
console.log("\nAll selected tests passed.");
