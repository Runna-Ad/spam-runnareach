// Screenshots /pitches end-to-end:
//   1. Generate a pitch from the prospect detail page
//   2. Show /pitches list with the new draft
//   3. Show the detail pane editing the body
// Usage:
//   PORT=3100 TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-pitches.mjs

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

// Wipe pitches for our demo prospect so the test is idempotent.
const { data: prospect } = await admin
  .from("prospects")
  .select("id")
  .eq("company_name", "Demo · Quebec Pet Food")
  .eq("tenant_id", TENANT)
  .maybeSingle();
const prospectId = prospect?.id;

if (prospectId) {
  await admin.from("pitches").delete().eq("prospect_id", prospectId);
  console.log("wiped existing pitches for prospect", prospectId);

  // Make sure there's at least one prospect_contacts row + a research row
  // with pain_points so the generator has good inputs.
  await admin
    .from("prospect_contacts")
    .delete()
    .eq("prospect_id", prospectId);
  await admin.from("prospect_contacts").insert({
    tenant_id: TENANT,
    prospect_id: prospectId,
    full_name: "Sarah Tremblay",
    email: "sarah@quebecpetfood.example.com",
    email_is_role_based: false,
    priority_rank: 1,
    selected_at: new Date().toISOString(),
    selected_by: "engine",
  });

  await admin
    .from("prospect_research")
    .upsert(
      {
        tenant_id: TENANT,
        prospect_id: prospectId,
        what_they_do: "Quebec-based DTC pet food brand selling subscription kibble nationally.",
        tech_stack: ["Shopify", "Klaviyo", "Recharge"],
        pain_points: [
          {
            pain_id: "44444444-4444-4444-4444-444444444443",
            pain_label: "Poor mobile conversion",
            evidence_quote: "checkout is 3 screens and breaks on iPhone Safari",
            confidence: 0.7,
          },
        ],
        notes: "Contact emails: sarah@quebecpetfood.example.com",
        evidence_urls: [
          "https://quebecpetfood.example.com",
          "https://quebecpetfood.example.com/about",
        ],
        research_method: "scraped",
      },
      { onConflict: "tenant_id,prospect_id" },
    );
  console.log("seeded contact + research");
} else {
  console.error("no Demo · Quebec Pet Food prospect");
  process.exit(1);
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("CONSOLEERR", msg.text());
});

await page.goto(`${BASE}/sign-in`);
await page.fill('input[name="email"]', TEST_EMAIL);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 15000 });

// Go to prospect detail + click Generate pitch
await page.goto(`${BASE}/companies/${prospectId}`);
await page.waitForLoadState("networkidle");
// Open Research tab so the action buttons are visible
await page.getByRole("button", { name: /^Research/ }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/spam-pitch-button.png", fullPage: false });
console.log("✓ /tmp/spam-pitch-button.png (Generate pitch button visible)");

await page.getByRole("button", { name: /Generate pitch/i }).click();
await page.waitForSelector("text=/Draft pitch ready/", { timeout: 15000 });
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/spam-pitch-success.png", fullPage: false });
console.log("✓ /tmp/spam-pitch-success.png (success message)");

// Navigate to /pitches
await page.goto(`${BASE}/pitches`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(800); // give the body fetch a moment
await page.screenshot({ path: "/tmp/spam-pitches-list.png", fullPage: false });
console.log("✓ /tmp/spam-pitches-list.png (list + detail pane)");

await browser.close();
