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
import { assertNoToast, recordToasts, waitForToast } from '../../../e2e/toast-recording.mjs'
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

before(async () => {
  await fs.mkdir(artifacts, { recursive: true })
  ;({ server, origin } = await createFixtureServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error' }))
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  // Pay the transform and dependency-optimisation cost once, here, instead of
  // charging it to whichever test happens to run first.
  await (await open()).close()
})
after(async () => { await browser?.close(); await server?.close() })
// UI v4 pickers (key and source dropdowns) are a button and a menu of options, not a <select>.
async function pickOption(page, testId, value) {
  await page.getByTestId(testId).click()
  await page.getByTestId(`${testId}-option-${value}`).click()
}
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
  if (clock === 'fixed' || clock instanceof Date) {
    // Date.now stands still but timers keep running: React reveals a lazily
    // loaded page on a timer, which a paused clock never fires. A Date fixes
    // the clock at that moment instead.
    await page.clock.setFixedTime(clock instanceof Date ? clock : new Date('2026-09-12T04:00:01Z'))
  } else if (clock) {
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
// v4 侧栏账号卡上没有「切换账号」了，它在个人中心「账号概览」底下那条「当前登录」上。
// 切换框里的东西都在框里找。
async function openAccountSwitcher(page) {
  await page.getByTestId('sidebar-account-open').click()
  await page.getByTestId('account-switch').click()
  const switcher = page.getByRole('dialog', { name: '切换账号', exact: true })
  await switcher.waitFor()
  return switcher
}

// v4 批09：游戏加速、备份、更新三页并进了「设置」，成了三张卡。手动去的路是侧栏「设置」再点
// 左栏那一组；卡的 testId 沿用原来的页面名。
async function openSettingsGroup(page, label) {
  await page.getByTestId('nav-settings').click()
  const settings = page.getByTestId('page-settings')
  const tab = settings.getByRole('tab', { name: label, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-selected', 'true')
  return settings
}
// 版本卡挂上后先自己读一次更新状态，读回来会盖掉在那之前推过去的：等它读完再往下走。
async function openVersionCard(page) {
  const settings = await openSettingsGroup(page, '版本更新')
  const card = settings.getByTestId('page-updates')
  await expect(card.getByTestId('updates-current-version')).toHaveText(/^当前版本 v|^版本暂未读到$/)
  return card
}
async function openBackupCard(page) {
  const settings = await openSettingsGroup(page, '备份迁移')
  const card = settings.getByTestId('page-backups')
  await card.waitFor()
  return card
}

// 首页「最近」读完之前说不准哪个工具聊过，第一次点「打开」照旧弹选择框；读完了、这个工具
// 没聊过也没选过文件夹，「打开」才直接替用户建项目文件夹（已知40）。
async function recentRead(page) {
  await page.waitForFunction(() => {
    const card = document.querySelector('[data-testid="home-recent-card"]')
    return Boolean(card) && !card.textContent.includes('正在读取最近记录')
  })
}
const starterFolder = 'C:\\Users\\fixture\\Documents\\XingmangProjects\\my-project'

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

// 登录后主界面背后原来铺着一层一直在重画的星空：窗口在最前面时界面和显卡进程各占掉
// 一成左右 CPU（yoyo 10-15 拍板去掉，v4 原型主界面也没有）。欢迎页的星空不在这里管。
test('the signed-in workspace draws no canvas behind the pages', async () => {
  const page = await open()
  try {
    await page.getByTestId('shell-topbar').waitFor()
    assert.equal(await page.getByTestId('shell-starfield').count(), 0)
    assert.equal(await page.locator('.v2-workspace canvas').count(), 0)
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
    await page.getByTestId('sidebar-account-open').click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出登录？', exact: true }).getByRole('button', { name: '退出', exact: true }).click()
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
        // v4 首页只有一组「工具」卡片，装没装看卡片自己的 data-installed。
        assert.equal(await row.getAttribute('data-installed'), 'true')
        await page.getByTestId(`home-client-${tool}`).click()
        const dialog = page.getByTestId('external-client-dialog')
        await dialog.waitFor()
        // 自家工具的密钥默认选中、也排在下拉第一项：0.2.19 测试包里 Claude Desktop 的下拉第一项是 Codex 那把。
        const own = tool === 'claudeDesktop' ? 'configured:claude' : 'configured:codex'
        await expect(page.getByTestId('external-client-source')).toHaveAttribute('data-value', own)
        await page.getByTestId('external-client-source').click()
        const options = page.locator('[data-testid^="external-client-source-option-"]')
        assert.equal(await options.first().getAttribute('data-testid'), `external-client-source-option-${own}`)
        await options.first().click()
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
          await expect(dialog).toContainText('完全退出再重新打开 Claude Desktop')
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
      await page.locator('.v2-statusbar').getByText('已装 6 个工具', { exact: true }).waitFor()
      await page.getByTestId('home-your-tools').getByText('已装 6 个', { exact: true }).waitFor()
      // 「N 个已连接」那句 v4 没有了：连上当前账号的每张卡片左下角写「当前账号」。
      for (const tool of ['workbuddy', 'claudeDesktop', 'opencode']) assert.equal(await page.getByTestId(`tool-${tool}-source`).innerText(), '当前账号')
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
    assert.equal(await row.getAttribute('data-installed'), 'false')
    await row.getByRole('button', { name: '安装', exact: true }).click()
    await row.getByText('正在下载安装包', { exact: true }).waitFor()
    assert.equal(await row.getByRole('progressbar').getAttribute('aria-valuenow'), '36')
    // 装着的时候卡片上只有「取消」，没有能再点一次的「安装」。
    assert.equal(await row.getByRole('button', { name: '安装', exact: true }).count(), 0)
    await row.getByTestId('tool-workbuddy-cancel').waitFor()
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await row.getByRole('button', { name: '确认连接', exact: true }).waitFor()
    assert.equal(await row.getAttribute('data-installed'), 'true')
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
    await row.getByRole('button', { name: '确认连接', exact: true }).waitFor()
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
    await buddy.getByRole('button', { name: 'WorkBuddy 更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '打开', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchExternalClient').map((entry) => entry.args[0])), ['claudeDesktop', 'workbuddy'])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureExternalTool')), false)
    // 自己配好的 Claude Desktop 写「已配好」，不挂「当前账号」那块牌子：不替用户认领。
    assert.equal(await claude.getByTestId('tool-claudeDesktop-source').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// #1111 第 1 条：Claude Desktop 改用当前账号时原来那份连接用不上了，弹连接框之前先说一句为什么弹。
test('switching Claude Desktop back to the account says why the connection dialog opens', async () => {
  const page = await open('externalInstalled=1&externalReady=claudeDesktop&externalAccountOwned=claudeDesktop&externalReconnect=1')
  try {
    const source = page.getByTestId('tool-claudeDesktop-source')
    await source.click()
    await page.getByTestId('tool-claudeDesktop-source-official').click()
    await source.filter({ hasText: '官方账号' }).waitFor()
    await source.click()
    await page.getByTestId('tool-claudeDesktop-source-account').click()
    await waitForToast(page, '原来那份连接用不上了，在弹出的窗口里保存一次，就改用当前账号')
    await page.getByTestId('external-client-dialog').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 第三十一批 C：打开以后那一行先写「运行中」，后台悄悄核一次，三行按钮不跟着变灰、右上角不转圈。
test('opening a desktop client marks its row running and leaves the client rows usable while it rechecks', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    const opener = page.getByTestId('tool-workbuddy-primary')
    await row.getByTestId('tool-workbuddy-source').waitFor()
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

// 桌面客户端的「打开」不排在别的工具安装后面（I11 的登记例外，yoyo 2026-10-16 真机：装着 Claude Code
// 点 Claude Desktop 以为全卡住了）。别的工具在装时照旧写「正在打开客户端」，不说在等谁；打开完
// 首页的「打开」马上放开，不用等那边装完。
test('opening a desktop client while another tool installs neither claims to wait for it nor holds the other buttons', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy&externalLaunchPending=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    const opener = page.getByTestId('tool-workbuddy-primary')
    await row.getByTestId('tool-workbuddy-source').waitFor()
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.evaluate(() => window.v2Test.holdNextInstall())
    await page.getByTestId('tool-grok-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    await expect(opener).toBeEnabled()
    await opener.click()
    await row.getByText('正在打开客户端', { exact: true }).waitFor()
    assert.equal(await row.getByText(/正在等/).count(), 0)
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await row.getByText(/运行中/).waitFor()
    // Grok 还在装：「打开」照样能再点。
    await expect(opener).toBeEnabled()
    await page.evaluate(() => window.v2Test.releaseInstall())
    await page.getByTestId('tool-grok-source').waitFor()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchExternalClient').map((entry) => entry.args[0])), ['workbuddy'])
    await clean(page)
  } finally { await page.close() }
})

test('a background recheck that fails after opening a desktop client keeps the last result without an error bar', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    const opener = page.getByTestId('tool-workbuddy-primary')
    const unread = page.getByRole('alert').filter({ hasText: '客户端状态暂未读到' })
    await row.getByTestId('tool-workbuddy-source').waitFor()
    await expect(opener).toBeEnabled()
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length)
    await page.evaluate(() => { window.v2Test.fail = 'scanExternalClients' })
    await opener.click()
    await row.getByText(/运行中/).waitFor()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length > count, before)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await unread.count(), 0)
    assert.equal(await row.getByTestId('tool-workbuddy-source').count(), 1)
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
    await ready.getByRole('button', { name: 'WorkBuddy 更多操作', exact: true }).click()
    const readyMenu = page.getByRole('menu')
    assert.equal(await readyMenu.getByRole('menuitem', { name: '配置…', exact: true }).count(), 1)
    // 主按钮已经是「打开」，菜单里不再重复给一个「打开」。
    assert.equal(await readyMenu.getByRole('menuitem', { name: '打开', exact: true }).count(), 0)
    await page.getByTestId('home-client-workbuddy').click()
    await page.getByTestId('external-client-dialog').waitFor()
    await page.getByTestId('external-client-dialog').getByRole('button', { name: '取消', exact: true }).click()
    // 还没配好的外部客户端：主按钮本身就是「确认连接」，菜单里不再重复。
    const pending = page.getByTestId('tool-row-opencode')
    await pending.getByRole('button', { name: '确认连接', exact: true }).waitFor()
    await pending.getByRole('button', { name: 'OpenCode 更多操作', exact: true }).click()
    const pendingMenu = page.getByRole('menu')
    assert.equal(await pendingMenu.getByRole('menuitem', { name: '配置…', exact: true }).count(), 0)
    assert.equal(await pendingMenu.getByRole('menuitem', { name: '打开', exact: true }).count(), 1)
    await page.keyboard.press('Escape')
    // 四个 CLI 行一直只有菜单入口，行上没有独立「配置」按钮，两类工具行现在给法一致。
    const cli = page.getByTestId('tool-row-codex')
    assert.equal(await cli.getByRole('button', { name: '配置', exact: true }).count(), 0)
    await cli.getByRole('button', { name: 'Codex CLI 更多操作', exact: true }).click()
    assert.equal(await page.getByRole('menu').getByRole('menuitem', { name: '配置…', exact: true }).count(), 1)
    await page.keyboard.press('Escape')
    await clean(page)
  } finally { await page.close() }
})

test('external client incomplete Claude configuration requires setup before primary launch', async () => {
  const page = await open('externalInstalled=1&externalOther=claudeDesktop')
  try {
    const row = page.getByTestId('tool-row-claudeDesktop')
    await row.getByText('待连接', { exact: true }).waitFor()
    await expect(row).toContainText('第三方推理配置待完善')
    assert.equal(await row.getByRole('button', { name: '打开', exact: true }).count(), 0)
    await row.getByRole('button', { name: '确认连接', exact: true }).click()
    await page.getByTestId('external-client-dialog').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureExternalTool')), false)
    await clean(page)
  } finally { await page.close() }
})

test('acceleration state is read once when idle, and again when the game acceleration card in settings is shown', async () => {
  const page = await open()
  try {
    const reads = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getAccelerationState').length)
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'getAccelerationState'))
    const initial = await reads()
    await page.clock.install()
    await page.clock.runFor(60_000)
    assert.equal(await reads(), initial, '没在加速时不定时读状态')
    // v4 批09：游戏加速是「设置 › 网络加速」最上面那张卡。
    const settings = await openSettingsGroup(page, '网络加速')
    await settings.getByTestId('acceleration-page').waitFor()
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
    // 开机只先要上次落盘的那份（已知13），主进程不起盘点；真的盘点照旧等首屏扫描。
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients' && !entry.args[1]?.cachedOnly).length), 0, '首屏扫描没回来之前不盘点外部客户端')
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'scanExternalClients' && entry.args[1]?.cachedOnly === true)), true)
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'scanExternalClients' && !entry.args[1]?.cachedOnly))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients' && !entry.args[1]?.cachedOnly).map((entry) => entry.args)), [[false]])
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients' && !entry.args[1]?.cachedOnly).length > 1)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').at(-1).args), [true])
    await clean(page)
  } finally { await page.close() }
})

// 已知13：开机先摆上次落盘的客户端检测结果，以前那几行要等首屏扫描和自己那轮都完了才出来。
test('desktop client rows show the last saved result at startup and wait for the real scan before acting', async () => {
  const page = await open('cachedScan=1&externalCached=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByText('v0.9.0 · cached-model', { exact: true }).waitFor()
    await page.getByTestId('home-external-detecting').waitFor()
    assert.equal(await page.getByTestId('tool-workbuddy-primary').isDisabled(), true)
    await row.getByRole('button', { name: 'WorkBuddy 更多操作', exact: true }).click()
    assert.equal(await page.getByRole('menu').getByRole('menuitem', { name: '配置…', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients' && !entry.args[1]?.cachedOnly).length), 0, '首屏扫描没回来之前不盘点外部客户端')
    await page.evaluate(() => window.v2Test.releaseScan())
    // 真的结果回来整份替换：这次 WorkBuddy 没装。
    await row.getByRole('button', { name: '安装', exact: true }).waitFor()
    assert.equal(await row.getByText('v0.9.0 · cached-model', { exact: true }).count(), 0)
    await page.getByTestId('home-external-detecting').waitFor({ state: 'detached' })
    assert.equal(await row.getByRole('button', { name: '安装', exact: true }).isEnabled(), true)
    await clean(page)
  } finally { await page.close() }
})

test('a failed first desktop client scan takes the last saved rows down instead of leaving them waiting', async () => {
  const page = await open('cachedScan=1&externalCached=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByText('v0.9.0 · cached-model', { exact: true }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'scanExternalClients'; window.v2Test.releaseScan() })
    await page.getByRole('alert').filter({ hasText: '客户端状态暂未读到' }).waitFor()
    assert.equal(await row.count(), 0)
    assert.equal(await page.getByTestId('home-external-detecting').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('external client scans from the previous account cannot overwrite the current account', async () => {
  const page = await open('externalInstalled=1')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByRole('button', { name: '确认连接', exact: true }).waitFor()
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
    // 连上当前账号的卡片左下角写「当前账号」（v4 没有「N 个已连接」那句了），余额卡上不写连接的事。
    assert.equal(await row.getByTestId('tool-workbuddy-source').innerText(), '当前账号')
    assert.equal(await page.getByRole('heading', { name: '账户余额', exact: true }).locator('xpath=ancestor::section[1]').getByText(/已连接|等待连接/).count(), 0)
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length)
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    const switcher = await openAccountSwitcher(page)
    await switcher.getByTestId('saved-accounts-list').getByRole('button', { name: '切换', exact: true }).click()
    // WorkBuddy 用的是别处的配置，切换框留着说这件事；换好了就关掉它回首页看那一行。
    await page.getByRole('button', { name: /^个人中心：saved-user(，|$)/ }).waitFor()
    await switcher.getByRole('button', { name: '关闭', exact: true }).click()
    await switcher.waitFor({ state: 'hidden' })
    await page.getByTestId('nav-home').click()
    await page.getByRole('heading', { name: /saved-user/ }).waitFor()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'scanExternalClients').length > count, before)
    assert.equal(await row.getByTestId('tool-workbuddy-source').count(), 0)
    await page.evaluate(() => window.v2Test.releaseExternalScan())
    await row.getByText('别处的配置', { exact: true }).waitFor()
    await row.getByText('v1.2.3 · fixture-model', { exact: true }).waitFor()
    assert.equal(await row.getByTestId('tool-workbuddy-source').count(), 0)
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
    await row.getByTestId('tool-workbuddy-source').waitFor()
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') === 'true')
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, siteId: 'solov', account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 } }))
    await row.getByText('别处的配置', { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.v2Test.releaseExternalScan()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await row.getByTestId('tool-workbuddy-source').count(), 0)
    assert.equal(await row.getByText('别处的配置', { exact: true }).count(), 1)
    // 命令行那三张（Claude Code、Codex CLI、Codex 桌面端）照旧连着当前账号。
    for (const tool of ['claude', 'codex', 'codexDesktop']) await connectedBadge(page, tool).waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('logout retains WorkBuddy local configuration without retaining the signed-out account badge or late scan', async () => {
  const page = await open('externalInstalled=1&externalReady=workbuddy&externalAccountOwned=workbuddy')
  try {
    const row = page.getByTestId('tool-row-workbuddy')
    await row.getByTestId('tool-workbuddy-source').waitFor()
    await page.evaluate(() => window.v2Test.holdNextExternalScan())
    await page.getByTestId('home-rescan').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') === 'true')
    await page.getByTestId('sidebar-account-open').click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出登录？', exact: true }).getByRole('button', { name: '退出', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    assert.equal(await row.count(), 0)
    await page.getByTestId('welcome-steps').click()
    await page.getByTestId('guide-route-codexDesktop').check()
    // 退出登录后本机 Key 还在、仍是当前账号来源，「确认连接」会被跳过（第十一批 3）。
    for (let step = 0; step < 2; step++) await page.getByTestId('guide-next').click()
    await page.locator('[data-guide-step="ready"]').waitFor()
    await page.getByTestId('guide-home').click()
    await row.getByText('别处的配置', { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.v2Test.releaseExternalScan()
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    assert.equal(await row.getByTestId('tool-workbuddy-source').count(), 0)
    assert.equal(await row.getByText('别处的配置', { exact: true }).count(), 1)
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
    assert.equal(await page.getByText('WorkBuddy 已装好，点「确认连接」用上当前账号', { exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the Claude Desktop dialog moves to the Claude Code key once it lands, but only while untouched', async () => {
  const page = await open('clientModels=1&claudeUnconfigured=1&bootstrapPending=1')
  try {
    await page.getByTestId('home-client-claudeDesktop').click()
    await page.getByTestId('external-client-dialog').waitFor()
    // Claude Code 还没写上密钥：先借 Codex 那把，但不把 Codex 的 GPT 型号带进来。
    await expect(page.getByTestId('external-client-source')).toHaveAttribute('data-value', 'configured:codex')
    assert.equal(await page.getByTestId('external-client-model').inputValue(), '')
    await page.evaluate(() => window.v2Test.releaseBootstrap())
    await expect(page.getByTestId('external-client-source')).toHaveAttribute('data-value', 'configured:claude')
    await page.getByTestId('external-client-save').click()
    await page.getByTestId('external-client-result').getByText('配置已保存', { exact: true }).waitFor()
    const call = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureExternalTool').at(-1))
    assert.deepEqual(call.args, ['claudeDesktop', { credential: { kind: 'configured', provider: 'claude' }, model: 'claude-fixture' }])
    await clean(page)
  } finally { await page.close() }
  // 他已经自己换过来源，后来写好的 Claude Code 密钥不许把他的选择换掉。
  const touched = await open('clientModels=1&claudeUnconfigured=1&bootstrapPending=1')
  try {
    await touched.getByTestId('home-client-claudeDesktop').click()
    await expect(touched.getByTestId('external-client-source')).toHaveAttribute('data-value', 'configured:codex')
    await pickOption(touched, 'external-client-source', 'manual')
    await expect(touched.getByTestId('tool-claude-primary')).not.toHaveText('打开')
    await touched.evaluate(() => window.v2Test.releaseBootstrap())
    // 首页那张 Claude Code 卡片变成「打开」，说明写好的配置已经读回来了；再等两帧，弹窗那边跟不跟都该落定了。
    await expect(touched.getByTestId('tool-claude-primary')).toHaveText('打开')
    await touched.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await touched.getByTestId('external-client-source').getAttribute('data-value'), 'manual')
    await clean(touched)
  } finally { await touched.close() }
  // 弹窗自己读到的工具配置还是旧的、密钥列表还没回来，首页先读到了写好的配置：弹窗读完也要换到 Claude Code 那把。
  const racing = await open('clientModels=1&claudeUnconfigured=1&bootstrapPending=1')
  try {
    await racing.getByTestId('home-client-claudeDesktop').waitFor()
    await racing.evaluate(() => window.v2Test.holdAccountKeys())
    await racing.getByTestId('home-client-claudeDesktop').click()
    await racing.getByTestId('external-client-dialog').waitFor()
    await racing.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'getAccountKeys'))
    await racing.evaluate(() => window.v2Test.releaseBootstrap())
    await expect(racing.getByTestId('tool-claude-primary')).toHaveText('打开')
    await expect(racing.getByTestId('external-client-save')).toBeDisabled()
    await racing.evaluate(() => window.v2Test.releaseAccountKeys())
    await expect(racing.getByTestId('external-client-source')).toHaveAttribute('data-value', 'configured:claude')
    await clean(racing)
  } finally { await racing.close() }
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
    await pickOption(page, 'external-client-source', 'account:202')
    // A new key has no detected models yet: the footer offers to detect first.
    await expect(page.getByTestId('external-client-save')).toHaveText('保存并检测')
    await page.getByTestId('external-client-detect').click()
    await page.getByTestId('external-client-model').selectOption('fixture-other')
    await page.getByTestId('external-client-save').click()
    const call = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureExternalTool').at(-1))
    assert.deepEqual(call.args, ['workbuddy', { credential: { kind: 'account', keyId: 202 }, model: 'fixture-other' }])
    await clean(page)
  } finally { await page.close() }
})

test('a replaced manual client key cannot save the previous key first detected model unseen', async () => {
  const page = await open('clientModels=1')
  try {
    await page.getByTestId('home-client-workbuddy').click()
    await pickOption(page, 'external-client-source', 'manual')
    await page.getByTestId('external-client-secret').fill('sk-fixture-first-key-0001')
    await page.getByTestId('external-client-save').click()
    // 第一把密钥读到的型号没有一个拿得准，只替他填上第一项，不保存；说一句还没保存，焦点放到「默认模型」上。
    await expect(page.getByTestId('external-client-save')).toHaveText('保存配置')
    assert.equal(await page.getByTestId('external-client-model').inputValue(), 'fixture-model')
    assert.equal(await page.getByTestId('external-client-pick-model').innerText(), '还没保存。请在「默认模型」里选一个模型，再点「保存配置」。')
    await expect(page.getByTestId('external-client-model')).toBeFocused()
    await page.getByTestId('external-client-secret').fill('sk-fixture-second-key-0002')
    assert.equal(await page.getByTestId('external-client-pick-model').count(), 0)
    await expect(page.getByTestId('external-client-save')).toHaveText('保存并检测')
    await page.getByTestId('external-client-save').click()
    // 换了密钥，上一把替他填的第一项不算「原来就配着的」：检测完照旧停下让他自己挑。
    await expect(page.getByTestId('external-client-save')).toHaveText('保存配置')
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureExternalTool').length), 0)
    assert.equal(await page.getByTestId('external-client-result').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('Codex non-GPT menu requires a detected non-GPT model before saving', async () => {
  const page = await open('clientModels=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.waitFor()
    assert.equal(await row.getByRole('button', { name: '换用别家模型', exact: true }).count(), 0)
    await row.getByRole('button', { name: 'Codex CLI 更多操作', exact: true }).click()
    await page.getByTestId('home-codex-models').click()
    // UI v4: its own small dialog, not the whole configuration with a filter.
    const dialog = page.getByTestId('codex-other-models-dialog')
    await dialog.waitFor()
    assert.equal(await page.getByTestId('config-dialog').count(), 0)
    // The current key's models load on their own; nothing is picked yet, so saving waits.
    const list = page.getByTestId('tool-codex-model-filter')
    await list.getByRole('radio', { name: 'deepseek-fixture' }).waitFor()
    assert.equal(await page.getByTestId('tool-save-config').isDisabled(), true)
    const choices = await list.getByRole('radio').allTextContents()
    assert.equal(choices.some((label) => label.includes('gpt-fixture')), false)
    await list.getByRole('radio', { name: 'deepseek-fixture' }).click()
    await page.getByTestId('tool-save-config').click()
    await dialog.waitFor({ state: 'hidden' })
    const call = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfig').at(-1))
    assert.equal(call.args[0].model, 'deepseek-fixture')
    assert.equal(call.args[0].provider, 'codex')
    assert.equal(call.args[0].apiKey, '')
    await clean(page)
  } finally { await page.close() }
})

// #1154 附录：服务状态文件改了 Codex 默认，「换用别家模型」里那条「Codex 默认」也跟着换，不再只认程序自带的。
test('Codex non-GPT menu offers the published Codex default as the way back', async () => {
  const page = await open('clientModels=1&cliModelHints=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.waitFor()
    await row.getByRole('button', { name: 'Codex CLI 更多操作', exact: true }).click()
    await page.getByTestId('home-codex-models').click()
    const list = page.getByTestId('tool-codex-model-filter')
    await list.getByRole('radio', { name: /gpt-fixture/ }).waitFor()
    const choices = await list.getByRole('radio').allTextContents()
    assert.equal(choices.length, 3)
    assert.match(choices[0], /gpt-fixture[\s\S]*Codex 默认/)
    assert.equal(choices.filter((label) => label.includes('Codex 默认')).length, 1)
    await page.keyboard.press('Escape')
    await page.getByTestId('codex-other-models-dialog').waitFor({ state: 'hidden' })
    await clean(page)
  } finally { await page.close() }
})

test('Codex model lists leave out grok-4.6 while the Grok CLI still offers it', async () => {
  const page = await open('codexGrokModels=1&allInstalled=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.waitFor()
    await row.getByRole('button', { name: 'Codex CLI 更多操作', exact: true }).click()
    await page.getByTestId('home-codex-models').click()
    const list = page.getByTestId('tool-codex-model-filter')
    await list.getByRole('radio', { name: 'grok-4.7' }).waitFor()
    const choices = await list.getByRole('radio').allTextContents()
    assert.equal(choices.length, 2)
    assert.equal(choices.some((label) => label.includes('gpt-6-astra')), true)
    assert.equal(choices.some((label) => label.includes('grok-4.6')), false)
    await page.keyboard.press('Escape')
    await page.getByTestId('codex-other-models-dialog').waitFor({ state: 'hidden' })

    const options = () => page.getByLabel('默认模型').locator('option').evaluateAll((items) => items.map((item) => item.value))
    await openToolConfiguration(page, 'codex')
    await page.getByTestId('tool-detect-models').click()
    await page.getByLabel('默认模型').locator('option[value="grok-4.7"]').waitFor({ state: 'attached' })
    assert.equal((await options()).includes('grok-4.6'), false)
    await page.keyboard.press('Escape')
    await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })

    await openToolConfiguration(page, 'grok')
    await page.getByTestId('tool-detect-models').click()
    await page.getByLabel('默认模型').locator('option[value="grok-4.6"]').waitFor({ state: 'attached' })
    assert.equal((await options()).includes('grok-4.7'), true)
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
        return { root: width('.v2-root'), sidebar: width('.v2-sidebar'), left: Math.round(width('.v2-home-hero')), right: Math.round(width('.v2-home-balance')), top: height('.v2-topbar'), bottom: height('.v2-statusbar'), overflow: document.documentElement.scrollWidth > 1280 }
      })
      // v4 首页顶上一排：大卡和余额卡按原型 1.7 : 1 分 1000 宽的内容区（中间隔 14）。
      assert.deepEqual(geometry, { root: 1280, sidebar: 224, left: 621, right: 365, top: 44, bottom: 28, overflow: false })
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
      // v4 顶栏右边是深浅色、公告、帮助三个 30 见方的图标键。
      assert.deepEqual(actionGeometry.top, {
        height: 30, gap: 2, align: 'center', paddingTop: 0, buttonHeights: [30, 30, 30],
        geometricGap: 2, sameLine: true, contained: true, overflow: false,
      })
      assert.deepEqual(actionGeometry.home, {
        height: 40, gap: 8, align: 'center', paddingTop: 4, buttonHeights: [36, 36],
        geometricGap: 8, sameLine: true, contained: true, overflow: false,
      })
      assert.equal(actionGeometry.pageHeadAlign, 'flex-start')
      assert.ok(Math.abs(actionGeometry.topCenterOffset) <= 1)
      assert.equal(actionGeometry.homeTopOffset, 4)
      // Gemini CLI 下线后少了它那一行。
      assert.equal(await page.locator('[data-testid^="tool-row-"]').count(), 7)
      assert.equal(await page.getByTestId('tool-row-gemini').count(), 0)
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
    await recentRead(page)
    const providers = ['claude', 'codex', 'grok']
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
    // 这几个工具都没聊过、也没选过文件夹：「打开」替用户建项目文件夹，建不成才弹选择框（已知40）。
    assert.deepEqual(choices.map((entry) => entry.args), providers.map(() => [{ createStarter: true, firstOpen: true }]))
    assert.deepEqual(launches.map((entry) => entry.args), providers.map((provider) => [provider, starterFolder]))
    for (let index = 0; index < launches.length; index += 1) {
      assert.ok(calls.indexOf(choices[index]) < calls.indexOf(launches[index]))
    }
    assert.deepEqual(calls.find((entry) => entry.method === 'launchCodexDesktop').args, ['open'])
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置…', exact: true }).click()
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
    // v4 卡片的主按钮只写「打开」，最近用过的目录写在悬停说明里，用户点下去之前能看到会在哪里打开。
    assert.equal(await button.innerText(), '打开')
    assert.equal(await button.getAttribute('title'), '在 C:\\work\\my-app 打开')
    assert.equal(await page.getByTestId('tool-codex-primary').getAttribute('title'), '在 C:\\work\\codex-app 打开')
    // 夹具里还留着一条已下线的 Gemini CLI 的记录（目录名很长）：首页不画它那一张卡片。
    assert.equal(await page.getByTestId('tool-row-gemini').count(), 0)
    await button.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const direct = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(direct.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args), [['claude', 'C:\\work\\my-app']])
    // 没记过目录的工具保持原来的行为：主按钮就是「打开」，没有悬停目录。
    assert.equal(await page.getByTestId('tool-grok-primary').innerText(), '打开')
    assert.equal(await page.getByTestId('tool-grok-primary').getAttribute('title'), null)
    assert.equal(direct.some((entry) => entry.method === 'chooseWorkspace'), false)

    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
    const items = await page.getByRole('menuitem').allInnerTexts()
    // 「…」最上面原来是最近几个文件夹的整条路径，客户看着像对话记录又看不懂（yoyo 10-16）：
    // 换成「接着之前的对话…」，后面还是原来的选择器和新建。
    assert.deepEqual(items.slice(0, 3), ['接着之前的对话…', '选择其他文件夹…', '新建项目文件夹并打开'])
    await page.getByTestId('tool-claude-choose-workspace').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'chooseWorkspace'))
    const picked = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(picked.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args),
      [['claude', 'C:\\work\\my-app'], ['claude', 'C:\\Selected Project']])

    // 目录名再长，按钮上也只写「打开」，完整路径在悬停说明里。
    await page.evaluate(() => window.v2Test.addRecentSession('6', 'grok', 'C:\\work\\a-very-long-project-name', 50))
    await page.getByTestId('home-rescan').click()
    await expect(page.getByTestId('tool-grok-primary')).toHaveAttribute('title', '在 C:\\work\\a-very-long-project-name 打开')
    assert.equal(await page.getByTestId('tool-grok-primary').innerText(), '打开')
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
    assert.equal(await row.locator('.v2-home-recent-dir').innerText(), 'Claude Code · my-app')
    assert.equal(await row.locator('.v2-home-recent-dir').getAttribute('title'), 'C:\\work\\my-app')
    assert.match(await row.locator('.v2-home-recent-time').innerText(), /^19(69|70)年\d{1,2}月\d{1,2}日$/)
    assert.equal(await page.getByTestId('home-recent-resume-claude:2').count(), 1)
    assert.equal(await page.getByTestId('home-recent-resume-claude:3').count(), 0)
    // v4 行上不再有「查看」（字表批04）：去记录页走卡片右上角的「全部记录」。
    assert.equal(await page.getByTestId('home-recent-card').getByRole('button', { name: '查看', exact: true }).count(), 0)
    assert.equal(await page.getByTestId('home-recent-card').getByRole('button', { name: '全部记录', exact: true }).count(), 1)

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

// yoyo 10-16：卡片「…」最上面那串文件夹路径看着像对话记录、又看不懂，换成「接着之前的对话…」，
// 弹一个窗口，一个文件夹一行，点哪行接哪行。
test('the card menu lists earlier chats of that tool, one per folder, and resumes the one picked', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await page.getByTestId('home-recent-resume-claude:1').waitFor()
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
    await page.getByTestId('tool-claude-conversations').click()
    const dialog = page.getByTestId('tool-conversations-dialog')
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('heading').innerText(), '接着 Claude Code 之前的对话')
    // my-app 的两条只留最近的 claude:1；older-app 的文件夹没了，那行照样列、按钮灰着；别的工具的不进来。
    await page.getByTestId('tool-conversation-row-claude:1').waitFor()
    assert.deepEqual(await dialog.locator('.v2-home-recent-row').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid'))),
      ['tool-conversation-row-claude:1', 'tool-conversation-row-claude:2'])
    // 现读的是这一个工具的记录，不是首页那份 60 条（开发版的 StrictMode 会让窗口挂上时读两遍，只看读的是什么）。
    const reads = await page.evaluate(() => window.v2Test.calls
      .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.provider === 'claude').map((entry) => entry.args[0]))
    assert.ok(reads.length > 0)
    for (const read of reads) assert.deepEqual(read, { provider: 'claude', page: 1, pageSize: 100 })
    const row = page.getByTestId('tool-conversation-row-claude:1')
    assert.equal(await row.locator('.v2-recent-title').innerText(), '会话 1')
    assert.equal(await row.locator('.v2-home-recent-dir').innerText(), 'my-app')
    assert.equal(await row.locator('.v2-home-recent-dir').getAttribute('title'), 'C:\\work\\my-app')
    assert.equal(await page.getByTestId('tool-conversation-row-claude:2').getByText('文件夹已不存在').count(), 1)
    assert.equal(await page.getByTestId('tool-conversation-resume-claude:2').isDisabled(), true)

    await page.getByTestId('tool-conversation-resume-claude:1').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await expect(dialog).toHaveCount(0)
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args), [['claude', 'C:\\work\\my-app', 'resumeLast']])
    // 文件夹是记录里现成的，不再弹选择框。
    assert.equal(calls.some((entry) => entry.method === 'chooseWorkspace'), false)
    await clean(page)
  } finally { await page.close() }
})

