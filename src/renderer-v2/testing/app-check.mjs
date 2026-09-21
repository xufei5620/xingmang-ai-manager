import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import { fixtureReadyTimeoutMs, waitForFixtureMount } from '../../../e2e/fixture-readiness.mjs'

let server, browser, origin
const artifacts = path.resolve('artifacts/renderer-v2-app')
// A first commit into #root is not enough here: this fixture also installs
// host globals the cases reach for, and a test that started before they were
// there saw `window.fixtureSupportQrCode is not a function` rather than a slow
// mount. The waiting itself - and the budget it runs on - is shared with the
// other fixtures.
async function waitForFixtureReady(page, timeout = fixtureReadyTimeoutMs) {
  await waitForFixtureMount(page, {
    timeout,
    what: 'the renderer-v2 fixture',
    ready: () => typeof window.fixtureSupportQrCode === 'function'
      && Boolean(window.v2Test) && Boolean(window.xingmang)
      && (document.getElementById('root')?.childElementCount ?? 0) > 0,
  })
}

// Toasts delete themselves 2400ms after they appear (src/renderer-v2/ui/
// feedback.tsx), so a locator that only starts looking after that deadline waits
// out its whole budget on an element that is never coming back. A slow Windows
// runner hit exactly that between the save click and the toast assertion: the
// grok configuration cases timed out at 30s while their faster siblings passed
// in a couple of seconds. Record every toast as it is inserted and assert
// against the recording, which cannot expire. A toast is only ever removed a
// whole task later, so the observer callback always runs while the node is
// still in the document.
function recordToasts() {
  const log = { entries: [], consumed: 0 }
  const seen = new WeakSet()
  window.__v2Toasts = log
  function collect() {
    for (const toast of document.querySelectorAll('.xm-toasts .xm-toast')) {
      if (seen.has(toast)) continue
      seen.add(toast)
      log.entries.push({ text: toast.textContent ?? '', role: toast.getAttribute('role') ?? '' })
    }
  }
  new MutationObserver(collect).observe(document, { childList: true, subtree: true })
}

// `consumed` marks how far the recording has been read, so a second save cannot
// be satisfied by the toast the first save left behind.
async function waitForToast(page, text) {
  await page.waitForFunction((expected) => {
    const log = window.__v2Toasts
    const index = log.entries.findIndex((entry, position) => position >= log.consumed && entry.role === 'status' && entry.text === expected)
    if (index < 0) return false
    log.consumed = index + 1
    return true
  }, text)
}

async function assertNoToast(page, text) {
  const shown = await page.evaluate((expected) => window.__v2Toasts.entries.slice(window.__v2Toasts.consumed).filter((entry) => entry.text === expected).length, text)
  assert.equal(shown, 0, `不应出现「${text}」提示`)
}

