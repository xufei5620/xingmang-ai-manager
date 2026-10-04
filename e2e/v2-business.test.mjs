import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { before, after, test } from 'node:test'
import { openFixturePage } from './fixture-readiness.mjs'
import { actionTimeoutMs, createBrowserFixture, navigationTimeoutMs } from './harness.mjs'

const business = createBrowserFixture({
  cacheDir: 'node_modules/.vite-v2-business-tests',
  viewport: { width: 1280, height: 900 },
  sameOriginOnly: true,
  actionTimeoutMs,
  navigationTimeoutMs,
})
before(async () => {
  process.env.XINGMANG_RENDERER = 'v2'
  await business.start()
})
after(async () => {
  await business.stop()
  business.assertNoPageErrors()
})
const fixture = async (route) => {
  const page = await business.newPage()
  // First paint waits on Vite transforming the module graph on demand, which on a
  // cold Windows runner under Defender routinely takes longer than the 5s default
  // the assertions below rely on. Waiting for the mount separately keeps that
  // default tight enough to catch a real regression, and openFixturePage spends
  // that wait as three navigations rather than one — two of this suite's mounts
  // died outright on the Windows shard (quality runs #525 and #561) with the
  // tests either side of them finishing in a second.
  return await openFixturePage(page, `${business.baseUrl}/e2e/v2-business-fixture.html?${route}`,
    (timeout) => page.locator('#root > *').first().waitFor({ timeout }), { label: 'v2-business fixture' })
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

test('Sub2API subscriptions show independent quotas and never offer unsupported writes or tasks', async () => {
  const page = await fixture('page=account&sub2apiReliability=1&subscriptionExternal=1')
  try {
    assert.equal(await page.getByRole('tab', { name: '异步任务', exact: true }).count(), 0)
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    await page.locator('.xm-row-title').filter({ hasText: '周期订阅' }).waitFor()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const text = await panel.innerText()
    assert.match(text, /日额度：\s*已用 \$1\.00 · 限额 \$5\.00 · 剩余 \$4\.00/)
    assert.match(text, /周额度：\s*已用 \$4\.00 · 限额 \$20\.00 · 剩余 \$16\.00/)
    assert.match(text, /月额度：\s*已用 \$12\.00 · 限额暂未提供/)
    assert.equal(await panel.getByRole('combobox', { name: '扣费偏好' }).count(), 0)
    assert.equal(await panel.getByRole('button', { name: '购买', exact: true }).count(), 0)
    await panel.getByText('订阅仅供查看', { exact: true }).waitFor()
    assert.equal((await calls(page)).some((call) => /purchase-subscription|create-subscription-payment|updateAccountSubscriptionPreference/.test(call.name)), false)
    await fs.mkdir(path.resolve('artifacts/sub2api-reliability'), { recursive: true })
    await page.screenshot({ path: path.resolve('artifacts/sub2api-reliability/subscriptions.png') })
  } finally { await page.close() }
})

test('Sub2API usage submits calendar dates, IDs and timezone with unsupported filters absent', async () => {
  const page = await fixture('page=account&sub2apiReliability=1')
  try {
    await page.getByRole('tab', { name: '调用明细', exact: true }).click()
    for (const label of ['开始时间', '结束时间', '令牌名称', '分组', '请求 ID', '上游请求 ID', '日志类型']) {
      assert.equal(await page.getByLabel(label, { exact: true }).count(), 0)
    }
    assert.equal(await page.getByLabel('Key ID', { exact: true }).count(), 0)
    const toggle = page.getByTestId('account-filters-toggle')
    assert.equal(await toggle.innerText(), '展开筛选')
    await page.getByLabel('开始日期', { exact: true }).fill('2026-09-08')
    await page.getByLabel('结束日期', { exact: true }).fill('2026-09-08')
    await toggle.click()
    assert.equal(await toggle.innerText(), '收起筛选')
    await page.getByLabel('Key ID', { exact: true }).fill('4')
    await page.getByLabel('分组 ID', { exact: true }).fill('5')
    await page.getByLabel('计费来源', { exact: true }).selectOption('0')
    await page.getByRole('button', { name: '查询', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage' && call.args.apiKeyId === 4))
    const last = (await calls(page)).filter((call) => call.name === 'query-usage').at(-1).args
    assert.equal(last.startDate, '2026-09-08')
    assert.equal(last.endDate, '2026-09-08')
    assert.equal(last.timezone, await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone))
    assert.equal(last.billingType, 0)
    assert.equal(last.groupId, 5)
    assert.equal('startTimestamp' in last, false)
    await page.getByText(/包含结束日期全天/).waitFor()
    await page.getByText('暂无调用明细', { exact: true }).waitFor()
    // 收起来以后，收着的框里生效的条件数挂在按钮上；日期在第一行看得见，不算。
    await toggle.click()
    assert.equal(await toggle.innerText(), '展开筛选 · 3')
    assert.equal(await page.getByLabel('Key ID', { exact: true }).count(), 0)
  } finally { await page.close() }
})

test('the usage dashboard splits spending across the tools that have a managed key', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    await page.getByRole('tab', { name: '用量看板', exact: true }).click()
    const card = page.getByTestId('tool-usage')
    await card.waitFor()
    await card.getByText('当前账号累计已用 $8.00，其中 Claude Code 最多（75%）。', { exact: true }).waitFor()
    const rows = card.locator('tbody tr')
    assert.equal(await rows.count(), 4)
    assert.match(await rows.nth(0).innerText(), /Claude Code\t?\s*\$6\.00\s*75%\s*\$18\.00\s*\$12\.00/)
    assert.match(await rows.nth(1).innerText(), /Codex CLI\s*\$2\.00\s*25%\s*不限额\s*不限额/)
    for (const index of [2, 3]) {
      assert.match(await rows.nth(index).innerText(), /未启用/)
      assert.equal(/\$/.test(await rows.nth(index).innerText()), false)
    }
    assert.equal(await card.getByText(/solov|new-api|sub2api/i).count(), 0)
  } finally { await page.close() }
})

test('account views distinguish summary-only, failed reads and valid empty results', async () => {
  for (const [query, tab, expected, absent] of [
    ['sub2apiReliability=1', '用量看板', '仅提供累计汇总', '这个时间段还没有用量'],
    ['fail=dashboard', '用量看板', '用量趋势暂时没有读到', '这个时间段还没有用量'],
    ['fail=usage', '调用明细', '调用明细暂时没有读到', '暂无调用明细'],
    ['sub2apiReliability=1&fail=subscriptions', '充值与订阅', '订阅信息暂时没有读到', '还没有订阅'],
  ]) {
    const page = await fixture(`page=account&${query}`)
    try {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      await page.getByText(expected, { exact: true }).waitFor()
      assert.equal(await page.getByText(absent, { exact: true }).count(), 0)
      if (query === 'sub2apiReliability=1') assert.equal(await page.getByLabel('统计时间', { exact: true }).count(), 0)
    } finally { await page.close() }
  }
})

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
      '充值与订阅',
      '我的订单',
      '邀请返利',
      '用量看板',
      '调用明细',
      '异步任务',
      '密钥',
      '登录设备',
    ])
    assert.deepEqual(await page.getByRole('tablist').evaluateAll((lists) => lists.map((list) => list.getAttribute('aria-labelledby') && document.getElementById(list.getAttribute('aria-labelledby'))?.textContent)), [
      '账号与充值',
      '用量',
      '密钥与设备',
    ])
    await page.getByRole('tab', { name: '我的订单', exact: true }).click()
    await page.getByText('TEST-ORDER').waitFor()
    await page.getByText('已到账', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByText('Test key').waitFor()
    await page.getByRole('button', { name: '复制', exact: true }).click()
    await page.getByText('密钥已复制。为了安全，1 分钟后会从剪贴板里清掉', { exact: true }).waitFor()
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'copy-key').args,
      1,
    )
  } finally {
    await page.close()
  }
})

test('the account pages move with the arrow keys across their three groups and open on Enter', async () => {
  const page = await fixture('page=account')
  try {
    const first = page.getByRole('tab', { name: '我的账号', exact: true })
    const recharge = page.getByRole('tab', { name: '充值与订阅', exact: true })
    const devices = page.getByRole('tab', { name: '登录设备', exact: true })
    const focused = (tab) => tab.evaluate((element) => element === document.activeElement)
    await first.waitFor()
    await first.focus()
    // 手动激活：方向键只挪焦点，回车才打开，挪过的分页不会被读一遍。
    await page.keyboard.press('ArrowDown')
    assert.equal(await focused(recharge), true)
    assert.equal(await recharge.getAttribute('aria-selected'), 'false')
    await page.keyboard.press('End')
    assert.equal(await focused(devices), true)
    await page.keyboard.press('ArrowDown')
    assert.equal(await focused(first), true)
    await page.keyboard.press('ArrowUp')
    assert.equal(await focused(devices), true)
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    assert.equal(await recharge.getAttribute('aria-selected'), 'true')
    assert.equal(await first.getAttribute('aria-selected'), 'false')
    // 只有选中的那一格进得了 Tab 键顺序。
    assert.equal(await page.getByRole('tab').evaluateAll((tabs) => tabs.filter((tab) => tab.tabIndex === 0).length), 1)
    assert.equal(await recharge.getAttribute('tabindex'), '0')
  } finally {
    await page.close()
  }
})

test('one refresh in the page head rereads the account and the page in view', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '我的订单', exact: true }).click()
    await page.getByText('TEST-ORDER').waitFor()
    assert.equal(await page.getByRole('button', { name: '查询订单', exact: true }).count(), 0)
    const before = await calls(page)
    const count = (entries, name) => entries.filter((call) => call.name === name).length
    await page.getByTestId('account-refresh').click()
    await page.waitForFunction(
      ([orders, profiles]) => {
        const entries = JSON.parse(document.documentElement.dataset.calls || '[]')
        return entries.filter((call) => call.name === 'query-orders').length > orders
          && entries.filter((call) => call.name === 'get-profile').length > profiles
      },
      [count(before, 'query-orders'), count(before, 'get-profile')],
    )
    await page.getByRole('tab', { name: '用量看板', exact: true }).click()
    await page.getByTestId('tool-usage').waitFor()
    // 用量看板和「各工具累计用量」都不再自带「刷新」。
    assert.equal(await page.getByRole('button', { name: '刷新', exact: true }).count(), 1)
  } finally {
    await page.close()
  }
})

