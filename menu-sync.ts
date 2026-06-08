import { chromium, type Browser } from "playwright";
import { createClient } from "@supabase/supabase-js";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

const AUTH_FILE = path.join(
  process.cwd(),
  "playwright",
  ".auth",
  "menu.json"
);

const MENU_REPORT_URL =
  "https://management.console.menu.inc/chain/orderReport/list?target_month=2026-06&shop_id=143836";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(supabaseUrl, supabaseKey);

function jstToUtcIso(dateText: string, timeText: string) {
  return new Date(`${dateText}T${timeText}:00+09:00`).toISOString();
}

function cleanText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function parsePrice(text: string) {
  const n = text.replace(/[^\d]/g, "");
  return n ? Number(n) : 0;
}

function normalizeDate(dateText: string) {
  const [y, m, d] = dateText.replace(/\//g, "-").split("-");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function normalizeTime(timeText: string) {
  const [h, m] = timeText.split(":");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

async function main() {
  console.log("========== MENU SYNC ==========");

  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(
      `Auth file not found: ${AUTH_FILE}\nRun menu auth first.`
    );
  }

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: false, // FIX: debugging safer
    });

    const context = await browser.newContext({
      storageState: AUTH_FILE,
      timezoneId: "Asia/Tokyo",
      locale: "ja-JP",
      viewport: { width: 1440, height: 900 },
    });

    const page = await context.newPage();

    console.log("🌐 Opening MENU...");
    await page.goto(MENU_REPORT_URL, {
      waitUntil: "networkidle", // FIX: more stable than domcontentloaded
      timeout: 90000,
    });

    await page.waitForTimeout(5000);

    const url = page.url();
    console.log("URL:", url);

    if (url.includes("login") || url.includes("signin")) {
      throw new Error("Session expired. Run menu auth again.");
    }

    const rows = await page.locator("table tbody tr").all();
    console.log(`Found rows: ${rows.length}`);

    const orders: any[] = [];

    for (const row of rows) {
      const cells = (await row.locator("td").allTextContents())
        .map(cleanText)
        .filter((x) => x.length > 0);

      if (cells.length < 4) continue;

      const joined = cells.join(" ");

      const orderId = cells.find((x) => /^[A-Z0-9]{5,10}$/.test(x));
      const dateMatch = joined.match(
        /20\d{2}[-/]\d{1,2}[-/]\d{1,2}/
      );
      const timeMatch = joined.match(/\b\d{1,2}:\d{2}\b/);
      const priceCell = cells.find(
        (x) => /[¥￥]\s*[\d,]+/.test(x) || /^[\d,]+円?$/.test(x)
      );

      if (!orderId || !dateMatch || !timeMatch || !priceCell) continue;

      const orderDate = normalizeDate(dateMatch[0]);
      const orderTime = normalizeTime(timeMatch[0]);
      const total = parsePrice(priceCell);

      if (total <= 0) continue;

      const items = cells.filter(
        (x) =>
          x !== orderId &&
          !x.includes(orderDate) &&
          !x.includes(orderTime) &&
          x !== priceCell
      );

      orders.push({
        platform: "menu",
        order_id: orderId,
        order_time: jstToUtcIso(orderDate, orderTime),
        order_date_jst: orderDate,
        order_time_jst: orderTime,
        order_datetime_jst: `${orderDate} ${orderTime}:00`,
        total,
        items,
        raw_data: { cells },
        scraped_at: new Date().toISOString(),
      });

      console.log(`✔ ${orderId} ¥${total}`);
    }

    console.log("Parsed:", orders.length);

    if (orders.length > 0) {
      const { error } = await supabase
        .from("delivery_orders")
        .upsert(orders, {
          onConflict: "platform,order_id",
        });

      if (error) throw error;
    }

    await context.close();
    console.log("✅ DONE");
  } catch (e) {
    console.error("❌ FAILED:", e);
  } finally {
    await browser?.close();
  }
}

main();