before(async () => {
  await fs.mkdir(artifacts, { recursive: true })
  server = await createServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  // Pay the transform and dependency-optimisation cost once, here, instead of
  // charging it to whichever test happens to run first.
  await (await open()).close()
})
after(async () => { await browser?.close(); await server?.close() })
async function open(query = '', clock = false) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.addInitScript(recordToasts)
  // The host outlives a renderer reload and does not share the page's localStorage.
  const noticeReads = new Map()
  await page.exposeFunction('fixtureNoticeStore', (scope, ids) => {
    const next = [...new Set([...(noticeReads.get(scope) ?? []), ...ids])].slice(-200)
    noticeReads.set(scope, next)
    return next
  })
  if (clock) {
    await page.clock.install({ time: new Date('2026-09-12T04:00:00Z') })
    await page.clock.pauseAt(new Date('2026-09-12T04:00:01Z'))
  }
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/src/renderer-v2/testing/app.html?${query}`)
  await waitForFixtureReady(page)
  return page
}
async function clean(page) {
  assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  assert.deepEqual(await page.evaluate(() => window.v2Test.unexpected), [])
}

const defaultSupportUrl = 'https://work.weixin.qq.com/kfid/kfc3ac7eece5344c034'
const historicalSupportUrl = 'https://work.weixin.qq.com/kfid/kfcffe6f62fdaa0ccf4'

async function checkSupportQr(page, surface, url) {
  const expected = await page.evaluate((value) => window.fixtureSupportQrCode(value), url)
  const image = surface.getByRole('img', { name: '微信客服二维码', exact: true })
  await image.waitFor()
  await expect.poll(async () => await image.getAttribute('src') === expected, { message: '客服二维码应编码当前账号对应的同一个企微地址' }).toBe(true)
}

async function checkSupportDialog(page, url) {
  const dialog = page.getByRole('dialog', { name: '帮助与客服', exact: true })
  await dialog.waitFor()
  await checkSupportQr(page, dialog, url)
  const previousCalls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').length)
  await dialog.getByRole('button', { name: '在浏览器打开', exact: true }).click()
  await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').length > count, previousCalls)
  const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal'))
  assert.equal(calls.length, previousCalls + 1)
  assert.deepEqual(calls.at(-1).args, [url])
  return dialog
}

test('customer support uses the default QR and browser destination for signed-out sessions, including retained historical metadata', async () => {
  for (const query of ['guest=1', 'guest=1&sub2api=1']) {
    const page = await open(query)
    try {
      const welcome = page.getByTestId('welcome-support')
      await checkSupportQr(page, welcome, defaultSupportUrl)
      await page.getByTestId('welcome-help').click()
      await checkSupportDialog(page, defaultSupportUrl)
      await clean(page)
    } finally { await page.close() }
  }
})

for (const [label, query, url] of [
  ['NewAPI', '', defaultSupportUrl],
  ['Sub2API', 'sub2api=1', historicalSupportUrl],
]) test(`customer support matches the QR and browser destination for signed-in ${label}`, async () => {
  const page = await open(query)
  try {
    await page.getByTestId('shell-topbar').getByRole('button', { name: '帮助与客服', exact: true }).click()
    await checkSupportDialog(page, url)
    await clean(page)
  } finally { await page.close() }
})

test('customer support returns to the default QR and browser destination after historical account logout', async () => {
  const page = await open('sub2api=1')
  try {
    await page.getByTestId('shell-topbar').getByRole('button', { name: '帮助与客服', exact: true }).click()
    const dialog = await checkSupportDialog(page, historicalSupportUrl)
    await dialog.locator('[data-modal-close]').click()
    await page.getByRole('button', { name: '打开个人中心 fixture-user', exact: true }).click()
    await page.getByRole('button', { name: '退出当前账号', exact: true }).click()
    await page.getByRole('dialog', { name: '退出当前账号？', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByTestId('welcome-support').waitFor()
    const session = await page.evaluate(() => window.xingmang.getAccountSession())
    assert.equal(session.authenticated, false)
    assert.equal(session.account, null)
    assert.equal(session.siteId, 'solov-api')
    assert.equal(session.realmId, 'api-account')
    await checkSupportQr(page, page.getByTestId('welcome-support'), defaultSupportUrl)
    await page.getByTestId('welcome-help').click()
    await checkSupportDialog(page, defaultSupportUrl)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').map((entry) => entry.args[0])), [historicalSupportUrl, defaultSupportUrl])
    await clean(page)
  } finally { await page.close() }
})

test('v2 home places clients in installed ToolRows and saves and opens through their native contracts', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`theme=${theme}&clientModels=1`)
    try {
      await page.getByTestId('tool-row-codex').waitFor()
      assert.equal(await page.getByTestId('home-codex-models').count(), 0)
      assert.equal(await page.getByTestId('home-client-connections').count(), 0)
      await page.screenshot({ path: path.join(artifacts, `client-connections-${theme}.png`) })
      for (const tool of ['workbuddy', 'claudeDesktop', 'opencode']) {
        const row = page.getByTestId(`tool-row-${tool}`)
        await row.waitFor()
        assert.equal(await row.locator('xpath=ancestor::section[1]').getByRole('heading', { name: '你的工具', exact: true }).count(), 1)
        await page.getByTestId(`home-client-${tool}`).click()
        const dialog = page.getByTestId('external-client-dialog')
        await dialog.waitFor()
        await page.getByTestId('external-client-detect').click()
        const model = tool === 'claudeDesktop' ? 'claude-fixture' : 'deepseek-fixture'
        await page.getByTestId('external-client-model').selectOption(model)
        if (tool === 'opencode') await page.getByTestId('external-client-protocol').selectOption('chat-completions')
        await page.getByTestId('external-client-save').click()
        await page.getByTestId('external-client-result').getByText('配置已保存', { exact: true }).waitFor()
        if (tool === 'claudeDesktop') {
          await expect(page.getByTestId('external-client-result')).toContainText('configLibrary')
          await expect(dialog).not.toContainText('HKEY_CURRENT_USER')
          await expect(dialog).not.toContainText('等待导入')
          await expect(dialog).toContainText('完全退出并重新打开 Claude Desktop')
        }
        const call = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureExternalTool').at(-1))
        assert.deepEqual(call.args, [tool, { credential: { kind: 'configured', provider: tool === 'claudeDesktop' ? 'claude' : 'codex' }, model, ...(tool === 'opencode' ? { protocol: 'chat-completions' } : {}) }])
        await page.screenshot({ path: path.join(artifacts, `${tool}-config-${theme}.png`) })
        await dialog.getByRole('button', { name: '完成', exact: true }).click()
        await row.getByRole('button', { name: '打开', exact: true }).click()
        await row.getByText(/运行中/).waitFor()
        const opened = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchExternalClient').at(-1))
        assert.deepEqual(opened.args, [tool])
      }
      await page.locator('.v2-statusbar').getByText('6 个工具已装', { exact: true }).waitFor()
      await page.getByRole('heading', { name: '账户余额', exact: true }).locator('xpath=ancestor::section[1]').getByText('6 个工具已连接', { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'revealApiKey' || entry.method === 'revealAccountKey')), false)
      await clean(page)
    } finally { await page.close() }
  }
})

test('external client install shows progress and finishes at configuration without writing a key', async () => {
  const page = await open('externalInstallPending=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.waitFor()
    assert.equal(await row.locator('xpath=ancestor::section[1]').getByRole('heading', { name: '还可以装', exact: true }).count(), 1)
    await row.getByRole('button', { name: '安装', exact: true }).click()
    await row.getByText('正在下载安装包', { exact: true }).waitFor()
    assert.equal(await row.getByRole('progressbar').getAttribute('aria-valuenow'), '36')
    assert.equal(await row.getByRole('button', { name: '安装中', exact: true }).isDisabled(), true)
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await row.getByRole('button', { name: '配置', exact: true }).waitFor()
    assert.equal(await row.locator('xpath=ancestor::section[1]').getByRole('heading', { name: '你的工具', exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureExternalTool' || entry.method === 'launchExternalClient')), false)
    await clean(page)
  } finally { await page.close() }
})

test('external client install failures clear busy state and remain retryable', async () => {
  const page = await open('externalInstallFailure=1')
  try {
    const row = page.getByTestId('tool-row-opencode')
    await row.getByRole('button', { name: '安装', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '客户端安装失败，请重试' }).waitFor()
    await page.getByRole('button', { name: '返回', exact: true }).click()
    assert.equal(await row.getByRole('button', { name: '安装', exact: true }).isEnabled(), true)
    assert.equal(await row.getByRole('progressbar').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('external clients recognize complete manual configurations without claiming account ownership', async () => {
  const page = await open('externalInstalled=1&externalOther=claudeDesktop&externalLocalReady=claudeDesktop&externalConfigError=workbuddy')
  try {
    const claude = page.getByTestId('tool-row-claudeDesktop')
    await claude.getByText('已配好', { exact: true }).waitFor()
    await expect(claude).toContainText('自动获取模型')
    await expect(claude).not.toContainText('其他账号')
    await page.screenshot({ path: path.join(artifacts, 'claude-manual-configuration-ready.png') })
    await claude.getByRole('button', { name: '打开', exact: true }).click()
    await claude.getByText(/运行中/).waitFor()
    const buddy = page.getByTestId('tool-row-workbuddy')
    await buddy.getByText('当前配置读取失败，可在客户端中检查', { exact: true }).waitFor()
    await buddy.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '打开', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchExternalClient').map((entry) => entry.args[0])), ['claudeDesktop', 'workbuddy'])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureExternalTool')), false)
    await page.getByRole('heading', { name: '账户余额', exact: true }).locator('xpath=ancestor::section[1]').getByText('3 个工具已连接', { exact: true }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('every tool row offers configuration in exactly one place', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy&externalAccountOwned=workbuddy')
  try {
    // 已配好的外部客户端：主按钮是「打开」，配置只在「…」菜单里，行上不再有独立的「配置」按钮。
    const ready = page.getByTestId('tool-row-workbuddy')
    await ready.getByRole('button', { name: '打开', exact: true }).waitFor()
    assert.equal(await ready.getByRole('button', { name: '配置', exact: true }).count(), 0)
    await ready.getByRole('button', { name: '更多操作', exact: true }).click()
    const readyMenu = page.getByRole('menu')
    assert.equal(await readyMenu.getByRole('menuitem', { name: '配置', exact: true }).count(), 1)
    // 主按钮已经是「打开」，菜单里不再重复给一个「打开」。
    assert.equal(await readyMenu.getByRole('menuitem', { name: '打开', exact: true }).count(), 0)
    await page.getByTestId('home-client-workbuddy').click()
    await page.getByTestId('external-client-dialog').waitFor()
    await page.getByTestId('external-client-dialog').getByRole('button', { name: '取消', exact: true }).click()
    // 还没配好的外部客户端：主按钮本身就是「配置」，菜单里不再重复。
    const pending = page.getByTestId('tool-row-opencode')
    await pending.getByRole('button', { name: '配置', exact: true }).waitFor()
    await pending.getByRole('button', { name: '更多操作', exact: true }).click()
    const pendingMenu = page.getByRole('menu')
    assert.equal(await pendingMenu.getByRole('menuitem', { name: '配置', exact: true }).count(), 0)
    assert.equal(await pendingMenu.getByRole('menuitem', { name: '打开', exact: true }).count(), 1)
    await page.keyboard.press('Escape')
    // 四个 CLI 行一直只有菜单入口，行上没有独立「配置」按钮，两类工具行现在给法一致。
    const cli = page.getByTestId('tool-row-codex')
    assert.equal(await cli.getByRole('button', { name: '配置', exact: true }).count(), 0)
    await cli.getByRole('button', { name: '更多操作', exact: true }).click()
    assert.equal(await page.getByRole('menu').getByRole('menuitem', { name: '配置', exact: true }).count(), 1)
    await page.keyboard.press('Escape')
    await clean(page)
  } finally { await page.close() }
})

test('external client incomplete Claude configuration requires setup before primary launch', async () => {
  const page = await open('externalInstalled=1&externalOther=claudeDesktop')
  try {
    const row = page.getByTestId('tool-row-claudeDesktop')
    await row.getByText('还没配 Key', { exact: true }).waitFor()
    await expect(row).toContainText('第三方推理配置待完善')
    assert.equal(await row.getByRole('button', { name: '打开', exact: true }).count(), 0)
    await row.getByRole('button', { name: '配置', exact: true }).click()
    await page.getByTestId('external-client-dialog').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureExternalTool')), false)
    await clean(page)
  } finally { await page.close() }
})

test('external client platform and detection failures remain distinct from missing installation', async () => {
  const page = await open('externalUnsupported=opencode&externalDetectionError=workbuddy')
  try {
    const unavailable = page.getByTestId('tool-row-opencode')
    await unavailable.getByText('当前平台请从官方页面手动安装', { exact: true }).waitFor()
    assert.equal(await unavailable.getByRole('button', { name: '暂不支持', exact: true }).isDisabled(), true)
    const failed = page.getByTestId('tool-row-workbuddy')
    await failed.getByText('检测失败', { exact: true }).waitFor()
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length)
    await failed.getByRole('button', { name: '重新检测', exact: true }).click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length > count, before)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'installExternalClient')), false)
    await clean(page)
  } finally { await page.close() }
})

test('external client scans from the previous account cannot overwrite the current account', async () => {
  const page = await open('externalInstalled=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByRole('button', { name: '配置', exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') === 'true')
    await page.evaluate(() => {
      window.v2Test.setExternalStatus('workbuddy', { configured: true, configurationSource: 'xingmang', model: 'new-account-model' })
      window.v2Test.emit('onAccountSessionChanged', { authenticated: true, account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 } })
    })
    await row.getByText('v1.2.3 · new-account-model', { exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.releaseExternalScan())
    await page.waitForTimeout(100)
    assert.equal(await row.getByRole('button', { name: '打开', exact: true }).count(), 1)
    assert.equal(await row.getByText('v1.2.3 · new-account-model', { exact: true }).count(), 1)
    await clean(page)
  } finally { await page.close() }
})

test('WorkBuddy loses current-account readiness when switching saved accounts on the same site', async () => {
  const page = await open('savedAccount=1&externalInstalled=1&externalReady=workbuddy&externalAccountOwned=workbuddy')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByText('已配好', { exact: true }).waitFor()
    const balancePanel = page.getByRole('heading', { name: '账户余额', exact: true }).locator('xpath=ancestor::section[1]')
    await balancePanel.getByText('4 个工具已连接', { exact: true }).waitFor()
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length)
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    await page.getByTestId('saved-accounts-list').getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('heading', { name: /saved-user/ }).waitFor()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length > count, before)
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 0)
    await page.evaluate(() => window.v2Test.releaseExternalScan())
    await row.getByText('已有第三方配置', { exact: true }).waitFor()
    await row.getByText('v1.2.3 · fixture-model', { exact: true }).waitFor()
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 0)
    await balancePanel.getByText('等待连接', { exact: true }).waitFor()
    const session = await page.evaluate(() => window.xingmang.getAccountSession())
    assert.equal(session.account.userId, 18)
    assert.equal(session.siteId ?? 'solov', 'solov')
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureExternalTool')), false)
    await clean(page)
  } finally { await page.close() }
})

test('a delayed ready WorkBuddy scan cannot restore the previous account badge after a same-site switch', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy&externalAccountOwned=workbuddy')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByText('已配好', { exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') === 'true')
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, siteId: 'solov', account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 } }))
    await row.getByText('已有第三方配置', { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.v2Test.releaseExternalScan()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 0)
    assert.equal(await row.getByText('已有第三方配置', { exact: true }).count(), 1)
    await page.getByRole('heading', { name: '账户余额', exact: true }).locator('xpath=ancestor::section[1]').getByText('3 个工具已连接', { exact: true }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('logout retains WorkBuddy local configuration without retaining the signed-out account badge or late scan', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy&externalAccountOwned=workbuddy')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByText('已配好', { exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') === 'true')
    await page.getByRole('button', { name: '打开个人中心 fixture-user', exact: true }).click()
    await page.getByRole('button', { name: '退出当前账号', exact: true }).click()
    await page.getByRole('dialog', { name: '退出当前账号？', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    assert.equal(await row.count(), 0)
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-codexDesktop').check()
    for (let step = 0; step < 3; step++) await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-home').click()
    await row.getByText('已有第三方配置', { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.v2Test.releaseExternalScan()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 0)
    assert.equal(await row.getByText('已有第三方配置', { exact: true }).count(), 1)
    assert.equal(await row.getByText('v1.2.3 · fixture-model', { exact: true }).count(), 1)
    const session = await page.evaluate(() => window.xingmang.getAccountSession())
    assert.equal(session.authenticated, false)
    assert.equal(session.account, null)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureExternalTool')), false)
    await clean(page)
  } finally { await page.close() }
})

test('external client installation completion does not refresh or notify the next account', async () => {
  const page = await open('externalInstallPending=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByRole('button', { name: '安装', exact: true }).click()
    await row.getByText('正在下载安装包', { exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 } }))
    await page.getByRole('heading', { name: /next-user/ }).waitFor()
    await page.waitForFunction(() => !document.querySelector('[data-testid="home-rescan"]')?.hasAttribute('aria-busy'))
    const count = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length)
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await row.getByRole('button', { name: '安装', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length), count)
    assert.equal(await page.getByText('客户端已安装，点击“配置”选择密钥和模型。', { exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('client save errors retain the selected model and never show a success notice', async () => {
  const page = await open('clientModels=1&clientSaveFailure=1&keyOptions=1')
  try {
    await page.getByTestId('home-client-workbuddy').click()
    await page.getByTestId('external-client-detect').click()
    await page.getByTestId('external-client-model').selectOption('deepseek-fixture')
    await page.getByTestId('external-client-save').click()
    await page.getByRole('alert').filter({ hasText: '配置保存失败，原配置已保留' }).waitFor()
    assert.equal(await page.getByTestId('external-client-model').inputValue(), 'deepseek-fixture')
    assert.equal(await page.getByTestId('external-client-result').count(), 0)
    await page.getByTestId('external-client-source').selectOption('account:202')
    assert.equal(await page.getByTestId('external-client-save').isDisabled(), true)
    await page.getByTestId('external-client-detect').click()
    await page.getByTestId('external-client-model').selectOption('fixture-other')
    await page.getByTestId('external-client-save').click()
    const call = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureExternalTool').at(-1))
    assert.deepEqual(call.args, ['workbuddy', { credential: { kind: 'account', keyId: 202 }, model: 'fixture-other' }])
    await clean(page)
  } finally { await page.close() }
})

test('Codex non-GPT menu requires a detected non-GPT model before saving', async () => {
  const page = await open('clientModels=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.waitFor()
    assert.equal(await row.getByRole('button', { name: '非 GPT 模型', exact: true }).count(), 0)
    await row.getByRole('button', { name: '更多操作', exact: true }).click()
    await page.getByTestId('home-codex-models').click()
    const dialog = page.getByTestId('config-dialog')
    await dialog.waitFor()
    assert.equal(await page.getByTestId('tool-save-config').isDisabled(), true)
    await page.getByTestId('tool-detect-models').click()
    await page.getByTestId('tool-default-model').selectOption('deepseek-fixture')
    const choices = await page.getByTestId('tool-default-model').locator('option').allTextContents()
    assert.equal(choices.some((label) => label === 'gpt-fixture'), false)
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-merge').click()
    await dialog.waitFor({ state: 'hidden' })
    const call = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfig').at(-1))
    assert.equal(call.args[0].model, 'deepseek-fixture')
    assert.equal(call.args[0].provider, 'codex')
    assert.equal(call.args[0].apiKey, '')
    await clean(page)
  } finally { await page.close() }
})

test('full App preserves the fixed desktop columns and renders only the new renderer assets', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`theme=${theme}`)
    try {
      await page.getByTestId('tool-row-codex').waitFor()
      const geometry = await page.evaluate(() => {
        const width = (selector) => document.querySelector(selector).getBoundingClientRect().width
        const height = (selector) => document.querySelector(selector).getBoundingClientRect().height
        return { root: width('.v2-root'), sidebar: width('.v2-sidebar'), left: width('.v2-home-main'), right: width('.v2-home-aside'), top: height('.v2-topbar'), bottom: height('.v2-statusbar'), overflow: document.documentElement.scrollWidth > 1280 }
      })
      assert.deepEqual(geometry, { root: 1280, sidebar: 216, left: 690, right: 292, top: 46, bottom: 30, overflow: false })
      const actionGeometry = await page.evaluate(() => {
        function measure(selector) {
          const group = document.querySelector(selector)
          const groupRect = group.getBoundingClientRect()
          const buttons = [...group.querySelectorAll(':scope > button')]
          const buttonRects = buttons.map((button) => button.getBoundingClientRect())
          return {
            height: groupRect.height,
            gap: Number.parseFloat(getComputedStyle(group).gap),
            align: getComputedStyle(group).alignItems,
            paddingTop: Number.parseFloat(getComputedStyle(group).paddingTop),
            buttonHeights: buttonRects.map((rect) => rect.height),
            geometricGap: buttonRects[1].left - buttonRects[0].right,
            sameLine: buttonRects.every((rect) => Math.abs(rect.top - buttonRects[0].top) <= 1),
            contained: buttonRects.every((rect) => rect.left >= groupRect.left && rect.right <= groupRect.right),
            overflow: group.scrollWidth > group.clientWidth || buttons.some((button) => button.scrollWidth > button.clientWidth),
          }
        }
        const topbar = document.querySelector('.v2-topbar').getBoundingClientRect()
        const pageHead = document.querySelector('.xm-page-head')
        const pageHeadRect = pageHead.getBoundingClientRect()
        const top = measure('.v2-topbar-actions')
        const home = measure('.xm-page-head-actions')
        const topButton = document.querySelector('.v2-topbar-actions button').getBoundingClientRect()
        const homeButton = document.querySelector('.xm-page-head-actions button').getBoundingClientRect()
        return {
          top,
          home,
          pageHeadAlign: getComputedStyle(pageHead).alignItems,
          topCenterOffset: (topButton.top + topButton.height / 2) - (topbar.top + topbar.height / 2),
          homeTopOffset: homeButton.top - pageHeadRect.top,
        }
      })
      assert.deepEqual(actionGeometry.top, {
        height: 32, gap: 6, align: 'center', paddingTop: 0, buttonHeights: [32, 32],
        geometricGap: 6, sameLine: true, contained: true, overflow: false,
      })
      assert.deepEqual(actionGeometry.home, {
        height: 40, gap: 8, align: 'center', paddingTop: 4, buttonHeights: [36, 36],
        geometricGap: 8, sameLine: true, contained: true, overflow: false,
      })
      assert.equal(actionGeometry.pageHeadAlign, 'flex-start')
      assert.ok(Math.abs(actionGeometry.topCenterOffset) <= 1)
      assert.equal(actionGeometry.homeTopOffset, 4)
      assert.equal(await page.locator('[data-testid^="tool-row-"]').count(), 8)
      await page.getByRole('button', { name: '标为已读' }).click()
      await page.screenshot({ path: path.join(artifacts, `home-${theme}.png`) })
      await page.getByTestId('sidebar-collapse').click()
      assert.equal(await page.locator('.v2-sidebar').evaluate((element) => element.getBoundingClientRect().width), 60)
      await clean(page)
    } finally { await page.close() }
  }
})
test('launch and config actions use the original typed desktop and CLI endpoints', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    const providers = ['claude', 'codex', 'gemini', 'grok']
    for (const provider of providers) {
      const launchCount = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length)
      await page.getByTestId(`tool-${provider}-primary`).click()
      await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length > count, launchCount)
      await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"]`)?.disabled, `tool-${provider}-primary`)
    }
    await page.getByTestId('tool-codexDesktop-primary').click()
    const calls = await page.evaluate(() => window.v2Test.calls)
    const choices = calls.filter((entry) => entry.method === 'chooseWorkspace')
    const launches = calls.filter((entry) => entry.method === 'launchCli')
    assert.equal(choices.length, 4)
    assert.deepEqual(launches.map((entry) => entry.args), providers.map((provider) => [provider, 'C:\\Selected Project']))
    for (let index = 0; index < launches.length; index += 1) {
      assert.ok(calls.indexOf(choices[index]) < calls.indexOf(launches[index]))
    }
    assert.deepEqual(calls.find((entry) => entry.method === 'launchCodexDesktop').args, ['open'])
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置', exact: true }).click()
    const dialog = page.getByTestId('config-dialog')
    await dialog.waitFor()
    await dialog.getByRole('button', { name: '检测模型', exact: true }).click()
    await dialog.getByLabel('默认模型').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('macOS opens an installed desktop app when Codex CLI and Node are missing', async () => {
  const page = await open('os=mac&desktopOnly=1')
  try {
    const button = page.getByTestId('tool-codexDesktop-primary')
    await button.waitFor()
    assert.equal(await button.innerText(), '打开')
    assert.equal(await button.isEnabled(), true)
    await button.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCodexDesktop').map((entry) => entry.args), [['open']])
    assert.equal(calls.some((entry) => ['launchCli', 'installCli', 'installNodeRuntime', 'chooseWorkspace'].includes(entry.method)), false)
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('canceling the CLI workspace picker keeps the tool closed without an error dialog', async () => {
  const page = await open('workspaceCancel=1')
  try {
    const button = page.getByTestId('tool-codex-primary')
    await button.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'chooseWorkspace'))
    await page.waitForTimeout(50)
    await button.click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'chooseWorkspace').length === 2)
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(methods.includes('launchCli'), false)
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('a pending CLI launch locks only its row and keeps the launch action visible', async () => {
  const page = await open('launchPending=1')
  try {
    const button = page.getByTestId('tool-codex-primary')
    await button.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-codex-primary"]')?.getAttribute('aria-busy') === 'true')
    assert.equal(await button.innerText(), '打开中')
    assert.equal(await button.isDisabled(), true)
    assert.equal(await button.evaluate((element) => element.scrollWidth <= element.clientWidth), true)
    assert.equal(await page.getByTestId('tool-claude-primary').isDisabled(), true)
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-codex-primary"]')?.getAttribute('aria-busy') !== 'true')
    assert.equal(await button.innerText(), '打开')
    await clean(page)
  } finally { await page.close() }
})

test('tool probe failures show a retry state instead of a third-party configuration state', async () => {
  const page = await open('detectionFailed=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByText('检测失败', { exact: true }).waitFor()
    await row.getByRole('button', { name: '重新检测', exact: true }).waitFor()
    await clean(page)
  } finally { await page.close() }
})
test('a failed probe offers a rescan on the maintenance page instead of an install', async () => {
  const page = await open('detectionFailed=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const row = page.getByTestId('maintenance-tool-claude')
    await row.getByText('检测失败', { exact: true }).waitFor()
    await row.getByRole('button', { name: '重新检测', exact: true }).waitFor()
    assert.equal(await row.getByRole('button', { name: '安装', exact: true }).count(), 0)
    // A4：原因原样上屏，而版本位不谎报「未找到版本」——这次根本没探到。
    assert.equal(await page.getByTestId('maintenance-reason-claude').innerText(), '本地探针暂时不可用')
    assert.match(await row.innerText(), /版本未读到/)
    await clean(page)
  } finally { await page.close() }
})
// A4：`buildCliStatus` 早就写好了这两条原因，渲染层一直没人读它们。
test('a failed update comparison says why on the maintenance page instead of going quiet', async () => {
  const page = await open('cliUpdateFailed=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const row = page.getByTestId('maintenance-tool-claude')
    await row.getByText('已安装', { exact: true }).waitFor()
    assert.equal(
      await page.getByTestId('maintenance-reason-claude').innerText(),
      '已安装 CLI 的版本号无法解析，不能判断是否有更新',
    )
    await clean(page)
  } finally { await page.close() }
})
// R-S8b: 安装卸载页自己那条读取路径原来是串行的，任一块失败整页退回未知态，
// 还把「未安装」当成结论显示出来。
test('a failed system scan leaves the maintenance page usable and never claims a tool is missing', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const row = page.getByTestId('maintenance-tool-claude')
    await row.waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'scanSystem' })
    await page.getByTestId('page-maintenance').getByRole('button', { name: '重新检测', exact: true }).first().click()
    await page.getByTestId('maintenance-failure-system').waitFor()
    await row.getByText('状态未读到', { exact: true }).waitFor()
    assert.equal(await row.getByText('未安装', { exact: true }).count(), 0)
    assert.equal(await row.getByRole('button', { name: '安装', exact: true }).count(), 0)
    await row.getByRole('button', { name: '重新检测', exact: true }).waitFor()
    // 运行环境那两行同样不能谎报「尚未安装」。
    const maintenance = page.getByTestId('page-maintenance')
    assert.equal(await maintenance.getByText('尚未安装', { exact: true }).count(), 0)
    assert.ok(await maintenance.getByText('状态未读到', { exact: true }).count() >= 5, '每个工具行与运行环境行都应只报未知')
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('maintenance-failure-system').getByRole('button', { name: '重新检测', exact: true }).click()
    await row.getByText('已安装', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('maintenance-failure-system').count(), 0)
    await clean(page)
  } finally { await page.close() }
})
test('a failed platform capability read keeps the tool states on the maintenance page', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const row = page.getByTestId('maintenance-tool-claude')
    await row.waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'getPlatformCapabilities' })
    await page.getByTestId('page-maintenance').getByRole('button', { name: '重新检测', exact: true }).first().click()
    await page.getByTestId('maintenance-failure-platform').waitFor()
    await row.getByText('已安装', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('maintenance-failure-system').count(), 0)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await clean(page)
  } finally { await page.close() }
})
test('uninstall is hidden when native status cannot safely remove the tool', async () => {
  const page = await open('uninstallUnavailable=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByRole('button', { name: '更多操作' }).click()
    assert.equal(await page.getByRole('menuitem', { name: '卸载', exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})
test('login synchronizes account Keys, configures installed tools, and route selection does not install', async () => {
  const page = await open('guest=1')
  try {
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.getByTestId('start-guide').waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    const bootstrapCalls = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.ok(bootstrapCalls.indexOf('syncManagedCliKeys') > bootstrapCalls.indexOf('loginAccount'))
    assert.ok(bootstrapCalls.indexOf('configureManagedCliKeys') > bootstrapCalls.indexOf('syncManagedCliKeys'))
    assert.equal(await page.getByRole('radio', { checked: true }).count(), 0)
    const configurationCount = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length)
    await page.getByTestId('guide-route-chat').check()
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(methods.includes('installCli') || methods.includes('installNodeRuntime'), false)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length), configurationCount)
    await page.getByTestId('guide-pause').click()
    await page.getByTestId('tool-row-claude').getByText('已配好').waitFor()
    await page.getByTestId('tool-row-codexDesktop').getByText('已配好').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('restored login repairs missing tool configs without overwriting official or third-party sources', async () => {
  const page = await open('missingConfig=1&allInstalled=1&official=1&unknownClaude=1')
  try {
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    const input = await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'configureManagedCliKeys').args[0])
    assert.deepEqual(input.providers, ['grok', 'gemini'])
    await page.getByTestId('tool-row-claude').getByText('已有第三方配置').waitFor()
    await page.getByTestId('tool-row-codex').getByText('官方账号', { exact: true }).waitFor()
    await page.getByTestId('tool-row-grok').getByText('已配好').waitFor()
    await page.getByTestId('tool-row-gemini').getByText('已配好').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length), 1)
    await clean(page)
  } finally { await page.close() }
})

