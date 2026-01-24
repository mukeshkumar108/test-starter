/**
 * Unit tests for entityNormalizer
 * Run with: pnpm tsx src/lib/services/memory/__tests__/entityNormalizer.test.ts
 */

import {
  slugify,
  normalizeEntityKey,
  parseEntityKey,
  sanitizeSubtype,
  sanitizeEntityRefs,
  sanitizeImportance,
  sanitizeEntityLabel,
} from "../entityNormalizer";

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
}

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
    toHaveLength(expected: number) {
      if (!Array.isArray(actual) || actual.length !== expected) {
        throw new Error(`Expected length ${expected}, got ${Array.isArray(actual) ? actual.length : "not an array"}`);
      }
    },
  };
}

// slugify tests
test("slugify: converts to lowercase and trims", () => {
  expect(slugify("  John Doe  ")).toBe("john_doe");
  expect(slugify("HELLO")).toBe("hello");
});

test("slugify: converts spaces to underscores", () => {
  expect(slugify("john doe")).toBe("john_doe");
  expect(slugify("mary jane watson")).toBe("mary_jane_watson");
});

test("slugify: converts hyphens to underscores", () => {
  expect(slugify("co-founder")).toBe("co_founder");
  expect(slugify("austin-texas")).toBe("austin_texas");
});

test("slugify: replaces punctuation with separators", () => {
  expect(slugify("Dr. Jane O'Brien")).toBe("dr_jane_o_brien");
  expect(slugify("Acme Corp, Inc.")).toBe("acme_corp_inc");
  expect(slugify("My App (v2)")).toBe("my_app_v2");
});

test("slugify: collapses multiple underscores", () => {
  expect(slugify("hello   world")).toBe("hello_world");
  expect(slugify("one - two - three")).toBe("one_two_three");
});

test("slugify: trims leading/trailing underscores", () => {
  expect(slugify("  _hello_  ")).toBe("hello");
  expect(slugify("---test---")).toBe("test");
});

test("slugify: handles empty/whitespace input", () => {
  expect(slugify("")).toBe("");
  expect(slugify("   ")).toBe("");
  expect(slugify("...")).toBe("");
});

test("slugify: preserves numbers", () => {
  expect(slugify("project 123")).toBe("project_123");
  expect(slugify("v2.0.1")).toBe("v2_0_1");
});

// normalizeEntityKey tests
test("normalizeEntityKey: creates proper entity keys", () => {
  expect(normalizeEntityKey("person", "John Doe")).toBe("person:john_doe");
  expect(normalizeEntityKey("org", "Acme Corp")).toBe("org:acme_corp");
  expect(normalizeEntityKey("place", "Austin, Texas")).toBe("place:austin_texas");
  expect(normalizeEntityKey("project", "My App")).toBe("project:my_app");
});

test("normalizeEntityKey: returns empty string for empty names", () => {
  expect(normalizeEntityKey("person", "")).toBe("");
  expect(normalizeEntityKey("person", "   ")).toBe("");
});

// parseEntityKey tests
test("parseEntityKey: parses valid entity keys", () => {
  expect(parseEntityKey("person:john_doe")).toEqual({ type: "person", slug: "john_doe" });
  expect(parseEntityKey("org:acme_corp")).toEqual({ type: "org", slug: "acme_corp" });
  expect(parseEntityKey("place:austin")).toEqual({ type: "place", slug: "austin" });
  expect(parseEntityKey("project:my_app")).toEqual({ type: "project", slug: "my_app" });
});

test("parseEntityKey: returns null for invalid keys", () => {
  expect(parseEntityKey("invalid:key")).toBe(null);
  expect(parseEntityKey("person:")).toBe(null);
  expect(parseEntityKey("person:John Doe")).toBe(null); // uppercase
  expect(parseEntityKey("personjohn_doe")).toBe(null); // missing colon
  expect(parseEntityKey("")).toBe(null);
});

// sanitizeSubtype tests
test("sanitizeSubtype: returns valid subtypes", () => {
  expect(sanitizeSubtype({ entityType: "person", factType: "relationship" })).toEqual({
    entityType: "person",
    factType: "relationship",
  });
  expect(sanitizeSubtype({ entityType: "org" })).toEqual({ entityType: "org" });
  expect(sanitizeSubtype({ factType: "preference" })).toEqual({ factType: "preference" });
});

