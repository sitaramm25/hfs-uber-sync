import { chromium, type Browser } from "playwright"
import { createClient } from "@supabase/supabase-js"
import fs from "fs"

const AUTH_FILE = "playwright/.auth/menu.json"

const MENU_REPORT_URL =
  "https://management.console.menu.inc/chain/orderReport/list?target_month=2026-06&shop_id=143836"

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
}

/**
 * Supabase client (Node 20 safe)
 */
const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    enabled: false
  }
})

function jstToUtcIso(dateText: string, timeText: string) {
  return new Date(`${dateText}T${timeText}:00+09:00`).toISOString()
}

function cleanText(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function parsePrice(text: string) {
  const n = text.replace(/[^\d]/g, "")
  return n ? Number(n) : 0
}

function normalizeDate(dateText: string) {
  const [y, m, d] = dateText.replace(/\//g, "-").split("-")
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`
}

function normalizeTime(timeText: string) {
  const [h, m] = timeText.split(":")
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`
}

async function main() {
  console.log("====================")
  console.log("MENU SYNC")
  console.log("====================")

  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error("Menu auth file not found. Run npm run menu:auth first.")
  }

  let browser: Browser | null = null

  try {
    browser = await chromium.launch({
      channel: "chrome",
      headless: true
    })

    const context = await browser.newContext({
      storageState: AUTH_FILE,
      timezoneId: "Asia/Tokyo",
      locale: "ja-JP",
      viewport: { width: 1440, height: 900 }
    })

    const page = await context.newPage()

    await page.goto(MENU_REPORT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    })

    await page.waitForTimeout(7000)

    const url = page.url()
    console.log("URL:", url)

    if (url.includes("login") || url.includes("signin")) {
      throw new Error("Menu session expired. Run npm run menu:auth again.")
    }

    const rows = await page.locator("table tbody tr").all()
    console.log(`Found rows: ${rows.length}`)

    const orders: any[] = []

    for (const row of rows) {
      const cells = await row.locator("td").allTextContents()
      const c = cells.map(cleanText).filter(Boolean)

      if (c.length < 4) continue

      const joined = c.join(" ")

      const orderId = c.find(x => /^[A-Z0-9]{5,10}$/.test(x))
      const dateMatch = joined.match(/20\d{2}[-/]\d{1,2}[-/]\d{1,2}/)
      const timeMatch = joined.match(/\b\d{1,2}:\d{2}\b/)
      const priceCell = c.find(
        x => /[¥￥]\s*[\d,]+/.test(x) || /^[\d,]+円?$/.test(x)
      )

      if (!orderId || !dateMatch || !timeMatch || !priceCell) continue

      const orderDate = normalizeDate(dateMatch[0])
      const orderTimeText = normalizeTime(timeMatch[0])
      const total = parsePrice(priceCell)

      if (total <= 0) continue

      const items = c.filter(
        x =>
          x !== orderId &&
          !x.includes(orderDate) &&
          !x.includes(orderTimeText) &&
          x !== priceCell
      )

      orders.push({
        platform: "menu",
        order_id: orderId,
        order_time: jstToUtcIso(orderDate, orderTimeText),
        order_date_jst: orderDate,
        order_time_jst: orderTimeText,
        order_datetime_jst: `${orderDate} ${orderTimeText}:00`,
        total,
        items,
        raw_data: { cells: c },
        scraped_at: new Date().toISOString()
      })

      console.log(
        `✔ Parsed ${orderId} JST ${orderDate} ${orderTimeText} → UTC ${jstToUtcIso(
          orderDate,
          orderTimeText
        )} ¥${total}`
      )
    }

    console.log(`Parsed orders: ${orders.length}`)

    if (orders.length > 0) {
      const { error } = await supabase
        .from("delivery_orders")
        .upsert(orders, {
          onConflict: "platform,order_id"
        })

      if (error) throw error
    }

    await context.close()
    console.log("✅ Menu sync finished")
  } finally {
    await browser?.close()
  }
}

main().catch(error => {
  console.error("❌ MENU SYNC FAILED:", error)
  process.exit(1)
})