test('restored login preserves a marked manual relay key and displays its source', async () => {
  const page = await open('missingConfig=1&allInstalled=1&manualClaude=1')
  try {
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    const input = await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'configureManagedCliKeys').args[0])
    assert.deepEqual(input.providers, ['codex', 'grok', 'gemini'])
    await page.getByTestId('tool-row-claude').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '自己填写密钥', exact: true }).getAttribute('aria-pressed'), 'true')
    await clean(page)
  } finally {
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('xingmang-v2:provider-source:v1:')) localStorage.removeItem(key)
      }
    }).catch(() => undefined)
    await page.close()
  }
})

const matchedToolIds = ['claude', 'codex', 'codexDesktop', 'grok', 'gemini']
async function matchedToolBadges(page, label) {
  for (const id of matchedToolIds) await page.getByTestId(`tool-row-${id}`).getByText(label, { exact: true }).waitFor()
}
async function settleMatchedBootstrap(page) {
  await page.waitForFunction(() => window.v2Test.calls.filter(entry => entry.method === 'getConfig').length >= 4)
  await page.waitForFunction(() => !document.querySelector('.v2-bootstrap-notice[data-busy="true"]') && document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') !== 'true')
}
async function assertNoMatchedKeyOperations(page, from = 0) {
  const calls = await page.evaluate(start => window.v2Test.calls.slice(start).map(entry => entry.method), from)
  assert.equal(calls.some(method => ['configureManagedCliKeys', 'saveConfig', 'saveConfigWithAccountKey', 'switchToOfficialAccount', 'revealApiKey', 'revealAccountKey', 'getAccountKeys', 'getAccountKeyOptions', 'listModels', 'listAccountKeyModels', 'listConfiguredModels'].includes(method)), false)
}

test('read-only account matches restore all five CLI tool badges without key requests or writes and keep detection read-only', async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1')
  try {
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    await assertNoMatchedKeyOperations(page)
    const before = await page.evaluate(() => window.v2Test.calls.length)
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') !== 'true')
    await matchedToolBadges(page, '已配好')
    await assertNoMatchedKeyOperations(page, before)
    assert.equal(await page.evaluate(start => window.v2Test.calls.slice(start).some(entry => entry.method === 'syncManagedCliKeys'), before), false)
    const summary = await page.evaluate(() => window.xingmang.getConfig())
    assert.ok(Object.values(summary.providers).every(provider => provider.configurationOwnership === 'unknown' && provider.configurationAccountMatched === true))
    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.screenshot({ path: path.join(artifacts, 'readonly-account-match-five-tools.png') })
    await clean(page)
  } finally { await page.close() }
})

test('read-only account matches respect local manual markers and preserve incomplete models without automatic repair', async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1&matchedManualMarker=claude&matchedMissingModel=gemini')
  try {
    await page.getByTestId('tool-row-claude').getByText('已配好', { exact: true }).waitFor()
    await page.getByTestId('tool-row-gemini').getByText('还没配 Key', { exact: true }).waitFor()
    for (const id of ['codex', 'codexDesktop', 'grok']) await page.getByTestId(`tool-row-${id}`).getByText('已配好', { exact: true }).waitFor()
    await settleMatchedBootstrap(page)
    await assertNoMatchedKeyOperations(page)
    assert.equal((await page.evaluate(() => window.xingmang.getConfig())).providers.gemini.model, '')
    await page.getByTestId('tool-row-claude').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '自己填写密钥', exact: true }).getAttribute('aria-pressed'), 'true')
    await clean(page)
  } finally { await page.close() }
})

test('read-only account matches remain third-party when the host cannot match an account', async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1&matchedUnavailable=1')
  try {
    await matchedToolBadges(page, '已有第三方配置')
    await settleMatchedBootstrap(page)
    await assertNoMatchedKeyOperations(page)
    await clean(page)
  } finally { await page.close() }
})

test('read-only account matches restore on fresh login without treating the match as configuration consent', async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1&guest=1&existing=1')
  try {
    await matchedToolBadges(page, '已有第三方配置')
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.getByTestId('start-guide').waitFor()
    await page.getByTestId('guide-pause').click()
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    await assertNoMatchedKeyOperations(page)
    assert.equal((await page.evaluate(() => window.xingmang.getConfig())).providers.codex.configurationOwnership, 'unknown')
    await clean(page)
  } finally { await page.close() }
})

for (const transition of ['same-site', 'cross-site']) test(`read-only account matches reject old getConfig responses after a ${transition} account switch`, async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1')
  try {
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    await page.evaluate(() => window.v2Test.holdNextConfigRead())
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') === 'true')
    await page.evaluate(kind => window.v2Test.emit('onAccountSessionChanged', { authenticated: true,
      siteId: kind === 'cross-site' ? 'solov-api' : 'solov', realmId: kind === 'cross-site' ? 'api-account' : 'xm-account',
      account: { userId: kind === 'cross-site' ? 17 : 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 },
    }), transition)
    await matchedToolBadges(page, '已有第三方配置')
    await page.evaluate(async () => {
      window.v2Test.releaseConfigRead()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await matchedToolBadges(page, '已有第三方配置')
    for (const id of matchedToolIds) assert.equal(await page.getByTestId(`tool-row-${id}`).getByText('已配好', { exact: true }).count(), 0)
    await assertNoMatchedKeyOperations(page)
    await clean(page)
  } finally { await page.close() }
})

test('read-only account matches do not survive logout or a late config read when local tools are reopened', async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1')
  try {
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    await page.evaluate(() => window.v2Test.holdNextConfigRead())
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') === 'true')
    await page.getByRole('button', { name: '打开个人中心 fixture-user', exact: true }).click()
    await page.getByRole('button', { name: '退出当前账号', exact: true }).click()
    await page.getByRole('dialog', { name: '退出当前账号？', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-codexDesktop').check()
    for (let step = 0; step < 2; step++) await page.getByTestId('guide-next').click()
    await page.getByText('已保留现有第三方配置。请先查看处理步骤，确认哪些设置需要保留后再决定如何连接。', { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.v2Test.releaseConfigRead()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await page.getByTestId('guide-next').isDisabled(), true)
    const summary = await page.evaluate(() => window.xingmang.getConfig())
    assert.ok(Object.values(summary.providers).every(provider => provider.configurationAccountMatched === false))
    await assertNoMatchedKeyOperations(page)
    await clean(page)
    await page.goto(`${origin}/src/renderer-v2/testing/app.html?readOnlyAccountMatch=1&allInstalled=1&guest=1&existing=1`)
    await matchedToolBadges(page, '已有第三方配置')
    await assertNoMatchedKeyOperations(page)
    await clean(page)
  } finally { await page.close() }
})

for (const scenario of ['manualClaude=1&lostManualMarker=1', 'unownedClaude=1']) test(`restored login preserves a native key when browser ownership is unavailable: ${scenario}`, async () => {
  const page = await open(`missingConfig=1&allInstalled=1&${scenario}`)
  try {
    await page.waitForFunction(() => window.v2Test.calls.some(entry => entry.method === 'configureManagedCliKeys'))
    const requests = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'configureManagedCliKeys').map(entry => entry.args[0]))
    assert.ok(requests.every(input => !input.providers.includes('claude')))
    assert.ok(requests.every(input => input.intent !== 'explicit'))
    const current = await page.evaluate(() => window.xingmang.getConfig())
    assert.equal(current.providers.claude.apiKeyPreview, 'sk-***')
    assert.equal(current.providers.claude.model, 'fixture-model')
    await clean(page)
  } finally { await page.close() }
})

test('partial Key configuration keeps successful tools and retries recoverably', async () => {
  const page = await open('guest=1&allInstalled=1&bootstrapPartial=1')
  try {
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.getByTestId('guide-pause').click()
    await page.getByText('Claude 分组暂时不可用').waitFor()
    await page.getByTestId('tool-row-claude').getByText('还没配 Key').waitFor()
    await page.getByTestId('tool-row-codex').getByText('已配好').waitFor()
    await page.getByRole('button', { name: '重新同步' }).click()
    await page.getByTestId('tool-row-claude').getByText('已配好').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length), 2)
    await clean(page)
  } finally { await page.close() }
})

