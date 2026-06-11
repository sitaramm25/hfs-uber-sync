/**
 * Rocket Now Manager Sync Script
 * Persistent Chrome Profile + Correct JST → UTC save
 */

import dotenv from 'dotenv'
dotenv.config()

import { chromium, type BrowserContext, type Page } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import ws from 'ws'
import * as fs from 'fs'
import * as path from 'path'

const SCREENSHOTS_DIR = 'screenshots'
const PROFILE_DIR = './rocket-browser-profile'
const OPEN_ORDERS_URL = 'https://store.rocketnow.co.jp/merchant/management/orders'

function ensureDirectories() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true })
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
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

async function saveScreenshot(page: Page, name: string) {
  const file = path.join(SCREENSHOTS_DIR, `${name}-${Date.now()}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log('📸 Saved:', file)
}

function jstToUtcIso(dateText: string, timeText: string) {
  return new Date(`${dateText}T${timeText}:00+09:00`).toISOString()
}

function parseRocketVisibleDateTime(text: string) {
  const match = text.match(/(\d{2})\.(\d{2})\.(\d{2})\s+(\d{1,2}):(\d{2})/)

  if (!match) {
    const now = new Date()
    return {
      order_time: now.toISOString(),
      order_date_jst: null,
      order_time_jst: null,
      order_datetime_jst: null,
    }
  }

  const year = 2000 + Number(match[1])
  const month = String(Number(match[2])).padStart(2, '0')
  const day = String(Number(match[3])).padStart(2, '0')
  const hour = String(Number(match[4])).padStart(2, '0')
  const minute = String(Number(match[5])).padStart(2, '0')

  const dateText = `${year}-${month}-${day}`
  const timeText = `${hour}:${minute}`

  return {
    order_time: jstToUtcIso(dateText, timeText),
    order_date_jst: dateText,
    order_time_jst: timeText,
    order_datetime_jst: `${dateText} ${timeText}:00`,
  }
}

async function selectTodayFilter(page: Page) {
  console.log('📅 Selecting 注文日 → 今日...')

  try {
    await page.getByText('注文日').first().click({ timeout: 10000 })
    await page.waitForTimeout(1000)

    await page.getByText('今日').first().click({ timeout: 10000 })
    await page.waitForTimeout(5000)

    console.log('✅ Today filter selected')
  } catch {
    console.log('⚠️ Could not click 今日 filter, continuing...')
  }
}

async function parseCurrentPage(page: Page) {
  await page.waitForTimeout(3000)

  const bodyText = await page.locator('body').innerText()

  const lines = bodyText
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

  const orders: any[] = []

  for (let i = 0; i < lines.length; i++) {
    const orderId = lines[i]

    if (!/^[0-9A-Z]{6}$/.test(orderId)) continue

    const dateTimeText = `${lines[i - 3] || ''} ${lines[i - 2] || ''}`.trim()
    const storeName = lines[i - 1] || ''
    const itemName = lines[i + 1] || ''
    const priceText = lines[i + 2] || ''

    const total = parseInt(priceText.replace(/[^\d]/g, ''), 10) || 0
    if (total <= 0) continue

    const jst = parseRocketVisibleDateTime(dateTimeText)

    orders.push({
      order_id: orderId,
      order_time: jst.order_time,
      order_date_jst: jst.order_date_jst,
      order_time_jst: jst.order_time_jst,
      order_datetime_jst: jst.order_datetime_jst,
      scraped_at: new Date().toISOString(),
      customer_name: null,
      total,
      items: itemName ? [itemName] : [],
      raw_data: {
        dateTimeText,
        storeName,
        itemName,
        priceText,
      },
    })

    console.log(`✔ Parsed ${orderId} ${jst.order_datetime_jst} → ${jst.order_time} ¥${total}`)
  }

  return orders
}

async function scrapeOrders(page: Page) {
  console.log('📦 Scraping Rocket orders...')

  const allOrders: any[] = []

  for (const pageNum of ['1', '2', '3', '4', '5']) {
    console.log(`📄 Opening page ${pageNum}`)

    const pageButton = page
      .locator('button')
      .filter({ hasText: new RegExp(`^${pageNum}$`) })
      .first()

    if ((await pageButton.count()) > 0) {
      await pageButton.scrollIntoViewIfNeeded()
      await pageButton.click()
      await page.waitForTimeout(3000)
    } else {
      console.log(`⚠️ Page ${pageNum} button not found`)
    }

    const orders = await parseCurrentPage(page)
    console.log(`Page ${pageNum} orders: ${orders.length}`)

    allOrders.push(...orders)
  }

  return Array.from(new Map(allOrders.map(o => [o.order_id, o])).values())
}

async function saveToSupabase(orders: any[]) {
  const supabase = getSupabase()

  for (const o of orders) {
    const { error } = await supabase.from('delivery_orders').upsert(
      {
        platform: 'rocket',
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
  console.log('Rocket Now SYNC')
  console.log('====================')

  ensureDirectories()

  let context: BrowserContext | null = null

  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      channel: 'chrome',
      headless: false,
      timezoneId: 'Asia/Tokyo',
      locale: 'ja-JP',
      viewport: {
        width: 1440,
        height: 900,
      },
      args: ['--disable-gpu', '--disable-dev-shm-usage', '--no-sandbox'],
    })

    const page = context.pages()[0] || await context.newPage()

    console.log('🌐 Opening Rocket Now...')

    await page.goto(OPEN_ORDERS_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000,
    })

    await page.waitForTimeout(10000)

    const url = page.url()
    console.log('URL:', url)

    const html = await page.content()

    if (html.includes('Access Denied')) {
      await saveScreenshot(page, 'rocket-access-denied')
      throw new Error('Rocket blocked browser session')
    }

    if (url.includes('auth') || url.includes('login')) {
      await saveScreenshot(page, 'login-expired')
      throw new Error('Session expired - run rocket-auth.ts first')
    }

    await saveScreenshot(page, 'orders-before-filter')

    await selectTodayFilter(page)

    await saveScreenshot(page, 'orders-after-today-filter')

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
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})