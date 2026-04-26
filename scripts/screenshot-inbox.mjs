// Screenshots /inbox in three states:
//   1. Empty state (no replies)
//   2. With seeded replies of varied intents
//   3. Detail pane open on a hot reply
// Usage:
//   PORT=3100 TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-inbox.mjs

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

// Wipe + re-seed demo replies on a known prospect.
const { data: existing } = await admin
  .from("prospects")
  .select("id")
  .eq("company_name", "Demo · Quebec Pet Food")
  .eq("tenant_id", TENANT)
  .maybeSingle();

const prospectId = existing?.id;

if (prospectId) {
  await admin.from("replies").delete().eq("tenant_id", TENANT).eq("prospect_id", prospectId);

  const fixtures = [
    {
      from_email: "sarah@quebecpetfood.example.com",
      subject: "Re: quick question about your DTC roastery",
      body_text:
        "Hey Pedro — thanks for reaching out. We're definitely curious about working with an agency. Could you grab some time on my Calendly next week? https://calendly.com/sarah-qpf",
      received_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      intent: "wants_meeting",
      urgency: "hot",
      sentiment: "positive",
    },
    {
      from_email: "marketing@quebecpetfood.example.com",
      subject: "Out of office — back Apr 30",
      body_text:
        "I am out of the office until April 30 and will respond to your email when I return.",
      received_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      intent: "auto_reply",
      urgency: "cold",
      sentiment: "neutral",
    },
    {
      from_email: "ben@quebecpetfood.example.com",
      subject: "not the right person",
      body_text:
        "Hey, I'm not the right person to talk to about this — please contact our marketing lead Sarah at sarah@quebecpetfood.example.com.",
      received_at: new Date(Date.now() - 36 * 3600 * 1000).toISOString(),
      intent: "wrong_person",
      urgency: "cold",
      sentiment: "neutral",
    },
    {
      from_email: "alex@quebecpetfood.example.com",
      subject: "send me more info",
      body_text:
        "Could you share some case studies for similar DTC pet brands? Curious to see what kind of results you've gotten.",
      received_at: new Date(Date.now() - 12 * 3600 * 1000).toISOString(),
      intent: "wants_info",
      urgency: "warm",
      sentiment: "positive",
    },
  ];

  await admin.from("replies").insert(
    fixtures.map((f) => ({
      tenant_id: TENANT,
      pitch_id: null,
      prospect_id: prospectId,
      from_email: f.from_email,
      subject: f.subject,
      body_text: f.body_text,
      received_at: f.received_at,
      intent: f.intent,
      urgency: f.urgency,
      sentiment: f.sentiment,
      classified_at: new Date().toISOString(),
    })),
  );
  console.log("seeded 4 replies");
} else {
  console.log("⚠ no Demo · Quebec Pet Food prospect — re-run screenshot-validation.mjs first");
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));

await page.goto(`${BASE}/sign-in`);
await page.fill('input[name="email"]', TEST_EMAIL);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 15000 });

await page.goto(`${BASE}/inbox`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/spam-inbox-list.png", fullPage: false });
console.log("✓ /tmp/spam-inbox-list.png");

// Click first reply (the hot wants_meeting one)
const firstRow = page.locator('button[type="button"]').filter({ hasText: "Wants meeting" }).first();
await firstRow.click();
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/spam-inbox-detail.png", fullPage: false });
console.log("✓ /tmp/spam-inbox-detail.png");

await browser.close();