test('Key bootstrap progress locks the guide until the account operation settles', async () => {
  const page = await open('guest=1&bootstrapPending=1')
  try {
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    const guide = page.getByTestId('start-guide')
    await guide.getByText('正在同步账号专属 Key').waitFor()
    assert.equal(await guide.getAttribute('data-busy'), 'true')
    assert.equal(await page.getByTestId('guide-route-claude').isDisabled(), true)
    await page.evaluate(() => window.v2Test.releaseBootstrap())
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    await page.getByTestId('guide-route-claude').waitFor({ state: 'visible' })
    assert.equal(await page.getByTestId('guide-route-claude').isDisabled(), false)
    await clean(page)
  } finally { await page.close() }
})

test('installing a new CLI while signed in writes only that provider Key', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length)
    await page.getByTestId('tool-gemini-primary').click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length > count, before)
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys'))
    assert.deepEqual(calls.at(-1).args[0].providers, ['gemini'])
    await page.getByTestId('tool-row-gemini').getByText('已配好').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('an updated tool row stays on the running install until the rescan lands', async () => {
  const page = await open('cliUpdate=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    const update = row.getByRole('button', { name: '更新', exact: true })
    await update.waitFor()
    // 重现用户看到的那一段：安装命令已经返回，同步 Key 和重新检测还在跑。
    await page.evaluate(() => window.v2Test.holdNextScan())
    await update.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    await row.getByText('安装完成，正在同步账号 Key 并刷新状态', { exact: true }).waitFor()
    assert.equal(await update.count(), 0, '刷新落地之前不能把「更新」按钮放回来')
    assert.equal(await row.getByText('v1.2.3', { exact: false }).count(), 0, '刷新落地之前不能把旧版本号放回来')
    await page.evaluate(() => window.v2Test.releaseScan())
    await row.getByText('v2.0.0', { exact: false }).waitFor()
    assert.equal(await update.count(), 0, '装到最新版之后不该还挂着「更新」')
    await clean(page)
  } finally { await page.close() }
})

test('saved-account switching keeps CLI synchronization opt-in', async () => {
  const page = await open('savedAccount=1')
  try {
    await page.getByTestId('tool-row-claude').waitFor()
    await page.getByRole('button', { name: '切换账号' }).click()
    await page.getByTestId('saved-accounts-list').getByRole('button', { name: '切换', exact: true }).click()
    await page.getByText('saved-user', { exact: true }).first().waitFor()
    await page.waitForTimeout(100)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length), 0)
    await clean(page)
  } finally { await page.close() }
})

test('read-only account matches switch only explicitly selected CLI providers one at a time', async () => {
  const page = await open('savedAccount=1&readOnlyAccountMatch=1&allInstalled=1')
  try {
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    const saved = page.getByTestId('saved-accounts-list')
    await saved.getByText('同步到工具（可选）', { exact: true }).click()
    await page.getByTestId('account-sync-claude').check()
    await page.getByTestId('account-sync-codex').check()
    assert.equal(await page.getByTestId('account-sync-gemini').isChecked(), false)
    assert.equal(await page.getByTestId('account-sync-grok').isChecked(), false)
    await saved.getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('button', { name: '打开个人中心 saved-user', exact: true }).waitFor()
    const writes = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'configureManagedCliKeys').map(entry => entry.args[0]))
    assert.deepEqual(writes, [
      { providers: ['claude'], preferredModels: { claude: 'fixture-model' }, intent: 'explicit' },
      { providers: ['codex'], preferredModels: { codex: 'fixture-model' }, intent: 'explicit' },
    ])
    for (const tool of ['claude', 'codex', 'codexDesktop']) await page.getByTestId(`tool-row-${tool}`).getByText('已配好', { exact: true }).waitFor()
    for (const tool of ['gemini', 'grok']) await page.getByTestId(`tool-row-${tool}`).getByText('已有第三方配置', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some(entry => ['saveConfig', 'saveConfigWithAccountKey', 'revealApiKey', 'revealAccountKey'].includes(entry.method))), false)
    await clean(page)
  } finally { await page.close() }
})

test('existing local tools remain accessible without a Xingmang account', async () => {
  const page = await open('guest=1&existing=1')
  try {
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop'))
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.ok(methods.includes('launchCodexDesktop'))
    assert.equal(methods.includes('loginAccount') || methods.includes('getAccountBalance'), false)
    await clean(page)
  } finally { await page.close() }
})

test('macOS guide detects an installed Codex Desktop with no config files or CLI runtime', async () => {
  const page = await open('os=mac&guest=1&missingConfig=1&desktopOnly=1')
  try {
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-codexDesktop').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('start-guide').getByText('已安装', { exact: true }).waitFor()
    await expect(page.getByTestId('guide-next')).toBeEnabled()
    assert.equal(await page.getByTestId('guide-install').count(), 0)
    await page.getByTestId('guide-next').click()
    await page.getByText('尚未选择连接方式', { exact: true }).waitFor()
    await expect(page.getByTestId('guide-next')).toBeDisabled()
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(methods.some((method) => ['installCodexDesktop', 'saveConfig', 'configureManagedCliKeys', 'switchToOfficialAccount'].includes(method)), false)
    await clean(page)
  } finally { await page.close() }
})

test('macOS guide does not report a failed Codex Desktop verification as not installed', async () => {
  const page = await open('os=mac&guest=1&desktopDetectionFailed=1')
  try {
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-codexDesktop').check()
    await page.getByTestId('guide-next').click()
    await page.getByText('暂时无法确认工具是否已安装，请重新检测。', { exact: true }).waitFor()
    await expect(page.getByTestId('guide-installed-rescan')).toBeEnabled()
    await expect(page.getByTestId('guide-next')).toBeDisabled()
    assert.equal(await page.getByText('未安装', { exact: true }).count(), 0)
    assert.equal(await page.getByTestId('guide-install').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('desktop status arriving during the initial scan preserves the full tool snapshot', async () => {
  const page = await open('desktopEvent=1')
  try {
    await page.getByTestId('tool-row-codexDesktop').getByText('v9.9.9 · fixture-model').waitFor()
    assert.equal(await page.locator('[data-testid^="tool-row-"]').count(), 8)
    await clean(page)
  } finally { await page.close() }
})

test('unavailable local preferences cannot prevent the toolbox shell from opening', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  try {
    await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
    await page.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error('storage unavailable') }; Storage.prototype.setItem = () => { throw new Error('storage unavailable') } })
    await page.goto(`${origin}/src/renderer-v2/testing/app.html`)
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('sidebar-collapse').click()
    assert.equal(await page.locator('.v2-sidebar').evaluate((element) => element.clientWidth), 59)
    await clean(page)
  } finally { await page.close() }
})

test('startup update errors leave the toolbox available and startup diagnostics run once', async () => {
  const page = await open('startupUpdate=1&diagnostics=1')
  try {
    await page.getByTestId('page-home').waitFor()
    await page.getByRole('alert').filter({ hasText: '本地更新源暂时不可用' }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'runDiagnostics').length), 1)
    await clean(page)
  } finally { await page.close() }
})

test('oversized announcements stay in a safe failure state and offer the allowlisted site', async () => {
  const page = await open('noticeOversized=1')
  try {
    await page.getByTestId('page-home').waitFor()
    await page.getByRole('button', { name: /^公告/ }).click()
    await page.getByRole('alert').waitFor()
    await page.getByText('公告包含过大的内嵌媒体，客户端已按安全上限拦截。').waitFor()
    const siteButton = page.getByTestId('announcement-open-site')
    await siteButton.waitFor()
    await siteButton.click()
    assert.equal((await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'openExternal')?.args[0])), 'https://xm.solov.cc')
    await clean(page)
  } finally { await page.close() }
})

test('Markdown announcements render headings, lists, emphasis and links', async () => {
  const page = await open('noticeMarkdown=1')
  try {
    await page.getByTestId('page-home').waitFor()
    await page.getByRole('button', { name: /^公告/ }).click()
    const dialog = page.getByRole('dialog', { name: '公告' })
    await dialog.locator('.v2-announcement-content').waitFor()
    assert.equal(await dialog.locator('h1').innerText(), '服务公告')
    assert.deepEqual(await dialog.locator('li').allInnerTexts(), ['第一项', '第二项'])
    assert.equal(await dialog.locator('strong').innerText(), '重点提醒')
    assert.equal(await dialog.getByRole('link', { name: '官方说明' }).getAttribute('href'), 'https://xm.solov.cc/help')
    await clean(page)
  } finally { await page.close() }
})

test('native announcement envelope stays styled and inert inside its sandbox', async () => {
  const page = await open('noticeNative=1')
  const externalRequests = []
  page.on('request', (request) => {
    if (!request.url().startsWith(origin + '/') && !request.url().startsWith('data:')) externalRequests.push(request.url())
  })
  try {
    await page.getByTestId('page-home').waitFor()
    await page.getByRole('button', { name: /^公告/ }).click()
    const locator = page.getByTestId('announcement-native-frame')
    await locator.waitFor()
    assert.equal(await locator.getAttribute('sandbox'), 'allow-same-origin')
    const handle = await locator.elementHandle()
    const frame = await handle?.contentFrame()
    assert.ok(frame)
    await frame.locator('[data-xm-state="zh-light"]').waitFor()
    const snapshot = await frame.evaluate(() => {
      const root = document.querySelector('[data-xm-native]')
      const title = document.querySelector('.title')
      const safeLink = document.querySelector('.safe-link')
      const unsafeLink = document.querySelector('.unsafe-link')
      const logo = document.querySelector('.logo')
      const qr = document.querySelector('.qr')
      return {
        scope: root?.className,
        state: [...document.querySelectorAll('[data-xm-state]')].map((element) => element.getAttribute('data-xm-state')),
        hidden: document.querySelectorAll('[hidden]').length,
        blockedNodes: document.querySelectorAll('script, form, input, iframe, object').length,
        eventAttributes: document.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]').length,
        remoteImage: document.querySelectorAll('img[src^="http:"] ,img[src^="https:"]').length,
        logo: { src: logo?.getAttribute('src'), width: logo?.getAttribute('width'), height: logo?.getAttribute('height') },
        qr: { src: qr?.getAttribute('src'), width: qr?.getAttribute('width'), height: qr?.getAttribute('height') },
        safeLink: { href: safeLink?.getAttribute('href'), external: safeLink?.getAttribute('data-xm-external-href') },
        unsafeLink: { href: unsafeLink?.getAttribute('href'), external: unsafeLink?.getAttribute('data-xm-external-href') },
        titleWeight: title ? getComputedStyle(title).fontWeight : '',
        titleColor: title ? getComputedStyle(title).color : '',
        art: getComputedStyle(document.querySelector('.art')).backgroundImage,
        css: [...document.querySelectorAll('style[data-xm-base]')].map((style) => style.textContent ?? '').join(''),
        xss: Boolean(window.nativeXss),
      }
    })
    assert.match(snapshot.scope, /^xm-native-/)
    assert.deepEqual(snapshot.state, ['zh-light'])
    assert.equal(snapshot.hidden, 0)
    assert.equal(snapshot.blockedNodes, 0)
    assert.equal(snapshot.eventAttributes, 0)
    assert.equal(snapshot.remoteImage, 0)
    assert.match(snapshot.logo.src, /^data:image\/svg\+xml;base64,/)
    assert.deepEqual({ width: snapshot.logo.width, height: snapshot.logo.height }, { width: '176', height: '69' })
    assert.match(snapshot.qr.src, /^data:image\/png;base64,/)
    assert.deepEqual({ width: snapshot.qr.width, height: snapshot.qr.height }, { width: '144', height: '144' })
    assert.deepEqual(snapshot.safeLink, { href: null, external: 'https://xm.solov.cc/help' })
    assert.deepEqual(snapshot.unsafeLink, { href: null, external: null })
    assert.equal(snapshot.titleWeight, '700')
    assert.equal(snapshot.titleColor, 'rgb(12, 34, 56)')
    assert.match(snapshot.art, /^url\("data:image\/png;base64,/)
    assert.doesNotMatch(snapshot.css, /attacker\.invalid|outside-escape|--escaped/)
    assert.equal(snapshot.xss, false)
    await frame.locator('.safe-link').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'openExternal' && entry.args[0] === 'https://xm.solov.cc/help'))
    assert.deepEqual(externalRequests, [])
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.waitForFunction(() => document.querySelector('[data-testid="announcement-native-frame"]')?.contentDocument?.querySelector('[data-xm-state="zh-dark"]'))
    assert.deepEqual(await page.getByTestId('announcement-native-frame').evaluate((element) => [...element.contentDocument.querySelectorAll('[data-xm-state]')].map((state) => state.getAttribute('data-xm-state'))), ['zh-dark'])
    const darkHandle = await page.getByTestId('announcement-native-frame').elementHandle()
    const darkFrame = await darkHandle?.contentFrame()
    assert.ok(darkFrame)
    await darkFrame.locator('.safe-link').focus()
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '公告' }).waitFor({ state: 'hidden' })
    await clean(page)
  } finally { await page.close() }
})

