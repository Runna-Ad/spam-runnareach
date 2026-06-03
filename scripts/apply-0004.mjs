// Applies migration 0004 (prospect_research) via the service-role client.
// We don't have Supabase MCP access for this project, so this script reads
// the SQL file and pushes it to the project's `pg_meta` query endpoint.
//
// Usage:
//   cd /Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368
//   export $(grep -v '^#' .env.local | xargs)
//   node scripts/apply-0004.mjs

import { readFileSync } from "node:fs";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing env. Need NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY",
  );
  process.exit(1);
}

const sql = readFileSync(
  new URL("../supabase/migrations/0004_prospect_research.sql", import.meta.url),
  "utf8",
);

// Supabase exposes a pg-meta query endpoint at /pg/query (REST shim around the
// `query` RPC). Service-role auth + a JSON body of `{ query: <sql> }`.
const projectRef = new URL(url).hostname.split(".")[0];
const _endpoint = `https://${projectRef}.supabase.co/rest/v1/rpc/exec`;

// Try the modern path first (pg_meta), fall back to a plain SQL POST against
// /pg/query if it exists for the project. Newer Supabase deployments expose
// this through the dashboard's `query` RPC; if it isn't available, the user
// has to paste the SQL into the SQL editor manually.
async function tryEndpoint(path, body) {
  const r = await fetch(`https://${projectRef}.supabase.co${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
}

const attempts = [
  // Supabase pg-meta: not exposed publicly, will likely 404
  ["/pg-meta/query", { query: sql }],
  // Self-hosted SQL endpoint (if enabled): also likely 404 in managed
  ["/sql", { query: sql }],
];

let lastResp = null;
for (const [path, body] of attempts) {
  const resp = await tryEndpoint(path, body);
  lastResp = { path, ...resp };
  if (resp.ok) {
    console.log(`✓ migration applied via ${path}`);
    process.exit(0);
  }
}

console.error("Couldn't auto-apply via API endpoints.");
console.error("Last attempt:", lastResp);
console.error("");
console.error("Apply manually instead:");
console.error(
  `  1. Open https://supabase.com/dashboard/project/${projectRef}/sql/new`,
);
console.error("  2. Paste the contents of supabase/migrations/0004_prospect_research.sql");
console.error("  3. Run.");
process.exit(2);