test('an unread profile keeps the account pages and only blocks the ones that need it', async () => {
  const page = await fixture('page=account&fail=profile&help=1')
  try {
    const failure = page.getByTestId('account-read-error')
    await failure.waitFor()
    assert.match(await failure.innerText(), /当前账号的资料暂时没有读到[\s\S]*账号资料服务暂时不可用/)
    await failure.getByRole('button', { name: '联系客服', exact: true }).click()
    assert.equal((await calls(page)).some((call) => call.name === 'open-help'), true)
    await page.getByText('当前账号的资料暂时没有读到', { exact: true }).first().waitFor()
    // 页头那句也直说没读到，不拿站点名或别的话顶上。
    assert.equal(await page.locator('.xm-page-head p').innerText(), '当前账号的资料暂时没有读到')
    assert.equal(await page.getByRole('tab').count(), 9)
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    await page.getByRole('button', { name: '到账 $10，实付 10.00', exact: true }).waitFor()
    await page.getByRole('tab', { name: '我的订单', exact: true }).click()
    await page.getByText('TEST-ORDER').waitFor()
    await page.getByRole('tab', { name: '我的账号', exact: true }).click()
    const reads = (await calls(page)).filter((call) => call.name === 'get-profile').length
    await failure.getByTestId('account-read-retry').click()
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-profile').length > count, reads)
  } finally {
    await page.close()
  }
})

test('account lists that could not be read say so with the reason and read again on request', async () => {
  for (const [query, tab, title, reason, absent] of [
    ['fail=orders', '我的订单', '订单暂时没有读到', '订单服务暂时不可用', '还没有订单'],
    ['fail=tasks', '异步任务', '异步任务暂时没有读到', '任务服务暂时不可用', '暂无异步任务'],
    ['fail=usage', '调用明细', '调用明细暂时没有读到', '调用记录服务暂时不可用', '暂无调用明细'],
    ['fail=devices', '登录设备', '登录设备暂时没有读到', '设备服务暂时不可用', '正在读取登录设备…'],
  ]) {
    const page = await fixture(`page=account&${query}`)
    try {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      const panel = page.getByRole('tabpanel').filter({ visible: true })
      await panel.getByText(title, { exact: true }).waitFor()
      await panel.getByText(reason, { exact: false }).waitFor()
      await panel.getByRole('button', { name: '重新加载', exact: true }).first().waitFor()
      assert.equal(await panel.getByText(absent, { exact: true }).count(), 0, `${tab} 不该写「${absent}」`)
      // 读数据出错不再挂顶上那条通用红框。
      assert.equal(await panel.getByText('未完成', { exact: true }).count(), 0, `${tab} 不该出通用红框`)
    } finally {
      await page.close()
    }
  }
})

test('the usage and task filters keep three boxes in the first row and fold the rest away', async () => {
  const page = await fixture('page=account&system=1&taskTransition=1')
  try {
    await page.getByRole('tab', { name: '调用明细', exact: true }).click()
    for (const label of ['开始时间', '结束时间', '模型名称']) await page.getByLabel(label, { exact: true }).waitFor()
    for (const label of ['分组', '日志类型', '令牌名称', '请求 ID', '上游请求 ID']) {
      assert.equal(await page.getByLabel(label, { exact: true }).count(), 0, `${label} 先收着`)
    }
    assert.equal(await page.getByRole('button', { name: '重置筛选', exact: true }).count(), 0)
    // 一共不到 10 条：「每页多少条」不出。
    assert.equal(await page.getByLabel('每页日志数量', { exact: true }).count(), 0)
    const toggle = page.getByTestId('account-filters-toggle')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    await page.getByLabel('上游请求 ID', { exact: true }).fill('up-1')
    await page.getByRole('button', { name: '查询', exact: true }).click()
    await page.getByRole('button', { name: '重置筛选', exact: true }).waitFor()
    await toggle.click()
    assert.equal(await toggle.innerText(), '展开筛选 · 1')
    await page.getByTestId('usage-stats').waitFor()
    assert.equal(await page.getByTestId('usage-stats').innerText(), '消耗 $0.00 · RPM 0 · TPM 0')
    await page.getByRole('tab', { name: '异步任务', exact: true }).click()
    const tasks = page.getByRole('tabpanel').filter({ visible: true })
    for (const label of ['开始时间', '结束时间', '状态']) await tasks.getByLabel(label, { exact: true }).waitFor()
    for (const label of ['平台', '任务 ID', '动作']) {
      assert.equal(await tasks.getByLabel(label, { exact: true }).count(), 0, `${label} 先收着`)
    }
  } finally {
    await page.close()
  }
})

