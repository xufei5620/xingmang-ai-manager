import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const testDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(testDirectory, '..')

async function withFixture(run, { viewport = { width: 1100, height: 760 } } = {}) {
  const server = await createServer({
    configFile: path.join(projectRoot, 'vite.config.ts'),
    root: projectRoot,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  })
  await server.listen()
  const address = server.httpServer?.address()
  if (!address || typeof address === 'string') throw new Error('Vite test server did not expose a TCP port')
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined,
  })
  try {
    const page = await browser.newPage({ viewport })
    await run(page, `http://127.0.0.1:${address.port}`)
  } finally {
    await browser.close()
    await server.close()
  }
}

function parseRgb(value) {
  const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error(`无法解析颜色: ${value}`)
  return channels
}

function relativeLuminance(value) {
  const [red, green, blue] = parseRgb(value).map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground)
  const backgroundLuminance = relativeLuminance(background)
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
}

test('orders expose loading, retry a failed request, and render the returned order', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=orders-retry`)
    await assert.doesNotReject(() => page.getByRole('heading', { name: '正在读取订单' }).waitFor())
    await page.evaluate(() => window.releaseFirstOrderRequest())
    const retry = page.getByRole('button', { name: '重试' })
    await retry.waitFor()
    assert.match(await page.getByRole('alert').innerText(), /订单服务暂时不可用/)
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.orderCalls), 1)

    await retry.click()
    await page.getByText('XM-ORDER-20260815').waitFor()
    assert.equal(await page.getByText('支付宝', { exact: true }).count(), 1)
    assert.equal(await page.getByText('已到账', { exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.orderCalls), 2)
  })
})

test('redemption blocks duplicate submits, recovers after failure, and refreshes after success', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=redeem-retry`)
    const input = page.getByPlaceholder('输入兑换码')
    const submit = page.getByRole('button', { name: '立即兑换' })
    await input.fill('FIRST-FAILS')
    await submit.click()
    await page.getByRole('button', { name: '正在兑换…' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '正在兑换…' }).isDisabled(), true)
    await page.evaluate(() => {
      document.querySelector('.account-redeem .primary-button')?.click()
    })
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.redeemCalls), 1)

    await page.getByTestId('toast').filter({ hasText: '兑换码无效或已使用' }).waitFor()
    assert.equal(await submit.isEnabled(), true)
    assert.equal(await input.inputValue(), 'FIRST-FAILS')

    await input.fill('SECOND-SUCCEEDS')
    await submit.click()
    await page.getByTestId('toast').filter({ hasText: '兑换成功，已增加' }).waitFor()
    assert.equal(await input.inputValue(), '')
    assert.equal(await page.getByTestId('refresh-version').textContent(), '1')
    const state = await page.evaluate(() => window.accountCommerceHarness)
    assert.equal(state.orderCalls, 0)
    assert.equal(state.redeemCalls, 2)
    assert.equal(state.refreshCalls, 1)
  })
})

test('top-up payment exits the waiting state when the payment window reports a timeout', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&section=topup`)
    const submit = page.getByRole('button', { name: '确认充值' })
    await submit.waitFor()
    await assert.doesNotReject(() => submit.waitFor({ state: 'visible' }))
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.includes('确认充值'))
      return button instanceof HTMLButtonElement && !button.disabled
    })
    await submit.click()
    await page.getByRole('button', { name: '使用支付宝支付' }).click()
    await page.getByText('正在等待支付结果', { exact: true }).waitFor()

    await page.evaluate(() => window.emitPaymentWindowTerminal({
      status: 'expired',
      tradeNo: 'XM-VISUAL-PAYMENT',
    }))

    await page.getByText('支付已超时', { exact: true }).waitFor()
    assert.equal(await page.getByText('正在等待支付结果', { exact: true }).count(), 0)
    assert.match(await page.getByTestId('toast').innerText(), /支付已超时/)
  })
})

test('top-up payment reports a manually closed payment window without cancelling the order', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&section=topup`)
    const submit = page.getByRole('button', { name: '确认充值' })
    await submit.waitFor()
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.includes('确认充值'))
      return button instanceof HTMLButtonElement && !button.disabled
    })
    await submit.click()
    await page.getByRole('button', { name: '使用支付宝支付' }).click()
    await page.getByText('正在等待支付结果', { exact: true }).waitFor()

    await page.evaluate(() => window.emitPaymentWindowTerminal({
      status: 'closed',
      tradeNo: 'XM-VISUAL-PAYMENT',
    }))

    await page.getByText('支付窗口已关闭', { exact: true }).waitFor()
    assert.equal(await page.getByText('正在等待支付结果', { exact: true }).count(), 0)
    assert.match(await page.getByRole('status').filter({ hasText: '支付窗口已关闭' }).innerText(), /订单没有取消/)
    assert.match(await page.getByTestId('toast').innerText(), /支付窗口已手动关闭/)
  })
})

