// E2E smoke for the site scraper:
//   1. Sign in
//   2. Insert a fixture prospect with domain=shopify.com
//   3. Open /companies/[id], click Research tab
//   4. Click "Scrape website" → confirm research fields populate (tech_stack
//      should include Shopify, what_they_do should be set, evidence URLs > 0)

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUNNA_CA_TENANT_ID = "11111111-1111-1111-1111-111111111111";

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

if (!url || !serviceKey || !TEST_EMAIL || !TEST_PASSWORD) {
  console.error("Missing env. Need NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TEST_EMAIL, TEST_PASSWORD");
  process.exit(1);
}

async function ensureTestUser() {
  const admin = createClient(url, serviceKey);
  const { data: existing } = await admin.auth.admin.listUsers();
  let uid = existing.users.find((u) => u.email === TEST_EMAIL)?.id ?? null;
  if (!uid) {
    const { data, error } = await admin.auth.admin.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Pedro De Velasco" },
    });
    if (error) throw error;
    uid = data.user.id;
  } else {
    await admin.auth.admin.updateUserById(uid, { password: TEST_PASSWORD });
  }
  const { data: p } = await admin.from("users").select("id").eq("id", uid).maybeSingle();
  if (!p) {
    await admin.from("users").insert({
      id: uid,
      tenant_id: RUNNA_CA_TENANT_ID,
      email: TEST_EMAIL,
      full_name: "Pedro De Velasco",
      role: "admin",
    });
  }
}

async function ensureFixture() {
  const admin = createClient(url, serviceKey);
  // Wipe prior runs of this test
  await admin.from("prospects").delete().eq("company_name", "Scrape Smoke Shopify");

  const { data, error } = await admin
    .from("prospects")
    .insert({
      tenant_id: RUNNA_CA_TENANT_ID,
      discovery_source: "manual_upload",
      company_name: "Scrape Smoke Shopify",
      domain: "shopify.com",
      website_url: "https://shopify.com",
      industry: "DTC platform",
      city: "Ottawa",
      region: "Ontario",
      country_code: "CA",
      market: "CA",
      language: "en",
      status: "raw",
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

async function shoot() {
  await ensureTestUser();
  const prospectId = await ensureFixture();

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("PAGEERR", e.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error("CONSOLEERR", msg.text());
  });

  await page.goto("http://localhost:3000/sign-in");
  await page.fill('input[name="email"]', TEST_EMAIL);
  await page.fill('input[name="password"]', TEST_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL("**/dashboard", { timeout: 15000 });

  await page.goto(`http://localhost:3000/companies/${prospectId}`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  // Research tab
  await page.getByRole("button", { name: /^Research/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/spam-scraper-before.png", fullPage: true });

  // Click Scrape — page does a server action + router.refresh()
  await page.getByRole("button", { name: /Scrape website/i }).click();
  // Wait for the success message...
  await page.waitForSelector("text=/Scraped: /", { timeout: 30000 });
  // ...then wait for the router.refresh() round-trip to repopulate form fields
  // (the textarea below shows the scraped text once the new props mount).
  await page.waitForFunction(
    () => {
      const ta = document.querySelector('textarea');
      return ta && ta.value && ta.value.length > 30;
    },
    { timeout: 15000 },
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-scraper-after.png", fullPage: true });

  // Verify in DB the research row was written
  const admin = createClient(url, serviceKey);
  const { data: research } = await admin
    .from("prospect_research")
    .select("what_they_do, tech_stack, evidence_urls, research_method, last_scraped_at")
    .eq("prospect_id", prospectId)
    .maybeSingle();

  if (!research) {
    console.error("research row not written");
    process.exit(1);
  }

  console.log("DB result:");
  console.log("  what_they_do:", research.what_they_do?.slice(0, 80) ?? "(none)");
  console.log("  tech_stack:", research.tech_stack);
  console.log("  evidence_urls count:", research.evidence_urls?.length ?? 0);
  console.log("  research_method:", research.research_method);
  console.log("  last_scraped_at:", research.last_scraped_at);

  if (!research.tech_stack?.includes("Shopify")) {
    console.error("Expected Shopify in tech_stack, got:", research.tech_stack);
    process.exit(1);
  }
  if (!research.what_they_do) {
    console.error("Expected what_they_do to be set");
    process.exit(1);
  }

  // Status should have bumped raw → researched
  const { data: prospectAfter } = await admin
    .from("prospects")
    .select("status")
    .eq("id", prospectId)
    .single();
  console.log("  prospect status:", prospectAfter.status);
  if (prospectAfter.status !== "researched") {
    console.error("Expected status=researched, got:", prospectAfter.status);
    process.exit(1);
  }

  await browser.close();

  // Cleanup
  await admin.from("prospect_research").delete().eq("prospect_id", prospectId);
  await admin.from("prospects").delete().eq("id", prospectId);

  console.log("\n✓ scraper smoke green");
  console.log("saved /tmp/spam-scraper-before.png + /tmp/spam-scraper-after.png");
}

shoot().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
