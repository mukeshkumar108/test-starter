process.env.FEATURE_JUDGE_TEST_MODE = "true";

import type { RegressContext, RegressResult } from "./regress/types";

async function runCase(fn: (ctx: RegressContext) => Promise<RegressResult>, ctx: RegressContext) {
  const result = await fn(ctx);
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${result.name}`);
  console.log(JSON.stringify(result.evidence, null, 2));
  return result;
}

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const {
    createQaUser,
    getPersonaIdBySlug,
    cleanupQaUser,
    isQaClerkId,
  } = await import("./regress/helpers");
  const { run: shadowJudgeWrites } = await import("./regress/cases/shadowJudge_writes");
  const { run: loopSemantics } = await import("./regress/cases/loop_semantics");
  const { run: stoplistProfile } = await import("./regress/cases/stoplist_profile");
  const { run: contextCaps } = await import("./regress/cases/context_caps");
  const { run: contextBlocks } = await import("./regress/cases/context_blocks");
  const { run: sessionLifecycle } = await import("./regress/cases/session_lifecycle");
  const { run: promptSizeWarn } = await import("./regress/cases/prompt_size_warn");
  const { run: sessionSummaryCreated } = await import("./regress/cases/session_summary_created");
  const { run: sessionSummaryNonBlocking } = await import("./regress/cases/session_summary_non_blocking");
  const { run: curatorAutoTrigger } = await import("./regress/cases/curator_auto_trigger");

  const user = await createQaUser();
  if (!isQaClerkId(user.clerkUserId)) {
    throw new Error(`Refusing to run on non-QA user: ${user.clerkUserId}`);
  }

  const personaId = await getPersonaIdBySlug("creative");
  const ctx: RegressContext = { prisma, userId: user.id, personaId };
  const results: RegressResult[] = [];

  try {
    results.push(await runCase(shadowJudgeWrites, ctx));
    results.push(await runCase(loopSemantics, ctx));
    results.push(await runCase(stoplistProfile, ctx));
    results.push(await runCase(contextCaps, ctx));
    results.push(await runCase(contextBlocks, ctx));
    results.push(await runCase(sessionLifecycle, ctx));
    results.push(await runCase(sessionSummaryNonBlocking, ctx));
    results.push(await runCase(sessionSummaryCreated, ctx));
    results.push(await runCase(curatorAutoTrigger, ctx));
    results.push(await runCase(promptSizeWarn, ctx));
  } finally {
    await cleanupQaUser(user.id);
  }

  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.error(`FAILURES: ${failed.map((result) => result.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