test('running desktop offers a real restart and official quotas can be refreshed', async () => {
  const page = await open('running=1&official=1')
  try {
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.getByRole('button', { name: '重启 Codex', exact: true }).click()
    await page.getByRole('heading', { name: 'Codex 已在运行' }).waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'launchCodexDesktop').args), ['restart'])
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '官方账户额度' }).click()
    await page.getByRole('button', { name: '刷新额度' }).click()
    await page.getByText('周限额 · 剩余 72%').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('configuration migration shares Codex drafts and failed saves retain the secret for retry', async () => {
  const page = await open('unknown=1')
  try {
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置', exact: true }).click()
    await page.getByRole('button', { name: '填写星芒密钥' }).click()
    await page.getByLabel('星芒访问密钥').fill('local-fixture-secret')
    await page.getByRole('tab', { name: 'Codex 桌面端', exact: true }).click()
    assert.equal(await page.getByLabel('星芒访问密钥').inputValue(), 'local-fixture-secret')
    await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await page.getByRole('button', { name: '检测模型', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await page.evaluate(() => { window.v2Test.fail = 'saveConfig' })
    await page.getByTestId('tool-save-config').click()
    const confirmation = page.getByRole('dialog', { name: '保存这份配置？' })
    await confirmation.getByTestId('tool-save-merge').click()
    await confirmation.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoToast(page, '配置保存成功')
    await confirmation.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await page.getByLabel('星芒访问密钥').inputValue(), 'local-fixture-secret')
    await clean(page)
  } finally { await page.close() }
})

test('a manual relay key saved over a third-party config survives the next login bootstrap', async () => {
  const page = await open('guest=1&existing=1&unknown=1')
  try {
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置', exact: true }).click()
    await page.getByRole('button', { name: '填写星芒密钥' }).click()
    await page.getByLabel('星芒访问密钥').fill('local-fixture-secret')
    await page.getByRole('button', { name: '检测模型', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-merge').click()
    await waitForSavedConfiguration(page)

    const marker = await page.evaluate(() => localStorage.getItem(
      `xingmang-v2:provider-source:v1:${encodeURIComponent('https://xm.solov.cc')}:codex`,
    ))
    assert.equal(marker, 'manual')

    await page.getByTestId('nav-chat').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    const configured = await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'configureManagedCliKeys').args[0].providers)
    assert.deepEqual(configured, ['claude'])
    await clean(page)
  } finally {
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith('xingmang-v2:provider-source:v1:')) localStorage.removeItem(key)
      }
    }).catch(() => undefined)
    await page.close()
  }
})

test('chat retains its task across navigation and reports work to native close protection', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('chat-composer-input').fill('local streaming fixture')
    await page.getByTestId('chat-send').click()
    await page.getByTestId('chat-stop').waitFor()
    const size = await page.getByTestId('page-chat').evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }))
    assert.equal(size.width, 1064)
    assert.ok(size.height > 600)
    await page.getByTestId('nav-home').click()
    await page.evaluate(() => window.v2Test.emit('onWindowCloseRequest', { requestId: 'fixture-close' }))
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'replyWindowClose'))
    assert.equal(await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'replyWindowClose').args[1].blockingTask), true)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'cancelAiChat')), false)
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('chat-stop').click()
    await clean(page)
  } finally { await page.close() }
})


test('NewAPI collection shows titles and keeps each opened notice read locally across reloads', async () => {
  const page = await open('noticeCollection=1')
  try {
    await page.getByTestId('announcement-open').click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    const list = dialog.getByTestId('announcement-list')
    await list.waitFor()
    assert.deepEqual(await list.locator('.v2-announcement-title').allTextContents(), ['图片模型上线', '旧模型下架通知', '发票中心上线'])
    assert.deepEqual(await list.locator('.v2-announcement-read-state').allTextContents(), ['未读', '未读', '未读'])
    assert.equal(await page.getByTestId('announcement-native-frame').count(), 0)
    assert.equal(await dialog.getByRole('button', { name: '标为已读', exact: true }).count(), 0)
    await dialog.screenshot({ path: path.join(artifacts, 'newapi-announcements-list.png') })
    const first = list.getByRole('button', { name: '图片模型上线 未读' })
    const firstId = await first.getAttribute('data-testid')
    await first.click()
    const frame = page.frameLocator('[data-testid="announcement-native-frame"]')
    await frame.getByRole('heading', { name: '图片模型上线亮色详情' }).waitFor()
    assert.equal(await frame.getByRole('heading', { name: /旧模型|发票中心/ }).count(), 0)
    assert.equal(await page.getByTestId('announcement-native-frame').getAttribute('sandbox'), 'allow-same-origin')
    assert.equal(await frame.locator('script, form, .remote').count(), 0)
    assert.equal(await page.evaluate(() => window.nativeXss), undefined)
    await dialog.getByRole('button', { name: '返回列表' }).click()
    assert.deepEqual(await list.locator('.v2-announcement-read-state').allTextContents(), ['已读', '未读', '未读'])
    assert.equal(await page.getByTestId(firstId).evaluate((element) => element === document.activeElement), true)
    await page.reload()
    await page.getByTestId('announcement-open').click()
    await list.waitFor()
    assert.deepEqual(await list.locator('.v2-announcement-read-state').allTextContents(), ['已读', '未读', '未读'])
    await list.getByRole('button', { name: '旧模型下架通知 未读' }).click()
    await frame.getByRole('heading', { name: '旧模型下架通知亮色详情' }).waitFor()
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await frame.getByRole('heading', { name: '旧模型下架通知暗色详情' }).waitFor()
    assert.equal(await frame.getByRole('heading', { name: '旧模型下架通知亮色详情' }).count(), 0)
    await dialog.screenshot({ path: path.join(artifacts, 'newapi-announcement-detail-dark.png') })
    await dialog.getByRole('button', { name: '返回列表' }).click()
    await list.getByRole('button', { name: '发票中心上线 未读' }).click()
    await frame.getByRole('heading', { name: '发票中心上线暗色详情' }).waitFor()
    await dialog.getByRole('button', { name: '返回列表' }).click()
    assert.deepEqual(await list.locator('.v2-announcement-read-state').allTextContents(), ['已读', '已读', '已读'])
    assert.equal(await page.locator('.v2-announcement-banner').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead')), false)
    await clean(page)
  } finally { await page.close() }
})

test('NewAPI read states survive collection updates and stay isolated between accounts', async () => {
  const page = await open('noticeCollection=1')
  const makeNotice = (firstBody) => ({ id: `collection-${firstBody}`, text: `<div data-newapi-collection="v1">
    <details class="collection-entry"><summary class="collection-summary"><span class="collection-entry-title">第一条</span></summary><div class="collection-body"><p>${firstBody}</p></div></details>
    <details class="collection-entry"><summary class="collection-summary"><span class="collection-entry-title">第二条</span></summary><div class="collection-body"><p>保持原内容</p></div></details>
  </div>` })
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.evaluate((notice) => window.v2Test.setNotice(notice), makeNotice('原内容'))
    await page.getByTestId('announcement-open').click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    const list = dialog.getByTestId('announcement-list')
    await list.getByRole('button', { name: '第一条 未读' }).click()
    await dialog.getByRole('button', { name: '返回列表' }).click()
    await list.getByRole('button', { name: '第二条 未读' }).click()
    await dialog.getByRole('button', { name: '返回列表' }).click()
    await page.evaluate((notice) => window.v2Test.setNotice(notice), makeNotice('更新后的内容'))
    await dialog.getByRole('button', { name: '重新读取' }).click()
    await list.getByRole('button', { name: '第一条 未读' }).waitFor()
    assert.deepEqual(await list.locator('.v2-announcement-read-state').allTextContents(), ['未读', '已读'])
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, siteId: 'solov', account: { userId: 18, username: 'other-user', group: 'default', role: 1, quota: 1, usedQuota: 0 } }))
    await page.getByTestId('announcement-open').click()
    await list.waitFor()
    assert.deepEqual(await list.locator('.v2-announcement-read-state').allTextContents(), ['未读', '未读'])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead')), false)
    await clean(page)
  } finally { await page.close() }
})

test('NewAPI durable read failures preserve details and can be retried without a remote write', async () => {
  const page = await open('noticeCollection=1')
  try {
    await page.getByTestId('announcement-open').click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    await dialog.getByTestId('announcement-list').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'syncLocalNoticeReads' })
    await dialog.getByRole('button', { name: '图片模型上线 未读' }).click()
    await dialog.getByRole('alert').filter({ hasText: '已读状态保存失败' }).waitFor()
    await page.frameLocator('[data-testid="announcement-native-frame"]').getByRole('heading', { name: '图片模型上线亮色详情' }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = '' })
    await dialog.getByRole('button', { name: '重试保存已读' }).click()
    await dialog.getByRole('alert').waitFor({ state: 'hidden' })
    await dialog.getByRole('button', { name: '返回列表' }).click()
    assert.deepEqual(await dialog.locator('.v2-announcement-read-state').allTextContents(), ['已读', '未读', '未读'])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead')), false)
    await clean(page)
  } finally { await page.close() }
})

test('Sub2API announcements list titles and automatically mark only the opened detail as read', async () => {
  const page = await open('sub2api=1')
  try {
    const button = page.getByTestId('announcement-open')
    await button.locator('.v2-unread').waitFor()
    await button.click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    const list = dialog.getByTestId('announcement-list')
    await list.getByRole('button', { name: '服务通知 未读', exact: true }).waitFor()
    await list.getByRole('button', { name: '套餐更新 未读', exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('announcement-detail').count(), 0)
    assert.equal(await dialog.getByText('系统升级完成', { exact: true }).count(), 0)
    assert.equal(await dialog.getByText('套餐详情已更新', { exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'markAccountNoticeRead')), [])
    await page.screenshot({ path: path.join(artifacts, 'sub2api-announcements.png') })

    await list.getByTestId('announcement-item-12').click()
    const detail = dialog.getByTestId('announcement-detail')
    await detail.getByRole('heading', { name: '服务通知', level: 2, exact: true }).waitFor()
    assert.equal(await detail.locator('strong').innerText(), '系统升级完成')
    assert.equal(await dialog.getByText('套餐详情已更新', { exact: true }).count(), 0)
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead'))
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await list.getByRole('button', { name: '服务通知 已读', exact: true }).waitFor()
    await list.getByRole('button', { name: '套餐更新 未读', exact: true }).waitFor()
    assert.equal(await button.locator('.v2-unread').count(), 1)

    await list.getByTestId('announcement-item-12').click()
    await detail.getByRole('heading', { name: '服务通知', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await list.getByTestId('announcement-item-8').click()
    await detail.getByRole('heading', { name: '套餐更新', level: 2, exact: true }).waitFor()
    await detail.getByText('套餐详情已更新', { exact: true }).waitFor()
    assert.equal(await dialog.locator('script').count(), 0)
    assert.equal(await page.evaluate(() => window.nativeXss), undefined)
    await button.locator('.v2-unread').waitFor({ state: 'hidden' })
    const writes = await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'markAccountNoticeRead'))
    assert.deepEqual(writes.map((call) => call.args), [['sub2api-notices', '12'], ['sub2api-notices', '8']])
    await page.screenshot({ path: path.join(artifacts, 'sub2api-announcement-detail.png') })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await button.click()
    await list.getByRole('button', { name: '服务通知 已读', exact: true }).waitFor()
    await list.getByRole('button', { name: '套餐更新 已读', exact: true }).waitFor()
    assert.equal(await detail.count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('Sub2API detail stays readable when marking fails and retry only marks that announcement', async () => {
  const page = await open('sub2api=1')
  try {
    const button = page.getByTestId('announcement-open')
    await button.click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    await page.evaluate(() => { window.v2Test.fail = 'markAccountNoticeRead' })
    await dialog.getByTestId('announcement-item-12').click()
    await dialog.getByRole('alert').getByText('本地测试操作失败').waitFor()
    await dialog.getByTestId('announcement-detail').getByText('系统升级完成', { exact: true }).waitFor()
    assert.equal(await button.locator('.v2-unread').count(), 1)
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await dialog.getByRole('button', { name: '服务通知 未读', exact: true }).waitFor()
    await dialog.getByTestId('announcement-item-12').click()
    await dialog.getByRole('alert').getByText('本地测试操作失败').waitFor()
    await page.evaluate(() => { window.v2Test.fail = '' })
    await dialog.getByRole('button', { name: '重试保存已读', exact: true }).click()
    await dialog.getByRole('alert').waitFor({ state: 'hidden' })
    await dialog.getByTestId('announcement-detail').getByText('系统升级完成', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await dialog.getByRole('button', { name: '服务通知 已读', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '套餐更新 未读', exact: true }).waitFor()
    assert.equal(await button.locator('.v2-unread').count(), 1)
    const writes = await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'markAccountNoticeRead'))
    assert.deepEqual(writes.map((call) => call.args), Array.from({ length: 3 }, () => ['sub2api-notices', '12']))
    await clean(page)
  } finally { await page.close() }
})

test('Sub2API pending read updates stay attached to their own announcement after switching details', async () => {
  const page = await open('sub2api=1&noticeMarkPending=1')
  try {
    const button = page.getByTestId('announcement-open')
    await button.click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    await dialog.getByTestId('announcement-item-12').click()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead' && call.args[1] === '12'))
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await dialog.getByTestId('announcement-item-8').click()
    const detail = dialog.getByTestId('announcement-detail')
    await detail.getByRole('heading', { name: '套餐更新', exact: true }).waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead' && call.args[1] === '8'))
    await page.evaluate(() => window.v2Test.releaseNoticeMark('12'))
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await detail.getByRole('heading', { name: '套餐更新', exact: true }).isVisible(), true)
    assert.equal(await button.locator('.v2-unread').count(), 1)
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await dialog.getByRole('button', { name: '服务通知 已读', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '套餐更新 未读', exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.releaseNoticeMark('8'))
    await dialog.getByRole('button', { name: '套餐更新 已读', exact: true }).waitFor()
    await button.locator('.v2-unread').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'markAccountNoticeRead').map((call) => call.args)), [['sub2api-notices', '12'], ['sub2api-notices', '8']])
    await clean(page)
  } finally { await page.close() }
})

test('Sub2API long announcement titles stay on one line and reveal their full title in details', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`sub2api=1&noticeLongTitle=1&theme=${theme}`)
    try {
      await page.setViewportSize({ width: 1100, height: 820 })
      await page.getByTestId('announcement-open').click()
      const dialog = page.getByRole('dialog', { name: '公告', exact: true })
      const title = dialog.getByTestId('announcement-item-12').locator('.v2-announcement-title')
      await title.waitFor()
      const fullTitle = await title.innerText()
      const geometry = await title.evaluate((element) => {
        const style = getComputedStyle(element)
        const row = element.closest('button').getBoundingClientRect()
        const list = element.closest('[data-testid="announcement-list"]')
        return { whiteSpace: style.whiteSpace, textOverflow: style.textOverflow, overflow: style.overflow, truncated: element.scrollWidth > element.clientWidth,
          rowContained: row.right <= list.getBoundingClientRect().right, listOverflows: list.scrollWidth > list.clientWidth }
      })
      assert.deepEqual(geometry, { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', truncated: true, rowContained: true, listOverflows: false })
      await page.screenshot({ path: path.join(artifacts, `sub2api-announcements-long-title-${theme}.png`) })
      await dialog.getByTestId('announcement-item-12').click()
      await dialog.getByTestId('announcement-detail').getByRole('heading', { name: fullTitle, level: 2, exact: true }).waitFor()
      await clean(page)
    } finally { await page.close() }
  }
})