test('recharge stays open when subscriptions fail and says when the top-up details could not be read', async () => {
  const page = await fixture('page=account&fail=subscriptions')
  try {
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    await panel.getByRole('button', { name: '到账 $10，实付 10.00', exact: true }).waitFor()
    assert.equal(await panel.getByTestId('account-recharge-submit').isDisabled(), false)
    await panel.getByText('订阅信息暂时没有读到', { exact: true }).waitFor()
    await panel.getByTestId('account-subscriptions-retry').waitFor()
    assert.equal(await panel.getByText('选择订阅', { exact: true }).count(), 0)
    assert.equal(await panel.getByRole('combobox', { name: '扣费偏好' }).count(), 0)
    assert.equal(await panel.getByText('未完成', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
  const failed = await fixture('page=account&fail=topup&help=1')
  try {
    await failed.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    const card = failed.getByTestId('account-recharge-error')
    await card.waitFor()
    assert.match(await card.innerText(), /充值信息暂时没有读到[\s\S]*充值服务暂时不可用/)
    await card.getByRole('button', { name: '联系客服', exact: true }).waitFor()
    assert.equal(await failed.getByRole('button', { name: /^到账/ }).count(), 0)
    // 订阅那边读得到，照样摆着。
    await failed.getByText('还没有订阅', { exact: true }).waitFor()
    const reads = (await calls(failed)).filter((call) => call.name === 'get-topup-info').length
    await card.getByTestId('account-recharge-retry').click()
    await failed.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-topup-info').length > count, reads)
  } finally {
    await failed.close()
  }
})

test('without a payment channel the recharge card says so first, greys the form and still redeems codes', async () => {
  const page = await fixture('page=account&noPayment=1&help=1')
  try {
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    const notice = page.getByTestId('account-recharge-no-methods')
    await notice.waitFor()
    assert.match(await notice.innerText(), /暂时没有可用的支付渠道[\s\S]*请稍后重试或联系客服。有充值码的话，可以在右边兑换。/)
    await notice.getByRole('button', { name: '联系客服', exact: true }).waitFor()
    // 提示在卡片最上面，档位在它下面。
    const noticeBox = await notice.boundingBox()
    const tier = page.getByRole('button', { name: '到账 $10', exact: true })
    const tierBox = await tier.boundingBox()
    assert.ok(noticeBox && tierBox && noticeBox.y + noticeBox.height <= tierBox.y)
    assert.equal(await tier.isDisabled(), true)
    assert.equal(await page.getByLabel('自定义金额').isDisabled(), true)
    assert.equal(await page.getByTestId('account-recharge-submit').isDisabled(), true)
    assert.equal(await page.getByText(/^实付/).count(), 0)
    await page.getByLabel('充值码').fill('CODE-1')
    const redeem = page.getByTestId('account-redeem')
    assert.equal(await redeem.isDisabled(), false)
    const input = await page.getByLabel('充值码').boundingBox()
    const button = await redeem.boundingBox()
    // 「兑换」在输入框右边同一行。
    assert.ok(input && button && button.x > input.x + input.width - 1 && Math.abs(button.y + button.height - (input.y + input.height)) <= 2)
  } finally {
    await page.close()
  }
})

test('login devices say which device each button signs out', async () => {
  const page = await fixture('page=account&otherDevice=1')
  try {
    await page.getByRole('tab', { name: '登录设备', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    await panel.getByRole('button', { name: '下线其他设备', exact: true }).waitFor()
    assert.equal(await panel.getByRole('button', { name: '退出其他设备', exact: true }).count(), 0)
    await panel.getByRole('button', { name: '让它下线', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '让这台设备下线？', exact: true })
    await dialog.getByRole('button', { name: '确认下线', exact: true }).waitFor()
    await dialog.getByText('该设备需要重新登录才能查看账户信息。', { exact: false }).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await panel.getByRole('button', { name: '退出登录', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '退出登录？', exact: true })
    await dialog.getByRole('button', { name: '退出登录', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '确认下线', exact: true }).count(), 0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await panel.getByRole('button', { name: '下线其他设备', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '下线其他设备？', exact: true })
    await dialog.getByRole('button', { name: '确认下线', exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('my account keeps the saved-accounts card down to two sentences and one button when there is no other account', async () => {
  const page = await fixture('page=account')
  try {
    const alone = page.getByTestId('saved-accounts-alone')
    await alone.waitFor()
    assert.equal(
      (await alone.innerText()).replace(/\s+/g, ''),
      '还没有保存别的账号。点下面的「添加另一个账号」，以后在这里一键切换。添加另一个账号',
    )
    assert.equal(await page.getByText('同步到工具', { exact: true }).count(), 0)
    // 显示名称没改过，「保存」点不了；改了才亮。
    const save = page.getByTestId('account-display-save')
    assert.equal(await save.isDisabled(), true)
    await page.getByTestId('account-display').fill('新的名字')
    assert.equal(await save.isDisabled(), false)
    await page.getByRole('button', { name: '修改密码', exact: true }).waitFor()
    assert.equal(await page.getByText('你的账户资料与余额', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('the invite page leads with the link and puts the transfer in the transferable cell', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '邀请返利', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const titles = await panel.locator('.xm-card-head h2').allTextContents()
    assert.equal(titles[0], '邀请链接')
    assert.equal(titles.at(-1), '已邀请用户')
    const link = await panel.getByTestId('account-invite-link').boundingBox()
    const copy = await panel.getByRole('button', { name: '复制链接', exact: true }).boundingBox()
    assert.ok(link && copy && copy.x > link.x + link.width - 1)
    const cells = panel.locator('.v2-business-stat-grid.is-four > .xm-card')
    assert.equal(await cells.count(), 4)
    const tops = await cells.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)))
    assert.equal(new Set(tops).size, 1)
    const transferable = cells.filter({ hasText: '可转余额' })
    await transferable.getByRole('button', { name: '转入余额', exact: true }).click()
    await page.getByRole('dialog', { name: '转入账户余额', exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('tool key limits list only the tools that have a key and name the ones still missing', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    const card = page.getByTestId('tool-key-limits')
    await card.getByTestId('tool-key-limit-claude').waitFor()
    assert.deepEqual(
      await card.locator('[data-testid^="tool-key-limit-"]:not([data-testid*="-input-"]):not([data-testid*="-save-"])').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid'))),
      ['tool-key-limit-claude', 'tool-key-limit-codex'],
    )
    assert.equal(await page.getByTestId('tool-key-limits-missing').innerText(), 'Gemini CLI、Grok CLI 还没配，配好后会出现在这里。')
  } finally {
    await page.close()
  }
  const none = await fixture('page=account')
  try {
    await none.getByRole('tab', { name: '密钥', exact: true }).click()
    const line = none.getByTestId('tool-key-limits')
    await line.waitFor()
    assert.equal(await line.innerText(), '工具配好后，可以在这里给每个工具设额度上限。')
  } finally {
    await none.close()
  }
})

test('a profile read once stays on screen with an unsaved name when a later refresh cannot read it', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByTestId('account-display').fill('改到一半的名字')
    await page.evaluate(() => window.failNextRead('profile'))
    await page.getByTestId('account-refresh').click()
    const alert = page.getByRole('tabpanel').filter({ visible: true }).getByRole('alert')
    await alert.getByText('账号资料服务暂时不可用').waitFor()
    // 手上那份资料留着：不整页换成「暂时没有读到」，没保存的名字也还在。
    assert.equal(await page.getByTestId('account-read-error').count(), 0)
    assert.equal(await page.getByTestId('account-display').inputValue(), '改到一半的名字')
    assert.equal(await page.getByText('当前账号：本地测试（test@example.invalid）', { exact: true }).count(), 1)
    await alert.getByRole('button', { name: '重新加载', exact: true }).click()
    await alert.waitFor({ state: 'detached' })
    assert.equal(await page.getByTestId('account-display').inputValue(), '改到一半的名字')
  } finally {
    await page.close()
  }
})

test('a slow profile read that lands after a newer one is not what a later failed refresh falls back to', async () => {
  const page = await fixture('page=account')
  try {
    const name = page.locator('.v2-business-profile-avatar strong')
    await name.filter({ hasText: /^本地测试$/ }).waitFor()
    // 先点「刷新」，这次读得慢；还没回来就把显示名称改了存上，存完那次读得快。
    await page.evaluate(() => window.profileReadHarness.deferNext())
    await page.getByTestId('account-refresh').click()
    await page.getByTestId('account-display').fill('新名字')
    await page.getByTestId('account-display-save').click()
    await name.filter({ hasText: /^新名字$/ }).waitFor()
    // 慢的那次这时才回来，带的还是改名前的资料。
    await page.evaluate(() => window.profileReadHarness.release())
    await page.waitForTimeout(100)
    await page.evaluate(() => window.failNextRead('profile'))
    await page.getByTestId('account-refresh').click()
    const alert = page.getByRole('tabpanel').filter({ visible: true }).getByRole('alert')
    await alert.getByText('账号资料服务暂时不可用').waitFor()
    assert.equal(await name.innerText(), '新名字')
    assert.equal(await page.getByTestId('account-display').inputValue(), '新名字')
  } finally {
    await page.close()
  }
})

test('a subscription re-read that fails says so instead of still showing no subscriptions', async () => {
  const page = await fixture('page=account&accountTab=recharge')
  try {
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const choose = panel.locator('.xm-card-head h2', { hasText: '选择订阅' })
    await panel.getByText('还没有订阅', { exact: true }).waitFor()
    assert.equal(await choose.count(), 1)
    await page.evaluate(() => window.failNextRead('subscriptions'))
    await page.getByTestId('account-refresh').click()
    await panel.getByTestId('account-subscriptions-error').getByText('订阅信息暂时没有读到').waitFor()
    assert.equal(await panel.getByText('还没有订阅', { exact: true }).count(), 0)
    assert.equal(await choose.count(), 0)
    // 充值那张卡不受影响。
    assert.equal(await panel.getByTestId('account-recharge-submit').count(), 1)
    await panel.getByTestId('account-subscriptions-retry').click()
    await panel.getByText('还没有订阅', { exact: true }).waitFor()
    assert.equal(await choose.count(), 1)
  } finally {
    await page.close()
  }
})

test('the header refresh reads the usage dashboard up to now, not up to when it was first opened', async () => {
  const page = await fixture('page=account&accountTab=dashboard')
  try {
    const ends = async () => (await calls(page)).filter((call) => call.name === 'get-dashboard').map((call) => call.args.endTimestamp)
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'get-dashboard'))
    const reads = (await ends()).length
    const first = (await ends()).at(-1)
    await page.waitForTimeout(1100)
    await page.getByTestId('account-refresh').click()
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-dashboard').length > count, reads)
    const last = (await ends()).at(-1)
    assert.ok(last > first, `the refreshed range ends at ${last}, after ${first}`)
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

async function revokeTestKey(page) {
  await page.getByRole('tab', { name: '密钥', exact: true }).click()
  await page.getByText('Test key').waitFor()
  await page.locator('.xm-list-row').filter({ has: page.getByText('Test key') }).locator('button[aria-haspopup="menu"]').click()
  await page.getByRole('menuitem', { name: '撤销密钥', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '撤销这把密钥？', exact: true })
  await dialog.waitFor()
  return dialog
}

test('revoking a key a tool is using warns first and puts a fresh key back without asking again', async () => {
  const page = await fixture('page=account&keyInUse=1')
  try {
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByTestId('account-key-in-use-1').getByText('Claude Code 在用').waitFor()
    const dialog = await revokeTestKey(page)
    assert.match(await dialog.innerText(), /Claude Code 正在用这把密钥。撤销后会马上自动换一把新的写进 Claude Code/)
    await dialog.getByRole('button', { name: '确认撤销', exact: true }).click()
    await page.getByText('密钥已撤销，Claude Code 已自动换上新密钥', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('account-key-replace-failed').count(), 0)
    const names = (await calls(page)).map((call) => [call.name, call.args])
    assert.deepEqual(names.filter(([name]) => name === 'revokeAccountKey' || name === 'rewriteKey'),
      [['revokeAccountKey', 1], ['rewriteKey', 'claude']])
  } finally { await page.close() }
})

test('a failed key replacement after revoking says what to press and retries on that button', async () => {
  const page = await fixture('page=account&keyInUse=1&replaceFails=2')
  try {
    const dialog = await revokeTestKey(page)
    await dialog.getByRole('button', { name: '确认撤销', exact: true }).click()
    const notice = page.getByTestId('account-key-replace-failed')
    await notice.getByText('Claude Code 暂时用不了', { exact: true }).waitFor()
    await page.getByTestId('account-key-replace-retry').click()
    await page.getByText('Claude Code 还是没换上新密钥，请检查网络后再点一次。', { exact: true }).waitFor()
    await page.getByTestId('account-key-replace-retry').click()
    await page.getByText('Claude Code 已换上新密钥', { exact: true }).waitFor()
    assert.equal(await notice.count(), 0)
    assert.equal((await calls(page)).filter((call) => call.name === 'rewriteKey').length, 3)
  } finally { await page.close() }
})

test('revoking a key a hand-configured tool is using never claims a fresh key and points at its settings', async () => {
  const page = await fixture('page=account&keyInUse=1&replaceSkipped=1')
  try {
    const dialog = await revokeTestKey(page)
    await dialog.getByRole('button', { name: '确认撤销', exact: true }).click()
    const notice = page.getByTestId('account-key-replace-skipped')
    await notice.getByText('Claude Code 还在用刚撤销的密钥', { exact: true }).waitFor()
    await page.getByText('密钥已撤销', { exact: true }).waitFor()
    assert.equal(await page.getByText(/已自动换上新密钥/).count(), 0)
    assert.equal(await page.getByTestId('account-key-replace-retry').count(), 0)
    await page.getByTestId('account-key-replace-configure').click()
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'openConfig').map((call) => call.args), ['claude'])
    // 只是打开了设置窗口，用户可能取消或保存失败：警告不能跟着消失（#546）。
    assert.equal(await notice.count(), 1)
    // 别的工具存好了也不算。
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-tool-config-confirmed', { detail: 'gemini' })))
    assert.equal(await notice.count(), 1)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-tool-config-confirmed', { detail: 'claude' })))
    await notice.waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('revoking the only key on the last page steps back to a real page instead of showing 2 / 1', async () => {
  const page = await fixture('page=account&keyCount=21')
  try {
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByRole('button', { name: '密钥 paged-key-1 的更多操作', exact: true }).waitFor()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.getByRole('button', { name: '密钥 paged-key-21 的更多操作', exact: true }).waitFor()
    await page.getByText('2 / 2', { exact: true }).waitFor()
    await page.getByRole('button', { name: '密钥 paged-key-21 的更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '撤销密钥', exact: true }).click()
    await page.getByRole('dialog', { name: '撤销这把密钥？', exact: true }).getByRole('button', { name: '确认撤销', exact: true }).click()
    await page.getByRole('button', { name: '密钥 paged-key-1 的更多操作', exact: true }).waitFor()
    assert.equal(await page.getByText('2 / 1', { exact: true }).count(), 0)
    // 只剩一页，分页条整个不摆。
    await page.locator('.v2-business-pagination').waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('key search finds a key that lives on a later page and starts from the first page of matches', async () => {
  const page = await fixture('page=account&keyCount=45')
  try {
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByRole('button', { name: '密钥 paged-key-1 的更多操作', exact: true }).waitFor()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.getByText('2 / 3', { exact: true }).waitFor()
    await page.getByTestId('keys-search').fill('paged-key-43')
    await page.getByRole('button', { name: '密钥 paged-key-43 的更多操作', exact: true }).waitFor()
    // 搜到的只有一页，分页条不摆。
    await page.locator('.v2-business-pagination').waitFor({ state: 'detached' })
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'searchAccountKeys').map((call) => call.args), ['paged-key-43'])
    await page.getByTestId('keys-search').fill('')
    await page.getByText('共 45 条', { exact: true }).waitFor()
  } finally { await page.close() }
})

test('revoking a key no tool is using keeps the old confirmation and never rewrites a tool', async () => {
  const page = await fixture('page=account')
  try {
    const dialog = await revokeTestKey(page)
    assert.match(await dialog.innerText(), /使用这把密钥的工具会停止请求，需要重新配置有效密钥。/)
    await dialog.getByRole('button', { name: '确认撤销', exact: true }).click()
    await page.getByText('密钥已撤销', { exact: true }).waitFor()
    assert.equal((await calls(page)).some((call) => call.name === 'rewriteKey'), false)
  } finally { await page.close() }
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
    // Confirm the existing value: Escape can also dismiss the parent dialog on macOS.
    await group.selectOption('group-B')
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
    await dialog.getByText('分组读取暂时失败，请重试', { exact: true }).waitFor()
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

test('key group failures name the real cause instead of one generic refresh prompt', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥', exact: true }).click()
    await page.getByText('Test key').waitFor()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-A']))
    await page.getByTestId('account-key-add').click()
    const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true })
    const save = dialog.getByRole('button', { name: '保存密钥', exact: true })
    await page.waitForFunction(() => document.querySelector('[data-testid="account-key-group"]')?.value === 'group-A')

    // 会话过期：主进程抛的是中文原文，脱敏后原样上屏，用户知道该去重新登录
    await page.evaluate(() => window.keyGroupsHarness.failNext(
      "Error invoking remote method 'account:list-groups': Error: 登录状态已失效，请重新登录",
    ))
    await page.getByTestId('account-key-groups-refresh').click()
    await dialog.getByText('登录状态已失效，请重新登录', { exact: true }).waitFor()
    assert.equal(await save.isDisabled(), true)
    assert.equal(await dialog.getByText('分组读取失败，请刷新后重试。', { exact: true }).count(), 0)

    // 限流：服务端回英文原文，映射成「稍等几秒」，而不是让用户反复点刷新
    await page.evaluate(() => window.keyGroupsHarness.failNext('list groups failed: 429 Too Many Requests'))
    await page.getByTestId('account-key-groups-refresh').click()
    await dialog.getByText('请求太频繁，稍等几秒再试。', { exact: true }).waitFor()
    assert.equal(await save.isDisabled(), true)

    // 账号被封禁：走 account-errors 的既有匹配表，同样不该退化成刷新提示
    await page.evaluate(() => window.keyGroupsHarness.failNext('user has been banned'))
    await page.getByTestId('account-key-groups-refresh').click()
    await dialog.getByText('该账号已被封禁，请联系客服', { exact: true }).waitFor()

    // 认不出的原因仍然保留原来的兜底话术，并且恢复成功后错误消失、可以保存
    await page.evaluate(() => window.keyGroupsHarness.failNext('   '))
    await page.getByTestId('account-key-groups-refresh').click()
    await dialog.getByText('分组读取失败，请刷新后重试。', { exact: true }).waitFor()
    await page.getByTestId('account-key-groups-refresh').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="account-key-groups-refresh"]')?.disabled)
    assert.equal(await save.isDisabled(), false)
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
    await page.getByTestId('sessions-view-codex:session-1').click()
    const drawer = page.getByRole('dialog')
    await drawer.getByText('这是一条测试消息').waitFor()
    await drawer.getByRole('button', { name: '归档', exact: true }).click()
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

// 记录页的 lead 一直写着「继续之前的对话」,但页面只有导出和归档。这条钉住
// 兑现之后的行为:按钮把记录里的工作目录和固定的 resumeLast 一起交给主进程,
// 续接参数本身永远不从渲染层来。Codex 另带这条记录的 id,由主进程核对后按 id
// 接(它自己按目录找时还看连接名,切过账号就找不到)。
test('records page resumes the most recent conversation in the folder on the row', async () => {
  const page = await fixture('page=sessions')
  try {
    await page.getByTestId('sessions-resume-codex:session-1').click()
    await page.getByText('已打开Codex CLI，接着 C:/test-project 里最近的一条对话').waitFor()
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'launch-cli').args,
      { provider: 'codex', workspace: 'C:/test-project', mode: 'resumeLast', sessionId: 'codex:session-1' },
    )
  } finally {
    await page.close()
  }
})

// 续接参数是 CLI 自己按目录找最近一条,所以同一个工具、同一个目录只有最近的
// 那条能给按钮:否则用户点第三条、接上的却是第一条。
test('only the most recent record of a folder offers to resume it', async () => {
  const page = await fixture('page=sessions&sameFolder=1')
  try {
    await page.getByTestId('sessions-row-codex:session-0').waitFor()
    assert.equal(await page.getByTestId('sessions-resume-codex:session-1').count(), 1)
    assert.equal(await page.getByTestId('sessions-resume-codex:session-0').count(), 0)
  } finally {
    await page.close()
  }
})

// 目录被删掉或搬走之后,CLI 按目录找回对话这条路就断了。按钮不藏起来,
// 而是留在原位按不动,旁边说一句为什么——藏起来的话用户只会觉得
// 「昨天还有的按钮今天没了」。
test('a record whose folder is gone keeps the resume button in place but disabled', async () => {
  const page = await fixture('page=sessions&missingFolder=1')
  try {
    const resume = page.getByTestId('sessions-resume-codex:session-1')
    await resume.waitFor()
    assert.equal(await resume.isDisabled(), true)
    assert.equal(
      await resume.getAttribute('title'),
      '这条记录的文件夹已经不在了，接不上上次的对话',
    )
    await page.getByTestId('sessions-missing-codex:session-1').waitFor()
    assert.equal(
      await page.getByTestId('sessions-missing-codex:session-1').innerText(),
      '文件夹已不存在',
    )
    // 按不动就不该有任何一次启动请求发出去。
    await resume.click({ force: true }).catch(() => {})
    assert.equal((await calls(page)).some((call) => call.name === 'launch-cli'), false)
  } finally {
    await page.close()
  }
})

test('session detail exposes a retry action after a temporary read failure', async () => {
  const page = await fixture('page=sessions&detailFailure=1')
  try {
    await page.getByTestId('sessions-view-codex:session-1').click()
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
        // 列表给出的层要原样带回去，否则项目里的那份会被当成全局的去改（#488）。
        scope: 'user',
      },
    )
  } finally {
    await page.close()
  }
})

test('each MCP connection carries its own checked answer and the reason behind it', async () => {
  const page = await fixture('page=mcp')
  try {
    const pill = page.getByTestId('mcp-health-test-extension')
    await pill.getByText('连不上', { exact: true }).waitFor()
    // 「连不上」本身不够用，工具给出的那句原因必须一起上屏。
    await page.getByText('启动失败：找不到 uvx', { exact: true }).waitFor()
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'mcp-health').length,
      1,
    )
    // 不后台轮询：再有结果只能是用户自己点出来的。
    await page.getByTestId('mcp-health-recheck').click()
    await pill.getByText('连不上', { exact: true }).waitFor()
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'mcp-health').length,
      2,
    )
  } finally {
    await page.close()
  }
})

test('adding a uvx connection without Python says so first and still lets it through', async () => {
  const page = await fixture('page=mcp')
  try {
    await page.getByTestId('mcp-add').click()
    await page.getByRole('button', { name: '本地程序', exact: true }).click()
    await page.getByTestId('mcp-source').fill('uvx')
    const notice = page.getByTestId('mcp-runtime-notice')
    await notice.waitFor()
    await notice.getByText(/没有找到 uv/).waitFor()
    // 提示只是提示：它不该把「添加」按下去的路堵死。
    await notice.getByText(/仍然可以直接添加/).waitFor()
    await notice.getByTestId('mcp-install-python').click()
    await page.getByText('测试环境不装 Python').first().waitFor()
    // npx 型的命令不该被这条提示牵连。
    await page.getByTestId('mcp-source').fill('npx')
    await notice.waitFor({ state: 'detached' })
  } finally {
    await page.close()
  }
})

test('curated MCP install confirms the exact command before writing any configuration', async () => {
  const page = await fixture('page=mcp')
  try {
    const shelf = page.getByTestId('curated-shelf')
    await shelf.waitFor()
    await shelf.getByTestId('curated-install-browser').click()
    const confirm = page.getByTestId('curated-confirm')
    await confirm.waitFor()
    // 确认框必须原样给出将要执行的命令和那句免责说明，用户才知道自己在同意什么。
    await confirm.getByText('npx -y @playwright/mcp@0.0.82', { exact: true }).waitFor()
    await confirm.getByText(/第三方软件/).first().waitFor()
    assert.equal(
      (await calls(page)).some((call) => call.name === 'extension'),
      false,
    )
    await confirm.getByTestId('curated-confirm-submit').click()
    await confirm.getByText('扩展操作失败，已有配置保留').waitFor()
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'extension').args,
      {
        provider: 'claude',
        kind: 'mcp',
        action: 'install',
        id: 'browser',
        scope: 'user',
        mcp: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@playwright/mcp@0.0.82'],
          env: {},
        },
      },
    )
  } finally {
    await page.close()
  }
})

test('the curated plugin shelf shows both commands and installs through the existing plugin path', async () => {
  const page = await fixture('page=plugins')
  try {
    const shelf = page.getByTestId('curated-shelf')
    await shelf.waitFor()
    await shelf.getByTestId('curated-install-code-review').click()
    const confirm = page.getByTestId('curated-confirm')
    await confirm.waitFor()
    // 装插件要先保证官方市场在册，所以确认框里必须是两条命令，少列一条就是没说全。
    await confirm
      .getByText('claude plugin marketplace add anthropics/claude-plugins-official', { exact: true })
      .waitFor()
    await confirm
      .getByText('claude plugin install code-review@claude-plugins-official', { exact: true })
      .waitFor()
    // 官方市场装到的是它当下那一份，钉不住版本这件事要在点确认之前说出来。
    await confirm.getByText(/安装的是官方市场当前的版本/).waitFor()
    await confirm.getByText(/第三方软件/).first().waitFor()
    assert.equal(
      (await calls(page)).some((call) => call.name === 'extension'),
      false,
    )
    await confirm.getByTestId('curated-confirm-submit').click()
    await confirm.getByText('扩展操作失败，已有配置保留').waitFor()
    // 精选不另开通道：走的还是页面上「添加插件」那一条出口。
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'extension').args,
      {
        provider: 'claude',
        kind: 'plugin',
        action: 'install',
        source: 'code-review@claude-plugins-official',
      },
    )
  } finally {
    await page.close()
  }
})

test('the Codex plugin market downloads the official catalog by itself and lists what can be installed', async () => {
  const page = await fixture('page=plugins&codexCatalogOffline')
  try {
    await page.getByRole('button', { name: 'Codex CLI', exact: true }).click()
    await page.getByRole('tab', { name: '市场' }).click()
    // 第一次按国内常见的样子失败：说清楚原因，留一颗按钮让用户开加速后自己再点。
    await page.getByText(/插件目录要从国外的网站下载/).first().waitFor()
    const notice = page.getByTestId('plugins-official-marketplace')
    await notice.getByText('官方插件目录还没下载').waitFor()
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'ensure-marketplace').length,
      1,
    )
    await notice.getByTestId('plugins-official-marketplace-add').click()
    await notice.getByText('官方插件目录已就绪').waitFor()
    const row = page.getByTestId('plugins-row-game-studio@openai-api-curated')
    await row.getByText('Design and prototype browser games').waitFor()
    await row.getByTestId('plugins-install-game-studio@openai-api-curated').waitFor()
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'ensure-marketplace').map((call) => call.args),
      ['codex', 'codex'],
    )
  } finally {
    await page.close()
  }
})

