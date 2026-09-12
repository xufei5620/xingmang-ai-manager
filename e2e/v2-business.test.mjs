import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs/promises'
import { before, after, test } from 'node:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

let browser, server, origin
before(async () => {
  process.env.XINGMANG_RENDERER = 'v2'
  server = await createServer({
    root: path.resolve('.'),
    cacheDir: 'node_modules/.vite-v2-business-tests',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 5191, strictPort: false },
  })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined,
  })
})
after(async () => {
  await browser?.close()
  await server?.close()
})
const fixture = async (route) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  page.setDefaultTimeout(5000)
  page.setDefaultNavigationTimeout(30000)
  page.on('pageerror', (error) => console.error(error.message))
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  )
  await page.goto(`${origin}/e2e/v2-business-fixture.html?${route}`)
  return page
}
const calls = (page) =>
  page.evaluate(() =>
    JSON.parse(document.documentElement.dataset.calls || '[]'),
  )

async function openUsageDetails(page) {
  await page.getByRole('tab', { name: '调用明细', exact: true }).click()
  await page.getByRole('button', { name: '详情', exact: true }).click()
  const dialog = page.getByTestId('usage-detail-dialog')
  await dialog.waitFor()
  return dialog
}

test('usage details include request metadata, token counts, exact billed cost and the matched dynamic price tier', async () => {
  await fs.mkdir(path.resolve('artifacts/usage-details'), { recursive: true })
  for (const theme of ['light', 'dark']) {
    const page = await fixture(`page=account&usageDetail=tiered&theme=${theme}`)
    try {
      const dialog = await openUsageDetails(page)
      assert.equal(await dialog.locator('.xm-dialog-body').evaluate((element) => element.scrollTop), 0)
      const info = dialog.locator('section[aria-label="调用信息"]')
      assert.match(await info.innerText(), /xingmang-desktop-codex[\s\S]*GPT-中转\/订阅[\s\S]*16 秒[\s\S]*4,778 ms[\s\S]*xhigh/)
      assert.match(await dialog.locator('section[aria-label="Token 明细"]').innerText(), /输入 Token\s*368,531[\s\S]*输出 Token\s*311[\s\S]*缓存读取\s*368,000/)
      const billing = dialog.locator('section[aria-label="计费详情"]')
      for (const expected of ['动态计费', 'long', '$25/M', '$75/M', '$2/M', '1.0000x', '$0.7726']) assert.ok((await billing.innerText()).includes(expected), expected)
      const table = dialog.getByRole('table')
      assert.equal(await table.locator('tbody tr').count(), 2)
      assert.equal(await table.locator('.is-matched').count(), 1)
      assert.match(await table.locator('.is-matched').innerText(), /long[\s\S]*已命中[\s\S]*\$25\.0000[\s\S]*\$75\.0000[\s\S]*\$2\.0000/)
      assert.match(await table.locator('tbody tr').first().innerText(), /short[\s\S]*272,000[\s\S]*\$10\.0000/)
      await dialog.screenshot({ path: path.resolve(`artifacts/usage-details/tiered-${theme}-top.png`) })
      await table.scrollIntoViewIfNeeded()
      await dialog.screenshot({ path: path.resolve(`artifacts/usage-details/tiered-${theme}-pricing.png`) })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.equal(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth), false)
      await dialog.getByRole('button', { name: '关闭', exact: true }).last().click()
      assert.equal(await page.getByRole('button', { name: '详情', exact: true }).evaluate((element) => document.activeElement === element), true)
    } finally { await page.close() }
  }
})