test('legacy announcements keep their content view and local mark-read action', async () => {
  const page = await open()
  try {
    const button = page.getByTestId('announcement-open')
    await button.locator('.v2-unread').waitFor()
    await button.click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    await dialog.getByText('本地测试公告', { exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('announcement-list').count(), 0)
    await dialog.getByRole('button', { name: '标为已读', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await button.locator('.v2-unread').waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'markAccountNoticeRead')), [])
    await clean(page)
  } finally { await page.close() }
})

test('Sub2API announcements keep server-read and empty states and recover from read errors', async () => {
  for (const query of ['sub2api=1&noticesRead=1', 'sub2api=1&noticeEmpty=1']) {
    const page = await open(query)
    try {
      await page.getByTestId('announcement-open').click()
      const dialog = page.getByRole('dialog', { name: '公告', exact: true })
      await dialog.getByText(query.includes('noticeEmpty') ? '暂无公告' : '服务通知', { exact: true }).waitFor()
      assert.equal(await page.locator('.v2-unread').count(), 0)
      if (query.includes('noticesRead')) {
        await dialog.getByRole('button', { name: '服务通知 已读', exact: true }).click()
        await dialog.getByTestId('announcement-detail').getByText('系统升级完成', { exact: true }).waitFor()
        await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
      }
      assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'markAccountNoticeRead')), [])
      await page.evaluate(() => { window.v2Test.fail = 'getAccountNotice' })
      await dialog.getByRole('button', { name: '重新读取' }).click()
      await dialog.getByRole('alert').getByText('本地测试操作失败').waitFor()
      await page.evaluate(() => { window.v2Test.fail = '' })
      await dialog.getByRole('button', { name: '重新读取' }).click()
      await dialog.getByText(query.includes('noticeEmpty') ? '暂无公告' : '服务通知', { exact: true }).waitFor()
      await clean(page)
    } finally { await page.close() }
  }
})

test('Sub2API session drives account panels while old relay settings stay on NewAPI', async () => {
  const page = await open('sub2api=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    assert.equal(await page.getByRole('button', { name: '充值', exact: true }).count(), 0)
    await page.getByRole('button', { name: '打开个人中心 fixture-user' }).click()
    await page.getByTestId('account-display').waitFor()
    const labels = await page.getByTestId('account-tabs').getByRole('tab').allTextContents()
    assert.deepEqual(labels, ['我的账号', '密钥'])
    assert.doesNotMatch(await page.getByTestId('page-account').innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov/i)
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(methods.includes('getAccountProfile'), true)
    assert.equal(methods.includes('getAccountNotice'), true)
    for (const method of ['getAccountUsage', 'getAccountLoginSessions', 'getAccountTopupInfo', 'getAccountSubscriptionSelf', 'getLegalDocument']) assert.equal(methods.includes(method), false, method)
    await page.screenshot({ path: path.join(artifacts, 'account-sub2api.png') })
    await clean(page)
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: false, account: null, siteId: 'solov-api', realmId: 'api-account' }))
    await page.getByTestId('welcome-login').waitFor()
    assert.equal(await page.getByTestId('account-display').count(), 0)
  } finally { await page.close() }
})

test('an obsolete balance rejection stays silent before the session-change event arrives', async () => {
  const page = await open('sub2api=1&balancePending=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'getAccountBalance'))
    await page.evaluate(() => window.v2Test.releaseBalance("Error invoking remote method 'account:get-balance': Error: 账号上下文已变化，请重试"))
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: false, account: null, siteId: 'solov-api', realmId: 'api-account' }))
    await page.getByTestId('welcome-login').waitFor()
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('late balance results and failures cannot escape an expired or switched account', async () => {
  for (const action of ['expire', 'switch']) for (const result of ['resolve', 'reject']) {
    const page = await open('sub2api=1&balancePending=1')
    try {
      await page.getByTestId('tool-row-codex').waitFor()
      await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'getAccountBalance'))
      await page.evaluate((action) => window.v2Test.emit('onAccountSessionChanged', action === 'expire'
        ? { authenticated: false, account: null, siteId: 'solov-api', realmId: 'api-account' }
        : { authenticated: true, account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 24.8, usedQuota: 0 }, siteId: 'solov-api', realmId: 'api-account' }), action)
      if (action === 'expire') await page.getByTestId('welcome-login').waitFor()
      else await page.locator('.v2-sidebar').getByText('$24.80', { exact: true }).waitFor()
      await page.evaluate((result) => window.v2Test.releaseBalance(result === 'reject'
        ? "Error invoking remote method 'account:get-balance': RealmAccountError: 账号服务暂时无法连接" : undefined), result)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
      if (action === 'expire') assert.equal(await page.getByTestId('welcome-login').isVisible(), true)
      else assert.equal(await page.locator('.v2-sidebar').getByText('$24.80', { exact: true }).isVisible(), true)
      await clean(page)
    } finally { await page.close() }
  }
})

test('a current-account balance failure stays inline and disappears on logout', async () => {
  const page = await open('sub2api=1&balancePending=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'getAccountBalance'))
    await page.evaluate(() => window.v2Test.releaseBalance("Error invoking remote method 'account:get-balance': RealmAccountError: 账号服务暂时无法连接"))
    const sidebar = page.getByTestId('account-entry')
    await sidebar.getByText('更新失败', { exact: true }).waitFor()
    assert.match(await page.getByTestId('sidebar-balance-refresh').getAttribute('title'), /余额暂时没有读到，请检查网络后重试/)
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: false, account: null, siteId: 'solov-api', realmId: 'api-account' }))
    await page.getByTestId('welcome-login').waitFor()
    assert.equal(await page.getByText('更新失败', { exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})


test('visible balances poll every 30 seconds, pause while hidden, and refresh when returning after five seconds', async () => {
  const page = await open('sub2api=1', true)
  const reads = () => page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'getAccountBalance').length)
  const visibility = (value) => page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }, value)
  try {
    await page.getByTestId('home-balance').getByText('$12.40', { exact: true }).waitFor()
    assert.equal(await reads(), 1)
    await page.clock.fastForward(29_999)
    assert.equal(await reads(), 1)
    await page.evaluate(() => window.v2Test.setBalance(11.25))
    await page.clock.fastForward(1)
    await page.getByTestId('home-balance').getByText('$11.25', { exact: true }).waitFor()
    assert.equal(await reads(), 2)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    assert.equal(await reads(), 2)
    await page.clock.fastForward(5_000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(() => window.v2Test.calls.filter((call) => call.method === 'getAccountBalance').length === 3)
    await visibility('hidden')
    await page.clock.fastForward(120_000)
    assert.equal(await reads(), 3)
    await page.evaluate(() => window.v2Test.setBalance(9.5))
    await visibility('visible')
    await page.getByTestId('home-balance').getByText('$9.50', { exact: true }).waitFor()
    assert.equal(await reads(), 4)
    await clean(page)
  } finally { await page.close() }
})

test('consumption completion refreshes after two seconds and merges notifications only for the active account', async () => {
  const page = await open('sub2api=1', true)
  const reads = () => page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'getAccountBalance').length)
  try {
    await page.getByTestId('home-balance').getByText('$12.40', { exact: true }).waitFor()
    await page.evaluate(() => {
      window.v2Test.setBalance(10)
      window.v2Test.emit('onAccountUsageChanged', { scope: 'xm-account:17' })
      window.v2Test.emit('onAccountUsageChanged', { scope: 'api-account:18' })
    })
    await page.clock.fastForward(2_000)
    assert.equal(await reads(), 1)
    await page.evaluate(() => window.v2Test.emit('onAccountUsageChanged', { scope: 'api-account:17' }))
    await page.clock.fastForward(1_000)
    await page.evaluate(() => window.v2Test.emit('onAccountUsageChanged', { scope: 'api-account:17' }))
    await page.clock.fastForward(1_999)
    assert.equal(await reads(), 1)
    await page.clock.fastForward(1)
    await page.getByTestId('home-balance').getByText('$10.00', { exact: true }).waitFor()
    assert.equal(await reads(), 2)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
      window.v2Test.setBalance(8)
      window.v2Test.emit('onAccountUsageChanged', { scope: 'api-account:17' })
    })
    await page.clock.fastForward(2_000)
    assert.equal(await reads(), 2)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.getByTestId('home-balance').getByText('$8.00', { exact: true }).waitFor()
    assert.equal(await reads(), 3)
    await clean(page)
  } finally { await page.close() }
})

test('manual balance refresh is shared by the sidebar, footer, home and personal center', async () => {
  const page = await open('sub2api=1')
  const reads = () => page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'getAccountBalance').length)
  try {
    await page.getByTestId('home-balance').getByText('$12.40', { exact: true }).waitFor()
    await page.getByRole('button', { name: '打开个人中心 fixture-user' }).click()
    await page.getByTestId('account-balance').waitFor()
    assert.equal(await reads(), 1)
    await page.evaluate(() => { window.v2Test.setBalance(20.25); window.v2Test.holdNextBalance() })
    const before = await reads()
    await page.getByTestId('sidebar-balance-refresh').click()
    assert.equal(await page.getByTestId('sidebar-balance-refresh').isDisabled(), true)
    assert.equal(await page.getByTestId('account-balance-refresh').isDisabled(), true)
    assert.equal(await page.getByTestId('account-balance').innerText(), '$12.40')
    await page.evaluate(() => window.v2Test.releaseBalance())
    await page.getByTestId('account-balance').getByText('$20.25', { exact: true }).waitFor()
    assert.equal(await reads(), before + 1)
    assert.match(await page.getByTestId('statusbar-balance').innerText(), /20\.25/)
    assert.match(await page.getByTestId('sidebar-balance-refresh').getAttribute('title'), /最后更新于/)
    await page.evaluate(() => window.v2Test.setBalance(23.5))
    await page.getByTestId('account-identity-menu').click()
    await page.getByRole('menuitem', { name: '刷新账号资料' }).click()
    await page.getByTestId('account-balance').getByText('$23.50', { exact: true }).waitFor()
    assert.match(await page.getByTestId('statusbar-balance').innerText(), /23\.50/)
    assert.equal(await reads(), before + 2)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('home-balance').getByText('$23.50', { exact: true }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('failed refresh keeps the last balance and timestamp without a blocking dialog and recovers on retry', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`sub2api=1&theme=${theme}`)
    try {
      await page.getByTestId('home-balance').getByText('$12.40', { exact: true }).waitFor()
      const originalTitle = await page.getByTestId('sidebar-balance-refresh').getAttribute('title')
      await page.evaluate(() => { window.v2Test.fail = 'getAccountBalance' })
      await page.getByTestId('sidebar-balance-refresh').click()
      await page.getByTestId('account-entry').getByText('更新失败', { exact: true }).waitFor()
      assert.equal(await page.getByTestId('home-balance').innerText(), '$12.40')
      assert.match(await page.getByTestId('statusbar-balance').innerText(), /12\.40/)
      const timestamp = originalTitle.match(/最后更新于 \d{2}:\d{2}:\d{2}/)?.[0]
      assert.ok(timestamp)
      assert.ok((await page.getByTestId('sidebar-balance-refresh').getAttribute('title')).includes(timestamp))
      assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
      const overflow = await page.getByTestId('account-entry').evaluate((element) => element.scrollWidth > element.clientWidth)
      assert.equal(overflow, false)
      await page.screenshot({ path: path.join(artifacts, `balance-refresh-${theme}.png`) })
      await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.setBalance(14) })
      await page.getByTestId('home-balance-refresh').click()
      await page.getByTestId('home-balance').getByText('$14.00', { exact: true }).waitFor()
      assert.equal(await page.getByTestId('account-entry').getByText('更新失败', { exact: true }).count(), 0)
      await clean(page)
    } finally { await page.close() }
  }
})