test('profile save remains retryable after failure and reloads the accepted display name', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=profile-retry`)
    const input = page.getByLabel('显示名称')
    await input.waitFor()
    assert.equal(await input.inputValue(), '交互测试用户')
    await input.fill('新的显示名称')
    await page.getByRole('button', { name: '保存资料' }).click()
    await page.getByTestId('toast').filter({ hasText: '资料服务暂时不可用' }).waitFor()
    assert.equal(await input.inputValue(), '新的显示名称')
    assert.equal(await page.getByRole('button', { name: '保存资料' }).isEnabled(), true)

    await page.getByRole('button', { name: '保存资料' }).click()
    await page.getByTestId('toast').filter({ hasText: '个人资料已更新' }).waitFor()
    assert.equal(await input.inputValue(), '新的显示名称')
    const state = await page.evaluate(() => window.accountCommerceHarness)
    assert.equal(state.profileUpdateCalls, 2)
    assert.equal(state.profileCalls, 2)
    assert.equal(state.profileName, '新的显示名称')
  })
})

test('security validates passwords and confirms every session revocation scope', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=security`)
    await page.getByText('10.0.0.2', { exact: false }).waitFor()

    await page.getByRole('button', { name: '确认修改' }).click()
    await page.getByText('请输入原密码', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.passwordCalls), 0)

    const originalPassword = page.locator('input[autocomplete="current-password"]')
    const newPasswords = page.locator('input[autocomplete="new-password"]')
    await originalPassword.fill('OldPass123')
    await newPasswords.nth(0).fill('NewPass123')
    await newPasswords.nth(1).fill('NewPass123')
    await page.getByRole('button', { name: '确认修改' }).click()
    await page.getByTestId('toast').filter({ hasText: '密码修改成功' }).waitFor()
    assert.equal(await originalPassword.inputValue(), '')
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.rememberedLoginClears), 1)

    const remoteA = page.locator('.account-session-list article').filter({ hasText: '10.0.0.2' })
    await remoteA.getByRole('button', { name: '撤销' }).click()
    let dialog = page.getByRole('alertdialog', { name: '撤销此登录设备' })
    await dialog.waitFor()
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.sessionRevokeCalls), 0)
    await dialog.getByRole('button', { name: '确认退出' }).click()
    await remoteA.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.sessionRevokeCalls), 1)

    await page.getByRole('button', { name: '退出其他设备' }).click()
    dialog = page.getByRole('alertdialog', { name: '退出所有其他设备' })
    await dialog.waitFor()
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.otherSessionRevokeCalls), 0)
    await dialog.getByRole('button', { name: '确认退出' }).click()
    await page.locator('.account-session-list article').filter({ hasText: '10.0.0.3' }).waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.otherSessionRevokeCalls), 1)

    const current = page.locator('.account-session-list article').filter({ hasText: '10.0.0.1' })
    await current.getByRole('button', { name: '退出当前设备' }).click()
    dialog = page.getByRole('alertdialog', { name: '退出当前设备' })
    await dialog.waitFor()
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.logoutCalls), 0)
    await dialog.getByRole('button', { name: '确认退出' }).click()
    await page.waitForFunction(() => window.accountCommerceHarness.logoutCalls === 1)
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.sessionRevokeCalls), 2)
  })
})

test('local tutorial searches, recovers empty results, navigates internally, and opens support callbacks', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(baseUrl + '/e2e/account-commerce-fixture.html?scenario=tutorial')
    const search = page.getByRole('searchbox', { name: '搜索教程' })
    await search.fill('管理员 镜像')
    await page.getByRole('heading', { name: '自动安装与更新' }).waitFor()
    assert.equal(await page.getByText('1 个主题', { exact: true }).count(), 1)
    await page.getByRole('button', { name: '打开安装维护' }).click()
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.navigationTarget), 'maintenance')

    await search.fill('充值')
    await page.getByRole('heading', { name: '账户、充值与 Key' }).waitFor()
    await page.getByRole('button', { name: '打开个人中心' }).click()
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.accountCenterCalls), 1)

    await search.fill('不存在的主题')
    await page.getByRole('heading', { name: '没找到相关教程' }).waitFor()
    await page.getByRole('button', { name: '清除搜索' }).click()
    await page.getByRole('heading', { name: '首次使用' }).waitFor()
    await page.getByRole('navigation', { name: '教程目录' }).getByRole('button', { name: '故障排查' }).click()
    await page.getByRole('heading', { name: '故障排查' }).waitFor()
    await page.getByRole('button', { name: '打开健康诊断' }).click()
    assert.equal(await page.evaluate(() => window.accountCommerceHarness.navigationTarget), 'health')

    await page.getByRole('button', { name: '联系售后' }).click()
    await page.getByRole('button', { name: '打开售后会话' }).click()
    const state = await page.evaluate(() => window.accountCommerceHarness)
    assert.equal(state.supportCalls, 2)
    assert.equal(await page.locator("a[href*='feishu'], a[href*='s4621e8xzb']").count(), 0)
    assert.doesNotMatch((await page.locator('body').innerText()).toLowerCase(), /feishu|s4621e8xzb/)
  })
})

