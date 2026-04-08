/**
 * Hit the deployed admin-only session-start smoke endpoint.
 *
 * Required env:
 *   BASE_URL=https://your-app.vercel.app
 *   ADMIN_SECRET=...
 *
 * Optional env:
 *   SMOKE_SCENARIO=session-start|repair
 *   SMOKE_PERSONA_SLUG=creative
 */

import "dotenv/config";

const baseUrl = process.env.BASE_URL || "http://localhost:3000";
const adminSecret = process.env.ADMIN_SECRET;

if (!adminSecret) {
  console.error("Missing ADMIN_SECRET in env.");
  process.exit(1);
}

async function run() {
  const scenario = process.env.SMOKE_SCENARIO || "session-start";
  const personaSlug = process.env.SMOKE_PERSONA_SLUG || "creative";
  const res = await fetch(`${baseUrl}/api/admin/session-start-smoke`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-admin-secret": adminSecret,
    },
    body: JSON.stringify({
      scenario,
      personaSlug,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Request failed ${res.status}: ${body}`);
  }

  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
}

run().catch((error) => {
  console.error("Remote session-start smoke failed:", error);
  process.exit(1);
});
