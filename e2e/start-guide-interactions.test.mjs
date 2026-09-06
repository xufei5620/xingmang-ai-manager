import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(projectRoot, '.project-surgeon/audits/20260906-ui-implementation/start-guide')
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
async function openFixture(query = '', viewport = { width: 1280, height: 820 }) {
  const page = await browser.newPage({ viewport })
  await page.goto(`${baseUrl}/e2e/start-guide-fixture.html?${query}`)
  await page.getByTestId('start-guide').waitFor()
  return page
}
async function choose(page, route) {
  await page.getByTestId(`guide-route-${route}`).check()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
}
async function assertStep(page, step) { await page.waitForFunction((expected) => document.querySelector('[data-testid="start-guide"]')?.getAttribute('data-guide-step') === expected, step) }

test('six routes have no default, choosing alone does not install, and chat skips local preparation', async () => {
  const page = await openFixture()
  try {
    assert.equal(await page.getByRole('radio').count(), 6)
    assert.equal(await page.locator('input[type="radio"]:checked').count(), 0)
    assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true)
    await page.getByTestId('guide-route-claude').check()
    assert.deepEqual(await page.evaluate(() => window.startGuideHarness.calls), [])
    await choose(page, 'chat')
    await assertStep(page, 'ready')
    assert.equal(await page.getByText(/（不适用）/).count(), 2)
    assert.deepEqual(await page.evaluate(() => window.startGuideHarness.calls), [])
    await page.getByRole('button', { name: '开始聊天' }).click()
    assert.deepEqual(await page.evaluate(() => window.startGuideHarness.calls), ['complete:chat'])
  } finally { await page.close() }
})

test('Desktop needs no Node, and connection waits for returned configuration before launching the selected route', async () => {
  const page = await openFixture()
  try {
    await choose(page, 'codexDesktop')
    await assertStep(page, 'prepare')
    assert.equal(await page.getByText('Node.js 与 npm', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '安装 Codex 桌面端', exact: true }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await assertStep(page, 'connect')
    assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '检查与配置' }).click()
    assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true)
    await page.evaluate(() => window.startGuideHarness.applyConfig('relay'))
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await assertStep(page, 'ready')
    await page.getByRole('button', { name: '打开工具', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.startGuideHarness.calls), ['scan', 'install:codexDesktop', 'scan', 'configure:codexDesktop', 'complete:codexDesktop'])
  } finally { await page.close() }
})

test('failed runtime or tool probes expose only recheck; external install never fakes ready', async () => {
  for (const scenario of ['runtime-probe-failed', 'tool-probe-failed']) {
    const page = await openFixture(`scenario=${scenario}`)
    try {
      await choose(page, 'claude')
      await assertStep(page, 'prepare')
      assert.equal(await page.getByRole('button', { name: /安装 Claude|准备运行环境/ }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true)
      await page.getByRole('button', { name: '重新检测' }).click()
      assert.deepEqual(await page.evaluate(() => window.startGuideHarness.calls), ['scan', 'scan'])
    } finally { await page.close() }
  }
  const page = await openFixture('platform=linux')
  try {
    assert.equal(await page.getByRole('radio').count(), 5)
    await choose(page, 'claude')
    await page.getByRole('button', { name: '打开环境安装入口' }).click()
    await page.getByText('请完成外部运行环境安装，再重新检测。', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true)
  } finally { await page.close() }
})

test('in-flight installation blocks duplicate execution and cancellation, failure preserves route and retry', async () => {
  const page = await openFixture('scenario=slow-install')
  try {
    await choose(page, 'claude')
    const install = page.getByRole('button', { name: '安装 Claude Code', exact: true })
    await install.click()
    await install.evaluate((button) => { button.click(); button.click() })
    assert.equal(await page.getByRole('button', { name: '上一步', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '返回工作台', exact: true }).isDisabled(), true)
    assert.equal((await page.evaluate(() => window.startGuideHarness.calls)).filter((call) => call === 'install:claude').length, 1)
    await page.evaluate(() => window.startGuideHarness.release(false))
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'claude')
    await assertStep(page, 'prepare')
    await install.click()
    await page.evaluate(() => window.startGuideHarness.release(true))
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await assertStep(page, 'connect')
    await page.getByRole('button', { name: '上一步', exact: true }).click()
    await page.getByRole('button', { name: '上一步', exact: true }).click()
    assert.equal(await page.getByTestId('guide-route-claude').isChecked(), true)
    await page.getByRole('button', { name: '返回工作台', exact: true }).first().click()
    assert.equal(await page.getByTestId('cancelled').textContent(), 'true')
  } finally { await page.close() }
})

test('unknown sources cannot advance and stale configuration disables launch without clearing selection', async () => {
  const page = await openFixture('scenario=installed')
  try {
    await choose(page, 'claude')
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.evaluate(() => window.startGuideHarness.applyConfig('unknown'))
    await page.getByText('已有第三方配置', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true)
    await page.evaluate(() => window.startGuideHarness.applyConfig('official'))
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await assertStep(page, 'ready')
    await page.evaluate(() => window.startGuideHarness.applyConfig('missing'))
    await page.getByText(/状态已变化/).waitFor()
    assert.equal(await page.getByRole('button', { name: '打开工具', exact: true }).isDisabled(), true)
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'claude')
    assert.ok((await page.evaluate(() => window.startGuideHarness.calls)).every((call) => !call.startsWith('complete:')))
  } finally { await page.close() }
})

test('completion rejects duplicate clicks and a failed launch stays on ready with the selected route', async () => {
  const page = await openFixture('scenario=slow-complete&configured=true')
  try {
    await choose(page, 'codex')
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    const launch = page.getByRole('button', { name: '打开工具', exact: true })
    await launch.click()
    await launch.evaluate((button) => { button.click(); button.click() })
    assert.equal((await page.evaluate(() => window.startGuideHarness.calls)).filter((call) => call === 'complete:codex').length, 1)
    await page.evaluate(() => window.startGuideHarness.release(false))
    await page.getByRole('alert').waitFor()
    await assertStep(page, 'ready')
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'codex')
    assert.equal(await launch.isEnabled(), true)
  } finally { await page.close() }
})

test('guide remains readable across themes and target windows', async () => {
  for (const theme of ['light', 'dark']) for (const viewport of [{ width: 960, height: 560 }, { width: 1280, height: 820 }, { width: 1440, height: 900 }]) {
    const page = await openFixture(`theme=${theme}&scenario=installed&configured=true`, viewport)
    try {
      await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true)
      const footer = await page.locator('.start-guide-footer').boundingBox()
      assert.ok(footer && footer.y + footer.height <= viewport.height + 1, `footer must stay reachable at ${viewport.width}x${viewport.height}`)
      await page.screenshot({ path: path.join(artifacts, `choose-${theme}-${viewport.width}.png`), fullPage: true })
      await choose(page, 'claude')
      await page.getByRole('button', { name: '下一步', exact: true }).click()
      await page.screenshot({ path: path.join(artifacts, `connect-${theme}-${viewport.width}.png`), fullPage: true })
    } finally { await page.close() }
  }
})
