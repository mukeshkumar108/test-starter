import { prisma } from "@/lib/prisma";
import { createQaUser, getPersonaIdBySlug, cleanupQaUser, isQaClerkId } from "./regress/helpers";
import { RegressContext, RegressResult } from "./regress/types";
import { run as shadowJudgeWrites } from "./regress/cases/shadowJudge_writes";
import { run as loopSemantics } from "./regress/cases/loop_semantics";
import { run as stoplistProfile } from "./regress/cases/stoplist_profile";
import { run as contextCaps } from "./regress/cases/context_caps";
import { run as contextBlocks } from "./regress/cases/context_blocks";
import { run as sessionLifecycle } from "./regress/cases/session_lifecycle";
import { run as promptSizeWarn } from "./regress/cases/prompt_size_warn";
import { run as sessionSummaryCreated } from "./regress/cases/session_summary_created";
import { run as sessionSummaryNonBlocking } from "./regress/cases/session_summary_non_blocking";
import { run as curatorAutoTrigger } from "./regress/cases/curator_auto_trigger";

async function runCase(fn: (ctx: RegressContext) => Promise<RegressResult>, ctx: RegressContext) {
  const result = await fn(ctx);
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${result.name}`);
  console.log(JSON.stringify(result.evidence, null, 2));
  return result;
}

async function main() {
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
