// E2E verifier for Phase 2 swap point #3 — Claude structured research.
// Logs in, finds a prospect with scraped research, clicks "Run structured
// research", then reads back pain_points + cost_tracking to confirm
// Claude (Sonnet) ran.
//
// Usage:
//   PORT=3001 TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-claude-research.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const env = readFileSync(".env.local", "utf8")
  .split("\n")
  .reduce((a, l) => {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m) a[m[1]] = m[2];
    return a;
  }, {});
const PORT = process.env.PORT ?? "3100";
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const TENANT = "11111111-1111-1111-1111-111111111111";

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const { data: prospect } = await admin
  .from("prospects")
  .select("id, company_name")
  .eq("company_name", "Demo · Quebec Pet Food")
  .eq("tenant_id", TENANT)
  .maybeSingle();
if (!prospect?.id) {
  console.error("no Demo · Quebec Pet Food prospect — re-seed first");
  process.exit(1);
}
const prospectId = prospect.id;

// Wipe pain_points so the action has work to do (idempotent re-runs
// would otherwise hit "no new pains" and not call Claude).
const { data: existingResearch } = await admin
  .from("prospect_research")
  .select("id, what_they_do, notes")
  .eq("prospect_id", prospectId)
  .eq("tenant_id", TENANT)
  .single();
if (!existingResearch) {
  console.error("no prospect_research for this prospect — scrape first");
  process.exit(1);
}
console.log("research what_they_do:", (existingResearch.what_they_do ?? "").slice(0, 80));
console.log("research notes:", (existingResearch.notes ?? "").slice(0, 80));

await admin
  .from("prospect_research")
  .update({ pain_points: [] })
  .eq("id", existingResearch.id);
console.log("wiped pain_points");

const costBefore = await admin
  .from("cost_tracking")
  .select("id", { count: "exact", head: true })
  .eq("category", "anthropic")
  .eq("entity_type", "research")
  .eq("tenant_id", TENANT);
console.log("cost_tracking research rows before:", costBefore.count);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("CONSOLEERR", msg.text());
});

await page.goto(`${BASE}/sign-in`);
await page.fill('input[name="email"]', TEST_EMAIL);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 60000 });

await page.goto(`${BASE}/companies/${prospectId}`);
await page.waitForLoadState("networkidle");
await page.getByRole("button", { name: /^Research/ }).click();
await page.waitForTimeout(400);

console.log("→ clicking Run structured research...");
const t0 = Date.now();
await page.getByRole("button", { name: /Run structured research/i }).click();
// Toast / status text appears with "Classified N pain points"
await page.waitForSelector("text=/Classified|No new pain points|Heuristic|Claude/i", { timeout: 30000 });
const elapsed = Date.now() - t0;
console.log(`→ research completed in ${elapsed}ms`);

await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/spam-claude-research.png", fullPage: false });
console.log("✓ /tmp/spam-claude-research.png");

await browser.close();

// Read back the pain_points
const { data: research } = await admin
  .from("prospect_research")
  .select("pain_points")
  .eq("id", existingResearch.id)
  .single();
console.log("\n=== pain_points after Claude ===");
console.log(JSON.stringify(research?.pain_points, null, 2));

const costAfter = await admin
  .from("cost_tracking")
  .select("id, cost_usd, sub_category, metadata", { count: "exact" })
  .eq("category", "anthropic")
  .eq("entity_type", "research")
  .eq("tenant_id", TENANT)
  .order("incurred_at", { ascending: false })
  .limit(1);
console.log("\ncost_tracking research rows after:", costAfter.count);
if (costAfter.data?.[0]) {
  console.log("latest research cost row:", {
    cost_usd: costAfter.data[0].cost_usd,
    model: costAfter.data[0].sub_category,
    metadata: costAfter.data[0].metadata,
  });
}

const claudeRan = (costAfter.count ?? 0) > (costBefore.count ?? 0);
console.log(claudeRan ? "\n✓ CLAUDE RAN" : "\n⚠ Claude did NOT run (heuristic fallback). Check audit_log metadata.");
