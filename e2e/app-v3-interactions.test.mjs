import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, test } from 'node:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

let server, browser, baseUrl
before(async () => {
  server = await createServer({ root: path.resolve('.'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort())
  await page.goto(`${baseUrl}/e2e/app-v3-fixture.html?${query}`)
  return page
}
async function clean(page) {
  assert.deepEqual(await page.evaluate(() => window.appHarness.unexpected), [], 'all bridge calls must be explicitly modelled')
  assert.deepEqual(await page.evaluate(() => window.appHarness.errors), [], 'no renderer failures')
}

test('real App login leads to explicit choice and direct chat does not install any local tool', async () => {
  const page = await open()
  try {
    await page.getByRole('button', { name: '已有账号，登录' }).click()
    const login = page.getByRole('dialog', { name: '登录', exact: true })
    await login.getByLabel('用户名或邮箱').fill('fixture-user')
    await login.getByRole('textbox', { name: '密码', exact: true }).fill('fixture-password')
    await login.getByRole('checkbox', { name: /同意/ }).check()
    await login.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('heading', { name: '选择一种开始方式' }).waitFor()
    assert.equal(await page.getByRole('radio', { checked: true }).count(), 0)
    await page.getByRole('radio', { name: /直接聊天/ }).check()
    await page.getByRole('button', { name: '下一步', exact: true }).click()
    await page.getByRole('button', { name: '开始聊天', exact: true }).click()
    await page.locator('.app-shell [data-page-id="ai-chat"]').waitFor()
    assert.equal(await page.locator('.shell-topbar').count(), 1)
    assert.equal(await page.locator('.shell-statusbar').count(), 1)
    const calls = await page.evaluate(() => window.appHarness.calls)
    assert.equal(calls.includes('installCli') || calls.includes('installNodeRuntime') || calls.includes('installCodexDesktop'), false)
    await clean(page)
  } finally { await page.close() }
})

test('App settings save uses patches and failed appearance changes restore the confirmed skin', async () => {
  const page = await open('logged=true&completed=true')
  try {
    await page.locator('[data-navigation-id="settings"]').click()
    await page.getByRole('button', { name: '浅色', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    await page.getByRole('button', { name: '雾青', exact: true }).click()
    await page.waitForFunction(() => document.documentElement.dataset.skin === 'mist')
    await page.waitForFunction(() => !document.querySelector('.settings-v3-feedback.saving'))
    await page.evaluate(() => { window.appHarness.failSetting = 'uiSkin' })
    await page.getByRole('button', { name: '极光紫', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Fixture settings write failed' }).waitFor()
    await page.waitForFunction(() => document.documentElement.dataset.skin === 'mist')
    await page.evaluate(() => { window.appHarness.emit('onWindowCloseRequest', { requestId: 'close-test' }) })
    await page.waitForFunction(() => window.appHarness.closeReports.length > 0)
    assert.equal((await page.evaluate(() => window.appHarness.closeReports.at(-1))).blockingTask, false)
    await clean(page)
  } finally { await page.close() }
})

test('saved-account failures preserve App identity and successful switching does not silently rewrite tool keys', async () => {
  const page = await open('logged=true&completed=true')
  try {
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    const row = page.locator('.account-switcher-row').filter({ hasText: 'account-b' })
    await page.evaluate(() => { window.appHarness.failSwitch = true })
    await row.getByRole('button', { name: '切换', exact: true }).click()
    await page.getByText('目标登录已过期', { exact: true }).waitFor()
    assert.match(await page.locator('.sidebar').innerText(), /account-a/)
    await page.evaluate(() => { window.appHarness.failSwitch = false })
    await row.getByRole('button', { name: '切换', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.sidebar')?.textContent?.includes('account-b'))
    assert.equal(await page.locator('.account-switcher').count(), 0)
    assert.equal((await page.evaluate(() => window.appHarness.calls)).includes('configureManagedCliKeys'), false)
    await page.locator('.sidebar .account-area').click()
    await page.locator('.account-center-v3').waitFor()
    assert.equal(await page.locator('[data-account-tab]').count(), 9)
    assert.equal(await page.locator('.shell-topbar').count(), 1)
    await clean(page)
  } finally { await page.close() }
})

test('cold invitation prefills registration without submitting; payment return only queries orders', async () => {
  const invite = await open('invite=XM-7K2Q')
  try {
    const dialog = invite.getByRole('dialog', { name: '注册', exact: true })
    await dialog.waitFor()
    assert.equal(await dialog.getByLabel(/邀请码/).inputValue(), 'XM-7K2Q')
    assert.equal((await invite.evaluate(() => window.appHarness.calls)).includes('registerAccount'), false)
    await clean(invite)
  } finally { await invite.close() }
  const page = await open('logged=true&completed=true')
  try {
    await page.locator('.app-shell').waitFor()
    await page.evaluate(() => {
      window.appHarness.deepLink = { kind: 'pay', order: 'XM-unknown' }
      window.appHarness.emit('onExternalDeepLink', undefined)
    })
    await page.locator('[data-account-tab="orders"][aria-selected="true"]').waitFor()
    await page.waitForFunction(() => window.appHarness.calls.includes('getAccountTopupOrders'))
    const count = await page.evaluate(() => window.appHarness.calls.filter((name) => name === 'getAccountTopupOrders').length)
    await page.evaluate(() => {
      window.appHarness.deepLink = { kind: 'pay', order: null }
      window.appHarness.emit('onExternalDeepLink', undefined)
    })
    await page.waitForFunction((previous) => window.appHarness.calls.filter((name) => name === 'getAccountTopupOrders').length > previous, count)
    assert.equal(await page.getByText('支付已到账，账户余额已刷新', { exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})
