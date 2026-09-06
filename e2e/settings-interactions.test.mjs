import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function withFixture(run) {
  const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  const address = server.httpServer.address()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 560 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await run(page, `http://127.0.0.1:${address.port}/e2e/settings-fixture.html`)
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
}

test('settings saves independent fields and rolls a failed switch back without losing a directory draft', async () => {
  await withFixture(async (page, url) => {
    await page.goto(`${url}?manual=1`)
    const motion = page.getByRole('switch', { name: '减少动画' })
    await motion.check()
    await page.getByLabel('界面大小').selectOption('110')
    await page.waitForFunction(() => window.settingsHarness.requests.length === 2)
    await page.evaluate(() => window.settingsHarness.settle(1))
    await page.locator('#settings-uiScale-feedback').getByText('已保存').waitFor()
    await page.evaluate(() => window.settingsHarness.settle(0, '设置文件被占用'))
    await page.getByRole('alert').getByText('设置文件被占用').waitFor()
    assert.equal(await motion.isChecked(), false)
    assert.equal(await page.getByLabel('界面大小').inputValue(), '110')

    await page.getByRole('button', { name: '工具', exact: true }).click()
    await page.getByLabel('默认工作目录').fill('D:\\offline\\保留草稿')
    await page.getByRole('button', { name: '保存工作目录', exact: true }).click()
    await page.waitForFunction(() => window.settingsHarness.requests.length === 3)
    await page.evaluate(() => window.settingsHarness.settle(2, '目录暂时不可用'))
    await page.getByRole('alert').getByText('目录暂时不可用').waitFor()
    await page.getByRole('button', { name: '网络', exact: true }).click()
    await page.getByRole('button', { name: '工具', exact: true }).click()
    assert.equal(await page.getByLabel('默认工作目录').inputValue(), 'D:\\offline\\保留草稿')
    assert.equal(await page.getByRole('button', { name: '保存工作目录', exact: true }).isEnabled(), true)
  })
})

test('desktop notification preference rolls back on failure and saves only its own field on retry', async () => {
  await withFixture(async (page, url) => {
    await page.goto(`${url}?manual=1`)
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '通知', exact: true }).click()
    const notifications = page.getByRole('switch', { name: '系统桌面通知', exact: true })
    assert.equal(await notifications.isChecked(), false)
    await notifications.check()
    await page.waitForFunction(() => window.settingsHarness.requests.length === 1)
    assert.deepEqual(await page.evaluate(() => window.settingsHarness.requests[0]), { version: 2, desktopNotifications: true })
    await page.evaluate(() => window.settingsHarness.settle(0, '通知偏好保存失败'))
    await page.getByRole('alert').getByText('通知偏好保存失败').waitFor()
    assert.equal(await notifications.isChecked(), false)
    assert.equal(await page.getByRole('switch', { name: '更新提醒', exact: true }).isChecked(), true)
    await notifications.check()
    await page.waitForFunction(() => window.settingsHarness.requests.length === 2)
    await page.evaluate(() => window.settingsHarness.settle(1))
    await page.locator('#settings-desktopNotifications-feedback').getByText('已保存').waitFor()
    assert.equal(await page.evaluate(() => window.settingsHarness.confirmed.desktopNotifications), true)
    await notifications.uncheck()
    await page.waitForFunction(() => window.settingsHarness.requests.length === 3)
    assert.deepEqual(await page.evaluate(() => window.settingsHarness.requests[2]), { version: 2, desktopNotifications: false })
    await page.evaluate(() => window.settingsHarness.settle(2))
    await page.locator('#settings-desktopNotifications-feedback').getByText('已保存').waitFor()
  })
})

test('an unsupported platform disables desktop notifications while preserving in-app update reminders', async () => {
  await withFixture(async (page, url) => {
    await page.goto(`${url}?unsupportedNotifications=1`)
    await page.getByRole('navigation', { name: '设置分组' }).getByRole('button', { name: '通知', exact: true }).click()
    assert.equal(await page.getByRole('switch', { name: '系统桌面通知', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('switch', { name: '更新提醒', exact: true }).isEnabled(), true)
    await page.getByText('当前系统不支持桌面通知，应用内提醒仍可用。', { exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => window.settingsHarness.requests), [])
  })
})

test('settings keeps the latest skin selected while a previous save completes and rolls back to the latest confirmed skin', async () => {
  await withFixture(async (page, url) => {
    await page.goto(`${url}?manual=1`)
    await page.getByRole('button', { name: '雾青', exact: true }).click()
    await page.getByRole('button', { name: '极光紫', exact: true }).click()
    assert.equal(await page.evaluate(() => window.settingsHarness.requests.length), 1)
    await page.evaluate(() => window.settingsHarness.settle(0))
    await page.waitForFunction(() => window.settingsHarness.requests.length === 2)
    assert.equal(await page.getByRole('button', { name: '极光紫', exact: true }).getAttribute('aria-pressed'), 'true')
    await page.evaluate(() => window.settingsHarness.settle(1, '写入失败'))
    await page.getByRole('alert').getByText('写入失败').waitFor()
    assert.equal(await page.getByRole('button', { name: '雾青', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.skin), 'mist')
  })
})

test('settings section layouts stay within compact and standard windows in both default themes', async () => {
  await withFixture(async (page, url) => {
    const output = path.join(root, '.project-surgeon', 'audits', '20260906-ui-implementation', 'settings')
    await fs.mkdir(output, { recursive: true })
    for (const theme of ['light', 'dark']) {
      for (const viewport of [{ width: 960, height: 560 }, { width: 1280, height: 820 }]) {
        await page.setViewportSize(viewport)
        await page.goto(`${url}?theme=${theme}`)
        const nav = page.getByRole('navigation', { name: '设置分组' })
        assert.equal(await nav.getByRole('button').count(), 8)
        for (const name of ['外观', '启动与关闭', '工具', '网络', '通知', '账号', '隐私与数据', '关于']) {
          await nav.getByRole('button', { name, exact: true }).click()
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
          assert.equal(overflow, false, `${name} overflow at ${viewport.width}/${theme}`)
          assert.equal(await page.locator('.settings-v3-panel').count(), 1)
        }
        await nav.getByRole('button', { name: '外观', exact: true }).click()
        assert.equal(await page.locator('.settings-v3-row').first().evaluate((element) => getComputedStyle(element).borderBottomWidth), '1px')
        await page.screenshot({ path: path.join(output, `appearance-${theme}-${viewport.width}.png`), fullPage: true })
      }
    }
  })
})
