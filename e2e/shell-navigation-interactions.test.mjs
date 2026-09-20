import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { fixtureReadyTimeoutMs } from './fixture-readiness.mjs'
import { createBrowserFixture, defaultViewport } from './harness.mjs'

const shell = createBrowserFixture({ sameOriginOnly: true })
before(async () => { await shell.start() })
after(async () => { await shell.stop(); shell.assertNoPageErrors() })

async function fixture(query = '', viewport = defaultViewport) {
  const page = await shell.newPage({ viewport })
  await page.goto(`${shell.baseUrl}/e2e/shell-navigation-fixture.html?${query}`)
  await page.locator('.shell-topbar').waitFor({ timeout: fixtureReadyTimeoutMs })
  return page
}

test('command search preserves focus, supports navigation and does not submit composition input', async () => {
  const page = await fixture()
  try {
    const trigger = page.getByRole('button', { name: '搜索页面与操作', exact: true })
    await trigger.click()
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索页面')
    await page.getByRole('combobox', { name: '搜索页面', exact: true }).fill('聊天')
    await page.getByRole('combobox', { name: '搜索页面', exact: true }).evaluate((input) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    assert.equal(await page.getByRole('dialog').count(), 1)
    assert.deepEqual(await page.evaluate(() => window.shellHarness.navigations), [])
    await page.keyboard.press('Enter')
    await page.locator('[data-view-key="chat"]').waitFor()
    await page.keyboard.press('Control+k')
    await page.getByRole('combobox').waitFor()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '搜索页面与操作')
    await page.getByRole('button', { name: /通知/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: /发现新版本/ }).click()
    assert.equal(await page.locator('main').getAttribute('data-view-key'), 'updates')
  } finally { await page.close() }
})

test('notices distinguish failed reads and retain per-account read state', async () => {
  const page = await fixture()
  try {
    await page.locator('.shell-unread').waitFor()
    await page.getByRole('button', { name: /^公告/ }).click()
    await page.getByRole('button', { name: '标为已读' }).click()
    assert.equal(await page.locator('.shell-unread').count(), 0)
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.shellHarness.remountTopbar())
    await page.getByRole('button', { name: /^公告/ }).click()
    assert.equal(await page.getByRole('button', { name: '标为已读' }).isDisabled(), true)
    await page.evaluate(() => { window.shellHarness.mode = 'error' })
    await page.getByRole('button', { name: '重新读取' }).click()
    await page.getByRole('alert').waitFor()
    assert.match(await page.locator('.shell-announcement').innerText(), /account-a/)
    await page.evaluate(() => { window.shellHarness.mode = 'normal'; window.shellHarness.switchScope('account-b') })
    await page.locator('.shell-unread').waitFor()
    await page.getByRole('button', { name: /^公告/ }).click()
    assert.match(await page.locator('.shell-announcement').innerText(), /account-b/)
  } finally { await page.close() }
})

test('late announcement responses cannot overwrite the next account or the latest request', async () => {
  const page = await fixture('announcement=deferred')
  try {
    await page.waitForFunction(() => window.shellHarness.requests.length === 1)
    const first = await page.evaluate(() => window.shellHarness.requests[0].id)
    await page.evaluate(() => window.shellHarness.switchScope('account-b'))
    await page.waitForFunction(() => window.shellHarness.requests.length === 2)
    const second = await page.evaluate(() => window.shellHarness.requests[1].id)
    await page.evaluate(({ first, second }) => { window.shellHarness.releaseNotice(second, '新的公告'); window.shellHarness.releaseNotice(first, '旧账号公告') }, { first, second })
    await page.getByRole('button', { name: /^公告/ }).click()
    await page.waitForFunction(() => document.querySelector('.shell-announcement')?.textContent?.includes('新的公告'))
    assert.doesNotMatch(await page.locator('.shell-announcement').innerText(), /旧账号公告/)
  } finally { await page.close() }
})

test('untrusted announcements neither execute HTML nor fetch remote media', async () => {
  const page = await fixture('announcement=malicious')
  try {
    const external = []
    page.on('request', (request) => { if (new URL(request.url()).origin !== shell.baseUrl) external.push(request.url()) })
    await page.getByRole('button', { name: /^公告/ }).click()
    await page.locator('.shell-announcement').waitFor()
    assert.equal(await page.locator('.shell-announcement script,.shell-announcement iframe,.shell-announcement img').count(), 0)
    assert.equal(await page.evaluate(() => window.shellHarness.xss), false)
    assert.deepEqual(external, [])
    await page.getByRole('link', { name: '官方说明' }).click()
    assert.deepEqual(await page.evaluate(() => window.shellHarness.external), ['https://example.com/notice'])
  } finally { await page.close() }
})

test('navigation restores filters and delayed content scroll, while account changes reset both', async () => {
  const page = await fixture('slow=true')
  try {
    await page.evaluate(() => window.shellHarness.releaseRows())
    await page.locator('[data-ready="true"]').waitFor()
    await page.getByLabel('页面筛选').fill('保留筛选')
    await page.locator('main').evaluate((main) => new Promise((resolve, reject) => {
      // scrollTop changes synchronously; the browser delivers scroll on a later frame.
      // Let navigation remember this position before replacing the page content.
      const timeout = setTimeout(() => {
        main.removeEventListener('scroll', onScroll)
        reject(new Error('Browser did not dispatch the scroll event'))
      }, 5000)
      const onScroll = () => { clearTimeout(timeout); resolve() }
      main.addEventListener('scroll', onScroll, { once: true })
      main.scrollTop = 900
    }))
    await page.waitForFunction(() => document.querySelector('main').scrollTop === 900)
    await page.evaluate(() => window.shellHarness.navigate('skills'))
    await page.locator('[data-view-key="skills"]').waitFor()
    await page.evaluate(() => window.shellHarness.navigate('sessions'))
    await page.locator('[data-view-key="sessions"] [data-ready="false"]').waitFor()
    assert.equal(await page.getByLabel('页面筛选').inputValue(), '保留筛选')
    await page.evaluate(() => window.shellHarness.releaseRows())
    await page.waitForFunction(() => Math.abs(document.querySelector('main').scrollTop - 900) < 2)
    await page.evaluate(() => window.shellHarness.switchScope('another-account'))
    await page.waitForFunction(() => document.querySelector('main').scrollTop === 0)
    assert.equal(await page.getByLabel('页面筛选').inputValue(), '')
  } finally { await page.close() }
})

test('five shell regions and collapsed navigation fit the supported window sizes', async () => {
  for (const theme of ['dark', 'light']) for (const viewport of [{ width: 960, height: 560 }, { width: 1280, height: 820 }, { width: 1440, height: 900 }]) {
    const page = await fixture(`theme=${theme}`, viewport)
    try {
      for (const collapsed of [false, true]) {
        if (collapsed) await page.getByRole('button', { name: '收起侧边栏', exact: true }).click()
        const bounds = await page.evaluate(() => {
          const selectors = ['.window-titlebar', '.sidebar', '.shell-topbar', '.main-content', '.shell-statusbar']
          return selectors.map((selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { selector, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } })
        })
        for (const rect of bounds) assert.ok(rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.right <= viewport.width + 1 && rect.bottom <= viewport.height + 1, JSON.stringify({ theme, viewport, collapsed, rect }))
      }
    } finally { await page.close() }
  }
})
