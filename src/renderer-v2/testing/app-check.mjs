import assert from 'node:assert/strict'
import { before, after } from 'node:test'
// Windows CI deals this file's tests across runners; see e2e/shard-tests.mjs.
import { test } from '../../../e2e/shard-tests.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import { createFixtureServer } from '../../../e2e/harness.mjs'
import { fixtureMountSliceMs, openFixturePage, waitForFixtureMount } from '../../../e2e/fixture-readiness.mjs'
import { enterWorkspaceWithoutAccount } from './guest-workspace.mjs'

let server, browser, origin
const artifacts = path.resolve('artifacts/renderer-v2-app')
// A first commit into #root is not enough here: this fixture also installs
// host globals the cases reach for, and a test that started before they were
// there saw `window.fixtureSupportQrCode is not a function` rather than a slow
// mount. The waiting itself - and the budget it runs on - is shared with the
// other fixtures.
//
// The budget this spends now belongs to one navigation rather than to the
// whole open: openFixturePage navigates again when a mount is lost, and the
// slices still add up to what a single wait used to get.
async function waitForFixtureReady(page, timeout = fixtureMountSliceMs()) {
  await waitForFixtureMount(page, {
    timeout,
    what: 'the renderer-v2 fixture',
    ready: () => typeof window.fixtureSupportQrCode === 'function'
      && Boolean(window.v2Test) && Boolean(window.xingmang)
      && (document.getElementById('root')?.childElementCount ?? 0) > 0,
  })
}

// Short toasts delete themselves 2400ms after they appear (toastDurationMs in
// src/renderer-v2/ui/feedback.tsx), so a locator that only starts looking after that deadline waits
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
  ;({ server, origin } = await createFixtureServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error' }))
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  // Pay the transform and dependency-optimisation cost once, here, instead of
  // charging it to whichever test happens to run first.
  await (await open()).close()
})
after(async () => { await browser?.close(); await server?.close() })
async function open(query = '', clock = false, initScript = null) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.addInitScript(recordToasts)
  if (initScript) await page.addInitScript(initScript)
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
  await openFixturePage(page, `${origin}/src/renderer-v2/testing/app.html?${query}`,
    (timeout) => waitForFixtureReady(page, timeout), { label: 'renderer-v2 fixture' })
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

// Count repaints of the workspace starfield only. Each repaint starts with a
// clearRect, so wrapping it on the page's own prototype counts frames without
// touching the component.
async function countStarfieldPaints(page, milliseconds) {
  await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype
    if (!window.__starfieldClear) window.__starfieldClear = proto.clearRect
    window.__starfieldPaints = 0
    proto.clearRect = function (...args) {
      if (this.canvas?.dataset.testid === 'shell-starfield') window.__starfieldPaints++
      return window.__starfieldClear.apply(this, args)
    }
  })
  await page.waitForTimeout(milliseconds)
  return page.evaluate(() => window.__starfieldPaints)
}

test('the workspace starfield stays still on low-end machines, runs at most 30 frames a second elsewhere, and stops while the window is in the background', async () => {
  const low = await open('lowEnd=1')
  try {
    await low.getByTestId('shell-starfield').waitFor()
    assert.equal(await low.evaluate(() => document.documentElement.dataset.lowEnd), 'true')
    // Let the fixture finish laying out: a resize legitimately repaints once.
    await low.waitForTimeout(1500)
    assert.equal(await countStarfieldPaints(low, 1000), 0, '低配电脑上工作台星空只画静态一帧')
    await clean(low)
  } finally { await low.close() }
  const page = await open()
  try {
    await page.getByTestId('shell-starfield').waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.lowEnd), 'false')
    await page.waitForTimeout(1500)
    const moving = await countStarfieldPaints(page, 1000)
    assert.ok(moving >= 3, `其它电脑上星空照旧在动：${moving}`)
    assert.ok(moving <= 40, `星空每秒最多约 30 帧：${moving}`)
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await page.waitForTimeout(200)
    assert.equal(await countStarfieldPaints(page, 800), 0, '窗口不在前台时星空停下')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    assert.ok(await countStarfieldPaints(page, 800) >= 2, '回到前台后星空接着动')
    await clean(page)
  } finally { await page.close() }
})

// Runs before the fixture mounts: the page reports a Mac the way Chromium does
// on macOS, and every state the startup windows reach is recorded as it is
// committed, so a frame laid out for the wrong system cannot slip by between
// two polls.
function recordAuthWindowOs() {
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => 'MacIntel' })
  window.__authWindowOs = []
  new MutationObserver(() => {
    for (const frame of document.querySelectorAll('.auth-window')) {
      const entry = `${frame.querySelector('main')?.dataset.testid ?? ''}:${frame.dataset.os}`
      if (window.__authWindowOs.at(-1) !== entry) window.__authWindowOs.push(entry)
    }
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-os'] })
}

// 红黄绿三个按钮压在 Mac 窗口左上角，顶栏得从第一帧起就让出位置。以前系统类型要等
// 画面出来之后才写到根节点上，启动时先写的还是 Windows，欢迎页头几帧就照 Windows 排版，
// 直到外观同步那次重绘才挪过去。
test('the macOS startup and welcome windows leave room for the traffic lights from their first frame', async () => {
  const page = await open('os=mac&guest=1', false, recordAuthWindowOs)
  try {
    await page.getByTestId('welcome-page').waitFor()
    const seen = await page.evaluate(() => window.__authWindowOs)
    assert.ok(seen.some((entry) => entry.startsWith('welcome-page:')), `应记录到欢迎页：${seen.join(', ')}`)
    assert.deepEqual(seen.filter((entry) => !entry.endsWith(':mac')), [], `启动页和欢迎页每一帧都按 Mac 排版：${seen.join(', ')}`)
    assert.equal(await page.getByTestId('window-titlebar').evaluate((element) => getComputedStyle(element).paddingLeft), '84px')
    await clean(page)
  } finally { await page.close() }
})

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
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出登录？', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
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
      await page.getByTestId('home-your-tools').locator('.xm-card-head').getByText(/(^| · )6 个已连接( · |$)/).waitFor()
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

test('external client install can be cancelled while downloading and returns to 安装 without an error', async () => {
  const page = await open('externalInstallPending=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByRole('button', { name: '安装', exact: true }).click()
    await row.getByText('正在下载安装包', { exact: true }).waitFor()
    await row.getByTestId('tool-workbuddy-cancel').click()
    await row.getByRole('button', { name: '安装', exact: true }).waitFor()
    assert.equal(await row.getByTestId('tool-workbuddy-cancel').count(), 0)
    assert.equal(await page.getByRole('alert').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'cancelExternalClientInstall').map((entry) => entry.args)), [['workbuddy']])
    await clean(page)
  } finally { await page.close() }
})

test('a refused external client cancel says why and lets the install finish', async () => {
  const page = await open('externalInstallPending=1&externalCancelRefused=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByRole('button', { name: '安装', exact: true }).click()
    await row.getByText('正在下载安装包', { exact: true }).waitFor()
    await row.getByTestId('tool-workbuddy-cancel').click()
    await page.getByText('正在安装 WorkBuddy，这一步中断会留下装了一半的程序，请等它结束。', { exact: true }).waitFor()
    assert.equal(await row.getByTestId('tool-workbuddy-cancel').textContent(), '取消')
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await row.getByRole('button', { name: '配置', exact: true }).waitFor()
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
    await buddy.getByRole('button', { name: '配置和更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '打开', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchExternalClient').map((entry) => entry.args[0])), ['claudeDesktop', 'workbuddy'])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureExternalTool')), false)
    await page.getByTestId('home-your-tools').locator('.xm-card-head').getByText(/(^| · )3 个已连接( · |$)/).waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 第三十一批 C：打开以后那一行先写「运行中」，后台悄悄核一次，三行按钮不跟着变灰、右上角不转圈。
test('opening a desktop client marks its row running and leaves the client rows usable while it rechecks', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    const opener = page.getByTestId('tool-workbuddy-primary')
    await row.getByText('已配好', { exact: true }).waitFor()
    await expect(opener).toBeEnabled()
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length)
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    await opener.click()
    await row.getByText(/运行中/).waitFor()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length > count, before)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').at(-1).args), [false])
    for (const id of ['tool-workbuddy-primary', 'home-client-claudeDesktop', 'home-client-opencode']) assert.equal(await page.getByTestId(id).isEnabled(), true, id)
    assert.notEqual(await page.getByTestId('home-rescan').getAttribute('aria-busy'), 'true')
    await page.evaluate(async () => {
      window.v2Test.releaseExternalScan()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await row.getByText(/运行中/).count(), 1)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchExternalClient').map((entry) => entry.args[0])), ['workbuddy'])
    await clean(page)
  } finally { await page.close() }
})

// 第三十九批 C：客户端的「打开」和命令行工具排同一个队。前面没东西在装时照旧写「正在打开客户端」；
// 正在装别的工具时写清在等谁装完，不再一直只写「正在打开客户端」。
test('opening a desktop client behind a running install says which install it waits for', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy&externalLaunchPending=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    const opener = page.getByTestId('tool-workbuddy-primary')
    await row.getByText('已配好', { exact: true }).waitFor()
    await opener.click()
    await row.getByText('正在打开客户端', { exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await row.getByText(/运行中/).waitFor()
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.evaluate(() => window.v2Test.holdNextInstall())
    await page.getByTestId('tool-gemini-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    await expect(opener).toBeEnabled()
    await opener.click()
    await row.getByText('正在等 Gemini CLI 安装完，安装完马上打开', { exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.releaseInstall())
    await page.getByTestId('tool-row-gemini').getByText('已配好').waitFor()
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await row.getByText('正在等 Gemini CLI 安装完，安装完马上打开', { exact: true }).waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchExternalClient').map((entry) => entry.args[0])), ['workbuddy', 'workbuddy'])
    await clean(page)
  } finally { await page.close() }
})

test('a background recheck that fails after opening a desktop client keeps the last result without an error bar', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    const opener = page.getByTestId('tool-workbuddy-primary')
    const unread = page.getByRole('alert').filter({ hasText: '客户端状态暂未读到' })
    await row.getByText('已配好', { exact: true }).waitFor()
    await expect(opener).toBeEnabled()
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length)
    await page.evaluate(() => { window.v2Test.fail = 'scanExternalClients' })
    await opener.click()
    await row.getByText(/运行中/).waitFor()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length > count, before)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await unread.count(), 0)
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 1)
    await expect(opener).toBeEnabled()
    // 客户自己点「重新检测」没读到的，照旧出红条。
    await page.getByTestId('home-rescan').click()
    await unread.waitFor()
    await page.evaluate(() => { window.v2Test.fail = '' })
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
    await ready.getByRole('button', { name: '配置和更多操作', exact: true }).click()
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
    await pending.getByRole('button', { name: '配置和更多操作', exact: true }).click()
    const pendingMenu = page.getByRole('menu')
    assert.equal(await pendingMenu.getByRole('menuitem', { name: '配置', exact: true }).count(), 0)
    assert.equal(await pendingMenu.getByRole('menuitem', { name: '打开', exact: true }).count(), 1)
    await page.keyboard.press('Escape')
    // 四个 CLI 行一直只有菜单入口，行上没有独立「配置」按钮，两类工具行现在给法一致。
    const cli = page.getByTestId('tool-row-codex')
    assert.equal(await cli.getByRole('button', { name: '配置', exact: true }).count(), 0)
    await cli.getByRole('button', { name: '配置和更多操作', exact: true }).click()
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

test('acceleration state is read once when idle, and again on entering the acceleration page', async () => {
  const page = await open()
  try {
    const reads = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getAccelerationState').length)
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'getAccelerationState'))
    const initial = await reads()
    await page.clock.install()
    await page.clock.runFor(60_000)
    assert.equal(await reads(), initial, '没在加速时不定时读状态')
    await page.getByTestId('nav-acceleration').click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'getAccelerationState').length > count, initial)
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

test('external client inventory waits for the first tool scan, and the home rescan forces a fresh one', async () => {
  const page = await open('holdFirstScan=1')
  try {
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'scanSystem'))
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length), 0, '首屏扫描没回来之前不盘点外部客户端')
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'scanExternalClients'))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').map((entry) => entry.args)), [[false]])
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length > 1)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').at(-1).args), [true])
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
    // 「N 个已连接」挂在「你的工具」标题旁，余额卡上不再写。
    const toolsHead = page.getByTestId('home-your-tools').locator('.xm-card-head')
    await toolsHead.getByText(/(^| · )4 个已连接( · |$)/).waitFor()
    assert.equal(await page.getByRole('heading', { name: '账户余额', exact: true }).locator('xpath=ancestor::section[1]').getByText(/已连接|等待连接/).count(), 0)
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length)
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    await page.getByTestId('saved-accounts-list').getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('heading', { name: /saved-user/ }).waitFor()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length > count, before)
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 0)
    await page.evaluate(() => window.v2Test.releaseExternalScan())
    await row.getByText('用的是别处的配置', { exact: true }).waitFor()
    await row.getByText('v1.2.3 · fixture-model', { exact: true }).waitFor()
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 0)
    // 一个都没连上时标题旁只写装了几个，不写「0 个已连接」。
    await page.waitForFunction(() => !document.querySelector('[data-testid="home-your-tools"] .xm-card-head')?.textContent?.includes('已连接'))
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
    await row.getByText('用的是别处的配置', { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.v2Test.releaseExternalScan()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 0)
    assert.equal(await row.getByText('用的是别处的配置', { exact: true }).count(), 1)
    await page.getByTestId('home-your-tools').locator('.xm-card-head').getByText(/(^| · )3 个已连接( · |$)/).waitFor()
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
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出登录？', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    assert.equal(await row.count(), 0)
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-codexDesktop').check()
    // 退出登录后本机 Key 还在、仍是当前账号来源，「确认连接」会被跳过（第十一批 3）。
    for (let step = 0; step < 2; step++) await page.getByTestId('guide-next').click()
    await page.locator('[data-guide-step="ready"]').waitFor()
    await page.getByTestId('guide-home').click()
    await row.getByText('用的是别处的配置', { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.v2Test.releaseExternalScan()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await row.getByText('已配好', { exact: true }).count(), 0)
    assert.equal(await row.getByText('用的是别处的配置', { exact: true }).count(), 1)
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
    assert.equal(await row.getByRole('button', { name: '换用别家模型', exact: true }).count(), 0)
    await row.getByRole('button', { name: '配置和更多操作', exact: true }).click()
    await page.getByTestId('home-codex-models').click()
    const dialog = page.getByTestId('config-dialog')
    await dialog.waitFor()
    assert.equal(await page.getByTestId('tool-save-config').isDisabled(), true)
    await page.getByTestId('tool-detect-models').click()
    await page.getByTestId('tool-default-model').selectOption('deepseek-fixture')
    const choices = await page.getByTestId('tool-default-model').locator('option').allTextContents()
    assert.equal(choices.some((label) => label === 'gpt-fixture'), false)
    await page.getByTestId('tool-save-config').click()
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
      await page.getByRole('button', { name: '关闭公告提示' }).click()
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

test('the launch button reuses the directory the tool was last opened in (N7)', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    const button = page.getByTestId('tool-claude-primary')
    await button.waitFor()
    // 最近用过的目录直接写在按钮上，用户点下去之前就知道会在哪里打开。
    assert.equal(await button.innerText(), '打开 my-app')
    assert.equal(await button.getAttribute('title'), '在 C:\\work\\my-app 打开')
    // 带下拉的那些行把按钮列放宽（app.css 的 :has 规则）。宽度不够时目录名会被
    // 省略号吃掉，按钮上就只剩「打开 my…」，那比不写目录还糟。
    const labels = await page.evaluate(() => ['claude', 'codex', 'gemini'].map((id) => {
      const label = document.querySelector(`[data-testid="tool-${id}-primary"] span`)
      return { id, text: label.textContent, clipped: label.scrollWidth - label.clientWidth }
    }))
    assert.deepEqual(labels, [
      { id: 'claude', text: '打开 my-app', clipped: 0 },
      { id: 'codex', text: '打开 codex-app', clipped: 0 },
      { id: 'gemini', text: '打开 a-very-lon…', clipped: 0 },
    ])
    await button.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const direct = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(direct.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args), [['claude', 'C:\\work\\my-app']])
    // 没记过目录的工具保持原来的行为：主按钮就是「打开」，旁边没有下拉。
    assert.equal(await page.getByTestId('tool-grok-primary').innerText(), '打开')
    assert.equal(await page.getByTestId('tool-grok-workspaces').count(), 0)
    assert.equal(direct.some((entry) => entry.method === 'chooseWorkspace'), false)

    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.getByTestId('tool-claude-workspaces').getByRole('button', { name: '换一个目录' }).click()
    const items = await page.getByRole('menuitem').allInnerTexts()
    // 同一个目录的两条记录只占一格,顺序按最近用过排,最后永远留着原来的选择器。
    assert.deepEqual(items, ['C:\\work\\my-app', 'C:\\work\\older-app', '选择其他目录…', '新建项目文件夹并打开'])
    await page.getByTestId('tool-claude-choose-workspace').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'chooseWorkspace'))
    const picked = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(picked.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args),
      [['claude', 'C:\\work\\my-app'], ['claude', 'C:\\Selected Project']])
    await clean(page)
  } finally { await page.close() }
})

test('the home recent card resumes the last conversation of that folder (#292)', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    // 卡片按时间倒序取前三条:claude:1(my-app)、claude:2(older-app)、claude:3(my-app)。
    // 续接是按目录找最近一条,所以 my-app 这个目录只有 claude:1 该有按钮,
    // 同目录更老的 claude:3 点下去会接到 claude:1,那比不给按钮还糟。
    const resume = page.getByTestId('home-recent-resume-claude:1')
    await resume.waitFor()
    assert.equal(await resume.innerText(), '接着聊')
    assert.equal(await resume.getAttribute('title'), '用 Claude Code 接着 my-app 里最近的一条对话')
    // 下面一行写「工具 · 文件夹名」，完整路径放小提示；时间写清是哪天（夹具的时间在 1970 年前后，随时区落在哪天不一定）。
    const row = page.getByTestId('home-recent-row-claude:1')
    assert.equal(await row.locator('.xm-row-desc').innerText(), 'Claude Code · my-app')
    assert.equal(await row.locator('.xm-row-desc span').getAttribute('title'), 'C:\\work\\my-app')
    assert.match(await row.locator('.xm-row-meta').innerText(), /^19(69|70)年\d{1,2}月\d{1,2}日$/)
    assert.equal(await page.getByTestId('home-recent-resume-claude:2').count(), 1)
    assert.equal(await page.getByTestId('home-recent-resume-claude:3').count(), 0)
    // 没有按钮的那一行仍然能跳去记录页,和以前一样。
    assert.equal(await page.getByTestId('home-recent-card').getByRole('button', { name: '查看', exact: true }).count(), 3)

    await resume.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args),
      [['claude', 'C:\\work\\my-app', 'resumeLast']])
    // 目录是记录里现成的,不该再弹一次目录选择器。
    assert.equal(calls.some((entry) => entry.method === 'chooseWorkspace'), false)
    await clean(page)
  } finally { await page.close() }
})

// 目录被删掉或搬走之后接不上上次的对话,点了只会得到一条报错。按钮留在原位
// 但按不动,旁边说一句为什么。
test('the home recent card greys out a row whose folder is gone', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    const missing = page.getByTestId('home-recent-resume-claude:2')
    await missing.waitFor()
    assert.equal(await missing.isDisabled(), true)
    assert.equal(await missing.getAttribute('title'), '这个文件夹已经不在了，接不上上次的对话')
    assert.equal(await page.getByTestId('home-recent-missing-claude:2').innerText(), '文件夹已不存在')
    // 目录还在的那一行不受影响,也不该多出这句说明。
    assert.equal(await page.getByTestId('home-recent-resume-claude:1').isDisabled(), false)
    assert.equal(await page.getByTestId('home-recent-missing-claude:1').count(), 0)

    await missing.click({ force: true }).catch(() => {})
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli')), false)
    await clean(page)
  } finally { await page.close() }
})

// 只装了 Codex 桌面端、或卸掉过某个工具时，「最近」里照样有那家的对话。「接着聊」走的是同一个「打开」，
// 那家没装，点了只会报「工具尚未安装，请先完成准备。」，所以不给这颗按钮；装上以后再给（第四十一批 A）。
test('the home recent card offers no resume for a tool that is not installed (第四十一批 A)', async () => {
  const page = await open('desktopOnly=1&recentWorkspaces=1')
  try {
    // 等检测回来再看：那之前还不知道装没装，按钮照旧摆着、灰着等。
    await expect(page.getByTestId('home-available').getByTestId('tool-claude-primary')).toHaveText('安装')
    // 在桌面端里聊过的一条也记在 Codex 名下，排在最前面；接着聊开的却是 Codex CLI，它没装。
    await page.evaluate(() => window.v2Test.addRecentSession('9', 'codex', 'C:\\work\\desk-app', 500))
    await page.getByTestId('home-rescan').click()
    const codex = page.getByTestId('home-recent-row-codex:9')
    await codex.waitFor()
    const card = page.getByTestId('home-recent-card')
    assert.equal(await card.locator('[data-testid^="home-recent-resume-"]').count(), 0)
    // 这一行的字、「打开文件夹」「查看」都照旧。
    assert.equal(await codex.locator('.xm-row-desc').innerText(), 'Codex CLI · desk-app')
    assert.equal(await page.getByTestId('home-recent-open-directory-codex:9').count(), 1)
    assert.equal(await card.getByRole('button', { name: '查看', exact: true }).count(), 3)

    // 装上 Claude Code（星芒先替客户准备好 Node.js）：它那条的按钮回来，Codex 那条照旧没有。
    await page.getByTestId('tool-claude-primary').click()
    const resume = page.getByTestId('home-recent-resume-claude:1')
    await resume.waitFor()
    assert.equal(await page.getByTestId('home-recent-resume-codex:9').count(), 0)
    await page.waitForFunction(() => document.querySelector('[data-testid="home-recent-resume-claude:1"]')?.disabled === false)
    await resume.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args),
      [['claude', 'C:\\work\\my-app', 'resumeLast']])
    assert.equal(calls.some((entry) => entry.method === 'chooseWorkspace'), false)
    await clean(page)
  } finally { await page.close() }
})

test('the records page opens the folder a record was made in (第七批 8)', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await page.getByTestId('nav-sessions').click()
    const open1 = page.getByTestId('sessions-open-directory-claude:1')
    await open1.waitFor()
    assert.equal(await open1.innerText(), '打开文件夹')
    assert.equal(await open1.getAttribute('title'), '在文件管理器里打开 C:\\work\\my-app')

    // 目录已经没了的那一行按钮留在原位但按不动,和旁边的「接着聊」同一个口径。
    const gone = page.getByTestId('sessions-open-directory-claude:2')
    assert.equal(await gone.isDisabled(), true)
    assert.equal(await gone.getAttribute('title'), '这条记录的文件夹已经不在了，打不开')

    await open1.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'openProviderSessionDirectory'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    // 只发会话 id:路径由主进程从记录里取,渲染层没有办法点名要打开哪个目录。
    assert.deepEqual(calls.filter((entry) => entry.method === 'openProviderSessionDirectory').map((entry) => entry.args),
      [['claude:1']])
    await clean(page)
  } finally { await page.close() }
})

// 第八批 5 原来把只有摘要的那行「查看记录」置灰；整行能点开以后，详情里照样看工具、文件夹、模型，正文位置说明只有摘要。
test('a summary-only record still opens, says only the summary is left and offers no export', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await page.getByTestId('nav-sessions').click()
    const summaryOnly = page.getByTestId('sessions-view-codex:4')
    await summaryOnly.waitFor()
    assert.equal(await summaryOnly.isDisabled(), false)
    await summaryOnly.click()
    const drawer = page.getByTestId('session-detail-drawer')
    assert.equal(await drawer.getByTestId('session-detail-summary-only').innerText(), '这条记录只有摘要，对话原文已经不在这台电脑上了')
    assert.equal(await drawer.getByTestId('session-detail-export').isDisabled(), true)
    // 原文已经不在了，不去读。
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'getProviderSessionDetail' && entry.args[0] === 'codex:4')), false)
    await clean(page)
  } finally { await page.close() }
})

// 整行可点的行，右边那一格里只有按钮各管各的：「可以试试」的小箭头、没有「接着聊」那一行留出的空位，点了照样打开整行。
test('the arrow of a home suggestion and the empty slot of a record row still open the row', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await page.evaluate(() => {
      window.xingmang.listProviderExtensions = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', items: [], warnings: [],
        capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
      })
      window.xingmang.checkProviderMcpHealth = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', supported: true, reason: null, entries: [],
      })
    })
    // 「最近」里已经有 Codex 的记录：不再出「第一次用 Codex？」。
    await page.getByTestId('home-recent-row-claude:1').waitFor()
    assert.equal(await page.getByTestId('home-suggestion-codex').count(), 0)
    // 小箭头本身不接点击，鼠标点在它的位置上，落到的是整行那颗按钮。
    const arrow = await page.getByTestId('home-suggestion-mcp').locator('.xm-row-actions svg').boundingBox()
    assert.ok(arrow, 'the arrow is on the row')
    await page.mouse.click(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2)
    await page.getByTestId('page-mcp').waitFor()

    await page.getByTestId('nav-sessions').click()
    // 记录行的标题是图标加文字：两者之间要留空、上下居中，不能贴在一起。
    const title = page.locator('[data-testid^="sessions-row-"] .xm-row-open').first()
    await title.waitFor()
    const layout = await title.evaluate((button) => {
      const icon = button.firstElementChild.getBoundingClientRect()
      const range = document.createRange()
      range.selectNodeContents([...button.childNodes].find((node) => node.nodeType === Node.TEXT_NODE))
      const text = range.getBoundingClientRect()
      return { gap: text.left - icon.right, offset: Math.abs((text.top + text.bottom) / 2 - (icon.top + icon.bottom) / 2) }
    })
    assert.ok(layout.gap >= 6, `icon and title are ${layout.gap}px apart`)
    assert.ok(layout.offset <= 2, `icon and title centres are ${layout.offset}px apart`)
    const placeholder = page.locator('[data-testid^="sessions-row-"] .v2-row-action-placeholder').first()
    await placeholder.waitFor({ state: 'attached' })
    const box = await placeholder.boundingBox()
    assert.ok(box, 'the placeholder keeps its width')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.getByTestId('session-detail-drawer').waitFor()
    await clean(page)
  } finally { await page.close() }
  const fresh = await open('allInstalled=1')
  try {
    await fresh.getByTestId('home-suggestion-codex').waitFor()
    await clean(fresh)
  } finally { await fresh.close() }
})

test('an exported report can be revealed in its folder and says so when it moved (第八批 5)', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.getByTestId('nav-health').click()
    const health = page.getByTestId('page-health')
    await health.waitFor()
    await health.getByRole('button', { name: '导出检查报告', exact: true }).click()
    await health.getByText('诊断报告已导出：C:\\Fixture\\xingmang-diagnostics.txt', { exact: true }).waitFor()
    const reveal = health.getByTestId('result-notice-reveal')
    assert.equal(await reveal.innerText(), '打开所在位置')
    await reveal.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'revealExportedFile'))
    // 交回主进程的就是导出返回的那条路径，界面不拼任何别的位置。
    assert.deepEqual(
      (await page.evaluate(() => window.v2Test.calls)).filter((entry) => entry.method === 'revealExportedFile').map((entry) => entry.args),
      [['C:\\Fixture\\xingmang-diagnostics.txt']],
    )

    // 文件被挪走了：按钮旁边说一句，上面那句「已导出」和路径留着，用户还能照着找。
    await page.evaluate(() => { window.v2Test.fail = 'revealExportedFile'; window.v2Test.failMessage = '导出的文件已经不在原来的位置了，可能被移动或删除。' })
    await reveal.click()
    await health.getByText('导出的文件已经不在原来的位置了，可能被移动或删除。').waitFor()
    await health.getByText('诊断报告已导出：C:\\Fixture\\xingmang-diagnostics.txt', { exact: true }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = '' })
    await clean(page)
  } finally { await page.close() }
})

test('the home recent card opens a record folder and says so when it cannot', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    const button = page.getByTestId('home-recent-open-directory-claude:1')
    await button.waitFor()
    assert.equal(await button.getAttribute('title'), '在文件管理器里打开 C:\\work\\my-app')
    assert.equal(await page.getByTestId('home-recent-open-directory-claude:2').isDisabled(), true)

    // 打不开时只提示一句,不把整张卡打回「记录暂时没有读到」。
    await page.evaluate(() => { window.v2Test.fail = 'openProviderSessionDirectory'; window.v2Test.failMessage = '这条记录的文件夹已经不在了。' })
    await button.click()
    await page.getByText('这条记录的文件夹已经不在了。').waitFor()
    assert.equal(await page.getByTestId('home-recent-card').count(), 1)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await clean(page)
  } finally { await page.close() }
})

// 全面检测 Q29：个人中心停在「我的订单」时，回首页再点「充值」要回到充值那一页。
// 以前 App 里记的分页值没变（还是上次的「充值」），个人中心就不切。
test('the home recharge button reopens the recharge tab even after another account tab was chosen', async () => {
  const page = await open()
  try {
    const recharge = page.locator('.v2-balance-actions').getByRole('button', { name: '充值', exact: true })
    const selected = (name) => page.getByTestId('account-tabs').getByRole('tab', { name, exact: true }).getAttribute('aria-selected')
    await recharge.click()
    await page.getByTestId('account-tabs').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="account-tabs"] [aria-selected="true"]')?.textContent === '充值与订阅')
    await page.getByTestId('account-tabs').getByRole('tab', { name: '我的订单', exact: true }).click()
    assert.equal(await selected('我的订单'), 'true')
    await page.getByTestId('nav-home').click()
    await recharge.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="account-tabs"] [aria-selected="true"]')?.textContent === '充值与订阅')
    assert.equal(await selected('我的订单'), 'false')
    // 默认夹具没接充值、订单那几个读取（会记进 unexpected），这里只看有没有报错。
    assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  } finally { await page.close() }
})

test('home reuses the recent list instead of rescanning session folders on every visit', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  // 首页读的是 pageSize 60 那一份;记录页自己读的是 20 / 100,不能混进来数。
  const homeReads = () => page.evaluate(() => window.v2Test.calls
    .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === 60).length)
  try {
    await page.getByTestId('home-recent-card').waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'listProviderSessions'))
    assert.equal(await homeReads(), 1)

    // 离开首页组件就卸载,回来又挂载一次。以前每回来一次就把三家 CLI 的会话
    // 目录整个走一遍,现在一分钟内直接复用上一次的结果。
    await page.getByTestId('nav-sessions').click()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('home-recent-card').waitFor()
    assert.equal(await homeReads(), 1)
    // 复用不等于空白:卡片上还是那三条。
    assert.equal(await page.getByTestId('home-recent-resume-claude:1').count(), 1)

    // 用户主动「重新检测」是在说「我要最新的」,这一下必须真去读。
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => window.v2Test.calls
      .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === 60).length === 2)
    await clean(page)
  } finally { await page.close() }
})

// 首页一直开着就不会重新挂载。以前从这里打开工具、在终端里聊完再切回来，「最近」一直是打开前那份：
// 刚聊的那条不在，「接着聊」还挂在同一文件夹更早的那条上，点下去接上的却是刚聊的那条（第四十一批 C）。
test('home re-reads the recent list when the window comes back after a tool was opened', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  const homeReads = () => page.evaluate(() => window.v2Test.calls
    .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === 60).length)
  // 等一会儿再数：React 处理完这一下、该读的已经发出去了，才能说「没读」。
  const focusWindow = () => page.evaluate(() => {
    window.dispatchEvent(new Event('focus'))
    return new Promise((resolve) => setTimeout(resolve, 100))
  })
  try {
    await page.getByTestId('home-recent-resume-claude:1').waitFor()
    assert.equal(await homeReads(), 1)
    // 一分钟内、又没打开过工具：回到窗口还是那一份，不读盘。
    await focusWindow()
    assert.equal(await homeReads(), 1)

    await page.getByTestId('tool-claude-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    // 在终端里聊了一条，然后切回星芒。
    await page.evaluate(() => window.v2Test.addRecentSession('6', 'claude', 'C:\\work\\my-app', 500))
    assert.equal(await page.getByTestId('home-recent-resume-claude:1').count(), 1)
    await focusWindow()
    await page.getByTestId('home-recent-resume-claude:6').waitFor()
    assert.equal(await homeReads(), 2)
    // 刚聊的排第一；my-app 里更早的 claude:1 不再挂「接着聊」，不会再有一颗接到别的对话上的按钮。
    assert.equal(await page.locator('[data-testid^="home-recent-row-"]').first().getAttribute('data-testid'), 'home-recent-row-claude:6')
    assert.equal(await page.getByTestId('home-recent-resume-claude:1').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('home re-reads the recent list when the window is shown again, so the open button names the folder just used', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  const homeReads = () => page.evaluate(() => window.v2Test.calls
    .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === 60).length)
  const visibility = (value) => page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
    return new Promise((resolve) => setTimeout(resolve, 100))
  }, value)
  try {
    const button = page.getByTestId('tool-claude-primary')
    await button.waitFor()
    assert.equal(await button.getAttribute('title'), '在 C:\\work\\my-app 打开')
    // 这次换了个文件夹：「换一个目录」→「选择其他目录…」，在那儿聊了一条。
    await page.getByTestId('tool-claude-workspaces').getByRole('button', { name: '换一个目录' }).click()
    await page.getByTestId('tool-claude-choose-workspace').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.evaluate(() => window.v2Test.addRecentSession('6', 'claude', 'C:\\Selected Project', 500))
    assert.equal(await button.getAttribute('title'), '在 C:\\work\\my-app 打开')
    // 缩在托盘里、窗口看不见的时候不读。
    await visibility('hidden')
    assert.equal(await homeReads(), 1)
    await visibility('visible')
    await expect(button).toHaveAttribute('title', '在 C:\\Selected Project 打开')
    assert.equal(await homeReads(), 2)
    await clean(page)
  } finally { await page.close() }
})