// #1111 第 3 条：窗口里点「接着聊」才发现同一文件夹刚有新对话，这次不打开，行内说一句已换成最新那条。
test('the earlier-chats window says it swapped in the newest chat of a folder instead of silently not opening', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await page.getByTestId('home-recent-resume-claude:1').waitFor()
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
    await page.getByTestId('tool-claude-conversations').click()
    const dialog = page.getByTestId('tool-conversations-dialog')
    await page.getByTestId('tool-conversation-row-claude:1').waitFor()
    await page.evaluate(() => window.v2Test.addRecentSession('6', 'claude', 'C:\\work\\my-app', 500))
    await page.getByTestId('tool-conversation-resume-claude:1').click()
    await page.getByTestId('tool-conversation-row-claude:6').waitFor()
    assert.equal(await dialog.getByTestId('tool-conversations-replaced').innerText(), 'my-app 里刚有新的对话，已换成最新那条，再点一次「接着聊」')
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli')), false)
    await page.getByTestId('tool-conversation-resume-claude:6').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await expect(dialog).toHaveCount(0)
    await clean(page)
  } finally { await page.close() }
})

test('the earlier-chats window can go to all records or start a new chat instead', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  async function openChats() {
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
    await page.getByTestId('tool-claude-conversations').click()
    await page.getByTestId('tool-conversations-dialog').waitFor()
  }
  try {
    await page.getByTestId('home-recent-resume-claude:1').waitFor()
    // Grok CLI 一条记录都没有：它的「…」里没有这一项。
    await page.getByRole('button', { name: 'Grok CLI 更多操作', exact: true }).click()
    assert.equal(await page.getByTestId('tool-grok-conversations').count(), 0)
    await page.keyboard.press('Escape')

    await openChats()
    await page.getByTestId('tool-conversations-all').click()
    await page.getByTestId('page-sessions').waitFor()
    await expect(page.getByTestId('tool-conversations-dialog')).toHaveCount(0)
    await page.getByTestId('nav-home').click()

    await openChats()
    await page.getByTestId('tool-conversations-new').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    // 「开新对话」就是卡片上的「打开」：在最近用过的文件夹里开，不接上一条。
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args)),
      [['claude', 'C:\\work\\my-app']])
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
    await expect(page.getByTestId('tool-claude-primary')).toHaveText('安装')
    assert.equal(await page.getByTestId('tool-row-claude').getAttribute('data-installed'), 'false')
    // 在桌面端里聊过的一条也记在 Codex 名下，排在最前面；接着聊开的却是 Codex CLI，它没装。
    await page.evaluate(() => window.v2Test.addRecentSession('9', 'codex', 'C:\\work\\desk-app', 500))
    await page.getByTestId('home-rescan').click()
    const codex = page.getByTestId('home-recent-row-codex:9')
    await codex.waitFor()
    const card = page.getByTestId('home-recent-card')
    assert.equal(await card.locator('[data-testid^="home-recent-resume-"]').count(), 0)
    // 这一行的字、「打开文件夹」都照旧；没装的那家给一颗「先安装」（字表批04）。
    assert.equal(await codex.locator('.v2-home-recent-dir').innerText(), 'Codex CLI · desk-app')
    assert.equal(await page.getByTestId('home-recent-open-directory-codex:9').count(), 1)
    assert.equal(await page.getByTestId('home-recent-install-codex:9').innerText(), '先安装')
    assert.equal(await page.getByTestId('home-recent-install-codex:9').getAttribute('title'), '要先装好 Codex CLI')

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
    // v4：「打开文件夹」挪进了行上的「…」。目录已经没了的那一行这一项按不动，文件夹那一格挂着警告图标。
    const goneMenu = page.getByTestId('sessions-menu-claude:2')
    await goneMenu.waitFor()
    assert.equal(await page.getByTestId('sessions-missing-claude:2').getAttribute('title'), '这个文件夹已经不在了')
    await goneMenu.locator('button').first().click()
    const gone = page.getByTestId('sessions-open-directory-claude:2')
    await gone.waitFor()
    assert.equal(await gone.isDisabled(), true)
    await page.keyboard.press('Escape')
    await gone.waitFor({ state: 'detached' })

    const menu = page.getByTestId('sessions-menu-claude:1')
    const trigger = menu.locator('button').first()
    assert.equal(await trigger.getAttribute('aria-label'), '「会话 1」更多操作')
    await trigger.click()
    const open1 = page.getByTestId('sessions-open-directory-claude:1')
    assert.equal(await open1.innerText(), '打开文件夹')
    await open1.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'openProviderSessionDirectory'))
    // 详情弹窗「项目文件夹」那一行的「打开」是同一件事。
    await page.getByTestId('sessions-view-claude:1').click()
    await page.getByTestId('session-detail-open-directory').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'openProviderSessionDirectory').length === 2)
    const calls = await page.evaluate(() => window.v2Test.calls)
    // 只发会话 id:路径由主进程从记录里取,渲染层没有办法点名要打开哪个目录。
    assert.deepEqual(calls.filter((entry) => entry.method === 'openProviderSessionDirectory').map((entry) => entry.args),
      [['claude:1'], ['claude:1']])
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

// 「可以试试」整行可点：右边的小箭头不接点击，点在它上面落到整行那颗按钮上。
test('the arrow of a home suggestion still opens the row', async () => {
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
    // 小箭头本身不接点击，鼠标点在它的位置上，落到的是整行那颗按钮。v4 首页「可以试试」在页面下半截，先滚过去。
    await page.getByTestId('home-suggestion-mcp').scrollIntoViewIfNeeded()
    const arrow = await page.getByTestId('home-suggestion-mcp').locator('.xm-row-actions svg').boundingBox()
    assert.ok(arrow, 'the arrow is on the row')
    await page.mouse.click(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2)
    await page.getByTestId('page-mcp').waitFor()
    await clean(page)
  } finally { await page.close() }
  const fresh = await open('allInstalled=1')
  try {
    await fresh.getByTestId('home-suggestion-codex').waitFor()
    await clean(fresh)
  } finally { await fresh.close() }
})

// v4 记录页是一张表：标题、工具、项目文件夹、最后活动四列；标题下面那行小字只剩模型和几条消息，时间在自己那一列。
test('the records table puts each record on one row with tool chips that count', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await page.getByTestId('nav-sessions').click()
    const sessions = page.getByTestId('page-sessions')
    await sessions.getByTestId('sessions-row-claude:1').waitFor()
    assert.deepEqual(await sessions.locator('thead th').evaluateAll((cells) => cells.map((cell) => cell.textContent)), ['标题', '工具', '项目文件夹', '最后活动', '操作'])
    const row = sessions.getByTestId('sessions-row-claude:1')
    assert.equal(await row.locator('.v2-sessions-open small').innerText(), 'fixture-model · 2 条消息')
    assert.equal(await row.locator('td').nth(1).innerText(), 'Claude Code')
    // 工具按钮带数：全部 = Claude Code 3 + Codex 1；下线的 Gemini CLI 不算、也不出按钮。
    await page.waitForFunction(() => document.querySelector('[data-testid="sessions-tool-all"] .xm-chip-count')?.textContent === '4')
    assert.equal(await sessions.getByTestId('sessions-tool-claude').locator('.xm-chip-count').innerText(), '3')
    assert.equal(await sessions.getByTestId('sessions-tool-gemini').count(), 0)
    assert.equal(await sessions.getByTestId('sessions-tool-all').getAttribute('aria-pressed'), 'true')
    await sessions.getByTestId('sessions-tool-codex').click()
    assert.equal(await sessions.getByTestId('sessions-tool-codex').getAttribute('aria-pressed'), 'true')
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.provider === 'codex'))
    // 搜不到时说这一页自己的话，提醒切回「全部」。
    await page.evaluate(() => { window.xingmang.listProviderSessions = async () => ({ items: [], page: 1, pageSize: 20, total: 0, pages: 1, stats: { total: 0, byProvider: {} }, capabilities: {} }) })
    await sessions.getByTestId('sessions-search').fill('没有这条')
    await sessions.getByText('没有找到相关记录').waitFor()
    await sessions.getByText('换个关键词，或者切换到「全部」再看看。').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('an exported report can be revealed in its folder and says so when it moved (第八批 5)', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.getByTestId('nav-health').click()
    const health = page.getByTestId('page-health')
    await health.waitFor()
    await health.getByRole('button', { name: '导出检查报告', exact: true }).click()
    await health.getByText('检查报告已导出：C:\\Fixture\\xingmang-diagnostics.txt', { exact: true }).waitFor()
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
    await health.getByText('检查报告已导出：C:\\Fixture\\xingmang-diagnostics.txt', { exact: true }).waitFor()
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

// yoyo 那台 Windows（0.2.19）：底栏写着「已登录」，点「用量账单」个人中心却说「登录后查看个人中心」，
// 点「登录账号」再登几次都没用。个人中心去过就只藏不卸，同一个账号重新登录作用域不变、页面也不重挂，
// 页面自己读到过一次「没登录」就一直停在那里。外壳说登着就按外壳的摆，再请外壳问一次主进程。
test('the account page follows the shell login when its own session read says signed out', async () => {
  const page = await open()
  try {
    await page.evaluate(() => window.v2Test.signOutAccountPageSessionReads())
    await page.getByTestId('sidebar-account-open').click()
    await page.waitForFunction(() => window.v2Test.accountPageSessionSignedOutServed() > 0)
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.getByTestId('account-tabs')).toBeVisible()
    assert.equal(await page.getByTestId('page-account').getByText('登录后查看个人中心', { exact: true }).count(), 0)
    assert.equal(await page.getByTestId('welcome-page').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 主进程那边已经没登录、广播却没到外壳（底栏还写着「已登录」）：外壳再问一次就退回欢迎页，在那里
// 登录会整页重来，不再停在一个点了「登录账号」也回不来的「登录后查看个人中心」上。
test('a sign-out the shell missed reaches it when the account page finds no login', async () => {
  const page = await open()
  try {
    await page.evaluate(() => window.v2Test.dropSessionSilently())
    await page.getByTestId('sidebar-account-open').click()
    await page.getByTestId('welcome-page').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 全面检测 Q29：个人中心停在别的页签（以前是「我的订单」）时，回首页再点「充值」要回到充值那一页。
// 以前 App 里记的分页值没变（还是上次的「充值」），个人中心就不切。
test('the home recharge button reopens the recharge tab even after another account tab was chosen', async () => {
  const page = await open()
  try {
    const recharge = page.getByTestId('home-recharge')
    const selected = (name) => page.getByTestId('account-tabs').getByRole('tab', { name, exact: true }).getAttribute('aria-selected')
    await recharge.click()
    await page.getByTestId('account-tabs').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="account-tabs"] [aria-selected="true"]')?.textContent === '充值订阅')
    await page.getByTestId('account-tabs').getByRole('tab', { name: '账号概览', exact: true }).click()
    assert.equal(await selected('账号概览'), 'true')
    await page.getByTestId('nav-home').click()
    await recharge.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="account-tabs"] [aria-selected="true"]')?.textContent === '充值订阅')
    assert.equal(await selected('账号概览'), 'false')
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

// 已知4：从终端直接点回星芒，回到前面时那次重读是异步的，这一下用的还是旧列表：「接着聊」还挂在同一文件夹更早那条上，
// Claude Code 按文件夹接最近一条，接上的却是刚聊的那条。点下去先现读一份对一次，点的这条已经不是最近的就这次不打开，
// 按钮挪到刚聊的那条上；还是最近的就照常打开。
test('home 接着聊 checks the newest records first and holds back when a newer chat took over the folder (已知4)', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  const homeReads = () => page.evaluate(() => window.v2Test.calls
    .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === 60).length)
  try {
    const resume = page.getByTestId('home-recent-resume-claude:1')
    await resume.waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-recent-resume-claude:1"]')?.disabled === false)
    const reads = await homeReads()
    // 在终端里又聊了一条，回到前面的那次重读还没赶上：卡片上还是旧的。
    await page.evaluate(() => window.v2Test.addRecentSession('6', 'claude', 'C:\\work\\my-app', 500))
    await resume.click()
    await page.getByTestId('home-recent-resume-claude:6').waitFor()
    assert.equal(await homeReads(), reads + 1)
    assert.equal(await page.getByTestId('home-recent-resume-claude:1').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli')), false)
    // 没打开要说一句为什么（#1111 第 3 条），不然只看到按钮转一下、那行标题悄悄换掉。
    assert.equal(await page.getByTestId('home-recent-replaced').innerText(), 'my-app 里刚有新的对话，已换成最新那条，再点一次「接着聊」')
    // 挪过去的那颗还是最近的，照常打开。
    await page.waitForFunction(() => document.querySelector('[data-testid="home-recent-resume-claude:6"]')?.disabled === false)
    await page.getByTestId('home-recent-resume-claude:6').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    assert.equal(await homeReads(), reads + 2)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args)),
      [['claude', 'C:\\work\\my-app', 'resumeLast']])
    assert.equal(await page.getByTestId('home-recent-replaced').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// Codex 带着记录 id 接，点哪条接哪条，不用先对一次。
test('home 接着聊 on a Codex record opens right away without reading the records again (已知4)', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  const homeReads = () => page.evaluate(() => window.v2Test.calls
    .filter((entry) => entry.method === 'listProviderSessions' && entry.args[0]?.pageSize === 60).length)
  try {
    await page.getByTestId('home-recent-resume-claude:1').waitFor()
    await page.evaluate(() => window.v2Test.addRecentSession('9', 'codex', 'C:\\work\\codex-app', 500))
    await page.getByTestId('home-rescan').click()
    const resume = page.getByTestId('home-recent-resume-codex:9')
    await resume.waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="home-recent-resume-codex:9"]')?.disabled === false)
    const reads = await homeReads()
    await resume.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    assert.equal(await homeReads(), reads)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args)),
      [['codex', 'C:\\work\\codex-app', 'resumeLast', 'codex:9']])
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
    // 这次换了个文件夹：「…」→「选择其他文件夹…」，在那儿聊了一条。
    await page.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
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

// 已知4：记录页同一下。停在记录页时在终端里又聊了一条，半分钟内回到窗口不重读；这时点同一文件夹更早那条的「接着聊」，
// 先读一份最新的对一次，不是最近的就这次不打开，列表换成新的、按钮挪到刚聊的那条上。
test('the records page 接着聊 checks the newest records first and holds back when a newer chat took over the folder (已知4)', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  try {
    await page.getByTestId('nav-sessions').click()
    const resume = page.getByTestId('sessions-resume-claude:1')
    await resume.waitFor()
    const [list, latest] = await recordsReads(page)
    await page.evaluate(() => window.v2Test.addRecentSession('6', 'claude', 'C:\\work\\my-app', 500))
    await resume.click()
    await page.getByTestId('sessions-resume-claude:6').waitFor()
    assert.deepEqual(await recordsReads(page), [list + 1, latest + 1])
    assert.equal(await page.getByTestId('sessions-resume-claude:1').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli')), false)
    // 什么都没打开：不说「已打开」，也不报错。
    assert.equal(await page.locator('.v2-business-notice.is-error').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 已知5：外接工具、技能、插件这几页去过以后只藏不卸，在首页或终端里装好、删掉东西再回来，看到的还是
// 第一次进去时那份。再显示时各自重读一次；外接工具的连接检测要挨个连一遍，照旧不跟着重跑。
// （「安装卸载」页第 10 批拆掉了，它那一段跟着去掉。）
test('the extension pages read again when shown again (已知5)', async () => {
  const page = await open()
  const calls = (method) => page.evaluate((name) => window.v2Test.calls.filter((entry) => entry.method === name).length, method)
  // 第一次进来读几次不固定（开发模式挂两遍、检测结果晚到时换默认工具），等它不再涨再数。
  async function settled(method) {
    let previous = -1
    let current = await calls(method)
    while (current !== previous) {
      previous = current
      await page.waitForTimeout(150)
      current = await calls(method)
    }
    return current
  }
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
    for (const id of ['mcp', 'skills', 'plugins']) {
      await page.getByTestId(`nav-${id}`).click()
      await page.getByTestId(`page-${id}`).waitFor()
      const lists = await settled('listProviderExtensions')
      const health = await settled('checkProviderMcpHealth')
      await page.getByTestId('nav-home').click()
      await page.getByTestId('page-home').waitFor()
      await page.getByTestId(`nav-${id}`).click()
      await expect.poll(() => calls('listProviderExtensions')).toBe(lists + 1)
      assert.equal(await calls('checkProviderMcpHealth'), health)
    }
    await clean(page)
  } finally { await page.close() }
})

// 逆向报告 B4：在一个工具下改连接、点「重新检测」，等它跑完的工夫换到别的工具，跑完以后不能再照原来那个
// 工具读一遍、把它的列表和检测结果摆到新工具下面。
test('an extension action that finishes after switching tools leaves the new tool list on screen (B4)', async () => {
  const page = await open()
  const calls = (method) => page.evaluate((name) => window.v2Test.calls.filter((entry) => entry.method === name).map((entry) => entry.args[0]), method)
  // 落不落那一次多余的读取要等它不再涨才知道，同「已知5」那条。
  async function settled(method) {
    let previous = -1
    let current = (await calls(method)).length
    while (current !== previous) {
      previous = current
      await page.waitForTimeout(150)
      current = (await calls(method)).length
    }
    return calls(method)
  }
  try {
    await page.evaluate(() => {
      let held = null
      window.releaseHeld = () => held?.()
      function hold() {
        return new Promise((resolve) => { held = () => { held = null; resolve() } })
      }
      let holdNextList = false
      window.holdNextList = () => { holdNextList = true }
      window.xingmang.listProviderExtensions = async (provider) => {
        if (holdNextList) {
          holdNextList = false
          await hold()
        }
        return {
          provider, checkedAt: '2026-09-22T00:00:00Z', warnings: [],
          capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
          items: [{
            provider, kind: 'mcp', id: `${provider}-link`, name: `${provider}-link`, description: '本机测试连接',
            installed: true, enabled: true, scope: 'user', currentVersion: null, latestVersion: null,
            source: { kind: 'npm', locator: `${provider}-package`, reference: null },
            update: { state: 'up-to-date', reason: '', checkedAt: null },
            operations: { install: false, uninstall: true, enable: true, disable: true, update: false },
          }],
        }
      }
      // 换到 Codex CLI 时页面还要读它自己的连接、技能、插件清单（夹具里 Grok CLI 没装，换不过去）。
      window.xingmang.listMcpServers = async () => []
      window.xingmang.listSkills = async () => []
      window.xingmang.listPlugins = async () => ({ plugins: [], marketplaces: [] })
      window.xingmang.checkProviderMcpHealth = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', supported: true, reason: null, entries: [],
      })
      window.xingmang.mutateProviderExtension = () => hold()
    })
    await page.getByTestId('nav-mcp').click()
    const mcp = page.getByTestId('page-mcp')
    await mcp.getByTestId('mcp-row-claude-link').waitFor()
    // 在 Claude Code 下停用连接，没跑完就换到 Codex CLI（夹具里 Grok CLI 没装，选它只出安装那一条）。
    await mcp.getByTestId('mcp-toggle-claude-link').getByRole('switch').click()
    await expect.poll(async () => (await calls('mutateProviderExtension')).length).toBe(1)
    await mcp.getByRole('tab', { name: /^Codex CLI/ }).click()
    await mcp.getByTestId('mcp-row-codex-link').waitFor()
    const lists = (await settled('listProviderExtensions')).length
    await page.evaluate(() => window.releaseHeld())
    await waitForToast(page, '已停用「claude-link」')
    await expect(mcp.getByTestId('mcp-row-codex-link')).toBeVisible()
    assert.equal(await mcp.getByTestId('mcp-row-claude-link').count(), 0)
    assert.equal((await settled('listProviderExtensions')).length, lists)

    // 在 Codex CLI 下点「重新检测」，列表还没读回来就换到 Claude Code：检测不再替 Codex CLI 跑。
    const health = (await settled('checkProviderMcpHealth')).length
    await page.evaluate(() => window.holdNextList())
    await mcp.getByTestId('mcp-health-recheck').click()
    await expect.poll(async () => (await calls('listProviderExtensions')).length).toBe(lists + 1)
    await mcp.getByRole('tab', { name: /^Claude Code/ }).click()
    await mcp.getByTestId('mcp-row-claude-link').waitFor()
    await page.evaluate(() => window.releaseHeld())
    assert.deepEqual((await settled('checkProviderMcpHealth')).slice(health), ['claude'])
    await expect(mcp.getByTestId('mcp-row-claude-link')).toBeVisible()
    assert.equal(await mcp.getByTestId('mcp-row-codex-link').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 同一处的另一半：操作没跑完就换了工具，跑完才落下来的失败不能挂到新工具下面，换回原来那个工具再看到它。
test('an extension action that fails after switching tools shows its failure under the tool it ran for', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      let fail = null
      window.failHeld = (message) => fail?.(message)
      window.xingmang.listProviderExtensions = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', warnings: [],
        capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
        items: [{
          provider, kind: 'mcp', id: `${provider}-link`, name: `${provider}-link`, description: '本机测试连接',
          installed: true, enabled: true, scope: 'user', currentVersion: null, latestVersion: null,
          source: { kind: 'npm', locator: `${provider}-package`, reference: null },
          update: { state: 'up-to-date', reason: '', checkedAt: null },
          operations: { install: false, uninstall: true, enable: true, disable: true, update: false },
        }],
      })
      // 换到 Codex CLI 时页面还要读它自己的连接、技能、插件清单（夹具里 Grok CLI 没装，换不过去）。
      window.xingmang.listMcpServers = async () => []
      window.xingmang.listSkills = async () => []
      window.xingmang.listPlugins = async () => ({ plugins: [], marketplaces: [] })
      window.xingmang.checkProviderMcpHealth = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', supported: true, reason: null, entries: [],
      })
      window.xingmang.mutateProviderExtension = () => new Promise((resolve, reject) => {
        fail = (message) => { fail = null; reject(new Error(message)) }
      })
    })
    await page.getByTestId('nav-mcp').click()
    const mcp = page.getByTestId('page-mcp')
    const failure = mcp.getByRole('alert').filter({ hasText: 'claude-link 没能停用' })
    await mcp.getByTestId('mcp-row-claude-link').waitFor()
    // 在 Claude Code 下停用连接，没跑完就换到 Codex CLI，这时它失败了。
    await mcp.getByTestId('mcp-toggle-claude-link').getByRole('switch').click()
    await expect(mcp.getByTestId('mcp-add')).toBeDisabled()
    await mcp.getByRole('tab', { name: /^Codex CLI/ }).click()
    await mcp.getByTestId('mcp-row-codex-link').waitFor()
    await page.evaluate(() => window.failHeld('claude-link 没能停用'))
    await expect(mcp.getByTestId('mcp-add')).toBeEnabled()
    assert.equal(await failure.count(), 0)
    // 换回 Claude Code 才看到；再换走照旧清掉，回来也不再出来。
    await mcp.getByRole('tab', { name: /^Claude Code/ }).click()
    await mcp.getByTestId('mcp-row-claude-link').waitFor()
    await expect(failure).toBeVisible()
    await mcp.getByRole('tab', { name: /^Codex CLI/ }).click()
    await mcp.getByTestId('mcp-row-codex-link').waitFor()
    assert.equal(await failure.count(), 0)
    await mcp.getByRole('tab', { name: /^Claude Code/ }).click()
    await mcp.getByTestId('mcp-row-claude-link').waitFor()
    assert.equal(await failure.count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 打开软件时替客户改好了提醒设置：右下角说一次就收，卡片照常写线路和版本；离开首页再回来不再说。
// 原来那句挂在卡片中间那行，软件开着就一直在（yoyo 2026-10-25 截图）。
test('a reminder setting fixed on startup is announced once and leaves the card line alone', async () => {
  const page = await open('desktopOnly=1&hooksAutoRepaired=codex')
  try {
    const text = 'Codex 里「做完弹通知」的设置之前记着旧地址，已经自动改好了，不用管。原来的那份备份在「设置 › 备份迁移」里。'
    await waitForToast(page, text)
    const card = page.getByTestId('tool-row-codexDesktop')
    await expect(card).toContainText('v1.2.3')
    await expect(card).not.toContainText('自动改好')
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('tool-row-codexDesktop')).toContainText('v1.2.3')
    await page.waitForTimeout(300)
    await assertNoToast(page, text)
    // 窗口缩在托盘久了界面被关掉、叫出来时同一个窗口重新加载（#1411），也不再说。
    await page.reload()
    await expect(page.getByTestId('tool-row-codexDesktop')).toContainText('v1.2.3')
    await page.waitForTimeout(300)
    await assertNoToast(page, text)
    await clean(page)
  } finally { await page.close() }
})

// 只装了 Codex 桌面端、没装 Codex CLI：外接工具和技能照样在 Codex 那一格管，名字写「Codex 桌面端」、不标「未安装」；
// 删和加一样走 Codex 自己那一边（主进程直接改 config.toml）；插件那一格只说去桌面端自己的插件页里装。
test('with only the Codex desktop app, the extension pages manage Codex connections and skills and send plugins to the app', async () => {
  const page = await open('desktopOnly=1')
  try {
    await page.evaluate(() => {
      window.xingmang.listProviderExtensions = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', warnings: [],
        capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
        items: provider === 'codex' ? [{
          provider, kind: 'mcp', id: 'docs', name: 'docs', description: 'npx（2 个参数）',
          installed: true, enabled: true, scope: 'user', currentVersion: null, latestVersion: null,
          source: { kind: 'source-unknown', locator: null, reference: null },
          update: { state: 'source-unknown', reason: '', checkedAt: null },
          operations: { install: true, uninstall: true, enable: false, disable: false, update: false },
        }] : [],
      })
      window.xingmang.listMcpServers = async () => []
      window.xingmang.listSkills = async () => []
      window.xingmang.listPlugins = async () => ({ plugins: [], marketplaces: [] })
      window.xingmang.addMcpServer = async () => []
      window.xingmang.removeMcpServer = async () => []
      window.xingmang.checkProviderMcpHealth = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', supported: false, reason: null, entries: [],
      })
    })
    await page.getByTestId('nav-mcp').click()
    const mcp = page.getByTestId('page-mcp')
    const codexTab = mcp.getByRole('tab', { name: /^Codex 桌面端/ })
    await expect(codexTab).toHaveAttribute('aria-selected', 'true')
    assert.equal(await codexTab.getByText('未安装').count(), 0)
    assert.equal(await mcp.getByRole('tab', { name: /^Codex CLI/ }).count(), 0)
    await mcp.getByTestId('mcp-row-docs').waitFor()
    assert.equal(await mcp.getByTestId('mcp-tool-missing').count(), 0)
    assert.equal(await mcp.getByTestId('mcp-codex-shared').count(), 0)

    // 加：勾选框写「Codex 桌面端」能勾，没装的两家灰着；网络服务的高级设置里没有 OAuth 那两项。
    await mcp.getByTestId('mcp-add').first().click()
    const dialog = page.getByRole('dialog', { name: '自定义连接', exact: true })
    const picker = dialog.getByTestId('mcp-form-tools')
    await expect(picker.getByTestId('mcp-form-tools-codex')).toBeEnabled()
    await expect(picker.getByTestId('mcp-form-tools-codex')).toHaveText('Codex 桌面端')
    await expect(picker.getByTestId('mcp-form-tools-claude')).toBeDisabled()
    await dialog.getByRole('button', { name: '网络服务', exact: true }).click()
    await dialog.getByText('高级认证设置').click()
    await dialog.getByLabel('登录信息的名称').waitFor()
    assert.equal(await dialog.getByLabel('OAuth Client ID').count(), 0)
    await dialog.getByTestId('mcp-name').fill('github')
    await dialog.getByTestId('mcp-source').fill('https://api.example.test/mcp')
    await dialog.getByTestId('mcp-form-submit').click()
    await dialog.waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'addMcpServer').map((entry) => entry.args[0])), [
      { name: 'github', type: 'http', url: 'https://api.example.test/mcp' },
    ])

    // 删：走 removeMcpServer，不跑 CLI 那条通用的。
    await mcp.getByTestId('mcp-menu-docs').click()
    await page.getByRole('menuitem', { name: '从 Codex 桌面端 移除…', exact: true }).click()
    await page.getByTestId('mcp-delete-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'removeMcpServer'))
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'removeMcpServer').map((entry) => entry.args[0])), ['docs'])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'mutateProviderExtension')), false)

    // 技能：Codex 那一格照常能从文件夹导入。
    await page.getByTestId('nav-skills').click()
    const skills = page.getByTestId('page-skills')
    await expect(skills.getByRole('tab', { name: /^Codex 桌面端/ })).toHaveAttribute('aria-selected', 'true')
    await expect(skills.getByTestId('skills-add').first()).toBeEnabled()

    // 插件：只有一句话，不放「添加插件」「添加市场」，也不去读列表、不替他下插件目录。
    const pluginLists = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'listProviderExtensions').length)
    await page.getByTestId('nav-plugins').click()
    const plugins = page.getByTestId('page-plugins')
    await expect(plugins.getByRole('tab', { name: /^Codex 桌面端/ })).toHaveAttribute('aria-selected', 'true')
    await expect(plugins.getByTestId('plugins-codex-desktop')).toContainText('插件请在 Codex 桌面端里装')
    await expect(plugins.getByTestId('plugins-codex-desktop')).toContainText('打开 Codex 桌面端，在它自己的插件页里装、卸载或停用。')
    assert.equal(await plugins.getByTestId('plugins-add').count(), 0)
    assert.equal(await plugins.getByTestId('plugins-market-add').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'listProviderExtensions').length), pluginLists)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'ensureProviderMarketplace')), false)

    // 精选：外接工具能勾给「Codex 桌面端」。
    await page.getByTestId('nav-featured').click()
    await page.getByTestId('featured-install-github').click()
    const tools = page.getByTestId('featured-install-tools')
    await expect(tools.getByTestId('featured-install-tools-codex')).toBeEnabled()
    await expect(tools.getByTestId('featured-install-tools-codex')).toHaveText('Codex 桌面端')
    await clean(page)
  } finally { await page.close() }
})

// 外接工具的开关：Codex 没有启停命令，主进程改 config.toml 里那条的 enabled，只装了桌面端也给开关，
// 走的是通用的 mutate，不是删连接那一条；停用后那一行写「已停用」，再点打开。
test('with only the Codex desktop app, a Codex connection can be switched off and back on', async () => {
  const page = await open('desktopOnly=1')
  try {
    await page.evaluate(() => {
      let enabled = true
      window.xingmang.listProviderExtensions = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', warnings: [],
        capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
        items: provider === 'codex' ? [{
          provider, kind: 'mcp', id: 'docs', name: 'docs', description: 'npx（2 个参数）',
          installed: true, enabled, scope: 'user', currentVersion: null, latestVersion: null,
          source: { kind: 'source-unknown', locator: null, reference: null },
          update: { state: 'source-unknown', reason: '', checkedAt: null },
          operations: { install: true, uninstall: true, enable: true, disable: true, update: false },
        }] : [],
      })
      window.xingmang.mutateProviderExtension = async (input) => {
        enabled = input.action === 'enable'
        return window.xingmang.listProviderExtensions(input.provider)
      }
      window.xingmang.listMcpServers = async () => []
      window.xingmang.listSkills = async () => []
      window.xingmang.listPlugins = async () => ({ plugins: [], marketplaces: [] })
      window.xingmang.removeMcpServer = async () => []
      window.xingmang.checkProviderMcpHealth = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', supported: false, reason: null, entries: [],
      })
    })
    await page.getByTestId('nav-mcp').click()
    const mcp = page.getByTestId('page-mcp')
    const row = mcp.getByTestId('mcp-row-docs')
    await row.waitFor()
    const toggle = mcp.getByTestId('mcp-toggle-docs').getByRole('switch', { name: '停用 docs' })
    await expect(toggle).toHaveAttribute('aria-checked', 'true')

    await toggle.click()
    await waitForToast(page, '已停用「docs」')
    await expect(row.getByText('已停用', { exact: true })).toBeVisible()
    const on = mcp.getByTestId('mcp-toggle-docs').getByRole('switch', { name: '启用 docs' })
    await expect(on).toHaveAttribute('aria-checked', 'false')

    await on.click()
    await waitForToast(page, '已启用「docs」')
    await expect(row.getByText('已停用', { exact: true })).toHaveCount(0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'mutateProviderExtension').map((entry) => entry.args[0])), [
      { provider: 'codex', kind: 'mcp', action: 'disable', id: 'docs', scope: 'user' },
      { provider: 'codex', kind: 'mcp', action: 'enable', id: 'docs', scope: 'user' },
    ])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'removeMcpServer')), false)
    await clean(page)
  } finally { await page.close() }
})

// 两个都装了：Codex 那一格下面说一句它们共用这些设置。
test('with both the Codex CLI and the desktop app, the Codex tab says they share these settings', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.xingmang.listProviderExtensions = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', items: [], warnings: [],
        capabilities: { mcp: { list: true, reason: null }, skill: { list: true, reason: null }, plugin: { list: true, reason: null } },
      })
      window.xingmang.listMcpServers = async () => []
      window.xingmang.listSkills = async () => []
      window.xingmang.listPlugins = async () => ({ plugins: [], marketplaces: [] })
      window.xingmang.checkProviderMcpHealth = async (provider) => ({
        provider, checkedAt: '2026-09-22T00:00:00Z', supported: true, reason: null, entries: [],
      })
    })
    await page.getByTestId('nav-mcp').click()
    const mcp = page.getByTestId('page-mcp')
    assert.equal(await mcp.getByTestId('mcp-codex-shared').count(), 0)
    await mcp.getByRole('tab', { name: /^Codex CLI/ }).click()
    await expect(mcp.getByTestId('mcp-codex-shared')).toHaveText('Codex 桌面端和 Codex CLI 共用这些设置，在这里加的两边都能用。')
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
    // 气泡前面有一句只给读屏的「你：」，按包含来找。
    await drawer.getByText('上回问到这里').waitFor()
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
    await drawer.getByText('刚在终端里问的').waitFor()
    // 「最新 100 条」多读的那一次是点「接着聊」时先对的一下（已知4）。
    assert.deepEqual(await recordsReads(page), [list + 1, latest + 2])
    await expect(drawer.getByText('上回问到这里')).toBeVisible()
    assert.equal(await page.evaluate(() => window.__sawTranscriptLoading), false)
    await clean(page)
  } finally { await page.close() }
})