test('usage details retain ordinary cache prices and distinguish missing prices from confirmed zero charges', async () => {
  for (const kind of ['legacy', 'missing', 'unknown-tier', 'sub2', 'sub2-missing', 'stream-error']) {
    const page = await fixture(`page=account&usageDetail=${kind}`)
    try {
      const dialog = await openUsageDetails(page)
      const billing = dialog.locator('section[aria-label="计费详情"]')
      const text = await dialog.innerText()
      if (kind === 'legacy') {
        assert.match(await billing.innerText(), /按 Token 计费[\s\S]*\$3\/M[\s\S]*\$15\/M[\s\S]*\$0\.3\/M[\s\S]*用户专属倍率\s*0\.5000x/)
        assert.match(text, /缓存写入（5 分钟）\s*1,000[\s\S]*缓存写入（1 小时）\s*500/)
        assert.equal(await dialog.getByRole('table').count(), 0)
      } else if (kind === 'missing' || kind === 'unknown-tier') {
        assert.doesNotMatch(await billing.innerText(), /\$25\/M|\$75\/M/)
        assert.match(await billing.innerText(), /\$0\.7726/)
        assert.match(text, /请以服务端记录的总费用为准/)
        assert.equal(await dialog.locator('.is-matched').count(), 0)
        if (kind === 'missing') assert.doesNotMatch(text, /未提供 ms/)
      } else if (kind === 'sub2') {
        assert.match(await billing.innerText(), /订阅额度[\s\S]*0\.5000x[\s\S]*已触发[\s\S]*\$0\.013275[\s\S]*\$0\.023325[\s\S]*\$0\.7360[\s\S]*\$0\.0000[\s\S]*\$0\.7726[\s\S]*\$0\.3863/)
        assert.equal(await dialog.getByRole('table').count(), 0)
        assert.doesNotMatch(await billing.innerText(), /\/M/)
      } else if (kind === 'sub2-missing') {
        assert.match(await billing.innerText(), /总费用\s*未提供/)
        assert.doesNotMatch(await billing.innerText(), /\$0\.0000|\$0\.7726/)
      } else {
        assert.match(text, /流式响应详情[\s\S]*upstream_error[\s\S]*连接中断[\s\S]*请稍后重试/)
        assert.equal(await dialog.locator('script').count(), 0)
        assert.equal(await page.evaluate(() => window.usageXss), undefined)
      }
    } finally { await page.close() }
  }
})

test('account exposes the exact nine tabs and keeps server orders and keys visible', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '我的账号', exact: true }).waitFor()
    assert.deepEqual(await page.getByRole('tab').allTextContents(), [
      '我的账号',
      '用量看板',
      '密钥',
      '调用明细',
      '异步任务',
      '充值与订阅',
      '我的订单',
      '邀请返利',
      '登录设备',
    ])
    await page.getByRole('tab', { name: '我的订单', exact: true }).click()
    await page.getByText('TEST-ORDER').waitFor()
    await page.getByText('已到账', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByText('Test key').waitFor()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await page.getByText('密钥已复制', { exact: true }).waitFor()
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'copy-key').args,
      1,
    )
  } finally {
    await page.close()
  }
})

test('redeeming subscription and concurrency codes reports the committed result and refreshes account data once', async () => {
  for (const [type, message] of [['subscription', '订阅兑换成功'], ['concurrency', '并发额度兑换成功'], ['balance', '余额兑换成功']]) {
    const page = await fixture(`page=account&redemptionType=${type}`)
    try {
      await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
      await page.getByLabel('充值码', { exact: true }).fill('MOCK-CARD')
      await page.getByRole('button', { name: '兑换', exact: true }).click()
      const before = await calls(page)
      await page.getByRole('dialog', { name: '确认兑换到当前账号？' }).getByRole('button', { name: '确认兑换', exact: true }).click()
      await page.getByText(message, { exact: true }).waitFor()
      await page.waitForFunction((previous) => {
        const current = JSON.parse(document.documentElement.dataset.calls || '[]')
        return ['get-profile', 'get-balance', 'get-subscriptions'].every((name) =>
          current.filter((call) => call.name === name).length > previous.filter((call) => call.name === name).length)
      }, before)
      assert.equal((await calls(page)).filter((call) => call.name === 'redeem-code').length, 1)
      assert.equal(await page.getByLabel('充值码', { exact: true }).inputValue(), '')
      assert.equal(await page.getByRole('dialog', { name: '确认兑换到当前账号？' }).count(), 0)
    } finally { await page.close() }
  }
})