// 第四十二批 B：记录页读两份，列表本身（pageSize 20）和定「接着聊」挂在哪条上的最新 100 条；首页那份是 60，不混着数。
// 开发模式挂两遍会让第一次进来读几次不固定，所以只数「多了几次」。
async function recordsReads(page) {
  return page.evaluate(() => [20, 100].map((size) => window.v2Test.calls
    .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === size).length))
}

// 记录页去过一次以后，在终端里聊完再回来还是第一次进来时那份：刚聊的那条不在，「接着聊」还挂在同一文件夹更早的那条上，
// 而 Claude Code 按文件夹接最近一条（#292），点下去接上的是刚聊的那条。
test('the records page reads both lists again when it is shown again, so 接着聊 sits on the newest record of the folder', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await page.getByTestId('nav-sessions').click()
    await page.getByTestId('sessions-resume-claude:1').waitFor()
    const [list, latest] = await recordsReads(page)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
    // 在首页打开 Claude Code，在 my-app 里新聊了一条。
    await page.evaluate(() => window.v2Test.addRecentSession('6', 'claude', 'C:\\work\\my-app', 500))
    await page.getByTestId('nav-sessions').click()
    await page.getByTestId('sessions-resume-claude:6').waitFor()
    assert.deepEqual(await recordsReads(page), [list + 1, latest + 1])
    // 刚聊的排第一、带「接着聊」；my-app 里更早的 claude:1 不再带，不会接到别的对话上。
    assert.equal(await page.locator('[data-testid^="sessions-row-"]').first().getAttribute('data-testid'), 'sessions-row-claude:6')
    assert.equal(await page.getByTestId('sessions-resume-claude:1').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 停在记录页、窗口回到前面时也重读，离上次读不到半分钟不读，窗口藏着时不读。时钟停着，等的那一下在测试这边等。
test('the records page reads again when the window comes back after half a minute, but not sooner and not while hidden', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1', true)
  async function foreground(event) {
    await page.evaluate((name) => {
      if (name === 'focus') window.dispatchEvent(new Event('focus'))
      else document.dispatchEvent(new Event('visibilitychange'))
    }, event)
    await page.waitForTimeout(100)
  }
  async function visibility(state) {
    await page.evaluate((value) => Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value }), state)
    await foreground('visibilitychange')
  }
  try {
    await page.getByTestId('nav-sessions').click()
    // 记录页是懒加载的：React 换下「正在加载」前要等那个占位摆满 300 毫秒（setTimeout），时钟停着就一直等，往前拨一秒。
    await page.clock.runFor(1_000)
    await page.getByTestId('sessions-resume-claude:1').waitFor()
    const [list, latest] = await recordsReads(page)
    // 刚进来：半分钟内回到窗口不读。
    await foreground('focus')
    assert.deepEqual(await recordsReads(page), [list, latest])
    await page.clock.fastForward(30_000)
    await page.evaluate(() => window.v2Test.addRecentSession('6', 'claude', 'C:\\work\\my-app', 500))
    await foreground('focus')
    await page.getByTestId('sessions-resume-claude:6').waitFor()
    assert.deepEqual(await recordsReads(page), [list + 1, latest + 1])
    // 马上又回来一次：不读。
    await foreground('focus')
    assert.deepEqual(await recordsReads(page), [list + 1, latest + 1])
    // 缩在托盘里时不读；过了半分钟再显示出来，读。
    await page.clock.fastForward(30_000)
    await visibility('hidden')
    assert.deepEqual(await recordsReads(page), [list + 1, latest + 1])
    await visibility('visible')
    await expect.poll(() => recordsReads(page)).toEqual([list + 2, latest + 2])
    // 换到别的页以后，窗口回到前面不替藏着的记录页读。
    await page.clock.fastForward(30_000)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
    await foreground('focus')
    assert.deepEqual(await recordsReads(page), [list + 2, latest + 2])
    await clean(page)
  } finally { await page.close() }
})

// 在记录页点「接着聊」，在终端里聊完切回来：不用等半分钟，回到窗口那一下就重读，开着的详情里也是新的对话，
// 读的时候不闪成「正在读取对话…」。
test('after 接着聊 on the records page the next return to the window reads again at once, open record included', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  async function focusWindow() {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForTimeout(100)
  }
  try {
    await page.evaluate(() => {
      window.__transcript = [{ role: 'user', text: '上回问到这里' }]
      window.xingmang.getProviderSessionDetail = async (id) => ({
        session: { id, provider: 'claude', nativeId: '1', title: '会话 1', cwd: 'C:\\work\\my-app', model: 'fixture-model', archived: false, readonly: true,
          createdAt: 400, updatedAt: 400, messageCount: window.__transcript.length, sourcePath: 'C:\\Fixture\\1.jsonl', detailAvailable: true, cwdExists: true },
        messages: window.__transcript.map((message) => ({ ...message })),
        messageStats: { total: window.__transcript.length, user: window.__transcript.length, assistant: 0, system: 0, other: 0, invalidLines: 0 },
        messagesTruncated: false, sourceTruncated: false,
      })
    })
    await page.getByTestId('nav-sessions').click()
    await page.getByTestId('sessions-view-claude:1').click()
    const drawer = page.getByTestId('session-detail-drawer')
    await drawer.getByText('上回问到这里', { exact: true }).waitFor()
    const [list, latest] = await recordsReads(page)
    // 刚进来：回到窗口不读。
    await focusWindow()
    assert.deepEqual(await recordsReads(page), [list, latest])
    await drawer.getByTestId('session-detail-resume').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.waitForFunction(() => document.querySelector('[data-testid="session-detail-resume"]')?.disabled === false)
    // 在终端里又问了一句，然后切回星芒。
    await page.evaluate(() => {
      window.__transcript.push({ role: 'user', text: '刚在终端里问的' })
      window.__sawTranscriptLoading = false
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="session-detail-drawer"]')?.textContent?.includes('正在读取对话')) window.__sawTranscriptLoading = true
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await focusWindow()
    await drawer.getByText('刚在终端里问的', { exact: true }).waitFor()
    assert.deepEqual(await recordsReads(page), [list + 1, latest + 1])
    await expect(drawer.getByText('上回问到这里', { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.__sawTranscriptLoading), false)
    await clean(page)
  } finally { await page.close() }
})

test('home shows the last usage right away instead of asking the account backend on every visit', async () => {
  const page = await open('allInstalled=1')
  const usageReads = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getAccountUsage').length)
  const usageLine = page.locator('.v2-balance-usage p')
  try {
    await expect(usageLine).toContainText('约还能用')
    // 本月、最近 7 天各一次；开发模式的 StrictMode 挂载两遍也只落到这一次。
    assert.equal(await usageReads(), 2)

    // 首页离开就卸载，以前每回来一次就再查两次、那一栏先显示「正在读取用量」。
    await page.evaluate(() => {
      window.__usageBlank = false
      new MutationObserver(() => {
        if (document.querySelector('.v2-balance-usage p')?.textContent?.includes('正在读取用量')) window.__usageBlank = true
      }).observe(document.body, { childList: true, subtree: true, characterData: true })
    })
    await page.getByTestId('nav-sessions').click()
    await page.getByTestId('nav-home').click()
    await expect(usageLine).toContainText('约还能用')
    assert.equal(await page.evaluate(() => window.__usageBlank), false)
    assert.equal(await usageReads(), 2)
    await clean(page)
  } finally { await page.close() }
})

test('archiving a session on the sessions page refreshes the home recent card right away', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&sessionArchive=1')
  const homeReads = () => page.evaluate(() => window.v2Test.calls
    .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === 60).length)
  try {
    await page.getByTestId('home-recent-resume-claude:1').waitFor()
    assert.equal(await homeReads(), 1)

    await page.getByTestId('nav-sessions').click()
    await page.getByTestId('sessions-view-claude:1').click()
    await page.getByTestId('session-detail-drawer').getByRole('button', { name: '归档', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'archiveSession'))

    // 首页那份「最近」缓存一分钟；以前归档之后回首页，刚归档的那条还挂着「接着聊」（#544）。
    await page.getByTestId('nav-home').click()
    await page.getByTestId('home-recent-card').waitFor()
    await page.waitForFunction(() => window.v2Test.calls
      .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === 60).length === 2)
    await page.waitForFunction(() => !document.querySelector('[data-testid="home-recent-resume-claude:1"]'))
    // 同一目录里的 claude:3 现在是最近一条，「接着聊」挪到它身上。
    await page.getByTestId('home-recent-resume-claude:3').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('deleting a session asks first, then removes it from the list and the home recent card', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&sessionDelete=1')
  try {
    await page.getByTestId('home-recent-resume-claude:1').waitFor()
    await page.getByTestId('nav-sessions').click()
    // 只有能删的那家才给按钮：Gemini 这条在夹具里没开删除。
    await page.getByTestId('sessions-view-gemini:5').click()
    assert.equal(await page.getByTestId('session-detail-delete').count(), 0)
    await page.getByTestId('session-detail-drawer').getByRole('button', { name: '关闭' }).first().click()

    await page.getByTestId('sessions-view-claude:1').click()
    await page.getByTestId('session-detail-delete').click()
    const confirm = page.getByTestId('session-delete-confirm')
    await confirm.waitFor()
    assert.match(await confirm.textContent(), /删了就找不回来/)
    // 「先不删」什么都不动。
    await confirm.getByRole('button', { name: '先不删' }).click()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'deleteProviderSession')), false)

    await page.getByTestId('session-detail-delete').click()
    await page.getByTestId('session-delete-confirm').getByRole('button', { name: '彻底删除' }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'deleteProviderSession'))
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'deleteProviderSession'))
    assert.deepEqual(calls.map((entry) => entry.args), [['claude:1']])
    await page.waitForFunction(() => !document.querySelector('[data-testid="sessions-row-claude:1"]'))

    await page.getByTestId('nav-home').click()
    await page.getByTestId('home-recent-card').waitFor()
    await page.waitForFunction(() => !document.querySelector('[data-testid="home-recent-resume-claude:1"]'))
    await page.getByTestId('home-recent-resume-claude:3').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('a new user can open a CLI in a folder the app creates, without the directory picker', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    // 没有最近目录时「打开」旁边没有下拉，入口在「更多操作」里。
    assert.equal(await page.getByTestId('tool-codex-workspaces').count(), 0)
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByTestId('tool-codex-new-workspace').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'chooseWorkspace').map((entry) => entry.args), [[{ createStarter: true }]])
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args),
      [['codex', 'C:\\Users\\fixture\\Documents\\XingmangProjects\\my-project']])
    // Codex 桌面端自己管工作区，不给这个入口。
    await page.keyboard.press('Escape')
    await page.getByTestId('tool-row-codexDesktop').getByRole('button', { name: '更多操作' }).click()
    assert.equal(await page.getByTestId('tool-codexDesktop-new-workspace').count(), 0)
    await page.keyboard.press('Escape')
    await clean(page)
  } finally { await page.close() }
})

test('a folder picked for one CLI opens the others there without asking again', async () => {
  const page = await open('launchRemembers=1')
  try {
    await page.getByTestId('tool-codex-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const claude = page.getByTestId('tool-claude-primary')
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.textContent?.includes('打开 Selected P'))
    await claude.click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === 2)
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.equal(calls.filter((entry) => entry.method === 'chooseWorkspace').length, 1)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args.slice(0, 2)), [['codex', 'C:\\Selected Project'], ['claude', 'C:\\Selected Project']])
    await clean(page)
  } finally { await page.close() }
})

// 第四十批 A：托盘「已安装的工具」和 Ctrl+1～5 以前什么文件夹都不带，每次都弹选择框；
// 现在和首页那颗「打开 xx」挑同一个文件夹，都没有才弹。
test('the tray and Ctrl+1-5 open a CLI in the folder its home button shows', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  const launches = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args))
  const choices = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'chooseWorkspace').length)
  async function settled(id, count) {
    await page.waitForFunction((expected) => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === expected, count)
    await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"]`)?.disabled, `tool-${id}-primary`)
  }
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.textContent === '打开 my-app')
    await page.evaluate(() => window.v2Test.emit('onLaunchTool', 'claude'))
    await settled('claude', 1)
    // Ctrl+2 是工具表里的第二个，Codex CLI。
    await page.keyboard.press('Control+2')
    await settled('codex', 2)
    assert.deepEqual(await launches(), [['claude', 'C:\\work\\my-app'], ['codex', 'C:\\work\\codex-app']])
    assert.equal(await choices(), 0)

    // Grok 没有记录，也没选过文件夹：照旧先问。
    await page.keyboard.press('Control+5')
    await settled('grok', 3)
    assert.deepEqual((await launches())[2], ['grok', 'C:\\Selected Project'])
    assert.equal(await choices(), 1)

    // Codex 桌面端自己管工作区，从托盘打开和以前一样。
    await page.evaluate(() => window.v2Test.emit('onLaunchTool', 'codexDesktop'))
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop'))
    const desktop = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCodexDesktop').map((entry) => entry.args))
    assert.deepEqual(desktop, [['open']])
    assert.equal(await choices(), 1)
    await clean(page)
  } finally { await page.close() }
})

test('a folder picked on home opens CLIs from the tray and shortcuts, even when records cannot be read', async () => {
  const page = await open('launchRemembers=1')
  const sessionReads = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'listProviderSessions').length)
  try {
    await page.getByTestId('tool-codex-primary').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.textContent?.includes('打开 Selected P'))
    // 上一次打开收完尾再发托盘事件：还在打开时，requestLaunch 会把新来的请求直接丢掉。
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-codex-primary"]')?.disabled)
    // 记录读不到就只看上次选过的文件夹，不因此弹选择框，也不报错。
    const readsBefore = await sessionReads()
    await page.evaluate(() => { window.v2Test.fail = 'listProviderSessions' })
    await page.evaluate(() => window.v2Test.emit('onLaunchTool', 'claude'))
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === 2)
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    assert.equal(await sessionReads(), readsBefore + 1)
    await page.evaluate(() => { window.v2Test.fail = '' })

    await page.keyboard.press('Control+1')
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === 3)
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.equal(calls.filter((entry) => entry.method === 'chooseWorkspace').length, 1)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args.slice(0, 2)),
      [['codex', 'C:\\Selected Project'], ['claude', 'C:\\Selected Project'], ['claude', 'C:\\Selected Project']])
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the tray says the remembered folder is gone and asks for another one', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&workspaceGone=1')
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.textContent === '打开 my-app')
    await page.evaluate(() => window.v2Test.emit('onLaunchTool', 'claude'))
    await waitForToast(page, '上次用的目录已经找不到了，请重新选择。')
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === 2)
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args),
      [['claude', 'C:\\work\\my-app'], ['claude', 'C:\\Selected Project']])
    assert.equal(calls.filter((entry) => entry.method === 'chooseWorkspace').length, 1)
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
// 第二十六批 D：系统给的英文原话（EPERM……）不再上屏，工具行和「安装卸载」页都换成同一句中文。
test('an English probe failure reads as a plain Chinese sentence on the home row and the maintenance page', async () => {
  const page = await open('detectionFailed=eperm')
  try {
    const sentence = '没有权限读取这个工具的文件，常见是安全软件拦了。点「重新检测」再试；还不行请在「反馈」页导出报告发给客服。'
    const row = page.getByTestId('tool-row-claude')
    await row.getByText(sentence, { exact: true }).waitFor()
    assert.doesNotMatch(await row.innerText(), /EPERM|operation not permitted/)
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    await expect.poll(() => page.getByTestId('maintenance-reason-claude').innerText()).toBe(sentence)
    await clean(page)
  } finally { await page.close() }
})
test('the maintenance page does not reinstall over a CLI from an official installer the app cannot replace', async () => {
  const page = await open('nativeCodex=1&nativeInstall=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const row = page.getByTestId('maintenance-tool-codex')
    const reinstall = page.getByTestId('maintenance-install-codex')
    await reinstall.waitFor()
    assert.equal(await reinstall.isDisabled(), true)
    assert.match(await row.innerText(), /由官方安装器管理/)
    assert.match(await row.innerText(), /已安装（官方安装器）/)
    // 官方安装器装的 Claude Code 星芒卸得掉：「重新安装」照常能点，点了先问一句（第三十一批 B）。
    const claude = page.getByTestId('maintenance-tool-claude')
    assert.equal(await page.getByTestId('maintenance-install-claude').isDisabled(), false)
    assert.doesNotMatch(await claude.innerText(), /由官方安装器管理/)
    assert.match(await claude.innerText(), /已安装（官方安装器）/)
    // 点了和首页同一个确认框；点「取消」什么都不动，页面上也不冒出一句「正在安装」。
    await page.getByTestId('maintenance-install-claude').click()
    const dialog = page.getByTestId('managed-switch-confirm')
    await dialog.getByText('换成星芒装的 Claude Code？', { exact: true }).waitFor()
    assert.match(await dialog.innerText(), /再装上 1\.2\.3。/)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByTestId('maintenance-cancel-claude').waitFor({ state: 'detached' })
    const switched = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli' || entry.method === 'installCli'))
    assert.deepEqual(await switched(), [])
    assert.doesNotMatch(await page.getByTestId('page-maintenance').innerText(), /这个工具正在安装|安装完成，工具状态已更新/)
    // 这一页的「重新安装」不点名版本：框里写的 1.2.3 必须原样交给主进程，而不是由主进程另挑一版。
    await page.getByTestId('maintenance-install-claude').click()
    await dialog.getByRole('button', { name: '换成星芒装的', exact: true }).click()
    await page.getByText('安装完成，工具状态已更新', { exact: true }).waitFor()
    assert.deepEqual(await switched(), [
      { method: 'uninstallCli', args: ['claude', { reinstall: true }] },
      { method: 'installCli', args: ['claude', '1.2.3'] },
    ])
    await clean(page)
  } finally { await page.close() }
})
test('switching the official-installer Claude Code to the app asks first, then uninstalls and installs the named version', async () => {
  const page = await open('cliUpdate=1&nativeInstall=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    const update = row.getByRole('button', { name: '更新', exact: true })
    await update.waitFor()
    assert.equal(await row.getByTestId('tool-claude-external-managed').count(), 0)
    const switched = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli' || entry.method === 'installCli'))
    const dialog = page.getByTestId('managed-switch-confirm')
    await update.click()
    await dialog.getByText('换成星芒装的 Claude Code？', { exact: true }).waitFor()
    assert.match(await dialog.innerText(), /星芒会先把它卸掉，再装上 2\.0\.0。工具配置、账户数据和历史记录会保留，以后在星芒里点一下就能更新。/)
    // 点「取消」什么都不动。
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await switched(), [])
    assert.equal(await update.count(), 1)
    // 再点一次、点「换成星芒装的」：这一行先「正在卸载」，卸完才装，装的正是框里写的那一版。
    await page.evaluate(() => window.v2Test.holdNextUninstall())
    await update.click()
    await dialog.getByRole('button', { name: '换成星芒装的', exact: true }).click()
    await row.getByText('正在卸载', { exact: true }).waitFor()
    assert.deepEqual((await switched()).map((entry) => entry.method), ['uninstallCli'])
    await page.evaluate(() => window.v2Test.releaseUninstall())
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    assert.deepEqual(await switched(), [
      { method: 'uninstallCli', args: ['claude', { reinstall: true }] },
      { method: 'installCli', args: ['claude', '2.0.0'] },
    ])
    await row.getByText('v2.0.0', { exact: false }).waitFor()
    assert.equal(await update.count(), 0)
    await clean(page)
  } finally { await page.close() }
})
/** 首页「更新」→「换成星芒装的」，返回这一行和只看卸载、安装两个调用的读数器。 */
async function startManagedSwitch(page, { hold = false } = {}) {
  const row = page.getByTestId('tool-row-claude')
  await row.getByRole('button', { name: '更新', exact: true }).waitFor()
  if (hold) await page.evaluate(() => window.v2Test.holdNextUninstall())
  await row.getByRole('button', { name: '更新', exact: true }).click()
  await page.getByTestId('managed-switch-confirm').getByRole('button', { name: '换成星芒装的', exact: true }).click()
  const switched = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli' || entry.method === 'installCli'))
  return { row, switched }
}
test('the uninstall step of a switch to the app cannot be cancelled, and asking again while it runs does not ask twice', async () => {
  const page = await open('cliUpdate=1&nativeInstall=1')
  try {
    const { row, switched } = await startManagedSwitch(page, { hold: true })
    await row.getByText('正在卸载', { exact: true }).waitFor()
    // 卸到一半停不下来：说清楚，而不是假装取消了。
    await row.getByTestId('tool-claude-cancel').click()
    await waitForToast(page, '这一步已经不能取消了。')
    // 换装还在跑时到安装卸载页：这一行跟着首页那次写「安装中」，按钮转圈点不了，
    // 也就不会再问一遍「先把它卸掉」。取消只在发起的那一页给。
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    await expect(page.getByTestId('maintenance-state-claude')).toHaveText('安装中')
    await expect(page.getByTestId('maintenance-tool-claude').locator('.xm-row-desc')).toHaveText('正在卸载')
    await expect(page.getByTestId('maintenance-install-claude')).toBeDisabled()
    assert.equal(await page.getByTestId('maintenance-cancel-claude').count(), 0)
    assert.equal(await page.getByTestId('managed-switch-confirm').count(), 0)
    await page.evaluate(() => window.v2Test.releaseUninstall())
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    assert.deepEqual(await switched(), [
      { method: 'uninstallCli', args: ['claude', { reinstall: true }] },
      { method: 'installCli', args: ['claude', '2.0.0'] },
    ])
    await clean(page)
  } finally { await page.close() }
})
test('a switch whose install fails after the uninstall reports the failure and offers a fresh install', async () => {
  const page = await open('cliUpdate=1&nativeInstall=1')
  try {
    await page.evaluate(() => {
      window.v2Test.fail = 'installCli'
      window.v2Test.failMessage = 'Claude Code 安装失败：npm 官方源：网络连接中断'
    })
    const { row, switched } = await startManagedSwitch(page)
    const failure = page.getByTestId('operation-error')
    await failure.waitFor()
    assert.match(await failure.innerText(), /网络连接中断/)
    assert.deepEqual((await switched()).map((entry) => entry.method), ['uninstallCli', 'installCli'])
    // 官方那份已经卸掉了：刷新后这一行变回「安装」，再点一次就好，不再挂着旧版本的「更新」。
    await row.getByRole('button', { name: '安装', exact: true }).waitFor()
    assert.equal(await row.getByRole('button', { name: '更新', exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})
test('a switch goes on to install when the uninstall leaves old version files behind', async () => {
  const page = await open('cliUpdate=1&nativeInstall=1&uninstallLeftovers=1')
  try {
    const { row, switched } = await startManagedSwitch(page)
    // 程序已经卸掉，只剩被占用的旧版本文件：照常装上，清理说明照旧弹出来。
    await page.getByTestId('manual-uninstall-reason').getByText('可能还有 Claude Code 在运行', { exact: false }).waitFor()
    await row.getByText('v2.0.0', { exact: false }).waitFor()
    assert.deepEqual(await switched(), [
      { method: 'uninstallCli', args: ['claude', { reinstall: true }] },
      { method: 'installCli', args: ['claude', '2.0.0'] },
    ])
    await clean(page)
  } finally { await page.close() }
})
test('a switch stops before uninstalling when the uninstall is handed to another window or the network drops', async () => {
  const handOff = await open('cliUpdate=1&nativeInstall=1&uninstallHandOff=1')
  try {
    const { row, switched } = await startManagedSwitch(handOff)
    await waitForToast(handOff, '已打开卸载窗口，在那个窗口里卸载完，再回来点「重新检测」。')
    assert.deepEqual(await switched(), [{ method: 'uninstallCli', args: ['claude', { reinstall: true }] }])
    // 官方那份在转交之前已经卸掉了：刷新一次，这一行不再挂着它的「更新」。
    await row.getByRole('button', { name: '安装', exact: true }).waitFor()
    assert.equal(await row.getByRole('button', { name: '更新', exact: true }).count(), 0)
    await clean(handOff)
  } finally { await handOff.close() }
  // 确认框开着时断了网：点「换成星芒装的」也先不卸，免得卸完装不回来。
  const page = await open('cliUpdate=1&nativeInstall=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByRole('button', { name: '更新', exact: true }).click()
    const dialog = page.getByTestId('managed-switch-confirm')
    await dialog.getByText('换成星芒装的 Claude Code？', { exact: true }).waitFor()
    await page.context().setOffline(true)
    await page.getByTestId('offline-banner').waitFor()
    await dialog.getByRole('button', { name: '换成星芒装的', exact: true }).click()
    await waitForToast(page, '现在没网，等网络恢复后再试。')
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli' || entry.method === 'installCli')), [])
    await row.getByRole('button', { name: '更新', exact: true }).waitFor()
    await page.context().setOffline(false)
    await clean(page)
  } finally { await page.close() }
})
test('the new-version notification only calls people back for updates the app can install', async () => {
  // 通知在开机第一轮检测落地时就发，所以系统通知接口要在页面加载前装好。
  function recordNotifications() {
    window.__notified = []
    window.xingmangPlatform = {
      notifyActivity: async (kind, key) => { window.__notified.push([kind, key]); return 'requested' },
      onStateChanged: () => () => undefined,
      getState: () => new Promise(() => undefined),
    }
  }
  for (const [query, expected] of [
    ['cliUpdate=1', [['cliUpdate', 'cli-update:claude.2.0.0']]],
    // 官方安装器装的 Claude Code 首页有「更新」（换成星芒装的），照常叫人回来。
    ['cliUpdate=1&nativeInstall=1', [['cliUpdate', 'cli-update:claude.2.0.0']]],
    // 星芒卸不掉的那份首页没有「更新」按钮，通知却说「回到星芒就能逐个更新」。
    ['codexUpdate=1&nativeCodex=1', []],
  ]) {
    const page = await open(query, false, recordNotifications)
    try {
      await page.getByTestId('tool-row-claude').waitFor()
      // 记下「已提醒过」是同一段收尾的最后一步，写进去了就说明这一轮已经判过要不要通知。
      await page.waitForFunction(() => localStorage.getItem('xingmang-v2-cli-update-notice') !== null)
      assert.deepEqual(await page.evaluate(() => window.__notified.filter(([kind]) => kind === 'cliUpdate')), expected, query)
      await clean(page)
    } finally { await page.close() }
  }
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
// 运行环境那两行原来只要没有版本号就写「尚未安装」，探针自己抛错时也照写。
test('a failed runtime probe on the maintenance page says so instead of 尚未安装', async () => {
  const page = await open('runtimeDetectionFailed=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const row = page.getByTestId('maintenance-runtime-node')
    await row.getByText('检测失败', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('maintenance-runtime-reason-node').innerText(), '读取 Node.js 安装位置时被拒绝')
    assert.match(await row.innerText(), /版本未读到/)
    assert.equal(await row.getByText('尚未安装', { exact: true }).count(), 0)
    // Python 这一行探到了，照常显示版本。
    assert.match(await page.getByTestId('maintenance-runtime-python').innerText(), /3\.12\.0/)
    await clean(page)
  } finally { await page.close() }
})
// 候选 4 → 2026-09-24：Windows 上缺 Git 时首页给大白话提示和「安装 Git」，点了由软件代装，
// 不再把客户送去官网自己找安装包。
test('the home runtime card installs a missing Git on Windows instead of sending the customer to a website', async () => {
  const page = await open('gitMissing=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const hint = page.getByTestId('home-runtime-git-hint')
    await hint.waitFor()
    assert.equal(await hint.innerText(), '没有 Git 的话，Claude Code 的部分功能和一些技能、插件会用不了。点「安装 Git」自动装好，不用管理员权限。')
    assert.doesNotMatch(await hint.innerText(), /PowerShell|bash|PATH|git-scm/)
    const button = page.getByTestId('home-runtime-git')
    assert.equal((await button.innerText()).trim(), '安装 Git')
    await button.click()
    await hint.waitFor({ state: 'detached' })
    await button.waitFor({ state: 'detached' })
    const calls = await page.evaluate(() => window.v2Test.calls.map((call) => call.method))
    assert.ok(calls.includes('installGitRuntime'))
    assert.ok(!calls.includes('openExternal'))
    await clean(page)
  } finally { await page.close() }
})
test('a failed Git install keeps the button so the customer can simply try again', async () => {
  const page = await open('gitMissing=1&gitInstallFail=1')
  try {
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('home-runtime-git').click()
    await page.getByText(/Git 没装上/).first().waitFor()
    await page.getByTestId('home-runtime-git').waitFor()
    assert.equal(await page.getByTestId('home-runtime-git').isEnabled(), true)
    await clean(page)
  } finally { await page.close() }
})
// 第十六批 2：Mac 上「安装 Git」弹苹果自己的安装窗口；客户在那里点了取消，首页说一句、按钮留着。
test('a Mac customer who cancels the Apple installer is told so and can press Install Git again', async () => {
  const page = await open('os=mac&gitMissing=1&gitCancel=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const hint = page.getByTestId('home-runtime-git-hint')
    await hint.waitFor()
    assert.equal(await hint.innerText(), '没有 Git 的话，装官方插件市场和部分技能、插件会用不了。点「安装 Git」，在苹果弹出的窗口里点“安装”。')
    assert.doesNotMatch(await hint.innerText(), /终端|xcode-select|brew/)
    await page.getByTestId('home-runtime-git').click()
    await page.getByText('没有装 Git。需要时再点一次「安装 Git」就行。').first().waitFor()
    await page.getByTestId('home-runtime-git').waitFor()
    assert.equal(await page.getByTestId('home-runtime-git').isEnabled(), true)
    await clean(page)
  } finally { await page.close() }
})
test('the home runtime card shows the Git version and no warning when Git is present', async () => {
  const page = await open('')
  try {
    await page.getByTestId('page-home').waitFor()
    assert.equal(await page.getByTestId('home-runtime-git-hint').count(), 0)
    assert.equal(await page.getByTestId('home-runtime-git').count(), 0)
    await clean(page)
  } finally { await page.close() }
})
// 第四十三批 F：在「外接工具」页点「自动安装 Python」装好以后回首页，「运行环境」里 Python 那一行是版本号，
// 不再写「可选 · 未装」、不再给安装按钮。
test('installing Python from the MCP page brings the home runtime card along', async () => {
  const page = await open('pythonMissing=1')
  try {
    await page.evaluate(() => {
      window.xingmang.listProviderExtensions = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', items: [], warnings: [],
        capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
        runtimes: { python: window.v2Test.calls.some((entry) => entry.method === 'installPythonRuntime'), uv: false },
      })
      window.xingmang.checkProviderMcpHealth = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', supported: true, reason: null, entries: [],
      })
    })
    const row = page.getByTestId('home-runtime-row-python')
    await expect(row).toContainText('可选 · 未装')
    await page.getByTestId('home-runtime-python').waitFor()
    await page.getByTestId('home-suggestion-mcp').click()
    await page.getByTestId('page-mcp').waitFor()
    // 还没有连接时空状态里也有一颗「添加」，点页头那颗。
    await page.getByTestId('mcp-add').first().click()
    await page.getByRole('button', { name: '本地程序', exact: true }).click()
    await page.getByTestId('mcp-source').fill('python')
    const notice = page.getByTestId('mcp-runtime-notice')
    await notice.getByTestId('mcp-install-python').click()
    // 本页重读以后有 Python 了，那条提示自己收起。这回先不加，关掉添加框回首页。
    await notice.waitFor({ state: 'detached' })
    const dialog = page.getByRole('dialog', { name: /添加连接/ })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByTestId('nav-home').click()
    await expect(row).toContainText('3.13.7')
    assert.equal(await page.getByTestId('home-runtime-python').count(), 0)
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
    await expect(page.getByTestId('maintenance-state-claude')).toHaveText('暂未读到')
    assert.equal(await row.locator('.xm-pill').count(), 0)
    assert.equal(await row.getByText('未安装', { exact: true }).count(), 0)
    assert.equal(await row.getByRole('button', { name: '安装', exact: true }).count(), 0)
    // 第 42 条：各行不再各放一颗「重新检测」，整页只留页头和红框里那两颗；红框照实说装不了也卸不了。
    assert.equal(await row.getByRole('button', { name: '重新检测', exact: true }).count(), 0)
    const maintenance = page.getByTestId('page-maintenance')
    assert.equal(await maintenance.getByRole('button', { name: '重新检测', exact: true }).count(), 2)
    assert.match(await page.getByTestId('maintenance-failure-system').innerText(), /读到之前装不了也卸不了/)
    // 运行环境那两行同样不能谎报「尚未安装」，也不给「安装」。
    assert.equal(await maintenance.getByText('尚未安装', { exact: true }).count(), 0)
    assert.equal(await maintenance.getByText('暂未读到', { exact: true }).count(), 7, '每个工具行与运行环境行都只写一次「暂未读到」')
    assert.equal(await page.getByTestId('maintenance-runtime-action-node').count(), 0)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('maintenance-failure-system').getByRole('button', { name: '重新检测', exact: true }).click()
    await row.getByText('已安装', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('maintenance-failure-system').count(), 0)
    await clean(page)
  } finally { await page.close() }
})
// 第 40、43 条：正在装的那一行自己写「安装中」，进度换成首页那种白话，有百分比时按钮写百分比、
// 底下一道细进度条；别的行灰着，鼠标停上去说在等谁；「取消」点了写「正在停止」。
//「安装日志」平时不占地方，一开始装就出现、装完留着。
test('the maintenance row being installed says so, shows plain progress and tells the other rows what they wait for', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const maintenance = page.getByTestId('page-maintenance')
    const row = page.getByTestId('maintenance-tool-gemini')
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('未安装')
    assert.equal(await maintenance.getByRole('log').count(), 0)
    await page.evaluate(() => window.v2Test.holdNextInstall())
    await page.getByTestId('maintenance-install-gemini').click()
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('安装中')
    await expect(page.getByTestId('maintenance-install-gemini')).toBeDisabled()
    const other = page.getByTestId('maintenance-install-claude')
    await expect(other).toBeDisabled()
    await expect(other).toHaveAttribute('title', '等 Gemini CLI 装完再操作')
    await page.evaluate(() => window.v2Test.emit('onInstallProgress', { provider: 'gemini', state: 'output', stage: 'download', message: 'npm 官方源：正在下载 @google/gemini-cli' }))
    await expect(row.locator('.xm-row-desc')).toHaveText('正在下载，第一次可能要几分钟，请别关窗口…')
    // 程序原话照旧只进「安装日志」，这张卡这时才出现。
    await expect(maintenance.getByRole('log')).toHaveText('npm 官方源：正在下载 @google/gemini-cli')
    assert.equal(await row.locator('.v2-maintenance-row-progress').count(), 0)
    await page.evaluate(() => window.v2Test.emit('onInstallProgress', { provider: 'gemini', state: 'output', stage: 'download', message: '已下载 38%', percent: 38 }))
    await expect(page.getByTestId('maintenance-install-gemini')).toHaveText('38%')
    await row.locator('.v2-maintenance-row-progress').waitFor()
    await page.getByTestId('maintenance-cancel-gemini').click()
    await expect(page.getByTestId('maintenance-cancel-gemini')).toHaveText('正在停止')
    await page.evaluate(() => window.v2Test.releaseInstall('安装已取消'))
    await page.getByTestId('maintenance-cancel-gemini').waitFor({ state: 'detached' })
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('未安装')
    assert.equal(await row.locator('.v2-maintenance-row-progress').count(), 0)
    await expect(other).toBeEnabled()
    assert.equal(await other.getAttribute('title'), null)
    await maintenance.getByRole('log').waitFor()
    await clean(page)
  } finally { await page.close() }
})
// 第 40 条：没装上的那一行写红色「安装失败」，名字下面写页顶红框领头的那一句。
test('a maintenance row whose install failed says 安装失败 with the sentence the red banner leads with', async () => {
  const page = await open('installPermissionDenied=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const row = page.getByTestId('maintenance-tool-gemini')
    const state = page.getByTestId('maintenance-state-gemini')
    await expect(state).toHaveText('未安装')
    await page.getByTestId('maintenance-install-gemini').click()
    await expect(state).toHaveText('安装失败')
    assert.match(await state.getAttribute('class'), /xm-tone-bad/)
    const banner = page.getByTestId('page-maintenance').locator('.v2-business-notice.is-error strong')
    await expect(banner).toHaveText('写不进安装目录')
    await expect(row.locator('.xm-row-desc')).toHaveText('写不进安装目录')
    // 别的行没受连累。
    await expect(page.getByTestId('maintenance-state-claude')).toHaveText('已安装')
    await clean(page)
  } finally { await page.close() }
})
// 第 44 条：「安装指南」落到装它的那一章，不再是教程第一章。
test('the runtime install guide opens the chapter that installs it', async () => {
  for (const [query, chapter] of [['desktopOnly=1&runtimeExternal=1&os=mac', 'Mac 上准备 Node.js 和 Python'], ['desktopOnly=1&runtimeExternal=1', '进阶：安装与使用命令行工具']]) {
    const page = await open(query)
    try {
      await page.getByTestId('nav-more').click()
      await page.getByTestId('nav-maintenance').click()
      const guide = page.getByTestId('maintenance-runtime-action-node')
      await expect(guide).toHaveText('安装指南')
      await guide.click()
      await expect(page.locator('#tutorial-article-title')).toHaveText(chapter)
      await clean(page)
    } finally { await page.close() }
  }
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
    // 推荐项是默认选中的（第十一批 1），但只是选中，不会触发任何安装。
    assert.equal(await page.getByTestId('start-guide').getAttribute('data-guide-route'), 'codexDesktop')
    const configurationCount = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length)
    await page.getByTestId('guide-route-chat').check()
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(methods.includes('installCli') || methods.includes('installNodeRuntime') || methods.includes('installCodexDesktop'), false)
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
    await page.getByTestId('tool-row-claude').getByText('不是当前账号的 Key').waitFor()
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
    await matchedToolBadges(page, 'Key 可能不是当前账号的')
    await settleMatchedBootstrap(page)
    await assertNoMatchedKeyOperations(page)
    await clean(page)
  } finally { await page.close() }
})