test('home shows the last usage right away instead of asking the account backend on every visit', async () => {
  const page = await open('allInstalled=1')
  const usageReads = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getAccountUsage').length)
  const usageLine = page.getByTestId('home-balance-days')
  try {
    await expect(usageLine).toContainText('约还能用')
    // 本月、最近 7 天各一次；开发模式的 StrictMode 挂载两遍也只落到这一次。
    assert.equal(await usageReads(), 2)

    // 首页离开就卸载，以前每回来一次就再查两次、那一栏先显示「正在读取用量」。
    await page.evaluate(() => {
      window.__usageBlank = false
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="home-balance-days"]')?.textContent?.includes('正在读取用量')) window.__usageBlank = true
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

// #1362 第 1 条：今天花得最多时，今天那根柱子最高，柱顶上的金额以前顶到「近 7 天花费」那一行，跟七天合计叠在一起。
// 测试数据每天花多少按星期几给，星期五最多，所以把时钟定在一个星期五：UTC 中午，哪个时区的跑机看都还是星期五
// （以前跟着真实日期走，只有星期五跑才绿）。
test('today\'s amount above the tallest bar stays clear of the 7-day total on home and the account overview', async () => {
  const page = await open('', new Date('2026-09-11T12:00:00Z'))
  async function chart(scope, head, bar) {
    return page.evaluate(([scopeSelector, headSelector, barSelector]) => {
      const root = document.querySelector(scopeSelector)
      const rect = (element) => { const { left, right, top, bottom } = element.getBoundingClientRect(); return { left, right, top, bottom } }
      const bars = [...root.querySelectorAll(barSelector)]
      return { total: rect(root.querySelector(headSelector)), amount: rect(root.querySelector('em')), bars: bars.map((element) => element.getBoundingClientRect().height), today: rect(bars.at(-1)) }
    }, [scope, head, bar])
  }
  function apart(a, b) { return a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top }
  try {
    for (const [name, scope, head, bar] of [
      ['home', '[data-testid="home-week-spend"]', '.v2-home-week-head > b', '.v2-home-week-bar > i'],
      ['account overview', '[data-testid="account-overview-week"]', '.v2-acct-week-head > b', '.v2-acct-week-track > i'],
    ]) {
      if (name === 'account overview') await page.getByTestId('sidebar-account-open').click()
      await page.locator(`${scope} em`).waitFor()
      const { total, amount, bars, today } = await chart(scope, head, bar)
      assert.equal(Math.max(...bars), bars.at(-1), `${name}: today is the tallest bar in the fixture`)
      assert.ok(apart(total, amount), `${name}: today's amount ${JSON.stringify(amount)} clears the total ${JSON.stringify(total)}`)
      assert.ok(amount.bottom <= today.top, `${name}: today's amount sits above its bar (${amount.bottom} / ${today.top})`)
    }
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
    // 已下线的 Gemini CLI 那条记录（夹具里还留着）记录页不列。
    await page.getByTestId('sessions-view-claude:1').waitFor()
    assert.equal(await page.getByTestId('sessions-view-gemini:5').count(), 0)
    // 只有能删的那家才给按钮：Codex 这条在夹具里没开删除。
    await page.getByTestId('sessions-view-codex:4').click()
    assert.equal(await page.getByTestId('session-detail-delete').count(), 0)
    await page.getByTestId('session-detail-drawer').getByRole('button', { name: '关闭' }).first().click()

    await page.getByTestId('sessions-view-claude:1').click()
    await page.getByTestId('session-detail-delete').click()
    const confirm = page.getByTestId('session-delete-confirm')
    await confirm.waitFor()
    assert.match(await confirm.textContent(), /删了就找不回来/)
    // 指的是「…」和详情里那颗「导出对话」，按钮改名后这句跟着改。
    assert.match(await confirm.textContent(), /先点「导出对话」/)
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

test('a new user opens a CLI in a folder the app creates and can still pick one from the menu (known 40)', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await recentRead(page)
    // 没有最近目录时按钮还是「打开」，悬停也不写文件夹。
    assert.equal(await page.getByTestId('tool-codex-primary').getAttribute('title'), null)
    assert.equal(await page.getByTestId('tool-codex-primary').innerText(), '打开')
    // 「⋯」里的「新建项目文件夹并打开」换成「选择其他文件夹…」：「打开」已经替人新建了。
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    assert.equal(await page.getByTestId('tool-codex-new-workspace').count(), 0)
    assert.equal(await page.getByTestId('tool-codex-choose-workspace').innerText(), '选择其他文件夹…')
    await page.keyboard.press('Escape')
    await page.getByTestId('tool-codex-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'chooseWorkspace').map((entry) => entry.args), [[{ createStarter: true, firstOpen: true }]])
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args), [['codex', starterFolder]])
    // 想用自己的文件夹：从「⋯」选，弹的是原来的选择框。
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.getByTestId('tool-row-claude').getByRole('button', { name: '更多操作' }).click()
    await page.getByTestId('tool-claude-choose-workspace').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === 2)
    const picked = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(picked.filter((entry) => entry.method === 'chooseWorkspace').map((entry) => entry.args), [[{ createStarter: true, firstOpen: true }], []])
    assert.deepEqual(picked.filter((entry) => entry.method === 'launchCli').at(-1).args, ['claude', 'C:\\Selected Project'])
    // Codex 桌面端自己管工作区，这两个入口都不给。
    await page.getByTestId('tool-row-codexDesktop').getByRole('button', { name: '更多操作' }).click()
    assert.equal(await page.getByTestId('tool-codexDesktop-new-workspace').count(), 0)
    assert.equal(await page.getByTestId('tool-codexDesktop-choose-workspace').count(), 0)
    await page.keyboard.press('Escape')
    await clean(page)
  } finally { await page.close() }
})

// 星芒卸不了的桌面端（外接客户端、Mac 上的 Codex 桌面端）以前「…」里什么都没有，客户以为是漏了。
test('desktop apps the app cannot remove explain in the card menu how to uninstall them in the system', async () => {
  const windows = await open('allInstalled=1&externalInstalled=1')
  try {
    await windows.getByTestId('tool-row-claudeDesktop').waitFor()
    await windows.getByTestId('tool-row-claudeDesktop').getByRole('button', { name: '更多操作' }).click()
    assert.equal(await windows.getByTestId('tool-claudeDesktop-uninstall-guide').innerText(), '卸载…')
    await windows.getByTestId('tool-claudeDesktop-uninstall-guide').click()
    const dialog = windows.getByTestId('uninstall-guide')
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('heading').innerText(), '怎么卸载 Claude Desktop')
    assert.deepEqual(await dialog.locator('li').allInnerTexts(), [
      '打开 Windows「设置 → 应用 → 已安装的应用」（Windows 10 上叫「应用和功能」）。',
      '找到 Claude，点右边的「…」→「卸载」（Windows 10 上先点它，再点「卸载」）。',
    ])
    await windows.getByTestId('uninstall-guide-close').click()
    await dialog.waitFor({ state: 'detached' })
    for (const id of ['opencode', 'workbuddy']) {
      await windows.getByTestId(`tool-row-${id}`).getByRole('button', { name: '更多操作' }).click()
      await windows.getByTestId(`tool-${id}-uninstall-guide`).waitFor()
      await windows.keyboard.press('Escape')
    }
    // Windows 上的 Codex 桌面端星芒自己卸，照旧是真的「卸载…」，不换成指引。
    await windows.getByTestId('tool-row-codexDesktop').getByRole('button', { name: '更多操作' }).click()
    await windows.getByTestId('tool-codexDesktop-uninstall').waitFor()
    assert.equal(await windows.getByTestId('tool-codexDesktop-uninstall-guide').count(), 0)
    await windows.keyboard.press('Escape')
    await clean(windows)
  } finally { await windows.close() }

  const mac = await open('os=mac&allInstalled=1&externalInstalled=1')
  try {
    await mac.getByTestId('tool-row-codexDesktop').waitFor()
    await mac.getByTestId('tool-row-codexDesktop').getByRole('button', { name: '更多操作' }).click()
    assert.equal(await mac.getByTestId('tool-codexDesktop-uninstall').count(), 0)
    await mac.getByTestId('tool-codexDesktop-uninstall-guide').click()
    const dialog = mac.getByTestId('uninstall-guide')
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('heading').innerText(), '怎么卸载 Codex 桌面端')
    assert.deepEqual(await dialog.locator('li').allInnerTexts(), [
      '先退出 ChatGPT（在它的窗口里按 ⌘Q）。',
      '打开访达，点左边的「应用程序」。',
      '找到 ChatGPT（Codex 桌面端在 Mac 上叫这个名字），把它拖进废纸篓。',
    ])
    await mac.getByTestId('uninstall-guide-close').click()
    await dialog.waitFor({ state: 'detached' })
    // 只是告诉客户怎么删，星芒自己什么都不卸。
    const calls = await mac.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(calls.some((method) => /uninstall/i.test(method)), false)
    await clean(mac)
  } finally { await mac.close() }
})

test('a CLI with chats older than the home list still asks for a folder on its first open (known 40)', async () => {
  const page = await open('allInstalled=1&codexOlderSessions=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await recentRead(page)
    // 首页只取最近 60 条，Codex 那两条挤不进来；整份记录里有它，就不是新手，照旧弹选择框。
    await page.getByTestId('tool-codex-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'chooseWorkspace').map((entry) => entry.args), [[]])
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args), [['codex', 'C:\\Selected Project']])
    // 没聊过的 Claude Code 照样替人新建。
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-claude-primary"]')?.disabled)
    await page.getByTestId('tool-claude-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === 2)
    const both = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(both.filter((entry) => entry.method === 'chooseWorkspace').map((entry) => entry.args), [[], [{ createStarter: true, firstOpen: true }]])
    assert.deepEqual(both.filter((entry) => entry.method === 'launchCli').at(-1).args, ['claude', starterFolder])
    await clean(page)
  } finally { await page.close() }
})

test('after the first open the button names the created folder and keeps the full dropdown (known 40)', async () => {
  const page = await open('launchRemembers=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await recentRead(page)
    await page.getByTestId('tool-codex-primary').click()
    await page.waitForFunction((folder) => document.querySelector('[data-testid="tool-claude-primary"]')?.getAttribute('title') === `在 ${folder} 打开`, starterFolder)
    await page.waitForFunction(() => !document.querySelector('[data-testid="tool-codex-primary"]')?.disabled)
    // v4：「…」最上面是选择器和新建；Codex 还没聊过，没有「接着之前的对话…」。
    await page.getByRole('button', { name: 'Codex CLI 更多操作', exact: true }).click()
    assert.deepEqual((await page.getByRole('menuitem').allInnerTexts()).slice(0, 2), ['选择其他文件夹…', '新建项目文件夹并打开'])
    await page.keyboard.press('Escape')
    await page.getByTestId('tool-claude-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === 2)
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.equal(calls.filter((entry) => entry.method === 'chooseWorkspace').length, 1)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args.slice(0, 2)), [['codex', starterFolder], ['claude', starterFolder]])
    await clean(page)
  } finally { await page.close() }
})

test('a folder picked for one CLI opens the others there without asking again', async () => {
  const page = await open('launchRemembers=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await recentRead(page)
    // 第一次点「打开」会替人新建（已知40）；自己挑文件夹从「⋯」里选。
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByTestId('tool-codex-choose-workspace').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const claude = page.getByTestId('tool-claude-primary')
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.getAttribute('title') === '在 C:\\Selected Project 打开')
    await claude.click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === 2)
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.equal(calls.filter((entry) => entry.method === 'chooseWorkspace').length, 1)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args.slice(0, 2)), [['codex', 'C:\\Selected Project'], ['claude', 'C:\\Selected Project']])
    await clean(page)
  } finally { await page.close() }
})

// 第四十批 A：托盘「已安装的工具」和 Ctrl+数字以前什么文件夹都不带，每次都弹选择框；
// 现在和首页那颗「打开 xx」挑同一个文件夹，都没有才弹。
test('the tray and Ctrl+number shortcuts open a CLI in the folder its home button shows', async () => {
  const page = await open('allInstalled=1&recentWorkspaces=1')
  const launches = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args))
  const choices = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'chooseWorkspace').length)
  async function settled(id, count) {
    await page.waitForFunction((expected) => window.v2Test.calls.filter((entry) => entry.method === 'launchCli').length === expected, count)
    await page.waitForFunction((testId) => !document.querySelector(`[data-testid="${testId}"]`)?.disabled, `tool-${id}-primary`)
  }
  try {
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.getAttribute('title') === '在 C:\\work\\my-app 打开')
    await page.evaluate(() => window.v2Test.emit('onLaunchTool', 'claude'))
    await settled('claude', 1)
    // Ctrl+2 是工具表里的第二个，Codex CLI。
    await page.keyboard.press('Control+2')
    await settled('codex', 2)
    assert.deepEqual(await launches(), [['claude', 'C:\\work\\my-app'], ['codex', 'C:\\work\\codex-app']])
    assert.equal(await choices(), 0)

    // Grok 没有记录，也没选过文件夹：照旧先问。Gemini CLI 下线以后它排第四。
    await page.keyboard.press('Control+4')
    await settled('grok', 3)
    assert.deepEqual((await launches())[2], ['grok', 'C:\\Selected Project'])
    assert.equal(await choices(), 1)
    // 这台电脑上只看得到四个工具，Ctrl+5 什么都不开。
    await page.keyboard.press('Control+5')
    await page.waitForTimeout(300)
    assert.equal((await launches()).length, 3)
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
    await page.getByTestId('tool-row-codex').waitFor()
    await recentRead(page)
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByTestId('tool-codex-choose-workspace').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.getAttribute('title') === '在 C:\\Selected Project 打开')
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
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.getAttribute('title') === '在 C:\\work\\my-app 打开')
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

// #1104 第 3 条：点「打开」以后先读配置、核对默认模型，要好几秒。这几步一开始就该挂上「打开中」，
// 不能等它们走完才挂，否则卡片一动不动，再点一下也没反应。
test('a CLI launch shows its opening state while it is still reading the configuration', async () => {
  const page = await open()
  try {
    const button = page.getByTestId('tool-codex-primary')
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-codex-primary"]')?.textContent === '打开'
      && !document.querySelector('[data-testid="tool-codex-primary"]')?.hasAttribute('disabled'))
    await page.evaluate(() => window.v2Test.holdNextConfigRead())
    const before = await page.evaluate(() => window.v2Test.calls.length)
    await button.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-codex-primary"]')?.getAttribute('aria-busy') === 'true')
    assert.equal(await button.innerText(), '打开中')
    assert.equal(await button.isDisabled(), true)
    assert.equal(await page.getByTestId('tool-claude-primary').isDisabled(), true)
    await page.getByTestId('tool-row-codex').getByText('正在打开工具', { exact: true }).waitFor()
    const preparing = await page.evaluate(start => window.v2Test.calls.slice(start).map((entry) => entry.method), before)
    assert.equal(preparing.includes('getConfig'), true)
    assert.equal(preparing.includes('chooseWorkspace'), false)
    assert.equal(preparing.includes('launchCli'), false)
    await page.evaluate(() => window.v2Test.releaseConfigRead())
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-codex-primary"]')?.getAttribute('aria-busy') !== 'true')
    assert.equal(await button.innerText(), '打开')
    const methods = await page.evaluate(start => window.v2Test.calls.slice(start).map((entry) => entry.method), before)
    assert.equal(methods.filter((method) => method === 'chooseWorkspace').length, 1)
    assert.equal(methods.filter((method) => method === 'launchCli').length, 1)
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
// #1132：四列卡片在任何窗口下都只有 235 上下宽。底栏放不下时省略左边的牌子（悬停看全文），
// 按钮上的字一个不少；官方安装器那句提示不冲出卡片；「重新检测」不配下载箭头。
test('a squeezed tool card shortens its status badge, never its button, and keeps its notes inside', async () => {
  const cases = [
    ['unownedClaude=1', 'claude', '打开', '密钥待确认'],
    ['unknownClaude=1', 'claude', '改用当前账号', '打不开'],
    ['allInstalled=1&changedClaude=1', 'claude', '重新写入密钥', '配置被改过'],
    ['nativeCodex=1&codexUpdate=1', 'codex', '打开', null],
    ['detectionFailed=1', 'claude', '重新检测', '检测失败'],
    ['emptyWallet=1', 'claude', '去充值', '余额为零'],
  ]
  for (const [query, tool, label, status] of cases) {
    const page = await open(query)
    try {
      const row = page.getByTestId(`tool-row-${tool}`)
      await row.locator('.xm-tool-card-actions > .xm-btn').filter({ hasText: label }).waitFor()
      // 默认窗口，和最小窗口自动缩到 0.9 以后的实际大小。
      for (const viewport of [{ width: 1280, height: 820 }, { width: 1067, height: 622 }]) {
        await page.setViewportSize(viewport)
        // 侧栏是 matchMedia 变了以后下一轮渲染才收起，没等到就量会量到侧栏还展开时的三列卡片（262 宽）。
        await expect.poll(() => page.locator('.v2-shell').getAttribute('class')).toBe(viewport.width < 1272 ? 'v2-shell sidebar-collapsed' : 'v2-shell')
        const layout = await row.evaluate((card) => {
          const box = (element) => element?.getBoundingClientRect() ?? null
          const button = card.querySelector('.xm-tool-card-actions > .xm-btn')
          const text = button.querySelector(':scope > span')
          const badge = card.querySelector('.xm-tool-card-badge .xm-pill > span')
          const note = card.querySelector('.v2-tool-external-note')
          return {
            card: box(card), actions: box(card.querySelector('.xm-tool-card-actions')), badge: box(card.querySelector('.xm-tool-card-badge')),
            buttonClipped: text.scrollWidth > text.clientWidth, download: Boolean(button.querySelector('.lucide-download')),
            badgeText: badge?.textContent ?? null, badgeTitle: badge?.getAttribute('title') ?? null, note: box(note),
          }
        })
        const where = `${query} at ${viewport.width}`
        assert.ok(layout.card.width < 245, `${where}: the card is ${layout.card.width}px wide`)
        assert.equal(layout.buttonClipped, false, `${where}: 「${label}」 is shown in full`)
        assert.ok(layout.badge.right <= layout.actions.left + 0.5, `${where}: the badge ends before the buttons`)
        assert.ok(layout.actions.right <= layout.card.right + 0.5, `${where}: the buttons stay inside the card`)
        if (status) assert.deepEqual([layout.badgeText, layout.badgeTitle], [status, status], `${where}: a cut badge keeps its full text on hover`)
        if (tool === 'codex') assert.ok(layout.note && layout.note.right <= layout.card.right - 13.5, `${where}: the installer note stays inside the card`)
        assert.equal(layout.download, false, `${where}: 「${label}」 carries no download arrow`)
      }
      await clean(page)
    } finally { await page.close() }
  }
})
// 主路卡点 F4：余额是 $0 时首页上面说要先充值，工具卡和大卡的主按钮也是「去充值」；「打开」照样能点。
test('an empty wallet turns the main button on the tool cards into 去充值 and keeps 打开 one click away', async () => {
  const page = await open('emptyWallet=1')
  try {
    await page.getByTestId('home-low-balance').waitFor()
    const row = page.getByTestId('tool-row-claude')
    await row.getByText('余额为零', { exact: true }).waitFor()
    assert.deepEqual(await row.locator('.xm-tool-card-actions > .xm-btn').allInnerTexts(), ['去充值'])
    // 大卡：「去充值」排第一当主按钮，「打开 Claude Code」退成旁边的次按钮。
    const hero = page.getByTestId('home-hero')
    assert.deepEqual((await hero.locator('.v2-home-hero-actions > .xm-btn').allInnerTexts()).map((text) => text.split('\n')[0]), ['去充值', '打开 Claude Code', '选择其他文件夹…'])
    assert.match(await page.getByTestId('home-hero-recharge').getAttribute('class'), /xm-btn-primary/)
    assert.match(await page.getByTestId('home-hero-open').getAttribute('class'), /xm-btn-secondary/)
    // 「打开」在「…」第一项，点了照常打开。
    await row.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
    const items = await page.locator('.xm-menu-pop [role="menuitem"]').allInnerTexts()
    assert.equal(items[0], '打开')
    await page.getByTestId('tool-claude-open').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.getByTestId('tool-claude-recharge').waitFor()
    await clean(page)
    // 卡上的「去充值」进个人中心的充值页。
    await page.getByTestId('tool-claude-recharge').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="account-tabs"] [aria-selected="true"]')?.textContent === '充值订阅')
    // 默认夹具没接充值、订单那几个读取（会记进 unexpected），这里只看有没有报错。
    assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  } finally { await page.close() }
})
// 第二十六批 D：系统给的英文原话（EPERM……）不再上屏，换成一句中文。
test('an English probe failure reads as a plain Chinese sentence on the home row', async () => {
  const page = await open('detectionFailed=eperm')
  try {
    const sentence = '没有权限读取这个工具的文件，常见是安全软件拦了。点「重新检测」再试；还不行请在「反馈与客服」页导出报告发给客服。'
    const row = page.getByTestId('tool-row-claude')
    await row.getByText(sentence, { exact: true }).waitFor()
    assert.doesNotMatch(await row.innerText(), /EPERM|operation not permitted/)
    await clean(page)
  } finally { await page.close() }
})
// 「安装卸载」页拆掉以后，「重新安装」在首页工具卡片的「…」里（第 10 批，问 2）。
test('the home 重新安装 does not reinstall over a CLI from an official installer the app cannot replace', async () => {
  const page = await open('nativeCodex=1&nativeInstall=1')
  try {
    // 官方安装器装的 Codex CLI 星芒换不了：菜单里不给「重新安装」。
    await page.getByRole('button', { name: 'Codex CLI 更多操作', exact: true }).click()
    await page.getByTestId('tool-codex-configure').waitFor()
    assert.equal(await page.getByTestId('tool-codex-reinstall').count(), 0)
    await page.keyboard.press('Escape')
    // 官方安装器装的 Claude Code 星芒卸得掉：「重新安装」照常给，点了先问一句（第三十一批 B）。
    await page.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
    await page.getByTestId('tool-claude-reinstall').click()
    const dialog = page.getByTestId('managed-switch-confirm')
    await dialog.getByText('换成星芒装的 Claude Code？', { exact: true }).waitFor()
    assert.match(await dialog.innerText(), /再装上 1\.2\.3。/)
    // 点「取消」什么都不动，卡片上也不冒出一句「正在安装」。
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.getByTestId('tool-claude-cancel').waitFor({ state: 'detached' })
    const switched = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli' || entry.method === 'installCli'))
    assert.deepEqual(await switched(), [])
    assert.doesNotMatch(await page.getByTestId('tool-row-claude').innerText(), /正在安装|安装完成/)
    // 「重新安装」不点名版本：框里写的 1.2.3 必须原样交给主进程，而不是由主进程另挑一版。
    await page.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
    await page.getByTestId('tool-claude-reinstall').click()
    await dialog.getByRole('button', { name: '换成星芒装的', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
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
    const update = row.getByTestId('tool-claude-update')
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
    await row.getByText('更新到 v2.0.0 · 正在卸载', { exact: true }).waitFor()
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
  await row.getByTestId('tool-claude-update').waitFor()
  if (hold) await page.evaluate(() => window.v2Test.holdNextUninstall())
  await row.getByTestId('tool-claude-update').click()
  await page.getByTestId('managed-switch-confirm').getByRole('button', { name: '换成星芒装的', exact: true }).click()
  const switched = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli' || entry.method === 'installCli'))
  return { row, switched }
}
test('the uninstall step of a switch to the app cannot be cancelled, and asking again while it runs does not ask twice', async () => {
  const page = await open('cliUpdate=1&nativeInstall=1')
  try {
    const { row, switched } = await startManagedSwitch(page, { hold: true })
    await row.getByText('更新到 v2.0.0 · 正在卸载', { exact: true }).waitFor()
    // 卸到一半停不下来：说清楚，而不是假装取消了。
    await row.getByTestId('tool-claude-cancel').click()
    await waitForToast(page, '这一步已经不能取消了。')
    // 换装还在跑时卡片上没有「…」：「重新安装」点不到，也就不会再问一遍「先把它卸掉」。
    assert.equal(await row.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).count(), 0)
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
    assert.equal(await row.getByTestId('tool-claude-update').count(), 0)
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
// 已知48「帮我清理」：主进程按卸载时记下的文件去删，删不掉就留着框说还剩几个。
test('the leftover dialog cleans up through the main process and says what is still left', async () => {
  const page = await open('cliUpdate=1&nativeInstall=1&uninstallLeftovers=1')
  try {
    await startManagedSwitch(page)
    const dialog = page.getByRole('dialog', { name: 'Claude Code 还有文件没删干净', exact: true })
    await dialog.getByText('点「帮我清理」，星芒再核对一遍就替你删掉；也可以复制下面的命令，在普通 PowerShell里自己执行。', { exact: true }).waitFor()
    await dialog.getByTestId('manual-uninstall-cleanup').click()
    // 第一次那个文件还被占着：框留着，红字说还剩几个、接下来怎么办。
    await expect(dialog.getByTestId('manual-uninstall-cleanup-problem'))
      .toHaveText('还有 1 个文件没删掉。关掉所有 Claude Code 窗口后再点一次「帮我清理」；还是不行，请联系客服。')
    await dialog.getByTestId('manual-uninstall-cleanup').click()
    await waitForToast(page, '清理好了。')
    await dialog.waitFor({ state: 'detached' })
    // 界面只说是哪个工具，删哪几个文件由主进程自己定。
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'cleanUninstallLeftovers')), [
      { method: 'cleanUninstallLeftovers', args: ['claude'] },
      { method: 'cleanUninstallLeftovers', args: ['claude'] },
    ])
    await clean(page)
  } finally { await page.close() }
})
// 「安装卸载」页拆掉以后卸载只在首页工具卡片的「…」里（第 10 批）。
test('the leftover dialog after a home uninstall cleans up the same way', async () => {
  const page = await open('allInstalled=1&uninstallLeftovers=1')
  try {
    await page.getByRole('button', { name: 'Claude Code 更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '卸载…', exact: true }).click()
    await page.getByRole('dialog', { name: '卸载 Claude Code？', exact: true }).getByRole('button', { name: '卸载 Claude Code', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Claude Code 还有文件没删干净', exact: true })
    await dialog.getByTestId('manual-uninstall-cleanup').click()
    await expect(dialog.getByTestId('manual-uninstall-cleanup-problem')).toContainText('还有 1 个文件没删掉。')
    await dialog.getByTestId('manual-uninstall-cleanup').click()
    await waitForToast(page, '清理好了。')
    await dialog.waitFor({ state: 'detached' })
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
    assert.equal(await row.getByTestId('tool-claude-update').count(), 0)
    await clean(handOff)
  } finally { await handOff.close() }
  // 确认框开着时断了网：点「换成星芒装的」也先不卸，免得卸完装不回来。
  const page = await open('cliUpdate=1&nativeInstall=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByTestId('tool-claude-update').click()
    const dialog = page.getByTestId('managed-switch-confirm')
    await dialog.getByText('换成星芒装的 Claude Code？', { exact: true }).waitFor()
    await page.context().setOffline(true)
    await page.getByTestId('offline-banner').waitFor()
    await dialog.getByRole('button', { name: '换成星芒装的', exact: true }).click()
    await waitForToast(page, '现在没网，等网络恢复后再试。')
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli' || entry.method === 'installCli')), [])
    await row.getByTestId('tool-claude-update').waitFor()
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
test('a failed probe offers a rescan on the home card instead of an install', async () => {
  const page = await open('detectionFailed=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByText('检测失败', { exact: true }).waitFor()
    await row.getByRole('button', { name: '重新检测', exact: true }).waitFor()
    assert.equal(await row.getByRole('button', { name: '安装', exact: true }).count(), 0)
    // A4：原因原样上屏。
    await row.getByText('本地探针暂时不可用', { exact: false }).waitFor()
    await clean(page)
  } finally { await page.close() }
})
// 运行环境那几行原来只要没有版本号就写「尚未安装」，探针自己抛错时也照写。「安装卸载」页拆掉以后看首页运行环境卡。
test('a failed runtime probe on the home runtime card says so instead of 未安装', async () => {
  const page = await open('runtimeDetectionFailed=1')
  try {
    const row = page.getByTestId('home-runtime-row-node')
    await row.getByText('检测失败', { exact: true }).waitFor()
    assert.equal(await row.getByText('未安装', { exact: true }).count(), 0)
    assert.equal(await page.getByTestId('home-runtime-node').count(), 0)
    await page.getByTestId('home-runtime-rescan').waitFor()
    // Python 这一行探到了，照常显示版本。
    assert.match(await page.getByTestId('home-runtime-row-python').innerText(), /3\.12\.0/)
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
// 不再写「Python（可选）」、不再给安装按钮。
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
    await expect(row).toContainText('Python（可选）')
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
    const dialog = page.getByRole('dialog', { name: '自定义连接', exact: true })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByTestId('nav-home').click()
    await expect(row).toContainText('3.13.7')
    assert.equal(await page.getByTestId('home-runtime-python').count(), 0)
    await clean(page)
  } finally { await page.close() }
})
// 第 40、43 条：正在装的那张卡写白话进度，有百分比时底下一道进度条；「取消」点了写「正在停止」。
// 「安装卸载」页第 10 批拆掉了，原来那一行的写法挪到首页工具卡片上验；程序原话照旧只进运行日志。
test('the home card being installed shows plain progress, a bar once there is a percent, and stops on cancel', async () => {
  const page = await open()
  try {
    const row = page.getByTestId('tool-row-grok')
    await row.getByText('未安装').waitFor()
    await page.evaluate(() => window.v2Test.holdNextInstall())
    await page.getByTestId('tool-grok-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    await page.evaluate(() => window.v2Test.emit('onInstallProgress', { provider: 'grok', state: 'output', stage: 'download', message: 'npm 官方源：正在下载 @xai-official/grok' }))
    await expect(row.locator('.xm-tool-card-text')).toHaveText('正在下载，第一次可能要几分钟，请别关窗口…')
    assert.equal(await row.locator('.xm-tool-card-progress').count(), 0)
    await page.evaluate(() => window.v2Test.emit('onInstallProgress', { provider: 'grok', state: 'output', stage: 'download', message: '已下载 38%', percent: 38 }))
    await expect(row.locator('.xm-tool-card-progress')).toContainText('38%')
    await row.getByTestId('tool-grok-cancel').click()
    await expect(row.getByTestId('tool-grok-cancel')).toHaveText('正在停止')
    await page.evaluate(() => window.v2Test.releaseInstall('安装已取消'))
    await row.getByTestId('tool-grok-cancel').waitFor({ state: 'detached' })
    await row.getByText('未安装').waitFor()
    assert.equal(await row.locator('.xm-tool-card-progress').count(), 0)
    await clean(page)
  } finally { await page.close() }
})
// #1097：装到一半退出登录，主进程那边照样装完。欢迎页不能被换成未登录的首页；再登录回来，
// 那张卡不能还停在「正在安装」、按钮全灰。
test('an install that finishes while signed out keeps the welcome page and leaves nothing installing', async () => {
  const page = await open()
  try {
    const row = page.getByTestId('tool-row-grok')
    await row.getByText('未安装').waitFor()
    await page.evaluate(() => window.v2Test.holdNextInstall())
    await page.getByTestId('tool-grok-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    await row.getByTestId('tool-grok-cancel').waitFor()
    await page.getByTestId('sidebar-account-open').click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出登录？', exact: true }).getByRole('button', { name: '退出', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    const scansBefore = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'scanSystem').length)
    await page.evaluate(() => window.v2Test.releaseInstall())
    // 装完那一轮最后才重新检测：等到它，要同步 Key 的话早就同步过了。
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'scanSystem').length > count, scansBefore)
    // 装完不替退出的那个账号同步 Key：那一轮只会被「账号已变化」拦下，还会把欢迎页换成未登录的首页。
    await expect(page.getByTestId('welcome-login')).toBeVisible()
    const writesBefore = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length)
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await row.getByTestId('tool-grok-source').waitFor()
    // 再登录那一轮把装好的 Grok 一起配上。
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length > count, writesBefore)
    assert.ok((await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').at(-1).args[0].providers)).includes('grok'))
    assert.equal(await row.getByText(/正在安装/).count(), 0)
    assert.equal(await row.getByTestId('tool-grok-cancel').count(), 0)
    await expect(page.getByTestId('tool-grok-primary')).toBeEnabled()
    await clean(page)
  } finally { await page.close() }
})
// 第 44 条：「安装指南」落到装它的那一章，不再是教程第一章。第 10 批起这颗按钮在检查页 Node.js 那一行。
test('the runtime install guide on the check page opens the chapter that installs it', async () => {
  for (const [query, chapter] of [['desktopOnly=1&runtimeExternal=1&os=mac', 'Mac 上准备 Node.js 和 Python'], ['desktopOnly=1&runtimeExternal=1', '进阶：安装与使用命令行工具']]) {
    const page = await open(query)
    try {
      await stubHealthReport(page, [{ code: 'RUNTIME_NODE', title: 'Node.js', state: 'fail', summary: '还没装 Node.js', details: { installed: false } }])
      await page.getByTestId('nav-health').click()
      const guide = page.getByTestId('maintenance-runtime-action-node')
      await expect(guide).toHaveText('安装指南')
      await guide.click()
      await expect(page.locator('#tutorial-article-title')).toHaveText(chapter)
      await clean(page)
    } finally { await page.close() }
  }
})
test('uninstall is hidden when native status cannot safely remove the tool', async () => {
  const page = await open('uninstallUnavailable=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByRole('button', { name: '更多操作' }).click()
    assert.equal(await page.getByRole('menuitem', { name: '卸载…', exact: true }).count(), 0)
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
    await connectedBadge(page, 'claude').waitFor()
    await connectedBadge(page, 'codexDesktop').waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('restored login repairs missing tool configs without overwriting official or third-party sources', async () => {
  const page = await open('missingConfig=1&allInstalled=1&official=1&unknownClaude=1')
  try {
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    const input = await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'configureManagedCliKeys').args[0])
    // 已下线的 Gemini CLI 装着、配置也缺，同样不替它写。
    assert.deepEqual(input.providers, ['grok'])
    await page.getByTestId('tool-row-claude').getByText('打不开', { exact: true }).waitFor()
    await page.getByTestId('tool-row-codex').getByText('官方账号', { exact: true }).waitFor()
    await connectedBadge(page, 'grok').waitFor()
    assert.equal(await page.getByTestId('tool-row-gemini').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length), 1)
    await clean(page)
  } finally { await page.close() }
})

test('restored login preserves a marked manual relay key and displays its source', async () => {
  const page = await open('missingConfig=1&allInstalled=1&manualClaude=1')
  try {
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    const input = await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'configureManagedCliKeys').args[0])
    assert.deepEqual(input.providers, ['codex', 'grok'])
    await page.getByTestId('tool-row-claude').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置…', exact: true }).click()
    assert.equal(await page.getByTestId('tool-manual-key').getAttribute('aria-checked'), 'true')
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

const matchedToolIds = ['claude', 'codex', 'codexDesktop', 'grok']
// v4 首页：配好的命令行工具卡片左下角是来源牌（当前账号 / 自己的密钥），不再写「已配好」。
function connectedBadge(scope, id) {
  return scope.getByTestId(`tool-${id}-source`).filter({ hasText: /^(当前账号|自己的密钥)$/ })
}
async function matchedToolBadges(page, label) {
  for (const id of matchedToolIds) await (label === '已配好' ? connectedBadge(page, id) : page.getByTestId(`tool-row-${id}`).getByText(label, { exact: true })).waitFor()
}
async function settleMatchedBootstrap(page) {
  await page.waitForFunction(() => window.v2Test.calls.filter(entry => entry.method === 'getConfig').length >= 4)
  await page.waitForFunction(() => !document.querySelector('[data-testid="home-bootstrap-progress"]') && document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') !== 'true')
}
async function assertNoMatchedKeyOperations(page, from = 0) {
  const calls = await page.evaluate(start => window.v2Test.calls.slice(start).map(entry => entry.method), from)
  assert.equal(calls.some(method => ['configureManagedCliKeys', 'saveConfig', 'saveConfigWithAccountKey', 'switchToOfficialAccount', 'revealApiKey', 'revealAccountKey', 'getAccountKeys', 'getAccountKeyOptions', 'listModels', 'listAccountKeyModels', 'listConfiguredModels'].includes(method)), false)
}

test('read-only account matches restore all four tool badges without key requests or writes and keep detection read-only', async () => {
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
    await page.screenshot({ path: path.join(artifacts, 'readonly-account-match-four-tools.png') })
    await clean(page)
  } finally { await page.close() }
})

test('read-only account matches respect local manual markers and preserve incomplete models without automatic repair', async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1&matchedManualMarker=claude&matchedMissingModel=grok')
  try {
    await connectedBadge(page, 'claude').waitFor()
    await page.getByTestId('tool-row-grok').getByText('待连接', { exact: true }).waitFor()
    for (const id of ['codex', 'codexDesktop']) await connectedBadge(page, id).waitFor()
    await settleMatchedBootstrap(page)
    await assertNoMatchedKeyOperations(page)
    assert.equal((await page.evaluate(() => window.xingmang.getConfig())).providers.grok.model, '')
    await page.getByTestId('tool-row-claude').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置…', exact: true }).click()
    assert.equal(await page.getByTestId('tool-manual-key').getAttribute('aria-checked'), 'true')
    await clean(page)
  } finally { await page.close() }
})

test('read-only account matches remain third-party when the host cannot match an account', async () => {
  const page = await open('readOnlyAccountMatch=1&allInstalled=1&matchedUnavailable=1')
  try {
    await matchedToolBadges(page, '密钥待确认')
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
    await matchedToolBadges(page, '密钥待确认')
    await page.evaluate(async () => {
      window.v2Test.releaseConfigRead()
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
    await matchedToolBadges(page, '密钥待确认')
    for (const id of matchedToolIds) assert.equal(await connectedBadge(page, id).count(), 0)
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
    await assertNoMatchedKeyOperations(page)
    // 退出登录在账号概览上：一进个人中心，「密钥与设备」那张卡会读一次密钥列表数把数。那是用户点开个人中心读的，
    // 不是配对去取 Key，所以从退出以后再接着查。
    await page.getByTestId('sidebar-account-open').click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    await page.getByRole('dialog', { name: '退出登录？', exact: true }).getByRole('button', { name: '退出', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    const loggedOut = await page.evaluate(() => window.v2Test.calls.length)
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
    await assertNoMatchedKeyOperations(page, loggedOut)
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
    await row.getByText('配置被别的程序改过，没在用当前账号的密钥', { exact: true }).waitFor()
    // 开机那轮自动同步不许碰它：提示归提示，改写要等用户点。
    const before = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'configureManagedCliKeys').map(entry => entry.args[0]))
    assert.ok(before.every(input => !input.providers.includes('claude')))
    await page.getByTestId('tool-claude-rewrite-key').click()
    await page.waitForFunction(() => window.v2Test.calls.some(entry => entry.method === 'configureManagedCliKeys'
      && entry.args[0].providers.includes('claude') && entry.args[0].intent === 'explicit'))
    await connectedBadge(page, 'claude').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 开机账号恢复超过启动画面的等待上限：先进首页，这期间一行都不许说「配置被改过」；
// 恢复成功只补读一次配置，不整页重来、不再扫描一遍。
test('a slow startup restore opens the home page first and settles ownership after one config re-read', async () => {
  const page = await open('allInstalled=1&changedClaude=1&restoring=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await connectedBadge(page, 'claude').waitFor()
    await page.getByText('正在恢复登录').first().waitFor()
    assert.equal(await page.getByText('配置被改过').count(), 0)
    assert.equal(await page.getByText('别处的配置', { exact: true }).count(), 0)
    assert.equal(await page.getByText('打不开', { exact: true }).count(), 0)
    assert.equal(await page.getByText('密钥待确认', { exact: true }).count(), 0)
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
    await connectedBadge(page, 'claude').waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: false, account: null, restoring: { account: { siteId: 'solov', userId: 17 }, retrying: true } }))
    await page.getByText('暂时连不上，登录还在').first().waitFor()
    assert.equal(await page.getByTestId('welcome-login').count(), 0)
    assert.equal(await page.getByText('当前登录已结束').count(), 0)
    assert.equal(await page.getByText('配置被改过').count(), 0)
    await page.getByTestId('nav-chat').click()
    await waitForToast(page, '暂时连不上服务，登录还在，连上后会自动恢复，不用重新登录。')
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
    await connectedBadge(page, 'claude').waitFor()
    assert.equal(await page.getByText('配置被改过').count(), 0)
    assert.equal(await page.getByTestId('tool-claude-rewrite-key').count(), 0)
    await page.evaluate(() => window.v2Test.releaseScan())
    await row.getByText('配置被改过').waitFor()
    assert.equal(await page.getByTestId('home-cached-scan').count(), 0)
    await connectedBadge(page, 'grok').waitFor()
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
    // Claude Code 没聊过、也没选过文件夹：第一次点「打开」替人建项目文件夹（已知40）。
    await recentRead(page)
    await page.getByTestId('tool-claude-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    const calls = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(calls.filter((entry) => entry.method === 'launchCli').map((entry) => entry.args), [['claude', starterFolder]])
    assert.equal(await page.getByTestId('home-cached-scan').count(), 1, '检测还没跑完就已经打开了')
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.getByTestId('home-cached-scan').waitFor({ state: 'detached' })
    await connectedBadge(page, 'grok').waitFor()
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
  const page = await open('allInstalled=1&cachedScan=1&restoreDirectRoute=1&mergeRoute=1')
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
  // 开机这一轮账号要写一次 Key：以前是已下线的 Gemini CLI 补写配置，现在让 Grok 的 Key 换了分组。
  const page = await open('allInstalled=1&cachedScan=1&launchRemembers=1&regrouped=grok')
  try {
    await page.getByTestId('home-cached-scan').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.disabled === false)
    // 第一次点「打开」会替人新建（已知40）；自己挑文件夹从「⋯」里选。
    await recentRead(page)
    await page.getByTestId('tool-row-claude').getByRole('button', { name: '更多操作' }).click()
    await page.getByTestId('tool-claude-choose-workspace').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.getAttribute('title') === '在 C:\\Selected Project 打开')
    // 账号这一轮写完 Key 也会重读一次配置，先按住它，看的是检测落地这一下本身。
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    await page.evaluate(() => window.v2Test.releaseScan())
    await page.getByTestId('home-cached-scan').waitFor({ state: 'detached' })
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.getAttribute('title') === '在 C:\\Selected Project 打开')
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys' && entry.args[0].providers.includes('grok')))
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
    await page.getByRole('menuitem', { name: '就用现在这份配置', exact: true }).click()
    await connectedBadge(page, 'claude').waitFor()
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
    await page.getByTestId('tool-row-claude').getByText('待连接', { exact: true }).waitFor()
    await connectedBadge(page, 'codex').waitFor()
    await page.getByRole('button', { name: '重新同步' }).click()
    await connectedBadge(page, 'claude').waitFor()
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
    await guide.getByText('正在同步账号专属密钥').waitFor()
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

// 主进程登录完要把手上的事忙完才发「会话变了」，常常晚于界面开跑的那一轮登录同步；说的还是
// 同一个账号，那一轮不能作废，否则引导页一直停在「正在同步账号专属密钥」、按钮全灰。
test('the session event that trails a login keeps the login Key sync and unlocks the guide', async () => {
  const page = await open('guest=1&bootstrapPending=1')
  try {
    await page.getByTestId('welcome-login').click()
    await page.getByTestId('login-account').fill('fixture-user')
    await page.getByTestId('login-password').fill('fixture-password')
    await page.getByTestId('auth-agree').check()
    await page.getByTestId('login-submit').click()
    await page.getByTestId('start-guide').getByText('正在同步账号专属密钥').waitFor()
    await page.evaluate(async () => window.v2Test.emit('onAccountSessionChanged', await window.xingmang.getAccountSession()))
    await page.evaluate(() => window.v2Test.releaseBootstrap())
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
    await page.waitForFunction(() => document.querySelector('[data-testid="start-guide"]')?.getAttribute('data-busy') === 'false')
    await page.getByTestId('guide-pause').click()
    await page.getByRole('button', { name: /^个人中心：fixture-user(，|$)/ }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('installing a new CLI while signed in writes only that provider Key', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length)
    await page.getByTestId('tool-grok-primary').click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length > count, before)
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys'))
    assert.deepEqual(calls.at(-1).args[0].providers, ['grok'])
    await connectedBadge(page, 'grok').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 已知12：「已完成 N 组工具的 Key 配置。」只是说一声做完了：照右下角提示条的读完时长摆着，到点自己收起，换页回来
// 也不再冒出来。以前登录后整场挂着，装完一个工具又换成「已完成 1 组…」。
test('the all-done key line on home goes away by itself after the toast reading time (已知12)', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.getByTestId('tool-grok-primary').click()
    const done = page.getByTestId('home-bootstrap-done').filter({ hasText: '已给 Grok CLI 配好密钥，可以直接用了' })
    await done.waitFor()
    // 19 个字：2400 + 7 × 200 毫秒。
    await done.waitFor({ state: 'detached', timeout: 10_000 })
    await page.getByTestId('nav-sessions').click()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
    await page.waitForTimeout(100)
    assert.equal(await page.locator('[data-testid^="home-bootstrap-"]').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('an updated tool row stays on the running install until the rescan lands', async () => {
  const page = await open('cliUpdate=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    const update = row.getByTestId('tool-claude-update')
    await update.waitFor()
    // 重现用户看到的那一段：安装命令已经返回，同步 Key 和重新检测还在跑。
    await page.evaluate(() => window.v2Test.holdNextScan())
    await update.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    await row.getByText('安装完成，正在同步账号密钥并刷新状态').waitFor()
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
    const update = row.getByTestId('tool-claude-update')
    await update.waitFor()
    await page.evaluate(() => window.v2Test.holdNextScan())
    await update.click()
    await row.getByText('安装完成，正在同步账号密钥并刷新状态').waitFor()
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
test('saved-account switching leaves tools without an account key untouched', async () => {
  const page = await open('savedAccount=1')
  try {
    await page.getByTestId('tool-row-claude').waitFor()
    const switcher = await openAccountSwitcher(page)
    await switcher.getByTestId('saved-account-row-saved-18').getByText('星芒账号', { exact: true }).waitFor()
    await switcher.getByTestId('saved-accounts-list').getByRole('button', { name: '切换', exact: true }).click()
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
    const switcher = await openAccountSwitcher(page)
    const saved = switcher.getByTestId('saved-accounts-list')
    // 原本就在用账号密钥的工具默认勾上；这里取消一个，确认只写勾着的。
    await switcher.getByTestId('account-sync-grok').waitFor()
    assert.equal(await switcher.getByTestId('account-sync-claude').isChecked(), true)
    assert.equal(await switcher.getByTestId('account-sync-codex').isChecked(), true)
    // 已下线的 Gemini CLI 也是账号密钥，但不给勾。
    assert.equal(await switcher.getByTestId('account-sync-gemini').count(), 0)
    await switcher.getByTestId('account-sync-grok').uncheck()
    await saved.getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('button', { name: /^个人中心：saved-user(，|$)/ }).waitFor()
    const writes = await page.evaluate(() => window.v2Test.calls.filter(entry => entry.method === 'configureManagedCliKeys').map(entry => entry.args[0]))
    assert.deepEqual(writes, [
      { providers: ['claude'], preferredModels: { claude: 'fixture-model' }, intent: 'explicit' },
      { providers: ['codex'], preferredModels: { codex: 'fixture-model' }, intent: 'explicit' },
    ])
    await page.getByTestId('nav-home').click()
    for (const tool of ['claude', 'codex', 'codexDesktop']) await connectedBadge(page, tool).waitFor()
    // 没勾的那个还是上一个账号的 Key：能用，但要提醒用量可能算到别的账号上（方案盘查第 10 条）。
    for (const tool of ['grok']) await page.getByTestId(`tool-row-${tool}`).getByText('密钥待确认', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some(entry => ['saveConfig', 'saveConfigWithAccountKey', 'revealApiKey', 'revealAccountKey'].includes(entry.method))), false)
    await clean(page)
  } finally { await page.close() }
})

test('tools switched to a saved account open right away instead of waiting for a key sync that never runs', async () => {
  const page = await open('savedAccount=1&readOnlyAccountMatch=1&allInstalled=1')
  try {
    await matchedToolBadges(page, '已配好')
    await settleMatchedBootstrap(page)
    const switcher = await openAccountSwitcher(page)
    await switcher.getByTestId('account-sync-grok').waitFor()
    await switcher.getByTestId('saved-accounts-list').getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('button', { name: /^个人中心：saved-user(，|$)/ }).waitFor()
    await expect(page.locator('dialog[open]')).toHaveCount(0)
    await page.getByTestId('nav-home').click()
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
    const switcher = await openAccountSwitcher(page)
    const saved = switcher.getByTestId('saved-accounts-list')
    await switcher.getByTestId('account-sync-grok').waitFor()
    await switcher.getByTestId('account-sync-grok').uncheck()
    await saved.getByRole('button', { name: '切换', exact: true }).click()
    // 有工具还开着时切换框不自己关掉，提示和按钮要让用户看得到。
    await switcher.getByTestId('account-sync-restart-hint')
      .getByText('Claude Code、Codex CLI、Codex 桌面端 还开着，要关掉重开才会用上当前账号。', { exact: true }).waitFor()
    const asked = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'inspectRunningTools').map((entry) => entry.args[0]))
    assert.deepEqual(asked, [['claude', 'codex']])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop')), false, '不点就不许重开桌面端')
    await switcher.getByTestId('account-sync-restart-codex-desktop').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCodexDesktop'))
    const launches = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'launchCodexDesktop').map((entry) => entry.args[0]))
    assert.deepEqual(launches, ['restart'])
    await switcher.getByTestId('account-sync-restart-hint')
      .getByText('Claude Code、Codex CLI 还开着，要关掉重开才会用上当前账号。', { exact: true }).waitFor()
    assert.equal(await switcher.getByTestId('account-sync-restart-codex-desktop').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('switching Codex account source offers to restart an open Codex desktop and does nothing until asked', async () => {
  const page = await open('runningTools=1&allInstalled=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.waitFor()
    await row.getByRole('button', { name: 'Codex CLI 更多操作', exact: true }).click()
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
    await page.getByTestId('start-guide').getByText('已装好', { exact: true }).waitFor()
    await expect(page.getByTestId('guide-next')).toBeEnabled()
    assert.equal(await page.getByTestId('guide-install').count(), 0)
    await page.getByTestId('guide-next').click()
    // v4：没登录时第 3 步是一张「登录后自动连接」卡，不再写「尚未选择连接方式」。
    await page.getByTestId('start-guide').getByText('登录后自动连接', { exact: true }).waitFor()
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
    await page.getByTestId('tool-row-codexDesktop').getByText('fixture-model · v9.9.9').waitFor()
    // Gemini CLI 下线后少了它那一行。
    assert.equal(await page.locator('[data-testid^="tool-row-"]').count(), 7)
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
    // v4 侧栏右边那条线画在侧栏里面（内阴影），收起后整条 60 宽都是侧栏。
    assert.equal(await page.locator('.v2-sidebar').evaluate((element) => element.clientWidth), 60)
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

// 窗口缩到托盘久了界面被关掉，叫出来时重新加载（electron/renderer-release.ts）：开机那几句、开机检查、检查更新
// 这次运行里已经做过，不再来一遍；回到关之前停的那一页；准备好了才告诉主进程，存着的跳页这时才发过来。
test('a renderer reloaded after the tray released it skips the startup round and returns to the page it was on', async () => {
  const page = await open('startupUpdate=1&diagnostics=1&rendererRestored=1', false, () => {
    sessionStorage.setItem('xingmang-v2-release-page', JSON.stringify({ page: 'settings', section: 'about' }))
  })
  try {
    await page.getByTestId('page-settings').waitFor()
    // 登录恢复那一轮密钥同步在跑时先说「有事」，跑完再说「没事」。
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'reportWindowActivity').at(-1)?.args[0])).toEqual({ busy: false })
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'runDiagnostics' || entry.method === 'runStartupUpdate')), false)
    assert.equal(await page.getByTestId('startup-notice-update').count(), 0)
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('xingmang-v2-release-page'))), { page: 'settings', section: 'about' })
    await clean(page)
  } finally { await page.close() }
})

test('the renderer remembers its page for a reload and tells the host it is busy while a dialog is open', async () => {
  const page = await open()
  try {
    await page.getByTestId('page-home').waitFor()
    const latestReport = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'reportWindowActivity').at(-1)?.args[0].busy)
    await expect.poll(latestReport).toBe(false)
    await page.getByTestId('nav-tutorial').click()
    await page.getByTestId('page-tutorial').waitFor()
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('xingmang-v2-release-page') ?? 'null'))).toEqual({ page: 'tutorial' })
    await page.getByTestId('shell-topbar').getByRole('button', { name: '帮助与客服', exact: true }).click()
    const help = page.getByRole('dialog', { name: '帮助与客服', exact: true })
    await help.waitFor()
    // 对话框一打开就报「有事」，不等窗口藏起来那一声（托盘里不一定有）：里面的东西关了就没了，这时不能关。
    await expect.poll(latestReport).toBe(true)
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await expect.poll(latestReport).toBe(false)
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

// 主路卡点 F11：第一次登录时引导、导览本身就占着一屏，错误报告那张卡再挤上来还盖住工具卡的按钮。
// 引导、导览开着时它先等着，都关了再出；告知的内容和缺省开关不变。
async function signInFromWelcome(page) {
  await page.getByTestId('welcome-login').click()
  await page.getByTestId('login-account').fill('fixture-user')
  await page.getByTestId('login-password').fill('fixture-password')
  await page.getByTestId('auth-agree').check()
  await page.getByTestId('login-submit').click()
  const guide = page.getByTestId('start-guide')
  await guide.waitFor()
  // 登录后那几件只做一次的事都跑过了，卡片要出早就该出了。
  await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys'))
  return guide
}

test('the crash reporting notice waits for the onboarding guide to close (F11)', async () => {
  const page = await open('crashNotice=1&guest=1')
  try {
    const guide = await signInFromWelcome(page)
    assert.equal(await page.getByTestId('startup-notice-crash-reporting').count(), 0)
    await page.getByTestId('guide-pause').click()
    await guide.waitFor({ state: 'detached' })
    await page.getByTestId('startup-notice-crash-reporting').waitFor()
    // 只是晚出，没替客户选：什么都没点之前不写设置。
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'saveSettings' && 'crashReportingNoticeShown' in entry.args[0])), false)
    await clean(page)
  } finally { await page.close() }
})

test('the crash reporting notice also waits for the interface tour that follows the guide (F11)', async () => {
  const page = await open('crashNotice=1&guest=1')
  try {
    const guide = await signInFromWelcome(page)
    await page.getByTestId('guide-route-chat').check()
    for (let turn = 0; turn < 4 && await guide.getAttribute('data-guide-step') !== 'ready'; turn++) {
      const step = await guide.getAttribute('data-guide-step')
      await page.getByTestId('guide-next').click()
      await page.waitForFunction((previous) => document.querySelector('[data-testid="start-guide"]')?.getAttribute('data-guide-step') !== previous, step)
    }
    await page.getByTestId('guide-home').click()
    await guide.waitFor({ state: 'detached' })
    const tour = page.getByTestId('shell-guide-tip')
    await tour.waitFor()
    assert.equal(await page.getByTestId('startup-notice-crash-reporting').count(), 0)
    for (const label of ['下一步', '下一步', '知道了']) await tour.getByRole('button', { name: label, exact: true }).click()
    await tour.waitFor({ state: 'detached' })
    await page.getByTestId('startup-notice-crash-reporting').waitFor()
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

// v4 第 8 批：线路从下拉框换成一排三个按钮，按下的那颗 aria-pressed；「现在重开」先问一句再重开。
const routeChoiceLabels = { auto: '自动（推荐）', primary: '只用线路1', direct: '只用线路2' }

function routeChoice(route, value) {
  return route.getByRole('button', { name: routeChoiceLabels[value], exact: true })
}

async function chooseRoute(route, value) {
  await routeChoice(route, value).click()
}

async function expectRoute(route, value) {
  await expect(routeChoice(route, value)).toHaveAttribute('aria-pressed', 'true')
}

async function expectRouteLocked(route, locked = true) {
  for (const value of ['auto', 'primary', 'direct']) {
    if (locked) await expect(routeChoice(route, value)).toBeDisabled()
    else await expect(routeChoice(route, value)).toBeEnabled()
  }
}

async function relaunchFromRouteNotice(page, scope = page) {
  await scope.getByTestId('settings-relay-relaunch-now').click()
  await page.getByTestId('settings-relay-relaunch-confirm').getByRole('button', { name: '现在重开', exact: true }).click()
}

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
    await chooseRoute(route, 'direct')
    await expectRouteLocked(route)
    await expect(page.getByTestId('auth-connection-back')).toBeDisabled()
    await expectRoute(route, 'primary')
    await page.evaluate(() => window.v2Test.releaseConfigSave('线路设置没有保存成功'))
    await panel.getByRole('alert').filter({ hasText: '线路设置没有保存成功' }).waitFor()
    await expectRoute(route, 'primary')
    await chooseRoute(route, 'direct')
    await panel.getByTestId('settings-relay-relaunch').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'relaunchApp').length), 0)
    await page.getByTestId('auth-connection-back').click()
    await expect(page.getByTestId('login-account')).toHaveValue('fixture-user')
    await expect(page.getByTestId('login-password')).toHaveValue('fixture-password')
    await expect(page.getByTestId('auth-agree')).toBeChecked()
    await page.getByTestId('auth-connection-settings').click()
    await expectRoute(route, 'direct')
    await page.evaluate(() => { window.xingmang.relaunchApp = async () => false })
    await panel.getByTestId('settings-relay-relaunch-now').click()
    // 登录框里问的是没填完的登录信息，不是「登录状态不变」。
    await expect(page.getByTestId('settings-relay-relaunch-confirm')).toContainText('没填完的登录信息要重新填')
    await page.getByTestId('settings-relay-relaunch-confirm').getByRole('button', { name: '现在重开', exact: true }).click()
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
    await chooseRoute(panel.getByTestId('settings-relay-route-solov'), 'direct')
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
    await settings.getByRole('tab', { name: '网络加速', exact: true }).click()
    const route = page.getByTestId('settings-relay-route-solov')
    await expectRoute(route, 'primary')
    // 历史账号也有直连了，这一行能选。
    await expectRouteLocked(page.getByTestId('settings-relay-route-solov-api'), false)
    await expectRoute(page.getByTestId('settings-relay-route-solov-api'), 'primary')
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    await chooseRoute(route, 'direct')
    await expectRouteLocked(route)
    await expectRoute(route, 'primary')
    assert.equal(await page.getByTestId('settings-relay-relaunch').count(), 0)
    await page.evaluate(() => window.v2Test.releaseConfigSave())
    await expectRoute(route, 'direct')
    await page.getByTestId('settings-relay-relaunch').waitFor()
    const saves = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0]))
    assert.deepEqual(saves.at(-1), { version: 2, relayEndpointIds: { solov: 'direct', 'solov-api': 'primary' } })
    assert.equal(await page.evaluate(async () => (await window.xingmang.getSettings()).activeRelayEndpointIds.solov), 'primary')
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-settings').click()
    await settings.getByRole('tab', { name: '网络加速', exact: true }).click()
    await page.getByTestId('settings-relay-relaunch').waitFor()
    await page.screenshot({ path: path.join(artifacts, 'settings-relay-route-pending.png'), fullPage: true })
    // 先问一句：点「稍后」什么都不做，横条留着。
    await page.getByTestId('settings-relay-relaunch-now').click()
    const confirm = page.getByTestId('settings-relay-relaunch-confirm')
    await expect(confirm).toContainText('登录状态和配好的工具都不变')
    await confirm.getByRole('button', { name: '稍后', exact: true }).click()
    await expect(confirm).toBeHidden()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'relaunchApp').length), 0)
    await relaunchFromRouteNotice(page)
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'relaunchApp').length)).toBe(1)
    await expect(page.getByTestId('settings-relay-relaunch')).toBeVisible()
    await clean(page)
  } finally { await page.close() }
})

