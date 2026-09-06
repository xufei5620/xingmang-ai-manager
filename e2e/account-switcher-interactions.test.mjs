import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(projectRoot, '.project-surgeon/audits/20260906-ui-implementation/account-switcher')
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
async function openFixture(query = '', viewport = { width: 960, height: 720 }) {
  const page = await browser.newPage({ viewport })
  await page.goto(`${baseUrl}/e2e/account-switcher-fixture.html?${query}`)
  await page.locator('#open-switcher').click()
  await page.getByRole('dialog').waitFor()
  if (!query.includes('encryption-fails')) await page.locator('[data-account-id="account-a"]').waitFor()
  return page
}
const targetSwitch = (page) => page.locator('[data-account-id="account-b"]').getByRole('button', { name: '切换', exact: true })

test('shows the current account without removal and never auto-selects tools or switches other sites', async () => {
  const page = await openFixture()
  try {
    assert.equal(await page.locator('[data-account-id="account-a"]').getByText('当前账号', { exact: true }).count(), 1)
    assert.equal(await page.locator('[data-account-id="account-a"]').getByRole('button').count(), 0)
    assert.equal(await page.locator('[data-account-id="account-c"]').getByText('其他站点', { exact: true }).count(), 1)
    assert.equal(await page.locator('[data-account-id="account-c"]').getByRole('button', { name: '切换', exact: true }).count(), 0)
    assert.equal(await page.locator('input:checked').count(), 0)
    assert.equal(await page.getByTestId('account-sync-claude').isDisabled(), true)
    assert.equal(await page.getByTestId('account-sync-gemini').isDisabled(), true)
    assert.deepEqual(await page.evaluate(() => window.accountSwitcherHarness.switchCalls), [])
    await targetSwitch(page).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.accountSwitcherHarness.switchCalls), [{ id: 'account-b', providers: [] }])
    assert.equal(await page.evaluate(() => window.accountSwitcherHarness.activeId), 2)
    assert.equal(await page.locator('#open-switcher').evaluate((button) => button === document.activeElement), true)
  } finally { await page.close() }
})

test('switch failure preserves A, the saved list and explicit tool choices for retry', async () => {
  const page = await openFixture('scenario=switch-fails-once')
  try {
    await page.getByTestId('account-sync-codex').check()
    await targetSwitch(page).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.evaluate(() => window.accountSwitcherHarness.activeId), 1)
    assert.equal(await page.locator('[data-account-id]').count(), 3)
    assert.equal(await page.getByTestId('account-sync-codex').isChecked(), true)
    await targetSwitch(page).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.accountSwitcherHarness.switchCalls), [{ id: 'account-b', providers: ['codex'] }, { id: 'account-b', providers: ['codex'] }])
  } finally { await page.close() }
})

test('filters a previously selected tool when its source becomes ineligible', async () => {
  const page = await openFixture()
  try {
    await page.getByTestId('account-sync-codex').check()
    await page.evaluate(() => window.accountSwitcherHarness.disallowCodex())
    await page.waitForFunction(() => document.querySelector('[data-testid="account-sync-codex"]')?.disabled === true)
    assert.equal(await page.getByTestId('account-sync-codex').isDisabled(), true)
    assert.equal(await page.getByTestId('account-sync-codex').isChecked(), false)
    await targetSwitch(page).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.accountSwitcherHarness.switchCalls), [{ id: 'account-b', providers: [] }])
  } finally { await page.close() }
})

test('in-flight switch rejects duplicate clicks, close and add-account actions', async () => {
  const page = await openFixture('scenario=slow-switch')
  try {
    const button = targetSwitch(page)
    await button.click()
    await button.evaluate((element) => { element.click(); element.click() })
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog').isVisible(), true)
    assert.equal(await page.getByRole('button', { name: '关闭账号切换', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '添加账号', exact: true }).isDisabled(), true)
    assert.equal((await page.evaluate(() => window.accountSwitcherHarness.switchCalls)).length, 1)
    await page.evaluate(() => window.accountSwitcherHarness.releaseSwitch(false))
    await page.getByRole('alert').waitFor()
    assert.equal(await page.evaluate(() => window.accountSwitcherHarness.activeId), 1)
    assert.equal(await targetSwitch(page).isEnabled(), true)
  } finally { await page.close() }
})

test('removal requires confirmation, Esc preserves the account and selected tools, and failed deletion stays recoverable', async () => {
  const page = await openFixture('scenario=remove-fails-once')
  try {
    await page.getByTestId('account-sync-grok').check()
    await page.getByRole('button', { name: '移除 目标账号 B', exact: true }).click()
    await page.getByRole('heading', { name: '移除已保存账号' }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.accountSwitcherHarness.removeCalls), [])
    assert.equal(await page.getByRole('button', { name: '保留账号', exact: true }).evaluate((button) => button === document.activeElement), true)
    await page.keyboard.press('Escape')
    await page.getByRole('heading', { name: '切换账号', exact: true }).waitFor()
    assert.equal(await page.getByTestId('account-sync-grok').isChecked(), true)
    await page.getByRole('button', { name: '移除 目标账号 B', exact: true }).click()
    await page.getByRole('button', { name: '确认移除', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('heading', { name: '移除已保存账号' }).isVisible(), true)
    await page.getByRole('button', { name: '确认移除', exact: true }).click()
    await page.getByRole('heading', { name: '切换账号', exact: true }).waitFor()
    assert.equal(await page.locator('[data-account-id="account-b"]').count(), 0)
    assert.equal(await page.locator('[data-account-id="account-a"]').count(), 1)
    assert.equal(await page.evaluate(() => window.accountSwitcherHarness.activeId), 1)
  } finally { await page.close() }
})

test('encryption and reload failures stay distinct from an empty list; adding an account never signs out A', async () => {
  const page = await openFixture('scenario=encryption-fails')
  try {
    await page.getByRole('alert').waitFor()
    assert.match(await page.getByRole('alert').innerText(), /系统加密服务不可用/)
    assert.equal(await page.getByText('还没有已保存账号', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '添加账号', exact: true }).click()
    assert.equal(await page.evaluate(() => window.accountSwitcherHarness.activeId), 1)
    assert.equal(await page.evaluate(() => window.accountSwitcherHarness.addCalls), 1)
    await page.evaluate(() => { window.accountSwitcherHarness.loadFailure = '' })
    await page.getByRole('button', { name: '重试读取', exact: true }).click()
    await page.locator('[data-account-id="account-a"]').waitFor()
    await page.evaluate(() => { window.accountSwitcherHarness.loadFailure = '已保存账号无法读取' })
    await page.getByRole('button', { name: '重新读取已保存账号', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator('[data-account-id]').count(), 3)
  } finally { await page.close() }
})

test('account lists and removal confirmation fit the desktop and narrow viewports in both themes', async () => {
  for (const theme of ['light', 'dark']) for (const viewport of [{ width: 960, height: 560 }, { width: 1280, height: 820 }, { width: 375, height: 812 }]) {
    const page = await openFixture(`theme=${theme}&scenario=long-name`, viewport)
    try {
      const bounds = await page.getByRole('dialog').boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height)
      assert.equal(await page.getByRole('dialog').evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth), true)
      await page.screenshot({ path: path.join(artifacts, `list-${theme}-${viewport.width}.png`) })
      await page.locator('[data-account-id="account-b"]').getByRole('button', { name: /^移除/ }).click()
      await page.getByRole('heading', { name: '移除已保存账号' }).waitFor()
      await page.screenshot({ path: path.join(artifacts, `remove-${theme}-${viewport.width}.png`) })
    } finally { await page.close() }
  }
})