test('a saved account with the same id switches platform without reusing NewAPI panels', async () => {
  const page = await open('crossSite=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    const list = page.getByTestId('saved-accounts-list')
    await list.getByText('账户尾号 aa0017', { exact: true }).waitFor()
    assert.doesNotMatch(await list.innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov/i)
    await list.getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('dialog', { name: '切换账号', exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '打开个人中心 fixture-user' }).click()
    await page.getByTestId('account-display').waitFor()
    assert.deepEqual(await page.getByTestId('account-tabs').getByRole('tab').allTextContents(), ['我的账号', '密钥'])
    await page.getByTestId('announcement-open').click()
    const notice = page.getByRole('dialog', { name: '公告', exact: true })
    await notice.getByRole('button', { name: '服务通知 未读', exact: true }).waitFor()
    assert.equal(await notice.getByText('本地测试公告', { exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})


test('Sub2API keeps fractional key limits and changing its password returns to login', async () => {
  const page = await open('sub2api=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.getByRole('button', { name: '打开个人中心 fixture-user' }).click()
    await page.getByTestId('account-display').waitFor()
    await page.getByTestId('account-tabs').getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByTestId('account-key-add').click()
    await page.getByLabel('名称', { exact: true }).fill('quarter-dollar')
    await page.getByLabel('可用额度（USD）', { exact: true }).fill('0.25')
    await page.getByRole('button', { name: '保存密钥', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'createAccountKey'))
    const created = await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'createAccountKey').args[0])
    assert.equal(created.remainQuota, 0.25)
    assert.equal(created.unlimitedQuota, false)
    await page.getByTestId('account-tabs').getByRole('tab', { name: '我的账号', exact: true }).click()
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await page.getByLabel('当前密码', { exact: true }).fill('old-test-password')
    await page.getByLabel('新密码', { exact: true }).fill('long-new-test-password-for-sub2api')
    await page.getByLabel('确认新密码', { exact: true }).fill('long-new-test-password-for-sub2api')
    await page.getByRole('button', { name: '确认修改', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    await page.getByText('当前登录已结束，请重新登录。', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('account-display').count(), 0)
    await clean(page)
  } finally { await page.close() }
})


test('explicit historical login uses returned account ownership with customer account-source labels', async () => {
  const page = await open('guest=1&sub2api=1')
  try {
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('auth-source').getByRole('button', { name: '历史账号', exact: true }).click()
    await page.getByTestId('login-account').fill('same@example.test')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.getByTestId('start-guide').waitFor()
    await page.getByTestId('guide-pause').click()
    await page.getByRole('button', { name: '打开个人中心 fixture-user' }).click()
    await page.getByTestId('account-display').waitFor()
    assert.deepEqual(await page.getByTestId('account-tabs').getByRole('tab').allTextContents(), ['我的账号', '密钥'])
    assert.doesNotMatch(await page.locator('.v2-root').innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov/i)
    await clean(page)
  } finally { await page.close() }
})


async function openToolConfiguration(page, provider = 'codex') {
  await page.getByTestId(`tool-row-${provider}`).getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '配置', exact: true }).click()
  await page.getByTestId('config-dialog').waitFor()
}

async function waitForSavedConfiguration(page) {
  await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
  await waitForToast(page, '配置保存成功')
  assert.equal(await page.getByRole('dialog', { name: /保存这份配置|重置为初始状态|放弃未保存/ }).count(), 0)
}

const defaultModelCases = [
  { tool: 'claude', provider: 'claude', model: 'claude-opus-5' },
  { tool: 'codex', provider: 'codex', model: 'gpt-6-astra' },
  { tool: 'codexDesktop', provider: 'codex', model: 'gpt-6-astra' },
  { tool: 'gemini', provider: 'gemini', model: 'gemini-3.8-flash-high' },
  { tool: 'grok', provider: 'grok', model: 'grok-4.6' },
]
for (const existing of [false, true]) for (const { tool, provider, model } of defaultModelCases) {
  test(`${tool} model detection ${existing ? 'preserves the saved model' : `defaults to ${model} before the first returned model`}`, async () => {
    const page = await open(`guest=1&existing=1&allInstalled=1&keyOptions=1&cliDefaultModels=1${existing ? '' : '&cliMissingModels=1'}`)
    try {
      await openToolConfiguration(page, tool)
      const expected = existing ? 'fixture-model' : model
      assert.equal(await page.getByLabel('默认模型').inputValue(), expected)
      await page.getByTestId('tool-detect-models').click()
      await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
      assert.equal(await page.getByLabel('默认模型').inputValue(), expected)
      assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'listConfiguredModels').map((entry) => entry.args)), [[provider]])
      await page.getByTestId('tool-save-config').click()
      await page.getByTestId('tool-save-merge').click()
      await waitForSavedConfiguration(page)
      assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfig').map((entry) => entry.args[0])), [
        { provider, apiKey: '', model: expected, mode: 'merge' },
      ])
      await openToolConfiguration(page, tool)
      assert.equal(await page.getByLabel('默认模型').inputValue(), expected)
      await clean(page)
    } finally { await page.close() }
  })
}

test('configuration keeps the current local key by default and saves through the reuse sentinel', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    const select = page.getByTestId('tool-key-select')
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"] option[value="automatic"]')?.textContent.includes('GPT-中转/订阅'))
    assert.equal(await select.inputValue(), 'current')
    assert.match(await select.locator('option:checked').innerText(), /保持当前.*sk-co••••1234/)
    assert.match(await page.getByTestId('tool-key-summary').innerText(), /分组未确认/)
    assert.doesNotMatch(await page.getByTestId('tool-key-summary').innerText(), /Custom group/)
    await page.getByTestId('tool-detect-models').click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await page.getByTestId('tool-save-config').click()
    const confirmation = page.getByRole('dialog', { name: '保存这份配置？' })
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /密钥：名称未确认[\s\S]*分组：分组未确认[\s\S]*sk-co••••1234[\s\S]*fixture-model/)
    await confirmation.getByTestId('tool-save-merge').click()
    await waitForSavedConfiguration(page)
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.find((entry) => entry.method === 'saveConfig').args[0], { provider: 'codex', apiKey: '', model: 'fixture-model', mode: 'merge' })
    assert.equal(actions.some((entry) => ['configureManagedCliKeys', 'saveConfigWithAccountKey', 'revealApiKey', 'listAccountKeyModels'].includes(entry.method)), false)
    assert.deepEqual(actions.find((entry) => entry.method === 'listConfiguredModels').args, ['codex'])
    assert.equal(await page.evaluate(() => localStorage.getItem(`xingmang-v2:provider-source:v1:${encodeURIComponent('https://xm.solov.cc')}:codex`)), null)
    await clean(page)
  } finally { await page.close() }
})

for (const tool of matchedToolIds) test(`read-only account matches retain account display after keeping the current key and changing the ${tool} model`, async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1&keyOptions=1&cliDefaultModels=1')
  const provider = tool === 'codexDesktop' ? 'codex' : tool
  const selectedModel = defaultModelCases.find(item => item.tool === tool).model
  try {
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    await openToolConfiguration(page, tool)
    assert.equal(await page.getByRole('button', { name: '使用星芒账号', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByTestId('tool-key-select').inputValue(), 'current')
    assert.equal(await page.getByLabel('星芒访问密钥', { exact: true }).count(), 0)
    await page.getByTestId('tool-detect-models').click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await page.getByLabel('默认模型').selectOption(selectedModel)
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-merge').click()
    await waitForSavedConfiguration(page)
    await matchedToolBadges(page, '已配好')
    await page.getByTestId(`tool-row-${tool}`).getByText(`v1.2.3 · ${selectedModel}`, { exact: true }).waitFor()
    const summary = await page.evaluate(() => window.xingmang.getConfig())
    assert.equal(summary.providers[provider].configurationOwnership, 'unknown')
    assert.equal(summary.providers[provider].configurationAccountMatched, true)
    assert.equal(summary.providers[provider].model, selectedModel)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'saveConfig').map(entry => entry.args[0])), [
      { provider, apiKey: '', model: selectedModel, mode: 'merge' },
    ])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some(entry => ['configureManagedCliKeys', 'saveConfigWithAccountKey', 'revealApiKey', 'revealAccountKey'].includes(entry.method))), false)
    assert.equal(await page.evaluate(id => localStorage.getItem(`xingmang-v2:provider-source:v1:${encodeURIComponent('https://xm.solov.cc')}:${id}`), provider), null)
    await openToolConfiguration(page, tool)
    assert.equal(await page.getByRole('button', { name: '使用星芒账号', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByTestId('tool-key-select').inputValue(), 'current')
    assert.equal(await page.getByLabel('默认模型').inputValue(), selectedModel)
    assert.equal(await page.getByLabel('星芒访问密钥', { exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('selected account key shows its group and survives delayed metadata plus tool tab changes', async () => {
  const page = await open('keyOptions=1&keyMetadataPending=codex')
  try {
    await openToolConfiguration(page)
    const select = page.getByTestId('tool-key-select')
    await select.selectOption('202')
    assert.equal(await select.locator('option[value="202"]').innerText(), 'custom-key · Custom group · sk-ot••••1234')
    await page.evaluate(() => window.v2Test.releaseKeyMetadata('codex'))
    await page.getByRole('tab', { name: 'Claude Code', exact: true }).click()
    assert.equal(await select.inputValue(), 'current')
    assert.match(await page.getByTestId('tool-key-summary').innerText(), /sk-cl••••5678/)
    await page.getByRole('tab', { name: 'Codex 桌面端', exact: true }).click()
    assert.equal(await select.inputValue(), '202')
    await page.getByTestId('tool-detect-models').click()
    await page.getByLabel('默认模型').selectOption('fixture-other')
    await page.getByTestId('tool-save-config').click()
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /custom-key[\s\S]*Custom group[\s\S]*sk-ot••••1234[\s\S]*fixture-other/)
    await page.getByTestId('tool-save-merge').click()
    await waitForSavedConfiguration(page)
    await openToolConfiguration(page)
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-summary"]')?.textContent.includes('custom-key'))
    assert.equal(await select.inputValue(), 'current')
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.find((entry) => entry.method === 'listAccountKeyModels').args, [202])
    assert.deepEqual(actions.find((entry) => entry.method === 'saveConfigWithAccountKey').args[0], { provider: 'codex', keyId: 202, model: 'fixture-other', mode: 'merge' })
    assert.equal(actions.some((entry) => entry.method === 'configureManagedCliKeys'), false)
    await clean(page)
  } finally { await page.close() }
})

test('explicit automatic key configuration shows the right group and adopts the actual saved model', async () => {
  const page = await open('keyOptions=1&sub2api=1&autoFallback=1')
  try {
    await openToolConfiguration(page)
    const select = page.getByTestId('tool-key-select')
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"] option[value="automatic"]')?.textContent.includes('Codex_pro'))
    assert.equal(await select.inputValue(), 'current')
    assert.match(await select.locator('option[value="automatic"]').innerText(), /自动准备\/复用.*Codex_pro.*xingmang-desktop-codex/)
    await select.selectOption('automatic')
    assert.equal(await page.getByTestId('tool-detect-models').isDisabled(), true)
    const before = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(before.includes('listConfiguredModels') || before.includes('configureManagedCliKeys'), false)
    await page.getByTestId('tool-save-config').click()
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /xingmang-desktop-codex[\s\S]*Codex_pro[\s\S]*保存时准备或复用/)
    await page.getByTestId('tool-save-merge').click()
    await waitForSavedConfiguration(page)
    await openToolConfiguration(page)
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"]')?.value === 'current' && document.querySelector('[data-testid="tool-key-summary"]')?.textContent.includes('coding-key'))
    assert.equal(await page.getByLabel('默认模型').inputValue(), 'gpt-5.6-sol')
    assert.match(await page.getByTestId('tool-key-summary').innerText(), /coding-key.*Codex_pro.*sk-se••••9012/)
    assert.equal(await page.getByTestId('tool-detect-models').isDisabled(), false)
    await clean(page)
  } finally { await page.close() }
})

test('failed metadata on a different provider does not receive a delayed previous-provider response', async () => {
  const page = await open('keyOptions=1&keyMetadataPending=codex&keyMetadataFail=claude')
  try {
    await openToolConfiguration(page)
    await page.getByRole('tab', { name: 'Claude Code', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '当前密钥信息暂时没有读到' }).waitFor()
    await page.evaluate(async () => { window.v2Test.releaseKeyMetadata('codex'); await new Promise((resolve) => requestAnimationFrame(resolve)) })
    assert.equal(await page.getByTestId('tool-key-select').inputValue(), 'current')
    assert.match(await page.getByTestId('tool-key-summary').innerText(), /sk-cl••••5678/)
    assert.doesNotMatch(await page.getByTestId('tool-key-summary').innerText(), /sk-co••••1234|Codex_pro/)
    assert.equal(await page.getByTestId('tool-key-select').locator('option[value="automatic"]').isDisabled(), true)
    await clean(page)
  } finally { await page.close() }
})

test('official source saving does not prepare or replace an account key', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByRole('button', { name: 'ChatGPT 账号', exact: true }).click()
    await page.getByTestId('tool-save-config').click()
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /来源：ChatGPT 账号/)
    await page.getByTestId('tool-save-merge').click()
    await waitForSavedConfiguration(page)
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.find((entry) => entry.method === 'switchToOfficialAccount').args, ['codex', 'merge'])
    assert.equal(actions.some((entry) => ['saveConfig', 'configureManagedCliKeys', 'saveConfigWithAccountKey'].includes(entry.method)), false)
    await clean(page)
  } finally { await page.close() }
})

test('Chinese locale can be retried after a runtime failure without mistaking the saved preference for success', async () => {
  const page = await open('localeRetry=1')
  try {
    await openToolConfiguration(page)
    await page.getByRole('tab', { name: 'Codex 桌面端', exact: true }).click()
    await page.getByText('界面语言与文件夹权限', { exact: true }).click()
    await page.getByRole('button', { name: '检查中文界面', exact: true }).click()
    await page.getByText('已保存的语言设置：简体中文。如果仍显示英文，可再次启用中文界面。', { exact: true }).waitFor()
    await page.getByRole('button', { name: '启用中文界面', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '本次未确认中文界面生效' }).waitFor()
    assert.equal(await page.getByText('中文界面已启用，Codex 已重新打开。', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '启用中文界面', exact: true }).click()
    await page.getByText('中文界面已启用，Codex 已重新打开。', { exact: true }).waitFor()
    assert.equal(await page.getByText('中文设置已保存，但本次未确认中文界面生效。请再次启用中文界面以重试。', { exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'setCodexDesktopLocale').map((call) => call.args)), [['zh-CN'], ['zh-CN']])
    await clean(page)
  } finally { await page.close() }
})

