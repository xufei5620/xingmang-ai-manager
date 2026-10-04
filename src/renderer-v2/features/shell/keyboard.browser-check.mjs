import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, test } from 'node:test'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'
import { createFixtureServer } from '../../../../e2e/harness.mjs'
import { openFixturePage, waitForFixtureMount } from '../../../../e2e/fixture-readiness.mjs'

let server, browser, origin
before(async () => {
  ;({ server, origin } = await createFixtureServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error' }))
  browser = await chromium.launch({ executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })

async function open() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await openFixturePage(page, `${origin}/src/renderer-v2/testing/app.html`,
    (timeout) => waitForFixtureMount(page, { timeout, what: 'the keyboard fixture', ready: () => Boolean(window.v2Test) && Boolean(document.querySelector('.v2-nav-item')) }),
    { label: 'keyboard fixture' })
  return page
}
async function clean(page) {
  assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  assert.deepEqual(await page.evaluate(() => window.v2Test.unexpected), [])
}
function focused(page) {
  return page.evaluate(() => {
    const element = document.activeElement
    return { id: element?.id ?? '', testId: element?.getAttribute('data-testid') ?? '', insideMain: Boolean(element?.closest('main')) }
  })
}
async function focusLandsInMain(page) {
  await page.waitForFunction(() => document.activeElement?.id === 'v2-main')
}

test('the skip link is the first stop, only shows while focused, and moves focus into the page', async () => {
  const page = await open()
  try {
    const skip = page.getByTestId('shell-skip-to-content')
    const hidden = await skip.boundingBox()
    assert.ok(hidden && hidden.width <= 1 && hidden.height <= 1, 'the link takes no visible space until it is focused')
    await page.keyboard.press('Tab')
    assert.equal((await focused(page)).testId, 'shell-skip-to-content')
    const shown = await skip.boundingBox()
    assert.ok(shown && shown.width > 100 && shown.height > 20, 'a focused skip link is visible')
    await page.keyboard.press('Enter')
    await focusLandsInMain(page)
    assert.equal(new URL(page.url()).hash, '', 'skipping does not rewrite the address')
    await page.keyboard.press('Tab')
    assert.equal((await focused(page)).insideMain, true, 'the next Tab continues inside the page, not the sidebar')
    await clean(page)
  } finally { await page.close() }
})

test('switching pages from the sidebar with the keyboard moves focus to the new page and announces it', async () => {
  const page = await open()
  try {
    await page.getByTestId('nav-settings').focus()
    await page.keyboard.press('Enter')
    await page.getByTestId('page-settings').waitFor()
    await focusLandsInMain(page)
    assert.equal(await page.getByTestId('shell-page-announcement').textContent(), '已切换到设置')
    await page.keyboard.press('Tab')
    assert.equal((await focused(page)).insideMain, true)

    await page.getByTestId('nav-home').focus()
    await page.keyboard.press('Enter')
    await focusLandsInMain(page)
    assert.equal(await page.getByTestId('shell-page-announcement').textContent(), '已切换到首页')
    await clean(page)
  } finally { await page.close() }
})

test('a page chosen from the command palette also receives focus once the palette closes', async () => {
  const page = await open()
  try {
    await page.keyboard.press('Control+k')
    const search = page.getByRole('searchbox', { name: '搜索页面' })
    await search.waitFor()
    await search.fill('设置')
    await page.keyboard.press('Enter')
    await page.getByTestId('page-settings').waitFor()
    await focusLandsInMain(page)
    assert.equal(await page.getByTestId('shell-page-announcement').textContent(), '已切换到设置')
    await clean(page)
  } finally { await page.close() }
})

test('the command palette finds tutorials by the problem and hands unmatched text to the tutorial search', async () => {
  const page = await open()
  try {
    await page.keyboard.press('Control+k')
    const search = page.getByRole('searchbox', { name: '搜索页面、设置和教程' })
    await search.waitFor()
    await search.fill('打不开')
    const first = page.getByTestId('command-palette').getByRole('option').first()
    assert.match(await first.getAttribute('aria-label'), /^教程 · /)
    await page.getByTestId('command-group-tutorial').waitFor()
    await page.keyboard.press('Enter')
    await page.getByTestId('page-tutorial').waitFor()
    assert.equal(await page.getByTestId('command-palette').count(), 0)

    await page.keyboard.press('Control+k')
    await search.fill('qqqq')
    assert.equal(await page.getByTestId('command-palette').getByRole('option').count(), 0)
    await page.getByText('没找到相关的页面或设置。').waitFor()
    await page.getByTestId('command-search-tutorial').click()
    await page.getByTestId('page-tutorial').waitFor()
    // 教程页上一步已经开着，页面出现时新的搜索词可能还没落进输入框，要等它落进去。
    await page.waitForFunction(() => document.querySelector('[data-testid="tutorial-search"]')?.value === 'qqqq')
    await clean(page)
  } finally { await page.close() }
})

test('on a short screen More and Settings stay pinned in view, the open More list fits and is remembered', async () => {
  const page = await open()
  try {
    // 1280×720 屏幕、1920×1080 开 150% 缩放时，窗口里能给侧栏的高度大约就这么多。
    await page.setViewportSize({ width: 1280, height: 672 })
    function visibleInSidebar(testId) {
      return page.evaluate((id) => {
        const element = document.querySelector(`[data-testid="${id}"]`)
        const nav = document.querySelector('.v2-sidebar-nav')
        const scroll = document.querySelector('.v2-sidebar-scroll')
        if (!element || !nav || !scroll) return false
        const box = element.getBoundingClientRect()
        const clip = element.closest('.v2-sidebar-scroll') ? scroll.getBoundingClientRect() : nav.getBoundingClientRect()
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        return box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1 && Boolean(hit && element.contains(hit))
      }, testId)
    }
    const pinned = ['nav-more', 'nav-settings']
    for (const id of pinned) assert.equal(await visibleInSidebar(id), true, `${id} is not cut off below the fold`)
    for (const id of pinned) assert.equal(await page.getByTestId('sidebar-pinned').getByTestId(id).count(), 1, `${id} sits in the pinned part, not the scrolling one`)
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').waitFor()
    for (const id of [...pinned, 'nav-maintenance', 'nav-backups', 'nav-feedback', 'nav-updates'])
      assert.equal(await visibleInSidebar(id), true, `${id} stays in view with More open`)
    // 上面那段放不下了自己滚，下沿渐隐，看得出还有。
    await page.waitForFunction(() => document.querySelector('.v2-sidebar-scroll')?.getAttribute('data-fade') === 'bottom')
    await page.getByTestId('sidebar-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight })
    await page.waitForFunction(() => document.querySelector('.v2-sidebar-scroll')?.getAttribute('data-fade') === 'top')

    await page.reload()
    await page.getByTestId('nav-updates').waitFor()
    assert.equal(await page.getByTestId('nav-more').getAttribute('aria-expanded'), 'true', 'More reopens the way it was left')
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').waitFor({ state: 'detached' })
    await page.reload()
    await page.getByTestId('nav-more').waitFor()
    assert.equal(await page.getByTestId('nav-more').getAttribute('aria-expanded'), 'false')
    assert.equal(await page.getByTestId('nav-updates').count(), 0)
    await clean(page)
  } finally { await page.close() }
})

test('the command palette has no title bar, stays put while the results change and shows the keys to use', async () => {
  const page = await open()
  try {
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: '搜功能、设置或教程', exact: true })
    await palette.waitFor()
    assert.equal(await palette.locator('[data-modal-close]').count(), 0, 'Esc and clicking outside close it; no close button')
    assert.equal(await palette.getByTestId('command-hint').textContent(), '↑↓ 选择　回车 打开　Esc 关闭')
    const search = palette.getByRole('searchbox', { name: '搜索页面、设置和教程' })
    assert.equal(await search.getAttribute('placeholder'), '搜功能、设置或教程…')
    const top = (await palette.boundingBox()).y
    await search.fill('通知')
    await palette.getByRole('option').first().waitFor()
    assert.equal((await palette.boundingBox()).y, top, 'more results grow the box downwards only')
    await search.fill('qqqq')
    await page.getByText('没找到相关的页面或设置。').waitFor()
    assert.equal((await palette.boundingBox()).y, top, 'fewer results do not move the box either')
    // 搜索框里有字时第一下 Esc 先清空（浏览器自带的），第二下关框，和原来一样。
    await page.keyboard.press('Escape')
    assert.equal(await search.inputValue(), '')
    await page.keyboard.press('Escape')
    await page.getByTestId('command-palette').waitFor({ state: 'detached' })
    await clean(page)
  } finally { await page.close() }
})

test('a single setting found from the command palette opens its group and points at that row', async () => {
  const page = await open()
  try {
    await page.keyboard.press('Control+k')
    const search = page.getByRole('searchbox', { name: '搜索页面、设置和教程' })
    await search.fill('收不到通知')
    const first = page.getByTestId('command-palette').getByRole('option').first()
    assert.equal(await first.getAttribute('aria-label'), '设置 · 通知 › 测试通知')
    await page.keyboard.press('Enter')
    await page.getByTestId('page-settings').waitFor()
    await page.waitForFunction(() => document.querySelector('[data-anchor="test-notification"]')?.getAttribute('data-anchor-focus') === 'true')
    assert.equal(await page.getByTestId('page-settings').getByRole('tab', { name: '通知', exact: true }).getAttribute('aria-selected'), 'true')
    const row = await page.locator('[data-anchor="test-notification"]').boundingBox()
    const viewport = page.viewportSize()
    assert.ok(row && row.y >= 0 && row.y + row.height <= viewport.height, 'the row is scrolled into view')
    // 亮一下就收，不一直挂着。
    await page.waitForFunction(() => !document.querySelector('[data-anchor="test-notification"]')?.hasAttribute('data-anchor-focus'), null, { timeout: 5000 })

    // 再搜一次别组的一行：设置页已经开着，也要翻过去。
    await page.keyboard.press('Control+k')
    await search.fill('开机')
    const launch = page.getByTestId('command-palette').getByRole('option', { name: '设置 · 启动与关闭 › 开机自动启动', exact: true })
    await launch.click()
    await page.waitForFunction(() => document.querySelector('[data-anchor="launch-at-login"]')?.getAttribute('data-anchor-focus') === 'true')
    assert.equal(await page.getByTestId('page-settings').getByRole('tab', { name: '启动与关闭', exact: true }).getAttribute('aria-selected'), 'true')
    await clean(page)
  } finally { await page.close() }
})
