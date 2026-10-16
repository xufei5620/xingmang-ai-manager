import assert from 'node:assert/strict'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { before, after, test } from 'node:test'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { openFixturePage, waitForFixtureMount } from '../../../../e2e/fixture-readiness.mjs'
import { enterWorkspaceWithoutAccount } from '../../testing/guest-workspace.mjs'

let server, browser, origin
before(async () => {
  ;({ server, origin } = await createFixtureServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error' }))
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open(query = 'accelerationPreview=1', { initScript } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  if (initScript) await page.addInitScript(initScript)
  await page.clock.install({ time: new Date('2026-09-14T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-14T00:00:01Z'))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  // Mounting and asserting are two different waits: the click below retries on
  // Playwright's 30s action default, which a cold Windows open of this fixture
  // can outlast, and it would be reported as the settings nav never
  // appearing. Take the shared mount budget first; everything after it keeps
  // the default so a real regression still fails in 30s.
  //
  // On #768 (2026-10-02) this open spent that whole budget on a page that never
  // mounted while the cases either side passed in 2-5s, so the budget is spent
  // as up to three navigations rather than one. The clock installed above is
  // replayed into every new document, so a second navigation starts from the
  // same paused time; the mount is polled from Node because that clock also
  // pauses Playwright's in-page polling.
  await openFixturePage(page, `${origin}/src/renderer-v2/testing/app.html?${query}`,
    (timeout) => waitForFixtureMount(page, { timeout, what: 'the acceleration fixture' }), { label: 'acceleration fixture' })
  if (new URLSearchParams(query).get('guest') === '1') await enterWorkspaceWithoutAccount(page)
  await openLazyAcceleration(page)
  return page
}
// v4 批09 起游戏加速是「设置 › 网络加速」最上面的一张卡，侧栏没有单独的入口了。
// 卡只在设置页翻到这一组时才挂上；连接本身挂在 App 上，离开设置页照样连着、照样计时。
function networkTab(page) {
  return page.getByTestId('page-settings').getByRole('tab', { name: '网络加速', exact: true })
}
async function goToAcceleration(page) {
  await page.getByTestId('nav-settings').click()
  await networkTab(page).click()
}
// 状态栏网络那一项只写「网络正常 · 国家」或「加速中 · 线路名」，国家和 IP 在悬停说明里。
function locationTitled(page, place) {
  return page.locator(`[data-testid="shell-network-location"][title^="${place}；"]`)
}
async function openLazyAcceleration(page) {
  const accelerationModule = page.waitForResponse((response) => response.url().includes('/features/acceleration/AccelerationPage.tsx'))
  await page.getByTestId('nav-settings').click()
  // The settings page is itself a lazy chunk on its first visit, and its
  // Suspense reveal waits on the same frozen clock. Nothing is connected yet
  // here, so nudging the clock until the group tabs show cannot skew a timer;
  // later visits (goToAcceleration) find the page kept alive and never need it.
  const deadline = Date.now() + 30_000
  while (!(await networkTab(page).count()) && Date.now() < deadline) {
    await page.clock.runFor(100)
    await delay(50)
  }
  await networkTab(page).click()
  await accelerationModule
  // React's Suspense reveal uses the browser clock, which this fixture freezes.
  await page.clock.runFor(500)
  await page.getByTestId('acceleration-page').waitFor()
}
async function clean(page) {
  assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  assert.deepEqual(await page.evaluate(() => window.v2Test.unexpected), [])
  await page.close()
}
// 剩余时长现在是说明行里的半句话（「剩余免费时长 19 分 50 秒」）；不知道剩多少时（没登录、
// 用完、线路准备中）这个数整个不出现，后半句换成计时规则。
const remaining = page => page.getByTestId('acceleration-quota-remaining')
function lead(page) {
  return page.getByTestId('acceleration-page').locator('.acceleration-lead')
}
async function openLineMenu(page) {
  await page.getByTestId('acceleration-line-picker-toggle').click()
  const menu = page.getByRole('menu', { name: '选择线路' })
  await menu.waitFor()
  return menu
}
function focusedTestId(page) {
  return page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)
}
// The menu moves focus in an effect after it has been placed, and the fixture's
// frozen clock also pauses Playwright's in-page polling, so poll from Node.
async function eventually(read, expected, message) {
  const deadline = Date.now() + 5000
  let value = await read()
  while (!isDeepStrictEqual(value, expected) && Date.now() < deadline) {
    await delay(25)
    value = await read()
  }
  assert.deepEqual(value, expected, message)
}
function callsTo(page, method) {
  return page.evaluate((name) => window.v2Test.calls.filter(call => call.method === name).map(call => call.args), method)
}

test('lists selectable acceleration lines, re-measures latency and switches back to automatic selection before connecting', async () => {
  const page = await open()
  try {
    const card = page.getByTestId('acceleration-page')
    // 卡片标题以前是舞台左上角那行英文 GAME CONNECT。
    assert.equal((await card.getByRole('heading', { level: 2 }).innerText()).trim(), '游戏加速')
    const toggle = page.getByTestId('acceleration-line-picker-toggle')
    const currentLine = page.getByTestId('acceleration-line-current')
    assert.equal(await currentLine.innerText(), '自动选择')
    let menu = await openLineMenu(page)
    const auto = page.getByTestId('acceleration-line-auto')
    const japan = page.getByTestId('acceleration-line-option-preview-jp')
    const singapore = page.getByTestId('acceleration-line-option-preview-sg')
    const america = page.getByTestId('acceleration-line-option-preview-us')
    const choices = menu.getByRole('menuitemradio')
    assert.equal(await choices.count(), 4)
    assert.equal(await choices.first().getAttribute('data-testid'), 'acceleration-line-auto')
    assert.equal(await auto.getAttribute('aria-checked'), 'true')
    await auto.getByText('连接时选最快的线路', { exact: true }).waitFor()
    await singapore.getByText('SG', { exact: true }).waitFor()

    // 原来每条线路各有一颗「检测延迟」；现在菜单底下一项「重新测速」，重读名单后逐条测一遍。
    const listsBefore = (await callsTo(page, 'listAccelerationLines')).length
    assert.deepEqual(await callsTo(page, 'pingAccelerationLine'), [])
    await page.getByTestId('acceleration-line-refresh').click()
    await menu.waitFor({ state: 'hidden' })
    await eventually(async () => (await callsTo(page, 'pingAccelerationLine')).map(args => args[1]), ['preview-jp', 'preview-sg', 'preview-us'], 'every listed line is measured once, one after another')
    assert.equal((await callsTo(page, 'listAccelerationLines')).length, listsBefore + 1)
    menu = await openLineMenu(page)
    await japan.getByText('最快 · 188 ms', { exact: true }).waitFor()
    await singapore.getByText('242 ms', { exact: true }).waitFor()
    await america.getByText('356 ms', { exact: true }).waitFor()
    assert.equal(await auto.getAttribute('aria-checked'), 'true', 're-measuring does not change the choice')

    await singapore.click()
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await currentLine.innerText(), '新加坡线路 2 · 242 ms')
    menu = await openLineMenu(page)
    assert.equal(await singapore.getAttribute('aria-checked'), 'true')
    assert.equal(await auto.getAttribute('aria-checked'), 'false')
    // 再点一次同一条还是它，不会被当成「取消选择」退回自动。
    await singapore.click()
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await currentLine.innerText(), '新加坡线路 2 · 242 ms')
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.find(call => call.method === 'startAcceleration')?.args), ['xm-account:17', 'system-proxy', 'preview-sg'])
    // 连着时线路按钮还摆着、写的是连上的那条，只是点不了。
    assert.equal(await toggle.isDisabled(), true)
    assert.equal(await currentLine.innerText(), '新加坡线路 2 · 242 ms')
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    menu = await openLineMenu(page)
    await auto.click()
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await currentLine.innerText(), '自动选择')
    menu = await openLineMenu(page)
    assert.equal(await auto.getAttribute('aria-checked'), 'true')
    assert.equal(await singapore.getAttribute('aria-checked'), 'false')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    assert.deepEqual(await callsTo(page, 'startAcceleration'), [
      ['xm-account:17', 'system-proxy', 'preview-sg'],
      ['xm-account:17', 'system-proxy'],
    ])
    // 自动选择连上以后，按钮写出它替你选的那条。
    assert.equal(await currentLine.innerText(), '自动选择（日本线路 1） · 188 ms')
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('the line menu moves focus with the arrows without choosing, Enter or Space chooses and Escape closes back on the button', async () => {
  const page = await open()
  try {
    const toggle = page.getByTestId('acceleration-line-picker-toggle')
    const currentLine = page.getByTestId('acceleration-line-current')
    const menu = page.getByRole('menu', { name: '选择线路' })
    const choices = menu.getByRole('menuitemradio')
    const checked = () => choices.evaluateAll(rows => rows.filter(row => row.getAttribute('aria-checked') === 'true').map(row => row.getAttribute('data-testid')))
    assert.equal(await toggle.getAttribute('aria-haspopup'), 'menu')

    await toggle.focus()
    await page.keyboard.press('Enter')
    await menu.waitFor()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(await choices.count(), 4)
    await eventually(() => focusedTestId(page), 'acceleration-line-auto', 'opening the menu puts focus on its first item')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const second = await choices.nth(2).getAttribute('data-testid')
    assert.equal(await focusedTestId(page), second)
    assert.deepEqual(await checked(), ['acceleration-line-auto'], 'moving with the arrows does not change the choice')
    // 「重新测速」是菜单的最后一项，方向键也能走到它；走到头会绕回第一项。
    await page.keyboard.press('End')
    assert.equal(await focusedTestId(page), 'acceleration-line-refresh')
    await page.keyboard.press('ArrowDown')
    assert.equal(await focusedTestId(page), 'acceleration-line-auto', 'the last item wraps to the first')
    await page.keyboard.press('ArrowUp')
    assert.equal(await focusedTestId(page), 'acceleration-line-refresh', 'the first item wraps to the last')
    await page.keyboard.press('ArrowUp')
    const last = await choices.nth(3).getAttribute('data-testid')
    assert.equal(await focusedTestId(page), last)
    assert.deepEqual(await checked(), ['acceleration-line-auto'])

    await page.keyboard.press('Enter')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await focusedTestId(page), 'acceleration-line-picker-toggle', 'choosing closes the menu back on the button')
    assert.equal(await currentLine.innerText(), '美国线路 3 · 356 ms')

    await page.keyboard.press(' ')
    await menu.waitFor()
    assert.deepEqual(await checked(), [last])
    await eventually(() => focusedTestId(page), 'acceleration-line-auto')
    await page.keyboard.press('End')
    await page.keyboard.press('Home')
    assert.equal(await focusedTestId(page), 'acceleration-line-auto')
    await page.keyboard.press(' ')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await currentLine.innerText(), '自动选择')

    await page.keyboard.press('Enter')
    await menu.waitFor()
    assert.deepEqual(await checked(), ['acceleration-line-auto'])
    await eventually(() => focusedTestId(page), 'acceleration-line-auto')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await focusedTestId(page), 'acceleration-line-picker-toggle', 'Escape returns focus to the button')
    assert.equal(await currentLine.innerText(), '自动选择', 'Escape leaves the choice alone')

    // 菜单不是 Tab 陷阱：按 Tab 就收起。
    await page.keyboard.press('Enter')
    await menu.waitFor()
    await eventually(() => focusedTestId(page), 'acceleration-line-auto')
    await page.keyboard.press('Tab')
    await menu.waitFor({ state: 'hidden' })
    assert.equal(await currentLine.innerText(), '自动选择')
  } finally { await clean(page) }
})