test('key editor re-reads available groups every time a new or existing key is opened', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByText('Test key').waitFor()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-A']))
    await page.getByTestId('account-key-add').click()
    const group = page.getByTestId('account-key-group')
    await page.waitForFunction(() => document.querySelector('[data-testid="account-key-group"]')?.value === 'group-A')
    await page.getByRole('dialog', { name: '新建密钥', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-B']))
    await page.getByTestId('account-key-add').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="account-key-group"]')?.value === 'group-B')
    assert.equal(await group.locator('option[value="group-A"]').count(), 0)
    const beforeOpen = await page.evaluate(() => {
      window.keyGroupsHarness.setGroups(['group-B', 'group-D'])
      // Move only the fixture clock beyond the focus/pointer coalescing window.
      const previousNow = Date.now
      Date.now = () => previousNow() + 1000
      return window.keyGroupsHarness.requests
    })
    await group.click()
    await page.keyboard.press('Escape')
    await page.waitForFunction((before) => window.keyGroupsHarness.requests > before, beforeOpen)
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="account-key-group"] option[value="group-D"]')))
    await page.getByRole('dialog', { name: '新建密钥', exact: true }).getByRole('button', { name: '取消', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['default', 'group-C']))
    await page.locator('.xm-list-row').filter({ has: page.getByText('Test key') }).locator('button[aria-haspopup="menu"]').click()
    await page.getByRole('menuitem', { name: '编辑密钥', exact: true }).click()
    await page.getByRole('dialog', { name: '编辑密钥', exact: true }).waitFor()
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="account-key-group"] option[value="group-C"]')))
    assert.equal(await group.inputValue(), 'default')
    assert.equal(await page.getByLabel('名称', { exact: true }).inputValue(), 'Test key')
  } finally { await page.close() }
})

test('refreshing key groups preserves the draft and requires a new choice when the selected group disappears', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByText('Test key').waitFor()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-A', 'group-B']))
    await page.getByTestId('account-key-add').click()
    const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true })
    const group = page.getByTestId('account-key-group')
    await group.selectOption('group-B')
    await dialog.getByLabel('名称', { exact: true }).fill('draft key')
    await dialog.getByLabel('可用额度（USD）', { exact: true }).fill('12.34')
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-B', 'group-C']))
    await page.getByTestId('account-key-groups-refresh').click()
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="account-key-group"] option[value="group-C"]')))
    assert.equal(await group.inputValue(), 'group-B')
    assert.equal(await dialog.getByLabel('名称', { exact: true }).inputValue(), 'draft key')
    assert.equal(await dialog.getByLabel('可用额度（USD）', { exact: true }).inputValue(), '12.34')
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-C']))
    await page.getByTestId('account-key-groups-refresh').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="account-key-groups-refresh"]')?.disabled)
    const save = dialog.getByRole('button', { name: '保存密钥', exact: true })
    assert.equal(await save.isDisabled(), true)
    assert.notEqual(await group.inputValue(), 'group-C')
    assert.equal((await calls(page)).filter((call) => call.name === 'create-key').length, 0)
    await group.selectOption('group-C')
    await save.click()
    await page.getByText('密钥已保存', { exact: true }).waitFor()
    const created = (await calls(page)).find((call) => call.name === 'create-key').args
    assert.deepEqual({ name: created.name, group: created.group, remainQuota: created.remainQuota }, { name: 'draft key', group: 'group-C', remainQuota: 1234 })
  } finally { await page.close() }
})

test('pending or failed key group requests block saves and can be retried without clearing inputs', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByText('Test key').waitFor()
    await page.evaluate(() => { window.keyGroupsHarness.setGroups(['group-A']); window.keyGroupsHarness.deferNext() })
    await page.getByTestId('account-key-add').click()
    const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true })
    const save = dialog.getByRole('button', { name: '保存密钥', exact: true })
    await dialog.getByLabel('名称', { exact: true }).fill('keep pending draft')
    await dialog.getByLabel('可用额度（USD）', { exact: true }).fill('3.25')
    assert.equal(await save.isDisabled(), true)
    assert.equal((await calls(page)).filter((call) => call.name === 'create-key').length, 0)
    await page.evaluate(() => window.keyGroupsHarness.release())
    await page.waitForFunction(() => document.querySelector('[data-testid="account-key-group"]')?.value === 'group-A')
    await page.evaluate(() => window.keyGroupsHarness.failNext())
    await page.getByTestId('account-key-groups-refresh').click()
    await dialog.getByText('分组读取失败，请刷新后重试。', { exact: true }).waitFor()
    assert.equal(await save.isDisabled(), true)
    assert.equal(await dialog.getByLabel('名称', { exact: true }).inputValue(), 'keep pending draft')
    assert.equal(await dialog.getByLabel('可用额度（USD）', { exact: true }).inputValue(), '3.25')
    assert.equal((await calls(page)).filter((call) => call.name === 'create-key').length, 0)
    await page.getByTestId('account-key-groups-refresh').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="account-key-groups-refresh"]')?.disabled)
    await save.click()
    await page.getByText('密钥已保存', { exact: true }).waitFor()
    assert.equal((await calls(page)).filter((call) => call.name === 'create-key').length, 1)
    await page.evaluate(() => { window.keyGroupsHarness.setGroups(['outdated-group']); window.keyGroupsHarness.deferNext() })
    await page.getByTestId('account-key-add').click()
    assert.equal(await save.isDisabled(), true)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['fresh-group']))
    await page.getByTestId('account-key-add').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="account-key-group"]')?.value === 'fresh-group')
    await page.evaluate(async () => {
      window.keyGroupsHarness.release()
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    assert.equal(await page.getByTestId('account-key-group').inputValue(), 'fresh-group')
    assert.equal(await page.getByTestId('account-key-group').locator('option[value="outdated-group"]').count(), 0)
  } finally { await page.close() }
})

