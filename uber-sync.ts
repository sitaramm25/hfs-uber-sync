import dotenv from "dotenv";
dotenv.config();

import { chromium, type Browser, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
import path from "path";

const AUTH_FILE = "playwright/.auth/user.json";
const OUTPUT_DIR = "output";

const OPEN_ORDERS_URL =
  "https://merchants.ubereats.com/manager/orders?dateRange=today";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDirs() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function validateStorageState(file: string) {
  if (!fs.existsSync(file)) throw new Error("Missing auth file");

  const raw = fs.readFileSync(file, "utf8");
  JSON.parse(raw);

  if (!raw.includes("cookies")) throw new Error("Invalid storage state");
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) throw new Error("Missing Supabase env vars");

  return createClient(url, key, {
    realtime: { transport: ws as any },
  });
}

async function scrape(page: Page) {
  await page.waitForSelector("table tbody tr", { timeout: 30000 });

  const rows = await page.locator("table tbody tr").all();

  const orders: any[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const cells = (await row.locator("td").allTextContents())
      .map((c) => c.trim())
      .filter(Boolean);

    const id = cells.find((x) => /^[A-Z0-9\-]{6,}$/.test(x));
    if (!id || seen.has(id)) continue;

    seen.add(id);

    const priceRaw = cells.find((x) => /¥|￥/.test(x)) || "0";
    const total = Number(priceRaw.replace(/[^\d]/g, "")) || 0;

    orders.push({
      order_id: id,
      platform: "uber",
      total,
      items: cells,
      scraped_at: new Date().toISOString(),
    });
  }

  return orders;
}

async function main() {
  ensureDirs();
  validateStorageState(AUTH_FILE);

  const browser: Browser = await chromium.launch({
    headless: !!process.env.CI,
  });

  try {
    const context = await browser.newContext({
      storageState: AUTH_FILE,
      timezoneId: "Asia/Tokyo",
    });

    const page = await context.newPage();

    await page.goto(OPEN_ORDERS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 120000,
    });

    await page.waitForTimeout(8000);

    const orders = await scrape(page);

    fs.writeFileSync(
      path.join(OUTPUT_DIR, "uber-orders.json"),
      JSON.stringify(orders, null, 2)
    );

    if (orders.length) {
      const supabase = getSupabase();

      await supabase.from("delivery_orders").upsert(orders, {
        onConflict: "platform,order_id",
      });
    }

    await context.close();
  } finally {
    await browser.close();
  }
}

main();