test('a curated entry that needs a folder prefills the form instead of installing a broken connection', async () => {
  const page = await fixture('page=mcp')
  try {
    await page.getByTestId('curated-install-files').click()
    await page.getByTestId('curated-confirm-submit').click()
    const notice = page.getByTestId('curated-input-directory')
    await notice.waitFor()
    await notice.getByText(/点「选择文件夹」挑一个/).waitFor()
    await notice.getByTestId('curated-choose-directory').waitFor()
    assert.equal(
      (await calls(page)).some((call) => call.name === 'extension'),
      false,
    )
    // 占位符没换就提交要当场拦住，而不是写进一条起不来的连接。
    await page.getByTestId('mcp-form-submit').click()
    await page
      .getByText('{{directory}} 还没换成真实内容，请先填好再添加。')
      .first()
      .waitFor()
    assert.equal(
      (await calls(page)).some((call) => call.name === 'extension'),
      false,
    )
  } finally {
    await page.close()
  }
})

const callsNamed = async (page, name) =>
  (await calls(page)).filter((call) => call.name === name)

// 第五部分第 23、24 条：自己加的连接在上，「星芒精选」在下；一个词同时筛两边。
test('the MCP page lists its own connections above the curated shelf and one search narrows both', async () => {
  const page = await fixture('page=mcp')
  try {
    const list = page.getByTestId('mcp-list')
    await list.getByRole('heading', { name: '已添加', exact: true }).waitFor()
    await list.getByTestId('mcp-row-test-extension').waitFor()
    const shelf = page.getByTestId('curated-shelf')
    await shelf.getByText('我们挑过的，装之前会先给你看它要什么权限', { exact: true }).waitFor()
    const listBox = await list.boundingBox()
    const shelfBox = await shelf.boundingBox()
    assert.ok(listBox.y + listBox.height <= shelfBox.y, '自己的列表排在「星芒精选」上面')
    // 精选每一行只留「安装」：要不要联网放在点「安装」后的确认框里说。
    assert.equal(await shelf.getByText(/联网/).count(), 0)
    const search = page.getByTestId('mcp-search')
    await search.fill('GitHub')
    await shelf.getByTestId('curated-install-github').waitFor()
    await shelf.getByTestId('curated-install-browser').waitFor({ state: 'detached' })
    // 精选一条都不匹配就整张收起；搜不到的那句在「已添加」这张卡里。
    await search.fill('no-such-connection-8472')
    await shelf.waitFor({ state: 'detached' })
    await list.getByTestId('mcp-filter-empty').getByText('没有找到「no-such-connection-8472」', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('an empty MCP list says how to add one and 看看精选 lands on the first install', async () => {
  const page = await fixture('page=mcp&empty')
  try {
    const empty = page.getByTestId('mcp-empty')
    await empty.getByText('还没有添加连接', { exact: true }).waitFor()
    await empty.getByText('装下面「星芒精选」里的，或点右上角「添加连接」接你自己的。', { exact: true }).waitFor()
    await empty.getByRole('button', { name: '添加连接', exact: true }).waitFor()
    await empty.getByTestId('mcp-see-curated').click()
    await page.waitForFunction(() => document.activeElement?.dataset.testid?.startsWith('curated-install-'))
  } finally {
    await page.close()
  }
})

// 第五部分第 25、28 条：没检测成就别写「上次检测」；「重新检测」先重读列表再检测。
test('an MCP check that did not finish says so, and 重新检测 reads the list again before checking', async () => {
  const page = await fixture('page=mcp&mcpHealthFail')
  try {
    await page.getByTestId('mcp-health-failed').getByText('这次没检测成', { exact: true }).waitFor()
    assert.equal(await page.getByText(/上次检测/).count(), 0)
    const reads = (await callsNamed(page, 'list-extensions')).length
    await page.getByTestId('mcp-health-recheck').click()
    await page.getByText(/^上次检测 /).waitFor()
    assert.equal(await page.getByTestId('mcp-health-failed').count(), 0)
    const names = (await calls(page)).map((call) => call.name)
    assert.equal(names.filter((name) => name === 'list-extensions').length, reads + 1)
    assert.ok(names.lastIndexOf('list-extensions') < names.lastIndexOf('mcp-health'), '先重读列表，再检测连接')
  } finally {
    await page.close()
  }
})

// 第五部分第 26 条：弹框标题带上工具名，选项上面有小标题。
test('the add dialogs name the tool they add to and label their choices', async () => {
  const mcp = await fixture('page=mcp')
  try {
    await mcp.getByTestId('mcp-add').first().click()
    const dialog = mcp.getByRole('dialog', { name: '给 Claude Code 添加连接', exact: true })
    await dialog.waitFor()
    await dialog.getByText('连接方式', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '网络服务', exact: true }).waitFor()
    await dialog.getByRole('combobox', { name: '装到哪里', exact: true }).waitFor()
  } finally {
    await mcp.close()
  }
  const plugins = await fixture('page=plugins')
  try {
    await plugins.getByTestId('plugins-add').first().click()
    await plugins.getByRole('dialog', { name: '给 Claude Code 添加插件', exact: true }).waitFor()
  } finally {
    await plugins.close()
  }
  const skills = await fixture('page=skills')
  try {
    await skills.getByRole('button', { name: 'Codex CLI', exact: true }).click()
    await skills.getByTestId('skills-add').first().click()
    await skills.getByRole('dialog', { name: '给 Codex CLI 导入技能', exact: true }).waitFor()
  } finally {
    await skills.close()
  }
})

// 第五部分第 27、28 条：不能在这里导入的工具，说清楚怎么放，空着时给「重新加载」。
test('a tool whose skills cannot be imported here says how to place them and offers a reload', async () => {
  const page = await fixture('page=skills&empty')
  try {
    const note = page.getByTestId('skills-import-unsupported')
    await note.getByText('Claude Code 的技能不能在这里导入，要按它自己的方式放好；Codex CLI、Gemini CLI 可以在这里导入。', { exact: true }).waitFor()
    const add = page.getByTestId('skills-add')
    assert.equal(await add.count(), 1, '空状态里不再放那颗灰的「导入技能」')
    assert.equal(await add.isDisabled(), true)
    assert.equal(await add.getAttribute('title'), 'Claude Code 不支持在这里导入')
    const empty = page.getByTestId('skills-empty')
    await empty.getByText('按 Claude Code 自己的方式放好技能，回来点「重新加载」就能看到。', { exact: true }).waitFor()
    let reads = (await callsNamed(page, 'list-extensions')).length
    await empty.getByTestId('skills-empty-reload').click()
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls).filter((call) => call.name === 'list-extensions').length > count, reads)
    await note.getByRole('button', { name: '看怎么放', exact: true }).click()
    assert.deepEqual((await callsNamed(page, 'navigate')).at(-1).args, ['tutorial', 'skills#Claude Code、Grok CLI 没有导入按钮？'])
    // 选 Grok CLI 时句首换成它。
    await page.getByRole('button', { name: 'Grok CLI', exact: true }).click()
    await note.getByText(/^Grok CLI 的技能不能在这里导入/).waitFor()
    // 能导入的工具：没有那一行，空着时叫人点「导入技能」；工具条上的「重新加载」照样重读。
    await page.getByRole('button', { name: 'Codex CLI', exact: true }).click()
    await note.waitFor({ state: 'detached' })
    await empty.getByText('点「导入技能」，选一个技能文件夹。', { exact: true }).waitFor()
    await empty.getByTestId('skills-add').waitFor()
    reads = (await callsNamed(page, 'list-extensions')).length
    await page.getByTestId('skills-reload').click()
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls).filter((call) => call.name === 'list-extensions').length > count, reads)
  } finally {
    await page.close()
  }
})

