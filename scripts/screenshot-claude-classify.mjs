// E2E verifier for Phase 2 swap point #2 — Claude reply classifier.
// Logs in, opens /inbox, posts a manual reply via the form, then
// reads back the row + cost_tracking row to confirm Claude ran.
//
// Usage:
//   PORT=3001 TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-claude-classify.mjs

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

const TEST_FROM = `e2e-classify-${Date.now()}@example.com`;
const TEST_SUBJECT = "Re: quick question about checkout drop-off";
const TEST_BODY =
  "Hey Pedro — really interested in what you wrote. Could you grab some time on my Calendly next Tuesday? https://calendly.com/sarah-test";

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

// Snapshot starting state for cost_tracking.
const costBefore = await admin
  .from("cost_tracking")
  .select("id", { count: "exact", head: true })
  .eq("category", "anthropic")
  .eq("entity_type", "reply_classify")
  .eq("tenant_id", TENANT);
console.log("cost_tracking reply_classify rows before:", costBefore.count);

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

await page.goto(`${BASE}/inbox`);
await page.waitForLoadState("networkidle");

// Open the "Log a reply manually" drawer
console.log("→ opening manual entry drawer...");
await page.getByRole("button", { name: /^Log reply$/i }).first().click();
await page.waitForSelector("#from", { timeout: 5000 });

await page.fill("#from", TEST_FROM);
await page.selectOption("#prospect", prospectId);
await page.fill("#subject", TEST_SUBJECT);
await page.fill("#body", TEST_BODY);

console.log("→ submitting (Claude should classify)...");
const t0 = Date.now();
await page.getByRole("button", { name: /Log reply \+ classify/i }).click();
// Wait for the drawer to close — that's our signal the action returned ok
await page.waitForSelector("#from", { state: "detached", timeout: 30000 });
const elapsed = Date.now() - t0;
console.log(`→ classify completed in ${elapsed}ms`);

await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/spam-claude-classify-list.png", fullPage: false });
console.log("✓ /tmp/spam-claude-classify-list.png");

await browser.close();

// Read back the row Claude classified
const { data: reply, error: replyErr } = await admin
  .from("replies")
  .select("id, intent, urgency, sentiment, classified_at")
  .eq("from_email", TEST_FROM.toLowerCase())
  .eq("tenant_id", TENANT)
  .order("received_at", { ascending: false })
  .limit(1)
  .single();
if (replyErr) {
  console.error("could not load reply:", replyErr.message);
  process.exit(1);
}
console.log("\n=== Reply row ===");
console.log(reply);

// Cost row written?
const costAfter = await admin
  .from("cost_tracking")
  .select("id, cost_usd, sub_category, metadata", { count: "exact" })
  .eq("category", "anthropic")
  .eq("entity_type", "reply_classify")
  .eq("tenant_id", TENANT)
  .order("incurred_at", { ascending: false })
  .limit(1);
console.log("\ncost_tracking reply_classify rows after:", costAfter.count);
if (costAfter.data?.[0]) {
  console.log("latest reply_classify cost row:", {
    cost_usd: costAfter.data[0].cost_usd,
    model: costAfter.data[0].sub_category,
    metadata: costAfter.data[0].metadata,
  });
}

// Audit log row?
const { data: audit } = await admin
  .from("audit_log")
  .select("metadata")
  .eq("tenant_id", TENANT)
  .eq("entity_id", prospectId)
  .order("created_at", { ascending: false })
  .limit(1)
  .single();
console.log("\nlatest audit row metadata:");
console.log(audit?.metadata);

const claudeRan = (costAfter.count ?? 0) > (costBefore.count ?? 0);
console.log(claudeRan ? "\n✓ CLAUDE RAN" : "\n⚠ Claude did NOT run (heuristic fallback). Check fallback_reason in audit metadata.");