test('usage logs support filters, advanced search, pagination, reset and keyboard-dismissed details', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&section=usage&theme=dark`)
    await page.getByRole('heading', { name: '使用日志', exact: true }).waitFor()
    assert.equal(await page.getByText('日志明细', { exact: true }).count(), 0)
    assert.equal((await page.locator('.account-usage-heading').innerText()).trim(), '43 条记录')
    const activeUsageNav = page.getByRole('button', { name: '使用日志', exact: true })
    const inactiveDashboardNav = page.getByRole('button', { name: '数据看板', exact: true })
    await inactiveDashboardNav.hover()
    assert.equal(await activeUsageNav.getAttribute('aria-current'), 'page')
    assert.equal(await inactiveDashboardNav.getAttribute('aria-current'), null)
    assert.notEqual(
      await activeUsageNav.evaluate((element) => getComputedStyle(element).backgroundColor),
      await inactiveDashboardNav.evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    await page.screenshot({ path: 'test-results/account-usage-hover-dark.png', fullPage: false })
    await page.getByLabel('模型名称').fill(' gpt-5.4 ')
    await page.getByLabel('分组').fill(' codex-pro ')
    await page.getByLabel('日志类型').selectOption('2')
    await page.getByRole('button', { name: /更多筛选/ }).click()
    await page.getByLabel('令牌名称').fill(' Codex-Pro 主密钥 ')
    await page.getByLabel('请求 ID', { exact: true }).fill(' req-fixture-1 ')
    await page.getByLabel('上游请求 ID').fill(' up-fixture-1 ')
    await page.getByRole('button', { name: '搜索' }).click()
    await page.waitForFunction(() => window.accountCommerceHarness.usageQueries.length >= 2)
    const searched = await page.evaluate(() => window.accountCommerceHarness.usageQueries.at(-1))
    assert.deepEqual(searched, {
      page: 1, pageSize: 20, type: 2, modelName: 'gpt-5.4', group: 'codex-pro',
      tokenName: 'Codex-Pro 主密钥', requestId: 'req-fixture-1', upstreamRequestId: 'up-fixture-1',
    })

    await page.getByRole('button', { name: '第 2 页' }).click()
    await page.waitForFunction(() => window.accountCommerceHarness.usageQueries.at(-1)?.page === 2)
    assert.equal((await page.evaluate(() => window.accountCommerceHarness.usageQueries.at(-1))).page, 2)

    await page.locator('.account-usage-table-row').first().click()
    const dialog = page.getByRole('dialog', { name: '日志详情' })
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /缓存读取 Token/)
    assert.match(await dialog.innerText(), /req-fixture-1/)
    await dialog.getByRole('button', { name: '关闭日志详情' }).press('Escape')
    await dialog.waitFor({ state: 'detached' })

    await page.getByRole('button', { name: '重置' }).click()
    await page.waitForFunction(() => window.accountCommerceHarness.usageQueries.at(-1)?.page === 1 && !window.accountCommerceHarness.usageQueries.at(-1)?.modelName)
    assert.equal(await page.getByLabel('模型名称').inputValue(), '')
    assert.equal(await page.getByLabel('令牌名称').inputValue(), '')
  })
})

test('task logs support status filters, pagination and details', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&section=tasks`)
    await page.getByRole('heading', { name: '任务日志', exact: true }).waitFor()
    assert.equal((await page.locator('.account-task-heading').innerText()).trim(), '22 条记录')
    const firstTaskRow = page.locator('.account-task-table-row').first()
    assert.match(await firstTaskRow.innerText(), /Sora/)
    assert.doesNotMatch(await firstTaskRow.innerText(), /(^|\s)55(\s|$)/)
    await page.getByLabel('平台').fill(' openai ')
    await page.getByLabel('状态').selectOption('SUCCESS')
    await page.getByLabel('动作').fill(' video ')
    await page.getByRole('button', { name: '搜索' }).click()
    await page.waitForFunction(() => window.accountCommerceHarness.taskQueries.length >= 2)
    assert.deepEqual(await page.evaluate(() => window.accountCommerceHarness.taskQueries.at(-1)), {
      page: 1, pageSize: 20, platform: 'openai', status: 'SUCCESS', action: 'video',
    })
    await page.getByRole('button', { name: '第 2 页' }).click()
    await page.waitForFunction(() => window.accountCommerceHarness.taskQueries.at(-1)?.page === 2)

    await page.locator('.account-task-table-row').nth(1).click()
    const dialog = page.getByRole('dialog', { name: '任务详情' })
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /上游服务暂时不可用/)
    await page.getByRole('button', { name: '关闭任务详情' }).click()
    await dialog.waitFor({ state: 'detached' })
  })
})

