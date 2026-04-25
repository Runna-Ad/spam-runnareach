// Screenshots the upgraded ICP drawer:
//   1. Drawer opened on an existing ICP — shows the Suggest button + first
//      suggestion-equipped TagInput
//   2. Same drawer with the dropdown OPEN on Google Places types so the
//      autocomplete UX is visible
//   3. Drawer for a fresh "New ICP" with the Suggest reasoning visible
//      after clicking Suggest from a populated name
//
// Usage:
//   cd /Users/work/Projects/S.P.A.M/.claude/worktrees/pensive-wilson-3cc368
//   export $(grep -v '^#' .env.local | xargs)
//   TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     PORT=3100 node scripts/screenshot-icp-suggestions.mjs

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
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
await page.waitForURL("**/dashboard", { timeout: 15000 });

console.log("→ /icp…");
await page.goto(`${BASE}/icp`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(400);

// Open the first ICP card
const firstCard = page.locator('button[aria-label^="Edit ICP: "]').first();
await firstCard.click();
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/spam-icp-drawer-suggest.png", fullPage: false });
console.log("✓ /tmp/spam-icp-drawer-suggest.png");

// Click into the Google Places types input to open its dropdown.
// The Field/Label pattern wraps the TagInput container, so the
// "Google Places types" label points at a wrapper div, not the
// actual <input>. Find the input by traversing.
const placesLabel = page.getByText(/Google Places types/i).first();
await placesLabel.scrollIntoViewIfNeeded();
// The input is the first <input> after the label wrapper — click the
// container that holds it.
const placesContainer = page.locator('text=Google Places types').locator('..').locator('input').first();
await placesContainer.click();
await page.waitForTimeout(300);
await page.keyboard.type("c");
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/spam-icp-drawer-dropdown.png", fullPage: false });
console.log("✓ /tmp/spam-icp-drawer-dropdown.png");

// Close drawer, open New ICP, type a name, click Suggest
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
await page.getByRole("button", { name: /^New ICP$/ }).click();
await page.waitForTimeout(400);
await page.getByPlaceholder(/Alberta DTC ecommerce/i).fill("Toronto DTC fitness apparel, 10-30 employees");
await page.getByRole("button", { name: /Suggest from name/i }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/spam-icp-drawer-suggested.png", fullPage: false });
console.log("✓ /tmp/spam-icp-drawer-suggested.png");

await browser.close();