test('settings failure restores the persisted control and never announces success', async () => {
  const page = await fixture('page=settings&fail=settings')
  try {
    const control = page.getByRole('switch', { name: '减少动画', exact: true })
    await control.click()
    await page.getByText('设置写入失败', { exact: true }).waitFor()
    assert.equal(await control.getAttribute('aria-checked'), 'false')
    assert.equal(await page.getByText('已保存', { exact: true }).count(), 0)
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'settings').args,
      { version: 2, reducedMotion: true },
    )
  } finally {
    await page.close()
  }
})

test('session detail shows transcript and archives the native id after a user action', async () => {
  const page = await fixture('page=sessions')
  try {
    await page.getByRole('button', { name: '查看记录', exact: true }).click()
    const drawer = page.getByRole('dialog')
    await drawer.getByText('这是一条测试消息').waitFor()
    await drawer.getByRole('button', { name: '归档记录', exact: true }).click()
    await page.getByText('测试归档失败').first().waitFor()
    assert.equal(
      (await calls(page)).find((call) => call.name === 'archive').args,
      'session-1',
    )
    assert.equal(await drawer.isVisible(), true)
  } finally {
    await page.close()
  }
})

test('session detail exposes a retry action after a temporary read failure', async () => {
  const page = await fixture('page=sessions&detailFailure=1')
  try {
    await page.getByRole('button', { name: '查看记录', exact: true }).click()
    const drawer = page.getByTestId('session-detail-drawer')
    await drawer.getByText('会话详情暂时不可读', { exact: true }).waitFor()
    await drawer.getByRole('button', { name: '重试读取', exact: true }).click()
    await drawer.getByText('这是一条测试消息', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('extension toggle preserves original state and reports mutation failure', async () => {
  const page = await fixture('page=mcp')
  try {
    const control = page.getByRole('switch', { name: '已启用', exact: true })
    await control.click()
    await page.getByText('扩展操作失败，已有配置保留').waitFor()
    assert.equal(await control.getAttribute('aria-checked'), 'true')
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'extension').args,
      {
        provider: 'claude',
        kind: 'mcp',
        action: 'disable',
        id: 'test-extension',
      },
    )
  } finally {
    await page.close()
  }
})

test('backup restore requires preview and confirmation before touching files', async () => {
  const page = await fixture('page=backups')
  try {
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await page
      .getByRole('dialog')
      .getByText('config.toml', { exact: true })
      .waitFor()
    await page
      .getByRole('button', { name: '恢复这份配置', exact: true })
      .click()
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'restore-backup')
        .length,
      0,
    )
    await page
      .getByRole('button', { name: '备份当前配置并恢复', exact: true })
      .click()
    await page.getByText('配置已恢复，恢复前备份已保留').waitFor()
    assert.equal(
      (await calls(page)).find((call) => call.name === 'restore-backup').args,
      'backup-1',
    )
  } finally {
    await page.close()
  }
})