// 第五部分第 29、31 条：「已安装」先放装了的，再放精选；有新版本的行上直接给「更新」。
test('installed plugins come before the curated shelf and an update sits on the row', async () => {
  const page = await fixture('page=plugins')
  try {
    const list = page.getByTestId('plugins-list')
    const row = list.getByTestId('plugins-row-test-extension')
    await row.waitFor()
    assert.equal(await list.locator('.xm-card-head').count(), 0, '列表卡不加标题')
    const shelf = page.getByTestId('curated-shelf')
    await shelf.waitFor()
    const listBox = await list.boundingBox()
    const shelfBox = await shelf.boundingBox()
    assert.ok(listBox.y + listBox.height <= shelfBox.y, '装了的排在「星芒精选」上面')
    const update = row.getByTestId('plugins-update-test-extension')
    await update.waitFor()
    const updateBox = await update.boundingBox()
    const switchBox = await row.getByRole('switch').boundingBox()
    assert.ok(updateBox.x + updateBox.width <= switchBox.x, '「更新」在开关左边')
    await update.click()
    await page.getByText('扩展操作失败，已有配置保留').first().waitFor()
    assert.equal((await callsNamed(page, 'extension')).at(-1).args.action, 'update')
    // 「…」菜单里那一项照留。
    await row.getByRole('button', { name: /更多操作/ }).click()
    await page.getByRole('menuitem', { name: '更新', exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('an empty installed list points at the curated shelf and the market tab', async () => {
  const page = await fixture('page=plugins&empty')
  try {
    const empty = page.getByTestId('plugins-empty')
    await empty.getByText('还没有插件', { exact: true }).waitFor()
    await empty.getByText('装下面「星芒精选」里的，或到「市场」页签挑。', { exact: true }).waitFor()
    // 在「市场」页签点「看看精选」：切回「已安装」，落到精选的第一颗「安装」。
    await page.getByRole('tab', { name: '市场', exact: true }).click()
    await page.getByTestId('plugins-empty').getByTestId('plugins-see-curated').click()
    await page.getByRole('tab', { name: '已安装', exact: true, selected: true }).waitFor()
    await page.waitForFunction(() => document.activeElement?.dataset.testid?.startsWith('curated-install-'))
  } finally {
    await page.close()
  }
})

// 第五部分第 30 条：没有插件市场的工具，「市场」页签直说，只留选工具。
test('a tool without a plugin market says so on the market tab and goes back to installed', async () => {
  const page = await fixture('page=plugins')
  try {
    await page.getByRole('button', { name: 'Gemini CLI', exact: true }).click()
    await page.getByRole('tab', { name: '市场', exact: true }).click()
    const notice = page.getByTestId('plugins-market-unavailable')
    await notice.getByText('Gemini CLI 没有插件市场', { exact: true }).waitFor()
    await notice.getByText('它的插件装好后在「已安装」里管理。', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('plugins-search').count(), 0)
    assert.equal(await page.locator('.xm-toolbar-right').count(), 0)
    await notice.getByTestId('plugins-market-go-installed').click()
    await page.getByRole('tab', { name: '已安装', exact: true, selected: true }).waitFor()
    await page.getByTestId('plugins-search').waitFor()
  } finally {
    await page.close()
  }
})

test('the Codex plugin catalog fetched on entering the market brings no extra success note', async () => {
  const page = await fixture('page=plugins')
  try {
    await page.getByRole('button', { name: 'Codex CLI', exact: true }).click()
    await page.getByRole('tab', { name: '市场', exact: true }).click()
    await page.getByTestId('plugins-row-game-studio@openai-api-curated').waitFor()
    await page.waitForTimeout(300)
    assert.equal(await page.getByText('插件目录已下载，下面就是可以安装的插件。').count(), 0)
    assert.equal((await callsNamed(page, 'ensure-marketplace')).length, 1)
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
    // 恢复完当场测一次连接，结论留在备份页上。
    await page
      .getByTestId('backups-restore-check')
      .getByText('连接正常，gpt-6-astra 可以直接使用')
      .waitFor()
    assert.equal(
      (await calls(page)).find((call) => call.name === 'check-connection').args,
      'codex',
    )
  } finally {
    await page.close()
  }
})

// 第 45～47 条：空着时说清备份从哪来；按工具筛选时空状态点名那个工具，「创建第一份备份」和右边的下拉都跟着筛选走。
test('an empty backup list says where backups come from and backs up the tool picked above', async () => {
  const page = await fixture('page=backups&empty')
  try {
    const state = page.getByTestId('backups-empty')
    await state.getByText('还没有备份', { exact: true }).waitFor()
    await state.getByText('改工具配置前会自动留一份。想现在就留一份，点下面的按钮。', { exact: true }).waitFor()
    const picker = page.getByRole('combobox', { name: '选择备份工具', exact: true })
    assert.equal(await picker.inputValue(), 'claude')
    await page.getByRole('button', { name: 'Gemini CLI', exact: true }).click()
    await state.getByText('Gemini CLI 还没有备份', { exact: true }).waitFor()
    assert.equal(await picker.inputValue(), 'gemini')
    await state.getByRole('button', { name: '创建第一份备份', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'createBackup'))
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'createBackup').map((call) => call.args), [['gemini']])
    // 选回「全部工具」：右边的下拉不动。
    await page.getByRole('button', { name: '全部工具', exact: true }).click()
    await state.getByText('还没有备份', { exact: true }).waitFor()
    assert.equal(await picker.inputValue(), 'gemini')
    await page.getByText('备份在本机，可能含凭据，请妥善保管。', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('backups are searched by the date the list shows, not by an id nobody sees', async () => {
  const page = await fixture('page=backups')
  try {
    const row = page.getByTestId('backups-row-backup-1')
    const shown = await row.locator('time').innerText()
    // 图标单独一格，标题只有工具名。
    await row.locator('.xm-row-icon').waitFor()
    assert.equal(await row.locator('.xm-row-title').innerText().then((text) => text.startsWith('Codex CLI')), true)
    const search = page.getByTestId('backups-search')
    assert.equal(await search.getAttribute('placeholder'), '搜索日期')
    await search.fill(shown)
    await row.waitFor()
    await search.fill('backup-1')
    await page.getByTestId('backups-filter-empty').getByText('没有找到「backup-1」', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('backup list names whose key a backup holds and warns before restoring another account key', async () => {
  const page = await fixture('page=backups&backupOtherKey')
  try {
    await page.getByTestId('backups-key-backup-1').getByText('账号 old-user 的 Key').waitFor()
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await page.getByTestId('backup-preview-key').getByText('账号 old-user 的 Key').waitFor()
    await page
      .getByRole('button', { name: '恢复这份配置', exact: true })
      .click()
    await page.getByTestId('backups-restore-key-warning').waitFor()
    assert.match(
      await page.getByTestId('backups-restore-key-warning').innerText(),
      /用量不会记在当前账号上/,
    )
  } finally {
    await page.close()
  }
})

test('feedback narrows the log list by source and to this run, and copies one entry', async () => {
  const page = await fixture('page=feedback')
  try {
    await page.getByText('上次启动的更新记录').waitFor()
    await page.getByTestId('feedback-source').selectOption('更新')
    await page.waitForFunction(() => !document.body.innerText.includes('测试日志'))
    await page.getByText('本次启动的更新失败').waitFor()

    await page.getByTestId('feedback-current-boot').getByRole('switch').click()
    await page.waitForFunction(() =>
      !document.body.innerText.includes('上次启动的更新记录'),
    )
    await page.getByText('本次启动的更新失败').waitFor()

    await page.getByTestId('feedback-log-2026-09-07T01:00:00Z:4242:2').click()
    await page.getByRole('button', { name: '复制这一条', exact: true }).click()
    await page.getByText('这一条已复制').first().waitFor()
    assert.deepEqual(
      (await calls(page))
        .filter((call) => call.name === 'copy-clipboard')
        .map((call) => call.args),
      ['[2026-09-07T01:00:00Z] [ERROR] [updater/download] 本次启动的更新失败 {"code":"ENOENT"}'],
    )
  } finally {
    await page.close()
  }
})

// 第 48～50 条：日志一条一行、整行点开；卡头写条数、放「打开日志目录」「清除日志」；脱敏提示是一行细条。
test('feedback shows one line per log entry under a card head that counts them', async () => {
  const page = await fixture('page=feedback')
  try {
    const row = page.getByTestId('feedback-log-2026-09-07T01:00:00Z:4242:2')
    await row.waitFor()
    assert.match(await row.locator('time').innerText(), /^(\d{4}年)?\d{1,2}月\d{1,2}日 \d{2}:\d{2}:\d{2}$/)
    assert.equal(await row.locator('.v2-feedback-log-level').innerText(), '错误')
    assert.match(await row.locator('.v2-feedback-log-level').getAttribute('class'), /is-error/)
    assert.equal(await row.locator('.v2-feedback-log-message').innerText(), '本次启动的更新失败')
    assert.equal(await row.locator('.v2-feedback-log-source').innerText(), '更新')
    assert.equal(await row.locator('.v2-feedback-log-more').innerText(), '详情 ›')
    // 一条一行：没有文件图标，也没有单独的「详情」按钮。
    assert.equal(await row.locator('svg').count(), 0)
    assert.equal(await page.getByRole('button', { name: '详情', exact: true }).count(), 0)
    const height = (await row.boundingBox()).height
    assert.ok(height < 44, `one line per entry (${height})`)
    const card = page.locator('.xm-card').filter({ has: row })
    await card.locator('.xm-card-head').getByText('共 3 条', { exact: true }).waitFor()
    await card.locator('.xm-card-head').getByRole('button', { name: '打开日志目录', exact: true }).waitFor()
    assert.equal(await page.getByTestId('feedback-clear').isEnabled(), true)
    assert.equal(await page.getByText('已限制为最近日志。').count(), 0)
    const privacy = page.getByTestId('feedback-privacy')
    assert.equal(await privacy.innerText().then((text) => text.replace(/\s+/g, '')), '报告会自动脱敏：不会包含账号密码与完整密钥。发送前仍请检查私有项目名称和地址。联系客服')
    assert.ok((await privacy.boundingBox()).height <= 50)
    // 筛选后条数跟着列表走。
    await page.getByTestId('feedback-source').selectOption('更新')
    await card.locator('.xm-card-head').getByText('共 2 条', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('feedback cannot clear logs it has none of and says how to read them when the list fails', async () => {
  const empty = await fixture('page=feedback&empty')
  try {
    const state = empty.getByTestId('feedback-empty')
    await state.getByText('还没有运行日志', { exact: true }).waitFor()
    await state.getByText('软件运行时的事件会记录在这里。', { exact: true }).waitFor()
    assert.equal(await empty.getByTestId('feedback-clear').isDisabled(), true)
  } finally {
    await empty.close()
  }
  const failed = await fixture('page=feedback&fail=load')
  try {
    const state = failed.getByTestId('feedback-error')
    await state.getByText('点「重新加载」再试；还不行，点「打开日志目录」直接看日志文件。', { exact: true }).waitFor()
    await state.getByRole('button', { name: '重新加载', exact: true }).waitFor()
    assert.equal(await failed.getByTestId('feedback-clear').isDisabled(), true)
  } finally {
    await failed.close()
  }
})

test('feedback shows the latest 100 entries first and 100 more on request', async () => {
  const page = await fixture('page=feedback&manyLogs')
  try {
    const card = page.locator('.xm-card').filter({ has: page.getByTestId('feedback-log-next') })
    await card.locator('.xm-card-head').getByText('最近 500 条', { exact: true }).waitFor()
    assert.equal(await page.locator('.v2-feedback-log').count(), 100)
    assert.equal(await page.getByTestId('feedback-log-next').innerText(), '再显示 100 条')
    await page.getByTestId('feedback-log-next').click()
    await page.getByTestId('feedback-log-next').waitFor({ state: 'detached' })
    assert.equal(await page.locator('.v2-feedback-log').count(), 150)
    // 换了筛选条件就从头的 100 条重新开始。
    await page.getByTestId('feedback-search').fill('测试日志')
    await page.getByTestId('feedback-log-next').waitFor()
    assert.equal(await page.locator('.v2-feedback-log').count(), 100)
    // 改回原来的条件也一样从头的 100 条开始，不接着上次翻到的 150 条。
    await page.getByTestId('feedback-search').fill('第 7 条测试日志')
    await page.waitForFunction(() => document.querySelectorAll('.v2-feedback-log').length === 1)
    await page.getByTestId('feedback-search').fill('')
    await page.waitForFunction(() => document.querySelectorAll('.v2-feedback-log').length > 1)
    assert.equal(await page.locator('.v2-feedback-log').count(), 100)
    await page.getByTestId('feedback-log-next').waitFor()
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
    // 报告里已经有检查结果时不提醒先去检查。
    assert.equal(await page.getByTestId('feedback-report-unchecked').count(), 0)
    await page.getByRole('button', { name: '复制报告', exact: true }).click()
    await page.getByRole('button', { name: '导出文件', exact: true }).click()
    await page.getByText('反馈报告已导出：').first().waitFor()
    // 提示条上那颗按钮把刚写出的那个文件交回主进程去定位，不是别的路径。
    await page
      .getByRole('dialog')
      .getByRole('button', { name: '打开所在位置', exact: true })
      .click()
    await page.waitForFunction(() =>
      JSON.parse(document.documentElement.dataset.calls || '[]').some(
        (call) => call.name === 'reveal-file',
      ),
    )
    assert.deepEqual(
      (await calls(page))
        .filter((call) => ['copy-report', 'export-report', 'reveal-file'].includes(call.name))
        .map((call) => call.args),
      ['report-snapshot-7', 'report-snapshot-7', 'C:\test-report.txt'],
    )
  } finally {
    await page.close()
  }
})

test('the feedback preview sends the customer to the check page when the report has no check result', async () => {
  const page = await fixture('page=feedback&selfCheckMissing')
  try {
    await page
      .getByRole('button', { name: '预览反馈报告', exact: true })
      .click()
    const hint = page.getByTestId('feedback-report-unchecked')
    await hint.getByText('报告里还没有检查结果', { exact: true }).waitFor()
    await hint.getByText('点「去检查」，等检查页查完再回来复制或导出，客服能少问你几句。', { exact: true }).waitFor()
    await hint.getByRole('button', { name: '去检查', exact: true }).click()
    await page.getByTestId('feedback-report-text').waitFor({ state: 'detached' })
    assert.deepEqual(
      (await calls(page))
        .filter((call) => call.name === 'navigate')
        .map((call) => call.args),
      ['health'],
    )
  } finally {
    await page.close()
  }
})

test('a cancelled export reports nothing instead of claiming the file was written', async () => {
  const page = await fixture('page=sessions')
  try {
    await page.getByTestId('sessions-view-codex:session-1').click()
    const drawer = page.getByTestId('session-detail-drawer')
    await drawer.getByText('这是一条测试消息').waitFor()
    await drawer.getByRole('button', { name: '导出', exact: true }).click()
    await page.waitForFunction(() =>
      JSON.parse(document.documentElement.dataset.calls || '[]').some(
        (call) => call.name === 'export-session',
      ),
    )
    assert.equal(await page.getByText('已导出').count(), 0)
    assert.equal(await page.getByText('操作已完成').count(), 0)
  } finally {
    await page.close()
  }
})

test('row overflow menus are named after the row they act on', async () => {
  const keys = await fixture('page=account&accountTab=keys')
  try {
    await keys
      .getByRole('button', { name: '密钥 Test key 的更多操作', exact: true })
      .waitFor()
    assert.equal(await keys.getByRole('button', { name: '操作', exact: true }).count(), 0)
  } finally {
    await keys.close()
  }
  const backups = await fixture('page=backups')
  try {
    await backups
      .getByRole('button', { name: /的备份更多操作$/ })
      .first()
      .waitFor()
  } finally {
    await backups.close()
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

// 第 52～54 条：版本号和别的行对齐、用正文的字；有新版本时多一行「新版本」；读不到时标题照实说；
//「安装前需要知道」不折叠。
test('the updates page lines up the versions, names the new one and shows what to know before installing', async () => {
  const page = await fixture('page=updates')
  try {
    const current = page.getByTestId('updates-current-version')
    await current.getByText('0.1.31', { exact: true }).waitFor()
    assert.equal(await current.locator('.xm-row-icon').count(), 0)
    const next = page.getByTestId('updates-new-version')
    await next.getByText('新版本', { exact: true }).waitFor()
    await next.getByText('0.1.32', { exact: true }).waitFor()
    const titleLeft = (row) => row.locator('.xm-row-title').evaluate((element) => Math.round(element.getBoundingClientRect().left))
    const checked = page.locator('.xm-list-row').filter({ hasText: '上次检查' })
    assert.equal(await titleLeft(current), await titleLeft(checked))
    const size = await current.locator('.v2-update-version').evaluate((element) => getComputedStyle(element).fontSize)
    assert.equal(size, '14px')
    const note = page.getByTestId('updates-install-note')
    assert.equal(await note.isVisible(), true)
    await note.getByText('安装前需要知道', { exact: true }).waitFor()
    await note.getByText(/^装之前先保存工具里没做完的东西。/).waitFor()
    assert.equal(await page.locator('details').count(), 0)
  } finally {
    await page.close()
  }
  const failed = await fixture('page=updates&fail=load')
  try {
    await failed.getByText('更新状态暂未读到', { exact: true }).waitFor()
    assert.equal(await failed.getByText('正在读取更新状态…', { exact: true }).count(), 0)
    assert.equal(await failed.getByTestId('updates-new-version').count(), 0)
  } finally {
    await failed.close()
  }
})

// 「更新」页也能直接开关启动检查和自动更新，不用再绕去设置。
test('the updates page switches the startup check and automatic updates in place', async () => {
  const page = await fixture('page=updates&autoUpdate=1')
  try {
    const check = page.getByTestId('updates-check-on-startup').getByRole('switch', { name: '启动时检查新版本', exact: true })
    const automatic = page.getByTestId('updates-auto-update').getByRole('switch', { name: '自动更新', exact: true })
    await page.waitForFunction(() => document.querySelector('[data-testid="updates-check-on-startup"] [role="switch"]')?.disabled === false)
    assert.equal(await check.getAttribute('aria-checked'), 'true')
    assert.equal(await automatic.getAttribute('aria-checked'), 'true')
    await check.click()
    await page.locator('.xm-toast').getByText('已保存', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid="updates-check-on-startup"] [role="switch"]')?.getAttribute('aria-checked') === 'false')
    await page.waitForFunction(() => document.querySelector('[data-testid="updates-auto-update"] [role="switch"]')?.disabled === false)
    await automatic.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="updates-auto-update"] [role="switch"]')?.getAttribute('aria-checked') === 'false')
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'settings').map((call) => call.args),
      [
        { version: 2, checkUpdatesOnStartup: false },
        { version: 2, autoUpdate: false },
      ],
    )
    assert.equal(await page.getByRole('button', { name: '去设置', exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('the updates page leaves the automatic update switch out where the app cannot update itself', async () => {
  const page = await fixture('page=updates')
  try {
    await page.getByTestId('updates-check-on-startup').waitFor()
    assert.equal(await page.getByTestId('updates-auto-update').count(), 0)
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

test('the payment terminal listener survives re-renders and still resolves a pending order', async () => {
  const page = await fixture('page=account&subscriptionExternal=1')
  try {
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    await page.getByRole('button', { name: '购买', exact: true }).waitFor()
    const subscribed = await page.evaluate(() => window.paymentTerminalSubscriptions())
    assert.equal(subscribed.live, 1)

    // 余额 store 每 30 秒 publish 两次，整棵树跟着重渲染。回调若随渲染变身份，
    // 订阅就跟着退订重订，重订之间到达的那条回调没有人接。
    await page.evaluate(async () => {
      for (let round = 0; round < 6; round++) {
        window.rerenderFixture()
        await new Promise((resolve) => requestAnimationFrame(resolve))
      }
    })
    const afterRerenders = await page.evaluate(() => window.paymentTerminalSubscriptions())
    assert.equal(afterRerenders.added, subscribed.added)
    assert.equal(afterRerenders.live, 1)

    // 重渲染之后到达的回调仍然落到同一个待支付订单上
    await page.getByRole('button', { name: '购买', exact: true }).click()
    await page.getByRole('button', { name: '打开支付窗口', exact: true }).click()
    await page.getByText('订阅订单 XM-VISUAL-SUBSCRIPTION', { exact: false }).waitFor()
    await page.evaluate(async () => {
      window.rerenderFixture()
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'closed', tradeNo: 'XM-VISUAL-SUBSCRIPTION' }))
    await page.getByText('支付窗口已关闭', { exact: true }).waitFor()
    assert.equal(await page.getByText('等待支付结果', { exact: true }).count(), 0)
    assert.equal((await page.evaluate(() => window.paymentTerminalSubscriptions())).live, 1)
  } finally {
    await page.close()
  }
})

test('recharge presets show credited, paid and bonus, and the quote dialog spells the bonus out', async () => {
  const page = await fixture('page=account&topupBonus=1')
  try {
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    const plain = page.getByRole('button', { name: '到账 $10，实付 10.00', exact: true })
    const bonus = page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true })
    await plain.waitFor()
    await bonus.click()
    assert.equal(await bonus.getAttribute('aria-pressed'), 'true')
    const breakdown = page.getByTestId('account-recharge-breakdown')
    assert.equal(await breakdown.innerText().then((text) => text.replace(/\s+/g, ' ')), '到账 $20 实付 16.00 送 25%')
    await plain.click()
    assert.equal(await breakdown.innerText().then((text) => text.replace(/\s+/g, ' ')), '到账 $10 实付 10.00')
    await page.getByLabel('自定义金额').fill('37')
    await breakdown.getByText('实付 37.00', { exact: false }).waitFor()
    assert.equal(await breakdown.innerText().then((text) => text.replace(/\s+/g, ' ')), '到账 $37 实付 37.00')
    assert.equal(await page.getByText('无赠送', { exact: true }).count(), 0)
    await bonus.click()
    await page.getByTestId('account-recharge-submit').click()
    const quote = page.getByRole('dialog', { name: '确认充值报价' })
    await quote.waitFor()
    assert.equal(
      await quote.getByTestId('account-recharge-quote-bonus').textContent(),
      '活动赠送：4（多送 25%），到账 20',
    )
    await quote.getByText('应付金额：16.00', { exact: false }).waitFor()
  } finally {
    await page.close()
  }
})

test('a tier picked on the home activity card arrives preselected on the recharge page', async () => {
  const page = await fixture('page=account&accountTab=recharge&rechargeAmount=20&topupBonus=1')
  try {
    const breakdown = page.getByTestId('account-recharge-breakdown')
    await breakdown.getByText('实付 16.00', { exact: false }).waitFor()
    assert.equal(await page.getByLabel('自定义金额').inputValue(), '20')
    assert.equal(await breakdown.innerText().then((text) => text.replace(/\s+/g, ' ')), '到账 $20 实付 16.00 送 25%')
    assert.equal(
      await page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true }).getAttribute('aria-pressed'),
      'true',
    )
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

test('a payment window closed before settlement keeps confirming and points to the order', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    await page.getByTestId('account-recharge-submit').click()
    await page.getByRole('dialog', { name: '确认充值报价' }).getByRole('button', { name: '打开支付窗口' }).click()
    await page.getByText('等待支付结果', { exact: true }).waitFor()
    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'closed', tradeNo: 'XM-VISUAL-TOPUP', confirming: true }))
    const notice = page.getByTestId('account-payment-notice')
    await notice.getByText('星芒还在确认到账', { exact: false }).waitFor()
    await notice.getByText('正在确认订单 XM-VISUAL-TOPUP 是否到账…', { exact: true }).waitFor()
    assert.equal(await notice.getByRole('button', { name: '查看我的订单', exact: true }).count(), 1)

    // 收起了提示也要把晚到的结果摆出来；别的订单的结果不算。
    await notice.getByRole('button', { name: '收起提示', exact: true }).click()
    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'success', tradeNo: 'OTHER-ORDER' }))
    assert.equal(await page.getByTestId('account-payment-notice').count(), 0)
    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'success', tradeNo: 'XM-VISUAL-TOPUP' }))
    await page.getByText('订单 XM-VISUAL-TOPUP 已到账，余额已更新。', { exact: true }).waitFor()
    await page.getByText('当前余额 $14.00', { exact: true }).waitFor()
  } finally { await page.close() }
})

test('an unconfirmed payment opens my orders with its order number', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '充值与订阅', exact: true }).click()
    await page.getByTestId('account-recharge-submit').click()
    await page.getByRole('dialog', { name: '确认充值报价' }).getByRole('button', { name: '打开支付窗口' }).click()
    await page.getByText('等待支付结果', { exact: true }).waitFor()
    await page.evaluate(() => {
      window.emitPaymentWindowTerminal({ status: 'closed', tradeNo: 'XM-VISUAL-TOPUP', confirming: true })
      window.emitPaymentWindowTerminal({ status: 'unconfirmed', tradeNo: 'XM-VISUAL-TOPUP' })
    })
    await page.getByText('还没查到这笔订单到账', { exact: true }).waitFor()
    await page.getByTestId('account-payment-orders').click()
    await page.getByRole('tab', { name: '我的订单', exact: true, selected: true }).waitFor()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-orders' && call.args.keyword === 'XM-VISUAL-TOPUP'))
  } finally { await page.close() }
})

// 存好了只弹会自己消失的小提示，页面不往下跳；页顶红条只留给没存上的。
test('a saved setting says so in a passing toast without pushing the page down', async () => {
  const page = await fixture('page=settings')
  try {
    const control = page.getByRole('switch', { name: '减少动画', exact: true })
    const before = (await control.boundingBox()).y
    await control.click()
    await page.locator('.xm-toast').getByText('已保存', { exact: true }).waitFor()
    assert.equal(await control.getAttribute('aria-checked'), 'true')
    assert.equal((await control.boundingBox()).y, before, 'the switch stays where it was')
    assert.equal(await page.locator('.v2-business-notice').count(), 0, 'no banner is added above the groups')
    assert.equal(await page.getByText('已完成', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('settings that wait on the system state say they were not read and read again on request', async () => {
  const page = await fixture('page=settings&system=1&fail=platform-read')
  try {
    await page.getByText('系统状态暂时读不到', { exact: true }).waitFor()
    const contrast = page.locator('[data-anchor="high-contrast"]')
    await contrast.getByText('暂未读到', { exact: true }).waitFor()
    assert.equal(await page.getByText('此版本暂不支持', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await page.getByRole('switch', { name: '高对比度', exact: true }).waitFor()
    assert.equal(await page.getByText('系统状态暂时读不到', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '重新读取', exact: true }).count(), 0)
    assert.equal(await contrast.getByText('暂未读到', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('the notification kinds sit under their own heading and say when the master switch silences them', async () => {
  const page = await fixture('page=settings&system=1')
  try {
    await page.getByRole('tab', { name: '通知', exact: true }).click()
    const kinds = page.getByTestId('settings-notification-kinds')
    await kinds.getByRole('heading', { name: '提醒哪些事', exact: true }).waitFor()
    assert.equal(await kinds.getByText('桌面通知关着，下面这些都不会提醒', { exact: true }).count(), 0)
    await page.getByRole('switch', { name: '桌面通知', exact: true }).click()
    await kinds.getByText('桌面通知关着，下面这些都不会提醒', { exact: true }).waitFor()
    assert.equal(await page.getByRole('switch', { name: '余额不足通知', exact: true }).isDisabled(), true)
  } finally {
    await page.close()
  }
})

test('account and network rows open the account switcher and the check page entry they name', async () => {
  const page = await fixture('page=settings')
  try {
    await page.getByRole('tab', { name: '账号', exact: true }).click()
    await page.getByTestId('settings-switch-account').click()
    await page.getByTestId('settings-logout').click()
    const logout = page.getByRole('dialog', { name: '退出登录？', exact: true })
    await logout.getByText('工具里已写入的配置继续保留。', { exact: true }).waitFor()
    await logout.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('tab', { name: '网络', exact: true }).click()
    await page.getByTestId('settings-certificate-health').click()
    assert.deepEqual(
      (await calls(page)).filter((call) => ['open-account-switcher', 'navigate'].includes(call.name)).map((call) => [call.name, call.args ?? null]),
      [
        ['open-account-switcher', null],
        ['navigate', ['health', 'CERTIFICATE_TRUST']],
      ],
    )
  } finally {
    await page.close()
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
    await page.getByRole('button', { name: '看连接方式', exact: true }).click()
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

test('saved accounts switch tools already on the account key by default and expose only eligible choices', async () => {
  const page = await fixture('page=account&sync=1')
  try {
    // 卡片里「同步到工具」默认收起；点开才看得到四个勾选框。
    const sync = page.getByText('同步到工具', { exact: true })
    await sync.waitFor()
    assert.equal(await page.getByTestId('account-sync-gemini').isVisible(), false)
    await sync.click()
    await page.getByTestId('account-sync-gemini').waitFor()
    assert.equal(
      await page.getByTestId('account-sync-claude').isChecked(),
      true,
    )
    assert.equal(
      await page.getByTestId('account-sync-gemini').isChecked(),
      true,
    )
    assert.equal(
      await page.getByTestId('account-sync-codex').isDisabled(),
      true,
    )
    assert.equal(await page.getByTestId('account-sync-grok').isDisabled(), true)
    // 取消勾选就不同步：用户说了算。
    await page.getByTestId('account-sync-claude').uncheck()
    await page.getByTestId('account-sync-gemini').uncheck()
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
    await page.getByText('同步到工具', { exact: true }).click()
    await page.getByTestId('account-sync-claude').waitFor()
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
      (await calls(page)).filter((call) => call.name === 'sync-config').map((call) => call.args),
      [
        { providers: ['claude'], preferredModels: { claude: 'fixture-model' }, intent: 'explicit' },
        { providers: ['gemini'], preferredModels: { gemini: 'fixture-model' }, intent: 'explicit' },
      ],
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
    await page.getByText('同步到工具', { exact: true }).click()
    await page.getByTestId('account-sync-claude').waitFor()
    await page.getByTestId('account-sync-claude').check()
    await page
      .getByRole('button', { name: '切换', exact: true, disabled: false })
      .click()
    await page
      .getByText('这个保存的账号登录已失效，当前账号没有变化。', { exact: false })
      .first()
      .waitFor()
    // 全面检测 Q12：不能套上「登录已过期」的标题，那读起来像当前账号掉线了。
    assert.equal(await page.getByText('登录已过期', { exact: true }).count(), 0)
    assert.equal(
      (await calls(page)).some((call) => call.name === 'sync-config'),
      false,
    )
    assert.equal(
      await page.getByTestId('account-sync-claude').isChecked(),
      true,
    )
    await page.getByRole('button', { name: '重新登录这个账号', exact: true }).click()
    assert.equal((await calls(page)).some((call) => call.name === 'login'), true)
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

test('desktop notifications start on, the master switch gates test notifications and privacy stores only an explicit local preference', async () => {
  const page = await fixture('page=settings&system=1')
  try {
    await page.getByRole('tab', { name: '通知', exact: true }).click()
    const testNotice = page.getByRole('button', {
      name: '发一条测试通知',
      exact: true,
    })
    // 没存过的设置按默认打开；关掉时只存下显式的 false，再打开能恢复。
    const master = page.getByRole('switch', { name: '桌面通知', exact: true })
    assert.equal(await master.getAttribute('aria-checked'), 'true')
    assert.equal(await testNotice.isDisabled(), false)
    await master.click()
    await page.waitForFunction(() => document.querySelector('[aria-label="桌面通知"]')?.getAttribute('aria-checked') === 'false')
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'settings').at(-1).args,
      { version: 2, desktopNotifications: false },
    )
    assert.equal(await testNotice.isDisabled(), true)
    await master.click()
    await page
      .getByRole('switch', { name: '余额不足通知', exact: true })
      .click()
    await testNotice.click()
    await page.getByText('已请求显示测试通知', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '隐私与数据', exact: true }).click()
    const crashReports = page.getByRole('switch', {
      name: '崩溃自动上报',
      exact: true,
    })
    assert.equal(await crashReports.getAttribute('aria-checked'), 'true')
    await crashReports.click()
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'settings').at(-1).args,
      { version: 2, crashReporting: false },
    )
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
    assert.equal(await page.getByRole('button', { name: '刷新任务', exact: true }).count(), 0)
    await page.getByTestId('account-refresh').click()
    await page.getByText('已完成 100%', { exact: true }).waitFor()
    await page.getByTestId('account-refresh').click()
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

test('an async task result is copied as a link instead of asking the host to open an upstream URL', async () => {
  const page = await fixture('page=account&system=1&taskTransition=1')
  try {
    await page.getByRole('tab', { name: '异步任务', exact: true }).click()
    await page.getByText('处理中 50%', { exact: true }).waitFor()
    await page.getByTestId('account-refresh').click()
    await page.getByText('已完成 100%', { exact: true }).waitFor()
    await page.getByRole('button', { name: '详情', exact: true }).click()
    await page
      .getByText('https://cdn.upstream.example.test/fixture-task.mp4', {
        exact: true,
      })
      .waitFor()
    assert.equal(
      await page.getByRole('button', { name: '查看结果', exact: true }).count(),
      0,
    )
    await page
      .getByRole('button', { name: '复制结果链接', exact: true })
      .click()
    await page.getByText('结果链接已复制', { exact: true }).waitFor()
    const recorded = await calls(page)
    assert.equal(
      recorded.some((call) => call.name === 'openExternal'),
      false,
    )
    assert.deepEqual(
      recorded
        .filter((call) => call.name === 'copy-clipboard')
        .map((call) => call.args),
      ['https://cdn.upstream.example.test/fixture-task.mp4'],
    )
  } finally {
    await page.close()
  }
})

test('cancelling the password dialog drops the typed secrets and Esc confirms before discarding them', async () => {
  const page = await fixture('page=account&system=1')
  try {
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('当前密码', { exact: true }).fill('old-secret')
    await dialog.getByLabel('新密码', { exact: true }).fill('new-secret-value')
    await page.keyboard.press('Escape')
    await dialog.getByText('要放弃未保存的修改吗？', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '继续编辑', exact: true }).click()
    assert.equal(
      await dialog.getByLabel('当前密码', { exact: true }).inputValue(),
      'old-secret',
    )
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    const reopened = page.getByRole('dialog')
    assert.deepEqual(
      await Promise.all([
        reopened.getByLabel('当前密码', { exact: true }).inputValue(),
        reopened.getByLabel('新密码', { exact: true }).inputValue(),
        reopened.getByLabel('确认新密码', { exact: true }).inputValue(),
      ]),
      ['', '', ''],
    )
  } finally {
    await page.close()
  }
})
