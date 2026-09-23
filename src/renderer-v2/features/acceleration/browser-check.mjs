import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, test } from 'node:test'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { waitForFixtureMount } from '../../../../e2e/fixture-readiness.mjs'
import { enterWorkspaceWithoutAccount } from '../../testing/guest-workspace.mjs'

let server, browser, origin
before(async () => {
  ;({ server, origin } = await createFixtureServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error' }))
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open(query = 'accelerationPreview=1') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await page.clock.install({ time: new Date('2026-09-14T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-14T00:00:01Z'))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/src/renderer-v2/testing/app.html?${query}`)
  // Mounting and asserting are two different waits: the click below retries on
  // Playwright's 30s action default, which a cold Windows open of this fixture
  // can outlast, and it would be reported as the acceleration nav never
  // appearing. Take the shared mount budget first; everything after it keeps
  // the default so a real regression still fails in 30s.
  await waitForFixtureMount(page, { what: 'the acceleration fixture' })
  if (new URLSearchParams(query).get('guest') === '1') await enterWorkspaceWithoutAccount(page)
  await openLazyAcceleration(page)
  return page
}
async function openLazyAcceleration(page) {
  const accelerationModule = page.waitForResponse((response) => response.url().includes('/features/acceleration/AccelerationPage.tsx'))
  await page.getByTestId('nav-acceleration').click()
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
const remaining = page => page.getByTestId('acceleration-quota-remaining')

test('lists selectable acceleration lines, checks ping and switches back to smart allocation before connecting', async () => {
  const page = await open()
  try {
    await page.getByTestId('acceleration-line-picker-toggle').click()
    const list = page.getByRole('listbox', { name: '加速线路选择' })
    const auto = page.getByTestId('acceleration-line-auto')
    const singapore = page.getByTestId('acceleration-line-option-preview-sg')
    const currentLine = page.getByTestId('acceleration-line-current')
    assert.equal(await list.getByRole('option').count(), 4)
    assert.equal(await list.getByRole('option').first().getAttribute('data-testid'), 'acceleration-line-auto')
    assert.equal(await auto.getAttribute('aria-selected'), 'true')
    await auto.getByText('连接时自动测速，选择最快可用线路', { exact: true }).waitFor()
    await singapore.getByRole('button', { name: '检测新加坡线路 2延迟', exact: true }).click()
    await singapore.getByText('242 ms', { exact: true }).waitFor()
    const chooseSingapore = singapore.getByRole('button', { name: /新加坡线路 2/ }).filter({ hasText: '新加坡线路 2' })
    await chooseSingapore.click()
    assert.equal(await singapore.getAttribute('aria-selected'), 'true')
    assert.equal(await auto.getAttribute('aria-selected'), 'false')
    await chooseSingapore.click()
    assert.equal(await singapore.getAttribute('aria-selected'), 'true')
    assert.match(await currentLine.innerText(), /^新加坡线路 2\s*SG$/)
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.find(call => call.method === 'startAcceleration')?.args), ['xm-account:17', 'system-proxy', 'preview-sg'])
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    if (!await auto.isVisible()) await page.getByTestId('acceleration-line-picker-toggle').click()
    await auto.getByRole('button').click()
    assert.equal(await auto.getAttribute('aria-selected'), 'true')
    assert.equal(await singapore.getAttribute('aria-selected'), 'false')
    assert.equal(await currentLine.innerText(), '智能分配')
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    assert.deepEqual(await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'startAcceleration').map(call => call.args)), [
      ['xm-account:17', 'system-proxy', 'preview-sg'],
      ['xm-account:17', 'system-proxy'],
    ])
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('the line list is one Tab stop: arrows move between rows without choosing, Enter or Space chooses', async () => {
  const page = await open()
  try {
    await page.getByTestId('acceleration-line-picker-toggle').click()
    const list = page.getByRole('listbox', { name: '加速线路选择' })
    const options = list.getByRole('option')
    assert.equal(await options.count(), 4)
    const stops = await options.evaluateAll(rows => rows.map(row => row.tabIndex))
    assert.deepEqual(stops, [0, -1, -1, -1], 'only the selected row sits in the Tab order')
    const focusedRow = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
    const selected = () => options.evaluateAll(rows => rows.filter(row => row.getAttribute('aria-selected') === 'true').map(row => row.getAttribute('data-testid')))

    await page.getByTestId('acceleration-line-auto').focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    const second = await options.nth(2).getAttribute('data-testid')
    assert.equal(await focusedRow(), second)
    assert.deepEqual(await selected(), ['acceleration-line-auto'], 'moving with the arrows does not change the choice')
    await page.keyboard.press('End')
    const last = await options.nth(3).getAttribute('data-testid')
    assert.equal(await focusedRow(), last)
    await page.keyboard.press('ArrowDown')
    assert.equal(await focusedRow(), last, 'the last row does not wrap to the first')

    await page.keyboard.press('Enter')
    assert.deepEqual(await selected(), [last])
    await page.keyboard.press('Home')
    assert.equal(await focusedRow(), 'acceleration-line-auto')
    await page.keyboard.press(' ')
    assert.deepEqual(await selected(), ['acceleration-line-auto'])
    assert.equal(await page.getByTestId('acceleration-line-current').innerText(), '智能分配')
  } finally { await clean(page) }
})

test('network location refreshes on connect and disconnect, stays synced on other pages and supports retry', async () => {
  const page = await open()
  try {
    const location = page.getByTestId('shell-network-location')
    await location.click()
    await location.filter({ hasText: '中国 · 198.51.100.18' }).waitFor()
    const scansBefore = await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'scanSystem').length)
    await page.getByTestId('acceleration-session-start').click()
    await location.filter({ hasText: '新加坡 · 203.0.113.24' }).waitFor()
    await page.getByTestId('nav-home').click()
    const refreshes = await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'refreshNetworkLocation').length)
    await page.clock.runFor(20_000)
    assert.equal(await location.innerText(), '新加坡 · 203.0.113.24')
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'refreshNetworkLocation').length), refreshes)
    assert.equal(await page.evaluate(() => window.v2Test.calls.filter(call => call.method === 'scanSystem').length), scansBefore)
    await page.getByTestId('nav-acceleration').click()
    await page.getByTestId('acceleration-session-stop').click()
    await location.filter({ hasText: '中国 · 198.51.100.18' }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'refreshNetworkLocation' })
    await location.click()
    await location.filter({ hasText: '网络位置未知' }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = '' })
    await location.click()
    await location.filter({ hasText: '中国 · 198.51.100.18' }).waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('failed stop retains the last connected location until a confirmed disconnect', async () => {
  const page = await open()
  try {
    const location = page.getByTestId('shell-network-location')
    await page.getByTestId('acceleration-session-start').click()
    await location.filter({ hasText: '新加坡 · 203.0.113.24' }).waitFor()
    await page.evaluate(() => { window.v2Test.fail = 'stopAcceleration' })
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await location.innerText(), '新加坡 · 203.0.113.24')
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('acceleration-session-stop').click()
    await location.filter({ hasText: '中国 · 198.51.100.18' }).waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('acceleration trial counts only connected time, survives navigation, pauses and resumes without resetting the twenty-minute trial', async () => {
  const page = await open()
  try {
    await page.getByTestId('acceleration-session-start').waitFor()
    assert.equal(await remaining(page).innerText(), '00:20:00')
    assert.equal(await page.locator('.acceleration-quota-badge').innerText(), '20 分钟')
    await page.clock.runFor(5000)
    assert.equal(await remaining(page).innerText(), '00:20:00')
    const tun = page.getByRole('switch', { name: 'TUN 模式' })
    assert.equal(await tun.getAttribute('aria-checked'), 'false')
    await tun.click()
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    assert.equal(await tun.isDisabled(), true)
    await page.clock.runFor(10_000)
    assert.equal(await remaining(page).innerText(), '00:19:50')
    await page.getByTestId('nav-home').click()
    await page.clock.runFor(10_000)
    await page.getByTestId('nav-acceleration').click()
    assert.equal(await remaining(page).innerText(), '00:19:40')
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    assert.equal(await tun.isDisabled(), false)
    await page.clock.runFor(20_000)
    assert.equal(await remaining(page).innerText(), '00:19:40')
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    await page.clock.runFor(5000)
    assert.equal(await remaining(page).innerText(), '00:19:35')
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    await page.reload()
    await openLazyAcceleration(page)
    await page.getByTestId('acceleration-session-start').waitFor()
    assert.equal(await remaining(page).innerText(), '00:19:35')
    assert.equal(await page.locator('.acceleration-preview').innerText(), '交互预览')
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
    await page.getByTestId('acceleration-session-start').filter({ hasText: '免费体验已用完' }).waitFor()
    assert.equal(await remaining(page).innerText(), '00:00:00')
    assert.equal(await page.getByTestId('acceleration-session-start').isDisabled(), true)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('xingmang-acceleration-preview:v2:xm-account:17')).usedMilliseconds), 25 * 60 * 1000)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('exhaustion stops the session once even when the acceleration page is hidden', async () => {
  const page = await open('accelerationPreview=1&accelerationShort=1')
  try {
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    await page.getByTestId('nav-home').click()
    await page.clock.runFor(10_000)
    await page.getByTestId('nav-acceleration').click()
    await page.getByTestId('acceleration-session-start').filter({ hasText: '免费体验已用完' }).waitFor()
    assert.equal(await remaining(page).innerText(), '00:00:00')
    assert.equal(await page.getByTestId('acceleration-session-start').isDisabled(), true)
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
    assert.equal(await remaining(page).innerText(), '--:--:--')
    await page.clock.runFor(60_000)
    assert.equal(await remaining(page).innerText(), '--:--:--')
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
    assert.equal(await remaining(page).innerText(), '00:20:00')
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('acceleration-session-start').click()
    await page.getByTestId('acceleration-session-stop').waitFor()
    await page.clock.runFor(5000)
    await page.evaluate(() => { window.v2Test.fail = 'stopAcceleration' })
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
    assert.equal(await page.getByTestId('acceleration-page').getAttribute('data-phase'), 'active')
    await page.clock.runFor(5000)
    assert.equal(await remaining(page).innerText(), '00:19:50')
    await page.evaluate(() => { window.v2Test.fail = '' })
    await page.getByTestId('acceleration-session-stop').click()
    await page.getByTestId('acceleration-session-start').waitFor()
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})

test('logged out users see the global acceleration page with a working login action', async () => {
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
  await page.getByTestId('shell-topbar').getByRole('button', { name: /搜索、打开、跳转/ }).click()
  const palette = page.getByTestId('command-palette')
  const input = palette.getByRole('searchbox', { name: '搜索页面' })
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
    assert.equal(await remaining(page).innerText(), '00:20:00')
    assert.equal(await feedback.count(), 0)
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await feedback.filter({ hasText: '领取成功，已增加 10 分钟' }).waitFor()
    assert.equal(await remaining(page).innerText(), '00:30:00')
    assert.equal(await page.locator('.acceleration-quota-badge').innerText(), '30 分钟')
    await action.click()
    await action.filter({ hasText: '正在领取' }).waitFor()
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await feedback.filter({ hasText: '当前账号已在本机领取过' }).waitFor()
    assert.equal(await remaining(page).innerText(), '00:30:00')
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
    await input.fill('设置')
    await input.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    assert.equal(await palette.isVisible(), true)
    assert.equal(await action.count(), 0)
    await input.press('Enter')
    await palette.waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('nav-settings').getAttribute('aria-current'), 'page')
    await page.getByTestId('shell-topbar').getByRole('button', { name: /搜索、打开、跳转/ }).click()
    await input.press('Escape')
    await palette.waitFor({ state: 'hidden' })
    assert.equal(await page.getByTestId('shell-topbar').getByRole('button', { name: /搜索、打开、跳转/ }).evaluate(element => document.activeElement === element), true)
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
    assert.equal(await remaining(page).innerText(), '00:20:00')
    assert.equal(await action.isEnabled(), true)
    await page.evaluate(() => { window.v2Test.fail = '' })
    await action.click()
    await feedback.filter({ hasText: '领取成功' }).waitFor()
    assert.equal(await remaining(page).innerText(), '00:30:00')
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
  const guest = await open('guest=1&existing=1&accelerationPreview=1')
  try {
    const { action, feedback } = await bonusPalette(guest)
    await action.click()
    await feedback.filter({ hasText: '请先登录星芒账号' }).waitFor()
    assert.equal((await bonusCalls(guest)).length, 0)
    assert.equal(await remaining(guest).innerText(), '--:--:--')
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
    await page.getByRole('button', { name: '打开个人中心 next-user', exact: true }).waitFor()
    await page.getByTestId('nav-acceleration').click()
    await page.clock.runFor(500)
    await remaining(page).waitFor()
    assert.equal(await remaining(page).innerText(), '00:20:00')
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await page.clock.runFor(1)
    assert.equal(await remaining(page).innerText(), '00:20:00')
    assert.equal(await page.getByTestId('command-acceleration-feedback').count(), 0)
    const next = await bonusPalette(page)
    await next.action.click()
    await next.action.filter({ hasText: '正在领取' }).waitFor()
    assert.deepEqual((await bonusCalls(page)).map(call => call.args[0]), ['xm-account:17', 'xm-account:18'])
    await page.evaluate(() => window.v2Test.releaseLaunch())
    await next.feedback.filter({ hasText: '领取成功' }).waitFor()
    assert.equal(await remaining(page).innerText(), '00:30:00')
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
    assert.equal(await remaining(page).innerText(), '00:30:00')
    assert.equal(await reopened.feedback.count(), 0)
    assert.equal(await reopened.action.count(), 0)
    await clean(page)
  } finally { if (!page.isClosed()) await page.close() }
})