test('read-only account matches restore on fresh login without treating the match as configuration consent', async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1&guest=1&existing=1')
  try {
    await page.getByTestId('welcome-page').waitFor()
    const before = await page.evaluate(() => window.xingmang.getConfig())
    assert.ok(Object.values(before.providers).every(provider => provider.configurationAccountMatched !== true))
    await page.getByTestId('welcome-login').click()
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
    await matchedToolBadges(page, 'Key 可能不是当前账号的')
    await page.evaluate(async () => {
      window.v2Test.releaseConfigRead()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await matchedToolBadges(page, 'Key 可能不是当前账号的')
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
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出登录？', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-codexDesktop').check()
    for (let step = 0; step < 2; step++) await page.getByTestId('guide-next').click()
    await page.locator('[data-testid="guide-foreign-key"][data-key-state="otherSite"]').waitFor()
    assert.equal((await page.getByTestId('guide-switch-account').textContent())?.trim(), '登录后改用我的账号')
    await page.evaluate(async () => {
      window.v2Test.releaseConfigRead()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await page.getByTestId('guide-next').count(), 0)
    const summary = await page.evaluate(() => window.xingmang.getConfig())
    assert.ok(Object.values(summary.providers).every(provider => provider.configurationAccountMatched === false))
    await assertNoMatchedKeyOperations(page)
    await clean(page)
    await page.goto(`${origin}/src/renderer-v2/testing/app.html?readOnlyAccountMatch=1&allInstalled=1&guest=1&existing=1`)
    // 引导进度按未登录作用域记在本机，重开直接回到上面停下的「确认连接」。
    await page.getByTestId('welcome-steps').click()
    await page.locator('[data-testid="guide-foreign-key"][data-key-state="otherSite"]').waitFor()
    assert.equal((await page.getByTestId('guide-switch-account').textContent())?.trim(), '登录后改用我的账号')
    assert.equal(await page.getByTestId('guide-next').count(), 0)
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

test('an edited configuration says so on the row and can be written back on request', async () => {
  const page = await open('allInstalled=1&changedClaude=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByText('配置被改过').waitFor()
    await row.getByText('配置在软件之外被改动过', { exact: false }).waitFor()
    // 开机那轮自动同步不许碰它：提示归提示，改写要等用户点。
    const before = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'configureManagedCliKeys').map(entry => entry.args[0]))
    assert.ok(before.every(input => !input.providers.includes('claude')))
    await page.getByTestId('tool-claude-rewrite-key').click()
    await page.waitForFunction(() => window.v2Test.calls.some(entry => entry.method === 'configureManagedCliKeys'
      && entry.args[0].providers.includes('claude') && entry.args[0].intent === 'explicit'))
    await row.getByText('已配好').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 开机账号恢复超过启动画面的等待上限：先进首页，这期间一行都不许说「配置被改过」；
// 恢复成功只补读一次配置，不整页重来、不再扫描一遍。
test('a slow startup restore opens the home page first and settles ownership after one config re-read', async () => {
  const page = await open('allInstalled=1&changedClaude=1&restoring=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByText('已配好').waitFor()
    await page.getByText('正在恢复登录').first().waitFor()
    assert.equal(await page.getByText('配置被改过').count(), 0)
    assert.equal(await page.getByText('用的是别处的配置').count(), 0)
    assert.equal(await page.getByText('不是当前账号的 Key').count(), 0)
    assert.equal(await page.getByText('Key 可能不是当前账号的').count(), 0)
    assert.equal(await page.getByTestId('tool-claude-rewrite-key').count(), 0)
    assert.equal(await page.getByTestId('welcome-login').count(), 0)
    // 工具列表整块重读（useToolbox.read）才会连带读平台能力；Key 同步那一步自己的
    // 安装检查不读它，所以用它来数「首页有没有整页重来」。
    const readsBefore = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'getPlatformCapabilities').length)
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, account: { userId: 17, username: 'fixture-user', group: 'default', role: 1, quota: 6_200_000, usedQuota: 0 } }))
    await row.getByText('配置被改过').waitFor()
    const readsAfter = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'getPlatformCapabilities').length)
    assert.equal(readsAfter, readsBefore, '恢复成功后首页不应整页重新检测')
    await clean(page)
  } finally { await page.close() }
})

test('an unreachable startup restore keeps the login on the home page and waits for the retry', async () => {
  const page = await open('allInstalled=1&changedClaude=1&restoring=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByText('已配好').waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: false, account: null, restoring: { account: { siteId: 'solov', userId: 17 }, retrying: true } }))
    await page.getByText('暂时连不上，登录还在').first().waitFor()
    assert.equal(await page.getByTestId('welcome-login').count(), 0)
    assert.equal(await page.getByText('当前登录已结束').count(), 0)
    assert.equal(await page.getByText('配置被改过').count(), 0)
    await page.getByTestId('nav-chat').click()
    await page.getByText('暂时连不上服务，登录还在').waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, account: { userId: 17, username: 'fixture-user', group: 'default', role: 1, quota: 6_200_000, usedQuota: 0 } }))
    await row.getByText('配置被改过').waitFor()
    assert.equal(await page.getByText('暂时连不上，登录还在').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('a launch paints the last saved scan first and swaps in the fresh one without calling config changed', async () => {
  const page = await open('allInstalled=1&changedClaude=1&cachedScan=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await page.getByTestId('home-cached-scan').waitFor()
    await row.getByText('已配好').waitFor()
    assert.equal(await page.getByText('配置被改过').count(), 0)
    assert.equal(await page.getByTestId('tool-claude-rewrite-key').count(), 0)
    await page.evaluate(() => window.v2Test.releaseScan())
    await row.getByText('配置被改过').waitFor()
    assert.equal(await page.getByTestId('home-cached-scan').count(), 0)
    await page.getByTestId('tool-row-grok').getByText('已配好').waitFor()
    const cachedReads = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'scanSystem' && entry.args[1]?.acceptCached === true).length)
    assert.equal(cachedReads, 1, '只有开机首屏那一次可以先用上次的结果')
    await clean(page)
  } finally { await page.close() }
})

// 第三十一批 A：开机检测没跑完时只放开「打开」「接着聊」。点下去配置现读、工具现找，
// 用不上上次的结果；「安装」照旧等检测跑完。
test('a connected tool opens while the last saved scan is still on screen, and install keeps waiting', async () => {
  const page = await open('allInstalled=1&cachedScan=1')
  try {
    await page.getByTestId('home-cached-scan').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.disabled === false)
    // 上次的结果里 Grok 还没装：装不装要等这一轮检测说了算。
    assert.equal(await page.getByTestId('tool-grok-primary').innerText(), '安装')
    assert.equal(await page.getByTestId('tool-grok-primary').isDisabled(), true)
    await page.getByTestId('tool-claude-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args), [['claude', 'C:\\Selected Project']])
    assert.equal(await page.getByTestId('home-cached-scan').count(), 1, '检测还没跑完就已经打开了')
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.getByTestId('home-cached-scan').waitFor({ state: 'detached' })
    await page.getByTestId('tool-row-grok').getByText('已配好').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('the home recent card resumes a conversation before the startup scan finishes', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&cachedScan=1')
  try {
    await page.getByTestId('home-cached-scan').waitFor()
    const resume = page.getByTestId('home-recent-resume-claude:1')
    await resume.waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-recent-resume-claude:1"]')?.disabled === false)
    // 目录已经不在的那一行照旧按不动。
    assert.equal(await page.getByTestId('home-recent-resume-claude:2').isDisabled(), true)
    await resume.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args), [['claude', 'C:\\work\\my-app', 'resumeLast']])
    assert.equal(await page.getByTestId('home-cached-scan').count(), 1, '检测还没跑完就已经接上了')
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.getByTestId('home-cached-scan').waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

// 开机这一轮账号要给已连好的 Claude 换 Key（Key 换了分组）：新 Key 要等检测跑完才写，
// 抢在前面打开就带着旧 Key 起来，所以只有它照旧等，别的工具不受连累。
test('a tool whose account key changes this startup keeps waiting for the scan while the others open', async () => {
  const page = await open('allInstalled=1&cachedScan=1&regrouped=claude')
  try {
    await page.getByTestId('home-cached-scan').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-codex-primary"]')?.disabled === false)
    assert.equal(await page.getByTestId('tool-claude-primary').isDisabled(), true)
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.getByTestId('home-cached-scan').waitFor({ state: 'detached' })
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    const configured = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').map((entry) => entry.args[0].providers))
    assert.ok(configured.some((providers) => providers.includes('claude')), '换了分组的 Claude 要在这一轮换上新 Key')
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.disabled === false)
    await clean(page)
  } finally { await page.close() }
})

// 账号 Key 同步还没问完服务端时，说不准这一轮要不要给谁换 Key，「打开」先等着；
// 问完了、谁都不用换，检测没跑完也能打开。
test('an applied route migration blocks home and native launch after scanning until configuration finishes', async () => {
  const page = await open('allInstalled=1&cachedScan=1&restoreDirectRoute=1')
  try {
    await page.getByTestId('home-cached-scan').waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'syncManagedCliKeys'))
    await page.evaluate(() => { window.v2Test.holdNextConfigSave(); window.v2Test.releaseScan() })
    await page.getByTestId('home-cached-scan').waitFor({ state: 'detached' })
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys' && entry.args[0].providers.includes('claude')))
    await expect(page.getByTestId('tool-claude-primary')).toBeDisabled()
    await expect(page.getByTestId('tool-codex-primary')).toBeEnabled()
    await page.evaluate(() => window.v2Test.emit('onLaunchTool', 'claude'))
    await waitForToast(page, '正在同步这个工具的账号连接，请稍后再打开。')
    const shortcutNumber = await page.evaluate(async () => {
      const { tools } = await import('/src/renderer-v2/registry/tools.ts')
      return tools.filter((entry) => !entry.hidden?.('win')).findIndex((entry) => entry.id === 'claude') + 1
    })
    await page.keyboard.press(`Control+${shortcutNumber}`)
    await waitForToast(page, '正在同步这个工具的账号连接，请稍后再打开。')
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length), 0)
    await page.evaluate(() => window.v2Test.releaseConfigSave())
    await expect(page.getByTestId('tool-claude-primary')).toBeEnabled()
    const configured = await page.evaluate(async () => (await window.xingmang.getConfig()).providers.claude)
    assert.equal(configured.actualBaseUrl, configured.baseUrl)
    await page.getByTestId('tool-claude-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await clean(page)
  } finally { await page.close() }
})

test('opening waits while the account key sync has not answered yet, then opens before the scan finishes', async () => {
  const page = await open('allInstalled=1&cachedScan=1&bootstrapPending=1')
  try {
    await page.getByTestId('home-cached-scan').waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'syncManagedCliKeys'))
    assert.equal(await page.getByTestId('tool-claude-primary').isDisabled(), true)
    await page.evaluate(() => window.v2Test.releaseBootstrap())
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.disabled === false)
    assert.equal(await page.getByTestId('home-cached-scan').count(), 1)
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.getByTestId('home-cached-scan').waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

// 检测没跑完时打开、刚选的文件夹写上了按钮；那一轮落地时带的是打开前读的配置，
// 不能把这个文件夹盖回去，否则下次点「打开」又要选一遍。
test('a folder picked while the startup scan runs stays on the button after the scan lands', async () => {
  const page = await open('allInstalled=1&cachedScan=1&launchRemembers=1')
  try {
    await page.getByTestId('home-cached-scan').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.disabled === false)
    await page.getByTestId('tool-claude-primary').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.textContent?.includes('打开 Selected P'))
    // 账号这一轮写完 Key 也会重读一次配置，先按住它，看的是检测落地这一下本身。
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.getByTestId('home-cached-scan').waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.textContent?.includes('打开 Selected P'))
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    await page.evaluate(() => window.v2Test.releaseConfigSave())
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'chooseWorkspace').length), 1)
    await clean(page)
  } finally { await page.close() }
})

test('an edited configuration can be kept as it is and stops asking', async () => {
  const page = await open('allInstalled=1&changedClaude=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByText('配置被改过').waitFor()
    await row.getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '就用现在这份', exact: true }).click()
    await row.getByText('已配好').waitFor()
    assert.equal(await page.getByTestId('tool-claude-rewrite-key').count(), 0)
    const requests = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'configureManagedCliKeys').map(entry => entry.args[0]))
    assert.ok(requests.every(input => !input.providers.includes('claude')))
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
    await page.waitForFunction(() => document.querySelector('[data-testid="start-guide"]')?.getAttribute('data-busy') === 'false')
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

// 第四十批 C：装完以后同步 Key、重新检测那几秒，那一行的「取消」还亮着。主进程这时已经不登记这次安装了，
// 再去问它只会回「这个工具当前没有正在进行的安装。」，可这一行明明还在走：直接说这一步停不下来。
test('cancelling during the key sync after an install says the step can no longer be cancelled', async () => {
  const page = await open('cliUpdate=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    const update = row.getByRole('button', { name: '更新', exact: true })
    await update.waitFor()
    await page.evaluate(() => window.v2Test.holdNextScan())
    await update.click()
    await row.getByText('安装完成，正在同步账号 Key 并刷新状态', { exact: true }).waitFor()
    await row.getByTestId('tool-claude-cancel').click()
    await waitForToast(page, '这一步已经不能取消了。')
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'cancelCliInstall').length), 0)
    await expect(row.getByTestId('tool-claude-cancel')).toHaveText('取消')
    await page.evaluate(() => window.v2Test.releaseScan())
    await row.getByText('v2.0.0', { exact: false }).waitFor()
    assert.equal(await row.getByTestId('tool-claude-cancel').count(), 0)
    await clean(page)
  } finally { await page.close() }
})
test('cancelling on the maintenance page during the key sync after an install says the step can no longer be cancelled', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const maintenance = page.getByTestId('page-maintenance')
    const row = page.getByTestId('maintenance-tool-gemini')
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('未安装')
    await page.evaluate(() => window.v2Test.holdNextScan())
    await page.getByTestId('maintenance-install-gemini').click()
    await expect(row.locator('.xm-row-desc')).toHaveText('安装完成，正在同步账号 Key 并刷新状态')
    await page.getByTestId('maintenance-cancel-gemini').click()
    await expect(maintenance.getByRole('alert')).toContainText('这一步已经不能取消了。')
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'cancelCliInstall').length), 0)
    await expect(page.getByTestId('maintenance-cancel-gemini')).toHaveText('取消')
    await page.evaluate(() => window.v2Test.releaseScan())
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('已安装')
    assert.equal(await page.getByTestId('maintenance-cancel-gemini').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 取消被拒那句红条只说这次安装还会跑完：跑完了就收起，照常提示装好了，不再挂着「未完成」。
test('a refused cancel on the maintenance page stops showing once the install finishes', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    const maintenance = page.getByTestId('page-maintenance')
    const row = page.getByTestId('maintenance-tool-gemini')
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('未安装')
    await page.evaluate(() => window.v2Test.holdNextScan())
    await page.getByTestId('maintenance-install-gemini').click()
    await expect(row.locator('.xm-row-desc')).toHaveText('安装完成，正在同步账号 Key 并刷新状态')
    await page.getByTestId('maintenance-cancel-gemini').click()
    await expect(maintenance.getByRole('alert')).toContainText('这一步已经不能取消了。')
    await page.evaluate(() => window.v2Test.releaseScan())
    await waitForToast(page, '安装完成，工具状态已更新')
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('已安装')
    await expect(maintenance.getByRole('alert')).toHaveCount(0)
    assert.doesNotMatch(await maintenance.innerText(), /这一步已经不能取消了。/)
    await clean(page)
  } finally { await page.close() }
})

test('saved-account switching leaves tools without an account key untouched', async () => {
  const page = await open('savedAccount=1')
  try {
    await page.getByTestId('tool-row-claude').waitFor()
    await page.getByRole('button', { name: '切换账号' }).click()
    await page.getByTestId('saved-account-row-saved-18').getByText('星芒账号', { exact: true }).waitFor()
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
    // 原本就在用账号密钥的工具默认勾上；这里取消两个，确认只写勾着的。
    await page.getByTestId('account-sync-grok').waitFor()
    assert.equal(await page.getByTestId('account-sync-claude').isChecked(), true)
    assert.equal(await page.getByTestId('account-sync-codex').isChecked(), true)
    await page.getByTestId('account-sync-gemini').uncheck()
    await page.getByTestId('account-sync-grok').uncheck()
    await saved.getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('button', { name: '打开个人中心 saved-user', exact: true }).waitFor()
    const writes = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'configureManagedCliKeys').map(entry => entry.args[0]))
    assert.deepEqual(writes, [
      { providers: ['claude'], preferredModels: { claude: 'fixture-model' }, intent: 'explicit' },
      { providers: ['codex'], preferredModels: { codex: 'fixture-model' }, intent: 'explicit' },
    ])
    for (const tool of ['claude', 'codex', 'codexDesktop']) await page.getByTestId(`tool-row-${tool}`).getByText('已配好', { exact: true }).waitFor()
    // 没勾的两个还是上一个账号的 Key：能用，但要提醒用量可能算到别的账号上（方案盘查第 10 条）。
    for (const tool of ['gemini', 'grok']) await page.getByTestId(`tool-row-${tool}`).getByText('Key 可能不是当前账号的', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some(entry => ['saveConfig', 'saveConfigWithAccountKey', 'revealApiKey', 'revealAccountKey'].includes(entry.method))), false)
    await clean(page)
  } finally { await page.close() }
})

test('tools switched to a saved account open right away instead of waiting for a key sync that never runs', async () => {
  const page = await open('savedAccount=1&readOnlyAccountMatch=1&allInstalled=1')
  try {
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    await page.getByTestId('account-sync-grok').waitFor()
    await page.getByTestId('saved-accounts-list').getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('button', { name: '打开个人中心 saved-user', exact: true }).waitFor()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    // 切换账号时 Key 已经在切换框里换好，开机那一轮同步不会再跑：「打开」不能一直灰着等它。
    await expect(page.getByTestId('tool-claude-primary')).toBeEnabled()
    await page.evaluate(() => window.v2Test.emit('onLaunchTool', 'codex'))
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.getByTestId('tool-claude-primary').click()
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length)).toBe(2)
    assert.equal(await page.getByText('正在同步这个工具的账号连接，请稍后再打开。').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('saved-account switching names the rewritten tools that are still open and restarts Codex desktop only when asked', async () => {
  const page = await open('savedAccount=1&readOnlyAccountMatch=1&allInstalled=1&runningTools=1')
  try {
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    const saved = page.getByTestId('saved-accounts-list')
    await page.getByTestId('account-sync-grok').waitFor()
    await page.getByTestId('account-sync-gemini').uncheck()
    await page.getByTestId('account-sync-grok').uncheck()
    await saved.getByRole('button', { name: '切换', exact: true }).click()
    // 有工具还开着时切换框不自己关掉，提示和按钮要让用户看得到。
    await page.getByTestId('account-sync-restart-hint')
      .getByText('Claude Code、Codex CLI、Codex 桌面端 还开着，要关掉重开才会用上当前账号。', { exact: true }).waitFor()
    const asked = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'inspectRunningTools').map((entry) => entry.args[0]))
    assert.deepEqual(asked, [['claude', 'codex']])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop')), false, '不点就不许重开桌面端')
    await page.getByTestId('account-sync-restart-codex-desktop').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop'))
    const launches = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCodexDesktop').map((entry) => entry.args[0]))
    assert.deepEqual(launches, ['restart'])
    await page.getByTestId('account-sync-restart-hint')
      .getByText('Claude Code、Codex CLI 还开着，要关掉重开才会用上当前账号。', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('account-sync-restart-codex-desktop').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('switching Codex account source offers to restart an open Codex desktop and does nothing until asked', async () => {
  const page = await open('runningTools=1&allInstalled=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.waitFor()
    await row.getByRole('button', { name: '配置和更多操作', exact: true }).click()
    const item = page.getByTestId('tool-codex-switch-official').or(page.getByTestId('tool-codex-switch-account'))
    await item.click()
    const restart = page.getByTestId('switch-restart-codex-desktop')
    await restart.waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop')), false, '不点就不许重开桌面端')
    await restart.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop'))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCodexDesktop').map((entry) => entry.args[0])), ['restart'])
    await restart.waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

test('local keys no longer skip the welcome page, which offers login first and still lets tools open without an account', async () => {
  const page = await open('guest=1&existing=1')
  try {
    await page.getByTestId('welcome-page').waitFor()
    assert.equal(await page.getByTestId('tool-row-codex').count(), 0)
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('login-account').waitFor()
    await page.getByTestId('login-cancel').click()
    await enterWorkspaceWithoutAccount(page)
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
    // A fresh page like every open() above, so it gets the same shared retry.
    await openFixturePage(page, `${origin}/src/renderer-v2/testing/app.html`,
      (timeout) => waitForFixtureReady(page, timeout), { label: 'renderer-v2 fixture without storage' })
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('sidebar-collapse').click()
    assert.equal(await page.locator('.v2-sidebar').evaluate((element) => element.clientWidth), 59)
    await clean(page)
  } finally { await page.close() }
})

// 启动时自己跑的检查失败了，用户什么都没点，所以不许拿模态框把界面挡住——CI 的
// 原生冒烟正是这样在欢迎页上被挡了 30 秒。提示改成角落里一条能关掉的通知，失败本身
// 仍然上报进运行日志。
test('a failed startup update check shows a dismissible notice instead of a blocking dialog', async () => {
  const page = await open('startupUpdate=1&diagnostics=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const notice = page.getByTestId('startup-notice-update')
    await notice.waitFor()
    await notice.getByText('本地更新源暂时不可用', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('operation-error').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'runDiagnostics').length), 1)
    // 登录后的 Key 自动配置也会经同一通道记一条 info / warn（context account-bootstrap），
    // 这几条断言只关心启动检查自己上报了什么。
    const reported = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'reportRendererError' && entry.args[0]?.context !== 'account-bootstrap').map((entry) => entry.args[0]))
    assert.equal(reported.length, 1)
    assert.equal(reported[0].context, 'renderer-v2 startup check: update')
    // 启动检查没完成是要留痕的提示，不是崩溃：warn 级只进本机日志，不走崩溃上报。
    assert.equal(reported[0].level, 'warn')
    assert.match(reported[0].message, /本地更新源暂时不可用/)
    await notice.getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(() => page.getByTestId('startup-notice-update').count()).toBe(0)
    await clean(page)
  } finally { await page.close() }
})

test('startup environment findings are a notice with a way in, not an error and not a dialog', async () => {
  const page = await open('diagnostics=1&diagnosticIssues=2&diagnosticWarnings=3')
  try {
    const notice = page.getByTestId('startup-notice-diagnostics')
    await notice.waitFor()
    await notice.getByText('环境检查发现 2 项需要处理', { exact: true }).waitFor()
    await notice.getByText('另有 3 项可留意', { exact: false }).waitFor()
    assert.equal(await page.getByTestId('operation-error').count(), 0)
    // 检查跑完了、只是结论要看一眼，这不是失败，不该占一条错误日志。
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'reportRendererError' && entry.args[0]?.context !== 'account-bootstrap').length), 0)
    await notice.getByRole('button', { name: '去看看', exact: true }).click()
    await page.getByTestId('page-health').waitFor()
    // 检查页自己那次检测不复用扫描结果，照旧全部重探。
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'runDiagnostics' && entry.args.length === 0).length)).toBeGreaterThan(0)
    await expect.poll(() => page.getByTestId('startup-notice-diagnostics').count()).toBe(0)
    await clean(page)
  } finally { await page.close() }
})

test('startup environment check says nothing when every finding is only worth a look', async () => {
  // 只装了一家工具的客户：其余 CLI、Python、Git 没装都是「需留意」，不该每次开机都提。
  const page = await open('diagnostics=1&diagnosticWarnings=5')
  try {
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'runDiagnostics').length)).toBe(1)
    // 开机这次让主进程直接用首页那轮扫描的探测结果，不再把子进程重跑一遍。
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'runDiagnostics').args), [{ reuseRecentScan: true }])
    await page.getByTestId('page-home').waitFor()
    // 结论是异步落地的：给它一拍，免得在提示出现之前就断言「没有」。
    await page.waitForTimeout(100)
    assert.equal(await page.getByTestId('startup-notice-diagnostics').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('a failed startup environment check stays out of the way while the manual one still reports', async () => {
  const page = await open('diagnostics=1&diagnosticsFail=1')
  try {
    const notice = page.getByTestId('startup-notice-diagnostics')
    await notice.waitFor()
    await notice.getByText('本机环境检查没有跑完', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('operation-error').count(), 0)
    const reported = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'reportRendererError' && entry.args[0]?.context !== 'account-bootstrap').map((entry) => entry.args[0].context))
    assert.deepEqual(reported, ['renderer-v2 startup check: diagnostics'])
    // 用户自己走到「检查」页点按钮，同一个失败要照常摆在页面上说清楚。
    await page.getByTestId('nav-health').click()
    const health = page.getByTestId('page-health')
    await health.waitFor()
    await health.getByRole('button', { name: '重新检查', exact: true }).click()
    await health.getByText('本机环境检查没有跑完', { exact: true }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 本机账号存储被重建时，用户看到的只是「记住的账号没了」。提示照后台检查那套挂在
// 角落，不挡操作，并且给一颗按钮直接把登录开出来，而不是让他自己去找。
test('a rebuilt account store explains itself and opens the login form', async () => {
  const page = await open()
  try {
    await page.getByTestId('page-home').waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountVaultRecovered', undefined))
    const notice = page.getByTestId('startup-notice-vault-recovered')
    await notice.waitFor()
    await notice.getByText('本机保存的登录信息已重置，请重新登录', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('operation-error').count(), 0)
    // 主进程已经记过一条 vault.recovered，界面不再重复上报一条错误日志。
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'reportRendererError' && entry.args[0]?.context !== 'account-bootstrap').length), 0)
    await notice.getByRole('button', { name: '去登录', exact: true }).click()
    await page.getByTestId('login-account').waitFor()
    await expect.poll(() => page.getByTestId('startup-notice-vault-recovered').count()).toBe(0)
    await clean(page)
  } finally { await page.close() }
})

test('the account-store notice can be dismissed and leaves nothing behind', async () => {
  const page = await open()
  try {
    await page.getByTestId('page-home').waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountVaultRecovered', undefined))
    const notice = page.getByTestId('startup-notice-vault-recovered')
    await notice.waitFor()
    await notice.getByRole('button', { name: '关闭', exact: true }).click()
    await expect.poll(() => page.getByTestId('startup-notice-vault-recovered').count()).toBe(0)
    assert.equal(await page.getByTestId('startup-notices').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 错误报告发到海外这件事，登录进来后说一次；两颗按钮都记下「已告知」，
// 「不想发送」同时关掉上报。没登录时不说。
test('the crash reporting notice appears once after login and records the choice', async () => {
  const page = await open('crashNotice=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const notice = page.getByTestId('startup-notice-crash-reporting')
    await notice.waitFor()
    await notice.getByText('软件出错时会发送错误报告', { exact: true }).waitFor()
    assert.match(await notice.textContent(), /海外的错误收集服务/)
    assert.equal(await notice.getByRole('button', { name: '关闭', exact: true }).count(), 0)
    await page.getByTestId('startup-notice-crash-reporting-secondary').click()
    await expect.poll(() => page.getByTestId('startup-notice-crash-reporting').count()).toBe(0)
    const saves = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0]))
    assert.deepEqual(saves.at(-1), { version: 2, crashReportingNoticeShown: true, crashReporting: false })
    await clean(page)
  } finally { await page.close() }
})

test('acknowledging the crash reporting notice keeps reporting on', async () => {
  const page = await open('crashNotice=1')
  try {
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('startup-notice-crash-reporting-primary').click()
    await expect.poll(() => page.getByTestId('startup-notice-crash-reporting').count()).toBe(0)
    const saves = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0]))
    assert.deepEqual(saves.at(-1), { version: 2, crashReportingNoticeShown: true })
    await clean(page)
  } finally { await page.close() }
})

test('the crash reporting notice waits until the user is signed in', async () => {
  const page = await open('crashNotice=1&guest=1')
  try {
    await page.getByTestId('welcome-page').waitFor()
    assert.equal(await page.getByTestId('startup-notice-crash-reporting').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 显卡接连崩溃后这次自动改用了兼容方式显示：角落里说一句，并让用户二选一，
// 不放关闭叉（关掉等于没选）。两个选择都写进设置，「恢复」接着给一颗「现在重开」。
test('an automatic display fallback explains itself and keeps the fallback when chosen', async () => {
  const page = await open('displayCompat=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const notice = page.getByTestId('startup-notice-display-compat')
    await notice.waitFor()
    await notice.getByText('已改用兼容方式显示界面', { exact: true }).waitFor()
    assert.equal(await notice.getByRole('button', { name: '关闭', exact: true }).count(), 0)
    await page.getByTestId('startup-notice-display-compat-primary').click()
    await expect.poll(() => page.getByTestId('startup-notice-display-compat').count()).toBe(0)
    const saves = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0]))
    assert.deepEqual(saves.at(-1), { version: 2, hardwareAcceleration: false })
    assert.equal(await page.getByTestId('startup-notice-display-relaunch').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('restoring the normal display offers a relaunch from the same corner', async () => {
  const page = await open('displayCompat=1')
  try {
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('startup-notice-display-compat-secondary').click()
    const relaunch = page.getByTestId('startup-notice-display-relaunch')
    await relaunch.waitFor()
    const saves = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0]))
    assert.deepEqual(saves.at(-1), { version: 2, hardwareAcceleration: true })
    await page.getByTestId('startup-notice-display-relaunch-primary').click()
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'relaunchApp').length)).toBe(1)
    await expect.poll(() => page.getByTestId('startup-notice-display-relaunch').count()).toBe(0)
    await clean(page)
  } finally { await page.close() }
})