test('relay route settings roll back a failed save and do not announce a pending restart', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络加速', exact: true }).click()
    const route = page.getByTestId('settings-relay-route-solov')
    await page.evaluate(() => { window.v2Test.fail = 'saveSettings' })
    await chooseRoute(route, 'direct')
    await page.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    await expectRoute(route, 'primary')
    await expectRouteLocked(route, false)
    assert.equal(await page.getByTestId('settings-relay-relaunch').count(), 0)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await chooseRoute(route, 'direct')
    await page.getByTestId('settings-relay-relaunch').waitFor()
    await chooseRoute(route, 'primary')
    await expect.poll(() => page.getByTestId('settings-relay-relaunch').count()).toBe(0)
    await clean(page)
  } finally { await page.close() }
})

test('relay route settings compare against the active backup route and preserve a cancelled restart', async () => {
  const page = await open('directRelayActive=1')
  try {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络加速', exact: true }).click()
    const route = page.getByTestId('settings-relay-route-solov')
    await expectRoute(route, 'direct')
    assert.equal(await page.getByTestId('settings-relay-relaunch').count(), 0)
    await chooseRoute(route, 'primary')
    await page.getByTestId('settings-relay-relaunch').waitFor()
    await page.evaluate(() => { window.xingmang.relaunchApp = async () => false })
    await relaunchFromRouteNotice(page)
    await waitForToast(page, '已取消重开')
    await expect(page.getByTestId('settings-relay-relaunch')).toBeVisible()
    assert.equal(await page.evaluate(async () => (await window.xingmang.getAccountSession()).account.userId), 17)
    await clean(page)
  } finally { await page.close() }
})

// 左栏搜索搜到线路那一行，改完就在搜索结果里给「现在重开」，不用再回到网络加速那一组。
test('a route changed from the settings search offers the restart right there', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('settings-search').fill('星芒账号线路')
    const results = page.getByTestId('settings-search-results')
    await chooseRoute(results.getByTestId('settings-relay-route-solov'), 'direct')
    await results.getByTestId('settings-relay-relaunch').waitFor()
    assert.equal(await page.getByTestId('settings-relay-relaunch').count(), 1)
    await relaunchFromRouteNotice(page, results)
    await expect.poll(() => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'relaunchApp').length)).toBe(1)
    await clean(page)
  } finally { await page.close() }
})

// 直连适配第二步：星芒账号线路没选过就是「自动」，主进程查出走哪条，换了就叫一声（onRelayRouteChanged）。
test('relay route settings read nothing stored as auto and offer it first with the approved wording', async () => {
  const page = await open('autoRelay=direct')
  try {
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络加速', exact: true }).click()
    const route = page.getByTestId('settings-relay-route-solov')
    await expectRoute(route, 'auto')
    assert.deepEqual(await route.getByRole('button').allTextContents(), ['自动（推荐）', '只用线路1', '只用线路2'])
    assert.deepEqual(await page.getByTestId('settings-relay-route-solov-api').getByRole('button').allTextContents(), ['自动（推荐）', '只用线路1', '只用线路2'])
    await page.getByText('自动会先走线路2，连不上时改走线路1。保存后重启星芒生效，不会切换账号。', { exact: true }).waitFor()
    await page.getByText('自动会先走线路1，线路1连不上时改走线路2。保存后重启星芒生效，不会切换账号。', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('settings-relay-relaunch').count(), 0)
    await chooseRoute(route, 'primary')
    await page.getByTestId('settings-relay-relaunch').waitFor()
    const saves = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveSettings').map((entry) => entry.args[0]))
    assert.deepEqual(saves.at(-1), { version: 2, relayEndpointIds: { 'solov-api': 'primary', solov: 'primary' } })
    await chooseRoute(route, 'auto')
    await expect.poll(() => page.getByTestId('settings-relay-relaunch').count()).toBe(0)
    await clean(page)
  } finally { await page.close() }
})

async function settleStartupBootstrap(page) {
  await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'syncManagedCliKeys'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="home-bootstrap-progress"]') && document.querySelector('[data-testid="home-rescan"]')?.getAttribute('aria-busy') !== 'true')
}

async function assertToolsOnTheirExpectedLine(page, line) {
  const providers = await page.evaluate(async () => (await window.xingmang.getConfig()).providers)
  // 已下线的 Gemini CLI 星芒不再替它改线路，只看还在用的工具。
  for (const provider of ['claude', 'codex', 'grok']) {
    assert.equal(new URL(providers[provider].actualBaseUrl).origin, line, provider)
    assert.equal(new URL(providers[provider].baseUrl).origin, line, provider)
  }
}

// 页面带 ?bootstrapPending 时每一轮同步 Key 都先扣着：开机那一轮放开让它做完。
async function releaseStartupBootstrap(page) {
  await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'syncManagedCliKeys'))
  await page.evaluate(() => window.v2Test.releaseBootstrap())
  await settleStartupBootstrap(page)
}

// 「自动」换了线路、工具跟着改配置的那一轮（yoyo 10-8：线路的事不要太多提示），页面要带 ?bootstrapPending：同步 Key
// 扣着的时候首页不摆进度；放开以后这一轮写完、首页照结果画完，也不说「已完成…」，中间一下都没出过同步横幅。
// 做没做完看运行日志里那一行，光看配置改没改，横幅可能还没画。
async function changeRouteQuietly(page, line) {
  assert.equal(await page.locator('[data-testid^="home-bootstrap-"]').count(), 0)
  await page.evaluate((next) => {
    window.routeRoundSyncsBefore = window.v2Test.calls.filter((entry) => entry.method === 'syncManagedCliKeys').length
    window.followedRouteRounds = () => window.v2Test.calls.filter((entry) => entry.method === 'reportRendererError'
      && entry.args[0]?.context === 'account-bootstrap' && String(entry.args[0]?.message).includes('跟着换了连接线路')).length
    window.followedRouteRoundsBefore = window.followedRouteRounds()
    window.bootstrapNoticeSeen = false
    new MutationObserver(() => { if (document.querySelector('[data-testid^="home-bootstrap-"]')) window.bootstrapNoticeSeen = true })
      .observe(document.body, { childList: true, subtree: true })
    window.v2Test.setRelayRoute({ line: next, settled: true })
    window.v2Test.emit('onRelayRouteChanged', undefined)
  }, line)
  await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'syncManagedCliKeys').length > window.routeRoundSyncsBefore)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.locator('[data-testid^="home-bootstrap-"]').count(), 0, '同步 Key 扣着的时候首页不摆进度')
  await page.evaluate(() => window.v2Test.releaseBootstrap())
  await page.waitForFunction(() => window.followedRouteRounds() > window.followedRouteRoundsBefore)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  assert.equal(await page.evaluate(() => window.bootstrapNoticeSeen), false, '跟着线路改的那一轮首页一下都没出同步横幅')
  assert.equal(await page.locator('[data-testid^="home-bootstrap-"]').count(), 0)
}

test('auto leaves the tools alone until its check settles, then moves the ones Xingmang configured onto that line', async () => {
  const page = await open('allInstalled=1&autoRelay=pending&bootstrapPending=1&mergeRoute=1')
  try {
    await releaseStartupBootstrap(page)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys')), false, '没查出线路以前不迁')
    await assertToolsOnTheirExpectedLine(page, 'https://xm.solov.cc')
    await changeRouteQuietly(page, 'direct')
    await assertToolsOnTheirExpectedLine(page, 'https://xm-direct.solov.cc')
    await clean(page)
  } finally { await page.close() }
})

