/**
 * Fetch recent librarian + synapse ingest traces from admin endpoints.
 * Usage:
 *   pnpm tsx scripts/admin/fetch-traces.ts
 * Optional env:
 *   TRACE_LIMIT=50
 *   TRACE_USER_ID=...
 *   TRACE_PERSONA_ID=...
 *   TRACE_SESSION_ID=...
 *   TRACE_SINCE_MINUTES=30
 *   INCLUDE_TEXT=1
 *   ONLY_FAILURES=1
 *   BASE_URL=https://your-domain
 */

import "dotenv/config";

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const adminKey = process.env.ADMIN_API_KEY;

if (!adminKey) {
  console.error("Missing ADMIN_API_KEY in env.");
  process.exit(1);
}

const limit = process.env.TRACE_LIMIT || "50";
const userId = process.env.TRACE_USER_ID;
const personaId = process.env.TRACE_PERSONA_ID;
const sessionId = process.env.TRACE_SESSION_ID;
const sinceMinutes = process.env.TRACE_SINCE_MINUTES;
const includeText = process.env.INCLUDE_TEXT === "1";
const onlyFailures = process.env.ONLY_FAILURES === "1";

function buildQuery() {
  const params = new URLSearchParams();
  params.set("limit", limit);
  if (userId) params.set("userId", userId);
  if (personaId) params.set("personaId", personaId);
  if (sessionId) params.set("sessionId", sessionId);
  if (sinceMinutes) params.set("sinceMinutes", sinceMinutes);
  if (includeText) params.set("includeText", "1");
  return params.toString();
}

async function fetchJson(path: string, extraParams?: Record<string, string>) {
  const params = new URLSearchParams(buildQuery());
  if (extraParams) {
    for (const [key, value] of Object.entries(extraParams)) {
      params.set(key, value);
    }
  }
  const url = `${baseUrl}${path}?${params.toString()}`;
  const res = await fetch(url, {
    headers: { "x-admin-key": adminKey },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Request failed ${res.status}: ${body}`);
  }
  return res.json();
}

async function run() {
  const librarian = await fetchJson("/api/admin/librarian-trace");
  const ingest = await fetchJson("/api/admin/synapse-ingest-trace", {
    ...(onlyFailures ? { onlyFailures: "1" } : {}),
  });

  console.log("\n== Librarian Traces ==");
  console.log(JSON.stringify(librarian, null, 2));
  console.log("\n== Synapse Ingest Traces ==");
  console.log(JSON.stringify(ingest, null, 2));
}

run().catch((error) => {
  console.error("Trace fetch failed:", error);
  process.exit(1);
});
