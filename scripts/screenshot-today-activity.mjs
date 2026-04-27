// Screenshots /dashboard with the new tenant-wide activity feed populated.
// Usage: PORT=3100 TEST_EMAIL=… TEST_PASSWORD=… node scripts/screenshot-today-activity.mjs

import { chromium } from "playwright";

const PORT = process.env.PORT ?? "3100";
const BASE = `http://localhost:${PORT}`;
const { TEST_EMAIL, TEST_PASSWORD } = process.env;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
page.on("pageerror", (e) => console.error("PAGEERR", e.message));

await page.goto(`${BASE}/sign-in`);
await page.fill('input[name="email"]', TEST_EMAIL);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 60000 });
await page.waitForLoadState("networkidle");
await page.waitForTimeout(800);
await page.screenshot({ path: "/tmp/spam-today-activity.png", fullPage: true });
console.log("✓ /tmp/spam-today-activity.png");

await browser.close();