test('turning the display switch off in settings asks for a relaunch, and later just hides the hint', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-claude').waitFor()
    assert.equal(await page.getByTestId('startup-notice-display-compat').count(), 0)
    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('page-settings')
    await settings.waitFor()
    await settings.getByRole('switch', { name: '用显卡加速显示' }).click()
    const hint = page.getByTestId('settings-display-relaunch')
    await hint.waitFor()
    await hint.getByText('重启软件后生效。', { exact: true }).waitFor()
    const saves = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0]))
    assert.deepEqual(saves.at(-1), { version: 2, hardwareAcceleration: false })
    await page.getByTestId('settings-display-relaunch-later').click()
    await expect.poll(() => page.getByTestId('settings-display-relaunch').count()).toBe(0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'relaunchApp').length), 0)
    await clean(page)
  } finally { await page.close() }
})

test('a first login network failure can change routes without losing its draft or bypassing relaunch', async () => {
  const page = await open('guest=1&missingConfig=1')
  try {
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.evaluate(() => { window.v2Test.fail = 'loginAccount'; window.v2Test.failMessage = '连接账号服务超时' })
    await page.getByTestId('login-submit').click()
    await page.getByTestId('auth-error').waitFor()
    await page.getByTestId('auth-connection-settings').click()
    const panel = page.getByTestId('auth-connection-routes')
    await panel.waitFor()
    await expect(page.locator('dialog[open]')).toHaveCount(1)
    const route = panel.getByTestId('settings-relay-route-solov')
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    await route.selectOption('direct')
    await expect(route).toBeDisabled()
    await expect(page.getByTestId('auth-connection-back')).toBeDisabled()
    await expect(route).toHaveValue('primary')
    await page.evaluate(() => window.v2Test.releaseConfigSave('线路设置没有保存成功'))
    await panel.getByRole('alert').filter({ hasText: '线路设置没有保存成功' }).waitFor()
    await expect(route).toHaveValue('primary')
    await route.selectOption('direct')
    await panel.getByTestId('settings-relay-relaunch').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'relaunchApp').length), 0)
    await page.getByTestId('auth-connection-back').click()
    await expect(page.getByTestId('login-account')).toHaveValue('fixture-user')
    await expect(page.getByTestId('login-password')).toHaveValue('fixture-password')
    await expect(page.getByTestId('auth-agree')).toBeChecked()
    await page.getByTestId('auth-connection-settings').click()
    await expect(route).toHaveValue('direct')
    await page.evaluate(() => window.v2Test.emit('onWindowCloseRequest', { requestId: 'fixture-route-relaunch' }))
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'replyWindowClose' && entry.args[0] === 'fixture-route-relaunch')?.args[1]?.unsavedChanges)).toBe(true)
    await page.evaluate(() => { window.xingmang.relaunchApp = async () => false })
    await panel.getByTestId('settings-relay-relaunch-now').click()
    await waitForToast(page, '已取消重开')
    await expect(panel.getByTestId('settings-relay-relaunch')).toBeVisible()
    await page.screenshot({ path: path.join(artifacts, 'auth-relay-route-pending.png'), fullPage: true })
    await page.getByTestId('auth-connection-back').click()
    await expect(page.getByTestId('login-password')).toHaveValue('fixture-password')
    assert.equal(await page.evaluate(async () => (await window.xingmang.getAccountSession()).authenticated), false)
    await clean(page)
  } finally { await page.close() }
})

test('an unsigned first-run guide reaches connection routes before it can configure any tool', async () => {
  const page = await open('guest=1&missingConfig=1')
  try {
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-chat').check()
    await page.getByTestId('guide-next').click()
    await page.getByTestId('guide-next').click()
    await expect(page.getByTestId('guide-next')).toBeDisabled()
    await page.getByTestId('guide-login').click()
    await page.getByTestId('auth-connection-settings').click()
    const panel = page.getByTestId('auth-connection-routes')
    await panel.getByTestId('settings-relay-route-solov').selectOption('direct')
    await panel.getByTestId('settings-relay-relaunch').waitFor()
    await page.getByTestId('auth-connection-back').click()
    await page.getByTestId('login-cancel').click()
    await expect(page.getByTestId('start-guide')).toHaveAttribute('data-guide-step', 'connect')
    const calls = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(calls.includes('loginAccount') || calls.includes('configureManagedCliKeys') || calls.includes('relaunchApp'), false)
    await clean(page)
  } finally { await page.close() }
})

test('relay route settings stay confirmed while saving and keep the restart notice across page visits', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('page-settings')
    await settings.getByRole('tab', { name: '网络', exact: true }).click()
    const route = page.getByTestId('settings-relay-route-solov')
    await expect(route).toHaveValue('primary')
    await expect(page.getByTestId('settings-relay-route-solov-api')).toBeDisabled()
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    await route.selectOption('direct')
    await expect(route).toBeDisabled()
    await expect(route).toHaveValue('primary')
    assert.equal(await page.getByTestId('settings-relay-relaunch').count(), 0)
    await page.evaluate(() => window.v2Test.releaseConfigSave())
    await expect(route).toHaveValue('direct')
    await page.getByTestId('settings-relay-relaunch').waitFor()
    const saves = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0]))
    assert.deepEqual(saves.at(-1), { version: 2, relayEndpointIds: { solov: 'direct', 'solov-api': 'primary' } })
    assert.equal(await page.evaluate(async () => (await window.xingmang.getSettings()).activeRelayEndpointIds.solov), 'primary')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-settings').click()
    await settings.getByRole('tab', { name: '网络', exact: true }).click()
    await page.getByTestId('settings-relay-relaunch').waitFor()
    await page.screenshot({ path: path.join(artifacts, 'settings-relay-route-pending.png'), fullPage: true })
    await page.getByTestId('settings-relay-relaunch-now').click()
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'relaunchApp').length)).toBe(1)
    await expect(page.getByTestId('settings-relay-relaunch')).toBeVisible()
    await clean(page)
  } finally { await page.close() }
})

test('relay route settings roll back a failed save and do not announce a pending restart', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络', exact: true }).click()
    const route = page.getByTestId('settings-relay-route-solov')
    await page.evaluate(() => { window.v2Test.fail = 'saveSettings' })
    await route.selectOption('direct')
    await page.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    await expect(route).toHaveValue('primary')
    await expect(route).toBeEnabled()
    assert.equal(await page.getByTestId('settings-relay-relaunch').count(), 0)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await route.selectOption('direct')
    await page.getByTestId('settings-relay-relaunch').waitFor()
    await route.selectOption('primary')
    await expect.poll(() => page.getByTestId('settings-relay-relaunch').count()).toBe(0)
    await clean(page)
  } finally { await page.close() }
})

test('relay route settings compare against the active backup route and preserve a cancelled restart', async () => {
  const page = await open('directRelayActive=1')
  try {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络', exact: true }).click()
    const route = page.getByTestId('settings-relay-route-solov')
    await expect(route).toHaveValue('direct')
    assert.equal(await page.getByTestId('settings-relay-relaunch').count(), 0)
    await route.selectOption('primary')
    await page.getByTestId('settings-relay-relaunch').waitFor()
    await page.evaluate(() => { window.xingmang.relaunchApp = async () => false })
    await page.getByTestId('settings-relay-relaunch-now').click()
    await waitForToast(page, '已取消重开')
    await expect(page.getByTestId('settings-relay-relaunch')).toBeVisible()
    assert.equal(await page.evaluate(async () => (await window.xingmang.getAccountSession()).account.userId), 17)
    await clean(page)
  } finally { await page.close() }
})

test('large text switch enlarges the small print and Ctrl plus / minus / 0 step the interface scale', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-claude').waitFor()
    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('page-settings')
    await settings.waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.largeText ?? 'false'), 'false')
    const before = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-small').trim())
    await settings.getByRole('switch', { name: '大字' }).click()
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.largeText)).toBe('true')
    const after = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-small').trim())
    assert.equal(before, '12.5px')
    assert.equal(after, '13.5px')
    function saves() { return page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0])) }
    assert.deepEqual((await saves()).at(-1), { version: 2, largeText: true })

    await page.keyboard.press('Control+Equal')
    await waitForToast(page, '界面放大到 110%，按 Ctrl 0 恢复')
    await expect.poll(async () => (await saves()).at(-1)).toEqual({ version: 2, uiScale: '110' })
    await settings.getByRole('button', { name: '110%', pressed: true }).waitFor()
    await page.keyboard.press('Control+Equal')
    await waitForToast(page, '界面已经放到最大的 110%，按 Ctrl 0 恢复')
    await page.keyboard.press('Control+Minus')
    await waitForToast(page, '界面缩小到 100%，按 Ctrl 0 恢复')
    await expect.poll(async () => (await saves()).at(-1)).toEqual({ version: 2, uiScale: '100' })
    await page.keyboard.press('Control+0')
    await waitForToast(page, '界面缩放已恢复为自动')
    await expect.poll(async () => (await saves()).at(-1)).toEqual({ version: 2, uiScale: 'auto' })
    await clean(page)
  } finally { await page.close() }
})

// 更新装完重新打开时，软件原来一句话都没有。现在角落里一张轻量卡片说一声已经在新版上、
// 列前几项改动，只有一颗「知道了」；完整清单在更新页。普通启动什么都不说。
test('the first launch after an update says which version it is on and lists the bundled changes', async () => {
  const page = await open('justUpdated=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const notice = page.getByTestId('startup-notice-updated')
    await notice.waitFor()
    await notice.getByText('已更新到 0.1.31', { exact: true }).waitFor()
    await notice.getByText('更新页能看到当前这一版改了什么', { exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    // 这是一件事实，不是失败，不该占一条错误日志。
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'reportRendererError' && entry.args[0]?.context !== 'account-bootstrap').length), 0)
    await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await expect.poll(() => page.getByTestId('startup-notice-updated').count()).toBe(0)
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    await updates.getByText('当前版本 0.1.31 更新内容', { exact: true }).waitFor()
    const notes = updates.getByTestId('updates-installed-notes')
    await notes.getByText('更新页能看到当前这一版改了什么。', { exact: true }).waitFor()
    assert.equal(await notes.locator('li').count(), 2)
    await clean(page)
  } finally { await page.close() }
})

// 老客户开机恢复账号后，主进程给落后于模板的配置补了缺省项：角落说一次补了哪几个工具、
// 什么没动、原来的在哪，只有一颗「知道了」。什么都没补时一句话也不说。
test('a restored login that filled newer tool settings says so once in the corner', async () => {
  const page = await open('templateFilled=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const notice = page.getByTestId('startup-notice-template-filled')
    await notice.waitFor()
    await notice.getByText('已把工具设置补齐到最新', { exact: true }).waitFor()
    assert.match(await notice.textContent(), /Claude Code、Codex/)
    assert.equal(await page.getByRole('dialog').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'fillToolTemplateDefaults').length), 1)
    await notice.getByRole('button', { name: '知道了', exact: true }).click()
    await expect.poll(() => page.getByTestId('startup-notice-template-filled').count()).toBe(0)
    await clean(page)
  } finally { await page.close() }
})

// 开机那轮 Codex 开着、设置没补成（第二十六批 E）：隔十分钟再要一次，这回补上了，角落照样
// 说一句；补上以后就不再要，回到前台也不要。
test('settings left unfilled while Codex was open get filled on a later try and announced then', async () => {
  const page = await open('templateDeferred=1', true)
  try {
    await page.getByTestId('page-home').waitFor()
    const fills = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'fillToolTemplateDefaults').map((entry) => entry.args[0] ?? null))
    await expect.poll(fills).toEqual([null])
    assert.equal(await page.getByTestId('startup-notice-template-filled').count(), 0)
    await page.clock.fastForward('10:00')
    const notice = page.getByTestId('startup-notice-template-filled')
    await notice.waitFor()
    assert.match(await notice.textContent(), /补上了 Codex 的几项设置/)
    assert.deepEqual(await fills(), [null, true])
    await page.clock.fastForward('30:00')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    assert.deepEqual(await fills(), [null, true])
    await clean(page)
  } finally { await page.close() }
})

test('coming back to the window asks again for settings left unfilled, two minutes after the last try at the earliest', async () => {
  const page = await open('templateDeferred=1', true)
  try {
    await page.getByTestId('page-home').waitFor()
    const fills = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'fillToolTemplateDefaults').map((entry) => entry.args[0] ?? null))
    await expect.poll(fills).toEqual([null])
    await page.clock.fastForward('01:00')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    assert.deepEqual(await fills(), [null])
    await page.clock.fastForward('01:00')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.getByTestId('startup-notice-template-filled').waitFor()
    assert.deepEqual(await fills(), [null, true])
    await clean(page)
  } finally { await page.close() }
})

