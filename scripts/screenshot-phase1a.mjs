// Dev utility: smoke-test Phase 1a — /compliance, /discover, /companies + CSV upload.
//
// Usage:
//   cd /Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368
//   export $(grep -v '^#' .env.local | xargs)
//   TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-phase1a.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

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

async function cleanFixtures() {
  const admin = createClient(url, serviceKey);
  // Wipe Phase-1a smoke fixtures so the test is idempotent.
  await admin.from("prospects").delete().like("company_name", "Smoke %");
  await admin.from("discovery_runs").delete().eq("source", "manual_upload");
  await admin.from("do_not_contact_list").delete().like("company_name", "Smoke %");
}

async function shoot() {
  await ensureTestUser();
  await cleanFixtures();

  // Write a CSV fixture to /tmp so we can upload it via Playwright's file chooser.
  const csv = `company_name,domain,website_url,industry,city,region,market
Smoke One Inc.,smokeone.ca,https://smokeone.ca,Coffee roaster,Calgary,Alberta,CA
Smoke Two Studio,smoketwo.io,https://smoketwo.io,Design agency,Edmonton,Alberta,CA
Smoke Three,, ,Consulting,Toronto,Ontario,CA
Smoke Four,smokefour.mx,,Tequila brand,Guadalajara,Jalisco,MX
`;
  const csvPath = "/tmp/spam-phase1a-fixture.csv";
  writeFileSync(csvPath, csv);

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

  // Compliance — capture, then add a DNC entry
  await page.goto("http://localhost:3000/compliance");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-phase1a-compliance.png", fullPage: true });

  await page.getByRole("button", { name: /Add entry/i }).first().click();
  await page.waitForTimeout(300);
  await page.fill('input[type="email"]', "ceo@smoketarget.com");
  await page.fill('input[placeholder="target.com"]', "smoketarget.com");
  await page.fill('input[placeholder="Target Inc."]', "Smoke Target Inc.");
  await page.getByRole("button", { name: /Add to DNC/i }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: "/tmp/spam-phase1a-compliance-after.png", fullPage: true });

  // Cleanup the just-added DNC so subsequent runs are idempotent.
  const adminClient = createClient(url, serviceKey);
  await adminClient
    .from("do_not_contact_list")
    .delete()
    .eq("email", "ceo@smoketarget.com");

  // Discover — show sources + open CSV upload + import fixture
  await page.goto("http://localhost:3000/discover");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-phase1a-discover.png", fullPage: true });

  // Click the "Upload CSV" button in the topbar
  await page.locator('button:has-text("Upload CSV")').first().click();
  await page.waitForTimeout(400);

  // Select the CSV file
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.locator('button:has-text("Choose CSV")').click(),
  ]);
  await chooser.setFiles(csvPath);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "/tmp/spam-phase1a-upload-preview.png", fullPage: true });

  // Import
  await page.getByRole("button", { name: /Import \d+ prospect/i }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "/tmp/spam-phase1a-upload-done.png", fullPage: true });

  // Close drawer + check Discover history
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-phase1a-discover-after.png", fullPage: true });

  const runsRendered = await page.locator('td:has-text("Manual upload")').count();
  console.log(`run-history rows for manual_upload: ${runsRendered}`);

  // Companies — verify the 4 prospects show up
  await page.goto("http://localhost:3000/companies");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-phase1a-companies.png", fullPage: true });

  const companyRows = await page.locator('td:has-text("Smoke ")').count();
  console.log(`companies rows containing "Smoke ": ${companyRows}`);
  if (companyRows < 4) {
    console.error("Expected at least 4 'Smoke …' rows on /companies");
    await browser.close();
    process.exit(1);
  }

  // Filter by market = MX → only Smoke Four
  await page.locator('select').filter({ hasText: /All markets/ }).first().selectOption("MX");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/spam-phase1a-companies-mx.png", fullPage: true });
  const mxRows = await page.locator('td:has-text("Smoke Four")').count();
  console.log(`MX-filtered rows containing "Smoke Four": ${mxRows}`);

  await browser.close();
  await cleanFixtures();
  console.log("saved /tmp/spam-phase1a-*.png");
}

shoot().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