test('legacy account deep links map into New API primary navigation and the correct secondary tab', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&section=orders`)
    assert.equal(await page.getByRole('button', { name: '钱包', exact: true }).getAttribute('aria-current'), 'page')
    assert.equal(await page.getByRole('tab', { name: '我的订单' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.locator('.account-center-recharge-button').count(), 1)
    await page.locator('.account-center-recharge-button').click()
    assert.equal(await page.getByRole('tab', { name: '充值 / 订阅' }).getAttribute('aria-selected'), 'true')
    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&section=security`)
    assert.equal(await page.getByRole('button', { name: '个人资料', exact: true }).getAttribute('aria-current'), 'page')
    assert.equal(await page.getByRole('tab', { name: '安全与设备' }).getAttribute('aria-selected'), 'true')
  })
})

test('sidebar keeps the full balance visible and uses stable collapsed icon slots', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(baseUrl + '/e2e/account-commerce-fixture.html?scenario=sidebar&theme=dark')
    const sidebar = page.locator('.sidebar')
    const balance = page.locator('.account-balance')
    await balance.waitFor()
    assert.equal((await balance.locator('.account-balance-label').textContent())?.trim(), '余额')
    assert.equal((await balance.locator('.account-balance-value').textContent())?.trim(), '$12345.67')
    assert.equal(await page.locator('.account-recharge-button').count(), 1)
    assert.equal((await balance.locator('.account-recharge-button').textContent())?.trim(), '充值')

    const expanded = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar')
      const balance = document.querySelector('.account-balance')
      const accountCopy = document.querySelector('.account-copy')
      const serviceButtons = Array.from(document.querySelectorAll('.sidebar-service-button'))
      if (!(sidebar instanceof HTMLElement) || !(balance instanceof HTMLElement) || !(accountCopy instanceof HTMLElement)) return null
      const sidebarRect = sidebar.getBoundingClientRect()
      const balanceRect = balance.getBoundingClientRect()
      const serviceRects = serviceButtons.map((button) => button.getBoundingClientRect())
      return {
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        balanceClipped: balance.scrollWidth > balance.clientWidth,
        balanceInsideSidebar: balanceRect.left >= sidebarRect.left && balanceRect.right <= sidebarRect.right,
        serviceRows: serviceRects.map((rect) => Math.round(rect.top)),
        systemLabel: document.querySelector('.nav-more-toggle .nav-label')?.textContent,
      }
    })
    assert.ok(expanded)
    assert.equal(expanded.documentOverflow, false)
    assert.equal(expanded.balanceClipped, false)
    assert.equal(expanded.balanceInsideSidebar, true)
    assert.deepEqual(expanded.serviceRows, [expanded.serviceRows[0], expanded.serviceRows[0], expanded.serviceRows[0]])
    assert.equal(expanded.systemLabel, '系统管理')
    assert.equal(await page.locator('.nav-more-toggle').getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('.nav-more-items').count(), 0)
    await sidebar.screenshot({ path: 'test-results/sidebar-expanded-dark.png' })

    await page.getByRole('button', { name: '系统管理' }).click()
    assert.equal(await page.locator('.nav-more-toggle').getAttribute('aria-expanded'), 'true')
    assert.equal(await page.locator('.nav-more-items .nav-item').count(), 6)
    const systemRows = await page.locator('.nav-more-items .nav-item').evaluateAll((items) =>
      items.map((item) => Math.round(item.getBoundingClientRect().top)),
    )
    assert.deepEqual(systemRows.slice(0, 2), [systemRows[0], systemRows[0]])
    assert.equal(new Set(systemRows).size, 3)

    await page.getByRole('button', { name: '收起侧边栏' }).click()
    await page.locator('.sidebar-collapsed').waitFor()
    const popover = page.locator('.nav-more-popover')
    await popover.waitFor()
    assert.equal(await popover.locator('.nav-item').count(), 6)
    const popoverRect = await popover.boundingBox()
    assert.ok(popoverRect)
    assert.ok(popoverRect.x >= 72)
    assert.ok(popoverRect.x + popoverRect.width <= 960)
    await page.keyboard.press('Escape')
    await popover.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '系统管理' }).click()
    await popover.waitFor()
    const collapsed = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar')
      const nav = document.querySelector('.main-nav')
      const brand = document.querySelector('.brand-block')
      const bottom = document.querySelector('.sidebar-bottom')
      const root = document.querySelector('#root')
      const shell = document.querySelector('.app-shell')
      const items = Array.from(document.querySelectorAll('.main-nav > .nav-group > .nav-item'))
      const icons = items.map((item) => item.querySelector(':scope > svg'))
      if (!(sidebar instanceof HTMLElement) || !(nav instanceof HTMLElement) || !(brand instanceof HTMLElement)
        || !(bottom instanceof HTMLElement)
        || !(root instanceof HTMLElement) || !(shell instanceof HTMLElement)) return null
      const sidebarRect = sidebar.getBoundingClientRect()
      const navRect = nav.getBoundingClientRect()
      const brandRect = brand.getBoundingClientRect()
      const bottomRect = bottom.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      const shellRect = shell.getBoundingClientRect()
      return {
        pageScrollY: window.scrollY,
        documentScrollTop: document.documentElement.scrollTop,
        bodyScrollTop: document.body.scrollTop,
        rootScrollTop: root.scrollTop,
        shellScrollTop: shell.scrollTop,
        sidebarScrollTop: sidebar.scrollTop,
        navScrollLeft: nav.scrollLeft,
        navScrollTop: nav.scrollTop,
        nav: {
          left: navRect.left, right: navRect.right, width: navRect.width,
          clientWidth: nav.clientWidth, scrollWidth: nav.scrollWidth,
        },
        moreChevronDisplay: getComputedStyle(document.querySelector('.nav-more-chevron')).display,
        itemSizes: items.map((item) => {
          const rect = item.getBoundingClientRect()
          return {
            id: item.getAttribute('data-navigation-id') ?? item.getAttribute('aria-label') ?? item.textContent?.trim(),
            width: rect.width,
            height: rect.height,
            left: rect.left,
            right: rect.right,
          }
        }),
        iconSizes: icons.map((icon) => {
          if (!(icon instanceof SVGElement)) return null
          const rect = icon.getBoundingClientRect()
          return { width: rect.width, height: rect.height, left: rect.left, right: rect.right }
        }),
        sidebar: { top: sidebarRect.top, bottom: sidebarRect.bottom, left: sidebarRect.left, right: sidebarRect.right },
        brand: { top: brandRect.top, bottom: brandRect.bottom },
        bottom: { top: bottomRect.top, bottom: bottomRect.bottom },
        root: { top: rootRect.top, bottom: rootRect.bottom },
        shell: { top: shellRect.top, bottom: shellRect.bottom },
      }
    })
    assert.ok(collapsed)
    assert.deepEqual(
      {
        pageScrollY: collapsed.pageScrollY,
        documentScrollTop: collapsed.documentScrollTop,
        bodyScrollTop: collapsed.bodyScrollTop,
        rootScrollTop: collapsed.rootScrollTop,
        shellScrollTop: collapsed.shellScrollTop,
        sidebarScrollTop: collapsed.sidebarScrollTop,
      },
      { pageScrollY: 0, documentScrollTop: 0, bodyScrollTop: 0, rootScrollTop: 0, shellScrollTop: 0, sidebarScrollTop: 0 },
      `折叠侧栏祖先出现隐藏滚动: ${JSON.stringify(collapsed)}`,
    )
    assert.equal(collapsed.navScrollLeft, 0)
    assert.ok(collapsed.navScrollTop >= 0)
    assert.equal(collapsed.moreChevronDisplay, 'none')
    assert.ok(
      collapsed.brand.top >= 0 && collapsed.brand.bottom <= 620,
      `品牌区越过折叠侧栏边界: ${JSON.stringify({ brand: collapsed.brand, sidebar: collapsed.sidebar, nav: collapsed.nav, navScrollTop: collapsed.navScrollTop })}`,
    )
    assert.ok(
      collapsed.bottom.top >= 0 && collapsed.bottom.bottom <= 620,
      `账户与控制区越过折叠侧栏边界: ${JSON.stringify({ bottom: collapsed.bottom, sidebar: collapsed.sidebar, nav: collapsed.nav })}`,
    )
    for (const item of collapsed.itemSizes) {
      assert.deepEqual({ width: item.width, height: item.height }, { width: 40, height: 40 })
    }
    const outsideItems = collapsed.itemSizes.filter((item) => (
      item.left < collapsed.sidebar.left || item.right > collapsed.sidebar.right
    ))
    assert.deepEqual(
      outsideItems,
      [],
      `导航项越过折叠侧栏边界: ${JSON.stringify({ outsideItems, sidebar: collapsed.sidebar, nav: collapsed.nav })}`,
    )
    for (const icon of collapsed.iconSizes) {
      assert.ok(icon)
      assert.deepEqual({ width: icon.width, height: icon.height }, { width: 18, height: 18 })
      assert.ok(icon.left >= collapsed.sidebar.left && icon.right <= collapsed.sidebar.right)
    }
    await sidebar.screenshot({ path: 'test-results/sidebar-collapsed-dark.png' })
  }, { viewport: { width: 960, height: 620 } })
})

