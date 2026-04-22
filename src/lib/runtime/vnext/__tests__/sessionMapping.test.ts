/**
 * Unit tests for vNext legacy session mapping.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/sessionMapping.test.ts
 */

import { mapLegacySessionToSessionContext } from "../sessionMapping";

type TestResult = { name: string; passed: boolean; error?: string };
const results: TestResult[] = [];

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeUndefined() {
      if (actual !== undefined) {
        throw new Error(`Expected undefined, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

async function main() {
  await runTest("maps legacy session fields into SessionContext", () => {
    const context = mapLegacySessionToSessionContext(
      {
        id: "session-1",
        turnCount: 3,
        startedAt: new Date("2026-04-22T10:00:00.000Z"),
        lastActivityAt: new Date("2026-04-22T10:05:00.000Z"),
      },
      "requested-session"
    );

    expect(context).toEqual({
      sessionId: "session-1",
      isNewSession: false,
      turnCount: 3,
      startedAt: "2026-04-22T10:00:00.000Z",
      lastActivityAt: "2026-04-22T10:05:00.000Z",
      metadata: {
        adapter: "legacy.ensureActiveSession",
        requestedSessionId: "requested-session",
      },
    });
  });

  await runTest("infers new session when turnCount is one", () => {
    const context = mapLegacySessionToSessionContext({
      id: "session-new",
      turnCount: 1,
    });

    expect(context.sessionId).toBe("session-new");
    expect(context.turnCount).toBe(1);
    expect(context.isNewSession).toBe(true);
    expect(context.metadata).toEqual({
      adapter: "legacy.ensureActiveSession",
      requestedSessionId: null,
    });
  });

  await runTest("infers existing session when turnCount is greater than one", () => {
    const context = mapLegacySessionToSessionContext({
      id: "session-existing",
      turnCount: 2,
    });

    expect(context.isNewSession).toBe(false);
    expect(context.turnCount).toBe(2);
  });

  await runTest("maps string timestamps and omits missing timestamps", () => {
    const withStrings = mapLegacySessionToSessionContext({
      id: "session-string-time",
      turnCount: 1,
      startedAt: "2026-04-22T11:00:00.000Z",
      lastActivityAt: "2026-04-22T11:03:00.000Z",
    });
    const withoutTimestamps = mapLegacySessionToSessionContext({
      id: "session-no-time",
      turnCount: 1,
    });

    expect(withStrings.startedAt).toBe("2026-04-22T11:00:00.000Z");
    expect(withStrings.lastActivityAt).toBe("2026-04-22T11:03:00.000Z");
    expect(withoutTimestamps.startedAt).toBeUndefined();
    expect(withoutTimestamps.lastActivityAt).toBeUndefined();
  });

  await runTest("requested session id is metadata only, not authoritative", () => {
    const context = mapLegacySessionToSessionContext(
      {
        id: "legacy-authoritative",
        turnCount: 1,
      },
      "client-requested"
    );

    expect(context.sessionId).toBe("legacy-authoritative");
    expect(context.metadata).toEqual({
      adapter: "legacy.ensureActiveSession",
      requestedSessionId: "client-requested",
    });
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext sessionMapping tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext sessionMapping tests passed.");
}

main();