// 升级后第一次开机几张卡一起来：角落最多摊开两张，要选的排最前，其余折成「还有 N 条提示」，
// 点开能看全、能收起；关掉一张后放得下了，那一行自己消失。
test('the startup corner shows two cards at most and folds the rest into one line', async () => {
  const page = await open('justUpdated=1&templateFilled=1&displayCompat=1')
  try {
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('startup-notice-display-compat').waitFor()
    const toggle = page.getByTestId('startup-notices-toggle')
    await expect.poll(() => toggle.textContent()).toBe('还有 1 条提示')
    // 「已更新」和「设置已补齐」同一档，谁先到谁摊开；只认定其中正好一张被折起来。
    const hiddenId = await page.getByTestId('startup-notice-updated').count() ? 'template-filled' : 'updated'
    assert.equal(await page.getByTestId(`startup-notice-${hiddenId}`).count(), 0)
    assert.equal(await page.getByTestId('startup-notices').locator('.xm-notice').count(), 2)
    await toggle.click()
    await page.getByTestId(`startup-notice-${hiddenId}`).waitFor()
    assert.equal(await toggle.textContent(), '收起')
    await toggle.click()
    await expect.poll(() => page.getByTestId(`startup-notice-${hiddenId}`).count()).toBe(0)
    await page.getByTestId('startup-notice-display-compat-primary').click()
    await expect.poll(() => page.getByTestId('startup-notice-display-compat').count()).toBe(0)
    await page.getByTestId('startup-notice-updated').waitFor()
    await page.getByTestId('startup-notice-template-filled').waitFor()
    assert.equal(await toggle.count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('an ordinary launch says nothing about updates', async () => {
  const page = await open()
  try {
    await page.getByTestId('page-home').waitFor()
    assert.equal(await page.getByTestId('startup-notice-updated').count(), 0)
    assert.equal(await page.getByTestId('startup-notice-template-filled').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('a failed manual update check still reports on the updates page', async () => {
  const page = await open('updateCheckFail=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    await updates.getByRole('button', { name: '检查更新', exact: true }).click()
    await updates.getByText('更新服务器暂时连不上', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('startup-notices').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 更新失败原来只有一句「更新没有装上」加一个「重新下载」，断网点一次「检查更新」
// 也是这句——更新根本还没开始下。三步各自的标题和按钮在这里一次看全。
test('the updates page names the step that failed and offers that step again', async () => {
  const page = await open('updateCheckFail=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    const stages = [
      { step: 'check', phase: 'error', title: '检查更新失败', retry: '重试', reason: '设备当前没有连上网络，请先连接网络再试。' },
      { step: 'download', phase: 'error', title: '下载更新失败', retry: '重新下载', reason: '连接更新服务器超时，请检查网络后再试。' },
      { step: 'install', phase: 'downloaded', title: '安装更新失败', retry: '重新安装', reason: '更新程序未能启动，已继续打开主程序；可在“检查更新”页重试安装' },
    ]
    for (const stage of stages) {
      await page.evaluate((value) => window.v2Test.emit('onUpdateState', {
        phase: value.phase, currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
        checkedAt: new Date().toISOString(), progress: null, failedStep: value.step,
        error: { code: 'UPDATE_ERROR', message: value.reason }, development: true,
      }), stage)
      const notice = updates.getByTestId(`updates-failure-${stage.step}`)
      await notice.waitFor()
      await notice.getByText(stage.title, { exact: true }).waitFor()
      await notice.getByText(stage.reason, { exact: true }).waitFor()
      await notice.getByRole('button', { name: stage.retry, exact: true }).waitFor()
      await notice.getByRole('button', { name: '查看日志', exact: true }).waitFor()
      // 首页那条浮动气泡读的是同一份文案，不许和页面说两套话；下载失败那条人在更新页时不弹（第 55 条）。
      if (stage.step === 'download') await expect.poll(() => page.locator('.v2-notification').count()).toBe(0)
      else await page.getByRole('alert').getByText(stage.title, { exact: true }).waitFor()
    }
    // 检查失败时的「重试」重新走检查，而不是去下载一个还没开始下的包。
    await updates.getByTestId('updates-failure-install').getByRole('button', { name: '重新安装', exact: true }).click()
    await page.getByRole('dialog', { name: '重启并安装更新？' }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 首页气泡说「下载更新失败」却只给「查看更新」，客户得换页再找按钮。气泡上直接
// 给那一步的重试，走的和更新页同一套：下载失败先重新查再下，安装失败落到更新页的
// 重启确认框，检查失败重新查。
test('the update failure bubble retries the failed step without a detour', async () => {
  const page = await open('updateRetryAvailable=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const emit = (step, phase, code, message) => page.evaluate((value) => window.v2Test.emit('onUpdateState', {
      phase: value.phase, currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, failedStep: value.step,
      error: { code: value.code, message: value.message }, development: true,
    }), { step, phase, code, message })
    const calls = (method) => page.evaluate((name) => window.v2Test.calls.filter((entry) => entry.method === name).length, method)

    await emit('download', 'error', 'ETIMEDOUT', '连接更新服务器超时，请检查网络后再试。')
    const bubble = page.getByRole('alert').filter({ hasText: '下载更新失败' })
    await bubble.waitFor()
    await bubble.getByRole('button', { name: '重新下载', exact: true }).click()
    await expect.poll(() => calls('downloadUpdate')).toBe(1)
    assert.equal(await calls('checkForUpdates'), 1)

    // 开机检查超时不算真的失败：用提醒色，说的是大白话，按钮是重新查。
    await emit('check', 'error', 'STARTUP_UPDATE_TIMEOUT', '网络有点慢，这次没来得及查完有没有新版本。星芒会在后台接着查，不影响现在使用。')
    const slow = page.locator('.xm-notice').filter({ hasText: '网络有点慢' })
    await slow.waitFor()
    assert.match(await slow.getAttribute('class'), /xm-tone-warn/)
    assert.equal(await page.getByRole('alert').filter({ hasText: '网络有点慢' }).count(), 0)
    await slow.getByRole('button', { name: '重试', exact: true }).click()
    await expect.poll(() => calls('checkForUpdates')).toBe(2)
    assert.equal(await calls('downloadUpdate'), 1)

    await emit('install', 'downloaded', 'UPDATE_ERROR', '更新程序未能启动，已继续打开主程序；可在“检查更新”页重试安装')
    const install = page.getByRole('alert').filter({ hasText: '安装更新失败' })
    await install.getByRole('button', { name: '重新安装', exact: true }).click()
    await page.getByTestId('page-updates').waitFor()
    await page.getByRole('dialog', { name: '重启并安装更新？' }).waitFor()
    assert.equal(await calls('installUpdate'), 0)
    await clean(page)
  } finally { await page.close() }
})

// 开机和每 3 小时自己跑的检查没查成，客户什么都没点：首页不弹红框，更新页照常能看到
// 这次失败和「重试」。客户自己点的检查没查成，照旧弹。
test('an automatic update check that fails stays off the home bubble but shows on the updates page', async () => {
  const page = await open('updateCheckFail=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    const emit = (automatic) => page.evaluate((flag) => window.v2Test.emit('onUpdateState', {
      phase: 'error', currentVersion: '0.1.31', availableVersion: null, releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, failedStep: 'check',
      error: { code: 'ERR_INTERNET_DISCONNECTED', message: '设备当前没有连上网络，请先连接网络再试。', ...(flag ? { automatic: true } : {}) }, development: true,
    }), automatic)

    await emit(true)
    const notice = updates.getByTestId('updates-failure-check')
    await notice.waitFor()
    await notice.getByRole('button', { name: '重试', exact: true }).waitFor()
    assert.equal(await page.getByRole('alert').filter({ hasText: '检查更新失败' }).count(), 0)

    await emit(false)
    await page.getByRole('alert').filter({ hasText: '检查更新失败' }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

// Mac 校验新版本签名没通过时，同一个包装多少遍都一样：更新页和首页气泡都不再给
//「重新安装」，改给「打开下载页」，让客户手动装一次。
test('a Mac signature rejection offers the download page instead of reinstalling', async () => {
  const page = await open('updateCheckFail=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    const reason = '新版本已经下载好了，但这台 Mac 校验它的时候没通过，自动安装装不上，再点也一样。请点「打开下载页」下载新版本的安装包，装好后打开就行。'
    await page.evaluate((message) => window.v2Test.emit('onUpdateState', {
      phase: 'downloaded', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, failedStep: 'install',
      error: { code: 'UPDATE_SIGNATURE_REJECTED', message }, development: true,
    }), reason)
    const notice = updates.getByTestId('updates-failure-install')
    await notice.getByText('安装更新失败', { exact: true }).waitFor()
    await notice.getByText(reason, { exact: true }).waitFor()
    await notice.getByRole('button', { name: '查看日志', exact: true }).waitFor()
    assert.equal(await notice.getByRole('button', { name: '重新安装', exact: true }).count(), 0)
    // 卡片头上的「重启安装」是同一条死路，也不能留。
    assert.equal(await updates.getByRole('button', { name: '重启安装', exact: true }).count(), 0)
    const bubble = page.getByRole('alert').filter({ hasText: '安装更新失败' })
    await bubble.getByRole('button', { name: '查看更新', exact: true }).waitFor()
    assert.equal(await bubble.getByRole('button', { name: '重新安装', exact: true }).count(), 0)

    const opened = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').map((entry) => entry.args[0]))
    const downloadPage = 'https://docs-new.solov.cc/guide/manager#download-installers'
    await notice.getByRole('button', { name: '打开下载页', exact: true }).click()
    await expect.poll(opened).toEqual([downloadPage])
    await bubble.getByRole('button', { name: '打开下载页', exact: true }).click()
    await expect.poll(opened).toEqual([downloadPage, downloadPage])
    assert.equal(await page.getByRole('dialog', { name: '重启并安装更新？' }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 下载停住、自动换直连重下也还是停住：有的公司网关先把整个安装包扣住查完才放行，再点
//「重新下载」多半还是一样。更新页和首页气泡在「重新下载」旁边多给「打开下载页」；别的下载
// 失败照旧只给「重新下载」。
test('a stalled update download offers the download page next to downloading again', async () => {
  const page = await open('updateCheckFail=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    const reason = '连接更新服务器超时，请检查网络后再试。'
    const emit = (code) => page.evaluate((value) => window.v2Test.emit('onUpdateState', {
      phase: 'error', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, failedStep: 'download',
      error: { code: value.code, message: value.reason }, development: true,
    }), { code, reason })
    await emit('UPDATE_DOWNLOAD_STALLED')
    const notice = updates.getByTestId('updates-failure-download')
    await notice.getByText('下载更新失败', { exact: true }).waitFor()
    await notice.getByText(reason, { exact: true }).waitFor()
    await notice.getByRole('button', { name: '重新下载', exact: true }).waitFor()
    await notice.getByRole('button', { name: '查看日志', exact: true }).waitFor()
    // 人在更新页时气泡不重复说一遍（第 55 条）。
    assert.equal(await page.locator('.v2-notification').count(), 0)

    const opened = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').map((entry) => entry.args[0]))
    const downloadPage = 'https://docs-new.solov.cc/guide/manager#download-installers'
    await notice.getByRole('button', { name: '打开下载页', exact: true }).click()
    await expect.poll(opened).toEqual([downloadPage])

    // 同一句「超时」，没经过看门狗的不算停住。
    await emit('ETIMEDOUT')
    await expect.poll(() => notice.getByRole('button', { name: '打开下载页', exact: true }).count()).toBe(0)
    await notice.getByRole('button', { name: '重新下载', exact: true }).waitFor()

    // 离开更新页，气泡照旧弹，按钮和页面上的一样。
    await page.getByTestId('nav-home').click()
    await emit('UPDATE_DOWNLOAD_STALLED')
    const bubble = page.getByRole('alert').filter({ hasText: '下载更新失败' })
    await bubble.getByRole('button', { name: '重新下载', exact: true }).waitFor()
    await bubble.getByRole('button', { name: '查看更新', exact: true }).waitFor()
    await bubble.getByRole('button', { name: '打开下载页', exact: true }).click()
    await expect.poll(opened).toEqual([downloadPage, downloadPage])
    await emit('ETIMEDOUT')
    await expect.poll(() => bubble.getByRole('button', { name: '打开下载页', exact: true }).count()).toBe(0)
    await bubble.getByRole('button', { name: '重新下载', exact: true }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 磁盘快满时新版本先不下：更新页和首页气泡都说清差多少，「怎么清理」就地展开步骤，
//「仍要下载」跳过这一次的空间预检。
test('the updates page explains a full disk and still lets the user download', async () => {
  const page = await open('updateCheckFail=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    await page.evaluate(() => window.v2Test.emit('onUpdateState', {
      phase: 'available', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, error: null, failedStep: null, development: true,
      diskShortfall: { neededBytes: 600 * 1024 ** 2, freeBytes: 380 * 1024 ** 2 },
    }))
    const notice = updates.getByTestId('updates-disk-shortfall')
    await notice.waitFor()
    await notice.getByText('还要再清出 220 MB', { exact: false }).waitFor()
    await page.getByRole('status').getByText('新版本先不下载', { exact: true }).waitFor()
    await notice.getByRole('button', { name: '怎么清理', exact: true }).click()
    await notice.getByTestId('updates-disk-cleanup').waitFor()
    await notice.getByRole('button', { name: '仍要下载', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'downloadUpdate'))
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'downloadUpdate'))
    assert.deepEqual(calls.at(-1).args, [{ ignoreDiskSpace: true }])
    await clean(page)
  } finally { await page.close() }
})

// 必须更新的门碰上磁盘不够：主进程不下载也不报错，门要说清差多少、给清理步骤，
//「空间够了，再试一次」重新量盘，「仍要下载」跳过预检，和更新页一样。
test('the required-update gate explains a full disk and lets the user retry', async () => {
  const page = await open('')
  try {
    const shortState = {
      phase: 'available', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, error: null, failedStep: null, development: false, requiredVersion: '0.1.32',
      diskShortfall: { neededBytes: 600 * 1024 ** 2, freeBytes: 380 * 1024 ** 2 },
    }
    await page.evaluate((state) => window.v2Test.emit('onUpdateState', state), shortState)
    const gate = page.getByTestId('required-update-gate')
    const notice = gate.getByTestId('required-update-disk')
    await notice.waitFor()
    await notice.getByText('还要再清出 220 MB', { exact: false }).waitFor()
    await notice.getByRole('button', { name: '怎么清理', exact: true }).click()
    await notice.getByTestId('required-update-disk-cleanup').waitFor()
    await gate.getByRole('button', { name: '空间够了，再试一次', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'downloadUpdate'))
    const first = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'downloadUpdate'))
    assert.notDeepEqual(first.at(-1).args, [{ ignoreDiskSpace: true }])
    // 量完还是不够：快照不变，门要多说一句，按钮仍然能点，不会卡在转圈。
    await page.evaluate((state) => window.v2Test.emit('onUpdateState', state), shortState)
    await notice.getByTestId('required-update-disk-still').waitFor()
    await gate.getByRole('button', { name: '仍要下载', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'downloadUpdate').length >= 2)
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'downloadUpdate'))
    assert.deepEqual(calls.at(-1).args, [{ ignoreDiskSpace: true }])
    await clean(page)
  } finally { await page.close() }
})

// Mac 自签包每换一版，第一次读登录信息都会弹「登录」钥匙串密码框；重启确认框里
// 先打招呼，Windows 没有这回事，不许多这一句。
test('the restart-to-install dialog warns about the keychain prompt on Mac and the consent window on Windows', async () => {
  for (const [query, expected] of [['os=mac', 1], ['', 0]]) {
    const page = await open(query)
    try {
      await page.getByTestId('nav-more').click()
      await page.getByTestId('nav-updates').click()
      const updates = page.getByTestId('page-updates')
      await updates.waitFor()
      await page.evaluate(() => window.v2Test.emit('onUpdateState', {
        phase: 'downloaded', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
        checkedAt: new Date().toISOString(), progress: null, failedStep: null, error: null, development: true,
      }))
      await updates.getByRole('button', { name: '重启安装', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '重启并安装更新？' })
      await dialog.waitFor()
      if (expected) await dialog.getByTestId('updates-mac-keychain-hint').getByText('始终允许', { exact: false }).waitFor()
      assert.equal(await dialog.getByTestId('updates-mac-keychain-hint').count(), expected, query || 'windows')
      // 反过来，Windows 要提醒的是授权窗口点「是」，Mac 上没有这个窗口。
      if (!expected) await dialog.getByTestId('updates-windows-consent-hint').getByText('点「是」', { exact: false }).waitFor()
      assert.equal(await dialog.getByTestId('updates-windows-consent-hint').count(), expected ? 0 : 1, query || 'windows')
      await clean(page)
    } finally { await page.close() }
  }
})

// 账号不在管理员组的 Windows 电脑：下好的新版本不自动装（第二十四批 2）。首页气泡和更新页「重启安装」
// 旁边说清要管理员密码、要谁来点，还没下好时也不说会自动装上，确认框不再只叫他点「是」，强制更新
// 那道门同样改口；字都是 yoyo 2026-10-06 批的原话。管理员账号照旧。
test('a Windows account outside the administrators group is told an administrator has to install updates', async () => {
  const page = await open('')
  try {
    await page.getByTestId('page-home').waitFor()
    const state = {
      phase: 'downloading', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: { percent: 40, bytesPerSecond: 1, transferred: 40, total: 100 }, failedStep: null, error: null, development: true,
      autoUpdateSupported: true, installNeedsAdminPassword: true,
    }
    const emit = (patch) => page.evaluate((value) => window.v2Test.emit('onUpdateState', value), { ...state, ...patch })
    await emit({})
    await page.locator('.xm-notice').getByText('正在后台下载；这台电脑装更新时要输入管理员密码，下好后不会自动装上。', { exact: true }).waitFor()

    await emit({ phase: 'downloaded', progress: null })
    const bubble = page.locator('.xm-notice').filter({ hasText: '这台电脑的账号不是管理员，装更新时要输入管理员密码。让有管理员账号的人点一次「重启安装」，或者找客服。' })
    await bubble.getByText('更新已下载', { exact: true }).waitFor()
    await bubble.getByRole('button', { name: '查看更新', exact: true }).click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    // 更新页进来自己再读一次状态：主进程读回的就是上面这份，夹具读回的是默认那份，所以再发一次。
    await emit({ phase: 'downloaded', progress: null })
    await updates.getByText('新版本会在后台下好；这台电脑装更新时要输入管理员密码，不会自动装上。', { exact: true }).waitFor()
    await updates.getByText('新版本在后台下好；这台电脑装更新时要输入管理员密码，不会自动装上。关掉后改成先提醒你，由你点安装', { exact: true }).waitFor()
    const notice = updates.getByTestId('updates-admin-password')
    await notice.getByText('这台电脑的账号不是管理员，装更新时要输入管理员密码', { exact: true }).waitFor()
    await notice.getByText('让有管理员账号的人点一次「重启安装」，或者找客服。', { exact: true }).waitFor()
    // 原话叫他点的就是卡片头上这颗按钮：自己点照样能装，确认框说清要输管理员密码。
    await updates.getByRole('button', { name: '重启安装', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '重启并安装更新？' })
    await dialog.getByTestId('updates-windows-consent-hint').getByText('Windows 会弹出一个授权窗口，要在里面输入管理员密码；点了「否」这次就装不上。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '稍后安装', exact: true }).click()

    await emit({ phase: 'downloaded', progress: null, installNeedsAdminPassword: false })
    await notice.waitFor({ state: 'detached' })
    await updates.getByText('新版本会在后台下好，等你关掉软件或下次打开时自动装上，不打断你正在用的。', { exact: true }).waitFor()

    // 强制更新那道门在开发环境不拦，这里按正式环境发。
    await emit({ phase: 'available', progress: null, development: false, requiredVersion: '0.1.32' })
    const gate = page.getByTestId('required-update-gate')
    await gate.getByTestId('required-update-admin-password').getByText('要输入管理员密码；让有管理员账号的人来点，或联系客服。', { exact: true }).waitFor()
    assert.equal(await gate.getByText('是否允许更改', { exact: false }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// Linux 的 .deb 交给系统安装窗口装：按钮不能叫「重启安装」（软件只关掉、不会自己重开），
// 确认框要先说清楚会弹安装窗口、要输开机密码。不是 .deb 装的那种根本没法自动更新，
// 更新页给一条去下载页的路，而不是一颗永远点不动的「检查更新」。
test('on Linux the updates page hands installing to the system installer and explains the password prompt', async () => {
  const page = await open('')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    await page.evaluate(() => window.v2Test.emit('onUpdateState', {
      phase: 'downloaded', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, failedStep: null, error: null, development: true,
      installMethod: 'system-installer',
    }))
    assert.equal(await updates.getByRole('button', { name: '重启安装', exact: true }).count(), 0)
    await updates.getByRole('button', { name: '安装新版本', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '安装新版本？' })
    await dialog.waitFor()
    await dialog.getByTestId('updates-system-installer-hint').getByText('输入开机密码', { exact: false }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '关掉并安装', exact: true }).count(), 1)
    await dialog.getByRole('button', { name: '稍后安装', exact: true }).click()

    await page.evaluate(() => window.v2Test.emit('onUpdateState', {
      phase: 'disabled', currentVersion: '0.1.31', availableVersion: null, releaseName: null, releaseNotesText: null,
      checkedAt: null, progress: null, failedStep: null, error: null, development: false,
      installMethod: 'manual',
    }))
    const manual = updates.getByTestId('updates-manual-install')
    await manual.waitFor()
    await manual.getByRole('button', { name: '打开下载页', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'openExternal'))
    const opened = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').at(-1).args)
    assert.deepEqual(opened, ['https://docs-new.solov.cc/guide/manager#download-installers'])
    await clean(page)
  } finally { await page.close() }
})

// 维护提示来自更新目录上的状态文件，没登录也得看得到：欢迎页角落一条，登录框是
// 模态的会盖住角落，所以框里再放一份。关掉的是这句话，发布者换了说法会再出现。
test('a maintenance notice from the update feed reaches signed-out users, including inside the login dialog', async () => {
  const page = await open('guest=1')
  try {
    await page.getByTestId('welcome-page').waitFor()
    const emit = (message) => page.evaluate((value) => window.v2Test.emit('onUpdateState', {
      phase: 'idle', currentVersion: '0.2.10', availableVersion: null, releaseName: null, releaseNotesText: null,
      checkedAt: null, progress: null, error: null, failedStep: null, development: true,
      serviceMaintenance: value === undefined ? null : { message: value },
    }), message)
    await emit('服务升级中，预计 22:00 恢复。')
    const corner = page.getByTestId('service-maintenance-notice')
    await corner.getByText('服务正在维护', { exact: true }).waitFor()
    await corner.getByText(/服务升级中，预计 22:00 恢复。 这不是你这边的问题/).waitFor()
    await page.getByTestId('welcome-login').click()
    const dialog = page.getByTestId('login-dialog')
    await dialog.getByTestId('auth-maintenance-notice').getByText('服务正在维护', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '关闭', exact: true }).first().click()
    await dialog.waitFor({ state: 'detached' })
    await corner.getByRole('button', { name: '关闭', exact: true }).click()
    await corner.waitFor({ state: 'detached' })
    await emit('服务升级中，预计 23:00 恢复。')
    await corner.getByText(/预计 23:00 恢复/).waitFor()
    await emit(undefined)
    await corner.waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

// 第 55 条：人就在更新页时，「新版本 X 可以安装」「正在下载更新」「下载更新失败」三种气泡说的是页面上
// 写着的同一件事，不弹；离开更新页照旧弹。「这个版本有已知问题」那种照旧。
test('the updates page does not pop the bubbles that repeat what it already says', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.getByText('当前环境暂不提供自动更新', { exact: true }).waitFor()
    const emit = (state) => page.evaluate((value) => window.v2Test.emit('onUpdateState', {
      currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, error: null, failedStep: null, development: true, ...value,
    }), state)
    const bubble = page.locator('.v2-notification')
    await emit({ phase: 'available' })
    await expect(updates.getByTestId('updates-new-version')).toContainText('0.1.32')
    assert.equal(await bubble.count(), 0)
    await emit({ phase: 'downloading', progress: { percent: 38, bytesPerSecond: 1, transferred: 38, total: 100 } })
    await updates.getByTestId('updates-progress-detail').waitFor()
    assert.equal(await bubble.count(), 0)
    await emit({ phase: 'error', failedStep: 'download', error: { code: 'ETIMEDOUT', message: '连接更新服务器超时，请检查网络后再试。' } })
    await updates.getByTestId('updates-failure-download').waitFor()
    assert.equal(await bubble.count(), 0)
    // 离开更新页照旧弹。
    await page.getByTestId('nav-home').click()
    await bubble.getByText('下载更新失败', { exact: true }).waitFor()
    await emit({ phase: 'available' })
    await bubble.getByText('新版本 0.1.32 可以安装', { exact: true }).waitFor()
    // 回到更新页那条又收起来；「这个版本有已知问题」人在更新页也照旧弹。
    await page.getByTestId('nav-updates').click()
    await expect(page.getByTestId('nav-updates')).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => bubble.count()).toBe(0)
    await emit({ phase: 'not-available', availableVersion: null, currentVersionWithdrawn: true })
    await bubble.getByText('这个版本有已知问题', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('nav-updates').getAttribute('aria-current'), 'page')
    await clean(page)
  } finally { await page.close() }
})

// 发布者撤回了本机这个版本、线上退回到旧版本时，界面不能再说「发现新版本」。
test('a withdrawn running version is called out and the older release is offered as a rollback', async () => {
  const page = await open()
  try {
    await page.getByTestId('page-home').waitFor()
    // 更新页打开时会自己重新读一次快照，所以进页面后要再推一次同样的状态。
    const emitWithdrawn = () => page.evaluate(() => window.v2Test.emit('onUpdateState', {
      phase: 'available', currentVersion: '0.2.10', availableVersion: '0.2.9', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, error: null, failedStep: null, development: true,
      serviceMaintenance: null, currentVersionWithdrawn: true, rollback: true,
    }))
    await emitWithdrawn()
    await page.getByText('建议退回 0.2.9', { exact: true }).waitFor()
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const updates = page.getByTestId('page-updates')
    await updates.waitFor()
    await emitWithdrawn()
    await updates.getByText('建议退回稳定版本', { exact: true }).waitFor()
    await updates.getByTestId('updates-current-withdrawn').getByText(/建议装回 0\.2\.9/).waitFor()
    assert.equal(await page.getByText('新版本 0.2.9 可以安装', { exact: true }).count(), 0)
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

test('a blocked announcement link is copied for the browser instead of failing', async () => {
  const page = await open('noticeMarkdown=1&externalBlocked=1')
  try {
    await page.evaluate(() => {
      window.__blockedLinkClipboard = { values: [], reject: false }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => {
          if (window.__blockedLinkClipboard.reject) throw new Error('Clipboard access denied')
          window.__blockedLinkClipboard.values.push(text)
        } },
      })
    })
    await page.getByTestId('page-home').waitFor()
    await page.getByRole('button', { name: /^公告/ }).click()
    const dialog = page.getByRole('dialog', { name: '公告' })
    const link = dialog.getByRole('link', { name: '官方说明' })
    await link.click()
    const hint = dialog.getByTestId('announcement-blocked-link')
    await expect(hint).toContainText('已经帮你复制好了')
    await expect(hint.locator('code')).toHaveText('https://xm.solov.cc/help')
    assert.deepEqual(await page.evaluate(() => window.__blockedLinkClipboard.values), ['https://xm.solov.cc/help'])
    await expect(dialog.getByRole('alert')).toHaveCount(0)
    await expect(dialog.getByText('不允许打开该链接')).toHaveCount(0)

    await page.evaluate(() => { window.__blockedLinkClipboard.reject = true })
    await link.click()
    await expect(hint).toContainText('请选中下面的地址复制')
    await expect(hint.locator('code')).toHaveText('https://xm.solov.cc/help')
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

test('a pinned recommendation does not turn the home update button into a Codex downgrade', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.evaluate(async () => {
      const snapshot = await window.xingmang.scanSystem()
      Object.assign(snapshot.clis.codex, {
        version: '0.157.0', latestVersion: '0.158.0', updateAvailable: true,
        versionAdvice: { recommendedVersion: '0.156.1', pinned: true, onRecommended: false, rollbackAvailable: true, blockedReason: null },
      })
      window.xingmang.scanSystem = async () => structuredClone(snapshot)
    })
    await page.getByTestId('home-rescan').click()
    const row = page.getByTestId('tool-row-codex')
    await expect(row).toContainText('0.157.0')
    assert.equal(await row.getByRole('button', { name: '更新', exact: true }).count(), 0)
    await row.getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '回到推荐版本 0.156.1', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'installCli')), false)
    await clean(page)
  } finally { await page.close() }
})

for (const pinned of [true, false]) {
  test(`the home CLI update installs the shown ${pinned ? 'recommended' : 'latest'} target`, async () => {
    const page = await open('allInstalled=1')
    try {
      await page.evaluate(async (pinned) => {
        const snapshot = await window.xingmang.scanSystem()
        Object.assign(snapshot.clis.codex, {
          version: '0.150.0', latestVersion: '0.158.0', updateAvailable: true,
          versionAdvice: { recommendedVersion: '0.156.1', pinned, onRecommended: false, rollbackAvailable: pinned, recommendedIsNewer: true, blockedReason: null },
        })
        window.xingmang.scanSystem = async () => structuredClone(snapshot)
      }, pinned)
      await page.getByTestId('home-rescan').click()
      const row = page.getByTestId('tool-row-codex')
      await expect(row).toContainText('0.150.0')
      await row.getByRole('button', { name: '更新', exact: true }).click()
      await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
      assert.deepEqual(await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'installCli').args),
        ['codex', pinned ? '0.156.1' : '0.158.0'])
      await clean(page)
    } finally { await page.close() }
  })
}

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

test('a key from another site is named for the account and switched from the row in one click', async () => {
  const page = await open('unknown=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.getByText('不是当前账号的 Key', { exact: true }).waitFor()
    assert.equal(await row.getByText('other.example.test').count(), 0)
    assert.equal((await page.getByTestId('tool-codex-use-account').textContent())?.trim(), '改用 fixture-user')
    await page.getByTestId('tool-codex-use-account').click()
    await waitForToast(page, 'Codex CLI 和 Codex 桌面端共用一份设置，已一起改好。')
    await row.getByText('已配好', { exact: true }).waitFor()
    const switched = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'switchAccountSource').map((entry) => entry.args))
    assert.deepEqual(switched, [['codex', 'account']])
    await clean(page)
  } finally { await page.close() }
})

test('the config dialog switches a foreign key in place without the old manual-key buttons', async () => {
  const page = await open('unknown=1')
  try {
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置', exact: true }).click()
    await page.getByTestId('tool-foreign-key-note').waitFor()
    assert.equal(await page.getByTestId('config-dialog').getByRole('button', { name: '填写星芒密钥' }).count(), 0)
    assert.equal(await page.getByTestId('config-dialog').getByRole('button', { name: '查看处理步骤' }).count(), 0)
    await page.getByTestId('tool-switch-account').click()
    await page.getByTestId('config-dialog').getByText('已改用 fixture-user，可以开始用了。').waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await clean(page)
  } finally { await page.close() }
})

test('configuration migration shares Codex drafts and failed saves retain the secret for retry', async () => {
  const page = await open('unknown=1')
  try {
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置', exact: true }).click()
    await page.getByTestId('tool-config-advanced').locator('summary').click()
    await page.getByTestId('tool-manual-key').click()
    await page.getByLabel('星芒访问密钥').fill('local-fixture-secret')
    await page.getByRole('tab', { name: 'Codex 桌面端', exact: true }).click()
    assert.equal(await page.getByLabel('星芒访问密钥').inputValue(), 'local-fixture-secret')
    await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await page.getByRole('button', { name: '检测模型', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await page.evaluate(() => { window.v2Test.fail = 'saveConfig' })
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('config-dialog').getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoToast(page, '配置保存成功')
    assert.equal(await page.getByLabel('星芒访问密钥').inputValue(), 'local-fixture-secret')
    await clean(page)
  } finally { await page.close() }
})

test('a manual relay key saved over a third-party config survives the next login bootstrap', async () => {
  const page = await open('guest=1&existing=1&unknown=1')
  try {
    await enterWorkspaceWithoutAccount(page, 'claude')
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置', exact: true }).click()
    await page.getByTestId('tool-config-advanced').locator('summary').click()
    await page.getByTestId('tool-manual-key').click()
    await page.getByLabel('星芒访问密钥').fill('local-fixture-secret')
    await page.getByRole('button', { name: '检测模型', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await page.getByTestId('tool-save-config').click()
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

const timelineRows = '[data-testid="announcement-list"] .v2-announcement-read-state'
async function expectTimelineStates(page, expected) {
  try {
    await page.waitForFunction(([selector, want]) => JSON.stringify([...document.querySelectorAll(selector)].map((node) => node.textContent)) === JSON.stringify(want), [timelineRows, expected])
  } catch (error) {
    assert.deepEqual(await page.locator(timelineRows).allTextContents(), expected)
    throw error
  }
}

test('the announcement timeline shows title, type, date and note, and only recent entries ask for attention', async () => {
  const page = await open('noticeTimeline=1&externalBlocked=1')
  try {
    await page.evaluate(() => {
      window.__blockedLinkClipboard = []
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__blockedLinkClipboard.push(text) } } })
    })
    await page.getByTestId('announcement-banner').getByText('图片模型上线', { exact: true }).waitFor()
    await page.getByTestId('announcement-open').click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    const list = dialog.getByTestId('announcement-list')
    await list.waitFor()
    assert.deepEqual(await list.locator('.v2-announcement-title').allTextContents(), ['图片模型上线', '本周维护通知', '开票中心上线测试'])
    assert.deepEqual(await list.locator('.v2-announcement-tag').allTextContents(), ['上新', '注意', '进行中'])
    // 一个月前的那条第一次出现就算已读，不会一下子全弹出来。
    await expectTimelineStates(page, ['未读', '未读', '已读'])
    assert.equal(await dialog.getByRole('button', { name: '标为已读', exact: true }).count(), 0)
    await list.locator('.v2-announcement-row').first().click()
    const detail = dialog.getByTestId('announcement-detail')
    await detail.getByRole('heading', { name: '图片模型上线' }).waitFor()
    assert.match(await detail.getByTestId('announcement-detail-meta').textContent(), /^上新\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 2 小时前$/)
    // 单个换行也要换行：三步说明逐行显示，不挤成一行。
    assert.equal(await detail.locator('.v2-announcement-content').first().locator('li').count(), 3)
    await detail.getByTestId('announcement-detail-extra').getByText(/勿发送 API 密钥/).waitFor()
    await detail.getByTestId('announcement-detail-extra').getByRole('link', { name: '联系客服' }).click()
    await expect(dialog.getByTestId('announcement-blocked-link').locator('code')).toHaveText('https://work.weixin.qq.com/kfid/fixture')
    assert.deepEqual(await page.evaluate(() => window.__blockedLinkClipboard), ['https://work.weixin.qq.com/kfid/fixture'])
    await dialog.getByRole('button', { name: '返回列表' }).click()
    await expectTimelineStates(page, ['已读', '未读', '已读'])
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.reload()
    await waitForFixtureReady(page)
    await page.getByTestId('announcement-open').click()
    await list.waitFor()
    await expectTimelineStates(page, ['已读', '未读', '已读'])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead')), false)
    await clean(page)
  } finally { await page.close() }
})

test('an old account keeps the moved-over notice read and counts unread entries from both sources', async () => {
  const page = await open('noticeCollection=1')
  try {
    await page.getByTestId('announcement-open').click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    const list = dialog.getByTestId('announcement-list')
    await list.getByRole('button', { name: '图片模型上线 未读' }).click()
    await dialog.getByRole('button', { name: '返回列表' }).click()
    await list.getByRole('button', { name: '图片模型上线 已读' }).waitFor()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    // 升级到读时间线的版本：服务端同时下发旧合集和时间线。
    await page.goto(page.url().replace('noticeCollection=1', 'noticeTimeline=1&noticeCollection=1'))
    await waitForFixtureReady(page)
    await page.getByTestId('announcement-open').click()
    await list.waitFor()
    assert.deepEqual(await list.locator('.v2-announcement-title').allTextContents(), ['图片模型上线', '本周维护通知', '开票中心上线测试', '图片模型上线', '旧模型下架通知', '发票中心上线'])
    // 搬过来的同名公告已读、一个月前的已读；未读是时间线 1 条加旧合集 2 条。
    await expectTimelineStates(page, ['已读', '未读', '已读', '已读', '未读', '未读'])
    await clean(page)
  } finally { await page.close() }
})

test('a new timeline entry shows up with the next balance refresh without another timer', async () => {
  const page = await open('noticeTimeline=1', true, () => { document.hasFocus = () => true })
  try {
    await page.getByTestId('announcement-banner').waitFor()
    await page.getByTestId('announcement-banner-close').click()
    await page.getByTestId('announcement-banner').waitFor({ state: 'hidden' })
    const noticeReads = () => page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'getAccountNotice').map((call) => call.args[0] ?? 'full'))
    const before = await noticeReads()
    assert.equal(before.includes('cached'), false)
    await page.evaluate(() => {
      const next = { id: `newapi-${'d'.repeat(64)}`, type: 'default', publishedAt: new Date(Date.now() - 60_000).toISOString(), extra: '', content: '**刚发布的公告**\n正文' }
      window.v2Test.setNotice({ id: 'newapi-timeline-fixture', text: '', bulletins: [next, ...window.v2Test.timelineFixture()] })
    })
    await page.clock.fastForward(60_000)
    await page.getByTestId('announcement-banner').getByText('刚发布的公告', { exact: true }).waitFor()
    // 跟着余额那次刷新走的检查只取主进程已有的数据，不单独再请求公告。
    assert.deepEqual(await noticeReads(), [...before, 'cached'])
    await clean(page)
  } finally { await page.close() }
})

test('recharge activity card lists bonus tiers and an activity bar stays on top after it is dismissed', async () => {
  const page = await open('', true, () => { document.hasFocus = () => true })
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.evaluate(() => {
      const hour = 60 * 60 * 1000
      const recharge = { id: `newapi-${'e'.repeat(64)}`, type: 'ongoing', publishedAt: new Date(Date.now() - hour).toISOString(), extra: '活动截止：2026-09-20 23:59', content: '**国庆礼遇 · 中秋同庆｜充值满赠**\nxm.solov.cc · 单笔充值最高送 100%' }
      const invite = { id: `newapi-${'f'.repeat(64)}`, type: 'ongoing', publishedAt: new Date(Date.now() - 2 * hour).toISOString(), extra: '', content: '**国庆礼遇 · 中秋同庆｜邀请有礼**\n邀请好友一起用' }
      window.v2Test.setNotice({ id: 'newapi-promo-fixture', text: '', bulletins: [recharge, invite] })
    })
    await page.clock.fastForward(60_000)
    const card = page.getByTestId('announcement-promo-card')
    await card.waitFor()
    await card.getByTestId('announcement-promo-tier-4000').waitFor()
    assert.equal(await card.getByTestId('announcement-promo-tier-10').count(), 0)
    assert.equal((await card.textContent()).includes('solov'), false)
    await card.getByTestId('announcement-promo-others').getByText('邀请有礼', { exact: false }).waitFor()
    // 大卡片在说活动时，首页不挂活动条，也不再出灰条。
    assert.equal(await page.getByTestId('announcement-promo-bar').count(), 0)
    assert.equal(await page.getByTestId('announcement-banner').count(), 0)
    await card.getByTestId('announcement-promo-dismiss').click()
    const bar = page.getByTestId('announcement-promo-bar')
    await bar.waitFor()
    assert.deepEqual(await bar.locator('.v2-promo-bar-item').allTextContents(), ['充值满赠9月20日截止，还剩 8 天', '邀请有礼'])
    await page.getByTestId('announcement-promo-bar-close').click()
    await bar.waitFor({ state: 'hidden' })
    assert.equal(await card.count(), 0)
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
    await page.getByRole('button', { name: '打开个人中心 other-user', exact: true }).waitFor()
    await page.getByTestId('announcement-open').click()
    // Opening reloads the new account's collection. The container can briefly
    // exist before that reload clears it; wait for both rows and their read
    // states to finish loading before taking the original synchronous snapshot.
    await expect(list.locator('.v2-announcement-title')).toHaveText(['第一条', '第二条'])
    await expect(list.locator('.v2-announcement-read-state')).toHaveText(['未读', '未读'])
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
    await list.getByRole('button', { name: '服务通知 09-28 未读', exact: true }).waitFor()
    await list.getByRole('button', { name: '套餐更新 09-20 未读', exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('announcement-detail').count(), 0)
    assert.equal(await dialog.getByText('系统升级完成', { exact: true }).count(), 0)
    assert.equal(await dialog.getByText('套餐详情已更新', { exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'markAccountNoticeRead')), [])
    await page.screenshot({ path: path.join(artifacts, 'sub2api-announcements.png') })

    await list.getByTestId('announcement-item-12').click()
    const detail = dialog.getByTestId('announcement-detail')
    await detail.getByRole('heading', { name: '服务通知', level: 2, exact: true }).waitFor()
    // 历史账号的公告没有类型标签，详情里只写发布时间。
    assert.match(await detail.getByTestId('announcement-detail-meta').textContent(), /^2026-09-28 \d{2}:\d{2} · \d+ (天|个月|年)前$/)
    assert.equal(await detail.locator('strong').innerText(), '系统升级完成')
    assert.equal(await dialog.getByText('套餐详情已更新', { exact: true }).count(), 0)
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'markAccountNoticeRead'))
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await list.getByRole('button', { name: '服务通知 09-28 已读', exact: true }).waitFor()
    await list.getByRole('button', { name: '套餐更新 09-20 未读', exact: true }).waitFor()
    assert.equal(await button.locator('.v2-unread').count(), 0)

    await list.getByTestId('announcement-item-12').click()
    await detail.getByRole('heading', { name: '服务通知', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await list.getByTestId('announcement-item-8').click()
    await detail.getByRole('heading', { name: '套餐更新', level: 2, exact: true }).waitFor()
    await detail.getByText('套餐详情已更新', { exact: true }).waitFor()
    assert.equal(await dialog.locator('script').count(), 0)
    assert.equal(await page.evaluate(() => window.nativeXss), undefined)
    assert.equal(await button.locator('.v2-unread').count(), 0)
    const writes = await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'markAccountNoticeRead'))
    assert.deepEqual(writes.map((call) => call.args), [['sub2api-notices', '12'], ['sub2api-notices', '8']])
    await page.screenshot({ path: path.join(artifacts, 'sub2api-announcement-detail.png') })
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await button.click()
    await list.getByRole('button', { name: '服务通知 09-28 已读', exact: true }).waitFor()
    await list.getByRole('button', { name: '套餐更新 09-20 已读', exact: true }).waitFor()
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
    assert.equal(await button.locator('.v2-unread').count(), 0)
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await dialog.getByRole('button', { name: '服务通知 09-28 未读', exact: true }).waitFor()
    await dialog.getByTestId('announcement-item-12').click()
    await dialog.getByRole('alert').getByText('本地测试操作失败').waitFor()
    await page.evaluate(() => { window.v2Test.fail = '' })
    await dialog.getByRole('button', { name: '重试保存已读', exact: true }).click()
    await dialog.getByRole('alert').waitFor({ state: 'hidden' })
    await dialog.getByTestId('announcement-detail').getByText('系统升级完成', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await dialog.getByRole('button', { name: '服务通知 09-28 已读', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '套餐更新 09-20 未读', exact: true }).waitFor()
    assert.equal(await button.locator('.v2-unread').count(), 0)
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
    assert.equal(await button.locator('.v2-unread').count(), 0)
    await dialog.getByRole('button', { name: '返回列表', exact: true }).click()
    await dialog.getByRole('button', { name: '服务通知 09-28 已读', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '套餐更新 09-20 未读', exact: true }).waitFor()
    await page.evaluate(() => window.v2Test.releaseNoticeMark('8'))
    await dialog.getByRole('button', { name: '套餐更新 09-20 已读', exact: true }).waitFor()
    assert.equal(await button.locator('.v2-unread').count(), 0)
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

test('announcement banner can be closed, stays closed after reload, and returns only for a notice not seen yet', async () => {
  const page = await open('noticeCollection=1')
  try {
    const button = page.getByTestId('announcement-open')
    const banner = page.getByTestId('announcement-banner')
    await banner.waitFor()
    await button.locator('.v2-unread').waitFor()
    await page.getByRole('button', { name: '关闭公告提示' }).click()
    await banner.waitFor({ state: 'hidden' })
    // The bell dot is lifted through App state one render after the banner hides.
    await button.locator('.v2-unread').waitFor({ state: 'hidden' })
    const [seenKey, seen] = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => name.startsWith('xingmang-v2-notice-seen:'))
      return [key, JSON.parse(localStorage.getItem(key) ?? '[]')]
    })
    assert.equal(seen.length, 3)
    await page.reload()
    await page.getByTestId('tool-row-codex').waitFor()
    // Absence only means something once the collection has been read and its read state synced.
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'syncLocalNoticeReads'))
    await page.waitForTimeout(500)
    assert.equal(await banner.count(), 0)
    assert.equal(await button.locator('.v2-unread').count(), 0)
    // Closing only quiets the reminder; every entry is still listed as unread.
    await button.click()
    const dialog = page.getByRole('dialog', { name: '公告', exact: true })
    // Opening the center re-reads the notice, so wait for the list before reading its rows.
    await dialog.getByTestId('announcement-list').waitFor()
    assert.deepEqual(await dialog.getByTestId('announcement-list').locator('.v2-announcement-read-state').allTextContents(), ['未读', '未读', '未读'])
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    // Simulate a newly published entry: one unread key this account has never seen.
    await page.evaluate(([key, keys]) => localStorage.setItem(key, JSON.stringify(keys)), [seenKey, seen.slice(1)])
    await page.reload()
    await banner.waitFor()
    await button.locator('.v2-unread').waitFor()
    await banner.getByRole('button', { name: '查看' }).click()
    await dialog.getByTestId('announcement-list').waitFor()
    assert.equal(await banner.count(), 0)
    await button.locator('.v2-unread').waitFor({ state: 'hidden' })
    await clean(page)
  } finally { await page.close() }
})

test('a notice published while the app is open shows up on the next background check and notifies once when the window is away', async () => {
  const page = await open('noticeCollection=1', true)
  try {
    const button = page.getByTestId('announcement-open')
    const banner = page.getByTestId('announcement-banner')
    await banner.waitFor()
    await page.getByRole('button', { name: '关闭公告提示' }).click()
    await banner.waitFor({ state: 'hidden' })
    await button.locator('.v2-unread').waitFor({ state: 'hidden' })
    // The window goes behind other apps; system notifications are the only way to reach the user now.
    await page.evaluate(() => {
      window.__notified = []
      window.xingmangPlatform = { notifyActivity: async (kind, key) => { window.__notified.push([kind, key]); return 'requested' } }
      document.hasFocus = () => false
      window.v2Test.setNotice({ id: 'collection-with-new-entry', text: `<div data-newapi-collection="v1">
        <details class="collection-entry"><summary class="collection-summary"><span class="collection-entry-title">新活动上线</span></summary><div class="collection-body"><p>活动详情</p></div></details>
      </div>` })
    })
    await page.clock.fastForward('10:30')
    await banner.getByText('新活动上线').waitFor()
    await button.locator('.v2-unread').waitFor()
    const notified = await page.evaluate(() => window.__notified)
    assert.equal(notified.length, 1)
    assert.equal(notified[0][0], 'announcement')
    assert.match(notified[0][1], /^notice-[0-9a-f]{8}$/)
    // The same notice is never announced twice, even after further checks.
    await page.clock.fastForward('10:30')
    await page.waitForFunction(() => window.v2Test.calls.filter((call) => call.method === 'getAccountNotice').length >= 3)
    assert.equal(await page.evaluate(() => window.__notified.length), 1)
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
        await dialog.getByRole('button', { name: '服务通知 09-28 已读', exact: true }).click()
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


test('balances poll every minute only while the window has focus, pause while hidden, and refresh when returning after five seconds', async () => {
  const page = await open('sub2api=1', true, () => {
    window.fixtureFocus = true
    document.hasFocus = () => window.fixtureFocus
  })
  const reads = () => page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'getAccountBalance').length)
  const visibility = (value) => page.evaluate((state) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }, value)
  try {
    await page.getByTestId('home-balance').getByText('$12.40', { exact: true }).waitFor()
    assert.equal(await reads(), 1)
    await page.clock.fastForward(59_999)
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
    // 窗口还在屏幕上但用户在用别的程序：不按时刷新，切回来再刷。
    await page.evaluate(() => { window.fixtureFocus = false })
    await page.clock.fastForward(300_000)
    assert.equal(await reads(), 3)
    await page.evaluate(() => { window.fixtureFocus = true; window.dispatchEvent(new Event('focus')) })
    await page.waitForFunction(() => window.v2Test.calls.filter((call) => call.method === 'getAccountBalance').length === 4)
    await visibility('hidden')
    await page.clock.fastForward(120_000)
    assert.equal(await reads(), 4)
    await page.evaluate(() => window.v2Test.setBalance(9.5))
    await visibility('visible')
    await page.getByTestId('home-balance').getByText('$9.50', { exact: true }).waitFor()
    assert.equal(await reads(), 5)
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
    await page.getByTestId('account-refresh').click()
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
    await list.getByTestId('saved-account-row-saved-aa0017').getByText('历史账号', { exact: true }).waitFor()
    assert.doesNotMatch(await list.innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov|账户尾号|aa0017/i)
    await list.getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('dialog', { name: '切换账号', exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '打开个人中心 fixture-user' }).click()
    await page.getByTestId('account-display').waitFor()
    assert.deepEqual(await page.getByTestId('account-tabs').getByRole('tab').allTextContents(), ['我的账号', '密钥'])
    await page.getByTestId('announcement-open').click()
    const notice = page.getByRole('dialog', { name: '公告', exact: true })
    await notice.getByRole('button', { name: '服务通知 09-28 未读', exact: true }).waitFor()
    assert.equal(await notice.getByText('本地测试公告', { exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('tools on the backup route follow a switch to a historical account', async () => {
  const page = await open('crossSite=1&directRelayActive=1&routedSwitch=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    const list = page.getByTestId('saved-accounts-list')
    await expect(list.getByTestId('account-sync-claude')).toBeChecked()
    await expect(list.getByTestId('account-sync-codex')).toBeChecked()
    await list.getByRole('button', { name: '切换', exact: true }).click()
    // 两个都换过去了，没有要用户看的：切换框自己关掉，不留「用的是别处的配置，保持原配置」。
    await page.getByRole('dialog', { name: '切换账号', exact: true }).waitFor({ state: 'hidden' })
    const writes = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').map((entry) => entry.args[0]))
    assert.deepEqual(writes, [
      { providers: ['claude'], preferredModels: { claude: 'fixture-model' }, intent: 'explicit' },
      { providers: ['codex'], preferredModels: { codex: 'fixture-model' }, intent: 'explicit' },
    ])
    const addresses = await page.evaluate(async () => {
      const { providers } = await window.xingmang.getConfig()
      return [providers.claude.actualBaseUrl, providers.codex.actualBaseUrl]
    })
    assert.deepEqual(addresses, ['https://api.solov.cc', 'https://api.solov.cc/v1'])
    await clean(page)
  } finally { await page.close() }
})

test('relogin on an expired saved account opens the login dialog on that account source with its remembered email, not its nickname', async () => {
  const page = await open('crossSite=1&rememberedLegacy=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    const list = page.getByTestId('saved-accounts-list')
    await list.getByTestId('saved-account-row-saved-aa0017').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'switchSavedAccount'; window.v2Test.failMessage = '保存的账号登录已失效，请重新登录' })
    await list.getByRole('button', { name: '切换', exact: true }).click()
    await list.getByTestId('saved-account-relogin-saved-aa0017').click()
    const dialog = page.getByTestId('login-dialog')
    await dialog.getByRole('heading', { name: '登录历史账号' }).waitFor()
    // 这一行存的是昵称 fixture-user，历史账号却只认注册邮箱：不预填昵称，带出记住的邮箱（#480 复核 F12）。
    await page.waitForFunction(() => document.querySelector('[data-testid="login-account"]')?.value === 'user@example.test')
    // 取消后当前账号不变，下一次普通登录也不带着刚才那个账号的来源和名字（不串草稿）。
    await page.getByTestId('login-cancel').click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'loginAccount').length), 0)
    await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.failMessage = '' })
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    await page.getByTestId('account-add').click()
    await page.getByRole('heading', { name: '登录星芒账号' }).waitFor()
    assert.equal(await page.getByTestId('login-account').inputValue(), '')
    await clean(page)
  } finally { await page.close() }
})

test('configuring a tool from the key page makes the home page re-read tool configuration', async () => {
  const page = await open('keyOptions=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.getByRole('button', { name: '打开个人中心 fixture-user' }).click()
    await page.getByTestId('account-display').waitFor()
    await page.getByTestId('account-tabs').getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByRole('button', { name: '密钥 custom-key 的更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '配置到工具', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '配置到工具', exact: true })
    await dialog.getByLabel('选择工具').selectOption('codex')
    await dialog.getByLabel('选择模型').locator('option[value="fixture-other"]').waitFor({ state: 'attached' })
    await dialog.getByLabel('选择模型').selectOption('fixture-other')
    const reads = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getConfig').length)
    const before = await reads()
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByText('密钥已写入工具配置', { exact: true }).waitFor()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'getConfig').length > count, before)
    const calls = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.ok(calls.lastIndexOf('getConfig') > calls.indexOf('saveConfigWithAccountKey'))
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
    await page.getByTestId('auth-source-expand').click()
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
  assert.equal(await page.getByRole('dialog', { name: /重置为初始状态|放弃未保存/ }).count(), 0)
}

async function openConfigAdvanced(page) {
  const advanced = page.getByTestId('tool-config-advanced')
  if (!(await advanced.evaluate((element) => element.open))) await advanced.locator('summary').click()
}

const defaultModelCases = [
  { tool: 'claude', provider: 'claude', model: 'claude-opus-5' },
  { tool: 'codex', provider: 'codex', model: 'gpt-6-astra' },
  { tool: 'codexDesktop', provider: 'codex', model: 'gpt-6-astra' },
  { tool: 'gemini', provider: 'gemini', model: 'gemini-3.8-flash-high' },
  { tool: 'grok', provider: 'grok', model: 'grok-4.6' },
]
// 没登录时欢迎页挡在前面（本机有 Key 也一样）。配好模型的工具走完使用步骤进首页再开配置；
// 没配模型的工具在引导「确认连接」那一步就能打开配置，未登录用户实际也是这么走的。
async function openGuestToolConfiguration(page, tool, existing) {
  if (existing) {
    if (await page.getByTestId('welcome-page').count()) await enterWorkspaceWithoutAccount(page)
    return openToolConfiguration(page, tool)
  }
  if (await page.getByTestId('welcome-page').count()) {
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId(`guide-route-${tool}`).check()
    await page.getByTestId('guide-next').click()
    await page.locator('[data-guide-step="prepare"]').waitFor()
    await page.getByTestId('guide-next').click()
    await page.locator('[data-guide-step="connect"]').waitFor()
  }
  await page.getByTestId('guide-config').click()
  await page.getByTestId('config-dialog').waitFor()
}
for (const existing of [false, true]) for (const { tool, provider, model } of defaultModelCases) {
  test(`${tool} model detection ${existing ? 'preserves the saved model' : `defaults to ${model} before the first returned model`}`, async () => {
    const page = await open(`guest=1&existing=1&allInstalled=1&keyOptions=1&cliDefaultModels=1${existing ? '' : '&cliMissingModels=1'}`)
    try {
      await openGuestToolConfiguration(page, tool, existing)
      const expected = existing ? 'fixture-model' : model
      assert.equal(await page.getByLabel('默认模型').inputValue(), expected)
      await page.getByTestId('tool-detect-models').click()
      await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
      assert.equal(await page.getByLabel('默认模型').inputValue(), expected)
      assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'listConfiguredModels').map((entry) => entry.args)), [[provider]])
      await page.getByTestId('tool-save-config').click()
      await waitForSavedConfiguration(page)
      assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfig').map((entry) => entry.args[0])), [
        { provider, apiKey: '', model: expected, mode: 'merge' },
      ])
      await openGuestToolConfiguration(page, tool, existing)
      assert.equal(await page.getByLabel('默认模型').inputValue(), expected)
      await clean(page)
    } finally { await page.close() }
  })
}

// Google 从 2026-06-18 起不再服务个人账号（含 AI Pro / Ultra 订阅），Gemini CLI
// 的官方来源只剩企业版 Code Assist。选项留着给企业客户，但限制要跟选项一起出现，
// 而不是等用户选完、保存完、在 Google 登录页上失败几次之后才知道。
test('Gemini marks the official source enterprise-only and still defaults to the relay key', async () => {
  const page = await open('allInstalled=1')
  try {
    await openToolConfiguration(page, 'gemini')
    const dialog = page.getByTestId('config-dialog')
    assert.equal(await dialog.getByRole('button', { name: 'Google 企业版账号', exact: true }).count(), 1)
    assert.equal(await dialog.getByRole('button', { name: '使用星芒账号', exact: true }).getAttribute('aria-pressed'), 'true')
    const note = await page.getByTestId('tool-source-note').innerText()
    assert.match(note, /个人 Google 账号/)
    assert.match(note, /企业版 Code Assist/)
    await dialog.getByRole('tab', { name: 'Claude Code', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-source-note"]'))
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await clean(page)
  } finally { await page.close() }
})

test('configuration keeps the current local key by default and saves through the reuse sentinel', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    const select = page.getByTestId('tool-key-select')
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"] option[value="automatic"]')?.disabled === false)
    assert.equal(await select.inputValue(), 'current')
    assert.match(await select.locator('option:checked').innerText(), /保持当前.*sk-co••••1234/)
    assert.match(await page.getByTestId('tool-key-summary').innerText(), /继续用现在这把密钥：名称未确认 · sk-co••••1234/)
    assert.doesNotMatch(await page.getByTestId('tool-key-summary').innerText(), /分组|Custom group/)
    await page.getByTestId('tool-detect-models').click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await openConfigAdvanced(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /密钥：名称未确认[\s\S]*分组：分组未确认[\s\S]*sk-co••••1234[\s\S]*fixture-model/)
    await page.getByTestId('tool-save-config').click()
    await waitForSavedConfiguration(page)
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.find((entry) => entry.method === 'saveConfig').args[0], { provider: 'codex', apiKey: '', model: 'fixture-model', mode: 'merge' })
    assert.equal(actions.some((entry) => ['configureManagedCliKeys', 'saveConfigWithAccountKey', 'revealApiKey', 'listAccountKeyModels'].includes(entry.method)), false)
    assert.deepEqual(actions.find((entry) => entry.method === 'listConfiguredModels').args, ['codex'])
    assert.equal(await page.evaluate(() => localStorage.getItem(`xingmang-v2:provider-source:v1:${encodeURIComponent('https://xm.solov.cc')}:codex`)), null)
    await clean(page)
  } finally { await page.close() }
})

// 「为什么没有 6.1 Sol」：下拉框里只有已选的那一个，客户以为只能用它。工具里已经是当前
// 账号的 Key 时，打开窗口就读一次：只填下拉框，选中的型号不动，也不算改动。
test('configuration lists the current key models on open without changing the selected model', async () => {
  const page = await open('keyOptions=1&cliDefaultModels=1')
  try {
    const start = await page.evaluate(() => window.v2Test.calls.length)
    await openToolConfiguration(page)
    const model = page.getByTestId('tool-default-model')
    await model.locator('option[value="gpt-6-astra"]').waitFor({ state: 'attached' })
    await expect(page.getByTestId('tool-detect-models')).toBeEnabled()
    assert.equal(await model.inputValue(), 'fixture-model')
    assert.deepEqual(await model.locator('option').evaluateAll((options) => options.map((option) => option.value)), ['codex-auto-review', 'gpt-6-astra', 'fixture-model'])
    const calls = await page.evaluate((from) => window.v2Test.calls.slice(from), start)
    const reads = calls.filter((entry) => entry.method === 'listConfiguredModels').map((entry) => entry.args)
    assert.ok(reads.length >= 1)
    assert.ok(reads.every((args) => args.length === 1 && args[0] === 'codex'))
    assert.equal(calls.some((entry) => ['revealApiKey', 'revealAccountKey', 'listModels', 'listAccountKeyModels', 'saveConfig', 'saveConfigWithAccountKey'].includes(entry.method)), false)
    const dialog = page.getByTestId('config-dialog')
    assert.equal(await dialog.getByRole('alert').count(), 0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('dialog', { name: '要放弃未保存的修改吗？' }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('configuration stays quiet when the model read on open fails and the detect button still explains why', async () => {
  const page = await open('keyOptions=1')
  try {
    await page.evaluate(() => { window.v2Test.fail = 'listConfiguredModels'; window.v2Test.failMessage = '模型接口暂时不可用' })
    await openToolConfiguration(page)
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'listConfiguredModels'))
    const detect = page.getByTestId('tool-detect-models')
    await expect(detect).toBeEnabled()
    const dialog = page.getByTestId('config-dialog')
    assert.equal(await dialog.getByRole('alert').count(), 0)
    assert.equal(await page.getByTestId('tool-default-model').inputValue(), 'fixture-model')
    await detect.click()
    await dialog.getByRole('alert').filter({ hasText: '模型接口暂时不可用' }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.failMessage = '' })
    await clean(page)
  } finally { await page.close() }
})

test('configuration stays usable while the model read on open is pending and drops a late answer for the previous tool', async () => {
  const page = await open('keyOptions=1&cliDefaultModels=1')
  try {
    await page.evaluate(() => window.v2Test.holdConfiguredModels('codex'))
    await openToolConfiguration(page)
    const detect = page.getByTestId('tool-detect-models')
    await expect(detect).toHaveAttribute('aria-busy', 'true')
    assert.equal(await page.locator('.v2-config-controls').evaluate((element) => element.disabled), false)
    assert.equal(await page.getByTestId('tool-key-select').isDisabled(), false)
    await page.getByTestId('config-dialog').getByRole('tab', { name: 'Claude Code', exact: true }).click()
    const model = page.getByTestId('tool-default-model')
    await model.locator('option[value="claude-opus-5"]').waitFor({ state: 'attached' })
    await expect(detect).toBeEnabled()
    await page.evaluate(async () => {
      window.v2Test.releaseConfiguredModels('codex')
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await model.locator('option[value="gpt-6-astra"]').count(), 0)
    assert.equal(await model.inputValue(), 'fixture-model')
    await expect(detect).toBeEnabled()
    await clean(page)
  } finally { await page.close() }
})

for (const { name, query, tool } of [
  { name: 'signed out', query: 'guest=1&existing=1&allInstalled=1', tool: 'codex' },
  { name: 'manually entered key', query: 'manualClaude=1', tool: 'claude' },
  { name: 'key from another site', query: 'unknown=1', tool: 'codex' },
]) test(`configuration does not read models on open for a ${name}`, async () => {
  const page = await open(query)
  try {
    await openGuestToolConfiguration(page, tool, true)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'listConfiguredModels')), false)
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
    await openConfigAdvanced(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /custom-key[\s\S]*Custom group[\s\S]*sk-ot••••1234[\s\S]*fixture-other/)
    await page.getByTestId('tool-save-config').click()
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
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"] option[value="automatic"]')?.disabled === false)
    assert.equal(await select.inputValue(), 'current')
    assert.equal(await select.locator('option[value="automatic"]').innerText(), '自动准备（推荐）')
    // 打开时那把「当前」的 Key 会先读一次模型；改选自动准备以后，保存前不该再读、也不该写。
    const opened = await page.evaluate(() => window.v2Test.calls.length)
    await select.selectOption('automatic')
    assert.equal(await page.getByTestId('tool-detect-models').count(), 0)
    assert.equal(await page.getByTestId('tool-key-summary').innerText(), '保存时自动准备好密钥，不用自己创建')
    const before = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(before.slice(opened).includes('listConfiguredModels') || before.includes('configureManagedCliKeys'), false)
    await openConfigAdvanced(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /xingmang-desktop-codex[\s\S]*Codex_pro[\s\S]*保存时准备或复用/)
    await page.getByTestId('tool-save-config').click()
    await waitForSavedConfiguration(page)
    await openToolConfiguration(page)
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"]')?.value === 'current' && document.querySelector('[data-testid="tool-key-summary"]')?.textContent.includes('coding-key'))
    assert.equal(await page.getByLabel('默认模型').inputValue(), 'gpt-5.6-sol')
    assert.match(await page.getByTestId('tool-key-summary').innerText(), /coding-key · sk-se••••9012/)
    await expect(page.getByTestId('tool-detect-models')).toBeEnabled()
    await clean(page)
  } finally { await page.close() }
})

// 第十一批候选 6：自动准备的密钥以前要「保存 → 关窗 → 重开 → 检测」才能换模型，
// 现在一颗按钮保存并检测，留在对话框里。
test('save and detect prepares the automatic key once, keeps the dialog open and adopts the saved model', async () => {
  const page = await open('keyOptions=1&sub2api=1&autoFallback=1')
  try {
    await openToolConfiguration(page)
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"] option[value="automatic"]')?.disabled === false)
    await page.getByTestId('tool-key-select').selectOption('automatic')
    await page.getByTestId('tool-save-detect-models').click()
    await page.getByTestId('tool-save-detect-notice').waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoToast(page, '配置保存成功')
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.filter((entry) => entry.method === 'configureManagedCliKeys').map((entry) => entry.args[0]), [
      { providers: ['codex'], preferredModels: { codex: 'fixture-model' }, mode: 'merge', intent: 'explicit' },
    ])
    assert.deepEqual(actions.find((entry) => entry.method === 'listConfiguredModels').args, ['codex'])
    assert.equal(await page.getByLabel('默认模型').inputValue(), 'gpt-5.6-sol')
    // 刚保存过、模型也没改：直接关掉不该再问「放弃未保存的修改」。
    await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).click()
    await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
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
    await openConfigAdvanced(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /来源：ChatGPT 账号/)
    await page.getByTestId('tool-save-config').click()
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
    // Codex 的中文开关只在从星芒打开时拿得到：这段先说清从哪打开，再说重试。
    await page.getByText('中文界面只在从星芒打开 Codex 时生效，直接点开始菜单、任务栏或桌面上的 Codex 图标打开还是英文。从星芒打开仍显示英文时，可再次点击启用。运行中的 Codex 会重新打开，请先保存手头的工作。', { exact: true }).waitFor()
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
    await page.getByRole('heading', { name: '要让 Codex 的界面显示中文吗？' }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'launchCodexDesktop').length), 0)
    // 开端口是安全取舍：焦点落在「先不用」，两个按钮都不是主按钮。
    const decline = page.getByTestId('codex-chinese-decline')
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'codex-chinese-decline')
    assert.equal(await decline.innerText(), '先不用')
    assert.equal(await page.getByTestId('codex-chinese-enable').innerText(), '显示中文')
    for (const button of [decline, page.getByTestId('codex-chinese-enable')]) {
      assert.equal(await button.evaluate((element) => element.classList.contains('xm-btn-primary')), false)
    }
    const question = await page.getByRole('dialog', { name: '要让 Codex 的界面显示中文吗？' }).innerText()
    assert.doesNotMatch(question, /调试端口/)
    assert.match(question, /关掉 Codex，通道也跟着关上。中文只在从星芒打开时生效，直接点 Codex 自己的图标打开还是英文。/)

    await decline.click()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'launchCodexDesktop'))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls
      .filter((call) => call.method === 'saveSettings' && call.args[0]?.codexDesktopChineseRuntimePatch !== undefined)
      .map((call) => call.args[0].codexDesktopChineseRuntimePatch)), ['disabled'])
    await page.getByRole('heading', { name: '要让 Codex 的界面显示中文吗？' }).waitFor({ state: 'hidden' })

    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((call) => call.method === 'launchCodexDesktop').length === 2)
    assert.equal(await page.getByRole('heading', { name: '要让 Codex 的界面显示中文吗？' }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('turns the Chinese runtime patch on through the locale path when the one-time question is accepted', async () => {
  const page = await open('chineseAsk=1')
  try {
    await page.getByTestId('tool-codexDesktop-primary').click()
    await page.getByRole('button', { name: '显示中文', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'launchCodexDesktop'))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'setCodexDesktopLocale').map((call) => call.args)), [['zh-CN']])
    assert.equal(await page.evaluate(() => window.v2Test.calls
      .some((call) => call.method === 'saveSettings' && call.args[0]?.codexDesktopChineseRuntimePatch !== undefined)), false)
    await clean(page)
  } finally { await page.close() }
})

