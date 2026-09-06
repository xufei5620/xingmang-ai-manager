import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(projectRoot, '.project-surgeon/audits/20260906-ui-implementation/primary-views')
let server
let browser
let baseUrl

before(async () => {
  server = await createServer({ configFile: path.join(projectRoot, 'vite.config.ts'), root: projectRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  await fs.mkdir(artifacts, { recursive: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function openFixture(scenario, viewport = { width: 1280, height: 820 }, theme = 'dark') {
  const page = await browser.newPage({ viewport })
  await page.goto(`${baseUrl}/e2e/primary-views-fixture.html?scenario=${scenario}&theme=${theme}`)
  await page.locator(scenario === 'welcome' ? '.welcome-v3' : '.dashboard-v3').waitFor()
  return page
}

test('welcome keeps authentication, guide, support and legal routes, and stops every decorative animation', async () => {
  const page = await openFixture('welcome')
  try {
    await page.getByRole('button', { name: '已有账号，登录' }).click()
    await page.getByRole('button', { name: '免费注册' }).click()
    await page.getByRole('button', { name: '先看看使用步骤' }).click()
    await page.getByRole('button', { name: '帮助与客服' }).click()
    assert.deepEqual(await page.evaluate(() => window.primaryViewActions), ['login', 'register', 'guide', 'support'])
    await page.getByLabel('减少动画').check()
    assert.equal(await page.locator('.welcome-v3').getAttribute('data-motion-paused'), 'true')
    assert.ok((await page.locator('.welcome-orbit,.welcome-node').evaluateAll((elements) => elements.map((element) => getComputedStyle(element).animationPlayState))).every((state) => state === 'paused'))
    await page.getByRole('button', { name: '用户协议', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('button', { name: '知道了' }).click()
    await page.getByRole('button', { name: '免费注册' }).waitFor()
  } finally { await page.close() }
})

test('tools preserve configure, launch, update and account actions; missing runtime does not block Desktop', async () => {
  const page = await openFixture('installed')
  try {
    assert.equal(await page.getByRole('columnheader').count(), 6)
    assert.equal(await page.locator('[data-provider-id]').count(), 5)
    await page.locator('[data-provider-id="claude"]').getByRole('button', { name: '打开', exact: true }).click()
    await page.getByRole('button', { name: '配置 Claude Code', exact: true }).click()
    await page.getByRole('button', { name: '更新 Claude Code', exact: true }).click()
    await page.getByRole('button', { name: '我的账号', exact: true }).click()
    const history = page.getByRole('button', { name: /查看记录/ })
    await history.evaluate((element) => element.click())
    assert.deepEqual(await page.evaluate(() => window.primaryViewActions), ['launch:claude', 'configure:claude', 'install:claude', 'account', 'history'])
    await page.goto(`${baseUrl}/e2e/primary-views-fixture.html?scenario=missing`)
    await page.locator('[data-provider-id="codex-desktop"]').getByRole('button').evaluate((element) => element.click())
    await page.locator('[data-provider-id="claude"]').getByRole('button', { name: '准备环境' }).evaluate((element) => element.click())
    assert.deepEqual(await page.evaluate(() => window.primaryViewActions), ['install:desktop', 'node'])
  } finally { await page.close() }
})

test('official and unknown sources stay distinct and detection failure exposes retry', async () => {
  const page = await openFixture('official')
  try {
    assert.match(await page.locator('[data-provider-id="codex"]').innerText(), /ChatGPT 账号/)
    assert.match(await page.locator('[data-provider-id="codex"]').innerText(), /套餐 Pro/)
    assert.doesNotMatch(await page.locator('[data-provider-id="claude"]').innerText(), /已登录/)
    await page.locator('[data-provider-id="codex"]').getByRole('button', { name: '刷新额度', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.primaryViewActions), ['official-usage'])
    await page.goto(`${baseUrl}/e2e/primary-views-fixture.html?scenario=third-party`)
    await page.locator('[data-provider-id="claude"]').getByRole('button', { name: '检查配置' }).click()
    assert.deepEqual(await page.evaluate(() => window.primaryViewActions), ['configure:claude'])
    await page.goto(`${baseUrl}/e2e/primary-views-fixture.html?scenario=failed`)
    await page.locator('[data-provider-id="grok"]').getByRole('button', { name: '重试' }).evaluate((element) => element.click())
    assert.deepEqual(await page.evaluate(() => window.primaryViewActions), ['scan'])
  } finally { await page.close() }
})

test('primary views render branded assets and nonblank stars without document overflow across window sizes', async () => {
  for (const theme of ['light', 'dark']) for (const viewport of [{ width: 960, height: 560 }, { width: 1280, height: 820 }, { width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    for (const scenario of ['welcome', 'official']) {
      const page = await openFixture(scenario, viewport, theme)
      try {
        await page.evaluate(() => document.fonts.ready)
        await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
        const geometry = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }))
        assert.ok(geometry.content <= geometry.width + 1, `${scenario} ${theme} ${viewport.width}: document overflow ${JSON.stringify(geometry)}`)
        if (scenario === 'welcome') {
          const orbitExpectedVisible = viewport.width >= 1100
          assert.equal(await page.locator('.welcome-hero-visual').isVisible(), orbitExpectedVisible, `star orbit visibility must follow prototype breakpoint at ${viewport.width}`)
          const pixels = await page.locator('canvas').evaluate((canvas) => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data].filter((value, index) => index % 4 === 3 && value > 0).length)
          assert.ok(pixels > 50, `nonblank starfield: ${pixels}`)
          const overlap = await page.evaluate(() => {
            const copy = document.querySelector('.welcome-hero-copy').getBoundingClientRect()
            return [...document.querySelectorAll('.welcome-node')].some((node) => { const rect = node.getBoundingClientRect(); return rect.left < copy.right && rect.right > copy.left && rect.top < copy.bottom && rect.bottom > copy.top })
          })
          assert.equal(overlap, false, `welcome stars overlap text at ${viewport.width}`)
        }
        await page.screenshot({ path: path.join(artifacts, `${scenario}-${theme}-${viewport.width}.png`), fullPage: true })
      } finally { await page.close() }
    }
  }
})