// #941：「自动」换了线路，开着的工具也照样跟着改好配置，下次打开就走新线路。yoyo 10-8：线路的事不要太多提示，
// 所以不问开没开，首页不摆进度、不说「已完成…」，也没有「要关掉重开」那句。
test('when auto changes the line while tools are open, they quietly follow it', async () => {
  const page = await open('autoRelay=direct&runningTools=1&bootstrapPending=1&mergeRoute=1')
  try {
    await releaseStartupBootstrap(page)
    await changeRouteQuietly(page, 'primary')
    const providers = await page.evaluate(async () => (await window.xingmang.getConfig()).providers)
    for (const provider of ['claude', 'codex']) assert.equal(new URL(providers[provider].actualBaseUrl).origin, 'https://xm.solov.cc', provider)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'inspectRunningTools')), false, '不再问开没开')
    assert.equal(await page.getByText('连接线路').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// xm 三线路 C9：星芒账号换线路由主进程定点改地址，界面收到那一声只重读设置和配置，不再同步 Key、整份写入。
test('when auto changes the xm line the main process moves the tools and home only rereads them', async () => {
  const page = await open('allInstalled=1&autoRelay=direct')
  try {
    await settleStartupBootstrap(page)
    const configReads = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getConfig').length)
    await page.evaluate(() => {
      window.v2Test.setRelayRoute({ line: 'primary', settled: true })
      window.v2Test.emit('onRelayRouteChanged', undefined)
    })
    await page.waitForFunction((before) => window.v2Test.calls.filter((entry) => entry.method === 'getConfig').length > before + 1, configReads)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys')), false, '界面不再整份写入')
    assert.equal(await page.locator('[data-testid^="home-bootstrap-"]').count(), 0)
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
    await waitForToast(page, '界面缩放 110%，按 Ctrl 0 恢复自动')
    await expect.poll(async () => (await saves()).at(-1)).toEqual({ version: 2, uiScale: '110' })
    await settings.getByRole('button', { name: '110%', pressed: true }).waitFor()
    await page.keyboard.press('Control+Equal')
    await waitForToast(page, '已经是最大的 110%')
    await page.keyboard.press('Control+Minus')
    await waitForToast(page, '界面缩放 100%，按 Ctrl 0 恢复自动')
    await expect.poll(async () => (await saves()).at(-1)).toEqual({ version: 2, uiScale: '100' })
    await page.keyboard.press('Control+0')
    await waitForToast(page, '界面缩放已恢复自动')
    await expect.poll(async () => (await saves()).at(-1)).toEqual({ version: 2, uiScale: 'auto' })
    await clean(page)
  } finally { await page.close() }
})

// 更新装完重新打开时，软件原来一句话都没有。现在角落里一张轻量卡片说一声已经在新版上、
// 列前几项改动，只有一颗「知道了」；完整清单在「设置 › 版本更新」的版本卡上。普通启动什么都不说。
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
    const updates = await openVersionCard(page)
    await updates.getByText('v0.1.31 更新了什么', { exact: true }).waitFor()
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

test('a failed manual update check still reports on the version card in settings', async () => {
  const page = await open('updateCheckFail=1')
  try {
    const updates = await openVersionCard(page)
    await updates.getByRole('button', { name: '检查更新', exact: true }).click()
    await updates.getByText('更新服务器暂时连不上', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('startup-notices').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 更新失败原来只有一句「更新没有装上」加一个「重新下载」，断网点一次「检查更新」
// 也是这句——更新根本还没开始下。三步各自的标题和按钮在这里一次看全。
test('the version card names the step that failed and offers that step again', async () => {
  const page = await open('updateCheckFail=1')
  try {
    const updates = await openVersionCard(page)
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
      // 首页那条浮动气泡读的是同一份文案，不许和卡上说两套话；下载失败那条人在「设置 › 版本更新」时不弹（第 55 条）。
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
// 给那一步的重试，走的和版本更新卡同一套：下载失败先重新查再下，安装失败落到「设置 › 版本更新」
// 那张卡的重启确认框，检查失败重新查。
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
    const settings = page.getByTestId('page-settings')
    await settings.getByTestId('page-updates').waitFor()
    await expect(settings.getByRole('tab', { name: '版本更新', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('dialog', { name: '重启并安装更新？' }).waitFor()
    assert.equal(await calls('installUpdate'), 0)
    await clean(page)
  } finally { await page.close() }
})

// 已知31：版本更新卡确认框里的「重启并安装」让主进程先看有没有工具在装（askIfInstalling），有就先问退出时那一句。
// 客户在那一句里点了「继续安装」：确认框关掉，不说「安装请求已提交」，新版本留着。
test('the version card asks about running installs before restarting and stays quiet when the user keeps installing (known 31)', async () => {
  const page = await open('installPostponed=1')
  try {
    const updates = await openVersionCard(page)
    const restart = updates.getByRole('button', { name: '重启并安装', exact: true })
    // 版本卡挂上先自己读一次状态（假数据里是没开自动更新），读回来之前推过去的会被它盖掉：推到按钮出来为止。
    await expect.poll(async () => {
      await page.evaluate(() => window.v2Test.emit('onUpdateState', {
        phase: 'downloaded', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
        checkedAt: new Date().toISOString(), progress: null, error: null, development: true,
      }))
      return restart.count()
    }).toBe(1)
    await restart.click()
    const confirm = page.getByRole('dialog', { name: '重启并安装更新？' })
    await confirm.getByRole('button', { name: '重启并安装', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'installUpdate').map((entry) => entry.args)), [[{ askIfInstalling: true }]])
    await restart.waitFor()
    await assertNoToast(page, '安装请求已提交')
    await clean(page)
  } finally { await page.close() }
})

// 开机和每 3 小时自己跑的检查没查成，客户什么都没点：首页不弹红框，版本更新卡照常能看到
// 这次失败和「重试」。客户自己点的检查没查成，照旧弹。
test('an automatic update check that fails stays off the home bubble but shows on the version card', async () => {
  const page = await open('updateCheckFail=1')
  try {
    const updates = await openVersionCard(page)
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

// Mac 校验新版本签名没通过时，同一个包装多少遍都一样：版本更新卡和首页气泡都不再给
//「重新安装」，改给「打开下载页」，让客户手动装一次。
test('a Mac signature rejection offers the download page instead of reinstalling', async () => {
  const page = await open('updateCheckFail=1')
  try {
    const updates = await openVersionCard(page)
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
    // 卡底那颗「重启并安装」是同一条死路，也不能留。
    assert.equal(await updates.getByRole('button', { name: '重启并安装', exact: true }).count(), 0)
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
//「重新下载」多半还是一样。版本更新卡和首页气泡在「重新下载」旁边多给「打开下载页」；别的下载
// 失败照旧只给「重新下载」。
test('a stalled update download offers the download page next to downloading again', async () => {
  const page = await open('updateCheckFail=1')
  try {
    const updates = await openVersionCard(page)
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
    // 人在「设置 › 版本更新」时气泡不重复说一遍（第 55 条）。
    assert.equal(await page.locator('.v2-notification').count(), 0)

    const opened = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').map((entry) => entry.args[0]))
    const downloadPage = 'https://docs-new.solov.cc/guide/manager#download-installers'
    await notice.getByRole('button', { name: '打开下载页', exact: true }).click()
    await expect.poll(opened).toEqual([downloadPage])

    // 同一句「超时」，没经过看门狗的不算停住。
    await emit('ETIMEDOUT')
    await expect.poll(() => notice.getByRole('button', { name: '打开下载页', exact: true }).count()).toBe(0)
    await notice.getByRole('button', { name: '重新下载', exact: true }).waitFor()

    // 离开设置页，气泡照旧弹，按钮和卡上的一样。
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

// 检查更新 45 秒没动静被掐断：连更新清单都拿不回来的网络，再点「重试」多半一样。版本更新卡在
//「重试」旁边多给「打开下载页」；别的检查失败照旧只给「重试」。
test('a stalled update check offers the download page next to retrying', async () => {
  const page = await open('updateCheckFail=1')
  try {
    const updates = await openVersionCard(page)
    const reason = '连接更新服务器超时，请检查网络后再试。'
    const emit = (code) => page.evaluate((value) => window.v2Test.emit('onUpdateState', {
      phase: 'error', currentVersion: '0.1.31', availableVersion: null, releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, failedStep: 'check',
      error: { code: value.code, message: value.reason }, development: true,
    }), { code, reason })
    await emit('UPDATE_CHECK_STALLED')
    const notice = updates.getByTestId('updates-failure-check')
    await notice.getByText('检查更新失败', { exact: true }).waitFor()
    await notice.getByRole('button', { name: '重试', exact: true }).waitFor()
    const opened = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').map((entry) => entry.args[0]))
    await notice.getByRole('button', { name: '打开下载页', exact: true }).click()
    await expect.poll(opened).toEqual(['https://docs-new.solov.cc/guide/manager#download-installers'])

    await emit('ENOTFOUND')
    await expect.poll(() => notice.getByRole('button', { name: '打开下载页', exact: true }).count()).toBe(0)
    await notice.getByRole('button', { name: '重试', exact: true }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 磁盘快满时新版本先不下：版本更新卡和首页气泡都说清差多少，「怎么清理」就地展开步骤，
//「仍要下载」跳过这一次的空间预检。
test('the version card explains a full disk and still lets the user download', async () => {
  const page = await open('updateCheckFail=1')
  try {
    const updates = await openVersionCard(page)
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
//「空间够了，再试一次」重新量盘，「仍要下载」跳过预检，和版本更新卡一样。
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
      const updates = await openVersionCard(page)
      await page.evaluate(() => window.v2Test.emit('onUpdateState', {
        phase: 'downloaded', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
        checkedAt: new Date().toISOString(), progress: null, failedStep: null, error: null, development: true,
      }))
      await updates.getByRole('button', { name: '重启并安装', exact: true }).click()
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

// 账号不在管理员组的 Windows 电脑：下好的新版本不自动装（第二十四批 2）。首页气泡和版本更新卡「重启并安装」
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
    // 设置页和版本卡挂上时各自再读一次状态：主进程读回的就是最后推过来的那份，夹具默认读回的是另一份，
    // 这里让它跟着推的走。
    await page.evaluate(() => {
      const original = window.xingmang.getUpdateState
      window.__updateState = null
      window.xingmang.getUpdateState = async () => window.__updateState ? { ...window.__updateState } : original()
    })
    const emit = (patch) => page.evaluate((value) => {
      window.__updateState = value
      window.v2Test.emit('onUpdateState', value)
    }, { ...state, ...patch })
    await emit({})
    await page.locator('.xm-notice').getByText('正在后台下载；这台电脑装更新时要输入管理员密码，下好后不会自动装上。', { exact: true }).waitFor()

    await emit({ phase: 'downloaded', progress: null })
    const bubble = page.locator('.xm-notice').filter({ hasText: '这台电脑的账号不是管理员，装更新时要输入管理员密码。让有管理员账号的人点一次「重启并安装」，或者找客服。' })
    await bubble.getByText('更新已下载', { exact: true }).waitFor()
    await bubble.getByRole('button', { name: '查看更新', exact: true }).click()
    const settings = page.getByTestId('page-settings')
    const updates = settings.getByTestId('page-updates')
    await updates.waitFor()
    await expect(settings.getByRole('tab', { name: '版本更新', exact: true })).toHaveAttribute('aria-selected', 'true')
    // 原来更新页页头那句「不会自动装上」挪进了卡下面「自动下载更新」那一行的说明（v4 批09）。
    await expect(settings.getByTestId('updates-auto-update')).toContainText('下好后要输入管理员密码才能装')
    // 要输管理员密码的不是「重启后生效」，小标签照旧写「更新已下载」。
    await updates.getByText('更新已下载', { exact: true }).waitFor()
    const notice = updates.getByTestId('updates-admin-password')
    await notice.getByText('这台电脑的账号不是管理员，装更新时要输入管理员密码', { exact: true }).waitFor()
    await notice.getByText('让有管理员账号的人点一次「重启并安装」，或者找客服。', { exact: true }).waitFor()
    // 原话叫他点的就是卡底这颗按钮：自己点照样能装，确认框说清要输管理员密码。
    await updates.getByRole('button', { name: '重启并安装', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '重启并安装更新？' })
    await dialog.getByTestId('updates-windows-consent-hint').getByText('Windows 会弹出一个授权窗口，要在里面输入管理员密码；点了「否」这次就装不上。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '稍后安装', exact: true }).click()

    await emit({ phase: 'downloaded', progress: null, installNeedsAdminPassword: false })
    await notice.waitFor({ state: 'detached' })
    await updates.getByText('已下载，重启后生效', { exact: true }).waitFor()
    // 管理员账号照旧会在关掉星芒时装上：从首页气泡再进一次「设置 › 版本更新」，那一行说的是这句。
    await page.getByTestId('nav-home').click()
    await page.locator('.xm-notice').filter({ hasText: '更新已下载' }).getByRole('button', { name: '查看更新', exact: true }).click()
    await expect(settings.getByTestId('updates-auto-update')).toContainText('下好后在你关掉星芒时装上')

    // 强制更新那道门在开发环境不拦，这里按正式环境发。
    await emit({ phase: 'available', progress: null, development: false, requiredVersion: '0.1.32' })
    const gate = page.getByTestId('required-update-gate')
    await gate.getByTestId('required-update-admin-password').getByText('要输入管理员密码；让有管理员账号的人来点，或联系客服。', { exact: true }).waitFor()
    assert.equal(await gate.getByText('是否允许更改', { exact: false }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 星芒这次本身就带着管理员权限在跑（自带 Administrator 没开管理员批准模式、关了 UAC、右键「以管理员
// 身份运行」）：装 Node.js、Codex 桌面端、装更新都不弹授权窗口，首页、检查页和重启并安装确认框都不说
// 会弹（已知19）。首页那段在只用 Codex 桌面端时只去掉弹窗半句，「一般不用单独点」照旧。没带管理员权限的照旧说。
test('an app already running with administrator rights does not promise a consent window', async () => {
  for (const [query, elevated] of [['desktopOnly=1&elevated=1', true], ['desktopOnly=1', false]]) {
    const page = await open(query)
    try {
      await expect(page.getByTestId('home-runtime-row-node')).toContainText('未装')
      const nodeNotice = page.getByTestId('home-runtime-node-elevation')
      await expect(nodeNotice).toContainText('装工具时会自动准备，一般不用单独点。')
      if (elevated) assert.doesNotMatch(await nodeNotice.innerText(), /管理员授权|授权窗口/, query)
      else await expect(nodeNotice).toContainText('准备时 Windows 会弹一次授权窗口')

      await stubHealthReport(page, [{ code: 'RUNTIME_NODE', title: 'Node.js', state: 'fail', summary: '还没装 Node.js', details: { installed: false } }])
      await page.getByTestId('nav-health').click()
      // 这一行的按钮只在读到平台以后才有，等它出来再看授权那句在不在。
      await expect(page.getByTestId('maintenance-runtime-action-node')).toHaveText('安装 Node.js')
      const row = page.getByTestId('health-row-RUNTIME_NODE')
      if (elevated) {
        assert.equal(await page.getByTestId('health-runtime-node-elevation').count(), 0, query)
        assert.doesNotMatch(await row.innerText(), /管理员授权|授权窗口/, query)
      } else await expect(page.getByTestId('health-runtime-node-elevation')).toHaveText('这一步需要管理员授权：准备 Node.js 时 Windows 会弹一次授权窗口，请选「是」，Node.js 才装得上；如果这台电脑登录的是普通账号，还要输入一个管理员账号的密码。')

      const updates = await openVersionCard(page)
      await page.evaluate(() => window.v2Test.emit('onUpdateState', {
        phase: 'downloaded', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
        checkedAt: new Date().toISOString(), progress: null, failedStep: null, error: null, development: true,
      }))
      await updates.getByRole('button', { name: '重启并安装', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '重启并安装更新？' })
      await dialog.waitFor()
      if (!elevated) await dialog.getByTestId('updates-windows-consent-hint').getByText('点「是」', { exact: false }).waitFor()
      assert.equal(await dialog.getByTestId('updates-windows-consent-hint').count(), elevated ? 0 : 1, query)
      await clean(page)
    } finally { await page.close() }
  }
})

// Linux 的 .deb 交给系统安装窗口装：按钮不能叫「重启并安装」（软件只关掉、不会自己重开），
// 确认框要先说清楚会弹安装窗口、要输开机密码。不是 .deb 装的那种根本没法自动更新，
// 版本更新卡给一条去下载页的路，而不是一颗永远点不动的「检查更新」。
test('on Linux the version card hands installing to the system installer and explains the password prompt', async () => {
  const page = await open('')
  try {
    const updates = await openVersionCard(page)
    await page.evaluate(() => window.v2Test.emit('onUpdateState', {
      phase: 'downloaded', currentVersion: '0.1.31', availableVersion: '0.1.32', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, failedStep: null, error: null, development: true,
      installMethod: 'system-installer',
    }))
    assert.equal(await updates.getByRole('button', { name: '重启并安装', exact: true }).count(), 0)
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

// 第 55 条：人就在「设置 › 版本更新」时，「新版本 X 可以安装」「正在下载更新」「下载更新失败」三种气泡说的是
// 版本卡上写着的同一件事，不弹；离开那一组照旧弹。「这个版本有已知问题」那种照旧。
test('settings › version update does not pop the bubbles that repeat what the version card already says', async () => {
  const page = await open()
  try {
    const updates = await openVersionCard(page)
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
    // 离开设置页照旧弹。
    await page.getByTestId('nav-home').click()
    await bubble.getByText('下载更新失败', { exact: true }).waitFor()
    await emit({ phase: 'available' })
    await bubble.getByText('新版本 0.1.32 可以安装', { exact: true }).waitFor()
    // 回到设置，还停在「版本更新」那组，那条又收起来；换到别的组，版本卡不在眼前了，照旧弹。
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page')
    const settings = page.getByTestId('page-settings')
    const versionTab = settings.getByRole('tab', { name: '版本更新', exact: true })
    await expect(versionTab).toHaveAttribute('aria-selected', 'true')
    await expect.poll(() => bubble.count()).toBe(0)
    await settings.getByRole('tab', { name: '外观显示', exact: true }).click()
    await bubble.getByText('新版本 0.1.32 可以安装', { exact: true }).waitFor()
    await versionTab.click()
    await expect.poll(() => bubble.count()).toBe(0)
    // 「这个版本有已知问题」人在「设置 › 版本更新」也照旧弹。
    await emit({ phase: 'not-available', availableVersion: null, currentVersionWithdrawn: true })
    await bubble.getByText('这个版本有已知问题', { exact: true }).waitFor()
    assert.equal(await versionTab.getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByTestId('nav-settings').getAttribute('aria-current'), 'page')
    await clean(page)
  } finally { await page.close() }
})

// 发布者撤回了本机这个版本、线上退回到旧版本时，界面不能再说「发现新版本」。
test('a withdrawn running version is called out and the older release is offered as a rollback', async () => {
  const page = await open()
  try {
    await page.getByTestId('page-home').waitFor()
    // 版本卡挂上时会自己重新读一次快照，所以进来后要再推一次同样的状态。
    const emitWithdrawn = () => page.evaluate(() => window.v2Test.emit('onUpdateState', {
      phase: 'available', currentVersion: '0.2.10', availableVersion: '0.2.9', releaseName: null, releaseNotesText: null,
      checkedAt: new Date().toISOString(), progress: null, error: null, failedStep: null, development: true,
      serviceMaintenance: null, currentVersionWithdrawn: true, rollback: true,
    }))
    await emitWithdrawn()
    await page.getByText('建议退回 0.2.9', { exact: true }).waitFor()
    const updates = await openVersionCard(page)
    await emitWithdrawn()
    await updates.getByText('建议退回稳定版本', { exact: true }).waitFor()
    await updates.getByTestId('updates-current-withdrawn').getByText(/建议装回 0\.2\.9/).waitFor()
    assert.equal(await page.getByText('新版本 0.2.9 可以安装', { exact: true }).count(), 0)
    assert.equal(await updates.getByTestId('updates-new-version').count(), 0)
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
    assert.equal(await row.getByTestId('tool-codex-update').count(), 0)
    await row.getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '回到推荐版本 v0.156.1…', exact: true }).waitFor()
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
      await row.getByTestId('tool-codex-update').click()
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
    await page.getByRole('menuitem', { name: 'ChatGPT 账号额度…', exact: true }).click()
    const quota = page.getByTestId('codex-quota-dialog')
    await quota.getByRole('button', { name: '刷新额度' }).click()
    // UI v4 draws the window as used rather than remaining.
    await quota.getByText('已用 28%', { exact: true }).waitFor()
    await quota.getByText('周限额', { exact: true }).waitFor()
    await clean(page)
  } finally { await page.close() }
})

test('a key from another site is named for the account and switched from the row in one click', async () => {
  const page = await open('unknown=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.getByText('打不开', { exact: true }).waitFor()
    assert.equal(await row.getByText('other.example.test').count(), 0)
    // v4 不再带用户名（字表批04「改用当前账号」）。
    assert.equal((await page.getByTestId('tool-codex-use-account').textContent())?.trim(), '改用当前账号')
    await page.getByTestId('tool-codex-use-account').click()
    await waitForToast(page, 'Codex CLI 和 Codex 桌面端共用一份设置，已一起改好。')
    await connectedBadge(page, 'codex').waitFor()
    const switched = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'switchAccountSource').map((entry) => entry.args))
    assert.deepEqual(switched, [['codex', 'account']])
    await clean(page)
  } finally { await page.close() }
})

// 2026-10-02 客户报的「无法加载组织设置」：Codex 自己读不了 config.toml。行上的「修好它」就是配置里的
// 「重置为初始状态」，按现在用的账号重新生成，不换来源。
test('a Codex config Codex cannot read is reset from either Codex row on the current account', async () => {
  const page = await open('codexBroken=1')
  try {
    for (const tool of ['codex', 'codexDesktop']) {
      const row = page.getByTestId(`tool-row-${tool}`)
      await row.getByText('配置坏了', { exact: true }).waitFor()
      await row.getByText('Codex 读不了这份配置，打开会报错。修之前会先备份，历史会话保留', { exact: true }).waitFor()
      assert.equal(await page.getByTestId(`tool-${tool}-repair-config`).getAttribute('title'), '改之前会先备份原来的设置')
    }
    assert.equal(await page.getByText('待连接', { exact: true }).count(), 0)
    await page.getByTestId('tool-codexDesktop-repair-config').click()
    await waitForToast(page, '已重置 Codex 桌面端的配置，原来的配置已备份')
    for (const tool of ['codex', 'codexDesktop']) await connectedBadge(page, tool).waitFor()
    const resets = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys' && entry.args[0].mode === 'reset').map((entry) => entry.args[0]))
    assert.deepEqual(resets, [{ providers: ['codex'], preferredModels: { codex: 'fixture-model' }, mode: 'reset', intent: 'explicit' }])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'switchToOfficialAccount')), false)
    await clean(page)
  } finally { await page.close() }
})

test('a ChatGPT login whose Codex config cannot be read is reset on the official account', async () => {
  const page = await open('codexBroken=1&official=1')
  try {
    const row = page.getByTestId('tool-row-codex')
    await row.getByText('配置坏了', { exact: true }).waitFor()
    await page.getByTestId('tool-codex-repair-config').click()
    await waitForToast(page, '已重置 Codex CLI 的配置，原来的配置已备份')
    await expect(page.getByTestId('tool-codex-source')).toHaveText('官方账号')
    const resets = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'switchToOfficialAccount').map((entry) => entry.args))
    assert.deepEqual(resets, [['codex', 'reset']])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'configureManagedCliKeys' && entry.args[0].mode === 'reset')), false)
    await clean(page)
  } finally { await page.close() }
})

// 已知44：Claude Code 读不了 settings.json、星芒也读不出 Key 时，原来首页写成「官方账号」，配置窗口也默认选官方账号。
test('a Claude Code settings file it cannot read is reset on the current account instead of passing for the official account', async () => {
  const page = await open('claudeBroken=1')
  try {
    const row = page.getByTestId('tool-row-claude')
    await row.getByText('配置坏了', { exact: true }).waitFor()
    await row.getByText('Claude Code 读不了这份配置，打开会报错。修之前会先备份，历史会话保留', { exact: true }).waitFor()
    assert.equal(await row.getByText('官方账号', { exact: true }).count(), 0)
    await openToolConfiguration(page, 'claude')
    await page.getByTestId('tool-key-select').waitFor()
    await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).click()
    await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
    await page.getByTestId('tool-claude-repair-config').click()
    await waitForToast(page, '已重置 Claude Code 的配置，原来的配置已备份')
    await connectedBadge(page, 'claude').waitFor()
    const resets = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys' && entry.args[0].mode === 'reset').map((entry) => entry.args[0]))
    assert.deepEqual(resets, [{ providers: ['claude'], preferredModels: {}, mode: 'reset', intent: 'explicit' }])
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'switchToOfficialAccount')), false)
    await clean(page)
  } finally { await page.close() }
})

// #1073 评论第 2 条：命令行工具和 Claude Desktop 卡片上「用哪个账号」菜单的字收成一份以后，
// 两张卡上看得见的每一个字（来源牌、读屏念的那句、标题、每一项和说明、勾在哪、哪项点不动）都和原来一样。
async function sourceMenuEntries(page, tool) {
  const chip = page.getByTestId(`tool-${tool}-source`)
  const shown = { chip: (await chip.innerText()).trim(), label: await chip.getAttribute('aria-label') }
  await chip.click()
  const menu = page.getByTestId(`tool-${tool}-source-menu`).getByRole('menu')
  await menu.waitFor()
  shown.menu = await menu.getAttribute('aria-label')
  shown.entries = await menu.evaluate((panel) => [...panel.children].map((node) => {
    if (node.tagName === 'HR') return 'divider'
    if (node.classList.contains('xm-menu-heading')) return { heading: node.textContent }
    if (node.classList.contains('xm-menu-note')) return { note: node.textContent }
    const text = node.querySelector('.xm-menu-text')
    return { label: text ? text.querySelector('span').textContent : node.textContent, description: text?.querySelector('small').textContent ?? null,
      checked: node.getAttribute('aria-checked'), disabled: node.disabled, testId: node.getAttribute('data-testid') }
  }))
  await page.keyboard.press('Escape')
  await menu.waitFor({ state: 'detached' })
  return shown
}
function sourceChoice(tool, kind, label, description, checked) {
  return { label, description, checked: String(checked), disabled: false, testId: `tool-${tool}-source-${kind}` }
}
function shownSourceMenu(label, chip, choices) {
  return { chip, label, menu: label, entries: [{ heading: '用哪个账号使用 AI' }, ...choices, 'divider',
    { label: '更多配置…', description: null, checked: null, disabled: false, testId: null }] }
}
const codexSharedNote = { note: 'Codex CLI 和 Codex 桌面端共用这份配置' }

test('the which-account menus on the CLI and Claude Desktop cards keep every word they showed before sharing one copy', async () => {
  let page = await open('allInstalled=1')
  try {
    assert.deepEqual(await sourceMenuEntries(page, 'claude'), shownSourceMenu('Claude Code 现在用当前账号，点击切换', '当前账号', [
      sourceChoice('claude', 'account', '当前账号', '按用量从当前账号扣费', true),
      sourceChoice('claude', 'official', 'Claude 账号', '用你自己的官方订阅登录', false),
      sourceChoice('claude', 'manual', '自己填写密钥', '粘贴你在星芒创建的密钥', false),
    ]))
    for (const [tool, label] of [['codex', 'Codex CLI 现在用当前账号，点击切换'], ['codexDesktop', 'Codex 桌面端现在用当前账号，点击切换']]) {
      assert.deepEqual(await sourceMenuEntries(page, tool), shownSourceMenu(label, '当前账号', [
        sourceChoice(tool, 'account', '当前账号', '按用量从当前账号扣费', true),
        sourceChoice(tool, 'official', 'ChatGPT 账号', '用你自己的官方订阅登录', false),
        sourceChoice(tool, 'manual', '自己填写密钥', '粘贴你在星芒创建的密钥', false),
        codexSharedNote,
      ]))
    }
    assert.deepEqual(await sourceMenuEntries(page, 'grok'), shownSourceMenu('Grok CLI 现在用当前账号，点击切换', '当前账号', [
      sourceChoice('grok', 'account', '当前账号', '按用量从当前账号扣费', true),
      sourceChoice('grok', 'official', 'Grok 账号', '用你自己的官方订阅登录', false),
      sourceChoice('grok', 'manual', '自己填写密钥', '粘贴你在星芒创建的密钥', false),
    ]))
    await clean(page)
  } finally { await page.close() }
  page = await open('manualClaude=1')
  try {
    assert.deepEqual(await sourceMenuEntries(page, 'claude'), shownSourceMenu('Claude Code 现在用自己的密钥，点击切换', '自己的密钥', [
      sourceChoice('claude', 'account', '当前账号', '按用量从当前账号扣费', false),
      sourceChoice('claude', 'official', 'Claude 账号', '用你自己的官方订阅登录', false),
      sourceChoice('claude', 'manual', '自己填写密钥', '粘贴你在星芒创建的密钥', true),
    ]))
    await clean(page)
  } finally { await page.close() }
  for (const [query, officialDescription] of [['official=1', '用你自己的官方订阅登录'], ['official=1&officialEmail=1', 'chatgpt@example.test，Plus']]) {
    page = await open(query)
    try {
      assert.deepEqual(await sourceMenuEntries(page, 'codex'), shownSourceMenu('Codex CLI 现在用官方账号，点击切换', '官方账号', [
        sourceChoice('codex', 'account', '当前账号', '按用量从当前账号扣费', false),
        sourceChoice('codex', 'official', 'ChatGPT 账号', officialDescription, true),
        sourceChoice('codex', 'manual', '自己填写密钥', '粘贴你在星芒创建的密钥', false),
        codexSharedNote,
      ]))
      await clean(page)
    } finally { await page.close() }
  }
  page = await open('externalInstalled=1&externalReady=claudeDesktop')
  try {
    assert.deepEqual(await sourceMenuEntries(page, 'claudeDesktop'), shownSourceMenu('Claude Desktop 现在用当前账号，点击切换', '当前账号', [
      sourceChoice('claudeDesktop', 'account', '当前账号', '按用量从当前账号扣费', true),
      sourceChoice('claudeDesktop', 'official', 'Claude 账号', '用你自己的官方订阅登录', false),
    ]))
    await page.getByTestId('tool-claudeDesktop-source').click()
    await page.getByTestId('tool-claudeDesktop-source-official').click()
    await expect(page.getByTestId('tool-claudeDesktop-source')).toHaveText('官方账号')
    assert.deepEqual(await sourceMenuEntries(page, 'claudeDesktop'), shownSourceMenu('Claude Desktop 现在用官方账号，点击切换', '官方账号', [
      sourceChoice('claudeDesktop', 'account', '当前账号', '按用量从当前账号扣费', false),
      sourceChoice('claudeDesktop', 'official', 'Claude 账号', '用你自己的官方订阅登录', true),
    ]))
    await clean(page)
  } finally { await page.close() }
})

test('a Codex login file Codex cannot read is reset from either Codex row', async () => {
  const page = await open('codexAuthBroken=1')
  try {
    for (const tool of ['codex', 'codexDesktop']) {
      const row = page.getByTestId(`tool-row-${tool}`)
      await row.getByText('配置坏了', { exact: true }).waitFor()
      await row.getByText('Codex 读不了登录信息，打开会要你重新登录。修之前会先备份，历史会话保留', { exact: true }).waitFor()
    }
    await page.getByTestId('tool-codex-repair-config').click()
    await waitForToast(page, '已重置 Codex CLI 的配置，原来的配置已备份')
    for (const tool of ['codex', 'codexDesktop']) await connectedBadge(page, tool).waitFor()
    const resets = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys' && entry.args[0].mode === 'reset').map((entry) => entry.args[0]))
    assert.deepEqual(resets, [{ providers: ['codex'], preferredModels: { codex: 'fixture-model' }, mode: 'reset', intent: 'explicit' }])
    await clean(page)
  } finally { await page.close() }
})

test('the config dialog switches a foreign key in place without the old manual-key buttons', async () => {
  const page = await open('unknown=1')
  try {
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置…', exact: true }).click()
    await page.getByTestId('tool-foreign-key-note').waitFor()
    assert.equal(await page.getByTestId('config-dialog').getByRole('button', { name: '填写星芒密钥' }).count(), 0)
    assert.equal(await page.getByTestId('config-dialog').getByRole('button', { name: '查看处理步骤' }).count(), 0)
    await page.getByTestId('tool-switch-account').click()
    await page.getByTestId('config-dialog').getByText('已改用 fixture-user，可以开始用了。').waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await clean(page)
  } finally { await page.close() }
})

test('configuration migration asks before dropping a draft and failed saves retain the secret for retry', async () => {
  const page = await open('unknown=1')
  try {
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置…', exact: true }).click()
    // UI v4: the manual card is one of the three source cards, also while the source is unconfirmed.
    await page.getByTestId('tool-manual-key').click()
    await page.getByLabel('星芒密钥').fill('sk-local-fixture-secret')
    await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '继续编辑', exact: true }).click()
    await page.getByRole('button', { name: '检测模型', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await page.evaluate(() => { window.v2Test.fail = 'saveConfig' })
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('config-dialog').getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoConfigSaveToast(page)
    assert.equal(await page.getByLabel('星芒密钥').inputValue(), 'sk-local-fixture-secret')
    await clean(page)
  } finally { await page.close() }
})

test('a manual relay key saved over a third-party config survives the next login bootstrap', async () => {
  const page = await open('guest=1&existing=1&unknown=1')
  try {
    await enterWorkspaceWithoutAccount(page, 'claude')
    await page.getByTestId('tool-row-codex').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '配置…', exact: true }).click()
    await page.getByTestId('tool-manual-key').click()
    await page.getByLabel('星芒密钥').fill('sk-local-fixture-secret')
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

test('chat retains its task across navigation', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('chat-composer-input').fill('local streaming fixture')
    await page.getByTestId('chat-send').click()
    await page.getByTestId('chat-stop').waitFor()
    const size = await page.getByTestId('page-chat').evaluate((element) => ({ width: element.clientWidth, height: element.clientHeight }))
    // 聊天页铺满侧栏右边：1280 减去 v4 侧栏 224。
    assert.equal(size.width, 1056)
    assert.ok(size.height > 600)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
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
    await page.getByRole('button', { name: /^个人中心：other-user(，|$)/ }).waitFor()
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
    // v4 的小框每条下面只露正文第一句的纯文字，正文要点进去才排出来。
    assert.deepEqual(await list.locator('.v2-announcement-preview').allTextContents(), ['系统升级完成，请重新读取分组。', '套餐详情已更新'])
    assert.equal(await dialog.locator('.v2-announcement-content, strong').count(), 0)
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
    // 小框没有关闭键，再点一次铃铛就收起。
    await button.click()
    await dialog.waitFor({ state: 'hidden' })
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
      // 看过一条的还在大框里，用底下的「重新读取」；小框没有这个键，收起再打开就会重新读，读坏了小框里才给「重新读取」。
      if (query.includes('noticesRead')) await dialog.getByRole('button', { name: '重新读取' }).click()
      else {
        await page.getByTestId('announcement-open').click()
        await dialog.waitFor({ state: 'hidden' })
        await page.getByTestId('announcement-open').click()
      }
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
    await page.getByTestId('sidebar-account-open').click()
    await page.getByTestId('account-overview-balance').waitFor()
    const labels = await page.getByTestId('account-tabs').getByRole('tab').allTextContents()
    assert.deepEqual(labels, ['账号概览', '密钥管理', '账号安全'])
    assert.doesNotMatch(await page.getByTestId('page-account').innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov/i)
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(methods.includes('getAccountProfile'), true)
    assert.equal(methods.includes('getAccountNotice'), true)
    for (const method of ['getAccountUsage', 'getAccountLoginSessions', 'getAccountTopupInfo', 'getAccountSubscriptionSelf', 'getLegalDocument']) assert.equal(methods.includes(method), false, method)
    await page.screenshot({ path: path.join(artifacts, 'account-sub2api.png') })
    await clean(page)
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: false, account: null, siteId: 'solov-api', realmId: 'api-account' }))
    await page.getByTestId('welcome-login').waitFor()
    assert.equal(await page.getByTestId('account-overview-balance').count(), 0)
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

// v4 的账号卡平时只摆余额，没有刷新键：首页和个人中心的刷新、状态栏、账号卡读的是同一份余额。
test('manual balance refresh is shared by the sidebar card, footer, home and personal center', async () => {
  const page = await open('sub2api=1', 'fixed')
  const reads = () => page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'getAccountBalance').length)
  try {
    await page.getByTestId('home-balance').getByText('$12.40', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('sidebar-balance-refresh').count(), 0)
    await page.getByTestId('sidebar-account-open').click()
    await page.getByTestId('account-balance').waitFor()
    assert.equal(await reads(), 1)
    await page.evaluate(() => { window.v2Test.setBalance(20.25); window.v2Test.holdNextBalance() })
    const before = await reads()
    await page.getByTestId('account-balance-refresh').click()
    assert.equal(await page.getByTestId('account-balance-refresh').isDisabled(), true)
    assert.equal(await page.getByTestId('account-balance').innerText(), '$12.40')
    await page.evaluate(() => window.v2Test.releaseBalance())
    await page.getByTestId('account-balance').getByText('$20.25', { exact: true }).waitFor()
    assert.equal(await reads(), before + 1)
    assert.match(await page.getByTestId('statusbar-balance').innerText(), /20\.25/)
    await page.getByTestId('account-entry').getByText('$20.25', { exact: true }).waitFor()
    assert.match(await page.getByTestId('statusbar-balance').getAttribute('title'), /最后更新于/)
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
      const originalTitle = await page.getByTestId('statusbar-balance').getAttribute('title')
      await page.evaluate(() => { window.v2Test.fail = 'getAccountBalance' })
      await page.getByTestId('home-balance-refresh').click()
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
    const switcher = await openAccountSwitcher(page)
    const list = switcher.getByTestId('saved-accounts-list')
    await list.getByTestId('saved-account-row-saved-aa0017').getByText('历史账号', { exact: true }).waitFor()
    assert.doesNotMatch(await list.innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov|账户尾号|aa0017/i)
    await list.getByRole('button', { name: '切换', exact: true }).click()
    await page.getByRole('dialog', { name: '切换账号', exact: true }).waitFor({ state: 'hidden' })
    await page.getByTestId('sidebar-account-open').click()
    await page.getByTestId('account-overview-balance').waitFor()
    assert.deepEqual(await page.getByTestId('account-tabs').getByRole('tab').allTextContents(), ['账号概览', '密钥管理', '账号安全'])
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
    const switcher = await openAccountSwitcher(page)
    const list = switcher.getByTestId('saved-accounts-list')
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
    const switcher = await openAccountSwitcher(page)
    const list = switcher.getByTestId('saved-accounts-list')
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
    await page.getByTestId('account-switch').click()
    await page.getByRole('dialog', { name: '切换账号', exact: true }).getByTestId('account-add').click()
    await page.getByRole('heading', { name: '登录星芒账号' }).waitFor()
    assert.equal(await page.getByTestId('login-account').inputValue(), '')
    await clean(page)
  } finally { await page.close() }
})

test('configuring a tool from the key page says so when the key has no models', async () => {
  const page = await open('keyOptions=1&emptyKeyModels=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.getByTestId('sidebar-account-open').click()
    await page.getByTestId('account-overview-balance').waitFor()
    await page.getByTestId('account-tabs').getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByRole('button', { name: '把密钥 custom-key 配置到工具', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Codex CLI/ }).click()
    const dialog = page.getByRole('dialog', { name: '把「custom-key」写进 Codex CLI？', exact: true })
    await dialog.getByText('这把密钥没有可用模型，请换一把密钥，或编辑它换个分组。', { exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '写入并改用当前账号', exact: true }).isDisabled(), true)
    await clean(page)
  } finally { await page.close() }
})

test('configuring a tool from the key page makes the home page re-read tool configuration', async () => {
  const page = await open('keyOptions=1')
  try {
    await page.getByTestId('tool-row-codex').waitFor()
    await page.getByTestId('sidebar-account-open').click()
    await page.getByTestId('account-overview-balance').waitFor()
    await page.getByTestId('account-tabs').getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByRole('button', { name: '把密钥 custom-key 配置到工具', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Codex CLI/ }).click()
    const dialog = page.getByRole('dialog', { name: '把「custom-key」写进 Codex CLI？', exact: true })
    await dialog.getByLabel('选择模型').locator('option[value="fixture-other"]').waitFor({ state: 'attached' })
    await dialog.getByLabel('选择模型').selectOption('fixture-other')
    const reads = () => page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'getConfig').length)
    const before = await reads()
    await dialog.getByRole('button', { name: '写入并改用当前账号', exact: true }).click()
    await waitForToast(page, '密钥已写入工具配置')
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
    await page.getByTestId('sidebar-account-open').click()
    await page.getByTestId('account-overview-balance').waitFor()
    await page.getByTestId('account-tabs').getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByTestId('account-key-add').click()
    await page.getByLabel('名称', { exact: true }).fill('quarter-dollar')
    await page.getByLabel('可用额度', { exact: true }).fill('0.25')
    await page.getByRole('button', { name: '创建密钥', exact: true }).click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'createAccountKey'))
    const created = await page.evaluate(() => window.v2Test.calls.find((entry) => entry.method === 'createAccountKey').args[0])
    assert.equal(created.remainQuota, 0.25)
    assert.equal(created.unlimitedQuota, false)
    await page.getByTestId('account-key-created-done').click()
    await page.getByTestId('account-tabs').getByRole('tab', { name: '账号安全', exact: true }).click()
    await page.getByTestId('account-security-password').click()
    await page.getByLabel('原密码', { exact: true }).fill('old-test-password')
    await page.getByLabel('新密码', { exact: true }).fill('long-new-test-password-for-sub2api')
    await page.getByLabel('再输一次', { exact: true }).fill('long-new-test-password-for-sub2api')
    await page.getByRole('button', { name: '保存新密码', exact: true }).click()
    await page.getByTestId('welcome-login').waitFor()
    await page.getByText('当前登录已结束，请重新登录。', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('account-overview-balance').count(), 0)
    await clean(page)
  } finally { await page.close() }
})


// 自己点的退出：会话变化的事件比退出的返回先到，不能当成「登录被结束」去提醒（#1098）。
// 改密码后被登出那条（上面）照样要提醒。个人中心和命令面板两个入口都走这一条。
test('logging out yourself does not warn that the login ended from either entry point', async () => {
  for (const entry of ['account', 'command']) {
    const page = await open()
    try {
      await page.getByTestId('tool-row-codex').waitFor()
      if (entry === 'account') {
        await page.getByTestId('sidebar-account-open').click()
        await page.getByTestId('account-overview-logout').click()
      } else {
        await page.keyboard.press('Control+k')
        await page.getByRole('searchbox', { name: '搜索或跳转' }).fill('退出登录')
        await page.getByTestId('command-result-account:logout').click()
      }
      await page.getByRole('dialog', { name: '退出登录？', exact: true }).getByRole('button', { name: '退出', exact: true }).click()
      await page.getByTestId('welcome-login').waitFor()
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      assert.equal(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'logoutAccount').length), 1)
      await assertNoToast(page, '当前登录已结束，请重新登录。')
      await clean(page)
    } finally { await page.close() }
  }
})

// #1097 第 2 部分：有工具正在装时退出登录，确认框在「已配好的工具会保留。」后面补一句会继续装完；
// 没在装时一个字不加（v4 交接包定的）。个人中心和命令面板两个入口都要有。
test('the logout prompt says an install in progress keeps going, from either entry point', async () => {
  for (const entry of ['account', 'command']) {
    const page = await open()
    async function logoutDialog() {
      if (entry === 'account') {
        await page.getByTestId('sidebar-account-open').click()
        await page.getByTestId('account-overview-logout').click()
      } else {
        await page.keyboard.press('Control+k')
        await page.getByRole('searchbox', { name: '搜索或跳转' }).fill('退出登录')
        await page.getByTestId('command-result-account:logout').click()
      }
      const dialog = page.getByRole('dialog', { name: '退出登录？', exact: true })
      await dialog.waitFor()
      return dialog
    }
    try {
      const row = page.getByTestId('tool-row-grok')
      await row.getByText('未安装').waitFor()
      await page.evaluate(() => window.v2Test.holdNextInstall())
      await page.getByTestId('tool-grok-primary').click()
      await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
      let dialog = await logoutDialog()
      await expect(dialog).toContainText('已配好的工具会保留。正在安装的 Grok CLI 会继续装完。')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await dialog.waitFor({ state: 'hidden' })
      await page.getByTestId('nav-home').click()
      await page.evaluate(() => window.v2Test.releaseInstall())
      await row.getByTestId('tool-grok-source').waitFor()
      await expect(row.getByText(/正在/)).toHaveCount(0)
      dialog = await logoutDialog()
      await dialog.getByText('已配好的工具会保留。', { exact: true }).waitFor()
      await expect(dialog).not.toContainText('会继续')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await clean(page)
    } finally { await page.close() }
  }
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
    await page.getByTestId('sidebar-account-open').click()
    await page.getByTestId('account-overview-balance').waitFor()
    assert.deepEqual(await page.getByTestId('account-tabs').getByRole('tab').allTextContents(), ['账号概览', '密钥管理', '账号安全'])
    assert.doesNotMatch(await page.locator('.v2-root').innerText(), /Sub2API|NewAPI|new-api|api\.solov|xm\.solov/i)
    await clean(page)
  } finally { await page.close() }
})


async function openToolConfiguration(page, provider = 'codex') {
  await page.getByTestId(`tool-row-${provider}`).getByRole('button', { name: '更多操作' }).click()
  await page.getByRole('menuitem', { name: '配置…', exact: true }).click()
  await page.getByTestId('config-dialog').waitFor()
}

async function waitForSavedConfiguration(page) {
  await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
  await waitForConfigSaveToast(page)
  assert.equal(await page.locator('.xm-leave-bar').count(), 0)
}

// UI v4: the save toast names the tool (「Codex CLI 的配置已保存」); a reset or a switch to the
// official account says that instead.
const configSaveToast = '^(?:.+的配置已保存|已重置 .+的配置，原来的配置已备份|已切回官方账号，原来的配置已备份)$'
async function waitForConfigSaveToast(page) {
  await page.waitForFunction((source) => {
    const pattern = new RegExp(source)
    const log = window.__v2Toasts
    const index = log.entries.findIndex((entry, position) => position >= log.consumed && entry.role === 'status' && pattern.test(entry.text))
    if (index < 0) return false
    log.consumed = index + 1
    return true
  }, configSaveToast)
}
async function assertNoConfigSaveToast(page) {
  const shown = await page.evaluate((source) => window.__v2Toasts.entries.slice(window.__v2Toasts.consumed).filter((entry) => new RegExp(source).test(entry.text)).length, configSaveToast)
  assert.equal(shown, 0, '不应出现保存成功的提示')
}

// The automatic key turns usable once the account's key details arrive; it is an item in the picker menu.
async function waitForAutomaticKeyOption(page, enabled = true) {
  await page.getByTestId('tool-key-select').click()
  const option = page.getByTestId('tool-key-select-option-automatic')
  if (enabled) await expect(option).toBeEnabled()
  else await expect(option).toBeDisabled()
  await page.keyboard.press('Escape')
  await option.waitFor({ state: 'detached' })
}

async function openConfigAdvanced(page) {
  const advanced = page.getByTestId('tool-config-advanced')
  if (!(await advanced.evaluate((element) => element.open))) await advanced.locator('summary').click()
}

const defaultModelCases = [
  { tool: 'claude', provider: 'claude', model: 'claude-opus-5-5' },
  { tool: 'codex', provider: 'codex', model: 'gpt-6-astra' },
  { tool: 'codexDesktop', provider: 'codex', model: 'gpt-6-astra' },
  { tool: 'grok', provider: 'grok', model: 'grok-4.6' },
]
// 没登录时欢迎页挡在前面（本机有 Key 也一样）。配好模型的工具走完使用步骤进首页再开配置；
// 没配模型的工具在引导「确认连接」那一步就能打开配置，未登录用户实际也是这么走的。
// v4 起引导是叠在欢迎页上面的弹窗，欢迎页一直在底下：引导已经开着就不再去点欢迎页。
async function openGuestToolConfiguration(page, tool, existing) {
  if (existing) {
    if (await page.getByTestId('welcome-page').count()) await enterWorkspaceWithoutAccount(page)
    return openToolConfiguration(page, tool)
  }
  if (await page.getByTestId('welcome-page').count() && !await page.getByTestId('start-guide').count()) {
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
      // UI v4: a saved model that detection leaves alone is no change, so the button only closes;
      // a default filled in for a tool that had none is still written.
      assert.equal((await page.getByTestId('tool-save-config').innerText()).trim(), existing ? '完成' : '保存配置')
      await page.getByTestId('tool-save-config').click()
      if (existing) {
        await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
        await assertNoConfigSaveToast(page)
      } else await waitForSavedConfiguration(page)
      assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfig').map((entry) => entry.args[0])), existing ? [] : [
        { provider, apiKey: '', model: expected, mode: 'merge' },
      ])
      await openGuestToolConfiguration(page, tool, existing)
      assert.equal(await page.getByLabel('默认模型').inputValue(), expected)
      await clean(page)
    } finally { await page.close() }
  })
}

