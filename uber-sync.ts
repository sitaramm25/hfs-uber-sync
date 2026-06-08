import dotenv from "dotenv";
dotenv.config();

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
import path from "path";

const AUTH_FILE = "playwright/.auth/user.json";
const SCREENSHOTS_DIR = "screenshots";
const OPEN_ORDERS_URL =
  "https://merchants.ubereats.com/manager/orders?dateRange=today";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureDirs() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

function validateStorageState(file: string) {
  if (!fs.existsSync(file)) {
    throw new Error("Missing auth file - run login first");
  }

  const raw = fs.readFileSync(file, "utf8");
  JSON.parse(raw);

  if (!raw.includes("cookies") || !raw.includes("origins")) {
    throw new Error("Invalid storageState");
  }
}

function parsePrice(str: string | null): number {
  if (!str) return 0;
  const n = Number(str.replace(/[¥￥,\s]/g, ""));
  return isNaN(n) ? 0 : n;
}

function normalizeDate(input: string): string | null {
  const m = input.match(/(\d{4})[\/\-\.](\d{1,2})[\/\-\.](\d{1,2})/);
  if (!m) return null;

  const [_, y, mth, d] = m;
  return `${y}-${mth.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function normalizeTime(input: string): string | null {
  const m = input.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;

  const [_, h, min] = m;
  return `${h.padStart(2, "0")}:${min}`;
}

function jstToUtc(date: string, time: string) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) throw new Error("Missing Supabase env vars");

  return createClient(url, key, {
    realtime: { transport: ws as any },
  });
}

async function scrapeOrders(page: Page) {
  console.log("📦 Scraping Uber orders...");

  await page.waitForSelector("table tbody tr", {
    timeout: 20000,
  });

  const rows = await page.locator("table tbody tr").all();
  console.log("Rows:", rows.length);

  const orders: any[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const cells = (await row.locator("td").allTextContents())
      .map((c) => c.trim())
      .filter(Boolean);

    if (!cells.length) continue;

    const orderId = cells.find((x) => /^[A-Z0-9\-]{6,}$/.test(x));
    if (!orderId || seen.has(orderId)) continue;
    seen.add(orderId);

    const dateRaw = cells.find((x) => /\d{4}[\/\-.]\d{1,2}[\/\-.]\d{1,2}/.test(x));
    const timeRaw = cells.find((x) => /\d{1,2}:\d{2}/.test(x));
    const priceRaw = cells.find((x) => /¥|￥/.test(x)) || "0";

    const date = dateRaw ? normalizeDate(dateRaw) : null;
    const time = timeRaw ? normalizeTime(timeRaw) : null;

    if (!date || !time) continue;

    const total = parsePrice(priceRaw);
    if (total <= 0) continue;

    const order = {
      order_id: orderId,
      order_time: jstToUtc(date, time),
      order_date_jst: date,
      order_time_jst: time,
      order_datetime_jst: `${date} ${time}:00`,
      total,
      items: cells.filter(
        (x) => x !== orderId && !x.includes("¥") && !x.includes("￥")
      ),
      scraped_at: new Date().toISOString(),
      raw_data: { cells },
    };

    orders.push(order);

    console.log(`✔ ${orderId} ¥${total}`);
  }

  return orders;
}

async function main() {
  console.log("===== UBER SYNC FIXED =====");

  ensureDirs();
  validateStorageState(AUTH_FILE);

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: false, // IMPORTANT: debugging safety
    });

    const context = await browser.newContext({
      storageState: AUTH_FILE,
      timezoneId: "Asia/Tokyo",
      locale: "ja-JP",
    });

    const page = await context.newPage();

    await page.goto(OPEN_ORDERS_URL, {
  waitUntil: "domcontentloaded",
  timeout: 120000,
});

await page.waitForTimeout(8000);

    if (page.url().includes("login")) {
      throw new Error("Session expired");
    }

    await page.mouse.wheel(0, 3000);
    await sleep(2000);

    const orders = await scrapeOrders(page);

    console.log("TOTAL:", orders.length);

    if (orders.length) {
      const supabase = getSupabase();

      const { error } = await supabase
        .from("delivery_orders")
        .upsert(
          orders.map((o) => ({
            platform: "uber",
            ...o,
          })),
          { onConflict: "platform,order_id" }
        );

      if (error) throw error;
    }

    await context.close();
  } catch (e) {
    console.error("FAILED:", e);
  } finally {
    await browser?.close();
  }
}

main();