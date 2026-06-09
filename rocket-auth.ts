/**
 * Rocket Now Manager Sync Script
 * Persistent Chrome Profile + JST → UTC save
 */

import dotenv from "dotenv";
dotenv.config();

import { chromium, type BrowserContext, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
import fs from "fs";
import path from "path";
import os from "os";

// ✅ FIX: safe portable profile path (override via env if needed)
const PROFILE_DIR =
  process.env.ROCKET_PROFILE_DIR ||
  path.join(os.homedir(), "rocket-browser-profile");

// screenshots folder (safe in runner workspace)
const SCREENSHOTS_DIR = path.join(process.cwd(), "screenshots");

const OPEN_ORDERS_URL =
  "https://store.rocketnow.co.jp/merchant/management/orders";

function ensureDirectories() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase env vars");
  }

  return createClient(url, key, {
    realtime: { transport: ws as any },
  });
}

async function saveScreenshot(page: Page, name: string) {
  const file = path.join(
    SCREENSHOTS_DIR,
    `${name}-${Date.now()}.png`
  );
  await page.screenshot({ path: file, fullPage: true });
  console.log("📸 Saved:", file);
}

function jstToUtcIso(dateText: string, timeText: string) {
  return new Date(`${dateText}T${timeText}:00+09:00`).toISOString();
}

// ✅ FIXED (critical bug: missing minute variable)
function parseRocketVisibleDateTime(text: string) {
  const match = text.match(
    /(\d{2})\.(\d{2})\.(\d{2})\s+(\d{1,2}):(\d{2})/
  );

  if (!match) {
    const now = new Date();
    return {
      order_time: now.toISOString(),
      order_date_jst: null,
      order_time_jst: null,
      order_datetime_jst: null,
    };
  }

  const year = 2000 + Number(match[1]);
  const month = String(Number(match[2])).padStart(2, "0");
  const day = String(Number(match[3])).padStart(2, "0");
  const hour = String(Number(match[4])).padStart(2, "0");
  const minute = String(Number(match[5])).padStart(2, "0");

  const dateText = `${year}-${month}-${day}`;
  const timeText = `${hour}:${minute}`;

  return {
    order_time: jstToUtcIso(dateText, timeText),
    order_date_jst: dateText,
    order_time_jst: timeText,
    order_datetime_jst: `${dateText} ${timeText}:00`,
  };
}

async function selectTodayFilter(page: Page) {
  console.log("📅 Selecting 今日...");

  try {
    await page.getByText("注文日").first().click({ timeout: 10000 });
    await page.waitForTimeout(1000);

    await page.getByText("今日").first().click({ timeout: 10000 });
    await page.waitForTimeout(5000);

    console.log("✅ Today filter selected");
  } catch {
    console.log("⚠️ Filter not found, continuing...");
  }
}

async function parseCurrentPage(page: Page) {
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();

  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const orders: any[] = [];

  for (let i = 0; i < lines.length; i++) {
    const orderId = lines[i];

    if (!/^[0-9A-Z]{6}$/.test(orderId)) continue;

    const dateTimeText = `${lines[i - 3] || ""} ${lines[i - 2] || ""}`.trim();
    const itemName = lines[i + 1] || "";
    const priceText = lines[i + 2] || "";

    const total = parseInt(priceText.replace(/[^\d]/g, ""), 10) || 0;
    if (total <= 0) continue;

    const jst = parseRocketVisibleDateTime(dateTimeText);

    orders.push({
      order_id: orderId,
      order_time: jst.order_time,
      order_date_jst: jst.order_date_jst,
      order_time_jst: jst.order_time_jst,
      order_datetime_jst: jst.order_datetime_jst,
      scraped_at: new Date().toISOString(),
      total,
      items: itemName ? [itemName] : [],
      raw_data: {
        dateTimeText,
        itemName,
        priceText,
      },
    });

    console.log(`✔ ${orderId} ¥${total} → ${jst.order_datetime_jst}`);
  }

  return orders;
}

async function scrapeOrders(page: Page) {
  const all: any[] = [];

  for (const pageNum of ["1", "2", "3", "4", "5"]) {
    const btn = page
      .locator("button")
      .filter({ hasText: new RegExp(`^${pageNum}$`) })
      .first();

    if ((await btn.count()) > 0) {
      await btn.click();
      await page.waitForTimeout(3000);
    }

    const orders = await parseCurrentPage(page);
    all.push(...orders);
  }

  return Array.from(new Map(all.map(o => [o.order_id, o])).values());
}

async function saveToSupabase(orders: any[]) {
  const supabase = getSupabase();

  for (const o of orders) {
    const { error } = await supabase
      .from("delivery_orders")
      .upsert(
        {
          platform: "rocket",
          order_id: o.order_id,
          order_time: o.order_time,
          order_date_jst: o.order_date_jst,
          order_time_jst: o.order_time_jst,
          order_datetime_jst: o.order_datetime_jst,
          total: o.total,
          items: o.items,
          raw_data: o.raw_data,
          scraped_at: o.scraped_at,
        },
        { onConflict: "platform,order_id" }
      );

    if (error) {
      console.error("❌ Supabase error:", error);
    } else {
      console.log("💾 Saved:", o.order_id);
    }
  }
}

async function main() {
  console.log("🚀 Rocket Sync Start");

  ensureDirectories();

  let context: BrowserContext | null = null;

  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: "chrome",
      headless: false,
      timezoneId: "Asia/Tokyo",
      locale: "ja-JP",
      viewport: { width: 1440, height: 900 },
    });

    const page = context.pages()[0] || await context.newPage();

    await page.goto(OPEN_ORDERS_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    await page.waitForTimeout(8000);

    if ((await page.content()).includes("Access Denied")) {
      await saveScreenshot(page, "blocked");
      throw new Error("Access denied");
    }

    await selectTodayFilter(page);

    const orders = await scrapeOrders(page);

    console.log("TOTAL:", orders.length);

    if (orders.length) {
      await saveToSupabase(orders);
    }

    console.log("DONE");
  } catch (e) {
    console.error("FAILED:", e);
    process.exitCode = 1;
  } finally {
    await context?.close();
  }
}

main().catch(console.error);