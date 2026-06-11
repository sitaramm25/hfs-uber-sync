/**
 * Uber Eats Manager Sync Script
 * Correct JST → UTC save for Supabase timestamptz
 */

import dotenv from 'dotenv'
dotenv.config()

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import ws from 'ws'
import * as fs from 'fs'
import * as path from 'path'

const AUTH_FILE = 'playwright/.auth/user.json'
const SCREENSHOTS_DIR = 'screenshots'
const OPEN_ORDERS_URL =
  'https://merchants.ubereats.com/manager/orders?dateRange=today'

function sleep(ms: number) {
  return new Promise(res => setTimeout(res, ms))
}

function validateStorageState(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error('Missing auth file - run login first')
  }

  const raw = fs.readFileSync(filePath, 'utf8')
  JSON.parse(raw)

  if (!raw.includes('"cookies"') || !raw.includes('"origins"')) {
    throw new Error('Invalid storageState format')
  }

  console.log('✅ Auth file valid')
}

function ensureDirectories() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })
}

async function saveScreenshot(page: Page, name: string) {
  const file = path.join(SCREENSHOTS_DIR, `${name}-${Date.now()}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log('📸 Saved:', file)
}

function parsePrice(str: string | null): number {
  if (!str) return 0
  const n = parseFloat(str.replace(/[¥￥,\s]/g, ''))
  return isNaN(n) ? 0 : n
}

function jstToUtcIso(dateText: string, timeText: string) {
  return new Date(`${dateText}T${timeText}:00+09:00`).toISOString()
}

function parseUberJstDateTime(orderDate: string, orderClock: string) {
  let date = orderDate.trim().replace(/\//g, '-').replace(/\./g, '-')
  let time = orderClock.trim()

  const [y, m, d] = date.split('-')
  date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`

  const [h, min] = time.split(':')
  time = `${h.padStart(2, '0')}:${min}`

  return {
    order_time: jstToUtcIso(date, time),
    order_date_jst: date,
    order_time_jst: time,
    order_datetime_jst: `${date} ${time}:00`,
  }
}

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    throw new Error('Missing Supabase env vars')
  }

  return createClient(url, key, {
    realtime: { transport: ws },
  })
}

async function scrapeOrders(page: Page) {
  console.log('📦 Scraping orders...')

  await page.waitForTimeout(10000)

  const bodyText = await page.locator('body').innerText()

  if (bodyText.includes('No orders found')) {
    console.log('No Uber orders today')
    return []
  }

  const rows = await page.locator('table tbody tr').all()
  console.log('Rows found:', rows.length)

  const orders: any[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    try {
      const cells = await row.locator('td').allTextContents()
      const cleaned = cells.map(c => c.trim()).filter(Boolean)

      if (cleaned.length === 0) continue

      const fixed: string[] = []

      for (let i = 0; i < cleaned.length; i++) {
        if (cleaned[i] === cleaned[i + 1]) {
          fixed.push(cleaned[i])
          i++
        } else {
          fixed.push(cleaned[i])
        }
      }

      console.log('ROW FIXED:', fixed)

      const orderId = fixed[0]
      if (!orderId || seen.has(orderId)) continue
      seen.add(orderId)

      const orderDate = fixed.find(v => /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(v))
      const orderClock = fixed.find(v => /^\d{1,2}:\d{2}$/.test(v))
      const totalText = fixed.find(v => v.includes('¥') || v.includes('￥')) || '0'

      if (!orderDate || !orderClock) {
        console.log('⚠️ Missing date/time:', fixed)
        continue
      }

      const total = parsePrice(totalText)
      if (total <= 0) continue

      const jstTime = parseUberJstDateTime(orderDate, orderClock)

      orders.push({
        order_id: orderId,
        order_time: jstTime.order_time,
        order_date_jst: jstTime.order_date_jst,
        order_time_jst: jstTime.order_time_jst,
        order_datetime_jst: jstTime.order_datetime_jst,
        scraped_at: new Date().toISOString(),
        customer_name: fixed[4] || null,
        total,
        items: null,
        raw_data: {
          row_original: cleaned,
          row_fixed: fixed,
          order_date_jst: jstTime.order_date_jst,
          order_time_jst: jstTime.order_time_jst,
          order_datetime_jst: jstTime.order_datetime_jst,
        },
      })

      console.log(
        `✔ Parsed ${orderId} JST ${jstTime.order_datetime_jst} → UTC ${jstTime.order_time} ¥${total}`
      )
    } catch (e) {
      console.error('Row error:', e)
    }
  }

  return orders
}

async function saveToSupabase(orders: any[]) {
  const supabase = getSupabase()

  for (const o of orders) {
    const { error } = await supabase.from('delivery_orders').upsert(
      {
        platform: 'uber',
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
      {
        onConflict: 'platform,order_id',
      }
    )

    if (error) {
      console.error('❌ Failed:', o.order_id, error.message)
    } else {
      console.log('💾 Saved/Updated:', o.order_id)
    }
  }
}

async function main() {
  console.log('====================')
  console.log('UBER SYNC JST → UTC FIXED')
  console.log('====================')

  ensureDirectories()
  validateStorageState(AUTH_FILE)

  let browser: Browser | null = null
  let context: BrowserContext | null = null

  try {
    browser = await chromium.launch({ headless: true })

    context = await browser.newContext({
      storageState: AUTH_FILE,
      timezoneId: 'Asia/Tokyo',
      locale: 'ja-JP',
    })

    const page = await context.newPage()

    console.log('🌐 Opening Uber...')

    await page.goto(OPEN_ORDERS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    })

    await page.waitForTimeout(10000)

    const url = page.url()
    console.log('URL:', url)

    if (url.includes('auth') || url.includes('login')) {
      await saveScreenshot(page, 'login-expired')
      throw new Error('Session expired - re-login needed')
    }

    await page.mouse.wheel(0, 5000)
    await sleep(3000)

    await saveScreenshot(page, 'orders')

    const orders = await scrapeOrders(page)

    console.log('Total:', orders.length)

    if (orders.length > 0) {
      await saveToSupabase(orders)
    } else {
      console.log('No orders found')
    }

    console.log('DONE')
  } catch (e) {
    console.error('SYNC FAILED:', e)
    process.exitCode = 1
  } finally {
    await context?.close()
    await browser?.close()
  }
}

main()