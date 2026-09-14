import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, test } from 'node:test'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'

let server, browser, origin
before(async () => {
  server = await createServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
})
after(async () => { await browser?.close(); await server?.close() })

async function open(query = 'accelerationPreview=1') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await page.clock.install({ time: new Date('2026-09-14T00:00:00Z') })
  await page.clock.pauseAt(new Date('2026-09-14T00:00:01Z'))
  await page.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/src/renderer-v2/testing/app.html?${query}`)
  await page.getByTestId('nav-acceleration').click()
  await page.getByTestId('acceleration-page').waitFor()
  return page
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
    await page.getByTestId('nav-acceleration').click()
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
    await page.getByTestId('nav-acceleration').click()
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