test("sanitizeSubtype: returns undefined for invalid input", () => {
  expect(sanitizeSubtype(null)).toBeUndefined();
  expect(sanitizeSubtype(undefined)).toBeUndefined();
  expect(sanitizeSubtype("string")).toBeUndefined();
  expect(sanitizeSubtype({})).toBeUndefined();
  expect(sanitizeSubtype({ entityType: "invalid" })).toBeUndefined();
});

test("sanitizeSubtype: filters out invalid fields but keeps valid ones", () => {
  expect(sanitizeSubtype({ entityType: "person", factType: "invalid" })).toEqual({
    entityType: "person",
  });
});

// sanitizeEntityRefs tests
test("sanitizeEntityRefs: returns valid entity refs", () => {
  expect(sanitizeEntityRefs(["person:john_doe", "org:acme"])).toEqual([
    "person:john_doe",
    "org:acme",
  ]);
});

test("sanitizeEntityRefs: filters out invalid refs", () => {
  expect(sanitizeEntityRefs(["person:john_doe", "invalid", "org:acme"])).toEqual([
    "person:john_doe",
    "org:acme",
  ]);
  expect(sanitizeEntityRefs(["person:John Doe"])).toEqual([]); // uppercase
  expect(sanitizeEntityRefs([123, null, "person:valid"])).toEqual(["person:valid"]);
});

test("sanitizeEntityRefs: caps at 5 refs", () => {
  const manyRefs = Array.from({ length: 10 }, (_, i) => `person:user_${i}`);
  expect(sanitizeEntityRefs(manyRefs)).toHaveLength(5);
});

test("sanitizeEntityRefs: returns empty array for invalid input", () => {
  expect(sanitizeEntityRefs(null)).toEqual([]);
  expect(sanitizeEntityRefs("string")).toEqual([]);
  expect(sanitizeEntityRefs({})).toEqual([]);
});

// sanitizeImportance tests
test("sanitizeImportance: returns valid importance values", () => {
  expect(sanitizeImportance(0)).toBe(0);
  expect(sanitizeImportance(1)).toBe(1);
  expect(sanitizeImportance(2)).toBe(2);
  expect(sanitizeImportance(3)).toBe(3);
});

test("sanitizeImportance: rounds floating point values", () => {
  expect(sanitizeImportance(1.4)).toBe(1);
  expect(sanitizeImportance(1.6)).toBe(2);
  expect(sanitizeImportance(2.5)).toBe(3);
});

test("sanitizeImportance: returns 1 for out-of-range values", () => {
  expect(sanitizeImportance(-1)).toBe(1);
  expect(sanitizeImportance(4)).toBe(1);
  expect(sanitizeImportance(100)).toBe(1);
});

test("sanitizeImportance: returns 1 for invalid input", () => {
  expect(sanitizeImportance(null)).toBe(1);
  expect(sanitizeImportance(undefined)).toBe(1);
  expect(sanitizeImportance("2")).toBe(1);
  expect(sanitizeImportance(NaN)).toBe(1);
  expect(sanitizeImportance(Infinity)).toBe(1);
});

// sanitizeEntityLabel tests
test("sanitizeEntityLabel: returns trimmed valid labels", () => {
  expect(sanitizeEntityLabel("John Doe")).toBe("John Doe");
  expect(sanitizeEntityLabel("  Trimmed  ")).toBe("Trimmed");
});

test("sanitizeEntityLabel: returns undefined for invalid input", () => {
  expect(sanitizeEntityLabel(null)).toBeUndefined();
  expect(sanitizeEntityLabel(123)).toBeUndefined();
  expect(sanitizeEntityLabel("")).toBeUndefined();
  expect(sanitizeEntityLabel("   ")).toBeUndefined();
});

test("sanitizeEntityLabel: returns undefined for labels over 100 chars", () => {
  const longLabel = "a".repeat(101);
  expect(sanitizeEntityLabel(longLabel)).toBeUndefined();
  expect(sanitizeEntityLabel("a".repeat(100))).toBe("a".repeat(100));
});

// Run and report
const passed = results.filter((r) => r.passed).length;
const failed = results.filter((r) => !r.passed);

console.log(`\nEntity Normalizer Tests: ${passed}/${results.length} passed\n`);

if (failed.length > 0) {
  console.log("FAILURES:");
  for (const f of failed) {
    console.log(`  [FAIL] ${f.name}`);
    console.log(`         ${f.error}`);
  }
  process.exit(1);
} else {
  console.log("All tests passed!");
  process.exit(0);
}
