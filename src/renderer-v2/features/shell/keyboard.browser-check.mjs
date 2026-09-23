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

test('on a short screen the sidebar keeps Settings in view and scrolls the opened More list into view', async () => {
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
    assert.equal(await visibleInSidebar('nav-settings'), true, 'Settings is not cut off below the fold')
    await page.getByTestId('nav-more').click()
    await page.getByTestId('nav-updates').waitFor()
    await page.waitForFunction(() => {
      const item = document.querySelector('[data-testid="nav-updates"]')?.getBoundingClientRect()
      const scroll = document.querySelector('.v2-sidebar-scroll')?.getBoundingClientRect()
      return Boolean(item && scroll && item.bottom <= scroll.bottom + 1)
    })
    assert.equal(await visibleInSidebar('nav-updates'), true, 'the last item of More is scrolled into view')
    assert.equal(await visibleInSidebar('nav-settings'), true, 'Settings stays in view with More open')
    await clean(page)
  } finally { await page.close() }
})
