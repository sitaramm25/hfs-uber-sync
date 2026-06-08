import { chromium } from "playwright";
import fs from "fs";
import os from "os";
import path from "path";

const PROFILE_DIR = path.join(os.homedir(), "rocket-browser-profile");

const ROCKET_URL =
  "https://store.rocketnow.co.jp/merchant/management/orders";

async function main() {
  // ensure folder exists
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: "chrome",
    headless: false,
    timezoneId: "Asia/Tokyo",
    locale: "ja-JP",
    viewport: { width: 1440, height: 900 },
  });

  const page = context.pages()[0] || (await context.newPage());

  await page.goto(ROCKET_URL, {
    waitUntil: "domcontentloaded",
    timeout: 90000,
  });

  console.log("Login to Rocket manually.");
  console.log("After orders page opens, press ENTER here to save session.");

  // wait for ENTER key
  await new Promise<void>((resolve) => {
    process.stdin.resume();
    process.stdin.once("data", () => resolve());
  });

  console.log("✅ Rocket persistent profile saved:", PROFILE_DIR);

  await context.close();
}

main();