// #1154 附录：没设型号的工具，配置窗口预选的默认跟登录自动配置一样看服务状态文件的型号表，不只认程序自带的。
test('the configuration dialog defaults a tool without a model to the published default', async () => {
  const page = await open('guest=1&existing=1&allInstalled=1&keyOptions=1&cliDefaultModels=1&cliMissingModels=1&cliModelHints=1')
  try {
    await openGuestToolConfiguration(page, 'claude', false)
    await expect(page.getByLabel('默认模型')).toHaveValue('claude-opus-6')
    await page.getByTestId('tool-detect-models').click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    assert.equal(await page.getByLabel('默认模型').inputValue(), 'claude-opus-6')
    await page.getByTestId('tool-save-config').click()
    await waitForSavedConfiguration(page)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfig').map((entry) => entry.args[0])), [
      { provider: 'claude', apiKey: '', model: 'claude-opus-6', mode: 'merge' },
    ])
    await clean(page)
  } finally { await page.close() }
})

// Gemini CLI 下线（yoyo 2026-10-14）：原来挂在它「官方账号」旁边的那句企业版限制也跟着没了；
// 装着它也一样。v4 起配置窗口只管点开的那一个工具，没有工具页签。
test('the configuration dialog has no tool tabs and says nothing about the retired Gemini CLI', async () => {
  const page = await open('allInstalled=1')
  try {
    await openToolConfiguration(page, 'claude')
    const dialog = page.getByTestId('config-dialog')
    await dialog.getByRole('heading', { name: 'Claude Code 配置', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('tablist').count(), 0)
    assert.equal(await page.getByTestId('tool-source-note').count(), 0)
    assert.doesNotMatch(await dialog.innerText(), /Gemini CLI|Google 企业版账号/)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await clean(page)
  } finally { await page.close() }
})

test('configuration keeps the current local key by default and saves through the reuse sentinel', async () => {
  const page = await open('keyOptions=1&cliDefaultModels=1')
  try {
    await openToolConfiguration(page)
    const select = page.getByTestId('tool-key-select')
    await waitForAutomaticKeyOption(page)
    assert.equal(await select.getAttribute('data-value'), 'current')
    assert.match(await select.innerText(), /保持当前.*sk-co••••1234/)
    assert.match(await page.getByTestId('tool-key-summary').innerText(), /继续用现在这把密钥：名称未确认 · sk-co••••1234/)
    assert.doesNotMatch(await page.getByTestId('tool-key-summary').innerText(), /分组|Custom group/)
    // Nothing changed yet: the primary button only closes and writes nothing.
    assert.equal((await page.getByTestId('tool-save-config').innerText()).trim(), '完成')
    await page.getByTestId('tool-detect-models').click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await openConfigAdvanced(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /密钥：名称未确认[\s\S]*分组：分组未确认[\s\S]*sk-co••••1234[\s\S]*fixture-model/)
    await page.getByTestId('tool-default-model').selectOption('gpt-6-astra')
    assert.equal((await page.getByTestId('tool-save-config').innerText()).trim(), '保存配置')
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
    await waitForToast(page, 'Codex CLI 的配置已保存')
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.find((entry) => entry.method === 'saveConfig').args[0], { provider: 'codex', apiKey: '', model: 'gpt-6-astra', mode: 'merge' })
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
    // 读了型号不算改过：点「取消」直接关掉，不弹「不保存」那一条。
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
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

test('configuration stays usable while the model read on open is pending and drops a late answer after it closes', async () => {
  const page = await open('keyOptions=1&cliDefaultModels=1')
  try {
    await page.evaluate(() => window.v2Test.holdConfiguredModels('codex'))
    await openToolConfiguration(page)
    const detect = page.getByTestId('tool-detect-models')
    await expect(detect).toHaveAttribute('aria-busy', 'true')
    assert.equal(await page.locator('.v2-config-controls').evaluate((element) => element.disabled), false)
    assert.equal(await page.getByTestId('tool-key-select').isDisabled(), false)
    const dialog = page.getByTestId('config-dialog')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await openToolConfiguration(page, 'claude')
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

// 已知11：保存时文件被占用这类失败，以前红字只有一句「保存配置没有成功」。
// 现在和页顶红条一个说法：先说是什么原因，原来那句跟在后面；重置的确认也一样（v4 起确认就在「高级」里）。
test('configuration save failures name the cause like the page notice for a save and for a reset', async () => {
  const page = await open('keyOptions=1&cliDefaultModels=1')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('tool-default-model').locator('option[value="gpt-6-astra"]').waitFor({ state: 'attached' })
    await page.getByTestId('tool-default-model').selectOption('gpt-6-astra')
    await page.evaluate(() => {
      window.v2Test.fail = 'saveConfig'
      window.v2Test.failMessage = "EBUSY: resource busy or locked, rename 'C:\\Users\\fixture\\.codex\\config.toml.tmp' -> 'C:\\Users\\fixture\\.codex\\config.toml'"
    })
    await page.getByTestId('tool-save-config').click()
    const dialog = page.getByTestId('config-dialog')
    const alert = dialog.getByRole('alert').filter({ hasText: '保存配置没有成功' })
    await alert.waitFor()
    assert.equal(await alert.locator('strong').innerText(), '工具正在运行')
    assert.match(await alert.innerText(), /文件被占用。先关掉正在使用这个工具的窗口，再重试。/)
    assert.doesNotMatch(await alert.innerText(), /EBUSY|fixture|config\.toml/)
    await openConfigAdvanced(page)
    await page.getByTestId('tool-save-reset').click()
    await page.getByTestId('tool-save-reset-confirm').click()
    await page.waitForFunction(() => window.v2Test.calls.filter((entry) => entry.method === 'saveConfig' && entry.args[0].mode === 'reset').length === 1)
    const resetAlert = dialog.getByRole('alert').filter({ hasText: '保存配置没有成功' })
    await resetAlert.waitFor()
    assert.equal(await resetAlert.locator('strong').innerText(), '工具正在运行')
    await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.failMessage = '' })
    await page.getByTestId('tool-save-config').click()
    await waitForSavedConfiguration(page)
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
    assert.equal(await page.getByTestId('tool-source-account').getAttribute('aria-checked'), 'true')
    assert.equal(await page.getByTestId('tool-key-select').getAttribute('data-value'), 'current')
    assert.equal(await page.getByLabel('星芒密钥', { exact: true }).count(), 0)
    await page.getByTestId('tool-detect-models').click()
    await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    await page.getByLabel('默认模型').selectOption(selectedModel)
    await page.getByTestId('tool-save-config').click()
    await waitForSavedConfiguration(page)
    await matchedToolBadges(page, '已配好')
    await page.getByTestId(`tool-row-${tool}`).getByText(`${selectedModel} · v1.2.3`, { exact: true }).waitFor()
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
    assert.equal(await page.getByTestId('tool-source-account').getAttribute('aria-checked'), 'true')
    assert.equal(await page.getByTestId('tool-key-select').getAttribute('data-value'), 'current')
    assert.equal(await page.getByLabel('默认模型').inputValue(), selectedModel)
    assert.equal(await page.getByLabel('星芒密钥', { exact: true }).count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('selected account key shows its group and survives delayed metadata', async () => {
  const page = await open('keyOptions=1&keyMetadataPending=codex')
  try {
    await openToolConfiguration(page)
    const select = page.getByTestId('tool-key-select')
    await pickOption(page, 'tool-key-select', '202')
    // UI v4: the mask and the group sit on a second line under the key's name.
    await select.click()
    assert.match(await page.getByTestId('tool-key-select-option-202').innerText(), /^custom-key\s+sk-ot••••1234，Custom group分组$/)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.v2Test.releaseKeyMetadata('codex'))
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await select.getAttribute('data-value'), '202')
    await page.getByTestId('tool-detect-models').click()
    await page.getByLabel('默认模型').selectOption('fixture-other')
    await openConfigAdvanced(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /custom-key[\s\S]*Custom group[\s\S]*sk-ot••••1234[\s\S]*fixture-other/)
    await page.getByTestId('tool-save-config').click()
    await waitForSavedConfiguration(page)
    await openToolConfiguration(page)
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-summary"]')?.textContent.includes('custom-key'))
    assert.equal(await select.getAttribute('data-value'), 'current')
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
    await waitForAutomaticKeyOption(page)
    assert.equal(await select.getAttribute('data-value'), 'current')
    // 打开时那把「当前」的 Key 会先读一次模型；改选自动准备以后，保存前不该再读、也不该写。
    const opened = await page.evaluate(() => window.v2Test.calls.length)
    await select.click()
    assert.match(await page.getByTestId('tool-key-select-option-automatic').innerText(), /^自动准备（推荐）\s+保存时自动准备好密钥，不用自己创建$/)
    await page.getByTestId('tool-key-select-option-automatic').click()
    assert.equal(await page.getByTestId('tool-detect-models').count(), 0)
    assert.equal(await page.getByTestId('tool-key-summary').count(), 0)
    const before = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method))
    assert.equal(before.slice(opened).includes('listConfiguredModels') || before.includes('configureManagedCliKeys'), false)
    await openConfigAdvanced(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /xingmang-desktop-codex[\s\S]*Codex_pro[\s\S]*保存时准备或复用/)
    // The automatic key has no models to list until it is written, so the one button saves and then lists them.
    assert.equal((await page.getByTestId('tool-save-config').innerText()).trim(), '保存并检测')
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-detect-notice').waitFor()
    await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).click()
    await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
    await openToolConfiguration(page)
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-key-select"]')?.getAttribute('data-value') === 'current' && document.querySelector('[data-testid="tool-key-summary"]')?.textContent.includes('coding-key'))
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
    await waitForAutomaticKeyOption(page)
    await pickOption(page, 'tool-key-select', 'automatic')
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('tool-save-detect-notice').waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoConfigSaveToast(page)
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

test('failed metadata for another tool does not receive a delayed response from the previous dialog', async () => {
  const page = await open('keyOptions=1&keyMetadataPending=codex&keyMetadataFail=claude')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).click()
    await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
    await openToolConfiguration(page, 'claude')
    await page.getByRole('alert').filter({ hasText: '当前密钥信息暂时没有读到' }).waitFor()
    await page.evaluate(async () => { window.v2Test.releaseKeyMetadata('codex'); await new Promise((resolve) => requestAnimationFrame(resolve)) })
    assert.equal(await page.getByTestId('tool-key-select').getAttribute('data-value'), 'current')
    assert.match(await page.getByTestId('tool-key-summary').innerText(), /sk-cl••••5678/)
    assert.doesNotMatch(await page.getByTestId('tool-key-summary').innerText(), /sk-co••••1234|Codex_pro/)
    await waitForAutomaticKeyOption(page, false)
    await clean(page)
  } finally { await page.close() }
})

test('official source saving does not prepare or replace an account key', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await page.getByTestId('tool-source-official').click()
    await openConfigAdvanced(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /来源：ChatGPT 账号/)
    await page.getByTestId('tool-save-config').click()
    await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
    await waitForToast(page, '已切回官方账号，原来的配置已备份')
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.find((entry) => entry.method === 'switchToOfficialAccount').args, ['codex', 'merge'])
    assert.equal(actions.some((entry) => ['saveConfig', 'configureManagedCliKeys', 'saveConfigWithAccountKey'].includes(entry.method)), false)
    await clean(page)
  } finally { await page.close() }
})

// v4：配置里官方账号那一栏能直接看额度。同一时间只开一个弹窗，所以先关配置再开额度（原型也是这样换过去的）。
test('the official account in the configuration opens the ChatGPT quota in place of the configuration', async () => {
  const page = await open('official=1&officialEmail=1')
  try {
    await openToolConfiguration(page)
    const dialog = page.getByTestId('config-dialog')
    assert.equal(await page.getByTestId('tool-source-official').getAttribute('aria-checked'), 'true')
    await dialog.getByText('chatgpt@example.test', { exact: true }).waitFor()
    await dialog.getByText('Plus，不扣当前账号余额', { exact: true }).waitFor()
    await page.getByTestId('tool-official-quota').click()
    await dialog.waitFor({ state: 'hidden' })
    const quota = page.getByTestId('codex-quota-dialog')
    await quota.waitFor()
    assert.equal(await page.locator('dialog[open]').count(), 1)
    await quota.getByRole('button', { name: '刷新额度' }).click()
    await quota.getByText('已用 28%', { exact: true }).waitFor()
    await quota.getByText('chatgpt@example.test', { exact: true }).waitFor()
    await quota.locator('footer').getByRole('button', { name: '关闭', exact: true }).click()
    await quota.waitFor({ state: 'hidden' })
    await clean(page)
  } finally { await page.close() }
})

test('Chinese locale can be retried after a runtime failure without mistaking the saved preference for success', async () => {
  const page = await open('localeRetry=1')
  try {
    await openToolConfiguration(page, 'codexDesktop')
    await page.getByText('界面语言与文件夹权限', { exact: true }).click()
    // Codex 的中文开关只在从星芒打开时拿得到：这段先说清从哪打开。
    await page.getByText('中文界面只在从星芒打开 Codex 时生效；从开始菜单或任务栏直接打开还是英文。运行中的 Codex 会重新打开，请先保存手头的工作。', { exact: true }).waitFor()
    // v4 drops 「检查中文界面」: opening the section reads the saved preference once.
    await expect(page.getByTestId('tool-config-language').locator('summary small')).toHaveText('中文界面')
    assert.equal(await page.getByRole('button', { name: '检查中文界面', exact: true }).count(), 0)
    await expect(page.getByRole('button', { name: '启用中文界面', exact: true })).toHaveAttribute('aria-pressed', 'true')
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
    assert.match(question, /关掉 Codex，通道也跟着关上。/)
    // 照实说同机别的程序和账户也连得上（#1067），共用电脑的劝先不用。
    assert.match(question, /通道开着时，这台电脑上的其他程序和其他账户也能连上它、控制 Codex；和别人共用这台电脑的，建议选「先不用」。中文只在从星芒打开时生效，直接点 Codex 自己的图标打开还是英文。/)
    assert.doesNotMatch(question, /只有这台电脑自己能连/)

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
    await page.getByText('Codex 已经打开，但这次没换成中文界面。先保存手头的工作，再在首页点「打开」，选「重启 Codex」试一次。', { exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog', { name: '操作没有完成' }).count(), 0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'launchCodexDesktop').map((call) => call.args)), [['open']])
    await clean(page)
  } finally { await page.close() }
})

// 第十一批候选 6：保存不再二选一，「重置」收进「高级」，仍要二次确认（v4 起确认就在原处，不另弹窗）。
test('reset lives under advanced, needs a confirmation and cancelling it keeps the draft without writing', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await open(`keyOptions=1&theme=${theme}`)
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await openToolConfiguration(page)
      await page.getByTestId('tool-source-official').click()
      assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'switchToOfficialAccount')), false)
      await page.getByTestId('tool-source-account').click()
      await pickOption(page, 'tool-key-select', '202')
      assert.equal(await page.getByTestId('tool-save-reset').isVisible(), false)
      await openConfigAdvanced(page)
      const advanced = page.getByTestId('tool-config-advanced')
      assert.match(await page.getByTestId('config-dialog').locator('footer').innerText(), /只改账号、密钥和模型/)
      assert.match(await advanced.locator('.v2-reset-box').innerText(), /重置为初始状态/)
      assert.equal((await page.getByTestId('tool-save-reset').innerText()).trim(), '重置')
      const overflows = () => advanced.evaluate((element) => {
        const bounds = element.getBoundingClientRect()
        return [...element.querySelectorAll('.v2-reset-box button')].some((button) => {
          const rect = button.getBoundingClientRect()
          return button.scrollWidth > button.clientWidth || rect.left < bounds.left || rect.right > bounds.right
        })
      })
      assert.equal(await overflows(), false)
      await advanced.screenshot({ path: path.join(artifacts, `config-advanced-${theme}.png`) })
      await page.getByTestId('tool-save-reset').click()
      await page.getByTestId('tool-save-reset-confirm').waitFor()
      assert.equal(await overflows(), false)
      await advanced.locator('.v2-reset-box').getByRole('button', { name: '取消', exact: true }).click()
      await page.getByTestId('tool-save-reset-confirm').waitFor({ state: 'detached' })
      assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
      assert.equal(await page.getByTestId('tool-key-select').getAttribute('data-value'), '202')
      assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => ['saveConfig', 'saveConfigWithAccountKey', 'configureManagedCliKeys', 'switchToOfficialAccount'].includes(entry.method))), false)
      await clean(page)
    } finally { await page.close() }
  }
})

test('pending merge configuration cannot close or write twice, then closes with a success toast', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await pickOption(page, 'tool-key-select', '202')
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    const save = page.getByTestId('tool-save-config')
    await save.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfigWithAccountKey'))
    assert.equal(await page.getByTestId('tool-save-reset-confirm').count(), 0)
    assert.equal(await save.isDisabled(), true)
    assert.equal(await page.getByTestId('config-dialog').locator('[data-modal-close]').isDisabled(), true)
    assert.equal(await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoConfigSaveToast(page)
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
    await pickOption(page, 'tool-key-select', '202')
    await page.evaluate(() => window.v2Test.holdNextConfigSave())
    await openConfigAdvanced(page)
    await page.getByTestId('tool-save-reset').click()
    const commit = page.getByTestId('tool-save-reset-confirm')
    await commit.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'saveConfigWithAccountKey'))
    assert.equal(await commit.isDisabled(), true)
    assert.equal(await page.locator('.v2-reset-box').getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
    assert.equal(await page.getByTestId('config-dialog').locator('[data-modal-close]').isDisabled(), true)
    assert.equal(await page.getByTestId('config-dialog').locator('footer').getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
    assert.equal(await page.getByTestId('tool-save-config').isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await commit.isVisible(), true)
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoConfigSaveToast(page)
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
    await pickOption(page, 'tool-key-select', '202')
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
    await pickOption(page, 'tool-key-select', '202')
    await page.evaluate(() => { window.v2Test.fail = 'getConfig' })
    await page.getByTestId('tool-save-config').click()
    await waitForSavedConfiguration(page)
    await page.getByTestId('home-config-failure').waitFor()
    for (const tool of ['claude', 'codex', 'grok']) {
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
    await assertNoConfigSaveToast(page)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => ['saveConfig', 'saveConfigWithAccountKey', 'configureManagedCliKeys', 'switchToOfficialAccount'].includes(entry.method))), false)
    await clean(page)
  } finally { await page.close() }
})

for (const source of ['current', 'selected', 'automatic', 'manual', 'official', 'alreadyOfficial']) test(`reset configuration uses the selected ${source} source only after confirmation`, async () => {
  const page = await open(`keyOptions=1&sub2api=1${source === 'alreadyOfficial' ? '&official=1' : ''}`)
  try {
    await openToolConfiguration(page)
    if (source === 'selected') await pickOption(page, 'tool-key-select', '202')
    if (source === 'automatic') {
      await waitForAutomaticKeyOption(page)
      await pickOption(page, 'tool-key-select', 'automatic')
    }
    if (source === 'official') await page.getByTestId('tool-source-official').click()
    if (source === 'manual') {
      await page.getByTestId('tool-manual-key').click()
      await page.getByLabel('星芒密钥').fill('sk-local-fixture-secret')
      await page.getByTestId('tool-detect-models').click()
      await page.waitForFunction(() => !document.querySelector('.v2-config-controls').disabled)
    }
    await openConfigAdvanced(page)
    await page.getByTestId('tool-save-reset').click()
    const confirm = page.getByTestId('tool-save-reset-confirm')
    await confirm.waitFor()
    const writes = () => page.evaluate(() => window.v2Test.calls.filter((entry) => ['saveConfig', 'saveConfigWithAccountKey', 'configureManagedCliKeys', 'switchToOfficialAccount'].includes(entry.method)))
    assert.deepEqual(await writes(), [])
    await confirm.click()
    await page.getByTestId('config-dialog').waitFor({ state: 'hidden' })
    await waitForToast(page, '已重置 Codex CLI 的配置，原来的配置已备份')
    const actions = await writes()
    assert.equal(actions.length, 1)
    if (source === 'official' || source === 'alreadyOfficial') {
      assert.deepEqual(actions[0], { method: 'switchToOfficialAccount', args: ['codex', 'reset'] })
    } else if (source === 'automatic') {
      assert.deepEqual(actions[0], { method: 'configureManagedCliKeys', args: [{ providers: ['codex'], preferredModels: { codex: 'fixture-model' }, mode: 'reset', intent: 'explicit' }] })
    } else if (source === 'selected') {
      assert.deepEqual(actions[0], { method: 'saveConfigWithAccountKey', args: [{ provider: 'codex', keyId: 202, model: 'fixture-model', mode: 'reset' }] })
    } else {
      assert.deepEqual(actions[0], { method: 'saveConfig', args: [{ provider: 'codex', apiKey: source === 'manual' ? 'sk-local-fixture-secret' : '', model: 'fixture-model', mode: 'reset' }] })
    }
    await clean(page)
  } finally { await page.close() }
})

test('failed reset retains the selected key and retries reset without silently merging', async () => {
  const page = await open('keyOptions=1')
  try {
    await openToolConfiguration(page)
    await pickOption(page, 'tool-key-select', '202')
    await openConfigAdvanced(page)
    await page.getByTestId('tool-save-reset').click()
    await page.evaluate(() => { window.v2Test.fail = 'saveConfigWithAccountKey' })
    await page.getByTestId('tool-save-reset-confirm').click()
    await page.getByTestId('config-dialog').getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await page.getByTestId('config-dialog').isVisible(), true)
    await assertNoConfigSaveToast(page)
    assert.match(await page.getByTestId('tool-save-summary').innerText(), /custom-key[\s\S]*Custom group/)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('tool-save-reset-confirm').click()
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
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.getByTestId('tool-grok-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installCli'))
    const methods = await page.evaluate(() => window.v2Test.calls.map((entry) => entry.method).filter((method) => method === 'installNodeRuntime' || method === 'installCli'))
    assert.deepEqual(methods, ['installNodeRuntime', 'installCli'])
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

test('a failed runtime stage says the tool never started and does not run the CLI install', async () => {
  const page = await open('nodeVersionUnknown=1&nodeInstallFail=1')
  try {
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.getByTestId('tool-grok-primary').click()
    await page.getByTestId('operation-error-detail').filter({ hasText: 'Node.js 运行环境没装上，Grok CLI 还没开始安装' }).waitFor()
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
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.getByTestId('tool-grok-primary').click()
    await page.getByTestId('runtime-restart-dialog').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some((entry) => entry.method === 'installCli')), false)
    assert.equal(await page.getByTestId('operation-error-detail').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('an unreadable Node version still blocks the CLI install where the app cannot install Node (R-G6)', async () => {
  const page = await open('nodeVersionUnknown=1&runtimeExternal=1')
  try {
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.getByTestId('tool-grok-primary').click()
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
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.getByTestId('tool-grok-primary').click()
    const dialog = page.getByTestId('operation-error')
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /写不进安装目录/)
    // 这颗按钮已经没有了：本程序按普通权限运行，提权重试等于换一套安装事务。
    assert.equal(await page.getByRole('button', { name: /管理员/ }).count(), 0)
    const target = '/home/fixture/.npm-global/lib/node_modules/@xai-official/grok'
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
    await page.getByTestId('guide-route-grok').check()
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
    await page.getByTestId('guide-route-grok').check()
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

// 第 10 批起 Node.js 没装时在检查页那一行直接「安装 Node.js」，装完首页运行环境卡跟着变。
test('installing Node.js from the check page updates the home runtime card', async () => {
  const page = await open('desktopOnly=1')
  try {
    const node = page.getByTestId('home-runtime-row-node')
    await expect(node).toContainText('未装')
    await stubHealthReport(page, [{ code: 'RUNTIME_NODE', title: 'Node.js', state: 'fail', summary: '还没装 Node.js', details: { installed: false } }])
    await page.getByTestId('nav-health').click()
    const install = page.getByTestId('maintenance-runtime-action-node')
    await expect(install).toHaveText('安装 Node.js')
    await install.click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'installNodeRuntime'))
    await page.getByTestId('nav-home').click()
    await expect(page.getByTestId('home-runtime-row-node')).toContainText('v24.0.0')
    await clean(page)
  } finally { await page.close() }
})

// 已知10：卸载时工具还开着，错误框说「先关掉……再重试」，框里就得真有「重试」可点。
// 卸载已经确认过，点「重试」直接再卸一次，不再问；卸成了确认框一起关掉。
test('an uninstall that hits a running tool offers 重试, which uninstalls again without asking twice', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.evaluate(() => { window.v2Test.fail = 'uninstallCli'; window.v2Test.failMessage = 'Grok CLI 卸载失败：文件被占用，检测到 Grok CLI 正在运行（1 个进程），请关掉它的窗口再试。' })
    await page.getByTestId('tool-row-grok').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '卸载…', exact: true }).click()
    await page.getByRole('dialog', { name: '卸载 Grok CLI？', exact: true }).getByRole('button', { name: '卸载 Grok CLI', exact: true }).click()
    const failure = page.getByTestId('operation-error')
    await failure.getByText('文件被占用。先关掉正在使用这个工具的窗口，再重试。', { exact: true }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.failMessage = '' })
    await page.getByTestId('operation-error-retry').click()
    await page.locator('[data-testid="tool-row-grok"][data-installed="false"]').waitFor()
    assert.equal(await failure.count(), 0)
    assert.equal(await page.getByRole('dialog', { name: '卸载 Grok CLI？', exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli').map((entry) => entry.args[0])), ['grok', 'grok'])
    await clean(page)
  } finally { await page.close() }
})

// 已知32：卸载其实做成了，紧接着的检测没读到。以前弹红色的「操作没有完成」、确认框也不关，
// 客户以为没卸成又点一次。现在确认框照常关，出一条黄色提示；首页顶上检测自己的那句照旧。
test('an uninstall that worked but whose rescan failed closes the dialog and says so instead of failing (known 32)', async () => {
  const page = await open('allInstalled=1')
  try {
    await page.getByTestId('tool-row-grok').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '卸载…', exact: true }).click()
    await page.evaluate(() => { window.v2Test.fail = 'scanSystem'; window.v2Test.failMessage = '检测没有完成，请重试。' })
    await page.getByRole('dialog', { name: '卸载 Grok CLI？', exact: true }).getByRole('button', { name: '卸载 Grok CLI', exact: true }).click()
    await waitForToast(page, 'Grok CLI 已卸载，但最新状态没有读到。请重新检测，无需重复卸载。')
    await expect(page.getByRole('dialog', { name: '卸载 Grok CLI？', exact: true })).toHaveCount(0)
    assert.equal(await page.getByTestId('operation-error').count(), 0)
    const scanFailure = page.getByTestId('home-scan-error').filter({ hasText: '检测没有完成，请重试。' })
    await scanFailure.waitFor()
    // 照提示重新检测：读到了，Grok CLI 卡片回到没装的样子。
    await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.failMessage = '' })
    await scanFailure.getByRole('button', { name: '重新检测', exact: true }).click()
    await page.locator('[data-testid="tool-row-grok"][data-installed="false"]').waitFor()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'uninstallCli').map((entry) => entry.args[0])), ['grok'])
    await clean(page)
  } finally { await page.close() }
})

