// Dev utility: smoke-test the ⌘K command palette.
//   1. Sign in, load /dashboard
//   2. Press Cmd+K to open the palette, screenshot it open
//   3. Type "ford" → verify Ford case study surfaces
//   4. Press Enter → verify navigation to /case-studies

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
  const { data: p } = await admin.from("users").select("id,role").eq("id", uid).maybeSingle();
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
  await page.waitForTimeout(400);

  // Open palette via keyboard
  await page.keyboard.press("Meta+k");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/spam-palette-open.png" });

  // Type and look for Ford
  await page.keyboard.type("ford");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "/tmp/spam-palette-ford.png" });

  const fordMatches = await page.locator('[cmdk-item]:has-text("Ford")').count();
  console.log(`ford matches: ${fordMatches}`);
  if (fordMatches < 1) {
    console.error("Ford not surfaced");
    await browser.close();
    process.exit(1);
  }

  // Press Enter → should navigate to /case-studies
  await page.keyboard.press("Enter");
  await page.waitForURL("**/case-studies", { timeout: 5000 });
  console.log("navigated to:", page.url());

  // Test topbar-button open
  await page.click('button[aria-label="Open command palette"]');
  await page.waitForTimeout(300);
  await page.keyboard.type("alberta");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-palette-icp.png" });

  const albertaMatches = await page.locator('[cmdk-item]:has-text("Alberta")').count();
  console.log(`alberta matches: ${albertaMatches}`);
  if (albertaMatches < 1) {
    console.error("Alberta ICP not surfaced");
    await browser.close();
    process.exit(1);
  }

  // ESC closes
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);

  await browser.close();
  console.log("saved /tmp/spam-palette-open.png, spam-palette-ford.png, spam-palette-icp.png");
}

shoot().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
