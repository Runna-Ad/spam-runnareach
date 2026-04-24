// Dev utility: smoke-test /icp CRUD.
//   1. Sign in, load the /icp grid, verify >= 2 cards (the 2 Alberta seeds)
//   2. Open the first card's drawer, screenshot it
//   3. Close, click "New ICP", screenshot the blank drawer
//
// Usage:
//   cd /Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368
//   export $(grep -v '^#' .env.local | xargs)
//   TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-icp.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUNNA_CA_TENANT_ID = "11111111-1111-1111-1111-111111111111";

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const TEST_NAME = process.env.TEST_NAME ?? "Pedro De Velasco";

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
      user_metadata: { full_name: TEST_NAME },
    });
    if (error) throw error;
    uid = data.user.id;
  } else {
    await admin.auth.admin.updateUserById(uid, { password: TEST_PASSWORD });
  }
  const { data: p } = await admin.from("users").select("id").eq("id", uid).maybeSingle();
  if (!p) {
    const { error } = await admin.from("users").insert({
      id: uid,
      tenant_id: RUNNA_CA_TENANT_ID,
      email: TEST_EMAIL,
      full_name: TEST_NAME,
      role: "admin",
    });
    if (error) throw error;
  }
}

async function shoot() {
  await ensureTestUser();
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

  await page.goto("http://localhost:3000/icp");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  const cards = await page.locator('button[aria-label^="Edit ICP"]').count();
  console.log(`icp cards rendered: ${cards}`);
  await page.screenshot({ path: "/tmp/spam-icp-grid.png", fullPage: true });

  if (cards < 2) {
    console.error(`expected >= 2 cards, got ${cards}`);
    await browser.close();
    process.exit(1);
  }

  await page.locator('button[aria-label^="Edit ICP"]').first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-icp-edit-drawer.png", fullPage: true });

  // Close drawer with Escape
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  // Open create drawer
  await page.getByRole("button", { name: /New ICP/i }).first().click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-icp-create-drawer.png", fullPage: true });

  await browser.close();
  console.log("saved /tmp/spam-icp-grid.png, /tmp/spam-icp-edit-drawer.png, /tmp/spam-icp-create-drawer.png");
}

shoot().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
