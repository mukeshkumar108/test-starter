/**
 * Unit tests for persona prompt loader/compiler
 * Run with: pnpm tsx src/lib/prompts/__tests__/personaPromptLoader.test.ts
 */

import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { readFile } from "fs/promises";
import { clearPersonaPromptCache, loadPersonaPrompt } from "../personaPromptLoader";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toContain(expected: string) {
      if (typeof actual !== "string" || !actual.includes(expected)) {
        throw new Error(`Expected string to contain ${JSON.stringify(expected)}`);
      }
    },
  };
}

async function runTest(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  await runTest("loads legacy prompt unchanged for non-creative personas", async () => {
    const tmpDir = join(process.cwd(), "tmp");
    await mkdir(tmpDir, { recursive: true });
    const promptPath = "tmp/persona-loader-legacy.md";
    await writeFile(join(process.cwd(), promptPath), "LEGACY PROMPT", "utf-8");

    const prompt = await loadPersonaPrompt({
      slug: "mentor",
      promptPath,
    });
    expect(prompt).toBe("LEGACY PROMPT");
  });

  await runTest("compiles creative kernels in configured order", async () => {
    clearPersonaPromptCache();
    const prompt = await loadPersonaPrompt({
      slug: "creative",
      promptPath: "/prompts/persona-creative.md",
    });

    const modelKernel = (await readFile(join(process.cwd(), "prompts/00_model_kernel.md"), "utf-8")).trim();
    const identityKernel = (await readFile(join(process.cwd(), "prompts/10_identity_kernel.md"), "utf-8")).trim();
    const steeringKernel = (await readFile(join(process.cwd(), "prompts/20_steering_kernel.md"), "utf-8")).trim();
    const productKernel = (await readFile(join(process.cwd(), "prompts/30_product_kernel.md"), "utf-8")).trim();
    const styleKernel = (await readFile(join(process.cwd(), "prompts/40_style_kernel.md"), "utf-8")).trim();
    const expected = [modelKernel, identityKernel, steeringKernel, productKernel, styleKernel]
      .filter(Boolean)
      .join("\n\n");

    const i0 = prompt.indexOf(modelKernel);
    const i1 = prompt.indexOf(identityKernel);
    const i2 = prompt.indexOf(steeringKernel);
    const i3 = prompt.indexOf(productKernel);
    if ([i0, i1, i2, i3].some((index) => index < 0)) {
      throw new Error("Expected compiled prompt to contain core kernel blocks");
    }
    if (!(i0 < i1 && i1 < i2 && i2 < i3)) {
      throw new Error("Expected kernel blocks to be compiled in 00,10,20,30,40 order");
    }
    expect(prompt).toBe(expected);
  });

  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    console.error("Test failures:");
    for (const f of failed) {
      console.error(`- ${f.name}: ${f.error}`);
    }
    process.exit(1);
  } else {
    console.log(`All ${results.length} tests passed.`);
  }
}

main().catch((error) => {
  console.error("Unhandled test error:", error);
  process.exit(1);
});