test('feedback copy and export retain the preview snapshot id', async () => {
  const page = await fixture('page=feedback')
  try {
    await page
      .getByRole('button', { name: '预览反馈报告', exact: true })
      .click()
    await page.getByTestId('feedback-report-text').waitFor()
    await page.getByRole('button', { name: '复制报告', exact: true }).click()
    await page.getByRole('button', { name: '导出文件', exact: true }).click()
    await page.getByText('导出操作已结束').first().waitFor()
    assert.deepEqual(
      (await calls(page))
        .filter((call) => ['copy-report', 'export-report'].includes(call.name))
        .map((call) => call.args),
      ['report-snapshot-7', 'report-snapshot-7'],
    )
  } finally {
    await page.close()
  }
})

test('available update displays download action and failed download remains reviewable', async () => {
  const page = await fixture('page=updates')
  try {
    await page.getByRole('button', { name: '下载更新', exact: true }).click()
    await page.getByText('测试下载失败').waitFor()
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'download-update')
        .length,
      1,
    )
    assert.equal(
      await page.getByRole('button', { name: '重启安装', exact: true }).count(),
      0,
    )
  } finally {
    await page.close()
  }
})

test('payment return only re-queries server orders and preserves the profile draft', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByTestId('account-display').fill('还没有保存的名称')
    await page.evaluate(() => dispatchEvent(new Event('test-payment-return')))
    await page.getByText('TEST-ORDER').waitFor()
    const count = (await calls(page)).filter(
      (call) => call.name === 'query-orders',
    ).length
    await page.evaluate(() => dispatchEvent(new Event('test-payment-return')))
    await page.waitForFunction(
      (previous) =>
        JSON.parse(document.documentElement.dataset.calls || '[]').filter(
          (call) => call.name === 'query-orders',
        ).length > previous,
      count,
    )
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'query-orders').at(-1)
        .args,
      { page: 1, pageSize: 20, keyword: 'TEST-ORDER' },
    )
    assert.equal(
      (await calls(page)).some((call) =>
        /payment|redeem|purchase/.test(call.name),
      ),
      false,
    )
    await page.getByRole('tab', { name: '我的账号', exact: true }).click()
    assert.equal(
      await page.getByTestId('account-display').inputValue(),
      '还没有保存的名称',
    )
  } finally {
    await page.close()
  }
})

test('subscription payment terminal events clear the pending state and explain the outcome', async () => {
  const page = await fixture('page=account&subscriptionExternal=1')
  try {
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    await page.getByRole('button', { name: '购买', exact: true }).waitFor()
    await page.getByRole('button', { name: '购买', exact: true }).click()
    await page.getByRole('button', { name: '打开支付窗口', exact: true }).click()
    await page.getByText('订阅订单 XM-VISUAL-SUBSCRIPTION', { exact: false }).waitFor()
    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'closed', tradeNo: 'XM-VISUAL-SUBSCRIPTION' }))
    await page.getByText('支付窗口已关闭', { exact: true }).waitFor()
    assert.equal(await page.getByText('等待支付结果', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('changing the recharge channel invalidates the previous quote', async () => {
  const page = await fixture('page=account&multiPayment=1')
  try {
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    await page.getByRole('radio', { name: 'Stripe', exact: true }).check()
    await page.getByTestId('account-recharge-submit').click()
    const quote = page.getByRole('dialog', { name: '确认充值报价' })
    await quote.waitFor()
    await quote.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('radio', { name: '支付宝', exact: true }).check()
    assert.equal(await page.getByRole('dialog', { name: '确认充值报价' }).count(), 0)
    assert.equal(await page.getByLabel('自定义金额').inputValue(), '20')
  } finally {
    await page.close()
  }
})

test('confirmed topup completion refreshes balance and cached orders and clears waiting state', async () => {
  for (const fast of [false, true]) {
    const page = await fixture(`page=account${fast ? '&fastPayment=1' : ''}`)
    try {
      await page.getByRole('tab', { name: '我的订单', exact: true }).click()
      await page.getByText('TEST-ORDER').waitFor()
      const ordersBefore = (await calls(page)).filter((call) => call.name === 'query-orders').length
      await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
      await page.getByTestId('account-recharge-submit').click()
      await page.getByRole('dialog', { name: '确认充值报价' }).getByRole('button', { name: '打开支付窗口' }).click()
      if (!fast) {
        await page.getByText('等待支付结果', { exact: true }).waitFor()
        // An unrelated order or a result without correlation must not finish this payment.
        await page.evaluate(() => {
          window.emitPaymentWindowTerminal({ status: 'success', tradeNo: 'OTHER-ORDER' })
          window.emitPaymentWindowTerminal({ status: 'success', tradeNo: null })
        })
        assert.equal(await page.getByText('等待支付结果', { exact: true }).isVisible(), true)
        await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'success', tradeNo: 'XM-VISUAL-TOPUP' }))
      }
      await page.getByText('充值成功', { exact: true }).waitFor()
      await page.getByText('当前余额 $14.00', { exact: true }).waitFor()
      assert.equal(await page.getByText('等待支付结果', { exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: '关闭支付窗口', exact: true }).count(), 0)
      assert.equal(await page.getByText('支付窗口已打开，到账状态请查询订单', { exact: true }).count(), 0)
      assert.ok((await calls(page)).filter((call) => call.name === 'query-orders').length > ordersBefore)
      assert.equal((await calls(page)).filter((call) => call.name === 'create-topup-payment').length, 1)
      if (!fast) await page.screenshot({ path: 'artifacts/renderer-v2-app/topup-confirmed.png' })
    } finally { await page.close() }
  }
})

