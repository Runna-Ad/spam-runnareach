// Dev utility: smoke-test the /settings subpages + invite accept flow.
//   1. Sign in, screenshot Profile / Sending / Users pages
//   2. Fire the invite form (bogus email on runnareach.com) and capture
//      the copy-link banner
//   3. Open the generated invite link in a fresh context (signed out)
//      and screenshot the accept form
//
// Usage:
//   cd /Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368
//   export $(grep -v '^#' .env.local | xargs)
//   TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-settings.mjs

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RUNNA_CA_TENANT_ID = "11111111-1111-1111-1111-111111111111";

const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
const INVITE_EMAIL = process.env.INVITE_EMAIL ?? "smoke-invite@runnareach.com";

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
  } else if (p.role !== "admin") {
    await admin.from("users").update({ role: "admin" }).eq("id", uid);
  }
}

async function cleanInviteFixture() {
  const admin = createClient(url, serviceKey);
  await admin.from("invitations").delete().eq("email", INVITE_EMAIL);
  const { data: existing } = await admin.auth.admin.listUsers();
  const orphan = existing.users.find((u) => u.email === INVITE_EMAIL);
  if (orphan) {
    await admin.from("users").delete().eq("id", orphan.id);
    await admin.auth.admin.deleteUser(orphan.id);
  }
}

async function shoot() {
  await ensureTestUser();
  await cleanInviteFixture();

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

  // Profile
  await page.goto("http://localhost:3000/settings/profile");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-settings-profile.png", fullPage: true });

  // Sending
  await page.goto("http://localhost:3000/settings/sending");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-settings-sending.png", fullPage: true });

  // Users — capture invite flow
  await page.goto("http://localhost:3000/settings/users");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({ path: "/tmp/spam-settings-users.png", fullPage: true });

  await page.fill('form input[type="email"]', INVITE_EMAIL);
  await page.getByRole("button", { name: /^Invite$/ }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "/tmp/spam-settings-users-invited.png", fullPage: true });

  // Pull the generated link from the page so we can follow it in a fresh ctx.
  const inviteUrl = await page.locator('code').filter({ hasText: /\/invite\// }).first().textContent();
  console.log("invite link:", inviteUrl);

  if (!inviteUrl) {
    console.error("Did not find invite link on the page");
    await browser.close();
    process.exit(1);
  }

  // Open the invite link in a fresh (signed-out) context.
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guestPage = await ctx2.newPage();
  guestPage.on("pageerror", (e) => console.error("PAGEERR-guest", e.message));
  await guestPage.goto(inviteUrl.trim());
  await guestPage.waitForLoadState("networkidle");
  await guestPage.waitForTimeout(400);
  await guestPage.screenshot({ path: "/tmp/spam-settings-accept-invite.png", fullPage: true });

  await browser.close();
  await cleanInviteFixture();
  console.log(
    "saved /tmp/spam-settings-profile.png, sending.png, users.png, users-invited.png, accept-invite.png",
  );
}

shoot().catch((e) => {
  console.error("FAIL", e.message);
  process.exit(1);
});