test('a CLI launch still opens but warns when the project folder overrides the current account', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&launchOverride=1')
  try {
    await page.getByTestId('tool-claude-primary').click()
    await page.getByText('这个项目文件夹里有自己的设置，会让 Claude Code 不用当前账号，余额和用量会对不上。不是你有意这样设的话，换一个文件夹打开就好。', { exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'launchCli').map((call) => call.args)), [['claude', 'C:\\work\\my-app']])
    await clean(page)
  } finally { await page.close() }
})

// 第十二批候选 5：默认模型下架时打开前问一句，点了才换，不点照旧打开。
test('opening a tool whose default model is gone asks first and only swaps the model when told to', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&modelGone=1')
  try {
    await page.getByTestId('tool-claude-primary').click()
    const question = page.getByTestId('model-swap-question')
    await question.waitFor()
    assert.match(await question.innerText(), /当前账号用不了了/)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'launchCli' || call.method === 'saveConfig')), false, '回答之前既不打开也不改配置')
    await page.getByTestId('model-swap-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'launchCli'))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'saveConfig').map((call) => call.args[0])),
      [{ provider: 'claude', apiKey: '', model: 'claude-opus-5-5', mode: 'merge' }])
    await question.waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

test('keeping the old model opens the tool without touching its config, and closing the question opens nothing', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&modelGone=1')
  try {
    await page.getByTestId('tool-claude-primary').click()
    await page.getByTestId('model-swap-question').waitFor()
    await page.keyboard.press('Escape')
    await page.getByTestId('model-swap-question').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'launchCli')), false)
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.getByTestId('tool-claude-primary').click()
    await page.getByTestId('model-swap-keep').click()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'launchCli'))
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'saveConfig')), false)
    await clean(page)
  } finally { await page.close() }
})

// #538：换模型的提问属于发起时那个账号，中途切号要替用户关掉，不打开也不改配置。
test('switching accounts while the model question is open drops it without opening or saving', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&modelGone=1')
  try {
    await page.getByTestId('tool-claude-primary').click()
    await page.getByTestId('model-swap-question').waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 } }))
    await page.getByTestId('model-swap-question').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'launchCli' || call.method === 'saveConfig')), false)
    await clean(page)
  } finally { await page.close() }
})

// 第四十批 B：记录页的「接着聊」以前直接叫主进程打开，首页打开前那几道关（核对默认模型、
// 没连好账号先去连、Codex 老配置先修）一道都没过。
const recordsResumedNotice = '已打开Claude Code，接着 C:\\work\\my-app 里最近的一条对话'
async function resumeFromRecords(page) {
  await page.getByTestId('nav-sessions').click()
  await page.getByTestId('sessions-resume-claude:1').click()
}
async function waitForRecordsIdle(page) {
  await page.waitForFunction(() => document.querySelector('[data-testid="sessions-resume-claude:1"]')?.disabled === false)
}
function launchCliCalls(page) {
  return page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'launchCli').map((call) => call.args))
}

test('resuming from the records page checks the tool first and opens right away when every check passes', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await resumeFromRecords(page)
    await waitForToast(page, recordsResumedNotice)
    assert.deepEqual(await launchCliCalls(page), [['claude', 'C:\\work\\my-app', 'resumeLast']])
    const methods = await page.evaluate(() => window.v2Test.calls.map((call) => call.method))
    assert.ok(methods.includes('checkToolModels') && methods.indexOf('checkToolModels') < methods.indexOf('launchCli'), '打开之前和首页一样核过默认模型')
    await clean(page)
  } finally { await page.close() }
})

test('resuming from the records page asks about a gone default model first and only swaps it when told to', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&modelGone=1')
  try {
    await resumeFromRecords(page)
    const question = page.getByTestId('model-swap-question')
    await question.waitFor()
    assert.match(await question.innerText(), /当前账号用不了了/)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'launchCli' || call.method === 'saveConfig')), false, '回答之前既不打开也不改配置')
    await page.getByTestId('model-swap-confirm').click()
    await waitForToast(page, recordsResumedNotice)
    // 先把模型换好，再接着聊。
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls
      .filter((call) => call.method === 'saveConfig' || call.method === 'launchCli')
      .map((call) => call.method === 'saveConfig' ? [call.method, call.args[0]] : [call.method, ...call.args])), [
      ['saveConfig', { provider: 'claude', apiKey: '', model: 'claude-opus-5-5', mode: 'merge' }],
      ['launchCli', 'claude', 'C:\\work\\my-app', 'resumeLast'],
    ])
    await question.waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

test('closing the records page question opens nothing, and keeping the old model resumes without touching the config', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&modelGone=1')
  try {
    await resumeFromRecords(page)
    await page.getByTestId('model-swap-question').waitFor()
    await page.keyboard.press('Escape')
    await page.getByTestId('model-swap-question').waitFor({ state: 'detached' })
    await waitForRecordsIdle(page)
    // 和问话框里点了关掉一样：什么都不打开，不报错，也不说「已打开」。
    assert.deepEqual(await launchCliCalls(page), [])
    await assertNoToast(page, recordsResumedNotice)
    assert.equal(await page.locator('.v2-business-notice.is-error').count(), 0)
    await page.getByTestId('sessions-resume-claude:1').click()
    await page.getByTestId('model-swap-keep').click()
    await waitForToast(page, recordsResumedNotice)
    assert.deepEqual(await launchCliCalls(page), [['claude', 'C:\\work\\my-app', 'resumeLast']])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'saveConfig')), false)
    await clean(page)
  } finally { await page.close() }
})

test('resuming a tool that is not connected to the current account opens its settings instead of the tool', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&unknownClaude=1')
  try {
    await resumeFromRecords(page)
    await page.getByRole('dialog', { name: 'Claude Code 配置' }).waitFor()
    await page.locator('.v2-business-notice.is-error').filter({ hasText: '请先确认账号连接，再打开工具。' }).waitFor()
    assert.deepEqual(await launchCliCalls(page), [])
    await clean(page)
  } finally { await page.close() }
})

test('switching accounts while the records page question is open drops it without resuming or saving', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&modelGone=1')
  try {
    await resumeFromRecords(page)
    await page.getByTestId('model-swap-question').waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 } }))
    await page.getByTestId('model-swap-question').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((call) => call.method === 'launchCli' || call.method === 'saveConfig')), false)
    await assertNoToast(page, recordsResumedNotice)
    await clean(page)
  } finally { await page.close() }
})

// 首页、托盘的「打开」一次只放一个，记录页「接着聊」不走那里：记录页那一问还开着时从托盘打开工具，
// 后来的一问顶掉它。记录页这次不打开，也不能一直转圈等一个再也没人回答的问题。
test('a tool opened from the tray while the records page question is open takes the question over', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1&modelGone=1')
  try {
    await resumeFromRecords(page)
    await page.getByTestId('model-swap-question').waitFor()
    await page.evaluate(() => window.v2Test.emit('onLaunchTool', 'claude'))
    await waitForRecordsIdle(page)
    await page.getByTestId('model-swap-keep').click()
    await page.waitForFunction(() => window.v2Test.calls.some((call) => call.method === 'launchCli'))
    // 托盘开的是新对话，文件夹和首页按钮挑的一样（第四十批 A）：Claude Code 最近一条记录在 my-app。
    assert.deepEqual(await launchCliCalls(page), [['claude', 'C:\\work\\my-app']])
    await assertNoToast(page, recordsResumedNotice)
    await page.getByTestId('model-swap-question').waitFor({ state: 'detached' })
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

// 第十一批候选 6：保存不再二选一，「重置」收进「高级」，仍要二次确认。
test('reset lives under advanced, needs a confirmation and cancelling it keeps the draft without writing', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`keyOptions=1&theme=${theme}`)
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openToolConfiguration(page)
      await page.getByRole('button', { name: 'ChatGPT 账号', exact: true }).click()
      assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'switchToOfficialAccount')), false)
      await page.getByRole('button', { name: '使用星芒账号', exact: true }).click()
      await page.getByTestId('tool-key-select').selectOption('202')
      assert.equal(await page.getByTestId('tool-save-reset').isVisible(), false)
      await openConfigAdvanced(page)
      const advanced = page.getByTestId('tool-config-advanced')
      assert.match(await advanced.innerText(), /只改账号、密钥和模型/)
      assert.match(await page.getByTestId('tool-save-reset').innerText(), /重置为初始状态/)
      assert.equal(await advanced.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return [...element.querySelectorAll('.v2-save-options button')].some((button) => {
          const rect = button.getBoundingClientRect()
          return button.scrollWidth > button.clientWidth || rect.left < bounds.left || rect.right > bounds.right || rect.height < 44
        })
      }), false)
      await advanced.screenshot({ path: path.join(artifacts, `config-advanced-${theme}.png`) })
      await page.getByTestId('tool-save-reset').click()
      const reset = page.getByRole('dialog', { name: '重置为初始状态？' })
      await reset.getByRole('button', { name: '取消', exact: true }).click()
      await reset.waitFor({ state: 'hidden' })
      assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
      assert.equal(await page.getByTestId('tool-key-select').inputValue(), '202')
      assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => ['saveConfig', 'saveConfigWithAccountKey', 'configureManagedCliKeys', 'switchToOfficialAccount'].includes(entry.method))), false)
      await clean(page)
    } finally { await page.close() }
  }
})

test('pending merge configuration cannot close or write twice, then closes with a success toast', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('tool-key-select').selectOption('202')
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    const save = page.getByTestId('tool-save-config')
    await save.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfigWithAccountKey'))
    assert.equal(await page.getByRole('dialog', { name: '重置为初始状态？' }).count(), 0)
    assert.equal(await save.isDisabled(), true)
    assert.equal(await page.getByTestId('config-dialog').locator('[data-modal-close]').isDisabled(), true)
    assert.equal(await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoToast(page, '配置保存成功')
    await page.evaluate(() => window.v2Test.releaseConfigSave())
    await waitForSavedConfiguration(page)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfigWithAccountKey').map((entry) => entry.args[0])), [
      { provider: 'codex', keyId: 202, model: 'fixture-model', mode: 'merge' },
    ])
    await clean(page)
  } finally { await page.close() }
})

test('pending reset configuration cannot close or write twice, then closes with a success toast', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('tool-key-select').selectOption('202')
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    await openConfigAdvanced(page)
    await page.getByTestId('tool-save-reset').click()
    const confirmation = page.getByRole('dialog', { name: '重置为初始状态？' })
    const commit = confirmation.getByRole('button', { name: '备份并重置', exact: true })
    await commit.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfigWithAccountKey'))
    assert.equal(await commit.isDisabled(), true)
    assert.equal(await confirmation.locator('[data-modal-close]').isDisabled(), true)
    assert.equal(await confirmation.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
    assert.equal(await page.getByTestId('config-dialog').locator('[data-modal-close]').isDisabled(), true)
    assert.equal(await page.getByTestId('tool-save-config').isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await confirmation.isVisible(), true)
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoToast(page, '配置保存成功')
    await page.evaluate(() => window.v2Test.releaseConfigSave())
    await waitForSavedConfiguration(page)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfigWithAccountKey').map((entry) => entry.args[0])), [
      { provider: 'codex', keyId: 202, model: 'fixture-model', mode: 'reset' },
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
      await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"] option[value="automatic"]')?.disabled === false)
      await page.getByTestId('tool-key-select').selectOption('automatic')
    }
    if (source === 'official') await page.getByRole('button', { name: 'ChatGPT 账号', exact: true }).click()
    if (source === 'manual') {
      await openConfigAdvanced(page)
      await page.getByTestId('tool-manual-key').click()
      await page.getByLabel('星芒访问密钥').fill('local-fixture-secret')
      await page.getByTestId('tool-detect-models').click()
      await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    }
    await openConfigAdvanced(page)
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
    await openConfigAdvanced(page)
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

// 第十一批 2：能代装的平台上，认不出版本的 Node 不再拦住安装，而是在同一次「安装」
// 里先重新准备运行环境，再装工具；两段各记一次调用，顺序固定。
test('an unreadable Node version is prepared again inside the same install (R-G6)', async () => {
  const page = await open('nodeVersionUnknown=1')
  try {
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.getByTestId('tool-gemini-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method).filter((method) => method === 'installNodeRuntime' || method === 'installCli'))
    assert.deepEqual(methods, ['installNodeRuntime', 'installCli'])
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

test('a failed runtime stage says the tool never started and does not run the CLI install', async () => {
  const page = await open('nodeVersionUnknown=1&nodeInstallFail=1')
  try {
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.getByTestId('tool-gemini-primary').click()
    await page.getByTestId('operation-error-detail').filter({ hasText: 'Node.js 运行环境没装上，Gemini CLI 还没开始安装' }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'installCli')), false)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await clean(page)
  } finally { await page.close() }
})

// MSI 回 3010：Windows 要重启才算把 Node.js 装完，这时不接着装工具（会失败），
// 而是停下来弹「现在重启」（第七批 5 的那个框）。
test('a runtime stage that needs a Windows restart stops before the CLI install and asks to restart', async () => {
  const page = await open('nodeVersionUnknown=1&nodeRestart=1')
  try {
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.getByTestId('tool-gemini-primary').click()
    await page.getByTestId('runtime-restart-dialog').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'installCli')), false)
    assert.equal(await page.getByTestId('operation-error-detail').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('an unreadable Node version still blocks the CLI install where the app cannot install Node (R-G6)', async () => {
  const page = await open('nodeVersionUnknown=1&runtimeExternal=1')
  try {
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.getByTestId('tool-gemini-primary').click()
    await page.getByTestId('operation-error-detail').filter({ hasText: '版本无法识别' }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'installCli')), false)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await clean(page)
  } finally { await page.close() }
})

test('a permission failure hands over the install directory instead of offering to elevate (A2)', async () => {
  const page = await open('installPermissionDenied=1')
  try {
    // 打包版里 navigator.clipboard 仍可能被系统拒绝，无头 Chromium 也没有授权，
    // 所以这里把它换成一个记录器：要验的是「复制了哪个路径」，不是浏览器权限。
    await page.evaluate(() => {
      window.__copied = []
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text) => { window.__copied.push(text); return Promise.resolve() } },
      })
    })
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.getByTestId('tool-gemini-primary').click()
    const dialog = page.getByTestId('operation-error')
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /写不进安装目录/)
    // 这颗按钮已经没有了：本程序按普通权限运行，提权重试等于换一套安装事务。
    assert.equal(await page.getByRole('button', { name: /管理员/ }).count(), 0)
    const target = '/home/fixture/.npm-global/lib/node_modules/@google/gemini-cli'
    assert.equal(await page.getByTestId('operation-error-path').innerText(), target)
    await page.getByTestId('operation-error-copyPath').click()
    await page.getByTestId('operation-error-copied').waitFor()
    assert.deepEqual(await page.evaluate(() => window.__copied), [target])
    // 复制不关对话框：后端原话和「查看日志」都还在。
    assert.equal(await dialog.count(), 1)
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await clean(page)
  } finally { await page.close() }
})

test('an unreadable Node version leaves the guide runtime step to the one install button (R-G6)', async () => {
  const page = await open('nodeVersionUnknown=1&guest=1&missingConfig=1')
  try {
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-gemini').check()
    await page.getByTestId('guide-next').click()
    const guide = page.getByTestId('start-guide')
    await guide.getByText('点「安装」就行，缺的运行环境会一并装好。', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('guide-node').count(), 0)
    await expect(page.getByTestId('guide-install')).toBeEnabled()
    await expect(page.getByTestId('guide-next')).toBeDisabled()
    await clean(page)
  } finally { await page.close() }
})

test('an unreadable Node version leaves the guide runtime step unfinished where the app cannot install Node (R-G6)', async () => {
  const page = await open('nodeVersionUnknown=1&guest=1&missingConfig=1&runtimeExternal=1')
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

// 第四十一批 B：「安装卸载」页和首页各记各的那几条路。R-G3 只补了「安装卸载」页装工具这一条。
test('uninstalling on the maintenance page takes the tool off the home page tools', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.getByTestId('home-your-tools').getByTestId('tool-row-claude').waitFor()
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    await expect(page.getByTestId('maintenance-state-claude')).toHaveText('已安装')
    await page.getByRole('button', { name: 'Claude Code 的更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '卸载工具', exact: true }).click()
    await page.getByRole('dialog', { name: '卸载工具？', exact: true }).getByRole('button', { name: '确认卸载', exact: true }).click()
    await waitForToast(page, '工具已卸载，配置已保留')
    await expect(page.getByTestId('maintenance-state-claude')).toHaveText('未安装')
    // 以前首页还摆着它、写着「打开」，点了才报「未检测到 Claude Code，请先安装」。
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home-available').getByTestId('tool-claude-primary')).toHaveText('安装')
    assert.equal(await page.getByTestId('home-your-tools').getByTestId('tool-row-claude').count(), 0)
    await clean(page)
  } finally { await page.close() }
})
test('installing Node.js on the maintenance page updates the home runtime card', async () => {
  const page = await open('desktopOnly=1')
  try {
    const node = page.getByTestId('home-runtime-row-node')
    await expect(node).toContainText('未装')
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    await page.getByTestId('maintenance-runtime-action-node').click()
    await expect(page.getByTestId('maintenance-runtime-state-node')).toHaveText('已安装')
    assert.match(await page.getByTestId('maintenance-runtime-node').innerText(), /24\.0\.0/)
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home-runtime-row-node')).toContainText('v24.0.0')
    await clean(page)
  } finally { await page.close() }
})
test('a tool installed from the home page reads as installed on a maintenance page opened earlier', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('未安装')
    await page.getByTestId('nav-home').click()
    await page.evaluate(() => window.v2Test.holdNextInstall())
    await page.getByTestId('tool-gemini-primary').click()
    await page.getByTestId('nav-maintenance').click()
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('安装中')
    await page.evaluate(() => window.v2Test.releaseInstall())
    // 以前任务一完这一行就回到进页时读的那份：又写「未安装」，按钮又是「安装」。
    await expect(page.getByTestId('maintenance-state-gemini')).toHaveText('已安装')
    assert.match(await page.getByTestId('maintenance-tool-gemini').innerText(), /2\.0\.0/)
    await expect(page.getByTestId('maintenance-install-gemini')).toHaveText('重新安装')
    await clean(page)
  } finally { await page.close() }
})
test('a tool uninstalled from the home page reads as missing on a maintenance page opened earlier', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    await expect(page.getByTestId('maintenance-state-grok')).toHaveText('已安装')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('tool-row-grok').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '卸载', exact: true }).click()
    await page.getByRole('dialog', { name: '卸载 Grok CLI？', exact: true }).getByRole('button', { name: '卸载工具', exact: true }).click()
    await page.getByTestId('home-available').getByTestId('tool-row-grok').waitFor()
    await page.getByTestId('nav-maintenance').click()
    await expect(page.getByTestId('maintenance-state-grok')).toHaveText('未安装')
    await page.getByRole('button', { name: 'Grok CLI 的更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '检查更新', exact: true }).waitFor()
    assert.equal(await page.getByRole('menuitem', { name: '卸载工具', exact: true }).count(), 0)
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
    // 每个工具一行：工具名、小标、一句结论；第二句（测了什么）收进「查看详情」。
    const claude = page.getByTestId('health-connection-result-claude')
    await claude.waitFor()
    await expect(claude.locator('.xm-row-title')).toContainText('Claude Code')
    await expect(claude.locator('.xm-pill')).toHaveText('正常')
    await expect(claude.locator('.xm-row-desc')).toHaveText('连接正常，claude-opus-5 可以直接使用')
    assert.equal(await claude.getByText('已用 claude-opus-5 发过一次最小请求').count(), 0)
    await claude.getByRole('button', { name: '查看详情', exact: true }).click()
    const details = page.getByTestId('health-connection-details')
    await details.getByRole('heading', { name: 'Claude Code · 正常', exact: true }).waitFor()
    await details.getByText('已用 claude-opus-5 发过一次最小请求', { exact: true }).waitFor()
    // 抽屉盖在每行右头的「查看详情」上，先关掉再看下一个工具。
    await details.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(details).toHaveCount(0)
    // 只读探测的结论要如实说出来，不能照 Claude 那句「发过一次最小请求」套。
    await page.getByTestId('health-connection-result-codex').getByRole('button', { name: '查看详情', exact: true }).click()
    await details.getByRole('heading', { name: 'Codex CLI · 正常', exact: true }).waitFor()
    await details.getByText('已核对当前账号的可用模型清单，gpt-6-astra 在其中', { exact: true }).waitFor()
    await details.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(details).toHaveCount(0)
    for (const provider of ['gemini', 'grok']) {
      const row = page.getByTestId(`health-connection-result-${provider}`)
      // 未配置不是失败：小标是灰的「未配置」，不是红的「有问题」，只给一条「去处理」。
      await expect(row.locator('.xm-pill')).toHaveText('未配置')
      await expect(row.locator('.xm-pill')).toHaveClass(/xm-tone-neutral/)
      await row.getByRole('button', { name: '去处理', exact: true }).waitFor()
    }
    // 有问题的排前：没配的两条排在正常的两条前面，同一档里照注册表的次序。
    const order = await page.getByTestId('health-connection').locator('[data-testid^="health-connection-result-"]')
      .evaluateAll((rows) => rows.map((row) => row.dataset.testid.replace('health-connection-result-', '')))
    assert.deepEqual(order.filter((id) => ['claude', 'codex', 'gemini', 'grok'].includes(id)), ['gemini', 'grok', 'claude', 'codex'])
    assert.equal(await page.getByTestId('health-connection-idle').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the paid Codex tool-call check requires fresh consent and drops an old-account result', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    const consent = page.getByTestId('health-codex-responses-consent').getByRole('switch')
    const run = page.getByTestId('health-codex-responses-run')
    await expect(run).toBeDisabled()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'probeCodexResponses').length), 0)
    await page.evaluate(() => window.v2Test.holdNextResponses())
    await consent.click()
    await run.click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'probeCodexResponses').length === 1)
    await expect(run).toBeDisabled()
    await page.evaluate(async () => {
      const current = await window.xingmang.getAccountSession()
      window.v2Test.emit('onAccountSessionChanged', {
        ...current, account: { ...current.account, userId: 18 },
      })
      window.v2Test.releaseResponses()
    })
    await expect(consent).toBeEnabled()
    assert.equal(await page.getByTestId('health-codex-responses-result').count(), 0)
    await expect(run).toBeDisabled()

    await consent.click()
    await run.click()
    await page.getByTestId('health-codex-responses-result').getByText('Codex 干活检查 · 正常', { exact: true }).waitFor()
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'probeCodexResponses'))
    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map((entry) => entry.args), [[true, 'xm-account:17'], [true, 'xm-account:18']])
    await expect(run).toBeDisabled()
    await clean(page)
  } finally { await page.close() }
})

