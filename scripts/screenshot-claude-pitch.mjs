// Generates a real Claude pitch end-to-end + verifies cost_tracking row
// + screenshots /pitches.
//
// Usage:
//   PORT=3100 TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-claude-pitch.mjs

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
  .select("id")
  .eq("company_name", "Demo · Quebec Pet Food")
  .eq("tenant_id", TENANT)
  .maybeSingle();
const prospectId = prospect?.id;
if (!prospectId) {
  console.error("no Demo · Quebec Pet Food prospect — re-seed first");
  process.exit(1);
}

// Wipe prior pitches so the test is idempotent
await admin.from("pitches").delete().eq("prospect_id", prospectId);
console.log("wiped prior pitches");

const costBefore = await admin
  .from("cost_tracking")
  .select("id", { count: "exact", head: true })
  .eq("category", "anthropic")
  .eq("tenant_id", TENANT);
console.log("cost_tracking rows before:", costBefore.count);

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

console.log("→ clicking Generate pitch (Claude)...");
const t0 = Date.now();
await page.getByRole("button", { name: /Generate pitch/i }).click();
await page.waitForSelector("text=/Draft pitch ready/", { timeout: 30000 });
const elapsed = Date.now() - t0;
console.log(`→ pitch ready in ${elapsed}ms`);

await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/spam-claude-pitch-success.png", fullPage: false });
console.log("✓ /tmp/spam-claude-pitch-success.png");

await page.goto(`${BASE}/pitches`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(1200);
await page.screenshot({ path: "/tmp/spam-claude-pitch-detail.png", fullPage: false });
console.log("✓ /tmp/spam-claude-pitch-detail.png");

await browser.close();

const costAfter = await admin
  .from("cost_tracking")
  .select("id, cost_usd, sub_category, metadata", { count: "exact" })
  .eq("category", "anthropic")
  .eq("tenant_id", TENANT)
  .order("incurred_at", { ascending: false })
  .limit(1);
console.log("cost_tracking rows after:", costAfter.count);
if (costAfter.data?.[0]) {
  console.log("latest cost row:", {
    cost_usd: costAfter.data[0].cost_usd,
    model: costAfter.data[0].sub_category,
    metadata: costAfter.data[0].metadata,
  });
}

const { data: pitch } = await admin
  .from("pitches")
  .select("id, subject, body_original, cost_usd, token_count_in, token_count_out, quality_self_score")
  .eq("prospect_id", prospectId)
  .order("created_at", { ascending: false })
  .limit(1)
  .single();
if (pitch) {
  console.log("\n=== Pitch ===");
  console.log("Subject:", pitch.subject);
  console.log("Body:");
  console.log(pitch.body_original);
  console.log("\n=== Meta ===");
  console.log("self-score:", pitch.quality_self_score);
  console.log("tokens in/out:", pitch.token_count_in, "/", pitch.token_count_out);
  console.log("cost USD:", pitch.cost_usd);
}
