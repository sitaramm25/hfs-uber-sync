import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const AUTH_FILE = path.join(
  process.cwd(),
  "playwright",
  ".auth",
  "menu.json"
);

const MENU_REPORT_URL =
  "https://management.console.menu.inc/chain/orderReport/list?target_month=2026-06&shop_id=143836";

async function main() {
  // ensure directory exists
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });

  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
  });

  const context = await browser.newContext({
    timezoneId: "Asia/Tokyo",
    locale: "ja-JP",
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  await page.goto(MENU_REPORT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  console.log("🔐 Login to Menu manually.");
  console.log("👉 After page is ready, press ENTER here to save session.");

  // FIX: ensure stdin works properly
  process.stdin.resume();
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  await context.storageState({
    path: AUTH_FILE,
  });

  console.log("✅ Saved Menu auth:", AUTH_FILE);

  await browser.close();
}

main().catch((error) => {
  console.error("❌ MENU AUTH FAILED:", error);
  process.exit(1);
});