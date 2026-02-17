import { readFile } from "fs/promises";
import { basename, join } from "path";

const CREATIVE_KERNEL_FILES = [
  "00_model_kernel.md",
  "10_identity_kernel.md",
  "20_steering_kernel.md",
  "30_product_kernel.md",
  "40_style_kernel.md",
] as const;

let creativeKernelCache: string | null = null;

function toAbsolutePath(rootDir: string, promptPath: string) {
  const relative = promptPath.startsWith("/") ? promptPath.slice(1) : promptPath;
  return join(rootDir, relative);
}

function isCreativePrompt(params: { slug?: string | null; promptPath: string }) {
  if ((params.slug ?? "").toLowerCase() === "creative") return true;
  return basename(params.promptPath) === "persona-creative.md";
}

async function readLegacyPrompt(rootDir: string, promptPath: string) {
  const fullPath = toAbsolutePath(rootDir, promptPath);
  return readFile(fullPath, "utf-8");
}

async function compileCreativeKernel(rootDir: string) {
  if (creativeKernelCache) return creativeKernelCache;
  const blocks = await Promise.all(
    CREATIVE_KERNEL_FILES.map(async (fileName) => {
      const fullPath = join(rootDir, "prompts", fileName);
      const contents = await readFile(fullPath, "utf-8");
      return contents.trim();
    })
  );
  const compiled = blocks.filter(Boolean).join("\n\n");
  creativeKernelCache = compiled;
  return compiled;
}

export async function loadPersonaPrompt(params: {
  promptPath: string;
  slug?: string | null;
  rootDir?: string;
}) {
  const rootDir = params.rootDir ?? process.cwd();
  if (!isCreativePrompt(params)) {
    return readLegacyPrompt(rootDir, params.promptPath);
  }

  try {
    return await compileCreativeKernel(rootDir);
  } catch (error) {
    console.warn("[prompt.loader] creative kernel compile failed, falling back", {
      error,
      promptPath: params.promptPath,
    });
    return readLegacyPrompt(rootDir, params.promptPath);
  }
}

export function clearPersonaPromptCache() {
  creativeKernelCache = null;
}