test('native preferences use the independent bridge while proxy remains a read-only query', async () => {
  const page = await fixture('page=settings&system=1')
  try {
    await page.getByRole('button', { name: '跟随系统', exact: true }).click()
    assert.equal(
      await page
        .getByRole('button', { name: '跟随系统', exact: true })
        .getAttribute('aria-pressed'),
      'true',
    )
    await page.getByRole('switch', { name: '高对比度', exact: true }).click()
    await page.waitForFunction(
      () => document.documentElement.dataset.contrast === 'high',
    )
    assert.equal(
      await page.evaluate(() =>
        document.documentElement.classList.contains('hc'),
      ),
      true,
    )
    await page.getByRole('tab', { name: '启动与关闭', exact: true }).click()
    await page
      .getByRole('switch', { name: '开机自动启动', exact: true })
      .click()
    await page.getByRole('tab', { name: '网络', exact: true }).click()
    await page.getByRole('button', { name: '查看路由', exact: true }).click()
    await page.getByText('应用窗口当前直接连接', { exact: true }).waitFor()
    assert.deepEqual(
      (await calls(page)).map((call) => call.name),
      [
        'platform-theme',
        'platform-contrast',
        'platform-startup',
        'platform-proxy',
      ],
    )
  } finally {
    await page.close()
  }
})

test('native preference errors retain the saved switch state', async () => {
  const page = await fixture('page=settings&system=1&fail=platform')
  try {
    const control = page.getByRole('switch', { name: '高对比度', exact: true })
    await control.click()
    await page.getByText('平台设置写入失败', { exact: true }).waitFor()
    assert.equal(await control.getAttribute('aria-checked'), 'false')
  } finally {
    await page.close()
  }
})

test('saved accounts default to no CLI sync and expose only eligible choices', async () => {
  const page = await fixture('page=account&sync=1')
  try {
    await page.getByText('同步到工具（可选）', { exact: true }).click()
    assert.equal(
      await page.getByTestId('account-sync-claude').isChecked(),
      false,
    )
    assert.equal(
      await page.getByTestId('account-sync-gemini').isChecked(),
      false,
    )
    assert.equal(
      await page.getByTestId('account-sync-codex').isDisabled(),
      true,
    )
    assert.equal(await page.getByTestId('account-sync-grok').isDisabled(), true)
    await page
      .getByRole('button', { name: '切换', exact: true, disabled: false })
      .click()
    await page.getByTestId('account-sync-result').waitFor()
    assert.equal(
      (await calls(page)).some((call) => call.name === 'sync-config'),
      false,
    )
  } finally {
    await page.close()
  }
})