test('asks once before opening Codex with the Chinese runtime patch and remembers the refusal', async () => {
  const page = await open('chineseAsk=1')
  try {
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.getByRole('heading', { name: '启用 Codex 中文界面？' }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'launchCodexDesktop').length), 0)

    await page.getByRole('button', { name: '保持当前语言', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'launchCodexDesktop'))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls
      .filter((call) => call.method === 'saveSettings' && call.args[0]?.codexDesktopChineseRuntimePatch !== undefined)
      .map((call) => call.args[0].codexDesktopChineseRuntimePatch)), ['disabled'])
    await page.getByRole('heading', { name: '启用 Codex 中文界面？' }).waitFor({ state: 'hidden' })

    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((call) => call.method === 'launchCodexDesktop').length === 2)
    assert.equal(await page.getByRole('heading', { name: '启用 Codex 中文界面？' }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('turns the Chinese runtime patch on through the locale path when the one-time question is accepted', async () => {
  const page = await open('chineseAsk=1')
  try {
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.getByRole('button', { name: '启用中文界面', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'launchCodexDesktop'))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'setCodexDesktopLocale').map((call) => call.args)), [['zh-CN']])
    assert.equal(await page.evaluate(() => window.v2Test.calls
      .some((call) => call.method === 'saveSettings' && call.args[0]?.codexDesktopChineseRuntimePatch !== undefined)), false)
    await clean(page)
  } finally { await page.close() }
})

test('ordinary desktop launch preserves the opened app and exposes a Chinese-locale warning', async () => {
  const page = await open('localeLaunchWarning=1')
  try {
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.getByText('Codex 已打开，但未确认中文界面生效，请在配置中再次启用。', { exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'launchCodexDesktop').map((call) => call.args)), [['open']])
    await clean(page)
  } finally { await page.close() }
})

test('save choices show both actions without writing and preserve focus and drafts when canceled', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`keyOptions=1&theme=${theme}`)
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openToolConfiguration(page)
      await page.getByRole('button', { name: 'ChatGPT 账号', exact: true }).click()
      assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'switchToOfficialAccount')), false)
      await page.getByRole('button', { name: '使用星芒账号', exact: true }).click()
      await page.getByTestId('tool-key-select').selectOption('202')
      await page.getByTestId('tool-save-config').click()
      const dialog = page.getByRole('dialog', { name: '保存这份配置？' })
      assert.match(await page.getByTestId('tool-save-merge').innerText(), /仅更新账号来源、密钥和模型\s*其他自定义设置会保留/)
      assert.match(await page.getByTestId('tool-save-reset').innerText(), /重置为初始状态/)
      assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).evaluate((element) => element === document.activeElement), true)
      assert.equal(await dialog.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return element.scrollWidth > element.clientWidth || [...element.querySelectorAll('.v2-save-options button')].some((button) => {
          const rect = button.getBoundingClientRect()
          return button.scrollWidth > button.clientWidth || rect.left < bounds.left || rect.right > bounds.right || rect.height < 44
        })
      }), false)
      await dialog.screenshot({ path: path.join(artifacts, `config-save-choices-${theme}.png`) })
      await page.getByTestId('tool-save-reset').click()
      const reset = page.getByRole('dialog', { name: '重置为初始状态？' })
      await reset.getByRole('button', { name: '返回选择' }).click()
      await dialog.waitFor()
      await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'hidden' })
      assert.equal(await page.getByTestId('tool-save-config').evaluate((element) => element === document.activeElement), true)
      assert.equal(await page.getByTestId('tool-key-select').inputValue(), '202')
      assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => ['saveConfig', 'saveConfigWithAccountKey', 'configureManagedCliKeys', 'switchToOfficialAccount'].includes(entry.method))), false)
      await clean(page)
    } finally { await page.close() }
  }
})

for (const mode of ['merge', 'reset']) test(`pending ${mode} configuration cannot close or write twice, then closes with a success toast`, async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('tool-key-select').selectOption('202')
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    await page.getByTestId('tool-save-config').click()
    if (mode === 'reset') await page.getByTestId('tool-save-reset').click()
    const confirmation = page.getByRole('dialog', { name: mode === 'merge' ? '保存这份配置？' : '重置为初始状态？' })
    const commit = mode === 'merge' ? confirmation.getByTestId('tool-save-merge') : confirmation.getByRole('button', { name: '备份并重置', exact: true })
    await commit.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfigWithAccountKey'))
    assert.equal(await commit.isDisabled(), true)
    assert.equal(await confirmation.locator('[data-modal-close]').isDisabled(), true)
    assert.equal(await confirmation.getByRole('button', { name: mode === 'merge' ? '取消' : '返回选择', exact: true }).isDisabled(), true)
    assert.equal(await page.getByTestId('config-dialog').locator('[data-modal-close]').isDisabled(), true)
    assert.equal(await page.getByTestId('tool-save-config').isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await confirmation.isVisible(), true)
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoToast(page, '配置保存成功')
    await page.evaluate(() => window.v2Test.releaseConfigSave())
    await waitForSavedConfiguration(page)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfigWithAccountKey').map((entry) => entry.args[0])), [
      { provider: 'codex', keyId: 202, model: 'fixture-model', mode },
    ])
    await clean(page)
  } finally { await page.close() }
})

test('configuration still closes after a saved write when the system scan refresh fails', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('tool-key-select').selectOption('202')
    await page.evaluate(() => { window.v2Test.fail = 'scanSystem' })
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-merge').click()
    await waitForSavedConfiguration(page)
    await waitForToast(page, '配置已保存，但最新状态没有读到。请重新检测，无需重复保存。')
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfigWithAccountKey').length), 1)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await clean(page)
  } finally { await page.close() }
})

// R-S8: 配置读不出来不再连坐整个工具页。以前这里只有一句会消失的 toast，
// 页面自身从头到尾没有任何痕迹。
test('a failed configuration re-read leaves the tool list standing and says which part failed', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('tool-key-select').selectOption('202')
    await page.evaluate(() => { window.v2Test.fail = 'getConfig' })
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-merge').click()
    await waitForSavedConfiguration(page)
    await page.getByTestId('home-config-failure').waitFor()
    for (const tool of ['claude', 'codex', 'grok', 'gemini']) {
      assert.equal(await page.getByTestId(`tool-row-${tool}`).count(), 1, `${tool} 那一行应该还在`)
    }
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfigWithAccountKey').length), 1)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await clean(page)
  } finally { await page.close() }
})

test('choosing a workspace refreshes the open configuration without showing a save success toast', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByRole('button', { name: '选择文件夹', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('input[readonly]')?.value === 'C:\\Selected Project' && !document.querySelector('.v2-config-controls').disabled)
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoToast(page, '配置保存成功')
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => ['saveConfig', 'saveConfigWithAccountKey', 'configureManagedCliKeys', 'switchToOfficialAccount'].includes(entry.method))), false)
    await clean(page)
  } finally { await page.close() }
})

for (const source of ['current', 'selected', 'automatic', 'manual', 'official', 'alreadyOfficial']) test(`reset configuration uses the selected ${source} source only after confirmation`, async () => {
  const page = await open(`keyOptions=1&sub2api=1${source === 'alreadyOfficial' ? '&official=1' : ''}`)
  try {
    await openToolConfiguration(page)
    if (source === 'selected') await page.getByTestId('tool-key-select').selectOption('202')
    if (source === 'automatic') {
      await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"] option[value="automatic"]')?.textContent.includes('Codex_pro'))
      await page.getByTestId('tool-key-select').selectOption('automatic')
    }
    if (source === 'official') await page.getByRole('button', { name: 'ChatGPT 账号', exact: true }).click()
    if (source === 'manual') {
      await page.getByRole('button', { name: '自己填写密钥', exact: true }).click()
      await page.getByLabel('星芒访问密钥').fill('local-fixture-secret')
      await page.getByTestId('tool-detect-models').click()
      await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    }
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-reset').click()
    const reset = page.getByRole('dialog', { name: '重置为初始状态？' })
    await reset.waitFor()
    const writes = () => page.evaluate(() => window.v2Test.calls.filter((entry) => ['saveConfig', 'saveConfigWithAccountKey', 'configureManagedCliKeys', 'switchToOfficialAccount'].includes(entry.method)))
    assert.deepEqual(await writes(), [])
    await reset.getByRole('button', { name: '备份并重置', exact: true }).click()
    await waitForSavedConfiguration(page)
    const actions = await writes()
    assert.equal(actions.length, 1)
    if (source === 'official' || source === 'alreadyOfficial') {
      assert.deepEqual(actions[0], { method: 'switchToOfficialAccount', args: ['codex', 'reset'] })
    } else if (source === 'automatic') {
      assert.deepEqual(actions[0], { method: 'configureManagedCliKeys', args: [{ providers: ['codex'], preferredModels: { codex: 'fixture-model' }, mode: 'reset', intent: 'explicit' }] })
    } else if (source === 'selected') {
      assert.deepEqual(actions[0], { method: 'saveConfigWithAccountKey', args: [{ provider: 'codex', keyId: 202, model: 'fixture-model', mode: 'reset' }] })
    } else {
      assert.deepEqual(actions[0], { method: 'saveConfig', args: [{ provider: 'codex', apiKey: source === 'manual' ? 'local-fixture-secret' : '', model: 'fixture-model', mode: 'reset' }] })
    }
    await clean(page)
  } finally { await page.close() }
})

test('failed reset retains the selected key and retries reset without silently merging', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('tool-key-select').selectOption('202')
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-reset').click()
    const reset = page.getByRole('dialog', { name: '重置为初始状态？' })
    await page.evaluate(() => { window.v2Test.fail = 'saveConfigWithAccountKey' })
    await reset.getByRole('button', { name: '备份并重置', exact: true }).click()
    await reset.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoToast(page, '配置保存成功')
    assert.match(await reset.getByTestId('tool-save-summary').innerText(), /custom-key[\s\S]*Custom group/)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await reset.getByRole('button', { name: '备份并重置', exact: true }).click()
    await waitForSavedConfiguration(page)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfigWithAccountKey').map((entry) => entry.args[0])), [
      { provider: 'codex', keyId: 202, model: 'fixture-model', mode: 'reset' },
      { provider: 'codex', keyId: 202, model: 'fixture-model', mode: 'reset' },
    ])
    await clean(page)
  } finally { await page.close() }
})

test('an unreadable Node version blocks the CLI install and says which step is blocking (R-G6)', async () => {
  const page = await open('nodeVersionUnknown=1')
  try {
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.getByTestId('tool-gemini-primary').click()
    await page.getByTestId('operation-error-detail').filter({ hasText: '版本无法识别' }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'installCli')), false)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await clean(page)
  } finally { await page.close() }
})

test('an unreadable Node version leaves the guide runtime step unfinished (R-G6)', async () => {
  const page = await open('nodeVersionUnknown=1&guest=1&missingConfig=1')
  try {
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-gemini').check()
    await page.getByTestId('guide-next').click()
    const guide = page.getByTestId('start-guide')
    await guide.getByText('命令行工具需要运行环境', { exact: true }).waitFor()
    await expect(page.getByTestId('guide-node')).toBeEnabled()
    await clean(page)
  } finally { await page.close() }
})

test('a deep link that cannot be read says so and points at the order page (R-B7)', async () => {
  const page = await open('deepLinkFail=1')
  try {
    const detail = page.getByTestId('operation-error-detail')
    await detail.waitFor()
    const text = await detail.innerText()
    assert.match(text, /回跳参数已过期/)
    assert.match(text, /订单/)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    assert.equal(await detail.count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('installing from the maintenance page writes the account Key and refreshes the home page (R-G3)', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const row = page.getByTestId('maintenance-tool-gemini')
    await row.getByText('未安装', { exact: true }).waitFor()
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length)
    await row.getByRole('button', { name: '安装', exact: true }).click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length > count, before)
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys'))
    assert.deepEqual(calls.at(-1).args[0].providers, ['gemini'])
    await row.getByText('已安装', { exact: true }).waitFor()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('tool-row-gemini').getByText('已配好').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 功能 N2 扩展：自检原来只测 Claude Code，另外三个工具配错了只能自己猜。
test('the connection self-check reports every CLI on its own, and an unconfigured tool is not a failure', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-idle').waitFor()
    await page.getByTestId('health-connection-run').click()
    // 每个工具一条结论，按注册表的展示顺序。
    const claude = page.getByTestId('health-connection-result-claude')
    await claude.waitFor()
    await claude.getByText('Claude Code · 正常', { exact: true }).waitFor()
    await claude.getByText('已用 claude-opus-5 发过一次最小请求', { exact: true }).waitFor()
    const codex = page.getByTestId('health-connection-result-codex')
    await codex.getByText('Codex CLI · 正常', { exact: true }).waitFor()
    // 只读探测的结论要如实说出来，不能照 Claude 那句「发过一次最小请求」套。
    await codex.getByText('已核对当前账号的可用模型清单，gpt-6-astra 在其中', { exact: true }).waitFor()
    for (const provider of ['gemini', 'grok']) {
      const row = page.getByTestId(`health-connection-result-${provider}`)
      await row.getByText('未配置', { exact: false }).waitFor()
      // 未配置不是失败：不给红色告警的 role，只给一条「去处理」。
      assert.equal(await row.getAttribute('role'), 'status')
      await row.getByRole('button', { name: '去处理', exact: true }).waitFor()
    }
    assert.equal(await page.getByTestId('health-connection-idle').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('a self-check failure is attributed per tool and never takes the other tools down with it', async () => {
  const page = await open('connectionFailure=1&connectionUnavailable=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').click()
    const claude = page.getByTestId('health-connection-result-claude')
    await claude.getByText('Claude Code · 分组与渠道', { exact: true }).waitFor()
    await claude.getByRole('button', { name: '去处理', exact: true }).click()
    await page.getByTestId('page-account').waitFor()
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    // 一个工具的 IPC 抛错只影响它自己那一条。
    await page.getByTestId('health-connection-run').click()
    await page.getByTestId('health-connection-error-codex').waitFor()
    await page.getByTestId('health-connection-result-gemini').waitFor()
    await clean(page)
  } finally { await page.close() }
})