test('account switch during session read prevents the paid Codex check IPC entirely', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    const consent = page.getByTestId('health-codex-responses-consent').getByRole('switch')
    const run = page.getByTestId('health-codex-responses-run')
    const previousReads = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getAccountSession').length)
    await page.evaluate(() => window.v2Test.holdNextAccountSession())
    await consent.click()
    await run.click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'getAccountSession').length > count, previousReads)
    await page.evaluate(async () => {
      const current = { authenticated: true, account: {
        userId: 18, username: 'new-user', group: 'default', role: 1, quota: 0, usedQuota: 0,
      } }
      window.v2Test.emit('onAccountSessionChanged', current)
      window.v2Test.releaseAccountSession()
    })
    await expect(consent).toBeEnabled()
    await expect(run).toBeDisabled()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'probeCodexResponses').length), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the paid Codex check waits for startup account restore instead of reporting a changed account', async () => {
  const page = await open('restoring=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-codex-responses-consent').getByRole('switch').click()
    await page.getByTestId('health-codex-responses-run').click()
    await page.getByTestId('health-codex-responses-error').getByText('账号还在登录中，请等几秒再检查', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'probeCodexResponses').length), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the paid Codex check stays hidden when Codex is not installed', async () => {
  const page = await open('codexMissing=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').waitFor()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'scanSystem'))
    assert.equal(await page.getByTestId('health-codex-responses').count(), 0)
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
    await expect(claude.locator('.xm-pill')).toHaveText('有问题')
    await expect(claude.locator('.xm-pill')).toHaveClass(/xm-tone-bad/)
    await expect(claude.locator('.xm-row-desc')).toHaveText('当前账号分组下没有可用渠道（HTTP 503）')
    // 出问题的是哪一层，点「查看详情」看。
    await claude.getByRole('button', { name: '查看详情', exact: true }).click()
    const details = page.getByTestId('health-connection-details')
    await details.getByRole('heading', { name: 'Claude Code · 账号分组', exact: true }).waitFor()
    await details.getByRole('button', { name: '关闭', exact: true }).click()
    // 测不成的那一条是「没测成」，排在「有问题」后面、「未配置」前面。
    const codex = page.getByTestId('health-connection-error-codex')
    await expect(codex.locator('.xm-pill')).toHaveText('没测成')
    await expect(codex.locator('.xm-row-desc')).toHaveText('自检没能完成')
    const order = await page.getByTestId('health-connection').locator('[data-testid^="health-connection-"]:is([data-testid*="-result-"], [data-testid*="-error-"])')
      .evaluateAll((rows) => rows.map((row) => row.dataset.testid.replace(/^health-connection-(result|error)-/, '')))
    assert.deepEqual(order.filter((id) => ['claude', 'codex', 'gemini', 'grok'].includes(id)), ['claude', 'codex', 'gemini', 'grok'])
    // 分组层的下一步是重签一把 Key，所以这一条给的是「重新写入 Key」；仍旧跳页的
    // 那几层（这里是未配置的 Gemini）继续给「去处理」。
    await claude.getByRole('button', { name: '重新写入 Key', exact: true }).waitFor()
    await page.getByTestId('health-connection-result-gemini').getByRole('button', { name: '去处理', exact: true }).click()
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    // 一个工具的 IPC 抛错只影响它自己那一条。
    await page.getByTestId('health-connection-run').click()
    await page.getByTestId('health-connection-error-codex').waitFor()
    await page.getByTestId('health-connection-result-gemini').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 候选 1：密钥 / 分组层报错时，按钮要就地把 Key 重写一遍，而不是把用户丢到账号页。
test('the self-check key layer rewrites the current account Key in place and re-runs itself', async () => {
  const page = await open('connectionCredential=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').click()
    const claude = page.getByTestId('health-connection-result-claude')
    await expect(claude.locator('.xm-pill')).toHaveText('有问题')
    await expect(claude.locator('.xm-row-desc')).toHaveText('密钥被拒绝（HTTP 401）')
    // 账号页上并没有「写入 Key」这颗按钮，所以这一层不再给「去处理」。
    assert.equal(await page.getByTestId('health-connection-fix-claude').count(), 0)
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length)
    await page.getByTestId('health-connection-rewrite-claude').click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length > count, before)
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys'))
    assert.deepEqual(calls.at(-1).args[0].providers, ['claude'])
    // 写完自己再测一遍：用户不用回到页头再点一次「测试连接」。
    await expect(claude.locator('.xm-pill')).toHaveText('正常')
    await expect(claude.locator('.xm-row-desc')).toHaveText('连接正常，claude-opus-5 可以直接使用')
    await clean(page)
  } finally { await page.close() }
})

test('a failed rewrite says what the backend said instead of claiming it was fixed', async () => {
  const page = await open('connectionCredential=1')
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').click()
    await page.getByTestId('health-connection-rewrite-claude').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'configureManagedCliKeys'; window.v2Test.failMessage = '当前账号的分组暂时不可用' })
    await page.getByTestId('health-connection-rewrite-claude').click()
    await page.getByText('当前账号的分组暂时不可用', { exact: false }).waitFor()
    // 没写成就不该把结论刷成正常。
    const claude = page.getByTestId('health-connection-result-claude')
    await expect(claude.locator('.xm-pill')).toHaveText('有问题')
    await expect(claude.locator('.xm-row-desc')).toHaveText('密钥被拒绝（HTTP 401）')
    await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.failMessage = '' })
    await clean(page)
  } finally { await page.close() }
})

// 目录里 keyInvalid 的「一键修复」以前没接线，落到「找客服」。
test('the one-click repair on an invalid key runs the same rewrite', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-gemini').getByText('未安装').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'installCli'; window.v2Test.failMessage = '安装失败：令牌已失效' })
    await page.getByTestId('tool-gemini-primary').click()
    await page.getByTestId('operation-error').waitFor()
    await page.getByTestId('operation-error-body').getByText('工具打不开对话，需要换一把 Key', { exact: true }).waitFor()
    const before = await page.evaluate(() => {
      window.v2Test.fail = ''
      window.v2Test.failMessage = ''
      return window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length
    })
    await page.getByTestId('operation-error-repair').click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length > count, before)
    assert.equal(await page.getByTestId('operation-error').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

async function openAboutSettings(page) {
  await page.getByTestId('nav-settings').click()
  const settings = page.getByTestId('page-settings')
  await settings.waitFor()
  await settings.getByRole('tab', { name: '更新与关于', exact: true }).click()
  return settings
}

test('settings reopens the onboarding guide, and the interface tour replays until it is actually finished (A8)', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-claude').waitFor()
    // 没有记录的账号不该凭空多出一段导览。
    assert.equal(await page.getByTestId('shell-guide-tip').count(), 0)
    await openAboutSettings(page)
    await page.getByTestId('settings-replay-tour').click()
    await page.getByTestId('shell-guide-tip').waitFor()
    // 重看导览会回到首页放，设置页不再是当前页面。
    await expect(page.getByTestId('page-settings')).toBeHidden()
    // 导览没看完就关掉软件，下次回到首页接着播（A8 要解决的就是这一条）。
    await page.reload()
    await waitForFixtureReady(page)
    const tour = page.getByTestId('shell-guide-tip')
    await tour.waitFor()
    for (const label of ['下一步', '下一步', '开始使用'])
      await tour.getByRole('button', { name: label, exact: true }).click()
    assert.equal(await tour.count(), 0)
    await page.reload()
    await waitForFixtureReady(page)
    await page.getByTestId('tool-row-claude').waitFor()
    // 看完之后就不再追着播了。
    assert.equal(await page.getByTestId('shell-guide-tip').count(), 0)
    // 「再看一遍」打开的是四步新手引导，不是静态教程页。
    await openAboutSettings(page)
    await page.getByTestId('settings-start-guide').click()
    await page.getByTestId('start-guide').waitFor()
    assert.equal(await page.getByTestId('page-tutorial').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 整个元素都在内容区看得见的范围里（内容区自己滚，不是窗口在滚）。
function insidePageViewport(locator) {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect()
    const visible = element.closest('[data-testid="page-viewport"]').getBoundingClientRect()
    return box.top >= visible.top && box.bottom <= visible.bottom
  })
}

test('tutorial searches step contents regardless of case and surrounding spaces and recovers from no results', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    await expect(tutorial.getByTestId('tutorial-article')).toBeVisible()
    const search = tutorial.getByRole('searchbox', { name: '搜索教程', exact: true })
    const viewport = page.getByTestId('page-viewport')
    await viewport.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(300)
    await search.fill('  BREW INSTALL PYTHON  ')
    await expect(tutorial.getByTestId('tutorial-group-advanced')).toHaveJSProperty('open', true)
    await expect(tutorial.getByTestId('tutorial-topic-runtime-mac')).toBeVisible()
    const heading = tutorial.getByTestId('tutorial-article').getByRole('heading', { level: 2 })
    await expect(heading).toContainText(/Mac|macOS/i)
    await expect.poll(() => heading.evaluate((element) => {
      const title = element.getBoundingClientRect()
      const visible = element.closest('[data-testid="page-viewport"]').getBoundingClientRect()
      return title.top >= visible.top && title.bottom <= visible.bottom
    })).toBe(true)
    await expect(search).toBeFocused()
    await expect(tutorial.getByTestId('tutorial-article')).toContainText('brew install python')
    // 命中的字带浅黄底，大小写照原文；页面落在第一处命中（这一篇是标题里的 Python）。
    const firstHit = tutorial.getByTestId('tutorial-article').locator('mark.v2-tutorial-hit').first()
    await expect(firstHit).toHaveText('Python')
    assert.notEqual(await firstHit.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)')
    await expect.poll(() => insidePageViewport(firstHit)).toBe(true)
    const advanced = tutorial.getByTestId('tutorial-group-advanced')
    await advanced.locator('summary').click()
    await expect(advanced).toHaveJSProperty('open', false)
    await search.fill('Homebrew')
    await expect(advanced).toHaveJSProperty('open', true)

    await search.fill('no-such-tutorial-8472')
    await expect(tutorial.getByRole('heading', { name: '没找到相关教程', exact: true })).toBeVisible()
    assert.equal(await tutorial.getByTestId('tutorial-article').count(), 0)
    assert.equal(await tutorial.getByRole('navigation', { name: '教程目录', exact: true }).getByRole('button').count(), 0)
    await tutorial.getByRole('button', { name: '清除搜索', exact: true }).click()
    await expect(search).toHaveValue('')
    await expect(tutorial.getByTestId('tutorial-article')).toBeVisible()
    await expect(tutorial.getByTestId('tutorial-topic-start')).toBeVisible()
    await search.fill('重新读取时')
    await expect(tutorial.getByTestId('tutorial-topic-start')).toBeVisible()
    await expect(tutorial.getByTestId('tutorial-topic-start')).toHaveAttribute('aria-current', 'page')
    const explanation = tutorial.getByTestId('tutorial-article').locator('details').filter({ hasText: '重新读取时' })
    await expect(explanation).toHaveCount(1)
    await expect(explanation).toHaveJSProperty('open', true)
    await expect(explanation.getByText(/刚改过配置，需要重新读取时/)).toBeVisible()
    // 只展开含这个词的那一条补充说明，其余照旧收着；页面翻到命中的那几个字。
    const notes = tutorial.getByTestId('tutorial-article').locator('details.v2-tutorial-extra')
    await expect.poll(() => notes.evaluateAll((items) => items.filter((item) => item.open).map((item) => item.dataset.extraTitle))).toEqual(['提示 Codex 已在运行？'])
    const explanationHit = explanation.locator('mark.v2-tutorial-hit')
    await expect(explanationHit).toHaveText('重新读取时')
    await expect.poll(() => insidePageViewport(explanationHit)).toBe(true)
    await search.fill('安装报错怎么办')
    const installationNote = tutorial.getByTestId('tutorial-article').locator('details').filter({ hasText: '安装报错怎么办' })
    await expect(installationNote).toHaveJSProperty('open', true)
    await expect(tutorial.getByTestId('tutorial-article').locator('details[data-extra-title="装的时候能走开吗？"]')).toHaveJSProperty('open', false)
    await installationNote.locator('summary').click()
    await expect(installationNote).toHaveJSProperty('open', false)
    await search.fill('Windows 安装报错')
    await expect(installationNote).toHaveJSProperty('open', true)
    await expect(installationNote.getByText(/Windows 安装报错时按提示处理/)).toBeVisible()
    await clean(page)
  } finally { await page.close() }
})

// 第五部分第 32、33 条：目录只写标题；读到中间，顶上吸着「第几步」；求助在文章最后。
test('tutorial pins the step being read on top and puts help at the end of the article', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    const article = tutorial.getByTestId('tutorial-article')
    await expect(article).toBeVisible()
    const directory = tutorial.getByRole('navigation', { name: '教程目录', exact: true })
    // 目录每行只写标题，「约 5 分钟 · 4 步」留在文章开头。
    await expect(directory.getByTestId('tutorial-topic-start')).toHaveText('第一次用？照着这 4 步做')
    assert.equal(await directory.getByText(/分钟/).count(), 0)
    await expect(article.locator('.v2-tutorial-meta')).toContainText('约 5 分钟 · 4 步')
    assert.equal(Math.round(await tutorial.locator('.v2-tutorial-directory').evaluate((element) => element.getBoundingClientRect().width)), 240)
    const progress = tutorial.getByTestId('tutorial-progress')
    await expect(progress).toBeHidden()

    // 点开头的第 3 步：开头滚出去，顶上那条出来，写着第 3 步，第三颗圆点亮着，也不压住第 3 步的标题。
    await article.locator('.v2-tutorial-step-links a').nth(2).click()
    await expect(progress).toBeVisible()
    await expect(progress).toContainText('第 3 步，共 4 步 · 看到「已配好」就继续')
    await expect(progress.getByRole('button', { name: '第 3 步：看到「已配好」就继续', exact: true })).toHaveAttribute('aria-current', 'step')
    const bar = await progress.evaluate((element) => element.getBoundingClientRect().toJSON())
    const pane = await page.getByTestId('page-viewport').evaluate((element) => element.getBoundingClientRect().toJSON())
    assert.ok(Math.abs(bar.height - 36) <= 1, `吸顶条约 36 高，实际 ${bar.height}`)
    assert.ok(Math.abs(bar.top - pane.top) <= 1, `吸顶条贴着内容区的上沿（条 ${bar.top}，内容区 ${pane.top}）`)
    const stepTitle = await article.locator('#tutorial-start-step-2 h3').evaluate((element) => element.getBoundingClientRect().toJSON())
    assert.ok(stepTitle.top >= bar.bottom, '吸顶条不压住这一步的标题')

    // 点圆点跳到最后一步：最后一步滚不到顶，也亮第 4 颗。
    await progress.getByRole('button', { name: '第 4 步：打开 Codex，发出第一条消息', exact: true }).click()
    await expect(progress).toContainText('第 4 步，共 4 步 · 打开 Codex，发出第一条消息')
    await expect(progress.getByRole('button', { name: '第 4 步：打开 Codex，发出第一条消息', exact: true })).toHaveAttribute('aria-current', 'step')
    // 自己滚回去，读到哪一步就写哪一步。
    await article.locator('#tutorial-start-step-1').evaluate((element) => element.scrollIntoView({ block: 'start' }))
    await expect(progress).toContainText('第 2 步，共 4 步 · 装好 Codex 桌面端')
    await expect(progress.locator('[aria-current="step"]')).toHaveText('2')
    // 回到文章开头，那条收起来。
    await page.getByTestId('page-viewport').evaluate((element) => { element.scrollTop = 0 })
    await expect(progress).toBeHidden()

    // 求助在每篇最后、「上一篇 / 下一篇」下面，目录里不再有。
    const support = article.getByTestId('tutorial-support')
    await expect(support).toContainText('还是不会？')
    const footer = await article.locator('.v2-tutorial-footer').evaluate((element) => element.getBoundingClientRect().toJSON())
    const supportBox = await support.evaluate((element) => element.getBoundingClientRect().toJSON())
    assert.ok(supportBox.top >= footer.bottom, '求助在「上一篇 / 下一篇」下面')
    assert.equal(await tutorial.locator('.v2-tutorial-directory').getByText('还是不知道怎么操作？').count(), 0)
    await support.getByRole('button', { name: '联系客服', exact: true }).click()
    const help = page.getByRole('dialog', { name: '帮助与客服', exact: true })
    await help.waitFor()
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    // 搜不到时，「联系客服」在「清除搜索」旁边。
    await tutorial.getByRole('searchbox', { name: '搜索教程', exact: true }).fill('no-such-tutorial-8472')
    const empty = tutorial.getByTestId('tutorial-empty')
    await empty.getByRole('button', { name: '清除搜索', exact: true }).waitFor()
    await empty.getByRole('button', { name: '联系客服', exact: true }).click()
    await help.waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 第五部分第 27、32 条：技能页「看怎么放」打开技能那篇、只展开那一条补充说明；目录翻到这一篇。
test('the skills page guide opens the skills chapter on its note and the directory follows it', async () => {
  const page = await open()
  try {
    await page.setViewportSize({ width: 1280, height: 560 })
    await page.evaluate(() => {
      window.xingmang.listProviderExtensions = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', items: [], warnings: [],
        capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
      })
    })
    await page.getByTestId('nav-skills').click()
    const skills = page.getByTestId('page-skills')
    const note = skills.getByTestId('skills-import-unsupported')
    await expect(note).toContainText('Claude Code 的技能不能在这里导入，要按它自己的方式放好；Codex CLI、Gemini CLI 可以在这里导入。')
    await expect(skills.getByTestId('skills-add')).toBeDisabled()
    await expect(skills.getByTestId('skills-add')).toHaveAttribute('title', 'Claude Code 不支持在这里导入')
    await note.getByRole('button', { name: '看怎么放', exact: true }).click()
    const tutorial = page.getByTestId('page-tutorial')
    const article = tutorial.getByTestId('tutorial-article')
    await expect(article.getByRole('heading', { level: 2 })).toHaveText('技能')
    const guide = article.locator('details[data-extra-title="Claude Code、Grok CLI 没有导入按钮？"]')
    await expect(guide).toHaveJSProperty('open', true)
    await expect(guide).toContainText('再回本页点「重新加载」')
    assert.deepEqual(await article.locator('details.v2-tutorial-extra').evaluateAll((items) => items.filter((item) => item.open).map((item) => item.dataset.extraTitle)), ['Claude Code、Grok CLI 没有导入按钮？'])
    await expect.poll(() => insidePageViewport(guide.locator('summary'))).toBe(true)
    // 目录只滚自己，翻到正在看的这一篇。
    const entry = tutorial.getByTestId('tutorial-topic-skills')
    await expect(entry).toHaveAttribute('aria-current', 'page')
    await expect.poll(() => entry.evaluate((element) => {
      const list = element.closest('.v2-tutorial-directory')
      const box = element.getBoundingClientRect()
      const visible = list.getBoundingClientRect()
      return list.scrollHeight > list.clientHeight && box.top >= visible.top && box.bottom <= visible.bottom
    })).toBe(true)
    await clean(page)
  } finally { await page.close() }
})

test('tutorial actions navigate to their tool and retain the selected chapter and search on return', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.listProviderExtensions = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', items: [], warnings: [],
        capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
      })
      window.xingmang.checkProviderMcpHealth = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', supported: true, reason: null, entries: [],
      })
    })
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    await tutorial.getByRole('searchbox', { name: '搜索教程', exact: true }).fill('MCP')
    await tutorial.getByTestId('tutorial-topic-mcp').click()
    const article = tutorial.getByTestId('tutorial-article')
    const heading = await article.getByRole('heading', { level: 2 }).innerText()
    await article.getByRole('button', { name: '打开外接工具', exact: true }).first().click()
    await expect(page.getByTestId('page-mcp')).toBeVisible()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'listProviderExtensions'))
    await page.getByTestId('nav-tutorial').click()
    await expect(tutorial.getByRole('searchbox', { name: '搜索教程', exact: true })).toHaveValue('MCP')
    await expect(tutorial.getByTestId('tutorial-article').getByRole('heading', { level: 2 })).toHaveText(heading)
    await clean(page)
  } finally { await page.close() }
})

// 全面检测 Q48：教程里「办理充值」「查看用量」以前都落在「我的账号」，设置里的隐私一步
// 落在「外观」或上次看的那组。每次点都要落到这一步说的那一页，已经打开过也一样。
test('tutorial actions land on the account tab or settings group the step describes, even after another one was chosen', async () => {
  const page = await open()
  try {
    const tutorial = page.getByTestId('page-tutorial')
    const accountTab = () => page.evaluate(() => document.querySelector('[data-testid="account-tabs"] [aria-selected="true"]')?.textContent ?? '')
    async function openChapter(group, id) {
      await page.getByTestId('nav-tutorial').click()
      const directory = tutorial.getByTestId(`tutorial-group-${group}`)
      if (!await directory.evaluate((element) => element.open)) await directory.locator('summary').click()
      await tutorial.getByTestId(`tutorial-topic-${id}`).click()
    }
    await openChapter('everyday', 'account')
    await tutorial.getByTestId('tutorial-account-action-2').click()
    await page.getByTestId('account-tabs').waitFor()
    await expect.poll(accountTab).toBe('充值与订阅')
    await page.getByTestId('account-tabs').getByRole('tab', { name: '我的订单', exact: true }).click()
    await expect.poll(accountTab).toBe('我的订单')
    for (const [index, label] of [[3, '调用明细'], [1, '密钥'], [2, '充值与订阅'], [0, '我的账号']]) {
      await openChapter('everyday', 'account')
      await tutorial.getByTestId(`tutorial-account-action-${index}`).click()
      await expect.poll(accountTab).toBe(label)
    }

    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('page-settings')
    await settings.getByRole('tab', { name: '更新与关于', exact: true }).click()
    await expect(settings.getByRole('tab', { name: '更新与关于', exact: true })).toHaveAttribute('aria-selected', 'true')
    for (let visit = 0; visit < 2; visit += 1) {
      await openChapter('advanced', 'safety')
      await tutorial.getByTestId('tutorial-safety-action-2').click()
      await expect(page.getByTestId('page-settings')).toBeVisible()
      await expect(page.getByTestId('page-settings').getByRole('tab', { name: '隐私与数据', exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.getByTestId('page-settings').getByRole('tab', { name: '更新与关于', exact: true }).click()
    }
    // 从侧栏点「设置」不点名分组，仍停在用户上次看的那组，不会被教程的跳转带偏。
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('page-settings').getByRole('tab', { name: '更新与关于', exact: true })).toHaveAttribute('aria-selected', 'true')
    // 默认夹具没接充值、订单、用量那几个读取（会记进 unexpected），这里只看有没有报错。
    assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  } finally { await page.close() }
})

// 检查页网络项以前的「去处理」跳到「设置 → 网络」，那里没有能处理它的东西、「去检查」又跳回来，
// 等于绕一圈（新手引导梳理 9-25 第 2 条）。说不出换线路救不救得回来的（这里不带原因），
// 这一行照旧只给结论，不带人去设置页兜圈。
test('the health network row no longer sends the user around through settings', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.runDiagnostics = async () => ({ version: 1, generatedAt: new Date().toISOString(), durationMs: 1,
        counts: { pass: 0, warn: 0, fail: 1, error: 0 },
        items: [{ code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'fail', summary: '连不上星芒服务', durationMs: 1 }] })
    })
    await page.getByTestId('nav-health').click()
    await expect(page.getByTestId('page-health').getByText('连不上星芒服务')).toBeVisible()
    await expect(page.getByTestId('health-fix-XINGMANG_NETWORK')).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  } finally { await page.close() }
})

// 第四十三批 B：「星芒 AI 网络」被当地网络切断（连接被切断、解析不出、等不到回话），登着星芒账号的人
// 在这一行拿到「去处理」，一点就到「设置 → 网络」里「星芒账号线路」那一行、亮一下，选「备用直连」再重开。
async function stubCutOffNetwork(page, siteId) {
  await stubHealthReport(page, [{ code: 'XINGMANG_NETWORK', title: '星芒 AI 网络', state: 'fail',
    summary: '与账号服务的连接被当前网络切断了，校园网、公司网常见。换一个网络（例如手机热点）再试一次。',
    details: { endpoint: 'https://xm.solov.cc/api/status', reason: 'refused', siteId } }])
}

test('a cut-off network row takes a signed-in account to its route setting', async () => {
  const page = await open()
  try {
    await stubCutOffNetwork(page, 'solov')
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-fix-XINGMANG_NETWORK').click()
    const settings = page.getByTestId('page-settings')
    await expect(settings.getByRole('tab', { name: '网络', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.waitForFunction(() => document.querySelector('[data-testid="page-settings"] [data-anchor="relay-route-solov"]')?.getAttribute('data-anchor-focus') === 'true')
    await expect(page.getByTestId('settings-relay-route-solov')).toBeFocused()
    await page.getByTestId('settings-relay-route-solov').selectOption('direct')
    await page.getByTestId('settings-relay-relaunch').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 线路被切断时开机恢复登录多半也联不上：登录还在，照样给。
test('the cut-off network row offers the route setting while the startup restore still holds the login', async () => {
  const page = await open('restoring=1')
  try {
    await stubCutOffNetwork(page, 'solov')
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-fix-XINGMANG_NETWORK').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="page-settings"] [data-anchor="relay-route-solov"]')?.getAttribute('data-anchor-focus') === 'true')
    await clean(page)
  } finally { await page.close() }
})

// 历史账号只有默认线路，访客没有账号：都不给，这一行照旧只有结论。开机恢复历史账号时，
// 主进程查的还是默认那个站，那条线路不是这个账号的，也不给。
test('a historical account or a guest gets no route fix on the cut-off network row', async () => {
  const historical = await open('sub2api=1')
  try {
    await stubCutOffNetwork(historical, 'solov-api')
    await historical.getByTestId('nav-health').click()
    await expect(historical.getByTestId('health-row-XINGMANG_NETWORK')).toContainText('连接被当前网络切断了')
    await expect(historical.getByTestId('health-fix-XINGMANG_NETWORK')).toHaveCount(0)
    assert.deepEqual(await historical.evaluate(() => window.v2Test.errors), [])
  } finally { await historical.close() }
  const restoring = await open('restoring=solov-api')
  try {
    await stubCutOffNetwork(restoring, 'solov')
    await restoring.getByTestId('nav-health').click()
    await expect(restoring.getByTestId('health-row-XINGMANG_NETWORK')).toContainText('连接被当前网络切断了')
    await expect(restoring.getByTestId('health-fix-XINGMANG_NETWORK')).toHaveCount(0)
    assert.deepEqual(await restoring.evaluate(() => window.v2Test.errors), [])
  } finally { await restoring.close() }
  const guest = await open('guest=1&existing=1')
  try {
    await enterWorkspaceWithoutAccount(guest)
    await stubCutOffNetwork(guest, 'solov')
    await guest.getByTestId('nav-health').click()
    await expect(guest.getByTestId('health-row-XINGMANG_NETWORK')).toContainText('连接被当前网络切断了')
    await expect(guest.getByTestId('health-fix-XINGMANG_NETWORK')).toHaveCount(0)
    assert.deepEqual(await guest.evaluate(() => window.v2Test.errors), [])
  } finally { await guest.close() }
})

// 顶部搜索能搜到设置里的每一行，靠的是每一行都带着注册表里的 id。这里把注册表和
// 页面对一遍：这台电脑该有的行一行不少、次序一样，不该有的（Windows 上的「卸载星芒」、
// 不支持自动更新时的「自动更新」）不出现。
test('every settings row the search can name is on the settings page, in the registry order', async () => {
  const page = await open()
  try {
    const groups = await page.evaluate(async () => {
      const { settingsGroups, settingsItems } = await import('/src/renderer-v2/registry/business.ts')
      return settingsGroups.map((group) => ({ label: group.label, ids: settingsItems.filter((item) => item.group === group.value && item.when !== 'mac' && item.when !== 'autoUpdate').map((item) => item.id) }))
    })
    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('page-settings')
    for (const group of groups) {
      await settings.getByRole('tab', { name: group.label, exact: true }).click()
      await expect(settings.locator('#v2-settings-panel h2')).toHaveText(group.label)
      await expect.poll(() => settings.locator('#v2-settings-panel [data-anchor]').evaluateAll((rows) => rows.map((row) => row.dataset.anchor)), { message: `「${group.label}」的行` }).toEqual(group.ids)
    }
    await clean(page)
  } finally { await page.close() }
})

test('the enterprise certificate row opens the check page on the certificate item and points at it', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.runDiagnostics = async () => ({ version: 1, generatedAt: new Date().toISOString(), durationMs: 1,
        counts: { pass: 1, warn: 1, fail: 0, error: 0 },
        items: [
          { code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'pass', summary: '连接正常', durationMs: 1 },
          { code: 'CERTIFICATE_TRUST', title: '安全证书', state: 'warn', summary: '这台电脑装了公司的安全证书', durationMs: 1 },
        ] })
    })
    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('page-settings')
    await settings.getByRole('tab', { name: '网络', exact: true }).click()
    await page.getByTestId('settings-certificate-health').click()
    await page.getByTestId('page-health').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="page-health"] [data-anchor="CERTIFICATE_TRUST"]')?.getAttribute('data-anchor-focus') === 'true')
    // 指名的是一项要留意的，正常的那几项照旧收着，也不会被点亮。
    assert.equal(await page.locator('[data-testid="page-health"] [data-anchor="XINGMANG_NETWORK"]').count(), 0)
    await expect(page.getByTestId('health-passing-toggle')).toHaveText('展开')
    await clean(page)
  } finally { await page.close() }
})

// 检查页每次「重新检查」都拿到这一份结果；计数按条目现算，免得和列表对不上。
async function stubHealthReport(page, items) {
  const counts = { pass: 0, warn: 0, fail: 0, error: 0 }
  for (const item of items) counts[item.state] += 1
  const report = { version: 1, durationMs: 1, counts, items: items.map((item) => ({ durationMs: 1, ...item })) }
  await page.evaluate((value) => {
    window.xingmang.runDiagnostics = async () => ({ ...value, generatedAt: new Date().toISOString() })
  }, report)
}

