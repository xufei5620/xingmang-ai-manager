import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { chromium } from '@playwright/test'
import react from '@vitejs/plugin-react'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { waitForFixtureMount } from '../../../../e2e/fixture-readiness.mjs'

let server, alternateServer, origins, storeClass, root
const browsers = new Set()
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-notice-persistence-'))
  // Concurrent origins must not replace each other's optimized dependency files.
  const configuration = (name) => ({
    root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error',
    cacheDir: path.join(root, name),
    optimizeDeps: { entries: ['src/renderer-v2/testing/app.html'] },
    server: { fs: { allow: [path.resolve('.'), root] } },
  })
  const primary = await createFixtureServer(configuration('primary-vite-cache'))
  const alternate = await createFixtureServer(configuration('alternate-vite-cache'))
  server = primary.server
  alternateServer = alternate.server
  origins = { primary: primary.origin, alternate: alternate.origin }
  storeClass = (await server.ssrLoadModule('/electron/announcement-read-store.ts')).AnnouncementReadStore
})
after(async () => {
  for (const browser of browsers) await browser.close()
  await alternateServer?.close()
  await server?.close()
  // Only this test's mkdtemp directory is removed.
  if (root) await fs.rm(root, { recursive: true, force: true })
})

async function open(store, { alternate = false, query = 'noticeCollection=1', beforeNavigate, sync } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  browsers.add(browser)
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  const origin = alternate ? origins.alternate : origins.primary
  const loadErrors = []
  const recordError = (message) => { if (loadErrors.length < 20) loadErrors.push(message) }
  page.on('pageerror', (error) => recordError(error.message))
  page.on('requestfailed', (request) => recordError(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`))
  page.on('response', (response) => { if (response.status() >= 400) recordError(`${new URL(response.url()).pathname}: HTTP ${response.status()}`) })
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.exposeFunction('fixtureNoticeStore', sync ?? ((scope, ids) => store.sync(scope, ids)))
  if (beforeNavigate) await beforeNavigate(page)
  await page.goto(`${origin}/src/renderer-v2/testing/app.html?${query}`)
  // Each case launches a browser of its own, so every open here is a cold one.
  // Without this the click below spends its 30s action default on the mount and
  // then blames the fixture for not loading, which is the wrong report.
  await waitForFixtureMount(page, { what: 'the announcement fixture' })
  try { await page.getByTestId('announcement-open').click() }
  catch (error) { throw new Error(`Announcement fixture did not load: ${JSON.stringify(loadErrors)}`, { cause: error }) }
  const dialog = page.getByRole('dialog', { name: '公告', exact: true })
  const list = dialog.getByTestId('announcement-list')
  return { browser, page, dialog, list }
}
// Opening the dialog and switching accounts each start a fresh read, so the
// list can render, drop back to loading and render again. Wait for the rows to
// settle on the expected states instead of reading whatever is there the
// moment the first row appears.
async function expectReadStates({ page }, expected) {
  const rows = '[data-testid="announcement-list"] .v2-announcement-read-state'
  try {
    await page.waitForFunction(([selector, want]) => JSON.stringify([...document.querySelectorAll(selector)].map((node) => node.textContent)) === JSON.stringify(want), [rows, expected])
  } catch (error) {
    assert.deepEqual(await page.locator(rows).allTextContents(), expected)
    throw error
  }
}
async function close({ browser, page }) {
  assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  assert.deepEqual(await page.evaluate(() => window.v2Test.unexpected), [])
  await browser.close()
  browsers.delete(browser)
}

test('NewAPI read state survives a browser process restart, a new host store and a different origin', async () => {
  const directory = path.join(root, 'restart')
  const first = await open(new storeClass(directory))
  await first.list.getByRole('button', { name: '图片模型上线 未读' }).click()
  await first.dialog.getByRole('status').waitFor({ state: 'hidden' })
  await first.dialog.getByRole('button', { name: '返回列表' }).click()
  await first.list.getByRole('button', { name: '图片模型上线 已读' }).waitFor()
  await close(first)

  const reopened = await open(new storeClass(directory), { alternate: true })
  await reopened.list.waitFor()
  await expectReadStates(reopened, ['已读', '未读', '未读'])
  assert.equal(await reopened.page.evaluate(() => localStorage.getItem('xingmang-v2-notice-entries:xm-account:17')), null)
  assert.equal(await reopened.page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead')), false)
  await reopened.dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await reopened.page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', {
    authenticated: true, siteId: 'solov', account: { userId: 18, username: 'other', group: 'default', role: 1, quota: 1, usedQuota: 0 },
  }))
  await reopened.page.getByTestId('announcement-open').click()
  await reopened.list.getByRole('button', { name: '图片模型上线 未读' }).waitFor()
  await expectReadStates(reopened, ['未读', '未读', '未读'])
  await close(reopened)
})

test('existing local read IDs migrate to the host and a failed browser cache cannot lose new reads', async () => {
  const directory = path.join(root, 'migration')
  const store = new storeClass(directory)
  const current = await open(store)
  await current.list.waitFor()
  const row = current.list.getByRole('button', { name: '图片模型上线 未读' })
  const id = (await row.getAttribute('data-testid')).match(/newapi-[a-f0-9]{64}/)[0]
  await current.page.evaluate((id) => {
    localStorage.setItem('xingmang-v2-notice-entries:xm-account:17', JSON.stringify([id]))
  }, id)
  await current.dialog.getByRole('button', { name: '重新读取' }).click()
  await current.list.getByRole('button', { name: '图片模型上线 已读' }).waitFor()
  assert.deepEqual(await store.sync('xm-account:17', []), [id])
  await current.page.evaluate(() => {
    Storage.prototype.setItem = () => { throw new Error('Browser storage unavailable') }
  })
  await current.list.getByRole('button', { name: '旧模型下架通知 未读' }).click()
  await current.dialog.getByRole('status').waitFor({ state: 'hidden' })
  await current.dialog.getByRole('button', { name: '返回列表' }).click()
  await current.list.getByRole('button', { name: '旧模型下架通知 已读' }).waitFor()
  await close(current)
  const reopened = await open(new storeClass(directory), { alternate: true })
  await reopened.list.waitFor()
  await expectReadStates(reopened, ['已读', '已读', '未读'])
  await close(reopened)
})

test('a failed durable write commits no marker and a successful retry survives restart', async () => {
  const directory = path.join(root, 'failure')
  const store = new storeClass(directory)
  let fail = true
  const current = await open(store, { sync: (scope, ids) => {
    if (fail && ids.length) throw new Error('本机没有保存已读状态')
    return store.sync(scope, ids)
  } })
  await current.list.getByRole('button', { name: '图片模型上线 未读' }).click()
  await current.dialog.getByRole('alert').filter({ hasText: '本机没有保存已读状态' }).waitFor()
  assert.deepEqual(await store.sync('xm-account:17', []), [])
  assert.equal(await current.page.evaluate(() => localStorage.getItem('xingmang-v2-notice-entries:xm-account:17')), null)
  fail = false
  await current.dialog.getByRole('button', { name: '重试保存已读' }).click()
  await current.dialog.getByRole('alert').waitFor({ state: 'hidden' })
  await close(current)
  const reopened = await open(new storeClass(directory))
  await reopened.list.getByRole('button', { name: '图片模型上线 已读' }).waitFor()
  await close(reopened)
})

test('the old single-notice scope migrates and remains read without renderer storage', async () => {
  const directory = path.join(root, 'legacy')
  const current = await open(new storeClass(directory), { query: '', beforeNavigate: (page) => page.addInitScript(() => {
    localStorage.setItem('xingmang-v2-notice:solov:17', 'local-notice')
  }) })
  await current.dialog.getByText('本地测试公告', { exact: true }).waitFor()
  assert.equal(await current.page.locator('.v2-unread').count(), 0)
  await close(current)
  const reopened = await open(new storeClass(directory), { alternate: true, query: '' })
  await reopened.dialog.getByText('本地测试公告', { exact: true }).waitFor()
  assert.equal(await reopened.page.locator('.v2-unread').count(), 0)
  await close(reopened)
})
