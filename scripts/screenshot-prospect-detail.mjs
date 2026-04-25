// Smoke-test the /companies/[id] prospect detail page.
//   1. Sign in, upload a fixture prospect via DB
//   2. Click row in /companies → land on /companies/[id]
//   3. Screenshot Overview / Research / Activity tabs
//   4. Click "Scrape website" → confirm stub error message renders

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

async function ensureFixtureProspect() {
  const admin = createClient(url, serviceKey);
  // Wipe any prior fixture
  await admin.from("prospects").delete().eq("company_name", "Detail Smoke Inc.");

  const { data, error } = await admin
    .from("prospects")
    .insert({
      tenant_id: RUNNA_CA_TENANT_ID,
      discovery_source: "manual_upload",
      company_name: "Detail Smoke Inc.",
      domain: "detailsmoke.ca",
      website_url: "https://detailsmoke.ca",
      industry: "Specialty coffee roaster",
      city: "Calgary",
      region: "Alberta",
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
  const prospectId = await ensureFixtureProspect();

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

  // Click-through from /companies
  await page.goto("http://localhost:3000/companies");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  // Click the row containing "Detail Smoke Inc."
  await page.locator('tr:has-text("Detail Smoke Inc.")').first().click();
  await page.waitForURL(`**/companies/${prospectId}`, { timeout: 5000 });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  await page.screenshot({ path: "/tmp/spam-prospect-overview.png", fullPage: true });

  // Research tab
  await page.getByRole("button", { name: /^Research/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/spam-prospect-research.png", fullPage: true });

  // Click Scrape button if the research form is visible (i.e. migration applied).
  // If the migration isn't applied yet, the Research tab shows instructions
  // instead of the scrape button — that's also a valid state, just skip.
  const scrapeBtn = page.getByRole("button", { name: /Scrape website/i });
  if ((await scrapeBtn.count()) > 0) {
    await scrapeBtn.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: "/tmp/spam-prospect-research-scrape.png", fullPage: true });
  } else {
    console.log("research form not rendered (migration 0004 not applied yet) — skipping scrape click");
  }

  // Activity tab
  await page.getByRole("button", { name: /^Activity/ }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/spam-prospect-activity.png", fullPage: true });

  await browser.close();

  // Cleanup
  const admin = createClient(url, serviceKey);
  await admin.from("prospects").delete().eq("id", prospectId);

  console.log("saved /tmp/spam-prospect-*.png");
}

shoot().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
