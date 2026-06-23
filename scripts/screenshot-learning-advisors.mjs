// Screenshots the PHASE-1 Learning Loop advisors:
//   1. ICP drawer → "Refine from evidence" panel (suggestions from assigned prospects)
//   2. Pitches page → pitch detail with the "Pitch angle advisor" card run
//   3. Prospect detail → pitch angle advisor near the Generate-pitch action
//
// Usage:
//   export $(grep -v '^#' .env.local | xargs)
//   TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     PORT=3100 node scripts/screenshot-learning-advisors.mjs

import { chromium } from "playwright";

const PORT = process.env.PORT ?? "3100";
const BASE = `http://localhost:${PORT}`;
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;

if (!TEST_EMAIL || !TEST_PASSWORD) {
  console.error("Missing TEST_EMAIL / TEST_PASSWORD");
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));
page.on("console", (msg) => {
  if (msg.type() === "error") console.error("CONSOLEERR", msg.text());
});

console.log("→ sign in…");
await page.goto(`${BASE}/sign-in`);
await page.fill('input[name="email"]', TEST_EMAIL);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 20000 });

// ── 1. ICP refine-from-evidence ───────────────────────────────────────────────
console.log("→ /icp — Refine from evidence…");
await page.goto(`${BASE}/icp`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(400);
await page.locator('button[aria-label^="Edit ICP: "]').first().click();
await page.waitForTimeout(600);
const refineBtn = page.getByRole("button", { name: /Refine from evidence/i });
if (await refineBtn.count()) {
  await refineBtn.click();
  // Haiku synthesis — give it time to return.
  await page.waitForTimeout(9000);
  await page.screenshot({ path: "/tmp/spam-icp-refine.png", fullPage: false });
  console.log("✓ /tmp/spam-icp-refine.png");
} else {
  console.error("! Refine button not found");
}
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// ── 2. Pitches page advisor ───────────────────────────────────────────────────
console.log("→ /pitches — angle advisor…");
await page.goto(`${BASE}/pitches`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(500);
const firstPitch = page.locator("main button, main a").filter({ hasText: /./ });
// Click the first pitch row (rows render prospect name + subject).
const pitchRow = page.locator('[class*="cursor-pointer"]').first();
try {
  await pitchRow.click({ timeout: 4000 });
} catch {
  console.error("! could not click a pitch row");
}
await page.waitForTimeout(600);
const angleBtn = page.getByRole("button", { name: /Suggest angles/i }).first();
if (await angleBtn.count()) {
  await angleBtn.click();
  await page.waitForTimeout(9000);
  await page.screenshot({ path: "/tmp/spam-pitches-angles.png", fullPage: false });
  console.log("✓ /tmp/spam-pitches-angles.png");
} else {
  console.error("! Suggest angles button not found on /pitches");
}

await browser.close();
console.log("done");