test('network location refreshes on connect and disconnect, stays synced on other pages and supports retry', async () => {
  const page = await open()
  try {
    const location = page.getByTestId('shell-network-location')
    await location.click()
    await locationTitled(page, '中国 · 198.51.100.18').waitFor()
    assert.equal(await location.innerText(), '网络正常 · 中国')
    const scansBefore = await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'scanSystem').length)
    await page.getByTestId('acceleration-session-start').click()
    await locationTitled(page, '新加坡 · 203.0.113.24').waitFor()
    assert.match(await location.innerText(), /^加速中 · .+线路 \d$/)
    await page.getByTestId('nav-home').click()
    const refreshes = await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'refreshNetworkLocation').length)
    await page.clock.runFor(20_000)
    assert.equal(await location.getAttribute('title'), '新加坡 · 203.0.113.24；点击刷新网络位置')
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'refreshNetworkLocation').length), refreshes)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'scanSystem').length), scansBefore)
    await goToAcceleration(page)
    await page.getByTestId('acceleration-session-stop').click()
    await locationTitled(page, '中国 · 198.51.100.18').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'refreshNetworkLocation' })
    await location.click()
    await page.locator('[data-testid="shell-network-location"]:not([title^="中国"])').filter({ hasText: /^网络正常$/ }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = '' })
    await location.click()
    await locationTitled(page, '中国 · 198.51.100.18').waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('failed stop retains the last connected location until a confirmed disconnect', async () => {
  const page = await open()
  try {
    const location = page.getByTestId('shell-network-location')
    await page.getByTestId('acceleration-session-start').click()
    await locationTitled(page, '新加坡 · 203.0.113.24').waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'stopAcceleration' })
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await location.getAttribute('title'), '新加坡 · 203.0.113.24；点击刷新网络位置')
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('acceleration-session-stop').click()
    await locationTitled(page, '中国 · 198.51.100.18').waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('acceleration trial counts only connected time, survives navigation, pauses and resumes without resetting the twenty-minute trial', async () => {
  const page = await open()
  try {
    await page.getByTestId('acceleration-session-start').waitFor()
    assert.equal(await remaining(page).innerText(), '20 分钟')
    assert.match(await lead(page).innerText(), /剩余免费时长 20 分钟$/)
    await page.clock.runFor(5000)
    assert.equal(await remaining(page).innerText(), '20 分钟')
    // 加速只走系统代理，页面上不再有那颗从没开放过的模式开关（第二十一批 6）。
    assert.equal(await page.getByRole('switch', { name: 'TUN 模式' }).count(), 0)
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    await page.clock.runFor(10_000)
    assert.equal(await remaining(page).innerText(), '19 分 50 秒')
    assert.equal(await page.getByTestId('acceleration-session-duration').innerText(), '10 秒')
    await page.getByTestId('nav-home').click()
    await page.clock.runFor(10_000)
    await goToAcceleration(page)
    assert.equal(await remaining(page).innerText(), '19 分 40 秒')
    assert.equal(await page.getByTestId('acceleration-session-duration').innerText(), '20 秒')
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    await page.clock.runFor(20_000)
    assert.equal(await remaining(page).innerText(), '19 分 40 秒')
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    await page.clock.runFor(5000)
    assert.equal(await remaining(page).innerText(), '19 分 35 秒')
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    await page.reload()
    await openLazyAcceleration(page)
    await page.getByTestId('acceleration-session-start').waitFor()
    assert.equal(await remaining(page).innerText(), '19 分 35 秒')
    assert.equal(await page.locator('.acceleration-preview').innerText(), '交互预览')
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

// React 找得到这个钩子就会在每次提交后调一次 onCommitFiberRoot（React DevTools 用的
// 就是它），数它就知道界面这段时间重画了几回。
function countReactCommits() {
  window.__reactCommits = 0
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(),
    inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
    onCommitFiberRoot() { window.__reactCommits++ },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  }
}

test('a running session does not re-render the app every second while another page is open', async () => {
  const page = await open('accelerationPreview=1', { initScript: countReactCommits })
  try {
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    await page.clock.runFor(3000)
    const onPage = await page.evaluate(() => window.__reactCommits)
    await page.clock.runFor(5000)
    // 游戏加速卡自己还是每秒走表，确认钩子确实数得到提交。
    assert.ok(await page.evaluate(() => window.__reactCommits) - onPage >= 4)
    await page.getByTestId('nav-home').click()
    await page.clock.runFor(1000)
    const onHome = await page.evaluate(() => window.__reactCommits)
    await page.clock.runFor(10_000)
    assert.equal(await page.evaluate(() => window.__reactCommits) - onHome, 0)
    await goToAcceleration(page)
    assert.equal(await remaining(page).innerText(), '19 分 41 秒')
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('a legacy thirty-five-minute remainder migrates to exhausted rather than a fresh twenty-minute trial', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      localStorage.removeItem('xingmang-acceleration-preview:v2:xm-account:17')
      localStorage.setItem('xingmang-acceleration-preview:xm-account:17', String(35 * 60 * 1000))
    })
    await page.reload()
    await openLazyAcceleration(page)
    await page.getByTestId('acceleration-contact-support').filter({ hasText: '联系客服' }).waitFor()
    // 用完以后说明行不再写剩余时长（原来是 00:00:00），换成「已经用完」的说法。
    assert.equal(await remaining(page).count(), 0)
    assert.match(await lead(page).innerText(), /免费体验已经用完，后续服务请联系客服$/)
    assert.equal(await page.getByTestId('acceleration-session-start').count(), 0)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xingmang-acceleration-preview:v2:xm-account:17')).usedMilliseconds), 25 * 60 * 1000)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('exhaustion stops the session once even when the acceleration card is hidden', async () => {
  const page = await open('accelerationPreview=1&accelerationShort=1')
  try {
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    await page.getByTestId('nav-home').click()
    await page.clock.runFor(10_000)
    await goToAcceleration(page)
    await page.getByTestId('acceleration-contact-support').filter({ hasText: '联系客服' }).waitFor()
    assert.equal(await remaining(page).count(), 0)
    assert.match(await lead(page).innerText(), /免费体验已经用完，后续服务请联系客服$/)
    assert.equal(await page.getByTestId('acceleration-session-start').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'stopAcceleration').length), 1)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('an unavailable production connection does not invent an entitlement, endpoint or countdown', async () => {
  const page = await open('')
  try {
    const start = page.getByTestId('acceleration-session-start')
    await start.filter({ hasText: '线路准备中' }).waitFor()
    assert.equal(await start.isDisabled(), true)
    // 不知道剩多少就不写数（原来是 --:--:--），只说准备好之前不计时。
    assert.equal(await remaining(page).count(), 0)
    assert.match(await lead(page).innerText(), /服务准备完成后即可开启，当前不消耗时长$/)
    await page.clock.runFor(60_000)
    assert.equal(await remaining(page).count(), 0)
    assert.match(await lead(page).innerText(), /服务准备完成后即可开启，当前不消耗时长$/)
    assert.equal(await page.locator('.acceleration-preview').count(), 0)
    assert.equal(await page.evaluate(() => window.v2Test.calls.some(call => call.method === 'startAcceleration')), false)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('failed start preserves the full trial and failed stop stays active until retried', async () => {
  const page = await open()
  try {
    await page.evaluate(() => { window.v2Test.fail = 'startAcceleration' })
    await page.getByTestId('acceleration-session-start').click()
    await page.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await remaining(page).innerText(), '20 分钟')
    assert.equal(await page.getByTestId('acceleration-phase').innerText(), '上次没连上')
    // 出错条留在游戏加速卡里、开关那一行下面，不会跑到别的设置卡中间去。
    const strip = await page.getByTestId('acceleration-error').boundingBox()
    const main = await page.locator('.acceleration-card-main').boundingBox()
    const card = await page.getByTestId('acceleration-page').boundingBox()
    assert.ok(strip.y >= main.y + main.height && strip.y + strip.height <= card.y + card.height,
      `the failure strip sits inside the card under the start row: ${JSON.stringify({ strip, main, card })}`)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    await page.clock.runFor(5000)
    await page.evaluate(() => { window.v2Test.fail = 'stopAcceleration' })
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await page.getByTestId('acceleration-page').getAttribute('data-phase'), 'active')
    await page.clock.runFor(5000)
    assert.equal(await remaining(page).innerText(), '19 分 50 秒')
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('logged out users see the acceleration card with a working login action', async () => {
  const page = await open('guest=1&existing=1')
  try {
    await page.getByTestId('acceleration-session-start').filter({ hasText: '登录领取免费体验' }).click()
    await page.getByTestId('login-account').waitFor()
    assert.equal(await page.evaluate(() => window.v2Test.calls.some(call => call.method === 'getAccelerationState')), false)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

const bonusCode = 'XM-NEBULA-10M-7Q9K'
async function bonusPalette(page, code = bonusCode) {
  await page.getByTestId('shell-topbar').getByRole('button', { name: /搜索或跳转/ }).click()
  const palette = page.getByTestId('command-palette')
  const input = palette.getByRole('searchbox', { name: '搜索或跳转' })
  if (code) await input.fill(code)
  return { palette, input, action: page.getByTestId('command-acceleration-bonus'), feedback: page.getByTestId('command-acceleration-feedback') }
}
async function bonusCalls(page) {
  return page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'redeemAccelerationCode'))
}

test('bonus palette requires the complete code and explicit non-IME submit, shares one pending request, and refreshes the authoritative quota', async () => {
  const page = await open('accelerationPreview=1&accelerationBonusPending=1')
  try {
    const { palette, input, action, feedback } = await bonusPalette(page, '')
    assert.equal(await action.count(), 0)
    assert.equal((await palette.innerText()).includes(bonusCode), false)
    await input.fill(bonusCode.slice(0, -1))
    assert.equal(await action.count(), 0)
    await input.press('Enter')
    assert.equal((await bonusCalls(page)).length, 0)
    await input.fill(`  ${bonusCode.toLowerCase()}  `)
    await action.waitFor()
    assert.equal((await bonusCalls(page)).length, 0)
    await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    assert.equal((await bonusCalls(page)).length, 0)
    await input.press('ArrowDown')
    await input.press('ArrowUp')
    assert.equal(await action.getAttribute('aria-selected'), 'true')
    await input.press('Enter')
    await action.filter({ hasText: '正在领取' }).waitFor()
    await input.press('Enter')
    assert.equal(await action.isDisabled(), true)
    assert.deepEqual((await bonusCalls(page)).map(call => call.args), [['xm-account:17', bonusCode]])
    assert.equal(await remaining(page).innerText(), '20 分钟')
    assert.equal(await feedback.count(), 0)
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await feedback.filter({ hasText: '领取成功，已增加 10 分钟' }).waitFor()
    assert.equal(await remaining(page).innerText(), '30 分钟')
    await action.click()
    await action.filter({ hasText: '正在领取' }).waitFor()
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await feedback.filter({ hasText: '当前账号已在本机领取过' }).waitFor()
    assert.equal(await remaining(page).innerText(), '30 分钟')
    assert.equal((await bonusCalls(page)).length, 2)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('bonus palette preserves page search, arrows, IME Enter and Escape focus restoration', async () => {
  const page = await open()
  try {
    const { palette, input, action } = await bonusPalette(page, '')
    const options = palette.getByRole('option')
    assert.equal(await options.first().getAttribute('aria-selected'), 'true')
    await input.press('ArrowDown')
    assert.equal(await options.nth(1).getAttribute('aria-selected'), 'true')
    await input.press('ArrowUp')
    assert.equal(await options.first().getAttribute('aria-selected'), 'true')
    // 游戏加速卡就在设置页里，搜「设置」跳过去等于原地不动；改搜首页，确实换了页才算跳成。
    await input.fill('首页')
    await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    assert.equal(await palette.isVisible(), true)
    assert.equal(await action.count(), 0)
    await input.press('Enter')
    await palette.waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('nav-home').getAttribute('aria-current'), 'page')
    await page.getByTestId('shell-topbar').getByRole('button', { name: /搜索或跳转/ }).click()
    await input.press('Escape')
    await palette.waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('shell-topbar').getByRole('button', { name: /搜索或跳转/ }).evaluate(element => document.activeElement === element), true)
    assert.equal((await bonusCalls(page)).length, 0)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('bonus redemption failures preserve time and allow retry; signed-out submit only asks for login', async () => {
  const page = await open()
  try {
    const { input, action, feedback } = await bonusPalette(page)
    await page.evaluate(() => { window.v2Test.fail = 'redeemAccelerationCode' })
    await input.press('Enter')
    await feedback.filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await remaining(page).innerText(), '20 分钟')
    assert.equal(await action.isEnabled(), true)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await action.click()
    await feedback.filter({ hasText: '领取成功' }).waitFor()
    assert.equal(await remaining(page).innerText(), '30 分钟')
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
  const guest = await open('guest=1&existing=1&accelerationPreview=1')
  try {
    const { action, feedback } = await bonusPalette(guest)
    await action.click()
    await feedback.filter({ hasText: '请先登录星芒账号' }).waitFor()
    assert.equal((await bonusCalls(guest)).length, 0)
    // 没登录不写剩余时长（原来是 --:--:--），只说每个账号能领多少。
    assert.equal(await remaining(guest).count(), 0)
    assert.match(await lead(guest).innerText(), /每个账号可领取 20 分钟免费体验$/)
    await clean(guest)
  } finally { if (!guest.isClosed()) await guest.close() }
})

test('bonus redemption cannot show an old account credit after an account switch', async () => {
  const page = await open('accelerationPreview=1&accelerationBonusPending=1')
  try {
    const { input, action } = await bonusPalette(page)
    await input.press('Enter')
    await action.filter({ hasText: '正在领取' }).waitFor()
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: true, account: { userId: 18, username: 'next-user', group: 'default', role: 1, quota: 1_000_000, usedQuota: 0 } }))
    await page.getByRole('button', { name: /^个人中心：next-user(，|$)/ }).waitFor()
    await goToAcceleration(page)
    await page.clock.runFor(500)
    await remaining(page).waitFor()
    assert.equal(await remaining(page).innerText(), '20 分钟')
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await page.clock.runFor(1)
    assert.equal(await remaining(page).innerText(), '20 分钟')
    assert.equal(await page.getByTestId('command-acceleration-feedback').count(), 0)
    const next = await bonusPalette(page)
    await next.action.click()
    await next.action.filter({ hasText: '正在领取' }).waitFor()
    assert.deepEqual((await bonusCalls(page)).map(call => call.args[0]), ['xm-account:17', 'xm-account:18'])
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await next.feedback.filter({ hasText: '领取成功' }).waitFor()
    assert.equal(await remaining(page).innerText(), '30 分钟')
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('closing and reopening the bonus palette does not display a stale success message', async () => {
  const page = await open('accelerationPreview=1&accelerationBonusPending=1')
  try {
    const first = await bonusPalette(page)
    await first.input.press('Enter')
    await first.action.filter({ hasText: '正在领取' }).waitFor()
    await first.input.press('Escape')
    // Native search fields clear their text on the first Escape; preserve that
    // existing interaction and use the next Escape to close the dialog.
    assert.equal(await first.input.inputValue(), '')
    await first.input.press('Escape')
    await first.palette.waitFor({ state: 'hidden' })
    const reopened = await bonusPalette(page, '')
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await page.clock.runFor(1)
    assert.equal(await remaining(page).innerText(), '30 分钟')
    assert.equal(await reopened.feedback.count(), 0)
    assert.equal(await reopened.action.count(), 0)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

// 免费时长用完：主按钮直接打开「帮助与客服」，不再给换线路。
test('an exhausted trial turns the main button into contacting support and hides the line picker', async () => {
  const page = await open()
  try {
    await page.evaluate(() => {
      localStorage.removeItem('xingmang-acceleration-preview:v2:xm-account:17')
      localStorage.setItem('xingmang-acceleration-preview:xm-account:17', String(35 * 60 * 1000))
    })
    await page.reload()
    await openLazyAcceleration(page)
    const contact = page.getByTestId('acceleration-contact-support')
    await contact.filter({ hasText: '联系客服' }).waitFor()
    assert.equal(await contact.isDisabled(), false)
    assert.equal(await page.getByText('免费体验已经用完，后续服务请联系客服').count(), 1)
    assert.equal(await page.getByTestId('acceleration-line-picker-toggle').count(), 0)
    assert.equal(await page.locator('.acceleration-line-row').count(), 0)
    assert.equal(await page.getByTestId('acceleration-status-refresh').count(), 0)
    await contact.click()
    await page.getByTestId('support-dialog').waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

// 失败后再点「开启加速」或「重新检查」，状态就不再停在「上次没连上」。
test('the failed-start label clears once the user checks again', async () => {
  const page = await open()
  try {
    await page.evaluate(() => { window.v2Test.fail = 'startAcceleration' })
    await page.getByTestId('acceleration-session-start').filter({ hasText: '开启加速' }).click()
    await page.getByTestId('acceleration-error').waitFor()
    assert.equal(await page.getByTestId('acceleration-phase').innerText(), '上次没连上')
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('acceleration-error').getByRole('button', { name: '重新检查' }).click()
    await page.getByTestId('acceleration-phase').filter({ hasText: '准备就绪' }).waitFor({ state: 'attached' })
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

// 线路一行是小字「线路」跟一颗带边框的菜单按钮；菜单贴着按钮左边往外展开，不出窗口。
test('the line picker follows its label as an outlined menu button and its menu opens from the button edge', async () => {
  const page = await open()
  try {
    const row = page.locator('.acceleration-line-row')
    const toggle = page.getByTestId('acceleration-line-picker-toggle')
    const label = await row.getByText('线路', { exact: true }).boundingBox()
    const button = await toggle.boundingBox()
    const rowBox = await row.boundingBox()
    assert.ok(button.x >= label.x + label.width, `the button follows the label: ${JSON.stringify({ label, button })}`)
    assert.ok(button.y >= rowBox.y && button.y + button.height <= rowBox.y + rowBox.height, 'the button is inside the line row')
    assert.ok(label.y + label.height / 2 >= button.y && label.y + label.height / 2 <= button.y + button.height, 'the label and the button share one line')
    assert.notEqual(await toggle.evaluate(element => getComputedStyle(element).borderTopColor), 'rgba(0, 0, 0, 0)')
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    const menu = page.getByRole('menu', { name: '选择线路' })
    await menu.waitFor()
    const list = await menu.boundingBox()
    assert.ok(Math.abs(list.x - button.x) <= 1, `the menu lines up with the button's left edge: ${JSON.stringify({ list, button })}`)
    assert.ok(list.y >= button.y + button.height, `the menu opens under the button when there is room: ${JSON.stringify({ list, button })}`)
    assert.ok(list.x + list.width <= 1280 && list.y + list.height <= 860, 'the menu stays inside the window')
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

// 窗口 1280×560 时，进「设置 › 网络加速」不用滚动就能看见「开启加速」。
test('the start button is on the first screen of a 1280 by 560 window', async () => {
  const page = await open()
  try {
    await page.setViewportSize({ width: 1280, height: 560 })
    const start = page.getByTestId('acceleration-session-start')
    await start.filter({ hasText: '开启加速' }).waitFor()
    const box = await start.boundingBox()
    const statusbar = await page.locator('.v2-statusbar').boundingBox()
    assert.ok(box.y >= 0 && box.y + box.height <= (statusbar?.y ?? 560), `the start button is visible without scrolling: ${JSON.stringify({ box, statusbar })}`)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})