test('explicit CLI sync retains partial failure details after account refresh', async () => {
  const page = await fixture('page=account&sync=1&partial=1')
  try {
    await page.getByText('同步到工具（可选）', { exact: true }).click()
    await page.getByTestId('account-sync-claude').check()
    await page.getByTestId('account-sync-gemini').check()
    await page
      .getByRole('button', { name: '切换', exact: true, disabled: false })
      .click()
    await page
      .getByText('账号已切换，部分工具没有同步', { exact: true })
      .waitFor()
    await page
      .getByText('Gemini CLI：Gemini 配置文件正在使用', { exact: true })
      .waitFor()
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'sync-config').args,
      {
        providers: ['claude', 'gemini'],
        preferredModels: { claude: 'fixture-model', gemini: 'fixture-model' },
      },
    )
    const entries = await calls(page)
    const index = entries.findIndex((call) => call.name === 'switch-account')
    assert.equal(
      entries
        .slice(index + 1)
        .some((call) => call.name === 'scan-sync' && call.args === true),
      true,
    )
  } finally {
    await page.close()
  }
})

test('failed saved-account verification never writes selected CLI config', async () => {
  const page = await fixture('page=account&sync=1&fail=switch')
  try {
    await page.getByText('同步到工具（可选）', { exact: true }).click()
    await page.getByTestId('account-sync-claude').check()
    await page
      .getByRole('button', { name: '切换', exact: true, disabled: false })
      .click()
    await page.getByText('目标账号登录已过期', { exact: true }).waitFor()
    assert.equal(
      (await calls(page)).some((call) => call.name === 'sync-config'),
      false,
    )
    assert.equal(
      await page.getByTestId('account-sync-claude').isChecked(),
      true,
    )
  } finally {
    await page.close()
  }
})

test('four skins persist via existing settings and failed changes leave the saved skin', async () => {
  for (const failed of [false, true]) {
    const page = await fixture(`page=settings${failed ? '&fail=settings' : ''}`)
    try {
      assert.equal(await page.locator('.v2-skin-chip').count(), 4)
      await page.getByTestId('settings-skin-mist').click()
      if (failed) {
        await page.getByText('设置写入失败', { exact: true }).waitFor()
        assert.equal(
          await page
            .getByTestId('settings-skin-mist')
            .getAttribute('aria-pressed'),
          'true',
        )
      } else
        await page.waitForFunction(
          () => document.documentElement.dataset.skin === 'mist',
        )
      assert.deepEqual(
        (await calls(page)).find((call) => call.name === 'settings').args,
        { version: 2, uiSkin: 'mist' },
      )
    } finally {
      await page.close()
    }
  }
})

test('test notifications respect the master switch and privacy stores only an explicit local preference', async () => {
  const page = await fixture('page=settings&system=1')
  try {
    await page.getByRole('tab', { name: '通知', exact: true }).click()
    const testNotice = page.getByRole('button', {
      name: '发一条测试通知',
      exact: true,
    })
    assert.equal(await testNotice.isDisabled(), true)
    await page.getByRole('switch', { name: '桌面通知', exact: true }).click()
    await page
      .getByRole('switch', { name: '余额不足通知', exact: true })
      .click()
    await testNotice.click()
    await page.getByText('已请求显示测试通知', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '隐私与数据', exact: true }).click()
    await page
      .getByRole('switch', { name: '匿名使用统计偏好', exact: true })
      .click()
    await page
      .getByText('偏好已保存在本机，没有上传使用记录', { exact: true })
      .waitFor()
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'platform-privacy').args,
      { kind: 'anonymousUsage', enabled: true },
    )
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'platform-notification')
        .args,
      { kind: 'balance', enabled: false },
    )
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'test-notification')
        .length,
      1,
    )
  } finally {
    await page.close()
  }
})

test('a previously observed account task sends one scoped completion notification after refresh', async () => {
  const page = await fixture('page=account&system=1&taskTransition=1')
  try {
    await page.getByRole('tab', { name: '异步任务', exact: true }).click()
    await page.getByText('处理中 50%', { exact: true }).waitFor()
    assert.equal(
      (await calls(page)).some((call) => call.name === 'activity-notification'),
      false,
    )
    await page.getByRole('button', { name: '刷新任务', exact: true }).click()
    await page.getByText('已完成 100%', { exact: true }).waitFor()
    await page.getByRole('button', { name: '刷新任务', exact: true }).click()
    const notifications = (await calls(page)).filter(
      (call) => call.name === 'activity-notification',
    )
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0].args.kind, 'task')
    assert.match(notifications[0].args.eventKey, /^https:\/\/xm\.solov\.cc:7:44:/)
  } finally {
    await page.close()
  }
})
