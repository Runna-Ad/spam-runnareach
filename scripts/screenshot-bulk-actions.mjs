// Screenshots /companies with bulk-action bar visible.
// Usage:
//   PORT=3100 TEST_EMAIL=petedv31@gmail.com TEST_PASSWORD=RunnaCase2026! \
//     node scripts/screenshot-bulk-actions.mjs

import { chromium } from "playwright";

const PORT = process.env.PORT ?? "3100";
const BASE = `http://localhost:${PORT}`;
const { TEST_EMAIL, TEST_PASSWORD } = process.env;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));

await page.goto(`${BASE}/sign-in`);
await page.fill('input[name="email"]', TEST_EMAIL);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 15000 });

await page.goto(`${BASE}/companies`);
await page.waitForLoadState("networkidle");
await page.waitForTimeout(400);

// Click first 3 row checkboxes
const checkboxes = page.locator('input[type="checkbox"][aria-label^="Select "]');
const n = await checkboxes.count();
console.log("rows:", n);
for (let i = 0; i < Math.min(3, n); i++) {
  await checkboxes.nth(i).click();
}
await page.waitForTimeout(400);
await page.screenshot({ path: "/tmp/spam-bulk-actions.png", fullPage: false });
console.log("✓ /tmp/spam-bulk-actions.png");

await browser.close();
