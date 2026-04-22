/**
 * Unit tests for vNext TurnEvent boundary mapping.
 * Run with: pnpm tsx src/lib/runtime/vnext/__tests__/buildTurnEvent.test.ts
 */

import { buildTextTurnEvent, buildVoiceTurnEvent, toTurnAttachment } from "../buildTurnEvent";

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
  await runTest("builds voice event with transcript and audio metadata", () => {
    const event = buildVoiceTurnEvent({
      userId: "user-1",
      personaId: "persona-1",
      sessionId: "session-1",
      transcript: "hello sophie",
      timestampUtc: "2026-04-22T12:00:00.000Z",
      timezone: "Europe/Zagreb",
      localTime: {
        date: "2026-04-22",
        hour: 14,
        weekday: "wednesday",
      },
      audio: {
        mimeType: "audio/webm",
        sizeBytes: 12345,
      },
      routeMetadata: {
        requestId: "request-1",
      },
    });

    expect(event.modality).toBe("voice");
    expect(event.transcript).toBe("hello sophie");
    expect(event.text).toBeUndefined();
    expect(event.audio).toEqual({ mimeType: "audio/webm", sizeBytes: 12345 });
    expect(event.metadata).toEqual({ route: { requestId: "request-1" } });
  });

  await runTest("builds text-only event without optional fields", () => {
    const event = buildTextTurnEvent({
      userId: "user-2",
      personaId: "persona-2",
      text: "typed message",
      timestampUtc: "2026-04-22T12:01:00.000Z",
    });

    expect(event.userId).toBe("user-2");
    expect(event.personaId).toBe("persona-2");
    expect(event.modality).toBe("text");
    expect(event.text).toBe("typed message");
    expect(event.sessionId).toBeUndefined();
    expect(event.audio).toBeUndefined();
    expect(event.attachments).toBeUndefined();
    expect(event.metadata).toBeUndefined();
  });

  await runTest("preserves required field and timezone/local time mapping", () => {
    const event = buildTextTurnEvent({
      userId: "user-3",
      personaId: "persona-3",
      text: "check local context",
      timestampUtc: "2026-04-22T12:02:00.000Z",
      timezone: "Europe/London",
      localTime: {
        date: "2026-04-22",
        hour: 13,
        weekday: "wednesday",
      },
    });

    expect(event.timestampUtc).toBe("2026-04-22T12:02:00.000Z");
    expect(event.timezone).toBe("Europe/London");
    expect(event.localTime).toEqual({
      date: "2026-04-22",
      hour: 13,
      weekday: "wednesday",
    });
  });

  await runTest("marks text event with attachments as multimodal", () => {
    const attachment = toTurnAttachment({
      id: "att-1",
      kind: "pdf",
      mimeType: "application/pdf",
      filename: "brief.pdf",
      sizeBytes: 2048,
    });
    const event = buildTextTurnEvent({
      userId: "user-4",
      personaId: "persona-4",
      text: "read this",
      timestampUtc: "2026-04-22T12:03:00.000Z",
      attachments: [attachment],
    });

    expect(event.modality).toBe("multimodal");
    expect(event.attachments).toEqual([attachment]);
  });

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    console.error("\nvNext buildTurnEvent tests failed:");
    for (const result of failed) {
      console.error(`- ${result.name}: ${result.error}`);
    }
    process.exit(1);
  }

  console.log("vNext buildTurnEvent tests passed.");
}

main();