test('StrictMode account panels finish their initial requests instead of staying on loading overlays', async () => {
  await withFixture(async (page, baseUrl) => {
    for (const section of ['dashboard', 'usage', 'tasks']) {
      await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&section=${section}&strict=true`)
      await page.waitForFunction(() => !document.body.textContent?.includes('正在汇总模型调用数据')
        && !document.body.textContent?.includes('正在读取使用日志')
        && !document.body.textContent?.includes('正在读取任务日志'))
      assert.equal(await page.locator('[aria-busy="true"]').count(), 0)
    }
  })
})

test('sidebar started collapsed keeps every primary icon inside the rail', async () => {
  await withFixture(async (page, baseUrl) => {
    await page.goto(baseUrl + '/e2e/account-commerce-fixture.html?scenario=sidebar&theme=dark&collapsed=true&more=true')
    const result = await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const sidebar = document.querySelector('.sidebar')
      const nav = document.querySelector('.main-nav')
      const items = Array.from(document.querySelectorAll('.main-nav > .nav-group > .nav-item'))
      if (!(sidebar instanceof HTMLElement) || !(nav instanceof HTMLElement)) return null
      nav.scrollLeft = 80
      nav.dispatchEvent(new Event('scroll'))
      const sidebarRect = sidebar.getBoundingClientRect()
      return {
        navScrollLeft: nav.scrollLeft,
        items: items.map((item) => {
          const icon = item.querySelector(':scope > svg')
          const itemRect = item.getBoundingClientRect()
          const iconRect = icon?.getBoundingClientRect()
          return {
            itemLeft: itemRect.left,
            itemRight: itemRect.right,
            iconLeft: iconRect?.left ?? -1,
            iconRight: iconRect?.right ?? -1,
          }
        }),
        sidebarLeft: sidebarRect.left,
        sidebarRight: sidebarRect.right,
      }
    })
    assert.ok(result)
    assert.equal(result.navScrollLeft, 0)
    for (const item of result.items) {
      assert.ok(item.itemLeft >= result.sidebarLeft && item.itemRight <= result.sidebarRight)
      assert.ok(item.iconLeft >= result.sidebarLeft && item.iconRight <= result.sidebarRight)
    }
  }, { viewport: { width: 960, height: 620 } })
})

test('visual fixture renders every account section and tutorial in both themes', async () => {
  await withFixture(async (page, baseUrl) => {
    const sections = [
      ['overview', '概览', '$4.00'],
      ['dashboard', '数据看板', 'gpt-5.6-sol'],
      ['subscriptions', '钱包', '星芒专业版'],
      ['topup', '钱包', '支付宝'],
      ['orders', '钱包', 'XM-ORDER-20260815'],
      ['redeem', '钱包', null],
      ['usage', '使用日志', 'gpt-5.4'],
      ['tasks', '任务日志', 'sora-2'],
      ['keys', 'API 密钥', 'Codex-Pro 主密钥'],
      ['invite', '钱包', 'FIXTURE'],
      ['profile', '个人资料', '显示名称'],
      ['security', '个人资料', '10.0.0.2'],
      ['tutorial', '使用教程', '首次使用'],
    ]

    for (const theme of ['light', 'dark']) {
      for (const [section, heading, marker] of sections) {
        const url = new URL('/e2e/account-commerce-fixture.html', baseUrl)
        url.searchParams.set('scenario', 'visual')
        url.searchParams.set('theme', theme)
        url.searchParams.set('section', section)
        await page.goto(url.href)
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme)
        assert.equal(await page.locator('body').getAttribute('data-fixture-section'), section)
        await page.getByRole('heading', { name: heading, exact: true }).first().waitFor()
        if (section === 'redeem') {
          await page.getByPlaceholder('输入兑换码').waitFor()
        } else {
          const markerLocator = section === 'dashboard'
            ? page.locator('.account-dashboard-legend').getByText(marker, { exact: true }).first()
            : page.getByText(marker, { exact: false }).first()
          await markerLocator.waitFor()
        }
        const layout = await page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
          clientHeight: document.documentElement.clientHeight,
          scrollHeight: document.documentElement.scrollHeight,
          hasAccountWorkspace: Boolean(document.querySelector('.account-center-workspace')),
          hasTutorial: Boolean(document.querySelector('.tutorial-page')),
        }))
        assert.equal(layout.scrollWidth <= layout.clientWidth, true, theme + '/' + section + ' 不应出现文档级横向溢出')
        assert.equal(layout.scrollHeight <= layout.clientHeight, true, theme + '/' + section + ' 不应出现文档级纵向溢出')
        assert.equal(layout.hasAccountWorkspace || layout.hasTutorial, true, theme + '/' + section + ' 应渲染可验收工作区')

        if (section === 'security') {
          const scrollResult = await page.evaluate(() => {
            const body = document.querySelector('.account-center-body')
            const target = Array.from(document.querySelectorAll('button'))
              .find((element) => element.textContent?.includes('退出其他设备'))
            if (!(body instanceof HTMLElement) || !(target instanceof HTMLElement)) return null
            target.scrollIntoView({ block: 'end' })
            const bodyRect = body.getBoundingClientRect()
            const targetRect = target.getBoundingClientRect()
            return {
              scrolled: body.scrollTop > 0,
              visible: targetRect.top >= bodyRect.top - 1 && targetRect.bottom <= bodyRect.bottom + 1,
            }
          })
          assert.deepEqual(scrollResult, { scrolled: true, visible: true })
        }

        if (section === 'keys') {
          const stickyResult = await page.evaluate(() => {
            const table = document.querySelector('.account-center-keys-table')
            const actions = document.querySelector('.account-center-keys-row .account-center-keys-actions')
            if (!(table instanceof HTMLElement) || !(actions instanceof HTMLElement)) return null
            table.scrollLeft = table.scrollWidth
            const tableRect = table.getBoundingClientRect()
            const actionsRect = actions.getBoundingClientRect()
            return {
              scrolled: table.scrollLeft > 0,
              sticky: getComputedStyle(actions).position === 'sticky',
              visible: actionsRect.left >= tableRect.left - 1 && actionsRect.right <= tableRect.right + 1,
            }
          })
          assert.deepEqual(stickyResult, { scrolled: true, sticky: true, visible: true })
        }
      }
    }
  }, { viewport: { width: 960, height: 620 } })
})

test('dark account form controls use readable adaptive surfaces in every interaction state', async () => {
  await withFixture(async (page, baseUrl) => {
    const artifactDirectory = path.join(projectRoot, 'test-results', 'change-11')
    await fs.mkdir(artifactDirectory, { recursive: true })

    for (const section of ['usage', 'tasks']) {
      await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&theme=dark&section=${section}`)
      const gridSelector = section === 'usage' ? '.account-usage-filter-grid' : '.account-task-filter-grid'
      const controls = page.locator(`${gridSelector} input, ${gridSelector} select`)
      await controls.first().waitFor()
      const styles = await controls.evaluateAll((elements) => elements.map((element) => {
        const style = getComputedStyle(element)
        const placeholder = element instanceof HTMLInputElement
          ? getComputedStyle(element, '::placeholder').color
          : null
        return {
          background: style.backgroundColor,
          border: style.borderTopColor,
          color: style.color,
          colorScheme: style.colorScheme,
          placeholder,
        }
      }))

      for (const style of styles) {
        assert.ok(Math.max(...parseRgb(style.background)) < 80, `${section} 暗色控件不应显示高亮白底`)
        assert.ok(contrastRatio(style.color, style.background) >= 4.5, `${section} 控件正文对比度不足`)
        assert.ok(contrastRatio(style.border, style.background) >= 1.3, `${section} 控件边界不清晰`)
        assert.equal(style.colorScheme, 'dark', `${section} 原生控件应使用暗色配色`)
        if (style.placeholder) {
          assert.ok(contrastRatio(style.placeholder, style.background) >= 4.5, `${section} placeholder 对比度不足`)
        }
      }

      const firstInput = controls.first()
      await firstInput.focus()
      const focusStyle = await firstInput.evaluate((element) => {
        const style = getComputedStyle(element)
        return { background: style.backgroundColor, border: style.borderTopColor, shadow: style.boxShadow }
      })
      assert.ok(Math.max(...parseRgb(focusStyle.background)) < 80, `${section} focus 状态不应变成亮色背景`)
      assert.ok(parseRgb(focusStyle.border)[2] > parseRgb(focusStyle.border)[0], `${section} focus 边框应保留冷青色提示`)
      assert.notEqual(focusStyle.shadow, 'none')

      await firstInput.evaluate((element) => { element.disabled = true })
      const disabledBackground = await firstInput.evaluate((element) => getComputedStyle(element).backgroundColor)
      assert.ok(Math.max(...parseRgb(disabledBackground)) < 60, `${section} disabled 状态不应变成亮色背景`)
    }

    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&theme=light&section=usage`)
    const lightBackground = await page.locator('.account-usage-filter-grid input').first().evaluate((element) => getComputedStyle(element).backgroundColor)
    assert.ok(Math.min(...parseRgb(lightBackground)) > 230, '亮色主题应继续使用柔和浅色输入面')

    await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&theme=dark&section=usage`)
    for (const selector of ['.account-usage-page-buttons button.active', '.account-center-recharge-button']) {
      const style = await page.locator(selector).first().evaluate((element) => {
        const computed = getComputedStyle(element)
        return { background: computed.backgroundColor, color: computed.color }
      })
      assert.ok(Math.max(...parseRgb(style.background)) < 80, `${selector} 不应在暗色主题中显示亮色软底`)
      assert.ok(contrastRatio(style.color, style.background) >= 4.5, `${selector} 文字对比度不足`)
    }
    await page.screenshot({ path: path.join(artifactDirectory, '1590x875-usage-dark.png'), fullPage: false })
  }, { viewport: { width: 1590, height: 875 } })
})