// 已知32 只管真卸掉了的：以管理员身份运行时转交给命令窗口的那种还没卸完，检测没读到照旧算没做完。
test('a handed-off uninstall whose rescan failed still reports the failure (known 32)', async () => {
  const page = await open('allInstalled=1&uninstallHandOff=1')
  try {
    await page.getByTestId('tool-row-grok').getByRole('button', { name: '更多操作' }).click()
    await page.getByRole('menuitem', { name: '卸载…', exact: true }).click()
    await page.evaluate(() => { window.v2Test.fail = 'scanSystem'; window.v2Test.failMessage = '检测没有完成，请重试。' })
    await page.getByRole('dialog', { name: '卸载 Grok CLI？', exact: true }).getByRole('button', { name: '卸载 Grok CLI', exact: true }).click()
    await page.getByTestId('operation-error').getByText('检测没有完成，请重试。', { exact: true }).waitFor()
    await assertNoToast(page, 'Grok CLI 已卸载，但最新状态没有读到。请重新检测，无需重复卸载。')
    await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.failMessage = '' })
    await clean(page)
  } finally { await page.close() }
})

// 功能 N2 扩展：自检原来只测 Claude Code，另外三个工具配错了只能自己猜。
test('the connection self-check reports every CLI on its own, and an unconfigured tool is not a failure', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-health').click()
    const run = page.getByTestId('health-connection-run')
    await expect(run).toHaveText('测试连接')
    assert.equal(await page.locator('[data-testid^="health-connection-result-"]').count(), 0)
    await run.click()
    // 每个工具一行：行首图标、「工具：结论」；第二句（测了什么）收进「详情」，在这一行下面展开（第 10 批，代替原来的抽屉）。
    const claude = page.getByTestId('health-connection-result-claude')
    await claude.waitFor()
    await expect(claude.locator('.v2-health-line-text')).toHaveText('Claude Code：连接正常，claude-opus-5 可以直接使用')
    await expect(claude.getByRole('img', { name: '正常', exact: true })).toHaveClass(/is-ok/)
    assert.equal(await claude.getByText('已用 claude-opus-5 发过一次最小请求').count(), 0)
    const claudeToggle = page.getByTestId('health-connection-details-claude')
    await claudeToggle.click()
    await expect(claudeToggle).toHaveText('收起')
    await expect(claudeToggle).toHaveAttribute('aria-expanded', 'true')
    await claude.getByTestId('health-connection-details').getByText('已用 claude-opus-5 发过一次最小请求', { exact: true }).waitFor()
    // 一次只展开一行。只读探测的结论要如实说出来，不能照 Claude 那句「发过一次最小请求」套。
    await page.getByTestId('health-connection-details-codex').click()
    await expect(claude.getByTestId('health-connection-details')).toHaveCount(0)
    await expect(claudeToggle).toHaveText('详情')
    await page.getByTestId('health-connection-result-codex').getByTestId('health-connection-details')
      .getByText('已核对当前账号的可用模型清单，gpt-6-astra 在其中', { exact: true }).waitFor()
    await page.getByTestId('health-connection-details-codex').click()
    await expect(page.getByTestId('health-connection-details')).toHaveCount(0)
    for (const provider of ['grok']) {
      const row = page.getByTestId(`health-connection-result-${provider}`)
      // 未配置不是失败：图标是灰的「未配置」，不是红的「有问题」，只给一条「去处理」。
      await expect(row.getByRole('img', { name: '未配置', exact: true })).toHaveClass(/is-neutral/)
      await row.getByRole('button', { name: '去处理', exact: true }).waitFor()
    }
    // 有问题的排前：没配的那条排在正常的两条前面，同一档里照注册表的次序。
    const order = await page.getByTestId('health-connection').locator('[data-testid^="health-connection-result-"]')
      .evaluateAll((rows) => rows.map((row) => row.dataset.testid.replace('health-connection-result-', '')))
    assert.deepEqual(order.filter((id) => ['claude', 'codex', 'grok'].includes(id)), ['grok', 'claude', 'codex'])
    // 已下线的 Gemini CLI 不再自检，也不占一行。
    assert.equal(order.includes('gemini'), false)
    await expect(run).toHaveText('再测一次')
    await clean(page)
  } finally { await page.close() }
})

test('the paid Codex tool-call check requires fresh consent and drops an old-account result', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-health').click()
    const consent = page.getByTestId('health-codex-responses-consent').getByRole('checkbox')
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
    await page.getByTestId('health-codex-responses-result').getByText('Codex 能正常干活', { exact: true }).waitFor()
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
    await page.getByTestId('nav-health').click()
    const consent = page.getByTestId('health-codex-responses-consent').getByRole('checkbox')
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
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-codex-responses-consent').getByRole('checkbox').click()
    await page.getByTestId('health-codex-responses-run').click()
    await page.getByTestId('health-codex-responses-error').getByText('Codex 没测成：账号还在登录中，请等几秒再检查', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'probeCodexResponses').length), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the paid Codex check stays hidden when Codex is not installed', async () => {
  const page = await open('codexMissing=1')
  try {
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
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').click()
    const claude = page.getByTestId('health-connection-result-claude')
    await expect(claude.getByRole('img', { name: '有问题', exact: true })).toHaveClass(/is-bad/)
    await expect(claude.locator('.v2-health-line-text')).toHaveText('Claude Code：当前账号分组下没有可用渠道（HTTP 503）')
    // 接下来怎么办，点「详情」在这一行下面看。
    await page.getByTestId('health-connection-details-claude').click()
    await claude.getByTestId('health-connection-details').waitFor()
    await page.getByTestId('health-connection-details-claude').click()
    // 测不成的那一条是「没测成」，排在「有问题」后面、「未配置」前面。
    const codex = page.getByTestId('health-connection-error-codex')
    await expect(codex.getByRole('img', { name: '没测成', exact: true })).toHaveClass(/is-bad/)
    await expect(codex.locator('.v2-health-line-text')).toHaveText('Codex CLI：自检没能完成')
    const order = await page.getByTestId('health-connection').locator('[data-testid^="health-connection-"]:is([data-testid*="-result-"], [data-testid*="-error-"])')
      .evaluateAll((rows) => rows.map((row) => row.dataset.testid.replace(/^health-connection-(result|error)-/, '')))
    assert.deepEqual(order.filter((id) => ['claude', 'codex', 'grok'].includes(id)), ['claude', 'codex', 'grok'])
    // 分组层的下一步是重签一把 Key，所以这一条给的是「重新写入密钥」（同首页工具卡片那一颗）；仍旧跳页的
    // 那几层（这里是未配置的 Grok）继续给「去处理」。
    await claude.getByRole('button', { name: '重新写入密钥', exact: true }).waitFor()
    await page.getByTestId('health-connection-result-grok').getByRole('button', { name: '去处理', exact: true }).click()
    await page.getByTestId('page-home').waitFor()
    await page.getByTestId('nav-health').click()
    // 一个工具的 IPC 抛错只影响它自己那一条。
    await page.getByTestId('health-connection-run').click()
    await page.getByTestId('health-connection-error-codex').waitFor()
    await page.getByTestId('health-connection-result-grok').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// 候选 1：密钥 / 分组层报错时，按钮要就地把 Key 重写一遍，而不是把用户丢到账号页。
test('the self-check key layer rewrites the current account Key in place and re-runs itself', async () => {
  const page = await open('connectionCredential=1')
  try {
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').click()
    const claude = page.getByTestId('health-connection-result-claude')
    await expect(claude.getByRole('img', { name: '有问题', exact: true })).toHaveClass(/is-bad/)
    await expect(claude.locator('.v2-health-line-text')).toHaveText('Claude Code：密钥被拒绝（HTTP 401）')
    // 账号页上并没有「重新写入密钥」这颗按钮，所以这一层不再给「去处理」。
    assert.equal(await page.getByTestId('health-connection-fix-claude').count(), 0)
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length)
    await page.getByTestId('health-connection-rewrite-claude').click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys').length > count, before)
    const calls = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'configureManagedCliKeys'))
    assert.deepEqual(calls.at(-1).args[0].providers, ['claude'])
    // 写完自己再测一遍：用户不用回到页头再点一次「测试连接」。
    await expect(claude.getByRole('img', { name: '正常', exact: true })).toHaveClass(/is-ok/)
    await expect(claude.locator('.v2-health-line-text')).toHaveText('Claude Code：连接正常，claude-opus-5 可以直接使用')
    await clean(page)
  } finally { await page.close() }
})

test('a failed rewrite says what the backend said instead of claiming it was fixed', async () => {
  const page = await open('connectionCredential=1')
  try {
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').click()
    await page.getByTestId('health-connection-rewrite-claude').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'configureManagedCliKeys'; window.v2Test.failMessage = '当前账号的分组暂时不可用' })
    await page.getByTestId('health-connection-rewrite-claude').click()
    await page.getByText('当前账号的分组暂时不可用', { exact: false }).waitFor()
    // 没写成就不该把结论刷成正常。
    const claude = page.getByTestId('health-connection-result-claude')
    await expect(claude.getByRole('img', { name: '有问题', exact: true })).toHaveClass(/is-bad/)
    await expect(claude.locator('.v2-health-line-text')).toHaveText('Claude Code：密钥被拒绝（HTTP 401）')
    await page.evaluate(() => { window.v2Test.fail = ''; window.v2Test.failMessage = '' })
    await clean(page)
  } finally { await page.close() }
})

// 目录里 keyInvalid 的「一键修复」以前没接线，落到「找客服」。
test('the one-click repair on an invalid key runs the same rewrite', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'installCli'; window.v2Test.failMessage = '安装失败：令牌已失效' })
    await page.getByTestId('tool-grok-primary').click()
    await page.getByTestId('operation-error').waitFor()
    await page.getByTestId('operation-error-body').getByText('工具打不开对话，需要换一把密钥', { exact: true }).waitFor()
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
  await settings.getByRole('tab', { name: '版本更新', exact: true }).click()
  return settings
}

// 从设置重开四步新手引导，选好开始方式，一路点到最后一步。
async function walkGuideToReady(page, route) {
  await openAboutSettings(page)
  await page.getByTestId('settings-start-guide').click()
  const guide = page.getByTestId('start-guide')
  await guide.waitFor()
  await page.getByTestId(`guide-route-${route}`).check()
  for (let turn = 0; turn < 4; turn++) {
    const step = await guide.getAttribute('data-guide-step')
    if (step === 'ready') return guide
    await page.getByTestId('guide-next').click()
    await page.waitForFunction((previous) => document.querySelector('[data-testid="start-guide"]')?.getAttribute('data-guide-step') !== previous, step)
  }
  await expect(guide).toHaveAttribute('data-guide-step', 'ready')
  return guide
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
    // v4：搜索框那步气泡在下面，侧栏两步气泡在右边；当前指着的那一项描金边，看完就撤掉。
    for (const [label, side] of [['下一步', 'below'], ['下一步', 'right'], ['知道了', 'right']]) {
      await expect(tour).toHaveAttribute('data-side', side)
      await expect(page.locator('[data-coach-target="true"]')).toHaveCount(1)
      await tour.getByRole('button', { name: label, exact: true }).click()
    }
    assert.equal(await tour.count(), 0)
    assert.equal(await page.locator('[data-coach-target]').count(), 0)
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

// #1104 第 12 条：引导里点「去聊天」，导览原来开在聊天页上，第二步只能指着侧栏的「首页」念
// 「每个工具一张卡片。点左下角的账号标签…」，左下角正好是侧栏的账号卡。现在导览只在首页放。
test('the interface tour waits for the home page instead of pointing its tool card step at the sidebar', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-claude').waitFor()
    await walkGuideToReady(page, 'chat')
    await page.getByTestId('guide-chat').click()
    // 客户选的是聊天：留在聊天页，导览先不出来。
    await page.getByTestId('page-chat').waitFor()
    const tour = page.getByTestId('shell-guide-tip')
    assert.equal(await tour.count(), 0)
    const target = page.locator('[data-coach-target="true"]')
    await page.getByTestId('nav-home').click()
    await tour.waitFor()
    await expect(tour.locator('small')).toHaveText('1 / 3')
    await expect(target).toHaveClass(/v2-command-trigger/)
    await tour.getByRole('button', { name: '下一步', exact: true }).click()
    await expect(target).toHaveAttribute('data-testid', 'tool-row-claude')
    // 放到一半去了别的页：先收起，回首页接着放这一步。
    await page.getByTestId('nav-chat').click()
    await page.getByTestId('page-chat').waitFor()
    assert.equal(await tour.count(), 0)
    assert.equal(await page.locator('[data-coach-target]').count(), 0)
    await page.getByTestId('nav-home').click()
    await expect(tour.locator('small')).toHaveText('2 / 3')
    await expect(target).toHaveAttribute('data-testid', 'tool-row-claude')
    await expect(tour).toHaveAttribute('data-side', 'right')
    await tour.getByRole('button', { name: '下一步', exact: true }).click()
    await expect(target).toHaveAttribute('data-testid', 'account-entry')
    await tour.getByRole('button', { name: '知道了', exact: true }).click()
    await tour.waitFor({ state: 'detached' })
    await page.reload()
    await waitForFixtureReady(page)
    await page.getByTestId('tool-row-claude').waitFor()
    assert.equal(await tour.count(), 0)
    await clean(page)
  } finally { await page.close() }
})

// 引导里选了「先在星芒里聊天」，「进入首页」以前跟旁边的「去聊天」一样进了聊天页。
test('the guide home button lands on the home page even when chat was chosen', async () => {
  const page = await open()
  try {
    await page.getByTestId('tool-row-claude').waitFor()
    const guide = await walkGuideToReady(page, 'chat')
    await page.getByTestId('guide-home').click()
    await guide.waitFor({ state: 'detached' })
    await page.getByTestId('page-home').waitFor()
    assert.equal(await page.getByTestId('page-chat').count(), 0)
    await expect(page.getByTestId('window-titlebar')).toHaveText('首页')
    // 回的是首页，导览就在这里放。
    await page.getByTestId('shell-guide-tip').waitFor()
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

// v4 问8「卡片」：先在卡片里搜、点开文章；文章里命中的字带底色、含这个词的补充说明展开。回到列表搜索还在。
test('tutorial searches step contents regardless of case and surrounding spaces and recovers from no results', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    const cards = tutorial.locator('[data-testid^="tutorial-card-"]')
    await expect(tutorial.getByTestId('tutorial-cards')).toBeVisible()
    const total = await cards.count()
    assert.ok(total > 10, `all chapters are listed as cards (${total})`)
    await expect(tutorial.getByTestId('tutorial-group-all').locator('.xm-chip-count')).toHaveText(String(total))
    const search = tutorial.getByRole('searchbox', { name: '搜索教程', exact: true })
    await search.fill('  BREW INSTALL PYTHON  ')
    await expect(tutorial.getByTestId('tutorial-card-runtime-mac')).toBeVisible()
    await expect(tutorial.getByTestId('tutorial-card-start')).toHaveCount(0)
    // 分类按钮上的数跟着搜索走。
    const found = await cards.count()
    await expect(tutorial.getByTestId('tutorial-group-all').locator('.xm-chip-count')).toHaveText(String(found))
    await expect(tutorial.getByTestId('tutorial-group-start').locator('.xm-chip-count')).toHaveText('0')
    await expect(search).toBeFocused()
    await tutorial.getByTestId('tutorial-topic-runtime-mac').click()
    const article = tutorial.getByTestId('tutorial-article')
    await expect(article.getByRole('heading', { level: 2 })).toContainText(/Mac|macOS/i)
    await expect(article).toContainText('brew install python')
    // 命中的字带浅黄底，大小写照原文；页面落在第一处命中（这一篇是标题里的 Python）。
    const firstHit = article.locator('mark.v2-tutorial-hit').first()
    await expect(firstHit).toHaveText('Python')
    assert.notEqual(await firstHit.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)')
    await expect.poll(() => insidePageViewport(firstHit)).toBe(true)
    // 「全部教程」回到卡片列表，搜索还在，焦点落回刚才那张卡片。
    await tutorial.getByTestId('tutorial-back').click()
    await expect(search).toHaveValue('  BREW INSTALL PYTHON  ')
    await expect(tutorial.getByTestId('tutorial-topic-runtime-mac')).toBeFocused()

    await search.fill('no-such-tutorial-8472')
    await expect(tutorial.getByRole('heading', { name: '没有找到相关教程', exact: true })).toBeVisible()
    await expect(tutorial.getByText('换个说法试试，或者直接问客服。', { exact: true })).toBeVisible()
    await expect(cards).toHaveCount(0)
    await tutorial.getByRole('button', { name: '清除搜索', exact: true }).click()
    await expect(search).toHaveValue('')
    await expect(cards).toHaveCount(total)

    await search.fill('重新读取时')
    await tutorial.getByTestId('tutorial-topic-start').click()
    const explanation = article.locator('details').filter({ hasText: '重新读取时' })
    await expect(explanation).toHaveCount(1)
    await expect(explanation).toHaveJSProperty('open', true)
    await expect(explanation.getByText(/刚改过配置，需要重新读取时/)).toBeVisible()
    // 只展开含这个词的那一条补充说明，其余照旧收着；页面翻到命中的那几个字。
    const notes = article.locator('details.v2-tutorial-extra')
    await expect.poll(() => notes.evaluateAll((items) => items.filter((item) => item.open).map((item) => item.dataset.extraTitle))).toEqual(['提示 Codex 已在运行？'])
    const explanationHit = explanation.locator('mark.v2-tutorial-hit')
    await expect(explanationHit).toHaveText('重新读取时')
    await expect.poll(() => insidePageViewport(explanationHit)).toBe(true)
    await tutorial.getByTestId('tutorial-back').click()
    await search.fill('安装报错怎么办')
    await tutorial.getByTestId('tutorial-topic-start').click()
    const installationNote = article.locator('details').filter({ hasText: '安装报错怎么办' })
    await expect(installationNote).toHaveJSProperty('open', true)
    await expect(article.locator('details[data-extra-title="装的时候能走开吗？"]')).toHaveJSProperty('open', false)
    await installationNote.locator('summary').click()
    await expect(installationNote).toHaveJSProperty('open', false)
    // 换一个词再搜，自己收起来的那条又展开。
    await tutorial.getByTestId('tutorial-back').click()
    await search.fill('Windows 安装报错')
    await tutorial.getByTestId('tutorial-topic-start').click()
    await expect(installationNote).toHaveJSProperty('open', true)
    await expect(installationNote.getByText(/Windows 安装报错时按提示处理/)).toBeVisible()
    await clean(page)
  } finally { await page.close() }
})

// 第五部分第 32、33 条：读到中间，顶上吸着「第几步」；求助在文章最后。v4：从卡片进、「全部教程」回。
test('tutorial pins the step being read on top and puts help at the end of the article', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    // 卡片写步数和时间；第一张是金色那张，按钮是主按钮「开始」，其余是普通按钮。
    const card = tutorial.getByTestId('tutorial-card-start')
    await expect(card).toContainText('4 步，约 5 分钟')
    await expect(card).toHaveClass(/is-lead/)
    const start = tutorial.getByTestId('tutorial-topic-start')
    await expect(start).toHaveText('开始')
    await expect(start).toHaveClass(/xm-btn-primary/)
    await expect(tutorial.getByTestId('tutorial-topic-install')).toHaveClass(/xm-btn-secondary/)
    await expect(tutorial.locator('.v2-tutorial-card.is-lead')).toHaveCount(1)
    await start.click()
    const article = tutorial.getByTestId('tutorial-article')
    await expect(article).toBeVisible()
    await expect(article).toBeFocused()
    await expect(article.locator('.v2-tutorial-meta')).toContainText('入门')
    await expect(article.locator('.v2-tutorial-meta')).toContainText('4 步，约 5 分钟')
    const progress = tutorial.getByTestId('tutorial-progress')
    await expect(progress).toBeHidden()

    // 点开头的第 3 步：开头滚出去，顶上那条出来，写着第 3 步，第三颗圆点亮着，也不压住第 3 步的标题。
    await article.locator('.v2-tutorial-step-links a').nth(2).click()
    await expect(progress).toBeVisible()
    await expect(progress).toContainText('第 3 步，共 4 步 · 看到「当前账号」就继续')
    await expect(progress.getByRole('button', { name: '第 3 步：看到「当前账号」就继续', exact: true })).toHaveAttribute('aria-current', 'step')
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

    // 求助在每篇最后、「上一篇 / 下一篇」下面。
    const support = article.getByTestId('tutorial-support')
    await expect(support).toContainText('还是不会？')
    const footer = await article.locator('.v2-tutorial-footer').evaluate((element) => element.getBoundingClientRect().toJSON())
    const supportBox = await support.evaluate((element) => element.getBoundingClientRect().toJSON())
    assert.ok(supportBox.top >= footer.bottom, '求助在「上一篇 / 下一篇」下面')
    await support.getByRole('button', { name: '联系客服', exact: true }).click()
    const help = page.getByRole('dialog', { name: '帮助与客服', exact: true })
    await help.waitFor()
    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    // 搜不到时，「联系客服」在「清除搜索」旁边。
    await tutorial.getByTestId('tutorial-back').click()
    await tutorial.getByRole('searchbox', { name: '搜索教程', exact: true }).fill('no-such-tutorial-8472')
    const empty = tutorial.getByTestId('tutorial-empty')
    await empty.getByRole('button', { name: '清除搜索', exact: true }).waitFor()
    await empty.getByRole('button', { name: '联系客服', exact: true }).click()
    await help.waitFor()
    await clean(page)
  } finally { await page.close() }
})

// v4 问8：卡片上记着读完了几步，「继续」翻到没读完的那一步；滚到文章底才算整篇读完；记在这台电脑上，重开还在。
test('tutorial cards remember how far each chapter was read and continue from there', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    const card = tutorial.getByTestId('tutorial-card-start')
    const button = tutorial.getByTestId('tutorial-topic-start')
    await button.click()
    const article = tutorial.getByTestId('tutorial-article')
    const progress = tutorial.getByTestId('tutorial-progress')
    // 打开就走，一步都不算读完。
    await tutorial.getByTestId('tutorial-back').click()
    await expect(button).toHaveText('开始')
    await button.click()
    // 读到第 3 步：前两步算读完了。
    await article.locator('.v2-tutorial-step-links a').nth(2).click()
    await expect(progress).toContainText('第 3 步，共 4 步')
    await tutorial.getByTestId('tutorial-back').click()
    await expect(button).toBeFocused()
    await expect(button).toHaveText('继续')
    await expect(card).toContainText('已完成 2 / 4 步')
    await expect(card.locator('.v2-tutorial-card-steps i.is-done')).toHaveCount(2)
    // 回头看前面不会把进度退回去；「继续」落在第 3 步。
    await button.click()
    await expect(progress).toBeVisible()
    await expect(progress).toContainText('第 3 步，共 4 步')
    await page.getByTestId('page-viewport').evaluate((element) => { element.scrollTop = 0 })
    await expect(progress).toBeHidden()
    await page.getByTestId('page-viewport').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await expect(progress).toContainText('第 4 步，共 4 步')
    await tutorial.getByTestId('tutorial-back').click()
    await expect(card).toContainText('已全部完成')
    await expect(button).toHaveText('再看一遍')
    // 读完的那张不再用主按钮催。
    await expect(button).toHaveClass(/xm-btn-secondary/)
    await page.reload()
    await waitForFixtureReady(page)
    await page.getByTestId('nav-tutorial').click()
    await expect(tutorial.getByTestId('tutorial-topic-start')).toHaveText('再看一遍')
    await expect(tutorial.getByTestId('tutorial-card-install')).toContainText('步，约')
    await clean(page)
  } finally { await page.close() }
})

// 第五部分第 32 条：「全部教程」回到卡片时落在这一篇上。10-24 起 Claude Code 也能在技能页导入（「扩展改」第 2 条），
// 技能页不再有「看怎么放」，教程「技能」篇也不再有「没有导入按钮？」那一条。
test('the skills chapter explains importing for every tool and the card list comes back to it', async () => {
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
    await expect(skills.getByTestId('skills-empty')).toContainText('点「从文件夹导入」，选一个技能文件夹。')
    await expect(skills.getByTestId('skills-import-unsupported')).toHaveCount(0)
    await expect(skills.getByTestId('skills-add').first()).toBeEnabled()
    await page.getByTestId('nav-tutorial').click()
    const tutorial = page.getByTestId('page-tutorial')
    const entry = tutorial.getByTestId('tutorial-topic-skills')
    await entry.click()
    const article = tutorial.getByTestId('tutorial-article')
    await expect(article.getByRole('heading', { level: 2 })).toHaveText('技能')
    await expect(article).toContainText('选好工具，再选一个本机的技能文件夹导入。')
    await expect(article.locator('details[data-extra-title="Claude Code、Grok CLI 没有导入按钮？"]')).toHaveCount(0)
    await tutorial.getByTestId('tutorial-back').click()
    await expect(entry).toBeFocused()
    await expect.poll(() => insidePageViewport(entry)).toBe(true)
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
    await expect(tutorial.getByTestId('tutorial-article').getByRole('heading', { level: 2 })).toHaveText(heading)
    await tutorial.getByTestId('tutorial-back').click()
    await expect(tutorial.getByRole('searchbox', { name: '搜索教程', exact: true })).toHaveValue('MCP')
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
    async function openChapter(id) {
      await page.getByTestId('nav-tutorial').click()
      // 教程页去过就不卸载：上回开着的文章还在，先回到卡片列表。
      const back = tutorial.getByTestId('tutorial-back')
      if (await back.count()) await back.click()
      await tutorial.getByTestId(`tutorial-topic-${id}`).click()
    }
    await openChapter('account')
    await tutorial.getByTestId('tutorial-account-action-2').click()
    await page.getByTestId('account-tabs').waitFor()
    await expect.poll(accountTab).toBe('充值订阅')
    await page.getByTestId('account-tabs').getByRole('tab', { name: '账号安全', exact: true }).click()
    await expect.poll(accountTab).toBe('账号安全')
    for (const [index, label] of [[3, '用量账单'], [1, '密钥管理'], [2, '充值订阅'], [0, '账号概览']]) {
      await openChapter('account')
      await tutorial.getByTestId(`tutorial-account-action-${index}`).click()
      await expect.poll(accountTab).toBe(label)
    }

    await page.getByTestId('nav-settings').click()
    const settings = page.getByTestId('page-settings')
    await settings.getByRole('tab', { name: '版本更新', exact: true }).click()
    await expect(settings.getByRole('tab', { name: '版本更新', exact: true })).toHaveAttribute('aria-selected', 'true')
    for (let visit = 0; visit < 2; visit += 1) {
      await openChapter('safety')
      await tutorial.getByTestId('tutorial-safety-action-2').click()
      await expect(page.getByTestId('page-settings')).toBeVisible()
      await expect(page.getByTestId('page-settings').getByRole('tab', { name: '隐私数据', exact: true })).toHaveAttribute('aria-selected', 'true')
      await page.getByTestId('page-settings').getByRole('tab', { name: '版本更新', exact: true }).click()
    }
    // 从侧栏点「设置」不点名分组，仍停在用户上次看的那组，不会被教程的跳转带偏。
    await page.getByTestId('nav-home').click()
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('page-settings').getByRole('tab', { name: '版本更新', exact: true })).toHaveAttribute('aria-selected', 'true')
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
    await expect(settings.getByRole('tab', { name: '网络加速', exact: true })).toHaveAttribute('aria-selected', 'true')
    await page.waitForFunction(() => document.querySelector('[data-testid="page-settings"] [data-anchor="relay-route-solov"]')?.getAttribute('data-anchor-focus') === 'true')
    // 焦点落在那一排的第一颗按钮上，键盘用户左右键就能换。
    await expect(routeChoice(page.getByTestId('settings-relay-route-solov'), 'auto')).toBeFocused()
    await chooseRoute(page.getByTestId('settings-relay-route-solov'), 'direct')
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

// 直连适配第二步起历史账号也能选直连：它的「去处理」翻到「历史账号线路」那一行。
test('a cut-off network row takes a historical account to its own route setting', async () => {
  const page = await open('sub2api=1')
  try {
    await stubCutOffNetwork(page, 'solov-api')
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-fix-XINGMANG_NETWORK').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="page-settings"] [data-anchor="relay-route-solov-api"]')?.getAttribute('data-anchor-focus') === 'true')
    await expect(routeChoice(page.getByTestId('settings-relay-route-solov-api'), 'auto')).toBeFocused()
    await clean(page)
  } finally { await page.close() }
})

// 访客没有账号，不给，这一行照旧只有结论。开机恢复历史账号时，主进程查的还是默认那个站，
// 那条线路不是这个账号的，也不给。
test('a guest or a check of another site gets no route fix on the cut-off network row', async () => {
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

// 检查页「查网址的服务（DNS）」「别的代理软件」：改 DNS、关代理都在系统设置里，行里直接给按钮，打开哪一页由主进程
// 按 kind 定；系统没让打开时页头说去哪里找。DNS 只错一条、又固定用着错的那条时，另给「去处理」翻到线路那一行。
test('the DNS and proxy rows open the system settings and the wrong fixed line goes to the route setting', async () => {
  const page = await open()
  try {
    await stubHealthReport(page, [
      { code: 'RELAY_DNS', title: '查网址的服务（DNS）', state: 'warn', summary: '你这台电脑用的 DNS 把星芒线路2的地址查错了，线路1是对的。',
        details: { siteId: 'solov', line1: 'ok', line2: 'wrong', fix: 'open-dns-settings', reroute: 'auto' } },
      { code: 'SYSTEM_PROXY_SOFTWARE', title: '别的代理软件', state: 'warn', summary: '系统设置里还开着代理（本机 7890 端口），可是那个代理软件没在运行。',
        details: { systemProxy: 'dead', proxyPort: 7890, fix: 'open-proxy-settings' } },
    ])
    await page.getByTestId('nav-health').click()
    const opened = () => page.evaluate(() => window.v2Test.calls.filter((call) => call.method === 'openNetworkSettings').map((call) => call.args))
    await expect(page.getByTestId('health-network-settings-RELAY_DNS')).toHaveText('打开网络设置')
    await page.getByTestId('health-network-settings-RELAY_DNS').click()
    await expect.poll(opened).toEqual([['dns']])
    await expect(page.getByTestId('health-network-settings-SYSTEM_PROXY_SOFTWARE')).toHaveText('打开系统代理设置')
    await page.getByTestId('health-network-settings-SYSTEM_PROXY_SOFTWARE').click()
    await expect.poll(opened).toEqual([['dns'], ['proxy']])
    // 代理那一行在软件里没有能处理它的地方：不给「去处理」。
    await expect(page.getByTestId('health-fix-SYSTEM_PROXY_SOFTWARE')).toHaveCount(0)
    await page.evaluate(() => { window.xingmang.openNetworkSettings = async () => false })
    await page.getByTestId('health-network-settings-RELAY_DNS').click()
    await expect(page.getByTestId('page-health')).toContainText('没能打开网络设置，请在系统设置里找「网络」。')
    await page.getByTestId('health-fix-RELAY_DNS').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="page-settings"] [data-anchor="relay-route-solov"]')?.getAttribute('data-anchor-focus') === 'true')
    await clean(page)
  } finally { await page.close() }
})

// 顶部搜索能搜到设置里的每一行，靠的是每一行都带着注册表里的 id。这里把注册表和
// 页面对一遍：这台电脑该有的行（含批09 并进来的游戏加速、工具配置备份、版本卡三张卡）一行不少、
// 次序一样，不该有的（Windows 上 Mac 才有的那行「卸载星芒」、不支持自动更新时的「自动下载更新」）不出现。
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
      await expect(settings.locator('#v2-settings-panel .v2-settings-panel-head h2')).toHaveText(group.label)
      await expect.poll(() => settings.locator('#v2-settings-panel [data-anchor]').evaluateAll((rows) => rows.map((row) => row.dataset.anchor)), { message: `「${group.label}」的行` }).toEqual(group.ids)
    }
    await clean(page)
  } finally { await page.close() }
})

