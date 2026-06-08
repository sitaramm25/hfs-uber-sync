import { chromium } from "playwright";
import fs from "fs";
import path from "path";

async function saveAuth() {
  const authDir = path.resolve("playwright/.auth");

  fs.mkdirSync(authDir, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext();

  const page = await context.newPage();

  await page.goto("https://merchants.ubereats.com/manager/");

  console.log("\n================================");
  console.log("LOGIN TO UBER EATS MANUALLY");
  console.log("COMPLETE HUMAN VERIFICATION");
  console.log("OPEN ORDERS PAGE IF NEEDED");
  console.log("THEN PRESS ENTER HERE");
  console.log("================================\n");

  // FIX: proper single-key wait
  process.stdin.resume();

  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  const savePath = path.resolve("playwright/.auth/user.json");

  await context.storageState({
    path: savePath,
  });

  console.log("✅ user.json saved");

  const state = JSON.parse(fs.readFileSync(savePath, "utf8"));

  console.log(
    `Cookies saved: ${state.cookies?.length || 0}`
  );

  await browser.close();
}

saveAuth().catch(async (err) => {
  console.error("❌ AUTH FAILED:", err);
});