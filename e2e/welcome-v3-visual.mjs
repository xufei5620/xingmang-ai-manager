import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import fs from 'node:fs/promises'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'artifacts', 'welcome-v3-visual')
await fs.mkdir(output, { recursive: true })
const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
await server.listen()
const address = server.httpServer.address()
const browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
const results = []
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  for (const theme of ['light', 'dark']) {
    await page.goto(`http://127.0.0.1:${address.port}/e2e/primary-views-fixture.html?scenario=welcome&theme=${theme}`)
    await page.locator('.welcome-v3').waitFor()
    const metrics = await page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const bounds = element.getBoundingClientRect()
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      }
      const rootStyle = getComputedStyle(document.documentElement)
      const logo = rect('.welcome-hero-brandline')
      const symbol = rect('.welcome-hero-brand-symbol')
      const wordmark = rect('.welcome-hero-brand-wordmark')
      const hero = rect('.welcome-hero')
      const visual = rect('.welcome-hero-visual')
      const copy = rect('.welcome-hero-copy')
      const preview = rect('.welcome-preview-workbench')
      const ringOne = rect('.welcome-orbit-ring-one')
      const ringTwo = rect('.welcome-orbit-ring-two')
      const core = rect('.welcome-orbit-core')
      const cards = [...document.querySelectorAll('.welcome-card, .welcome-support-card')].map((element) => {
        const bounds = element.getBoundingClientRect()
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      })
      return {
        width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
        theme: document.documentElement.dataset.theme, skin: document.documentElement.dataset.skin, logo, symbol, wordmark, hero, copy, visual, preview, ringOne, ringTwo, core,
        bottomCards: document.querySelectorAll('.welcome-cards3 > .welcome-card').length,
        support: Boolean(document.querySelector('.welcome-support-card')),
        background: rootStyle.getPropertyValue('--bg').trim(),
      }
    })
    assert.equal(metrics.theme, theme)
    assert.ok(metrics.logo && Math.abs(metrics.logo.height - 128) <= 1, `${theme}: brandline height must be 128`)
    assert.ok(metrics.symbol && Math.abs(metrics.symbol.height - 128) <= 1, `${theme}: symbol height must be 128`)
    assert.ok(metrics.wordmark && metrics.wordmark.width > 170, `${theme}: wordmark is missing or too small`)
    assert.ok(metrics.hero && metrics.hero.width >= 1080, `${theme}: hero columns are too narrow`)
    assert.ok(metrics.preview && Math.abs(metrics.preview.height - 330) <= 2, `${theme}: workbench preview height`)
    assert.ok(metrics.preview && metrics.preview.width >= 520, `${theme}: workbench preview width ${JSON.stringify(metrics.preview)}`)
    assert.ok(metrics.ringOne && Math.abs(metrics.ringOne.width - 220) <= 3, `${theme}: inner orbit size ${JSON.stringify(metrics.ringOne)}`)
    assert.ok(metrics.ringTwo && Math.abs(metrics.ringTwo.width - 340) <= 3, `${theme}: outer orbit size ${JSON.stringify(metrics.ringTwo)}`)
    assert.ok(metrics.core && Math.abs(metrics.core.width - 150) <= 2, `${theme}: orbit core size`)
    assert.equal(metrics.bottomCards, 4)
    assert.equal(metrics.support, true)
    assert.ok(metrics.scrollWidth <= metrics.width + 1, `${theme}: horizontal overflow`)
    assert.ok(metrics.scrollHeight <= metrics.height + 1, `${theme}: vertical overflow`)
    const screenshot = path.join(output, `${theme}-1280x820.png`)
    await page.screenshot({ path: screenshot, fullPage: true })
    results.push({ theme, metrics, screenshot })
  }
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output, 'result.json'), `${JSON.stringify({ passed: true, results }, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify({ passed: true, screenshots: results.map((entry) => entry.screenshot), result: path.join(output, 'result.json') }))
} finally {
  await browser.close()
  await server.close()
}