// 手机遥控开着时坐在电脑前的人要看得到：状态栏亮「手机遥控中」，点了落到设置里那张卡。
test('the status bar says the phone remote is on and leads to its settings card', async () => {
  const page = await open()
  try {
    await expect(page.getByTestId('statusbar-remote')).toHaveCount(0)
    const feishu = { channel: 'feishu', hasCredential: true, accountLabel: 'cli_a1b2c3d4', enabled: true, status: { state: 'connected' }, boundPeer: null, pairing: null }
    const weixin = { channel: 'weixin', hasCredential: false, accountLabel: null, enabled: false, status: { state: 'stopped' }, boundPeer: null, pairing: null }
    await page.evaluate(([channel, idle]) => window.v2Test.emit('onCodexRemoteStateChanged', { revision: 50, available: true, credentialPersistence: 'durable', workspaceDirectory: '~/projects/demo', task: 'idle', pendingApprovals: 0, channels: { feishu: channel, weixin: idle } }), [feishu, weixin])
    await page.getByTestId('statusbar-remote').click()
    await expect(page.getByTestId('page-settings').getByTestId('settings-remote-card')).toBeVisible()
    // 推来的旧快照（revision 小）不把它关掉。
    await page.evaluate(([channel, idle]) => window.v2Test.emit('onCodexRemoteStateChanged', { revision: 2, available: true, credentialPersistence: 'durable', workspaceDirectory: null, task: 'idle', pendingApprovals: 0, channels: { feishu: { ...channel, enabled: false }, weixin: idle } }), [feishu, weixin])
    await expect(page.getByTestId('statusbar-remote')).toBeVisible()
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
    await settings.getByRole('tab', { name: '网络加速', exact: true }).click()
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
  { code: 'RUNTIME_PYTHON', title: 'Python', state: 'warn', summary: '还没装 Python', details: { installed: false } },
  { code: 'CERTIFICATE_TRUST', title: '安全证书', state: 'pass', summary: '没有发现公司证书' },
  { code: 'CLI_CODEX', title: 'Codex CLI', state: 'fail', summary: 'Codex CLI 打不开' },
]

// 第五部分第 35 条、第六部分第 8 条，第 10 批（v4）：最上面一行结论，下面依次「需要处理」「可选」「正常」三组；
// 正常的只列名字，点「展开」才摆成行；「连接自检」在结果下面。
test('the check page lists problems first, folds the passing items into their names and keeps the self-checks below', async () => {
  const page = await open()
  try {
    await stubHealthReport(page, mixedHealthItems)
    await page.getByTestId('nav-health').click()
    const health = page.getByTestId('page-health')
    await health.getByTestId('health-row-CLI_CODEX').waitFor()
    // 页头：先「导出检查报告」，再主按钮「重新检查」；页底不再有导出。
    const head = await health.locator('.xm-page-head button').evaluateAll((buttons) => buttons.map((button) => button.textContent.trim()))
    assert.deepEqual(head, ['导出检查报告', '重新检查'])
    assert.equal(await health.getByRole('button', { name: '导出检查报告', exact: true }).count(), 1)
    // 结论一行：几项需要处理，什么时候查的、一共几项。
    const summary = health.getByTestId('health-summary')
    await expect(summary.locator('strong')).toHaveText('检查完成：1 项需要处理')
    await expect(summary).toContainText('检查，共 4 项')
    const groups = await health.locator('[data-testid^="health-group-"]').evaluateAll((items) => items.map((item) => item.dataset.testid))
    assert.deepEqual(groups, ['health-group-problem', 'health-group-optional', 'health-group-ok'])
    const rows = await health.locator('[data-testid^="health-row-"], [data-testid="health-passing"]').evaluateAll((items) => items.map((item) => item.dataset.testid))
    assert.deepEqual(rows, ['health-row-CLI_CODEX', 'health-row-RUNTIME_PYTHON', 'health-passing'])
    await expect(health.getByTestId('health-passing')).toHaveText('星芒服务连接安全证书')
    // 没装 Python 是可选的，图标是灰的，不算进「需要处理」。
    await expect(health.getByTestId('health-row-RUNTIME_PYTHON').getByRole('img')).toHaveClass(/is-neutral/)
    await expect(health.getByTestId('health-row-CLI_CODEX').getByRole('img')).toHaveClass(/is-bad/)
    const toggle = health.getByTestId('health-passing-toggle')
    await expect(toggle).toHaveText('展开')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(toggle).toHaveText('收起')
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const expanded = await health.locator('[data-testid^="health-row-"]').evaluateAll((items) => items.map((item) => item.dataset.testid))
    assert.deepEqual(expanded, ['health-row-CLI_CODEX', 'health-row-RUNTIME_PYTHON', 'health-row-XINGMANG_NETWORK', 'health-row-CERTIFICATE_TRUST'])
    assert.equal(await health.getByTestId('health-passing').count(), 0)
    await toggle.click()
    assert.equal(await health.getByTestId('health-row-XINGMANG_NETWORK').count(), 0)
    // 连接自检在结果下面。
    const resultsBottom = await health.getByTestId('health-group-ok').evaluate((element) => element.getBoundingClientRect().bottom)
    const connectionTop = await health.getByTestId('health-connection').evaluate((element) => element.getBoundingClientRect().top)
    assert.ok(resultsBottom < connectionTop, '结果应在「连接自检」上面')
    // 「Codex 干活检查」那一行：勾选在说明下面，「开始检查」在右边。
    const consent = await health.getByTestId('health-codex-responses-consent').evaluate((element) => element.getBoundingClientRect().toJSON())
    const run = await health.getByTestId('health-codex-responses-run').evaluate((element) => element.getBoundingClientRect().toJSON())
    assert.ok(run.left > consent.right, '「开始检查」在勾选右边')
    await clean(page)
  } finally { await page.close() }
})

test('a check page with nothing but passing items says so in one row', async () => {
  const page = await open()
  try {
    await stubHealthReport(page, mixedHealthItems.filter((item) => item.state === 'pass'))
    await page.getByTestId('nav-health').click()
    await expect(page.getByTestId('health-summary').locator('strong')).toHaveText('检查完成：全部正常')
    await expect(page.getByTestId('health-passing')).toHaveText('星芒服务连接安全证书')
    assert.equal(await page.locator('[data-testid^="health-row-"]').count(), 0)
    assert.equal(await page.getByTestId('health-group-problem').count(), 0)
    assert.equal(await page.getByTestId('health-group-optional').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the settings network check opens the passing network item and points at it', async () => {
  const page = await open()
  try {
    await stubHealthReport(page, mixedHealthItems)
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络加速', exact: true }).click()
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
    await expect(health.getByTestId('health-summary').locator('strong')).toHaveText('检查完成：全部正常')
    const first = await healthChecks(page)
    await page.evaluate(() => { window.__health.items = [{ code: 'XINGMANG_NETWORK', title: '星芒服务连接', state: 'fail', summary: '连不上星芒服务' }] })
    // 藏着的检查页不查。
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
    await page.waitForTimeout(100)
    assert.equal(await healthChecks(page), first)
    // 回来不用点「重新检查」就是新结果，结论那一行照旧写什么时候查的。
    await page.getByTestId('nav-health').click()
    await expect(health.getByTestId('health-row-XINGMANG_NETWORK')).toContainText('连不上星芒服务')
    assert.equal(await healthChecks(page), first + 1)
    await expect(health.getByTestId('health-summary')).toContainText('检查，共 1 项')
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
    await expect(health.getByTestId('health-summary').locator('strong')).toHaveText('检查完成：全部正常')
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
    await page.getByTestId('page-settings').getByRole('tab', { name: '网络加速', exact: true }).click()
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

// 改用失败的错误框叫人「到「设置 › 备份迁移」里恢复改用之前的那一份」：去过的备份卡回来时，列表里得有这一份。
test('the backup card in settings lists a backup made while it was hidden once it is shown again', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      window.__backups = []
      window.xingmang.listBackups = async () => window.__backups.map((item) => ({ ...item }))
    })
    const backups = await openBackupCard(page)
    await backups.getByTestId('backups-empty').waitFor()
    await page.getByTestId('nav-home').click()
    await page.getByTestId('page-home').waitFor()
    await page.evaluate(() => {
      window.__backups.push({ id: 'backup-before-switch', provider: 'codex', reason: 'pre-save', createdAt: new Date().toISOString(),
        fileCount: 2, existingFileCount: 2, totalSize: 2048, valid: true, error: null, keyOwnership: 'current', keyAccountName: null })
    })
    // 设置页去过以后只是藏起来，再点「设置」还停在「备份迁移」那组，露面时自己重读一次。
    await page.getByTestId('nav-settings').click()
    await expect(page.getByTestId('page-settings').getByRole('tab', { name: '备份迁移', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(backups.getByTestId('backups-row-backup-before-switch')).toContainText('改 Codex CLI 配置前自动备份')
    await expect(backups.getByTestId('backups-empty')).toHaveCount(0)
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
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-connection-run').click()
    const claude = page.getByTestId('health-connection-result-claude')
    await expect(claude.getByRole('img', { name: '有问题', exact: true })).toHaveClass(/is-bad/)
    await expect(claude.locator('.v2-health-line-text')).toHaveText('Claude Code：连不上星芒服务（连接被重置）')
    await page.getByTestId('health-connection-details-claude').click()
    await claude.getByTestId('health-connection-details').getByText('换个网络或打开加速后再测一次', { exact: true }).waitFor()
    await claude.getByRole('button', { name: '去处理', exact: true }).click()
    const settings = page.getByTestId('page-settings')
    await settings.waitFor()
    await expect(settings.getByRole('tab', { name: '网络加速', exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(settings.locator('#v2-settings-panel .v2-settings-panel-head h2')).toHaveText('网络加速')
    await clean(page)
  } finally { await page.close() }
})

// 帮助与客服弹窗下面那六格（v4 第 10 批，代替「设置里还有」「左边「更多」里还有」那两行）：点了先关弹窗，
// 再落到对应的地方。跑检查、看日志要进主界面，欢迎页里只给不用进主界面的那几格。
test('the help dialog shortcuts close the dialog and land on the tutorial, the feedback tabs and the check page', async () => {
  const page = await open()
  try {
    // 这份夹具本身不带运行日志，落到「反馈与客服」时给一份空的。
    await page.evaluate(() => {
      window.xingmang.getRuntimeLogs = async () => ({ generatedAt: new Date().toISOString(), directory: 'C:/logs', filePath: 'C:/logs/runtime.log', sizeBytes: 0,
        total: 0, truncated: false, counts: { debug: 0, info: 0, warn: 0, error: 0 }, sources: [], currentProcessId: 4242, startedAt: '2026-10-06T00:00:00.000Z', entries: [] })
    })
    async function openHelp() {
      await page.getByTestId('shell-topbar').getByRole('button', { name: '帮助与客服', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '帮助与客服', exact: true })
      await dialog.waitFor()
      return dialog
    }
    const first = await openHelp()
    await expect(first.getByTestId('support-more').getByRole('button')).toHaveText(['使用教程', '留言反馈', '跑一遍检查', '运行日志', '打开下载页', '重开软件'])
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('support-dialog')).toHaveCount(0)
    const feedbackTab = (name) => page.getByTestId('page-feedback').getByRole('tab', { name })
    for (const [id, nav, landed] of [
      ['tutorial', 'nav-tutorial', () => page.getByTestId('page-tutorial').waitFor()],
      ['feedback', 'nav-feedback', () => expect(feedbackTab(/^留言反馈/)).toHaveAttribute('aria-selected', 'true')],
      ['health', 'nav-health', () => page.getByTestId('page-health').waitFor()],
      ['log', 'nav-feedback', () => expect(feedbackTab(/^运行日志/)).toHaveAttribute('aria-selected', 'true')],
    ]) {
      const dialog = await openHelp()
      await dialog.getByTestId(`support-more-${id}`).click()
      await expect(page.getByTestId('support-dialog')).toHaveCount(0)
      await landed()
      await expect(page.getByTestId(nav)).toHaveAttribute('aria-current', 'page')
    }
    const before = await page.evaluate(() => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').length)
    await (await openHelp()).getByTestId('support-more-download').click()
    await page.waitForFunction((count) => window.v2Test.calls.filter((entry) => entry.method === 'openExternal').length > count, before)
    await (await openHelp()).getByTestId('support-more-relaunch').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'relaunchApp'))
    await clean(page)
  } finally { await page.close() }
  const welcome = await open('guest=1')
  try {
    await welcome.getByTestId('welcome-help').click()
    const dialog = welcome.getByRole('dialog', { name: '帮助与客服', exact: true })
    await expect(dialog.getByTestId('support-more').getByRole('button')).toHaveText(['使用教程', '留言反馈', '打开下载页', '重开软件'])
    await clean(welcome)
  } finally { await welcome.close() }
})

// 「启动时检查新版本」原来在「更新」页和设置「版本更新」各有一个开关，两边改的是同一份设置；并进设置后
// 只剩版本卡下面那一行（v4 批09）。改完存下的就是这一份：从别处跳进「设置 › 版本更新」整页重新挂上，
// 读回来的还是改过的样子。
test('the startup update check switched under the version card reads back the same when settings is opened again', async () => {
  const page = await open()
  try {
    const settings = await openSettingsGroup(page, '版本更新')
    const check = settings.getByTestId('updates-check-on-startup').getByRole('switch', { name: '启动时检查新版本', exact: true })
    await expect(check).toBeEnabled()
    await expect(check).toHaveAttribute('aria-checked', 'false')
    await check.click()
    await waitForToast(page, '已保存')
    await expect(check).toHaveAttribute('aria-checked', 'true')
    // 状态栏上的版本号：设置页带着分组整页重新挂一次，开关是重新读回来的。（帮助与客服里那颗「版本更新」第 10 批换成了六格。）
    async function reopen() {
      await page.getByTestId('nav-home').click()
      await page.getByTestId('page-home').waitFor()
      await page.getByTestId('statusbar-version').click()
      await expect(settings.getByRole('tab', { name: '版本更新', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(check).toBeEnabled()
    }
    await reopen()
    await expect(check).toHaveAttribute('aria-checked', 'true')
    await check.click()
    await waitForToast(page, '已保存')
    await expect(check).toHaveAttribute('aria-checked', 'false')
    await reopen()
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
      const cards = tutorial.locator('[data-testid^="tutorial-card-"]')
      await expect(cards.first()).toBeVisible()
      // 卡片两列、不出横向滚动；每张卡片的标题和按钮都在卡片里。
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      await page.screenshot({ path: path.join(artifacts, `tutorial-cards-${theme}.png`), fullPage: true })
      const ids = await cards.evaluateAll((items) => items.map((item) => item.dataset.testid.slice('tutorial-card-'.length)))
      let illustratedSteps = 0
      for (const id of ids) {
        await tutorial.getByTestId(`tutorial-topic-${id}`).click()
        await expect(tutorial.getByTestId('tutorial-article')).toBeVisible()
        const illustrations = tutorial.getByTestId('tutorial-article').locator('[data-tutorial-illustration]')
        for (const illustration of await illustrations.all()) {
          illustratedSteps += 1
          await expect(illustration).toHaveAttribute('aria-label', /\S/)
          assert.equal(await illustration.locator('button, input, select, textarea, a[href], [role="button"]').count(), 0)
          assert.equal(await illustration.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true)
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
        await tutorial.getByTestId('tutorial-back').click()
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
    await tutorial.getByTestId('tutorial-topic-start').click()
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
      await page.getByTestId('nav-tutorial').click()
      const back = tutorial.getByTestId('tutorial-back')
      if (await back.count()) await back.click()
      await search.fill(query)
      await expect(tutorial.getByTestId('tutorial-cards')).toBeVisible()
      await page.getByTestId('nav-home').click()
      const guide = page.getByTestId('tool-opencode-primary')
      await expect(guide).toHaveText('安装指南')
      await guide.click()
      await expect(tutorial.getByTestId('tutorial-article').getByRole('heading', { level: 2 })).toHaveText('Mac 上装桌面端')
      // 指名打开的这一篇不带上回的搜索：回到卡片列表时搜索框是空的。
      await tutorial.getByTestId('tutorial-back').click()
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
    assert.match(await failure.innerText(), /^工具配置暂未读到（本地测试操作失败）。工具列表、安装和卸载照常可用；点工具卡片上的「重新配置」可以重新写入。/)
    assert.equal(await page.getByTestId('tool-row-codex').getByText('未安装', { exact: true }).count(), 0)
    const written = await page.evaluate(() => window.v2Test.calls.filter((entry) => ['syncManagedCliKeys', 'configureManagedCliKeys', 'saveConfig', 'saveConfigWithAccountKey', 'createAccountKey', 'switchAccountSource'].includes(entry.method)))
    assert.deepEqual(written, [])
    await page.getByTestId('nav-health').click()
    await page.getByTestId('page-health').waitFor()
    await openBackupCard(page)
    await page.getByTestId('nav-home').click()
    await page.evaluate(() => { window.v2Test.fail = '' })
    await failure.getByRole('button', { name: '重新检测' }).click()
    await failure.waitFor({ state: 'detached' })
    await connectedBadge(page, 'codex').waitFor()
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
    await page.getByTestId('nav-health').click()
    await page.getByTestId('page-health').waitFor()
    await openBackupCard(page)
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
    assert.equal((await box(page, '.v2-root')).width, 1600)
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

test('a window narrower than the design collapses the sidebar by itself and never saves that as the choice', async () => {
  const page = await open()
  try {
    // 选了 110% 的窗口在 1280 设计宽下只剩 1163 逻辑宽。
    await page.setViewportSize({ width: 1164, height: 820 })
    await page.getByTestId('page-home').waitFor()
    const shell = page.locator('.v2-shell')
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    assert.equal((await box(page, '[data-testid="sidebar"]')).width, 60)
    assert.equal((await box(page, '[data-testid="page-home"]')).width, 1000)
    await page.screenshot({ path: path.join(artifacts, 'shell-narrow-rail.png') })
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').waitFor()
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    assert.equal(await page.evaluate(() => localStorage.getItem('xingmang-v2-sidebar')), null, 'collapsing on its own does not change the saved choice')
    // 窗口拉回 1280：回到自己设的样子（没设过就是展开）。
    await page.setViewportSize({ width: 1280, height: 820 })
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell')
    assert.equal((await box(page, '[data-testid="sidebar"]')).width, 224)
    await clean(page)
  } finally { await page.close() }
})

// 2026-10-20 产品负责人在 Windows 0.2.19 上报「侧边栏无法展开」：窗口逻辑宽约 1092（Windows 放大加上「110%」），
// 侧栏自动收着，点左下角的展开键只弹一句「窗口较窄时侧栏会自动收起」。现在点了就展开：照 224 宽浮在正文上面，
// 正文不挪、不变窄，背后不罩；点外面、按 Esc、再点一次或点了侧栏里的一项都收回窄条，不改自己记的展开/收起。
test('asking for the sidebar in a narrow window floats it over the page until you click away, press Esc or pick a page', async () => {
  const page = await open()
  try {
    await page.setViewportSize({ width: 1092, height: 820 })
    await page.getByTestId('page-home').waitFor()
    const shell = page.locator('.v2-shell')
    const toggle = page.getByTestId('sidebar-collapse')
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    const pageBefore = await box(page, '[data-testid="page-home"]')
    assert.equal(pageBefore.width, 1000)
    async function expand() {
      await toggle.click()
      await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-floating')
    }
    async function folded() {
      await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
      assert.equal((await box(page, '[data-testid="sidebar"]')).width, 60)
    }
    await expand()
    const sidebar = await box(page, '[data-testid="sidebar"]')
    assert.equal(sidebar.width, 224)
    assert.equal(sidebar.left, 0)
    // 侧栏的字、账号卡和余额都回来了，收起键换回「收起侧栏」。
    assert.equal(await page.getByTestId('nav-settings').innerText(), '设置')
    await page.getByTestId('sidebar-account-days').waitFor()
    assert.equal(await toggle.getAttribute('aria-label'), '收起侧栏')
    // 浮在正文上面：正文不挪不缩，侧栏盖住它左边一截，而且在上面（点得到侧栏里的项）。
    assert.deepEqual(await box(page, '[data-testid="page-home"]'), pageBefore)
    assert.ok(sidebar.right > pageBefore.left, `the sidebar covers the page edge (${sidebar.right} / ${pageBefore.left})`)
    assert.equal(await page.evaluate(() => {
      const item = document.querySelector('[data-testid="nav-settings"]').getBoundingClientRect()
      return document.elementFromPoint(item.left + item.width / 2, item.top + item.height / 2)?.closest('[data-testid="nav-settings"]') !== null
    }), true)
    await assertNoToast(page, '窗口较窄时侧栏会自动收起')
    await page.screenshot({ path: path.join(artifacts, 'shell-narrow-floating.png') })
    // 点外面收起（点状态栏中间那段空白，不碰任何按钮）。
    const spacer = await box(page, '.v2-status-spacer')
    const statusbar = await box(page, '[data-testid="shell-statusbar"]')
    assert.ok(spacer.left > sidebar.right && spacer.width > 40, `the status bar has room to click outside the sidebar: ${JSON.stringify(spacer)}`)
    await page.mouse.click(spacer.left + spacer.width / 2, (statusbar.top + statusbar.bottom) / 2)
    await folded()
    // 按 Esc 收起；这一下 Esc 已经被别的浮层（比如抽屉）用掉了就不跟着收，一下只关一层。
    await expand()
    await page.evaluate(() => {
      window.__claimEscape = (event) => { if (event.key === 'Escape') event.preventDefault() }
      document.addEventListener('keydown', window.__claimEscape, true)
    })
    await page.keyboard.press('Escape')
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.equal(await shell.getAttribute('class'), 'v2-shell sidebar-floating')
    await page.evaluate(() => document.removeEventListener('keydown', window.__claimEscape, true))
    await page.keyboard.press('Escape')
    await folded()
    // 再点一次收起。
    await expand()
    await toggle.click()
    await folded()
    // 点了侧栏里的一页：去那一页，侧栏收回去，不挡着刚打开的页。
    await expand()
    await page.getByTestId('nav-settings').click()
    await page.getByTestId('page-settings').waitFor()
    await folded()
    // 自动收起和浮着展开都不改自己记的展开/收起。
    assert.equal(await page.evaluate(() => localStorage.getItem('xingmang-v2-sidebar')), null)
    // 浮着展开时把窗口拉宽：回到自己设的样子；再变窄还是收着的窄条，不会自己浮出来。
    await expand()
    await page.setViewportSize({ width: 1280, height: 820 })
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell')
    await page.setViewportSize({ width: 1092, height: 820 })
    await folded()
    await clean(page)
  } finally { await page.close() }
})

test('a sidebar floated open from the keyboard keeps focus on its toggle and folds when focus leaves it', async () => {
  const page = await open()
  try {
    await page.setViewportSize({ width: 1092, height: 820 })
    const shell = page.locator('.v2-shell')
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    await page.getByTestId('sidebar-collapse').focus()
    await page.keyboard.press('Enter')
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-floating')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '收起侧栏')
    // 焦点离开侧栏（交给正文）：侧栏收回去，不留在那儿挡着焦点所在的地方。
    await page.getByTestId('page-viewport').focus()
    await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    await clean(page)
  } finally { await page.close() }
})

// #1361：窄条图标的名字提示以前冒在图标正下方、还接鼠标，正好盖住下一个图标的大半截；鼠标从「首页」挪到「聊天」
// 点下去，点到的是「首页」的提示，页面不动。照 v4 原型改成冒在图标右边、不接鼠标。
test('a rail icon names itself beside the rail, so moving down to the next icon clicks that icon', async () => {
  const page = await open()
  try {
    await page.setViewportSize({ width: 1092, height: 820 })
    await page.getByTestId('page-home').waitFor()
    await expect.poll(() => page.locator('.v2-shell').getAttribute('class')).toBe('v2-shell sidebar-collapsed')
    const sidebar = await box(page, '[data-testid="sidebar"]')
    const home = await box(page, '[data-testid="nav-home"]')
    const chat = await box(page, '[data-testid="nav-chat"]')
    await page.mouse.move(home.left + home.width / 2, (home.top + home.bottom) / 2)
    const tip = page.getByRole('tooltip')
    await expect(tip).toHaveText('首页')
    await expect(tip).toBeVisible()
    const placed = await tip.evaluate((element) => {
      const { left, top, bottom } = element.getBoundingClientRect()
      return { left, top, bottom, pointerEvents: getComputedStyle(element).pointerEvents }
    })
    assert.ok(placed.left >= sidebar.right, `the tip sits beside the rail (${placed.left} / ${sidebar.right})`)
    assert.ok(placed.top < home.bottom && placed.bottom > home.top, `the tip is level with its icon (${placed.top}-${placed.bottom} / ${home.top}-${home.bottom})`)
    assert.equal(placed.pointerEvents, 'none')
    // 跟客户一样一路往下挪，不先挪开再回来。
    const target = { x: chat.left + chat.width / 2, y: (chat.top + chat.bottom) / 2 }
    await page.mouse.move(target.x, target.y, { steps: 8 })
    assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'), target), 'nav-chat')
    await expect(page.getByRole('tooltip')).toHaveText('聊天')
    await page.mouse.down()
    await page.mouse.up()
    await page.getByTestId('page-chat').waitFor()
    await clean(page)
  } finally { await page.close() }
})

// #1349 第 1 条：顶栏整条是拖动区，Electron 把那里的鼠标按下交给系统拖窗口，页面收不到 pointerdown、焦点也不动，
// 浮着的侧栏点顶栏空白处收不回。无头 Chromium 不认拖动区，这里钉的是样式：浮着时侧栏外面一处拖动区都没有，
// 收回、拉宽以后顶栏照常能拖。真机上点顶栏能不能收，以真机为准。
test('a floating sidebar leaves no window drag region outside it, so clicking the empty top bar folds it', async () => {
  for (const os of ['windows', 'mac']) {
    const page = await open(os === 'mac' ? 'os=mac' : '')
    try {
      await page.setViewportSize({ width: 1092, height: 820 })
      await page.getByTestId('page-home').waitFor()
      const shell = page.locator('.v2-shell')
      const topbar = page.getByTestId('shell-topbar')
      function region(locator) { return locator.evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region')) }
      await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
      assert.equal(await region(topbar), 'drag', `${os}: the top bar drags the window while the sidebar is a rail`)
      await page.getByTestId('sidebar-collapse').click()
      await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-floating')
      assert.deepEqual(await page.evaluate(() => {
        const sidebar = document.querySelector('[data-testid="sidebar"]')
        return [...document.querySelectorAll('body *')]
          .filter((element) => !sidebar.contains(element) && getComputedStyle(element).getPropertyValue('-webkit-app-region') === 'drag')
          .map((element) => element.getAttribute('data-testid') ?? element.className)
      }), [], `${os}: nothing outside the floating sidebar swallows a click as a window drag`)
      // 点顶栏左边那段空白（侧栏右边、搜索框左边，不碰任何按钮）。
      const sidebar = await box(page, '[data-testid="sidebar"]')
      const search = await box(page, '.v2-command-trigger')
      const bar = await box(page, '[data-testid="shell-topbar"]')
      assert.ok(search.left - sidebar.right > 40, `${os}: the top bar has room to click beside the sidebar (${sidebar.right} / ${search.left})`)
      const point = { x: (sidebar.right + search.left) / 2, y: (bar.top + bar.bottom) / 2 }
      assert.equal(await page.evaluate(({ x, y }) => {
        const target = document.elementFromPoint(x, y)
        return Boolean(target?.closest('[data-testid="shell-topbar"]')) && !target.closest('button, a, input')
      }, point), true, `${os}: the click lands on the empty top bar`)
      await page.mouse.click(point.x, point.y)
      await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell sidebar-collapsed')
      assert.equal(await region(topbar), 'drag', `${os}: the top bar drags the window again once the sidebar folds`)
      await page.setViewportSize({ width: 1280, height: 820 })
      await expect.poll(() => shell.getAttribute('class')).toBe('v2-shell')
      assert.equal(await region(topbar), 'drag', `${os}: the top bar drags the window in a wide window`)
      await clean(page)
    } finally { await page.close() }
  }
})

// #1133 第 3、4 条：最小窗口选 110% 只剩 970×566 逻辑大小。收成窄条的侧栏一项不少地放得下，不滚、不渐隐
// （Mac 顶上还要让红黄绿三个点）；状态栏里历史账号那种长邮箱先省略、悬停看全文，网络状态一个字不少。
test('the smallest window at 110% fits the collapsed sidebar and shortens a long email before the network status', async () => {
  for (const os of ['windows', 'mac']) {
    const page = await open(os === 'mac' ? 'longUsername=1&os=mac' : 'longUsername=1')
    try {
      await page.setViewportSize({ width: 970, height: 566 })
      await expect.poll(() => page.locator('.v2-shell').getAttribute('class')).toBe('v2-shell sidebar-collapsed')
      assert.equal(await page.locator('.v2-root').getAttribute('data-os'), os === 'mac' ? 'mac' : 'win')
      const scroller = page.getByTestId('sidebar-scroll')
      await expect.poll(() => scroller.getAttribute('data-fade')).toBe(null)
      const sidebar = await scroller.evaluate((element) => ({
        overflow: element.scrollHeight - element.clientHeight,
        bottom: element.getBoundingClientRect().bottom,
        feedback: document.querySelector('[data-testid="nav-feedback"]').getBoundingClientRect().bottom,
        settings: document.querySelector('[data-testid="nav-settings"]').getBoundingClientRect().top,
      }))
      assert.ok(sidebar.overflow <= 0, `${os}: the collapsed sidebar overflows by ${sidebar.overflow}px`)
      assert.ok(sidebar.feedback <= sidebar.bottom && sidebar.bottom <= sidebar.settings, `${os}: every entry is in view above 设置: ${JSON.stringify(sidebar)}`)
      const email = '已登录 zhangwei.developer2026@company-mail.com.cn'
      const status = await page.getByTestId('shell-statusbar').evaluate((bar) => {
        const user = bar.querySelector('[data-testid="statusbar-user"]')
        const network = bar.querySelector('[data-testid="shell-network-location"] > span')
        return {
          barOverflow: bar.scrollWidth - bar.clientWidth,
          userWidth: user.getBoundingClientRect().width, userCut: user.firstElementChild.scrollWidth > user.firstElementChild.clientWidth,
          userText: user.textContent, userTitle: user.getAttribute('title'),
          network: network.textContent, networkCut: network.scrollWidth > network.clientWidth,
        }
      })
      assert.ok(status.barOverflow <= 0, `${os}: the status bar overflows by ${status.barOverflow}px`)
      assert.ok(status.userWidth <= 220.5 && status.userCut, `${os}: the long email is shortened: ${JSON.stringify(status)}`)
      assert.deepEqual([status.userText, status.userTitle], [email, email], `${os}: the full email stays on hover`)
      assert.deepEqual([status.network, status.networkCut], ['网络正常', false], `${os}: the network status is shown in full`)
      await clean(page)
    } finally { await page.close() }
  }
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

// 欢迎页没有侧栏和状态栏：开机提示卡放在左下角会压住那行链接和底下四格（Windows 原生冒烟点「减少动画」
// 就是被「已更新到 …」挡住的），欢迎页上它在右上角、星轨那片装饰上面。
test('the startup card on the welcome page stays clear of the links and the feature row', async () => {
  const page = await open('guest=1&justUpdated=1')
  try {
    await page.setViewportSize({ width: 1280, height: 660 })
    await page.getByTestId('welcome-page').waitFor()
    const card = page.getByTestId('startup-notices-list').locator('.xm-notice').first()
    await card.waitFor()
    const notice = await card.boundingBox()
    for (const selector of ['.auth-welcome-copy', '.auth-welcome-foot']) {
      const other = await page.locator(selector).boundingBox()
      const apart = notice.x >= other.x + other.width || notice.x + notice.width <= other.x || notice.y >= other.y + other.height || notice.y + notice.height <= other.y
      assert.ok(apart, `the startup card must not cover ${selector}: ${JSON.stringify({ notice, other })}`)
    }
    // 改动列表再长也只在卡里滚：整摞卡最高也到不了底下四格。
    const reach = await page.getByTestId('startup-notices').evaluate((element) => element.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(element).maxHeight))
    const foot = await page.locator('.auth-welcome-foot').boundingBox()
    assert.ok(reach <= foot.y, `the startup cards must stop above the feature row: ${JSON.stringify({ reach, foot })}`)
    await page.getByTestId('welcome-motion').click({ timeout: 5000 })
    await clean(page)
  } finally { await page.close() }
})

// v4 不用抽屉（yoyo 10-13）：记录详情是居中的弹窗，背后罩住；Esc 关掉，焦点回到点开它的那一行。
test('a record opens in a modal dialog that closes with Esc and hands focus back to its row', async () => {
  const page = await open('recentWorkspaces=1')
  try {
    await page.getByTestId('nav-sessions').click()
    const rows = page.locator('[data-testid^="sessions-view-"]')
    await rows.nth(1).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByTestId('session-detail-drawer')
    await dialog.getByRole('heading', { name: '会话 2', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.querySelector(':modal')?.getAttribute('data-testid')), 'session-detail-drawer')
    assert.equal(await dialog.evaluate((element) => element.classList.contains('xm-dialog-640')), true)
    // 文件夹没了的那条：弹窗里说清楚接不上，「接着聊」按不动。
    assert.equal(await dialog.locator('.v2-session-detail-gone').innerText(), '项目文件夹 C:\\work\\older-app 已经不在了，接不上上次的对话。')
    assert.equal(await dialog.getByTestId('session-detail-resume').isDisabled(), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
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
    assert.equal(await offline.getByRole('button').last().textContent(), '重试')
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
    // 账号卡平时没有刷新键，第一次从首页刷新；读失败了卡片上才出「更新失败」和刷新键。
    await page.getByTestId('home-balance-refresh').click()
    await page.getByTestId('account-entry').getByText('更新失败', { exact: true }).waitFor()
    await page.getByTestId('sidebar-balance-refresh').click()
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
    await expect.poll(() => environment.textContent()).toBe('2 项需要处理')
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

// 已知6：状态栏那句是上一次检查的结论。在首页装好工具、改好设置以后它就说不准了，退回灰点「环境待检测」，不再挂着
// 原来的数；只是打开工具不改环境，不算。点进检查页重查一遍，跟着变。
test('the status bar drops back to not-checked once a tool was installed, and follows the next check (已知6)', async () => {
  const page = await open('diagnostics=1&diagnosticIssues=2&recentWorkspaces=1')
  try {
    const environment = page.getByTestId('statusbar-environment')
    await expect.poll(() => environment.textContent()).toBe('2 项需要处理')
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.disabled === false)
    await page.getByTestId('tool-claude-primary').click()
    await page.waitForFunction(() => window.v2Test.calls.some((entry) => entry.method === 'launchCli'))
    await page.waitForFunction(() => document.querySelector('[data-testid="tool-claude-primary"]')?.disabled === false)
    assert.equal(await environment.textContent(), '2 项需要处理')
    await page.getByTestId('tool-row-grok').getByText('未安装').waitFor()
    await page.getByTestId('tool-grok-primary').click()
    await connectedBadge(page, 'grok').waitFor()
    await expect.poll(() => environment.textContent()).toBe('环境待检测')
    assert.equal(await environment.locator('.v2-dot').getAttribute('class'), 'v2-dot')
    await environment.click()
    await page.getByTestId('page-health').waitFor()
    await expect.poll(() => environment.textContent()).toBe('2 项需要处理')
    await clean(page)
  } finally { await page.close() }
})

// 检查页开着的时候在这一页重新写了 Key：状态栏退回「环境待检测」，这一页跟着重查一遍，不用再点「重新检查」，两处说的一样。
test('the check page checks again by itself when the environment changed while it is shown (已知6)', async () => {
  const page = await open('connectionCredential=1&diagnosticIssues=1')
  try {
    await page.getByTestId('nav-health').click()
    const environment = page.getByTestId('statusbar-environment')
    await expect.poll(() => environment.textContent()).toBe('1 项需要处理')
    await page.waitForTimeout(100)
    const checks = await healthChecks(page)
    await page.getByTestId('health-connection-run').click()
    await page.getByTestId('health-connection-rewrite-claude').click()
    await expect.poll(() => healthChecks(page)).toBe(checks + 1)
    await expect.poll(() => environment.textContent()).toBe('1 项需要处理')
    await clean(page)
  } finally { await page.close() }
})

// 同原型 .page：页头下面的结论、各组和「连接自检」之间一律隔 16；卡片里的行贴着卡片边框，长说明不把标题挤成两行。
// （原来量的是「安装卸载」页那几张卡，那一页第 10 批拆掉了，换成检查页。）
test('sections on the check page sit 16 apart, the rows in a card reach its edges and a long note leaves the title on one line', async () => {
  const page = await open()
  try {
    await stubHealthReport(page, mixedHealthItems)
    await page.getByTestId('nav-health').click()
    await page.getByTestId('health-row-CLI_CODEX').waitFor()
    await page.getByTestId('health-codex-responses').waitFor()
    const layout = await page.evaluate(() => {
      const health = document.querySelector('[data-testid="page-health"]')
      const blocks = [...health.children].filter((element) => !element.classList.contains('xm-page-head') && element.getBoundingClientRect().height > 0)
      const gaps = blocks.slice(1).map((block, index) => Math.round(block.getBoundingClientRect().top - blocks[index].getBoundingClientRect().bottom))
      const card = document.querySelector('[data-testid="health-connection"]')
      const box = card.getBoundingClientRect()
      const edges = [...card.querySelectorAll(':scope > .xm-list-row')].flatMap((row) => {
        const rowBox = row.getBoundingClientRect()
        return [rowBox.left - box.left, box.right - rowBox.right].map(Math.round)
      })
      return { count: blocks.length, gaps, edges }
    })
    // 结论一行、需要处理、可选、正常、连接自检。
    assert.equal(layout.count, 5)
    assert.deepEqual(layout.gaps, layout.gaps.map(() => 16))
    // 卡片自己有 1 像素边框，两行都贴着它。
    assert.deepEqual(layout.edges, [1, 1, 1, 1])
    const title = await page.getByTestId('health-codex-responses').locator('.xm-row-title').evaluate((element) => ({ height: element.getBoundingClientRect().height, line: parseFloat(getComputedStyle(element).lineHeight) }))
    assert.ok(title.height < title.line * 1.5, `the title stays on one line (${title.height})`)
    await clean(page)
  } finally { await page.close() }
})