const mixedHealthItems = [
  { code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'pass', summary: '连接正常' },
  { code: 'RUNTIME_PYTHON', title: 'Python', state: 'warn', summary: '还没装 Python' },
  { code: 'CERTIFICATE_TRUST', title: '安全证书', state: 'pass', summary: '没有发现公司证书' },
  { code: 'CLI_CODEX', title: 'Codex CLI', state: 'fail', summary: 'Codex CLI 打不开' },
]

// 第五部分第 35 条、第六部分第 8 条：结果在两张说明卡上面，有问题的排最前，正常的收成一行。
test('the check page lists problems first, folds the passing items into one row and keeps the self-checks below', async () => {
  const page = await open()
  try {
    await stubHealthReport(page, mixedHealthItems)
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    const health = page.getByTestId('page-health')
    await health.getByTestId('health-row-CLI_CODEX').waitFor()
    // 页头：先「导出检查报告」，再主按钮「重新检查」；页底不再有导出。
    const head = await health.locator('.xm-page-head button').evaluateAll((buttons) => buttons.map((button) => button.textContent.trim()))
    assert.deepEqual(head, ['导出检查报告', '重新检查'])
    assert.equal(await health.getByRole('button', { name: '导出检查报告', exact: true }).count(), 1)
    // 计数条：待处理、需留意、正常，右边是上次检查的时间。
    const pills = await health.locator('.xm-toolbar .xm-pill').evaluateAll((items) => items.map((item) => item.textContent.trim()))
    assert.deepEqual(pills, ['待处理 1', '需留意 1', '正常 2'])
    await expect(health.locator('.xm-toolbar')).toContainText(/上次检查 (刚刚|今天 \d{2}:\d{2})/)
    const rows = await health.locator('[data-testid^="health-row-"], [data-testid="health-passing"]').evaluateAll((items) => items.map((item) => item.dataset.testid))
    assert.deepEqual(rows, ['health-row-CLI_CODEX', 'health-row-RUNTIME_PYTHON', 'health-passing'])
    await expect(health.getByTestId('health-passing')).toContainText('另外 2 项正常')
    const toggle = health.getByTestId('health-passing-toggle')
    await expect(toggle).toHaveText('展开')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveText('收起')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const expanded = await health.locator('[data-testid^="health-row-"]').evaluateAll((items) => items.map((item) => item.dataset.testid))
    assert.deepEqual(expanded, ['health-row-CLI_CODEX', 'health-row-RUNTIME_PYTHON', 'health-row-XINGMANG_NETWORK', 'health-row-CERTIFICATE_TRUST'])
    await toggle.click()
    assert.equal(await health.getByTestId('health-row-XINGMANG_NETWORK').count(), 0)
    // 两张说明卡挪到结果下面。
    const resultsBottom = await health.getByTestId('health-passing').evaluate((element) => element.getBoundingClientRect().bottom)
    const connectionTop = await health.getByTestId('health-connection').evaluate((element) => element.getBoundingClientRect().top)
    assert.ok(resultsBottom < connectionTop, '结果应在「连接自检」上面')
    // 「Codex 干活检查」的开关和「开始检查」在同一行。
    const consent = await health.getByTestId('health-codex-responses-consent').evaluate((element) => element.getBoundingClientRect().toJSON())
    const run = await health.getByTestId('health-codex-responses-run').evaluate((element) => element.getBoundingClientRect().toJSON())
    assert.ok(Math.abs((consent.top + consent.bottom) / 2 - (run.top + run.bottom) / 2) < consent.height / 2, '开关和「开始检查」应在同一行')
    assert.ok(run.left > consent.left, '「开始检查」在开关右边')
    await clean(page)
  } finally { await page.close() }
})

test('a check page with nothing but passing items says so in one row', async () => {
  const page = await open()
  try {
    await stubHealthReport(page, mixedHealthItems.filter((item) => item.state === 'pass'))
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    const passing = page.getByTestId('health-passing')
    await expect(passing).toContainText('全部 2 项正常')
    assert.equal(await page.locator('[data-testid^="health-row-"]').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the settings network check opens the passing network item and points at it', async () => {
  const page = await open()
  try {
    await stubHealthReport(page, mixedHealthItems)
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络', exact: true }).click()
    await page.getByTestId('settings-network-health').click()
    await page.getByTestId('page-health').waitFor()
    // 网络那一项是正常的：先把正常的几项摆出来，再翻到它、亮一下。
    await page.waitForFunction(() => document.querySelector('[data-testid="page-health"] [data-anchor="XINGMANG_NETWORK"]')?.getAttribute('data-anchor-focus') === 'true')
    await expect(page.getByTestId('health-passing-toggle')).toHaveText('收起')
    await expect.poll(() => page.getByTestId('health-row-XINGMANG_NETWORK').evaluate((row) => {
      const box = row.getBoundingClientRect()
      const visible = row.closest('[data-testid="page-viewport"]').getBoundingClientRect()
      return box.top >= visible.top && box.bottom <= visible.bottom
    })).toBe(true)
    await clean(page)
  } finally { await page.close() }
})

test('the startup notice lands on the first problem of the check results', async () => {
  const page = await open('diagnostics=1&diagnosticIssues=1&diagnosticWarnings=1')
  try {
    const notice = page.getByTestId('startup-notice-diagnostics')
    await notice.waitFor()
    await stubHealthReport(page, mixedHealthItems)
    await notice.getByRole('button', { name: '去看看', exact: true }).click()
    await page.getByTestId('page-health').waitFor()
    // 排在最前的那一项问题亮一下；正常的几项还收着。
    await page.waitForFunction(() => document.querySelector('[data-testid="page-health"] [data-anchor="CLI_CODEX"]')?.getAttribute('data-anchor-focus') === 'true')
    assert.equal(await page.locator('[data-testid="page-health"] [data-anchor="RUNTIME_PYTHON"][data-anchor-focus]').count(), 0)
    await expect(page.getByTestId('health-passing-toggle')).toHaveText('展开')
    await clean(page)
  } finally { await page.close() }
})

// 第四十二批 A：检查页每次查都现取 window.__health.items；hold 为真时先停住，release() 了才回结果。
async function stubHeldHealthReport(page, items) {
  await page.evaluate((initial) => {
    window.__health = { items: initial, hold: false, release: () => undefined }
    window.xingmang.runDiagnostics = async () => {
      if (window.__health.hold) await new Promise((resolve) => { window.__health.release = resolve })
      const items = window.__health.items.map((item) => ({ durationMs: 1, ...item }))
      const counts = { pass: 0, warn: 0, fail: 0, error: 0 }
      for (const item of items) counts[item.state] += 1
      return { version: 1, generatedAt: new Date().toISOString(), durationMs: 1, counts, items }
    }
  }, items)
}

// 只数检查页自己那一轮（不带参数）；开机检查带 reuseRecentScan，不算。
function healthChecks(page) {
  return page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'runDiagnostics' && entry.args.length === 0).length)
}

// 第四十二批 A：去过的页面换走时只藏起来、不卸载，再显示时自己重读一次，和点页头那颗按钮一样。
// 从错误框「检查网络」、侧栏回到检查页，看到的是现在的结果；还在查的时候换走再回来，不再起一轮。
// 开发模式挂两遍会让第一次查几轮不固定，所以只数「多了几轮」。
test('the check page checks again when it is shown again, but not while a check is still running', async () => {
  const page = await open()
  try {
    await stubHeldHealthReport(page, [{ code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'pass', summary: '连接正常' }])
    const health = page.getByTestId('page-health')
    await page.getByTestId('nav-health').click()
    await expect(health.getByTestId('health-passing')).toContainText('全部 1 项正常')
    const first = await healthChecks(page)
    await page.evaluate(() => { window.__health.items = [{ code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'fail', summary: '连不上星芒服务' }] })
    // 藏着的检查页不查。
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
    await page.waitForTimeout(100)
    assert.equal(await healthChecks(page), first)
    // 回来不用点「重新检查」就是新结果，右上照旧写「上次检查」。
    await page.getByTestId('nav-health').click()
    await expect(health.getByTestId('health-row-XINGMANG_NETWORK')).toContainText('连不上星芒服务')
    assert.equal(await healthChecks(page), first + 1)
    await expect(health.locator('.xm-toolbar')).toContainText('上次检查')
    // 查着的时候换走再回来：那一轮还没查完，不再起一轮；查完照样换上新结果。
    await page.evaluate(() => {
      window.__health.hold = true
      window.__health.items = [{ code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'pass', summary: '连接正常' }]
    })
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-health').click()
    await expect.poll(() => healthChecks(page)).toBe(first + 2)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-health').click()
    await page.waitForTimeout(100)
    assert.equal(await healthChecks(page), first + 2)
    await page.evaluate(() => { window.__health.hold = false; window.__health.release() })
    await expect(health.getByTestId('health-passing')).toContainText('全部 1 项正常')
    assert.equal(await healthChecks(page), first + 2)
    await clean(page)
  } finally { await page.close() }
})

// 去过检查页、换走，再从设置「网络检查」点「去检查页」：这时正在重查，等新结果出来再翻到网络那一项、
// 亮一下，不先在上回那份结果上亮。
test('pointing at an item of a check page visited before waits for the new results', async () => {
  const page = await open()
  try {
    await stubHeldHealthReport(page, [
      { code: 'CLI_CODEX', title: 'Codex CLI', state: 'fail', summary: 'Codex CLI 打不开' },
      { code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'pass', summary: '上回查：连接正常' },
    ])
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-row-CLI_CODEX').waitFor()
    await page.evaluate(() => {
      window.__health.hold = true
      window.__health.items = [
        { code: 'CLI_CODEX', title: 'Codex CLI', state: 'fail', summary: 'Codex CLI 打不开' },
        { code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'pass', summary: '这回查：连接正常' },
      ]
    })
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络', exact: true }).click()
    await page.getByTestId('settings-network-health').click()
    await page.getByTestId('page-health').waitFor()
    // 新结果还没回来：哪一项都不亮，正常的几项也还收着。
    await page.waitForTimeout(300)
    assert.equal(await page.locator('[data-testid="page-health"] [data-anchor-focus]').count(), 0)
    await expect(page.getByTestId('health-passing-toggle')).toHaveText('展开')
    await page.evaluate(() => { window.__health.hold = false; window.__health.release() })
    await page.waitForFunction(() => document.querySelector('[data-testid="page-health"] [data-anchor="XINGMANG_NETWORK"]')?.getAttribute('data-anchor-focus') === 'true')
    await expect(page.getByTestId('health-row-XINGMANG_NETWORK')).toContainText('这回查：连接正常')
    await clean(page)
  } finally { await page.close() }
})

// 错误框「查看日志」把人带回去过的反馈页：刚出的那个错不点「刷新」就在「运行日志」最上面。
test('the feedback page reads the run log again when it is shown again', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      const entry = (index, level, message) => ({ id: `2026-10-06T00:00:0${index}.000Z:4242:${index}`, timestamp: `2026-10-06T00:00:0${index}.000Z`, level, source: 'fixture', event: 'test', message, detail: null })
      window.__logs = [entry(1, 'info', '上回进来时就有的日志')]
      window.__logError = () => window.__logs.unshift(entry(2, 'error', '刚出的那个错'))
      window.xingmang.getRuntimeLogs = async () => ({ generatedAt: new Date().toISOString(), directory: 'C:/logs', filePath: 'C:/logs/runtime.log', sizeBytes: 64,
        total: window.__logs.length, truncated: false, counts: { debug: 0, info: 1, warn: 0, error: window.__logs.length - 1 }, sources: ['fixture'],
        currentProcessId: 4242, startedAt: '2026-10-06T00:00:00.000Z', entries: window.__logs.map((item) => ({ ...item })) })
    })
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-feedback').click()
    const logs = page.getByTestId('page-feedback').locator('button.v2-feedback-log')
    await expect(logs.first()).toContainText('上回进来时就有的日志')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
    await page.evaluate(() => window.__logError())
    await page.getByTestId('nav-feedback').click()
    await expect(logs.first()).toContainText('刚出的那个错')
    await expect(logs).toHaveCount(2)
    await clean(page)
  } finally { await page.close() }
})

// 改用失败的错误框叫人「到「备份」里恢复改用之前的那一份」：去过的备份页回来时，列表里得有这一份。
test('the backups page lists a backup made while it was hidden once it is shown again', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.__backups = []
      window.xingmang.listBackups = async () => window.__backups.map((item) => ({ ...item }))
    })
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-backups').click()
    await page.getByTestId('backups-empty').waitFor()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
    await page.evaluate(() => {
      window.__backups.push({ id: 'backup-before-switch', provider: 'codex', reason: 'pre-save', createdAt: new Date().toISOString(),
        fileCount: 2, existingFileCount: 2, totalSize: 2048, valid: true, error: null, keyOwnership: 'current', keyAccountName: null })
    })
    await page.getByTestId('nav-backups').click()
    await expect(page.getByTestId('backups-row-backup-before-switch')).toContainText('配置前备份')
    await expect(page.getByTestId('backups-empty')).toHaveCount(0)
    await clean(page)
  } finally { await page.close() }
})

// 第五部分第 39 条：结论是「网络」时，「去处理」打开设置的「网络」那一组，不再落在第一组「外观」。
test('a network self-check result sends 去处理 to the network group of settings', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      const original = window.xingmang.checkProviderConnection
      window.xingmang.checkProviderConnection = async (provider) => provider === 'claude'
        ? { provider, siteId: 'solov', ok: false, layer: 'network', summary: '连不上星芒服务（连接被重置）', nextStep: '换个网络或打开加速后再测一次',
          endpoint: 'https://fixture.invalid/v1/messages', model: 'claude-opus-5', detail: 'ECONNRESET', status: null, durationMs: 12, checkedAt: new Date().toISOString() }
        : original(provider)
    })
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').click()
    const claude = page.getByTestId('health-connection-result-claude')
    await expect(claude.locator('.xm-pill')).toHaveText('有问题')
    await expect(claude.locator('.xm-row-desc')).toHaveText('连不上星芒服务（连接被重置）')
    await claude.getByRole('button', { name: '查看详情', exact: true }).click()
    const details = page.getByTestId('health-connection-details')
    await details.getByRole('heading', { name: 'Claude Code · 网络', exact: true }).waitFor()
    await details.getByText('换个网络或打开加速后再测一次', { exact: true }).waitFor()
    await details.getByRole('button', { name: '关闭', exact: true }).click()
    await claude.getByRole('button', { name: '去处理', exact: true }).click()
    const settings = page.getByTestId('page-settings')
    await settings.waitFor()
    await expect(settings.getByRole('tab', { name: '网络', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(settings.locator('#v2-settings-panel h2')).toHaveText('网络')
    await clean(page)
  } finally { await page.close() }
})

test('the help dialog lists the pages tucked under More and opens them', async () => {
  const page = await open()
  try {
    for (const [id, label] of [['maintenance', '安装卸载'], ['backups', '备份'], ['updates', '更新']]) {
      await page.getByTestId('shell-topbar').getByRole('button', { name: '帮助与客服', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '帮助与客服', exact: true })
      await expect(dialog.getByTestId('support-more')).toContainText('左边「更多」里还有：')
      const button = dialog.getByTestId(`support-more-${id}`)
      await expect(button).toHaveText(label)
      await button.click()
      await page.getByTestId(`page-${id}`).waitFor()
      await expect(page.getByTestId('support-dialog')).toHaveCount(0)
      await expect(page.getByTestId(`nav-${id}`)).toHaveAttribute('aria-current', 'page')
    }
    await clean(page)
  } finally { await page.close() }
  // 欢迎页没有侧栏，也就不说「左边「更多」里还有」。
  const welcome = await open('guest=1')
  try {
    await welcome.getByTestId('welcome-help').click()
    await welcome.getByRole('dialog', { name: '帮助与客服', exact: true }).getByRole('button', { name: '使用教程', exact: true }).waitFor()
    assert.equal(await welcome.getByTestId('support-more').count(), 0)
    await clean(welcome)
  } finally { await welcome.close() }
})

// 「更新」页和设置「更新与关于」改的是同一份设置：在一边关掉，另一边跟着关。
test('the startup update check switched on the updates page shows the same in settings, and back', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').click()
    const check = page.getByTestId('updates-check-on-startup').getByRole('switch', { name: '启动时检查新版本', exact: true })
    await expect(check).toBeEnabled()
    await expect(check).toHaveAttribute('aria-checked', 'false')
    await check.click()
    await waitForToast(page, '已保存')
    await expect(check).toHaveAttribute('aria-checked', 'true')
    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('page-settings')
    await settings.getByRole('tab', { name: '更新与关于', exact: true }).click()
    const settingsCheck = settings.getByRole('switch', { name: '启动时检查新版本', exact: true })
    await expect(settingsCheck).toHaveAttribute('aria-checked', 'true')
    await settingsCheck.click()
    await waitForToast(page, '已保存')
    await expect(settingsCheck).toHaveAttribute('aria-checked', 'false')
    await page.getByTestId('nav-updates').click()
    await expect(check).toHaveAttribute('aria-checked', 'false')
    await clean(page)
  } finally { await page.close() }
})

test('tutorial illustrations remain accessible and contained in both themes and the guide action opens onboarding', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`theme=${theme}`)
    try {
      await page.getByTestId('nav-tutorial').click()
      const tutorial = page.getByTestId('page-tutorial')
      await expect(tutorial.getByTestId('tutorial-article')).toBeVisible()
      for (const id of ['everyday', 'advanced']) {
        const group = tutorial.getByTestId(`tutorial-group-${id}`)
        await expect(group).toHaveJSProperty('open', false)
        await group.locator('summary').click()
      }
      const chapters = tutorial.getByRole('navigation', { name: '教程目录', exact: true }).locator('[data-testid^="tutorial-topic-"]')
      await expect(chapters.first()).toBeVisible()
      let illustratedSteps = 0
      for (const chapter of await chapters.all()) {
        const group = chapter.locator('xpath=ancestor::details[1]')
        if (await group.count() && !await group.evaluate((element) => element.open)) await group.locator('summary').click()
        await chapter.click()
        await expect(chapter).toHaveAttribute('aria-current', 'page')
        const illustrations = tutorial.getByTestId('tutorial-article').locator('[data-tutorial-illustration]')
        for (const illustration of await illustrations.all()) {
          illustratedSteps += 1
          await expect(illustration).toHaveAttribute('aria-label', /\S/)
          assert.equal(await illustration.locator('button, input, select, textarea, a[href], [role="button"]').count(), 0)
          assert.equal(await illustration.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true)
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      }
      assert.ok(illustratedSteps > 0, '教程应包含可访问的操作示意图')
      await tutorial.getByTestId('tutorial-topic-start').click()
      await expect(tutorial.getByTestId('tutorial-article').locator('[data-tutorial-illustration]').first()).toBeVisible()
      await page.screenshot({ path: path.join(artifacts, `tutorial-start-${theme}.png`), fullPage: true })
      await tutorial.getByRole('button', { name: '打开新手引导', exact: true }).click()
      await expect(page.getByTestId('start-guide')).toBeVisible()
      await clean(page)
    } finally { await page.close() }
  }
})

test('tutorial copies the first Codex message and offers manual copying when clipboard access fails', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.__tutorialClipboard = { values: [], reject: false }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async (text) => {
          if (window.__tutorialClipboard.reject) throw new Error('Clipboard access denied')
          window.__tutorialClipboard.values.push(text)
        } },
      })
    })
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    const step = tutorial.getByTestId('tutorial-article').locator('#tutorial-start-step-3')
    const copy = tutorial.getByTestId('tutorial-start-copy-3')
    await expect(copy).toBeVisible()
    const example = await step.locator('pre').innerText()
    await copy.click()
    await expect(step.getByText('已复制，粘贴到 Codex 的输入框里即可。', { exact: true })).toBeVisible()
    assert.deepEqual(await page.evaluate(() => window.__tutorialClipboard.values), [example])

    await page.evaluate(() => { window.__tutorialClipboard.reject = true })
    await copy.click()
    await expect(step.getByRole('status')).toHaveText('没能自动复制，请选中上面的文字，右键复制。')
    await expect(step.getByText('已复制，粘贴到 Codex 的输入框里即可。', { exact: true })).toHaveCount(0)
    await expect(step.locator('pre')).toHaveText(example)
    assert.deepEqual(await page.evaluate(() => window.__tutorialClipboard.values), [example])
    await clean(page)
  } finally { await page.close() }
})

test('tutorial installation guides open the Mac desktop chapter and clear previous searches on every visit', async () => {
  const page = await open('os=mac&externalUnsupported=opencode')
  try {
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    const search = tutorial.getByRole('searchbox', { name: '搜索教程', exact: true })
    for (const query of ['MCP', '充值']) {
      await tutorial.getByTestId('tutorial-topic-start').click()
      await search.fill(query)
      await expect(tutorial.getByTestId('tutorial-article')).toBeVisible()
      await page.getByTestId('nav-home').click()
      const guide = page.getByTestId('tool-opencode-primary')
      await expect(guide).toHaveText('安装指南')
      await guide.click()
      await expect(tutorial.getByTestId('tutorial-article').getByRole('heading', { level: 2 })).toHaveText('Mac 上装桌面端')
      await expect(tutorial.getByTestId('tutorial-topic-mac-desktop-apps')).toHaveAttribute('aria-current', 'page')
      await expect(search).toHaveValue('')
    }
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'installExternalClient')), false)
    await clean(page)
  } finally { await page.close() }
})

// #623: a bad tool config is a recoverable toolbox partition, not a reason to
// trap the whole application on Splash. The account path must fail before it
// can issue a managed Key or rewrite any local configuration.
test('startup configuration failure opens the signed-in toolbox without issuing Keys or overwriting tools', async () => {
  const page = await open('startupConfigFail=1&allInstalled=1')
  try {
    await page.getByTestId('page-home').waitFor()
    const failure = page.getByTestId('home-config-failure')
    await failure.waitFor()
    assert.match(await failure.innerText(), /^工具配置暂未读到（本地测试操作失败）。工具列表、安装和卸载照常可用；点工具行的「重新配置」可以重新写入。/)
    assert.equal(await page.getByTestId('tool-row-codex').getByText('未安装', { exact: true }).count(), 0)
    const written = await page.evaluate(() => window.v2Test.calls.filter((entry) => ['syncManagedCliKeys', 'configureManagedCliKeys', 'saveConfig', 'saveConfigWithAccountKey', 'createAccountKey', 'switchAccountSource'].includes(entry.method)))
    assert.deepEqual(written, [])
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('page-health').waitFor()
    await page.getByTestId('nav-backups').click()
    await page.getByTestId('page-backups').waitFor()
    await page.getByTestId('nav-home').click()
    await page.evaluate(() => { window.v2Test.fail = '' })
    await failure.getByRole('button', { name: '重新检测' }).click()
    await failure.waitFor({ state: 'detached' })
    await page.getByTestId('tool-row-codex').getByText('已配好').waitFor()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => ['syncManagedCliKeys', 'configureManagedCliKeys', 'saveConfig', 'saveConfigWithAccountKey', 'createAccountKey', 'switchAccountSource'].includes(entry.method))), [])
    await clean(page)
  } finally { await page.close() }
})

test('startup configuration failure lets a guest log in and reach recovery pages without creating Keys', async () => {
  const page = await open('guest=1&existing=1&startupConfigFail=1&allInstalled=1')
  try {
    await page.getByTestId('welcome-page').waitFor()
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.getByTestId('guide-pause').click()
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('home-config-failure').waitFor()
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-health').click()
    await page.getByTestId('page-health').waitFor()
    await page.getByTestId('nav-backups').click()
    await page.getByTestId('page-backups').waitFor()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => ['syncManagedCliKeys', 'configureManagedCliKeys', 'saveConfig', 'saveConfigWithAccountKey', 'createAccountKey', 'switchAccountSource'].includes(entry.method))), [])
    await clean(page)
  } finally { await page.close() }
})

function box(page, selector) {
  return page.evaluate((target) => {
    const element = document.querySelector(target)
    if (!element) return null
    const { left, right, top, bottom, width } = element.getBoundingClientRect()
    return { left, right, top, bottom, width }
  }, selector)
}

test('the shell fills a wide window and keeps each page 1000 wide to the right of the sidebar', async () => {
  const page = await open()
  try {
    await page.setViewportSize({ width: 1600, height: 900 })
    await page.getByTestId('page-home').waitFor()
    for (const selector of ['.v2-root', '[data-testid="window-titlebar"]']) assert.equal((await box(page, selector)).width, 1600, selector)
    assert.equal((await box(page, '[data-testid="shell-statusbar"]')).right, 1600)
    assert.equal((await box(page, '[data-testid="shell-topbar"]')).right, 1600)
    const workspace = await box(page, '.v2-workspace')
    const home = await box(page, '[data-testid="page-home"]')
    assert.equal(home.width, 1000)
    // 左右留白一样多（滚动条那一点点差不算）。
    assert.ok(Math.abs((home.left - workspace.left) - (workspace.right - home.right)) <= 20, `page is centred (${home.left - workspace.left} / ${workspace.right - home.right})`)
    await page.screenshot({ path: path.join(artifacts, 'shell-wide-1600.png') })
    await clean(page)
  } finally { await page.close() }
})

test('a window narrower than the design collapses the sidebar by itself, floats it when opened and never saves that as the choice', async () => {
  const page = await open()
  try {
    // 选了 110% 的窗口在 1280 设计宽下只剩 1163 逻辑宽。
    await page.setViewportSize({ width: 1164, height: 820 })
    await page.getByTestId('page-home').waitFor()
    const shell = page.locator('.v2-shell')
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    assert.equal((await box(page, '[data-testid="page-home"]')).width, 1000)
    const workspace = await box(page, '.v2-workspace')
    await page.getByTestId('sidebar-collapse').click()
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-overlay')
    assert.equal((await box(page, '[data-testid="sidebar"]')).width, 216)
    assert.deepEqual(await box(page, '.v2-workspace'), workspace, 'the page does not move under the floating sidebar')
    await page.screenshot({ path: path.join(artifacts, 'shell-narrow-overlay.png') })
    await page.keyboard.press('Escape')
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    // Escape restores focus in the next animation frame, after the class changes.
    await expect(page.getByTestId('sidebar-collapse')).toBeFocused()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '展开侧栏')
    await page.getByTestId('sidebar-collapse').click()
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-overlay')
    await page.getByTestId('page-home').click({ position: { x: 900, y: 10 } })
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    await page.getByTestId('sidebar-collapse').click()
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').waitFor()
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    assert.equal(await page.evaluate(() => localStorage.getItem('xingmang-v2-sidebar')), null, 'collapsing on its own does not change the saved choice')
    // 窗口拉回 1280：回到自己设的样子（没设过就是展开）。
    await page.setViewportSize({ width: 1280, height: 820 })
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell')
    await clean(page)
  } finally { await page.close() }
})

test('startup cards no longer carry the dialog shadow that the scroll area cut into a block', async () => {
  const page = await open('justUpdated=1&noticeCollection=1')
  try {
    const card = page.getByTestId('startup-notices-list').locator('.xm-notice').first()
    await card.waitFor()
    assert.equal(await card.evaluate((element) => getComputedStyle(element).boxShadow.includes('64px')), false, 'the card does not carry the dialog shadow that the scroll area cuts into a block')
    await clean(page)
  } finally { await page.close() }
})

test('a detail drawer stays between the bars, leaves the list usable and switches to the row picked behind it', async () => {
  const page = await open('recentWorkspaces=1')
  try {
    await page.getByTestId('nav-sessions').click()
    const rows = page.locator('[data-testid^="sessions-view-"]')
    await rows.first().click()
    const drawer = page.getByTestId('session-detail-drawer')
    await drawer.getByRole('heading', { name: '会话 1', exact: true }).waitFor()
    const drawerBox = await box(page, '[data-testid="session-detail-drawer"]')
    assert.equal(drawerBox.top, (await box(page, '#v2-main')).top, 'the drawer starts where the page starts')
    assert.equal(drawerBox.bottom, (await box(page, '[data-testid="shell-statusbar"]')).top, 'the drawer stops above the status bar')
    // 背后不罩、不锁：页面上的按钮照样点得到。
    assert.equal(await page.evaluate(() => document.querySelector(':modal')), null)
    const topbarButton = await page.getByTestId('announcement-open').boundingBox()
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="announcement-open"]') !== null, { x: topbarButton.x + 5, y: topbarButton.y + 5 }), true)
    // 盖在抽屉下面的那一行用键盘也能换过去，抽屉里换成那一行。
    await rows.nth(1).focus()
    await page.keyboard.press('Enter')
    await drawer.getByRole('heading', { name: '会话 2', exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 1)
    // 焦点在抽屉外面时按 Esc 照样关，焦点留在刚才那一行上。
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'detached' })
    assert.equal(await rows.nth(1).evaluate((element) => element === document.activeElement), true)
    await clean(page)
  } finally { await page.close() }
})

function setBrowserOnline(page, online) {
  return page.evaluate((value) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value })
    window.dispatchEvent(new Event(value ? 'online' : 'offline'))
  }, online)
}

test('going offline swaps the announcement bar for the offline bar and brings it back afterwards', async () => {
  const page = await open('noticeCollection=1')
  try {
    const banner = page.getByTestId('announcement-banner')
    await banner.waitFor()
    await setBrowserOnline(page, false)
    const offline = page.getByTestId('offline-banner')
    await offline.waitFor()
    await banner.waitFor({ state: 'detached' })
    // 只剩一条：页面只往下让一条的高度。
    assert.equal(await page.locator('.v2-workspace > :is(.v2-offline-banner, .v2-announcement-banner, .v2-promo-bar)').count(), 1)
    assert.equal(await offline.getByRole('button').last().textContent(), '检查网络')
    // 铃铛的红点照旧。
    await page.getByTestId('announcement-open').locator('.v2-unread').waitFor()
    await setBrowserOnline(page, true)
    await offline.waitFor({ state: 'detached' })
    await banner.waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('the note that the app went direct closes by itself once the app is back on the system proxy', async () => {
  const page = await open('sub2api=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    // 电脑里的代理软件关了：读余额连着被拒两次，星芒自己改成直连，余额又读得到了。
    await page.evaluate(() => {
      window.v2Test.fail = 'getAccountBalance'
      window.v2Test.failMessage = "Error invoking remote method 'account:get-balance': Error: 系统里设置的代理连不上，请检查代理或加速设置后再试。"
    })
    const refresh = page.getByTestId('sidebar-balance-refresh')
    await refresh.click()
    await page.getByTestId('account-entry').getByText('更新失败', { exact: true }).waitFor()
    await refresh.click()
    const notice = page.getByTestId('proxy-bypass-banner')
    await notice.waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'bypassBrokenProxy').length), 1)
    // 代理软件又开起来，主进程改回跟随系统代理：不用点「知道了」，这条提示自己收起。
    await page.evaluate(() => window.v2Test.emit('onProxyBypassEnded', undefined))
    await notice.waitFor({ state: 'detached' })
    assert.equal(await page.getByTestId('offline-banner').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the status bar says whether the environment is fine and follows the latest check', async () => {
  const page = await open('diagnostics=1&diagnosticIssues=2&diagnosticWarnings=3')
  try {
    const environment = page.getByTestId('statusbar-environment')
    await expect.poll(() => environment.textContent()).toBe('环境有 2 项需要处理')
    assert.equal(await environment.locator('.v2-dot').getAttribute('class'), 'v2-dot is-warn')
    await expect.poll(() => environment.getAttribute('title')).toBe('Node.js v24.0.0 · Python 3.12.0 · Git 2.43.0')
    await clean(page)
  } finally { await page.close() }
  const unchecked = await open()
  try {
    const environment = unchecked.getByTestId('statusbar-environment')
    // 开机没跑检查：灰点，不猜。
    assert.equal(await environment.textContent(), '环境待检测')
    assert.equal(await environment.locator('.v2-dot').getAttribute('class'), 'v2-dot')
    await environment.click()
    await unchecked.getByTestId('page-health').waitFor()
    // 检查页跑完，状态栏跟着变。
    await expect.poll(() => environment.textContent()).toBe('环境正常')
    assert.equal(await environment.locator('.v2-dot').getAttribute('class'), 'v2-dot is-ok')
    await clean(unchecked)
  } finally { await unchecked.close() }
})

test('cards on a page sit 16 apart, a list in a card reaches its edges and a long card note leaves the title on one line', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-maintenance').click()
    await page.getByTestId('maintenance-tool-claude').waitFor()
    const layout = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('[data-testid="page-maintenance"] > .xm-card')]
      const gaps = cards.slice(1).map((card, index) => Math.round(card.getBoundingClientRect().top - cards[index].getBoundingClientRect().bottom))
      const tools = cards[0]
      const card = tools.getBoundingClientRect()
      const head = tools.querySelector('.v2-business-table-head').getBoundingClientRect()
      const row = tools.querySelector('.xm-list-row')
      const rowBox = row.getBoundingClientRect()
      return {
        gaps,
        // 卡片自己有 1 像素边框，表头和行贴着它。
        edges: [head.left - card.left, card.right - head.right, rowBox.left - card.left, card.right - rowBox.right].map(Math.round),
        firstRowBorder: getComputedStyle(row).borderTopWidth,
      }
    })
    assert.ok(layout.gaps.length >= 1)
    assert.deepEqual(layout.gaps, layout.gaps.map(() => 16))
    assert.deepEqual(layout.edges, [1, 1, 1, 1])
    assert.equal(layout.firstRowBorder, '0px', 'the table head already draws the line above the first row')
    await page.getByTestId('nav-health').click()
    const codex = page.getByTestId('health-codex-responses')
    await codex.waitFor()
    const title = await codex.locator('.xm-card-head h2').evaluate((element) => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight) }))
    assert.ok(title.height < title.line * 1.5, `the title stays on one line (${title.height})`)
    assert.equal(await codex.locator('.xm-card-head small').count(), 0)
    assert.match(await codex.locator('.xm-card-body > .xm-card-lead').textContent(), /^上面的连接自检只确认能连上。/)
    await clean(page)
  } finally { await page.close() }
})
