import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'

let server, browser, origin
const artifacts = path.resolve('artifacts/renderer-v2-app')
before(async () => {
  await fs.mkdir(artifacts, { recursive: true })
  server = await createServer({ root: path.resolve('.'), configFile: false, plugins: [react()], logLevel: 'error', server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
})
after(async () => { await browser?.close(); await server?.close() })
async function open(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  await page.goto(`${origin}/src/renderer-v2/testing/app.html?${query}`)
  return page
}
async function clean(page) {
  assert.deepEqual(await page.evaluate(() => window.v2Test.errors), [])
  assert.deepEqual(await page.evaluate(() => window.v2Test.unexpected), [])
}
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
      assert.equal(await page.locator('[data-testid^="tool-row-"]').count(), 5)
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

test('desktop status arriving during the initial scan preserves the full tool snapshot', async () => {
  const page = await open('desktopEvent=1')
  try {
    await page.getByTestId('tool-row-codexDesktop').getByText('v9.9.9 · fixture-model').waitFor()
    assert.equal(await page.locator('[data-testid^="tool-row-"]').count(), 5)
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
    await confirmation.getByRole('button', { name: '保存配置', exact: true }).click()
    await confirmation.getByRole('alert').filter({ hasText: '本地测试操作失败' }).waitFor()
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
    await page.getByRole('dialog', { name: '保存这份配置？' }).getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByText('配置已保存。Codex 桌面端运行中时，可关闭此面板后选择重新打开。').waitFor()

    const marker = await page.evaluate(() => localStorage.getItem(
      `xingmang-v2:provider-source:v1:${encodeURIComponent('https://xm.solov.cc')}:codex`,
    ))
    assert.equal(marker, 'manual')

    await page.getByTestId('config-dialog').getByRole('button', { name: '取消', exact: true }).click()
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
    for (const method of ['getAccountUsage', 'getAccountNotice', 'getAccountLoginSessions', 'getAccountTopupInfo', 'getAccountSubscriptionSelf', 'getLegalDocument']) assert.equal(methods.includes(method), false, method)
    await page.screenshot({ path: path.join(artifacts, 'account-sub2api.png') })
    await clean(page)
    await page.evaluate(() => window.v2Test.emit('onAccountSessionChanged', { authenticated: false, account: null, siteId: 'solov-api', realmId: 'api-account' }))
    await page.getByTestId('welcome-login').waitFor()
    assert.equal(await page.getByTestId('account-display').count(), 0)
  } finally { await page.close() }
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


test('automatic login uses returned account ownership without exposing a platform choice', async () => {
  const page = await open('guest=1&sub2api=1')
  try {
    await page.getByTestId('welcome-login').click()
    assert.equal(await page.getByTestId('login-site').count(), 0)
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
  await page.getByTestId('tool-key-select').waitFor()
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
    await confirmation.getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByText('配置已保存。Codex 桌面端运行中时，可关闭此面板后选择重新打开。').waitFor()
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.find((entry) => entry.method === 'saveConfig').args[0], { provider: 'codex', apiKey: '', model: 'fixture-model', mode: 'merge' })
    assert.equal(actions.some((entry) => ['configureManagedCliKeys', 'saveConfigWithAccountKey', 'revealApiKey', 'listAccountKeyModels'].includes(entry.method)), false)
    assert.deepEqual(actions.find((entry) => entry.method === 'listConfiguredModels').args, ['codex'])
    assert.equal(await page.evaluate(() => localStorage.getItem(`xingmang-v2:provider-source:v1:${encodeURIComponent('https://xm.solov.cc')}:codex`)), null)
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
    await page.getByRole('dialog', { name: '保存这份配置？' }).getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByText('配置已保存。Codex 桌面端运行中时，可关闭此面板后选择重新打开。').waitFor()
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
    await page.getByRole('dialog', { name: '保存这份配置？' }).getByRole('button', { name: '保存配置', exact: true }).click()
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
    await page.getByRole('dialog', { name: '保存这份配置？' }).getByRole('button', { name: '保存配置', exact: true }).click()
    await page.getByText('配置已保存。Codex 桌面端运行中时，可关闭此面板后选择重新打开。').waitFor()
    const actions = await page.evaluate(() => window.v2Test.calls)
    assert.deepEqual(actions.find((entry) => entry.method === 'switchToOfficialAccount').args, ['codex'])
    assert.equal(actions.some((entry) => ['saveConfig', 'configureManagedCliKeys', 'saveConfigWithAccountKey'].includes(entry.method)), false)
    await clean(page)
  } finally { await page.close() }
})