test('Change-8 account navigation and log tables pass multi-viewport visual checks', async () => {
  await withFixture(async (page, baseUrl) => {
    const artifactDirectory = path.join(projectRoot, 'test-results', 'change-8')
    await fs.mkdir(artifactDirectory, { recursive: true })
    const viewports = [
      { width: 960, height: 620 },
      { width: 1366, height: 768 },
      { width: 1590, height: 875 },
      { width: 3840, height: 2160 },
    ]
    for (const viewport of viewports) {
      await page.setViewportSize(viewport)
      for (const section of ['overview', 'dashboard', 'usage', 'tasks']) {
        const url = new URL('/e2e/account-commerce-fixture.html', baseUrl)
        url.searchParams.set('scenario', 'visual')
        url.searchParams.set('theme', 'dark')
        url.searchParams.set('section', section)
        await page.goto(url.href)
        await page.locator('.account-center-workspace').waitFor()
        if (section === 'dashboard') {
          await page.locator('.account-dashboard-legend').getByText('gpt-5.6-sol', { exact: true }).first().waitFor()
        }
        const metrics = await page.evaluate((targetSection) => {
          const workspace = document.querySelector('.account-center-workspace')
          const body = document.querySelector('.account-center-body')
          const navButtons = Array.from(document.querySelectorAll('.account-center-navigation nav button'))
          const table = document.querySelector(targetSection === 'usage' ? '.account-usage-table-scroll' : '.account-task-table-scroll')
          const sticky = document.querySelector(targetSection === 'usage' ? '.account-usage-table-row > :last-child' : '.account-task-table-row > :last-child')
          if (!(workspace instanceof HTMLElement) || !(body instanceof HTMLElement)) return null
          if (table instanceof HTMLElement) table.scrollLeft = table.scrollWidth
          const tableRect = table instanceof HTMLElement ? table.getBoundingClientRect() : null
          const stickyRect = sticky instanceof HTMLElement ? sticky.getBoundingClientRect() : null
          return {
            documentOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            documentOverflowY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
            workspaceInsideViewport: workspace.getBoundingClientRect().right <= document.documentElement.clientWidth + 1,
            navButtonsVisible: navButtons.every((button) => {
              const rect = button.getBoundingClientRect()
              return rect.width > 0 && rect.height > 0
            }),
            stickyVisible: tableRect && stickyRect
              ? getComputedStyle(sticky).position === 'sticky'
                && stickyRect.left >= tableRect.left - 1
                && stickyRect.right <= tableRect.right + 1
              : true,
            bodyHasScrollableContent: body.scrollHeight >= body.clientHeight,
          }
        }, section)
        assert.ok(metrics)
        assert.equal(metrics.documentOverflowX, false, `${viewport.width}x${viewport.height}/${section} 文档横向溢出`)
        assert.equal(metrics.documentOverflowY, false, `${viewport.width}x${viewport.height}/${section} 文档纵向溢出`)
        assert.equal(metrics.workspaceInsideViewport, true)
        assert.equal(metrics.navButtonsVisible, true)
        assert.equal(metrics.stickyVisible, true)
        await page.screenshot({
          path: path.join(artifactDirectory, `${viewport.width}x${viewport.height}-${section}-dark.png`),
          fullPage: false,
        })
      }
    }
  }, { viewport: { width: 1590, height: 875 } })
})
