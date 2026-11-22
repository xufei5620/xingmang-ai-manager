import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { before, after, test } from 'node:test'
import { expect } from '@playwright/test'
import { openFixturePage } from './fixture-readiness.mjs'
import { actionTimeoutMs, createBrowserFixture, navigationTimeoutMs } from './harness.mjs'
import { assertNoToast, recordToasts, waitForToast } from './toast-recording.mjs'

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
const fixture = async (route, prepare) => {
  const page = await business.newPage()
  await page.addInitScript(recordToasts)
  await prepare?.(page)
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

// 调用明细一行就是一个入口（v4），点那一行打开详情。
function usageRow(page) {
  return page.getByTestId('account-usage-section').locator('tbody tr').first()
}

async function openUsageDetails(page) {
  await page.getByRole('tab', { name: '用量账单', exact: true }).click()
  await usageRow(page).click()
  const dialog = page.getByTestId('usage-detail-dialog')
  await dialog.waitFor()
  return dialog
}

test('Sub2API subscriptions show independent quotas and never offer unsupported writes or tasks', async () => {
  const page = await fixture('page=account&sub2apiReliability=1&subscriptionExternal=1')
  try {
    // 用量账单里没有「生成任务」这一节。
    await page.getByRole('tab', { name: '用量账单', exact: true }).click()
    await page.getByTestId('account-usage-section').waitFor()
    assert.equal(await page.getByTestId('account-tasks-section').count(), 0)
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.locator('.xm-row-title').filter({ hasText: '周期订阅' }).waitFor()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const text = await panel.innerText()
    assert.match(text, /日额度：\s*已用 \$1\.00 · 限额 \$5\.00 · 剩余 \$4\.00/)
    assert.match(text, /周额度：\s*已用 \$4\.00 · 限额 \$20\.00 · 剩余 \$16\.00/)
    assert.match(text, /月额度：\s*已用 \$12\.00 · 限额暂未提供/)
    assert.equal(await panel.getByRole('group', { name: '扣费顺序' }).count(), 0)
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
    await page.getByRole('tab', { name: '用量账单', exact: true }).click()
    const usage = page.getByTestId('account-usage-section')
    await usage.waitFor()
    // 筛选框全部收在「展开筛选」里（v4），工具条上只有这一颗按钮。
    const toggle = usage.getByTestId('account-filters-toggle')
    assert.equal(await toggle.innerText(), '展开筛选')
    assert.equal(await usage.getByLabel('开始日期', { exact: true }).count(), 0)
    await toggle.click()
    assert.equal(await toggle.innerText(), '收起筛选')
    for (const label of ['开始时间', '结束时间', '密钥名称', '分组', '请求 ID', '上游请求 ID', '日志类型', 'Key ID', '分组 ID']) {
      assert.equal(await usage.getByLabel(label, { exact: true }).count(), 0)
    }
    await usage.getByLabel('开始日期', { exact: true }).fill('2026-09-08')
    await usage.getByLabel('结束日期', { exact: true }).fill('2026-09-08')
    await usage.getByLabel('密钥编号', { exact: true }).fill('4')
    await usage.getByLabel('分组编号', { exact: true }).fill('5')
    await usage.getByLabel('计费来源', { exact: true }).selectOption('0')
    await usage.getByRole('button', { name: '查询', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage' && call.args.apiKeyId === 4))
    const last = (await calls(page)).filter((call) => call.name === 'query-usage').at(-1).args
    assert.equal(last.startDate, '2026-09-08')
    assert.equal(last.endDate, '2026-09-08')
    assert.equal(last.timezone, await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone))
    assert.equal(last.billingType, 0)
    assert.equal(last.groupId, 5)
    assert.equal('startTimestamp' in last, false)
    await page.getByText(/包含结束日期全天/).waitFor()
    await usage.getByText('该时间段暂无调用', { exact: true }).waitFor()
    await usage.getByText('请调整筛选条件。', { exact: true }).waitFor()
    // 收起来以后，改过的条件数挂在按钮上；没动过的默认日期不算。
    await toggle.click()
    assert.equal(await toggle.innerText(), '展开筛选 · 5')
    assert.equal(await usage.getByLabel('密钥编号', { exact: true }).count(), 0)
  } finally { await page.close() }
})

test('Sub2API usage left open overnight still asks for the last 7 days up to today', async () => {
  // 页签只藏不卸、关窗只缩到托盘：没手选日期时默认那 7 天按每次读的时候现算，不停在第一次打开那天（#1093 第 1 条）。
  const page = await fixture('page=account&accountTab=usage&sub2apiReliability=1', (next) => next.clock.install({ time: new Date('2026-10-17T12:00:00Z') }))
  const shift = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
  const today = () => page.evaluate(() => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()))
  const usageQueries = async () => (await calls(page)).filter((call) => call.name === 'query-usage').map((call) => call.args)
  async function refreshOnDay(time) {
    await page.clock.setSystemTime(new Date(time))
    const count = (await usageQueries()).length
    await page.getByTestId('account-refresh').click()
    await page.waitForFunction((seen) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'query-usage').length > seen, count)
    return (await usageQueries()).at(-1)
  }
  try {
    const usage = page.getByTestId('account-usage-section')
    await usage.waitFor()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage'))
    const first = (await usageQueries()).at(-1)
    assert.equal(first.endDate, await today())
    assert.equal(first.startDate, shift(first.endDate, -6))

    const next = await refreshOnDay('2026-10-18T12:00:00Z')
    assert.equal(next.endDate, shift(first.endDate, 1))
    assert.equal(next.startDate, shift(first.startDate, 1))
    // 筛选框里的默认日期跟着换到今天，也不算用户加的条件。
    const toggle = usage.getByTestId('account-filters-toggle')
    assert.equal(await toggle.innerText(), '展开筛选')
    await toggle.click()
    assert.equal(await usage.getByLabel('开始日期', { exact: true }).inputValue(), next.startDate)
    assert.equal(await usage.getByLabel('结束日期', { exact: true }).inputValue(), next.endDate)

    // 只加一个密钥编号、日期没动：日期还是跟着日子走。
    await usage.getByLabel('密钥编号', { exact: true }).fill('4')
    await usage.getByRole('button', { name: '查询', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage' && call.args.apiKeyId === 4))
    const keyed = await refreshOnDay('2026-10-19T12:00:00Z')
    assert.equal(keyed.apiKeyId, 4)
    assert.equal(keyed.endDate, shift(next.endDate, 1))
    assert.equal(keyed.startDate, shift(next.startDate, 1))

    // 自己选了日期就照选的查，过了夜也不动；只改了开始日期，结束日期那一格也不跟着跳，框里写的就是查的。
    assert.equal(await usage.getByLabel('结束日期', { exact: true }).inputValue(), keyed.endDate)
    await usage.getByLabel('开始日期', { exact: true }).fill('2026-10-01')
    await usage.getByRole('button', { name: '查询', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage' && call.args.startDate === '2026-10-01'))
    const picked = await refreshOnDay('2026-10-20T12:00:00Z')
    assert.equal(picked.startDate, '2026-10-01')
    assert.equal(picked.endDate, keyed.endDate)
    assert.equal(picked.apiKeyId, 4)
    assert.equal(await usage.getByLabel('结束日期', { exact: true }).inputValue(), keyed.endDate)
    assert.equal(await toggle.innerText(), '收起筛选')

    // 选过日期以后框里的默认是停住的：过几天把开始日期改回跟它一样，也是自己选的，照这段查，不换成今天往前 7 天。
    await usage.getByLabel('开始日期', { exact: true }).fill(keyed.startDate)
    await usage.getByRole('button', { name: '查询', exact: true }).click()
    await page.waitForFunction((start) => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage' && call.args.startDate === start), keyed.startDate)
    const typedBack = await refreshOnDay('2026-10-21T12:00:00Z')
    assert.equal(typedBack.startDate, keyed.startDate)
    assert.equal(typedBack.endDate, keyed.endDate)

    // 「重置筛选」回到跟着日子走的默认：今天往前 7 天，框里也写这一段。
    const beforeReset = (await usageQueries()).length
    await usage.getByRole('button', { name: '重置筛选', exact: true }).click()
    await page.waitForFunction((seen) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'query-usage').length > seen, beforeReset)
    const reset = (await usageQueries()).at(-1)
    assert.equal(reset.endDate, await today())
    assert.equal(reset.startDate, shift(reset.endDate, -6))
    assert.equal(reset.apiKeyId, undefined)
    assert.equal(await usage.getByLabel('开始日期', { exact: true }).inputValue(), reset.startDate)
    assert.equal(await usage.getByLabel('结束日期', { exact: true }).inputValue(), reset.endDate)
  } finally { await page.close() }
})

test('the usage dashboard splits spending across the tools that have a managed key', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    await page.getByRole('tab', { name: '用量账单', exact: true }).click()
    const card = page.getByTestId('tool-usage')
    await card.waitFor()
    await card.getByText('当前账号累计已用 $8.00，其中 Claude Code 最多（75%）。', { exact: true }).waitFor()
    const rows = card.locator('tbody tr')
    // 已下线的 Gemini CLI 不占一行。
    assert.equal(await rows.count(), 3)
    assert.doesNotMatch(await card.innerText(), /Gemini/)
    assert.match(await rows.nth(0).innerText(), /Claude Code\t?\s*\$6\.00\s*75%\s*\$18\.00\s*\$12\.00/)
    assert.match(await rows.nth(1).innerText(), /Codex CLI\s*\$2\.00\s*25%\s*不限额\s*不限额/)
    assert.match(await rows.nth(2).innerText(), /Grok CLI[\s\S]*未启用/)
    assert.equal(/\$/.test(await rows.nth(2).innerText()), false)
    assert.equal(await card.getByText(/solov|new-api|sub2api/i).count(), 0)
  } finally { await page.close() }
})

test('the usage range drives the stats, one bar per local day or week and the call list', async () => {
  // 直接打开用量账单：账号概览的「近 7 天」也问看板，先停在概览会混进来。
  const page = await fixture('page=account&accountTab=usage')
  try {
    const dashboards = async () => (await calls(page)).filter((call) => call.name === 'get-dashboard').map((call) => call.args)
    const lastUsage = async () => (await calls(page)).filter((call) => call.name === 'query-usage').at(-1)?.args
    await page.getByRole('tab', { name: '用量账单', exact: true, selected: true }).waitFor()
    const stats = page.getByTestId('usage-stats')
    await stats.getByText('$35.00', { exact: true }).waitFor()
    // 默认「7 天」：一天问一次（本地零点切开，接缝那一秒不算两遍），柱子一天一根，最后一根是今天。
    const week = await dashboards()
    assert.equal(week.length, 7)
    const midnight = await page.evaluate(() => { const now = new Date(); return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime() / 1000) })
    assert.equal(week[0].startTimestamp, midnight)
    for (let index = 1; index < week.length; index++) assert.equal(week[index].startTimestamp, week[index - 1].endTimestamp + 1)
    assert.equal((await stats.innerText()).replace(/\s+/g, ' '), '总花费 $35.00 日均 $5.00 请求次数 77 处理字数 14,000')
    const bars = page.locator('.v2-usage-chart-col')
    assert.equal(await bars.count(), 7)
    assert.equal(await bars.last().innerText().then((text) => text.replace(/\s+/g, ' ')), '$5.00 今天')
    assert.match(await bars.last().getAttribute('class'), /is-current/)
    // 调用明细跟着同一段时间查。
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage'))
    assert.equal((await lastUsage()).startTimestamp, midnight)
    await page.getByTestId('account-usage-section').getByText('该时间段暂无调用', { exact: true }).waitFor()

    const range = page.getByRole('group', { name: '统计时间' })
    await range.getByRole('button', { name: '24 小时', exact: true }).click()
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-dashboard').length > count, week.length)
    const day = (await dashboards()).slice(week.length)
    assert.equal(day.length, 1)
    // 起点退到 24 小时前所在的整点：后台看板只记到整点，起点落在半点上，最早那一小时整行不回（#1093 第 4 条）。
    const span = day[0].endTimestamp - day[0].startTimestamp
    assert.equal(day[0].startTimestamp % 3_600, 0)
    assert.ok(span >= 86_400 && span < 86_400 + 3_600, String(span))
    await page.waitForFunction((start) => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage' && call.args.startTimestamp === start), day[0].startTimestamp)
    await stats.getByText('$5.00', { exact: true }).first().waitFor()

    await range.getByRole('button', { name: '30 天', exact: true }).click()
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-dashboard').length >= count + 5, week.length + 1)
    await page.waitForFunction(() => document.querySelectorAll('.v2-usage-chart-col').length === 5)
    assert.match(await bars.first().getAttribute('title'), /^\d+月\d+日至\d+月\d+日：\$5\.00$/)

    // 快捷筛选「失败」：只查错误记录，空着时说该时间段无失败的调用。
    await page.getByTestId('account-usage-section').getByRole('button', { name: '失败', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-usage' && call.args.type === 5))
    await page.getByText('该时间段无失败的调用', { exact: true }).waitFor()
  } finally { await page.close() }
})

test('sub-cent calls, bars and the daily average show the fraction of a cent the call details show', async () => {
  // D53：一次几厘钱的调用以前在明细、柱子、日均上都写成「$0.00」，状态却是「成功」，点进详情又是「$0.0032」。
  const page = await fixture('page=account&accountTab=usage&usageDetail=sub-cent')
  try {
    await page.getByRole('tab', { name: '用量账单', exact: true, selected: true }).waitFor()
    const stats = page.getByTestId('usage-stats')
    await stats.getByText('日均 $0.0032', { exact: true }).waitFor()
    // 七天合计 $0.0224，一分以上照旧两位小数。
    assert.equal((await stats.innerText()).replace(/\s+/g, ' '), '总花费 $0.02 日均 $0.0032 请求次数 77 处理字数 14,000')
    const bars = page.locator('.v2-usage-chart-col')
    assert.equal(await bars.count(), 7)
    assert.equal(await bars.last().innerText().then((text) => text.replace(/\s+/g, ' ')), '$0.0032 今天')
    assert.match(await bars.last().getAttribute('title'), /：\$0\.0032$/)
    const row = usageRow(page)
    await row.getByText('$0.0032', { exact: true }).waitFor()
    await row.click()
    const dialog = page.getByTestId('usage-detail-dialog')
    await dialog.waitFor()
    assert.match(await dialog.locator('section[aria-label="计费明细"]').innerText(), /合计\s*\$0\.0032/)
  } finally { await page.close() }
})

test('refund rows in the call list leave the cost cell as a dash', async () => {
  // 余额审查 F5：退款记录里记着退回的额度，「花费」一格以前写成「$0.50」，看着像又扣了一笔；不是消费的行跟没扣费的失败行一样写「—」。
  const page = await fixture('page=account&accountTab=usage&usageDetail=refund')
  try {
    await page.getByRole('tab', { name: '用量账单', exact: true, selected: true }).waitFor()
    const section = page.getByTestId('account-usage-section')
    const costColumn = await section.locator('thead th').allInnerTexts().then((labels) => labels.map((label) => label.trim()).indexOf('花费'))
    assert.ok(costColumn >= 0)
    const row = usageRow(page)
    await row.getByText('退款', { exact: true }).waitFor()
    assert.equal((await row.locator('td').nth(costColumn).innerText()).trim(), '—')
  } finally { await page.close() }
})

test('changing the usage range sends the call list back to its first page', async () => {
  const page = await fixture('page=account&accountTab=usage&usagePages=1')
  try {
    const section = page.getByTestId('account-usage-section')
    await section.getByText('共 60 条').waitFor()
    // 整行就是入口，读屏念时间和模型，不是「[object Object]」。
    const label = await section.locator('tbody tr').first().getAttribute('aria-label')
    assert.doesNotMatch(label, /object/)
    assert.match(label, /\S+ \S+/)
    await section.getByRole('button', { name: '下一页', exact: true }).click()
    await section.getByText('2 / 3', { exact: true }).waitFor()
    await page.getByRole('group', { name: '统计时间' }).getByRole('button', { name: '24 小时', exact: true }).click()
    await section.getByText('1 / 3', { exact: true }).waitFor()
    const pages = (await calls(page)).filter((call) => call.name === 'query-usage').map((call) => call.args.page)
    // 换范围那一下直接问第一页，不先拿旧页码多问一次。
    assert.deepEqual(pages.slice(-2), [2, 1])
  } finally { await page.close() }
})

test('account views distinguish summary-only, failed reads and valid empty results', async () => {
  for (const [query, tab, expected, absent] of [
    ['sub2apiReliability=1', '用量账单', '只有累计数', '该时间段暂无用量'],
    ['fail=dashboard', '用量账单', '花费趋势获取失败', '该时间段暂无用量'],
    ['fail=usage', '用量账单', '调用明细暂时无法获取', '该时间段暂无调用'],
    ['sub2apiReliability=1&fail=subscriptions', '充值订阅', '订阅信息暂时无法获取', '暂无订阅'],
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
      // 调用信息和 Token 数平铺成一张（v4），计费单独一节「计费明细」。
      const summary = await dialog.innerText()
      assert.match(summary, /xingmang-desktop-codex[\s\S]*GPT-中转\/订阅，倍率 1×[\s\S]*16 秒[\s\S]*4\.8 秒[\s\S]*xhigh/)
      assert.match(summary, /输入 Token\s*368,531[\s\S]*输出 Token\s*311[\s\S]*缓存读取\s*368,000/)
      const billing = dialog.locator('section[aria-label="计费明细"]')
      for (const expected of ['动态计费', 'long', '368,531 Token × $25 / 百万', '311 Token × $75 / 百万', '$2/M', '1×', '$0.7726']) assert.ok((await billing.innerText()).includes(expected), expected)
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
      assert.equal(await usageRow(page).evaluate((element) => document.activeElement === element), true)
    } finally { await page.close() }
  }
})

test('usage details retain ordinary cache prices and distinguish missing prices from confirmed zero charges', async () => {
  for (const kind of ['legacy', 'missing', 'unknown-tier', 'sub2', 'sub2-missing', 'stream-error']) {
    const page = await fixture(`page=account&usageDetail=${kind}`)
    try {
      const dialog = await openUsageDetails(page)
      const billing = dialog.locator('section[aria-label="计费明细"]')
      const text = await dialog.innerText()
      if (kind === 'legacy') {
        // 输入、输出的单价写在下面那两行里：「N Token × $3 / 百万」。
        assert.match(await billing.innerText(), /按 Token 计费[\s\S]*\$0\.3\/M[\s\S]*用户专属倍率\s*0\.5×[\s\S]*输入\s*[\d,]+ Token × \$3 \/ 百万[\s\S]*输出\s*[\d,]+ Token × \$15 \/ 百万/)
        assert.match(text, /缓存写入（5 分钟）\s*1,000[\s\S]*缓存写入（1 小时）\s*500/)
        assert.equal(await dialog.getByRole('table').count(), 0)
      } else if (kind === 'missing' || kind === 'unknown-tier') {
        assert.doesNotMatch(await billing.innerText(), /\$25 \/ 百万|\$75 \/ 百万/)
        assert.match(await billing.innerText(), /\$0\.7726/)
        assert.match(text, /此记录未提供单价，以上方总费用为准。/)
        assert.equal(await dialog.locator('.is-matched').count(), 0)
        if (kind === 'missing') assert.doesNotMatch(text, /未提供 秒/)
      } else if (kind === 'sub2') {
        assert.match(await billing.innerText(), /订阅额度[\s\S]*0\.5×[\s\S]*已触发[\s\S]*\$0\.7360[\s\S]*\$0\.0000[\s\S]*\$0\.7726[\s\S]*输入[\s\S]*\$0\.013275[\s\S]*输出[\s\S]*\$0\.023325[\s\S]*合计\s*\$0\.3863/)
        assert.equal(await dialog.getByRole('table').count(), 0)
        assert.doesNotMatch(await billing.innerText(), /\/M|百万/)
      } else if (kind === 'sub2-missing') {
        assert.match(await billing.innerText(), /合计\s*未提供/)
        assert.doesNotMatch(await billing.innerText(), /\$0\.0000|\$0\.7726/)
      } else {
        assert.match(text, /流式响应详情[\s\S]*upstream_error[\s\S]*连接中断[\s\S]*请稍后重试/)
        assert.equal(await dialog.locator('script').count(), 0)
        assert.equal(await page.evaluate(() => window.usageXss), undefined)
      }
    } finally { await page.close() }
  }
})

// 后台给的名字撑没撑出外框：里面那块的左右两边都得落在外框里（留 1px 给小数取整）。
async function staysInside(inner, outer) {
  const [a, b] = await Promise.all([inner.boundingBox(), outer.boundingBox()])
  return a.x >= b.x - 1 && a.x + a.width <= b.x + b.width + 1
}

test('names the server sends too long to break stay inside their card, cut short with the full name on hover', async () => {
  const page = await fixture('page=account&usageDetail=tiered&longNames')
  try {
    const cutShort = (locator) => locator.evaluate((element) => element.scrollWidth > element.clientWidth)
    // 密钥行：分组牌放不下就换到标题下面一行，最宽一整行，再长才省略（#1133 第 7 条）。
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    const row = page.getByTestId('account-key-row-1')
    const group = row.locator('.xm-row-title .xm-pill > span').first()
    await group.waitFor()
    assert.equal(await staysInside(group, row.locator('.xm-row-main')), true)
    assert.match(await group.getAttribute('title'), /^default-SuperLong\w+XYZ$/)

    // 充值：支付方式名只占一行，悬停整张卡看全名。
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const option = page.locator('.v2-recharge-pay-option').first()
    await option.waitFor()
    const name = option.locator('.v2-recharge-pay-copy strong')
    assert.equal(await staysInside(name, option), true)
    assert.equal(await cutShort(name), true)
    assert.match(await option.getAttribute('title'), /^Stripe-SuperLong\w+XYZ$/)

    // 调用详情：状态牌照常，模型名牌缩到弹窗放得下。
    const dialog = await openUsageDetails(page)
    const model = dialog.locator('.v2-usage-detail-summary .xm-pill > span')
    assert.equal(await staysInside(model, dialog.locator('.v2-usage-detail-summary')), true)
    assert.equal(await cutShort(model), true)
    assert.match(await model.getAttribute('title'), /^gpt-SuperLong\w+XYZ$/)
    assert.equal(await cutShort(dialog.locator('.v2-usage-detail-summary .xm-pill').first()), false)
  } finally { await page.close() }
})

test('account exposes the six v4 tabs and keeps server orders and keys visible', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '账号概览', exact: true }).waitFor()
    assert.deepEqual(await page.getByRole('tab').allTextContents(), [
      '账号概览',
      '充值订阅',
      '用量账单',
      '密钥管理',
      '账号安全',
      '邀请返利',
    ])
    assert.deepEqual(await page.getByRole('tablist').evaluateAll((lists) => lists.map((list) => list.getAttribute('aria-label'))), ['个人中心分区'])
    // 「我的订单」并进充值订阅，排在充值下面。
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const orders = page.getByTestId('account-orders-section')
    await orders.getByText('TEST-ORDER').waitFor()
    await orders.getByText('已到账', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    const row = page.getByTestId('account-key-row-1')
    await row.locator('.xm-row-title', { hasText: 'Test key' }).waitFor()
    await row.getByRole('button', { name: '复制密钥', exact: true }).click()
    await waitForToast(page, '已复制「Test key」的密钥，1 分钟后从剪贴板清除')
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'copy-key').args,
      1,
    )
  } finally {
    await page.close()
  }
})

test('the orders head asks the main process to open the invoice window without naming a site or account', async () => {
  // 两个账号登录开票中心用的名字不同：星芒账号是用户名，历史账号是邮箱。开哪一个由主进程按当前账号定，
  // 界面这一下不带地址、不带账号。
  for (const [route, loginName] of [
    ['page=account', '用户名'],
    ['page=account&sub2apiReliability=1', '邮箱'],
  ]) {
    const page = await fixture(route)
    try {
      await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
      const orders = page.getByTestId('account-orders-section')
      await orders.getByRole('button', { name: '开发票', exact: true }).click()
      await waitForToast(page, `开票中心已在新窗口打开。如需登录，请使用当前账号的${loginName}和密码。`)
      assert.deepEqual(
        (await calls(page)).filter((call) => call.name === 'open-invoice-portal').map((call) => call.args),
        [[]],
      )
      assert.equal(await orders.getByRole('alert').count(), 0)
    } finally {
      await page.close()
    }
  }
})

test('the invoice button says the approved line when the invoice window does not open', async () => {
  const page = await fixture('page=account&invoiceFail=1')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const orders = page.getByTestId('account-orders-section')
    await orders.getByRole('button', { name: '开发票', exact: true }).click()
    await orders.getByRole('alert').filter({ hasText: '开票中心打开失败，请稍后重试；如仍无法打开，请联系客服。' }).waitFor()
    // 订单照常列着：打不开开票中心不影响看订单。
    await orders.getByText('TEST-ORDER').waitFor()
  } finally {
    await page.close()
  }
})

test('order search drops surrounding spaces and asks the server once after typing stops', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const orders = page.getByTestId('account-orders-section')
    await orders.getByText('TEST-ORDER').waitFor()
    const queries = async () => (await calls(page)).filter((call) => call.name === 'query-orders').map((call) => call.args)
    const before = (await queries()).length
    const search = orders.getByRole('searchbox', { name: '搜索订单号', exact: true })
    // 中文输入法下按空格出的是全角空格：只有空白当没填，不拿去查（F4）。
    await search.fill('　 ')
    // 一个字一个字地敲：停手以后只按去掉首尾空白的词查一次，不是每个字查一次。
    await search.pressSequentially('XM-42 ')
    await page.waitForFunction(
      () => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'query-orders' && call.args.keyword === 'XM-42'),
    )
    assert.deepEqual((await queries()).slice(before), [{ page: 1, pageSize: 20, keyword: 'XM-42' }])
    assert.equal(await search.inputValue(), '　 XM-42 ')
    // 清空马上回到全部订单。
    await search.fill('')
    await page.waitForFunction(
      (count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'query-orders').length > count,
      before + 1,
    )
    assert.deepEqual((await queries()).at(-1), { page: 1, pageSize: 20, keyword: '' })
  } finally {
    await page.close()
  }
})

test('the account tabs move with the left and right arrow keys and open on Enter', async () => {
  const page = await fixture('page=account')
  try {
    const first = page.getByRole('tab', { name: '账号概览', exact: true })
    const recharge = page.getByRole('tab', { name: '充值订阅', exact: true })
    const last = page.getByRole('tab', { name: '邀请返利', exact: true })
    const focused = (tab) => tab.evaluate((element) => element === document.activeElement)
    await first.waitFor()
    await first.focus()
    // 手动激活：方向键只挪焦点，回车才打开，挪过的页签不会被读一遍。
    await page.keyboard.press('ArrowRight')
    assert.equal(await focused(recharge), true)
    assert.equal(await recharge.getAttribute('aria-selected'), 'false')
    await page.keyboard.press('End')
    assert.equal(await focused(last), true)
    await page.keyboard.press('ArrowRight')
    assert.equal(await focused(first), true)
    await page.keyboard.press('ArrowLeft')
    assert.equal(await focused(last), true)
    await page.keyboard.press('Home')
    await page.keyboard.press('ArrowRight')
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
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.getByTestId('account-orders-section').getByText('TEST-ORDER').waitFor()
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
    await page.getByRole('tab', { name: '用量账单', exact: true }).click()
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
    assert.match(await failure.innerText(), /当前账号资料获取失败[\s\S]*账号资料服务暂时不可用/)
    await failure.getByRole('button', { name: '联系客服', exact: true }).click()
    assert.equal((await calls(page)).some((call) => call.name === 'open-help'), true)
    await page.getByText('当前账号资料获取失败', { exact: true }).first().waitFor()
    // 页头那句也直说没读到，不拿站点名或别的话顶上。
    assert.equal(await page.locator('.v2-acct-hero p').innerText(), '当前账号资料获取失败')
    assert.equal(await page.getByRole('tab').count(), 6)
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.getByRole('button', { name: '到账 $10，实付 10.00', exact: true }).waitFor()
    await page.getByTestId('account-orders-section').getByText('TEST-ORDER').waitFor()
    // 账号安全什么都不等，照常能进。
    await page.getByRole('tab', { name: '账号安全', exact: true }).click()
    await page.getByTestId('account-security-password').waitFor()
    await page.getByRole('tab', { name: '账号概览', exact: true }).click()
    const reads = (await calls(page)).filter((call) => call.name === 'get-profile').length
    await failure.getByTestId('account-read-retry').click()
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-profile').length > count, reads)
  } finally {
    await page.close()
  }
})

test('account lists that could not be read say so with the reason and read again on request', async () => {
  for (const [query, tab, title, reason, absent] of [
    ['fail=orders', '充值订阅', '订单暂时无法获取', '订单服务暂时不可用', '暂无订单'],
    ['fail=tasks', '用量账单', '生成任务暂时无法获取', '任务服务暂时不可用', '暂无生成任务'],
    ['fail=usage', '用量账单', '调用明细暂时无法获取', '调用记录服务暂时不可用', '该时间段暂无调用'],
    ['fail=devices', '账号安全', '登录设备暂时无法获取', '设备服务暂时不可用', '正在读取登录设备…'],
  ]) {
    const page = await fixture(`page=account&${query}`)
    try {
      await page.getByRole('tab', { name: tab, exact: true }).click()
      const panel = page.getByRole('tabpanel').filter({ visible: true })
      // 生成任务和调用明细同一处，两段切换（v4）。
      if (query === 'fail=tasks') await panel.getByRole('button', { name: '生成任务', exact: true }).click()
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

test('the usage and task filters fold behind one button on the toolbar and count what was applied', async () => {
  const page = await fixture('page=account&system=1&taskTransition=1')
  try {
    await page.getByRole('tab', { name: '用量账单', exact: true }).click()
    const usage = page.getByTestId('account-usage-section')
    const toggle = usage.getByTestId('account-filters-toggle')
    await toggle.waitFor()
    for (const label of ['开始时间', '结束时间', '模型名称', '分组', '日志类型', '密钥名称', '请求 ID', '上游请求 ID']) {
      assert.equal(await usage.getByLabel(label, { exact: true }).count(), 0, `${label} 先收着`)
    }
    assert.equal(await usage.getByRole('button', { name: '重置筛选', exact: true }).count(), 0)
    // 一共不到 10 条：「每页多少条」不出。
    assert.equal(await usage.getByLabel('每页日志数量', { exact: true }).count(), 0)
    // 「展开筛选」和「调用明细 | 生成任务」在同一行。
    const switchBox = await usage.getByRole('button', { name: '调用明细', exact: true }).boundingBox()
    const toggleBox = await toggle.boundingBox()
    assert.ok(switchBox && toggleBox && Math.abs(switchBox.y + switchBox.height / 2 - (toggleBox.y + toggleBox.height / 2)) <= 4)
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    for (const label of ['开始时间', '结束时间', '模型名称']) await usage.getByLabel(label, { exact: true }).waitFor()
    await usage.getByLabel('上游请求 ID', { exact: true }).fill('up-1')
    await usage.getByRole('button', { name: '查询', exact: true }).click()
    await usage.getByRole('button', { name: '重置筛选', exact: true }).waitFor()
    await toggle.click()
    assert.equal(await toggle.innerText(), '展开筛选 · 1')
    assert.match(await page.getByTestId('usage-stats').innerText(), /总花费[\s\S]*请求次数[\s\S]*处理字数/)
    // 切到生成任务：焦点跟到新露出来那组按钮上，筛选框各管各的，也收着。
    await usage.getByRole('button', { name: '生成任务', exact: true }).click()
    const tasks = page.getByTestId('account-tasks-section')
    const taskSwitch = tasks.getByRole('button', { name: '生成任务', exact: true })
    await taskSwitch.waitFor()
    assert.equal(await usage.isHidden(), true)
    assert.equal(await taskSwitch.getAttribute('aria-pressed'), 'true')
    assert.equal(await taskSwitch.evaluate((element) => document.activeElement === element), true)
    const taskToggle = tasks.getByTestId('account-filters-toggle')
    assert.equal(await taskToggle.innerText(), '展开筛选')
    await taskToggle.click()
    for (const label of ['开始时间', '结束时间', '状态', '平台', '任务 ID', '动作']) await tasks.getByLabel(label, { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('the price table is a third view of the usage page, read only when first opened, with a retry when it cannot be read', async () => {
  for (const query of ['page=account', 'page=account&fail=prices']) {
    const page = await fixture(query)
    try {
      await page.getByRole('tab', { name: '用量账单', exact: true }).click()
      const usage = page.getByTestId('account-usage-section')
      await usage.getByRole('button', { name: '价格表', exact: true }).waitFor()
      assert.equal((await calls(page)).some((call) => call.name === 'get-price-list'), false, 'nothing is read before the view opens')
      await usage.getByRole('button', { name: '价格表', exact: true }).click()
      const prices = page.getByTestId('account-prices-section')
      await prices.getByRole('button', { name: '价格表', exact: true }).waitFor()
      assert.equal(await prices.getByRole('button', { name: '价格表', exact: true }).getAttribute('aria-pressed'), 'true')
      if (query.includes('fail')) {
        await prices.getByText('价格表暂时无法获取，请稍后重试，不影响使用。').waitFor()
        await prices.getByTestId('account-prices-retry').click()
        await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-price-list').length === 2)
        await prices.getByText('价格表暂时无法获取，请稍后重试，不影响使用。').waitFor()
        continue
      }
      const table = prices.getByTestId('account-prices-table')
      await table.locator('tbody tr').first().waitFor()
      assert.deepEqual(await table.locator('thead th').allInnerTexts(), ['模型', '分组', '输入', '输出'])
      assert.deepEqual(await table.locator('tbody tr').evaluateAll((rows) => rows.map((row) => [...row.cells].map((cell) => cell.innerText))), [
        ['gpt-image-2', '图片模型', '$0.06 / 次', '—'],
        ['claude-tiered', 'Claude', '分档计价', '—'],
        ['gpt-5.6-sol', 'GPT', '$1.25', '$10.00'],
      ])
      await prices.getByText('价格表 · 美元 / 每百万 Token').waitFor()
      assert.equal(await prices.getByTestId('account-prices-note').innerText(), '已经算上分组的倍数。实际扣多少以用量账单为准。分档计价的模型，可在调用明细中展开对应记录查看各档价格。')
      // Switching away and back keeps what was read.
      await prices.getByRole('button', { name: '调用明细', exact: true }).click()
      await usage.getByRole('button', { name: '价格表', exact: true }).click()
      await table.locator('tbody tr').first().waitFor()
      assert.equal((await calls(page)).filter((call) => call.name === 'get-price-list').length, 1)
    } finally {
      await page.close()
    }
  }
  // A history account has no per-model price list, so the view is not offered.
  const legacy = await fixture('page=account&sub2apiReliability')
  try {
    await legacy.getByRole('tab', { name: '用量账单', exact: true }).click()
    await legacy.getByTestId('account-usage-section').waitFor()
    assert.equal(await legacy.getByRole('button', { name: '价格表', exact: true }).count(), 0)
    assert.equal(await legacy.getByTestId('account-prices-section').count(), 0)
  } finally {
    await legacy.close()
  }
})

test('recharge stays open when subscriptions fail and says when the top-up details could not be read', async () => {
  const page = await fixture('page=account&fail=subscriptions')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    await panel.getByRole('button', { name: '到账 $10，实付 10.00', exact: true }).waitFor()
    assert.equal(await panel.getByTestId('account-recharge-submit').isDisabled(), false)
    await panel.getByText('订阅信息暂时无法获取', { exact: true }).waitFor()
    await panel.getByTestId('account-subscriptions-retry').waitFor()
    assert.equal(await panel.getByTestId('account-recharge-plans').count(), 0)
    assert.equal(await panel.getByRole('group', { name: '扣费顺序' }).count(), 0)
    assert.equal(await panel.getByText('未完成', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
  const failed = await fixture('page=account&fail=topup&help=1')
  try {
    await failed.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const card = failed.getByTestId('account-recharge-error')
    await card.waitFor()
    assert.match(await card.innerText(), /充值信息加载失败[\s\S]*充值服务暂时不可用/)
    await card.getByRole('button', { name: '联系客服', exact: true }).waitFor()
    assert.equal(await failed.getByRole('button', { name: /^到账/ }).count(), 0)
    // 订阅那边读得到，照样摆着。
    await failed.getByLabel('充值订阅').getByText('暂无订阅', { exact: true }).waitFor()
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
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const notice = page.getByTestId('account-recharge-no-methods')
    await notice.waitFor()
    assert.match(await notice.innerText(), /暂时没有可用的支付渠道[\s\S]*请稍后重试或联系客服。如有充值码，可点击「有充值码？」兑换。/)
    await notice.getByRole('button', { name: '联系客服', exact: true }).waitFor()
    // 提示在卡片最上面，档位在它下面。
    const noticeBox = await notice.boundingBox()
    const tier = page.getByRole('button', { name: '到账 $10', exact: true })
    const tierBox = await tier.boundingBox()
    assert.ok(noticeBox && tierBox && noticeBox.y + noticeBox.height <= tierBox.y)
    assert.equal(await tier.isDisabled(), true)
    assert.equal(await page.getByLabel('自定义金额').isDisabled(), true)
    assert.equal(await page.getByTestId('account-recharge-submit').isDisabled(), true)
    assert.equal(await page.getByRole('radiogroup', { name: '支付方式' }).count(), 0)
    // 兑换充值码是「本次充值」下面的文字链，点开是一个弹窗。
    await page.getByTestId('account-recharge-redeem-open').click()
    const dialog = page.getByRole('dialog', { name: '兑换充值码' })
    await dialog.waitFor()
    await dialog.getByLabel('充值码').fill('CODE-1')
    assert.equal(await dialog.getByTestId('account-redeem').isDisabled(), false)
  } finally {
    await page.close()
  }
})

test('login devices say which device each button signs out', async () => {
  const page = await fixture('page=account&otherDevice=1')
  try {
    await page.getByRole('tab', { name: '账号安全', exact: true }).click()
    const devices = page.getByTestId('account-security-devices')
    const others = page.getByTestId('account-security-devices-others')
    await others.waitFor()
    assert.equal(await others.innerText(), '下线其他设备')
    // 这台电脑只标「当前设备」；退出登录在账号概览那条「当前登录」上。
    await devices.getByText('当前设备', { exact: true }).waitFor()
    assert.equal(await devices.getByRole('button', { name: '退出登录', exact: true }).count(), 0)
    await devices.getByRole('button', { name: '下线此设备', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: /^是否下线「.+」？$/ })
    await dialog.getByRole('button', { name: '下线', exact: true }).waitFor()
    await dialog.getByText('该设备需重新登录才能查看账号信息，其上已配置的工具可正常使用。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await others.click()
    dialog = page.getByRole('dialog', { name: '是否下线所有其他设备？', exact: true })
    await dialog.getByRole('button', { name: '全部下线', exact: true }).waitFor()
    await dialog.getByText('除本机外，其他设备需重新登录才能查看账号信息，其上已配置的工具可正常使用。', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('the overview keeps switching and signing out on the current-login bar and edits the name in a dialog', async () => {
  const page = await fixture('page=account')
  try {
    const bar = page.getByTestId('account-overview-session')
    await bar.waitFor()
    // 保存的账号只在「切换账号」框里列，概览不再摆那张卡。
    assert.equal(await page.getByTestId('saved-accounts-list').count(), 0)
    assert.equal(await page.getByText('同步到工具', { exact: true }).count(), 0)
    await bar.getByTestId('account-switch').click()
    assert.equal((await calls(page)).some((call) => call.name === 'open-account-switcher'), true)
    await bar.getByTestId('account-overview-logout').click()
    const logout = page.getByRole('dialog', { name: '退出登录？', exact: true })
    await logout.getByText('已配置的工具将保留。', { exact: true }).waitFor()
    await logout.getByRole('button', { name: '取消', exact: true }).click()
    // 显示名称在页头铅笔打开的「编辑资料」里：没改过「保存」点不了，改了才亮。
    await page.getByTestId('account-profile-edit').click()
    const dialog = page.getByTestId('account-profile-dialog')
    const save = dialog.getByTestId('account-display-save')
    assert.equal(await dialog.getByTestId('account-display').inputValue(), '本地测试')
    assert.equal(await save.isDisabled(), true)
    await dialog.getByTestId('account-display').fill('新的名字')
    assert.equal(await save.isDisabled(), false)
    await save.click()
    await waitForToast(page, '资料已保存')
    await page.locator('.v2-acct-hero h1', { hasText: /^新的名字$/ }).waitFor()
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'update-display-name').map((call) => call.args), [{ displayName: '新的名字' }])
  } finally {
    await page.close()
  }
})

test('the invite page leads with the code, copies the whole link and moves rebates from the results card', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '邀请返利', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    await panel.getByTestId('account-invite-code-card').waitFor()
    assert.deepEqual(await panel.locator('.v2-acct-card h2').allTextContents(), ['我的邀请码', '邀请成绩'])
    assert.equal(await panel.getByTestId('account-invite-code').innerText(), 'TEST')
    // 页面上只摆邀请码，不出站点地址；复制出去的是完整链接。
    assert.equal(await panel.getByText(/https?:\/\//).count(), 0)
    await panel.getByTestId('account-invite-link').click()
    await waitForToast(page, '邀请链接已复制')
    const copied = (await calls(page)).filter((call) => call.name === 'copy-clipboard').at(-1).args
    assert.match(copied, /^https:\/\/[^/]+\/register\?aff=TEST$/)
    // 星芒账号的后台不给邀请名单，「邀请记录」整节不出。
    assert.equal(await panel.getByTestId('account-invite-records').count(), 0)
    await panel.getByTestId('account-invite-transfer').click()
    await page.getByRole('dialog', { name: '是否将 $1.00 返利转入余额？', exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('the transfer dialog starts from what is transferable now, also after part of it was moved', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '邀请返利', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const transferable = panel.locator('.v2-acct-kv').filter({ hasText: '可转入余额' })
    const transfer = panel.getByTestId('account-invite-transfer')
    const dialog = page.getByRole('dialog', { name: /返利转入余额？$/ })
    const amount = dialog.getByLabel('转入金额（美元）', { exact: true })
    await transfer.click()
    await dialog.waitFor()
    assert.equal(await amount.inputValue(), '1')
    await amount.fill('0.4')
    // 余额 F8-1：只转一部分时标题写这次要转的数，不再写全部可转的 $1.00。
    await page.getByRole('dialog', { name: '是否将 $0.40 返利转入余额？', exact: true }).waitFor()
    await amount.fill('')
    await page.getByRole('dialog', { name: '是否将 $1.00 返利转入余额？', exact: true }).waitFor()
    await amount.fill('0.4')
    await page.getByRole('dialog', { name: '是否将 $0.40 返利转入余额？', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '转入余额', exact: true }).click()
    await waitForToast(page, '$0.40 已转入余额')
    await dialog.waitFor({ state: 'hidden' })
    await transferable.getByText('$0.60', { exact: true }).waitFor()
    await transfer.click()
    await page.getByRole('dialog', { name: '是否将 $0.60 返利转入余额？', exact: true }).waitFor()
    assert.equal(await amount.inputValue(), '0.6')
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'transfer-affiliate-quota').map((call) => call.args), [{ quota: 40 }])
  } finally {
    await page.close()
  }
})

test('a historical account moves a rebate with cents in one go, at the exact amount', async () => {
  // 余额 F4：以前 $3.456 被四舍五入成 3 发出去，后台要全额，怎么点都报错。
  const page = await fixture('page=account&sub2apiReliability=1&fractionalRebate=1')
  try {
    await page.getByRole('tab', { name: '邀请返利', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const transfer = panel.getByTestId('account-invite-transfer')
    await transfer.click()
    const dialog = page.getByRole('dialog', { name: '是否将 $3.46 返利转入余额？', exact: true })
    await dialog.waitFor()
    const amount = dialog.getByLabel('转入金额（美元）', { exact: true })
    assert.equal(await amount.inputValue(), '3.456')
    assert.equal(await amount.isEditable(), false)
    await dialog.getByRole('button', { name: '转入余额', exact: true }).click()
    await waitForToast(page, '$3.46 已转入余额')
    await dialog.waitFor({ state: 'hidden' })
    await transfer.getByText('已全部转入', { exact: true }).waitFor()
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'transfer-affiliate-quota').map((call) => call.args), [{ quota: 3.456 }])
  } finally {
    await page.close()
  }
})

test('the empty transfer button tells a drained rebate from one never earned', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '邀请返利', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const transfer = panel.getByTestId('account-invite-transfer')
    await transfer.click()
    const dialog = page.getByRole('dialog', { name: '是否将 $1.00 返利转入余额？', exact: true })
    await dialog.getByRole('button', { name: '转入余额', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await transfer.getByText('已全部转入', { exact: true }).waitFor()
    assert.equal(await transfer.isDisabled(), true)
  } finally {
    await page.close()
  }
  const fresh = await fixture('page=account&noRebate=1')
  try {
    await fresh.getByRole('tab', { name: '邀请返利', exact: true }).click()
    const transfer = fresh.getByRole('tabpanel').filter({ visible: true }).getByTestId('account-invite-transfer')
    // 从来没赚过时写「已全部转入」像是转过了（W44）。
    await transfer.getByText('暂无返利', { exact: true }).waitFor()
    assert.equal(await transfer.isDisabled(), true)
  } finally {
    await fresh.close()
  }
})

test('subscription rows name each state in Chinese instead of the value the server sent', async () => {
  const page = await fixture('page=account&subscriptionStates=1')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const state = (title) => panel.locator('.xm-row-title').filter({ hasText: title }).locator('.xm-pill')
    await state('月卡一号').waitFor()
    assert.equal(await state('月卡一号').innerText(), '生效中')
    assert.equal(await state('月卡二号').innerText(), '已到期')
    assert.equal(await state('月卡三号').innerText(), '已撤销')
    assert.equal(await state('月卡四号').innerText(), '已停用')
    assert.equal(await state('月卡五号').innerText(), '待确认')
  } finally {
    await page.close()
  }
})

test('tool key limits list only the tools that have a key and name the ones still missing', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    const card = page.getByTestId('tool-key-limits')
    await card.getByTestId('tool-key-limit-claude').waitFor()
    assert.deepEqual(
      await card.locator('[data-testid^="tool-key-limit-"]:not([data-testid*="-input-"]):not([data-testid*="-save-"])').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-testid'))),
      ['tool-key-limit-claude', 'tool-key-limit-codex'],
    )
    assert.equal(await page.getByTestId('tool-key-limits-missing').innerText(), 'Grok CLI 尚未配置，配置后将显示在此处。')
  } finally {
    await page.close()
  }
  const none = await fixture('page=account')
  try {
    await none.getByRole('tab', { name: '密钥管理', exact: true }).click()
    const line = none.getByTestId('tool-key-limits')
    await line.waitFor()
    assert.equal(await line.innerText(), '工具配置完成后，可在此为每个工具设置额度上限。')
  } finally {
    await none.close()
  }
})

test('tool key limits that could not be read can be read again without leaving the page', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    // 概览数密钥把数也按 100 一页读，等它读完再让下一次失败，失败的才是这张卡。
    await page.locator('.v2-acct-kv').filter({ hasText: '2 个' }).waitFor()
    await page.evaluate(() => window.failNextRead('toolKeyLimits'))
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    const card = page.getByTestId('tool-key-limits')
    const alert = card.getByRole('alert')
    await alert.getByText('密钥服务暂时不可用').waitFor()
    assert.equal(await card.getByTestId('tool-key-limit-claude').count(), 0)
    await alert.getByRole('button', { name: '重新加载', exact: true }).click()
    await card.getByTestId('tool-key-limit-claude').waitFor()
    await card.getByTestId('tool-key-limit-codex').waitFor()
    assert.equal(await card.getByRole('alert').count(), 0)
  } finally {
    await page.close()
  }
  // 读到过「一个工具都没配」、页头刷新又没读到：不能还收成那行灰字，把红条和「重新加载」藏掉。
  const none = await fixture('page=account')
  try {
    await none.getByRole('tab', { name: '密钥管理', exact: true }).click()
    const card = none.getByTestId('tool-key-limits')
    const emptyLine = none.locator('.v2-business-key-limits-empty')
    await emptyLine.waitFor()
    await none.evaluate(() => window.failNextRead('toolKeyLimits'))
    await none.getByTestId('account-refresh').click()
    const alert = card.getByRole('alert')
    await alert.getByText('密钥服务暂时不可用').waitFor()
    assert.equal(await emptyLine.count(), 0)
    await alert.getByRole('button', { name: '重新加载', exact: true }).click()
    await emptyLine.waitFor()
    assert.equal(await emptyLine.innerText(), '工具配置完成后，可在此为每个工具设置额度上限。')
    assert.equal(await card.getByRole('alert').count(), 0)
  } finally {
    await none.close()
  }
})

test('a half-typed tool key limit is refused instead of being saved as no limit', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    const card = page.getByTestId('tool-key-limits')
    const field = card.getByTestId('tool-key-limit-input-claude')
    const save = card.getByTestId('tool-key-limit-save-claude')
    const refused = card.getByRole('alert').getByText('请填写大于 0 的上限金额，留空表示不限额度。', { exact: true })
    await field.waitFor()
    // 「1e」「-」这种半截数，数字框交出来的值是空的，跟留空一样；不能当成不限额存下去（表单 F10-b）。
    // 「-」是先清空再打的：从空到「-」值没变，框的 onChange 根本不来。
    for (const typed of ['1e', '-']) {
      await field.fill('')
      await field.pressSequentially(typed)
      assert.equal(await field.inputValue(), '')
      await save.click()
      await refused.waitFor()
      await assertNoToast(page, '额度上限已保存')
      // 两轮红条是同一句，第二轮光看红条分不出来，所以每轮都核对保存一次也没发出去。
      assert.equal((await calls(page)).filter((call) => call.name === 'updateAccountKey').length, 0)
    }
    // 真留空照旧是不限额：保存发出去，而且前面两次一次都没发。
    await field.fill('')
    await save.click()
    await waitForToast(page, '额度上限已保存')
    const updates = (await calls(page)).filter((call) => call.name === 'updateAccountKey')
    assert.equal(updates.length, 1)
    assert.equal(updates[0].args.unlimitedQuota, true)
  } finally {
    await page.close()
  }
})

// F01：「每个工具的额度上限」和下面的密钥列表各读各的，两边的保存都是整条覆盖。
const keyUpdates = async (page) => (await calls(page)).filter((call) => call.name === 'updateAccountKey').map((call) => call.args)
async function openKeyEditor(page, name) {
  await page.getByRole('button', { name: `密钥 ${name} 的更多操作`, exact: true }).click()
  await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `编辑「${name}」`, exact: true })
  await dialog.getByLabel('名称', { exact: true }).waitFor()
  return dialog
}

test('renaming a key in the list keeps the cap just set for its tool', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['default', 'GPT', 'Claude-MAX']))
    const card = page.getByTestId('tool-key-limits')
    await card.getByTestId('tool-key-limit-input-codex').fill('5')
    await card.getByTestId('tool-key-limit-save-codex').click()
    await waitForToast(page, '额度上限已保存')
    // 列表跟着重读：Codex 那一行也写着刚设的上限，不再是「不限额度」。
    await page.getByTestId('account-key-row-12').getByText('剩余 $5.00', { exact: true }).waitFor()
    const dialog = await openKeyEditor(page, 'xingmang-desktop-codex')
    await dialog.getByLabel('名称', { exact: true }).fill('我的 Codex')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await waitForToast(page, '已保存「我的 Codex」')
    const updates = await keyUpdates(page)
    assert.equal(updates.length, 2)
    assert.deepEqual(updates[1], { id: 12, name: '我的 Codex', group: 'GPT', remainQuota: 500, unlimitedQuota: false, expiredTime: -1 })
    await page.getByTestId('account-key-row-12').getByText('剩余 $5.00', { exact: true }).waitFor()
  } finally { await page.close() }
})

test('a key editor opened before the cap changed elsewhere does not put the old one back', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['default', 'GPT', 'Claude-MAX']))
    await page.getByTestId('account-key-row-12').waitFor()
    const dialog = await openKeyEditor(page, 'xingmang-desktop-codex')
    // 编辑框开着的时候，别处给这把设了 $7 上限和到期日；框里还是「不限额度」「不改」。
    const expiredAt = '2027-03-01T00:00:00.000Z'
    await page.evaluate((at) => window.changeKeyElsewhere(12, { unlimitedQuota: false, remainQuota: 700, expiredAt: at }), expiredAt)
    await dialog.getByLabel('名称', { exact: true }).fill('我的 Codex')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await waitForToast(page, '已保存「我的 Codex」')
    const expiredTime = Date.parse(expiredAt) / 1000
    assert.deepEqual((await keyUpdates(page)).at(-1), { id: 12, name: '我的 Codex', group: 'GPT', remainQuota: 700, unlimitedQuota: false, expiredTime })
    // 客户自己点了「不限额度」的照旧放开，到期日不动。
    const again = await openKeyEditor(page, '我的 Codex')
    await again.getByTestId('account-key-quota-mode').getByRole('button', { name: '不限额度', exact: true }).click()
    await again.getByRole('button', { name: '保存', exact: true }).click()
    await waitForToast(page, '已保存「我的 Codex」')
    assert.deepEqual((await keyUpdates(page)).at(-1), { id: 12, name: '我的 Codex', group: 'GPT', remainQuota: 0, unlimitedQuota: true, expiredTime })
  } finally { await page.close() }
})

test('saving a tool cap keeps what the list or another device just changed on that key', async () => {
  const page = await fixture('page=account&managedKeys=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['default', 'GPT', 'Claude-MAX']))
    const row = page.getByTestId('tool-key-limits').getByTestId('tool-key-limit-claude')
    await row.getByText(/上限剩余 \$12\.00/).waitFor()
    // 在列表里把 Claude 那把的额度改成 $20：上面的卡片跟着重读。
    const dialog = await openKeyEditor(page, 'xingmang-desktop-claude')
    await dialog.getByLabel('可用额度', { exact: true }).fill('20')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await waitForToast(page, '已保存「xingmang-desktop-claude」')
    await row.getByText(/上限剩余 \$20\.00/).waitFor()
    // 卡片读完以后，别处又改了这把的名字和到期日；卡片上还是旧的。
    const expiredAt = '2027-03-01T00:00:00.000Z'
    await page.evaluate((at) => window.changeKeyElsewhere(11, { name: 'renamed-claude', expiredAt: at }), expiredAt)
    await row.getByTestId('tool-key-limit-input-claude').fill('9')
    await row.getByTestId('tool-key-limit-save-claude').click()
    await waitForToast(page, '额度上限已保存')
    assert.deepEqual((await keyUpdates(page)).at(-1), {
      id: 11, name: 'renamed-claude', group: 'Claude-MAX', remainQuota: 900, unlimitedQuota: false, expiredTime: Date.parse(expiredAt) / 1000,
    })
  } finally { await page.close() }
})

test('a profile read once stays on screen when a later refresh cannot read it', async () => {
  const page = await fixture('page=account')
  try {
    const name = page.locator('.v2-acct-hero h1')
    await name.filter({ hasText: /^本地测试$/ }).waitFor()
    await page.evaluate(() => window.failNextRead('profile'))
    await page.getByTestId('account-refresh').click()
    const alert = page.getByRole('tabpanel').filter({ visible: true }).getByRole('alert')
    await alert.getByText('账号资料服务暂时不可用').waitFor()
    // 手上那份资料留着：不整页换成「暂未获取」，页头的名字和邮箱也还在。
    assert.equal(await page.getByTestId('account-read-error').count(), 0)
    assert.equal(await name.innerText(), '本地测试')
    assert.match(await page.locator('.v2-acct-hero p').innerText(), /^test@example\.invalid · /)
    await page.getByTestId('account-profile-edit').click()
    const dialog = page.getByTestId('account-profile-dialog')
    assert.equal(await dialog.getByTestId('account-display').inputValue(), '本地测试')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await alert.getByRole('button', { name: '重新加载', exact: true }).click()
    await alert.waitFor({ state: 'detached' })
  } finally {
    await page.close()
  }
})

test('a slow profile read that lands after a newer one is not what a later failed refresh falls back to', async () => {
  const page = await fixture('page=account')
  try {
    const name = page.locator('.v2-acct-hero h1')
    await name.filter({ hasText: /^本地测试$/ }).waitFor()
    // 先点「刷新」，这次读得慢；还没回来就把显示名称改了存上，存完那次读得快。
    await page.evaluate(() => window.profileReadHarness.deferNext())
    await page.getByTestId('account-refresh').click()
    await page.getByTestId('account-profile-edit').click()
    const dialog = page.getByTestId('account-profile-dialog')
    await dialog.getByTestId('account-display').fill('新名字')
    await dialog.getByTestId('account-display-save').click()
    await dialog.waitFor({ state: 'detached' })
    await name.filter({ hasText: /^新名字$/ }).waitFor()
    // 慢的那次这时才回来，带的还是改名前的资料。
    await page.evaluate(() => window.profileReadHarness.release())
    await page.waitForTimeout(100)
    await page.evaluate(() => window.failNextRead('profile'))
    await page.getByTestId('account-refresh').click()
    const alert = page.getByRole('tabpanel').filter({ visible: true }).getByRole('alert')
    await alert.getByText('账号资料服务暂时不可用').waitFor()
    assert.equal(await name.innerText(), '新名字')
    await page.getByTestId('account-profile-edit').click()
    assert.equal(await page.getByTestId('account-profile-dialog').getByTestId('account-display').inputValue(), '新名字')
  } finally {
    await page.close()
  }
})

test('a subscription re-read that fails says so instead of still showing no subscriptions', async () => {
  const page = await fixture('page=account&accountTab=recharge&subscriptionExternal=1')
  try {
    const panel = page.getByRole('tabpanel').filter({ visible: true })
    const choose = panel.getByTestId('account-recharge-plans')
    await panel.getByText('暂无订阅', { exact: true }).waitFor()
    assert.equal(await choose.count(), 1)
    await page.evaluate(() => window.failNextRead('subscriptions'))
    await page.getByTestId('account-refresh').click()
    await panel.getByTestId('account-subscriptions-error').getByText('订阅信息暂时无法获取').waitFor()
    assert.equal(await panel.getByText('暂无订阅', { exact: true }).count(), 0)
    assert.equal(await choose.count(), 0)
    // 充值那张卡不受影响。
    assert.equal(await panel.getByTestId('account-recharge-submit').count(), 1)
    await panel.getByTestId('account-subscriptions-retry').click()
    await panel.getByText('暂无订阅', { exact: true }).waitFor()
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
  for (const [type, message] of [['subscription', '订阅兑换成功'], ['concurrency', '并发额度兑换成功'], ['balance', '兑换成功，$0.05 已到账']]) {
    const page = await fixture(`page=account&redemptionType=${type}`)
    try {
      await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
      await page.getByTestId('account-recharge-redeem-open').click()
      const dialog = page.getByRole('dialog', { name: '兑换充值码' })
      await dialog.waitFor()
      // 空着点「兑换」不发请求，框下面说要填。
      await dialog.getByTestId('account-redeem').click()
      await dialog.getByText('请输入充值码', { exact: true }).waitFor()
      await dialog.getByLabel('充值码', { exact: true }).fill('MOCK-CARD')
      const before = await calls(page)
      await dialog.getByTestId('account-redeem').click()
      await waitForToast(page, message)
      await page.waitForFunction((previous) => {
        const current = JSON.parse(document.documentElement.dataset.calls || '[]')
        return ['get-profile', 'get-balance', 'get-subscriptions'].every((name) =>
          current.filter((call) => call.name === name).length > previous.filter((call) => call.name === name).length)
      }, before)
      assert.equal((await calls(page)).filter((call) => call.name === 'redeem-code').length, 1)
      await dialog.waitFor({ state: 'hidden' })
      // 再打开时框是空的。
      await page.getByTestId('account-recharge-redeem-open').click()
      assert.equal(await page.getByRole('dialog', { name: '兑换充值码' }).getByLabel('充值码', { exact: true }).inputValue(), '')
    } finally { await page.close() }
  }
})

async function revokeTestKey(page) {
  await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
  await page.getByRole('button', { name: '密钥 Test key 的更多操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '撤销密钥', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '撤销「Test key」？', exact: true })
  await dialog.waitFor()
  return dialog
}

// 分组每次打开编辑框、点到分组、窗口回到前台都会重读；同一下手势里的几次合成一次（500 毫秒内）。
// 只把夹具的钟往后拨过那一段，再让窗口回到前台，就是一次不带错误的重读。
async function rereadKeyGroups(page) {
  const before = await page.evaluate(() => {
    const previousNow = Date.now
    Date.now = () => previousNow() + 1000
    const requests = window.keyGroupsHarness.requests
    window.dispatchEvent(new Event('focus'))
    return requests
  })
  await page.waitForFunction((count) => window.keyGroupsHarness.requests > count, before)
}

function keyGroupChoice(page, name) {
  return page.getByTestId('account-key-group-choices').getByRole('button', { name, exact: true })
}

test('revoking a key a tool is using warns first and puts a fresh key back without asking again', async () => {
  const page = await fixture('page=account&keyInUse=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByTestId('account-key-in-use-1').getByText('Claude Code 在用').waitFor()
    const dialog = await revokeTestKey(page)
    assert.match(await dialog.innerText(), /撤销后该密钥将立即失效且无法恢复。[\s\S]*Claude Code 正在使用该密钥，将立即写入新密钥，不影响使用。/)
    await dialog.getByRole('button', { name: '撤销', exact: true }).click()
    await waitForToast(page, '已撤销「Test key」，Claude Code 已更换为新密钥')
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
    await dialog.getByRole('button', { name: '撤销', exact: true }).click()
    const notice = page.getByTestId('account-key-replace-failed')
    await notice.getByText('Claude Code 暂时无法使用', { exact: true }).waitFor()
    await page.getByTestId('account-key-replace-retry').click()
    await page.getByText('Claude Code 仍未更换为新密钥，请检查网络后重试。', { exact: true }).waitFor()
    await page.getByTestId('account-key-replace-retry').click()
    await waitForToast(page, 'Claude Code 已更换为新密钥')
    assert.equal(await notice.count(), 0)
    assert.equal((await calls(page)).filter((call) => call.name === 'rewriteKey').length, 3)
  } finally { await page.close() }
})

test('revoking a key a hand-configured tool is using never claims a fresh key and points at its settings', async () => {
  const page = await fixture('page=account&keyInUse=1&replaceSkipped=1')
  try {
    const dialog = await revokeTestKey(page)
    await dialog.getByRole('button', { name: '撤销', exact: true }).click()
    const notice = page.getByTestId('account-key-replace-skipped')
    await notice.getByText('Claude Code 仍在使用已撤销的密钥', { exact: true }).waitFor()
    await waitForToast(page, '已撤销「Test key」')
    assert.equal(await page.getByText(/已更换为新密钥/).count(), 0)
    assert.equal(await page.getByTestId('account-key-replace-retry').count(), 0)
    await page.getByTestId('account-key-replace-configure').click()
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'openConfig').map((call) => call.args), ['claude'])
    // 只是打开了设置窗口，用户可能取消或保存失败：警告不能跟着消失（#546）。
    assert.equal(await notice.count(), 1)
    // 别的工具存好了也不算。
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-tool-config-confirmed', { detail: 'grok' })))
    assert.equal(await notice.count(), 1)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('test-tool-config-confirmed', { detail: 'claude' })))
    await notice.waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('revoking the only key on the last page steps back to a real page instead of showing 2 / 1', async () => {
  const page = await fixture('page=account&keyCount=21')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByRole('button', { name: '密钥 paged-key-1 的更多操作', exact: true }).waitFor()
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await page.getByRole('button', { name: '密钥 paged-key-21 的更多操作', exact: true }).waitFor()
    await page.getByText('2 / 2', { exact: true }).waitFor()
    await page.getByRole('button', { name: '密钥 paged-key-21 的更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '撤销密钥', exact: true }).click()
    await page.getByRole('dialog', { name: '撤销「paged-key-21」？', exact: true }).getByRole('button', { name: '撤销', exact: true }).click()
    await page.getByRole('button', { name: '密钥 paged-key-1 的更多操作', exact: true }).waitFor()
    assert.equal(await page.getByText('2 / 1', { exact: true }).count(), 0)
    // 只剩一页，分页条整个不摆。
    await page.locator('.v2-business-pagination').waitFor({ state: 'detached' })
  } finally { await page.close() }
})

// 切到别的页签时账号概览藏着不卸：在「密钥管理」里撤销一把再回到概览，「密钥与设备」那张卡上的把数要跟着变。
test('the overview key count catches up after a key is revoked on the key tab', async () => {
  const page = await fixture('page=account&keyCount=21')
  try {
    const card = page.getByTestId('account-overview-security')
    await card.getByText('21 个', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByRole('button', { name: '密钥 paged-key-1 的更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '撤销密钥', exact: true }).click()
    await page.getByRole('dialog', { name: '撤销「paged-key-1」？', exact: true }).getByRole('button', { name: '撤销', exact: true }).click()
    await waitForToast(page, '已撤销「paged-key-1」')
    await page.getByRole('tab', { name: '账号概览', exact: true }).click()
    await card.getByText('20 个', { exact: true }).waitFor()
  } finally { await page.close() }
})

test('key search finds a key that lives on a later page and starts from the first page of matches', async () => {
  const page = await fixture('page=account&keyCount=45')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
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

test('a stopped key offers 启用 on its own row and turns back on when it is pressed (Q2)', async () => {
  const page = await fixture('page=account&stoppedKeys=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    const disabled = page.getByTestId('account-key-row-21')
    await disabled.getByText('已停用', { exact: true }).waitFor()
    // 正常那把不摆「启用」。
    assert.equal(await page.getByTestId('account-key-enable-1').count(), 0)
    const enable = page.getByRole('button', { name: '启用密钥 disabled-key', exact: true })
    assert.equal(await enable.innerText(), '启用')
    await enable.click()
    await waitForToast(page, '已启用「disabled-key」')
    await page.getByTestId('account-key-enable-21').waitFor({ state: 'detached' })
    assert.equal(await disabled.getByText('已停用', { exact: true }).count(), 0)
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'enableAccountKey').map((call) => call.args), [21])
  } finally { await page.close() }
})

test('enabling a key past its expiry says to change the expiry first and keeps the button', async () => {
  const page = await fixture('page=account&stoppedKeys=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByRole('button', { name: '启用密钥 expired-key', exact: true }).click()
    await page.getByText('该密钥已过到期时间。请先点击该行右侧的「⋯」，选择「编辑」延后到期时间，再点击「启用」。', { exact: true }).waitFor()
    await page.getByTestId('account-key-row-22').getByText('已过期', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('account-key-enable-22').isEnabled(), true)
  } finally { await page.close() }
})

test('a 历史账号 key list never offers 启用, since that backend cannot turn keys back on here', async () => {
  const page = await fixture('page=account&stoppedKeys=1&sub2apiReliability=1')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByTestId('account-key-row-21').getByText('已停用', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^启用密钥/ }).count(), 0)
  } finally { await page.close() }
})

test('revoking a key no tool is using only says it cannot be undone and never rewrites a tool', async () => {
  const page = await fixture('page=account')
  try {
    const dialog = await revokeTestKey(page)
    assert.equal((await dialog.locator('p').allInnerTexts()).join('\n'), '撤销后该密钥将立即失效且无法恢复。')
    await dialog.getByRole('button', { name: '撤销', exact: true }).click()
    await waitForToast(page, '已撤销「Test key」')
    assert.equal((await calls(page)).some((call) => call.name === 'rewriteKey'), false)
  } finally { await page.close() }
})

// 撤销一发出去就收不回：执行中「取消」、×、Esc 都关不掉弹窗，免得看着像取消了、过几秒又弹「已撤销」（#1099 第 2 条）。
test('the revoke dialog stays open and cannot be cancelled while the revoke is running', async () => {
  const page = await fixture('page=account&keyInUse=1&revokeHold=1')
  try {
    const dialog = await revokeTestKey(page)
    const cancel = dialog.getByRole('button', { name: '取消', exact: true })
    const close = dialog.getByRole('button', { name: '关闭', exact: true })
    assert.equal(await cancel.isDisabled(), false)
    assert.equal(await close.isDisabled(), false)
    await dialog.getByRole('button', { name: '撤销', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'revokeAccountKey'))
    assert.equal(await cancel.isDisabled(), true)
    assert.equal(await close.isDisabled(), true)
    await dialog.focus()
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    assert.equal(await dialog.isVisible(), true)
    await page.evaluate(() => window.releaseRevoke())
    await waitForToast(page, '已撤销「Test key」，Claude Code 已更换为新密钥')
    await dialog.waitFor({ state: 'hidden' })
    assert.equal((await calls(page)).filter((call) => call.name === 'revokeAccountKey').length, 1)
  } finally { await page.close() }
})

test('key editor re-reads available groups every time a new or existing key is opened', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByTestId('account-key-row-1').waitFor()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-A']))
    await page.getByTestId('account-key-add').click()
    const editor = page.getByTestId('account-key-editor')
    // 分组不多时摆成分段，读到的第一个先选好。
    await keyGroupChoice(page, 'group-A').and(page.locator('[aria-pressed="true"]')).waitFor()
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-B']))
    await page.getByTestId('account-key-add').click()
    await keyGroupChoice(page, 'group-B').and(page.locator('[aria-pressed="true"]')).waitFor()
    assert.equal(await keyGroupChoice(page, 'group-A').count(), 0)
    const beforeOpen = await page.evaluate(() => {
      window.keyGroupsHarness.setGroups(['group-B', 'group-D'])
      // Move only the fixture clock beyond the focus/pointer coalescing window.
      const previousNow = Date.now
      Date.now = () => previousNow() + 1000
      return window.keyGroupsHarness.requests
    })
    // 点到分组那一下也重读一次。
    await keyGroupChoice(page, 'group-B').click()
    await page.waitForFunction((before) => window.keyGroupsHarness.requests > before, beforeOpen)
    await keyGroupChoice(page, 'group-D').waitFor()
    assert.equal(await keyGroupChoice(page, 'group-B').getAttribute('aria-pressed'), 'true')
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['default', 'group-C']))
    await page.getByRole('button', { name: '密钥 Test key 的更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '编辑', exact: true }).click()
    await page.getByRole('dialog', { name: '编辑「Test key」', exact: true }).waitFor()
    await keyGroupChoice(page, 'group-C').waitFor()
    assert.equal(await keyGroupChoice(page, 'default').getAttribute('aria-pressed'), 'true')
    assert.equal(await editor.getByLabel('名称', { exact: true }).inputValue(), 'Test key')
  } finally { await page.close() }
})

test('refreshing key groups preserves the draft and requires a new choice when the selected group disappears', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByTestId('account-key-row-1').waitFor()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-A', 'group-B']))
    await page.getByTestId('account-key-add').click()
    const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true })
    await keyGroupChoice(page, 'group-B').click()
    await dialog.getByLabel('名称', { exact: true }).fill('draft key')
    await dialog.getByLabel('可用额度', { exact: true }).fill('12.34')
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-B', 'group-C']))
    await rereadKeyGroups(page)
    await keyGroupChoice(page, 'group-C').waitFor()
    assert.equal(await keyGroupChoice(page, 'group-B').getAttribute('aria-pressed'), 'true')
    assert.equal(await dialog.getByLabel('名称', { exact: true }).inputValue(), 'draft key')
    assert.equal(await dialog.getByLabel('可用额度', { exact: true }).inputValue(), '12.34')
    // 选中的分组没了：换成下拉，把它标成「已不可用」，不替用户换成别的分组。
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-C']))
    await rereadKeyGroups(page)
    const group = page.getByTestId('account-key-group')
    await group.locator('option[value="group-B"]', { hasText: 'group-B（已不可用）' }).waitFor({ state: 'attached' })
    await dialog.getByText('原分组已不可用，请重新选择；已填写的内容仍保留。', { exact: true }).waitFor()
    const save = dialog.getByRole('button', { name: '创建密钥', exact: true })
    assert.equal(await save.isDisabled(), true)
    assert.equal(await group.inputValue(), 'group-B')
    assert.equal((await calls(page)).filter((call) => call.name === 'create-key').length, 0)
    await group.selectOption('group-C')
    await save.click()
    const created = page.getByTestId('account-key-created')
    await created.getByText('「draft key」已创建', { exact: true }).waitFor()
    await created.getByText('如需在工具中使用，请在列表中点击「配置到工具」。', { exact: true }).waitFor()
    const args = (await calls(page)).find((call) => call.name === 'create-key').args
    assert.deepEqual({ name: args.name, group: args.group, remainQuota: args.remainQuota }, { name: 'draft key', group: 'group-C', remainQuota: 1234 })
    await page.getByTestId('account-key-created-done').click()
    await dialog.waitFor({ state: 'detached' })
  } finally { await page.close() }
})

// 站点按 UTF-8 字节数限名称 50，一个汉字 3 个字节：中文名字打到 16 个字就打不进去，跟英文打满 50 个字母一样，
// 不再等点了保存才被站点拒（ZW-1）。
test('a Chinese key name stops at 16 characters, the 50 bytes the server counts, instead of being refused on save', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByTestId('account-key-row-1').waitFor()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-A']))
    await page.getByTestId('account-key-add').click()
    const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true })
    await keyGroupChoice(page, 'group-A').and(page.locator('[aria-pressed="true"]')).waitFor()
    const name = dialog.getByLabel('名称', { exact: true })
    await name.fill('星芒'.repeat(9))
    assert.equal(await name.inputValue(), '星芒'.repeat(8))
    await name.press('End')
    await page.keyboard.type('abc')
    assert.equal(await name.inputValue(), `${'星芒'.repeat(8)}ab`)
    // A character typed into the middle of a full name is refused and the caret stays put.
    await name.press('Home')
    await name.press('ArrowRight')
    await page.keyboard.type('x')
    assert.equal(await name.inputValue(), `${'星芒'.repeat(8)}ab`)
    await page.waitForFunction(() => document.activeElement instanceof HTMLInputElement && document.activeElement.selectionStart === 1)
    // Pinyin still being composed does not count; the characters picked are cut to what fits.
    await name.fill('星'.repeat(15))
    await name.press('End')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: 'xingmang', selectionStart: 8, selectionEnd: 8 })
    assert.equal(await name.inputValue(), `${'星'.repeat(15)}xingmang`)
    await cdp.send('Input.insertText', { text: '星芒' })
    await page.waitForFunction(() => document.activeElement instanceof HTMLInputElement && document.activeElement.value.length === 16)
    assert.equal(await name.inputValue(), '星'.repeat(16))
    await dialog.getByRole('button', { name: '创建密钥', exact: true }).click()
    await page.getByTestId('account-key-created').waitFor()
    const args = (await calls(page)).find((call) => call.name === 'create-key').args
    assert.equal(args.name, '星'.repeat(16))
  } finally { await page.close() }
})

test('pending or failed key group requests block saves and can be retried without clearing inputs', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByTestId('account-key-row-1').waitFor()
    await page.evaluate(() => { window.keyGroupsHarness.setGroups(['group-A']); window.keyGroupsHarness.deferNext() })
    await page.getByTestId('account-key-add').click()
    const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true })
    const save = dialog.getByRole('button', { name: '创建密钥', exact: true })
    await dialog.getByLabel('名称', { exact: true }).fill('keep pending draft')
    await dialog.getByLabel('可用额度', { exact: true }).fill('3.25')
    assert.equal(await save.isDisabled(), true)
    assert.equal((await calls(page)).filter((call) => call.name === 'create-key').length, 0)
    await page.evaluate(() => window.keyGroupsHarness.release())
    await keyGroupChoice(page, 'group-A').and(page.locator('[aria-pressed="true"]')).waitFor()
    // 「刷新分组」只在读失败时出现。
    assert.equal(await page.getByTestId('account-key-groups-refresh').count(), 0)
    await page.evaluate(() => window.keyGroupsHarness.failNext())
    await rereadKeyGroups(page)
    await dialog.getByText('分组读取暂时失败，请重试', { exact: true }).waitFor()
    assert.equal(await save.isDisabled(), true)
    assert.equal(await dialog.getByLabel('名称', { exact: true }).inputValue(), 'keep pending draft')
    assert.equal(await dialog.getByLabel('可用额度', { exact: true }).inputValue(), '3.25')
    assert.equal((await calls(page)).filter((call) => call.name === 'create-key').length, 0)
    await page.getByTestId('account-key-groups-refresh').click()
    await page.getByTestId('account-key-groups-refresh').waitFor({ state: 'detached' })
    await save.click()
    await page.getByTestId('account-key-created').waitFor()
    assert.equal((await calls(page)).filter((call) => call.name === 'create-key').length, 1)
    await page.getByTestId('account-key-created-done').click()
    await page.evaluate(() => { window.keyGroupsHarness.setGroups(['outdated-group']); window.keyGroupsHarness.deferNext() })
    await page.getByTestId('account-key-add').click()
    assert.equal(await save.isDisabled(), true)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['fresh-group']))
    await page.getByTestId('account-key-add').click()
    await keyGroupChoice(page, 'fresh-group').and(page.locator('[aria-pressed="true"]')).waitFor()
    await page.evaluate(async () => {
      window.keyGroupsHarness.release()
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    assert.equal(await keyGroupChoice(page, 'fresh-group').getAttribute('aria-pressed'), 'true')
    assert.equal(await keyGroupChoice(page, 'outdated-group').count(), 0)
  } finally { await page.close() }
})

test('key group failures name the real cause instead of one generic refresh prompt', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '密钥管理', exact: true }).click()
    await page.getByTestId('account-key-row-1').waitFor()
    await page.evaluate(() => window.keyGroupsHarness.setGroups(['group-A']))
    await page.getByTestId('account-key-add').click()
    const dialog = page.getByRole('dialog', { name: '新建密钥', exact: true })
    const save = dialog.getByRole('button', { name: '创建密钥', exact: true })
    await keyGroupChoice(page, 'group-A').and(page.locator('[aria-pressed="true"]')).waitFor()

    // 会话过期：主进程抛的是中文原文，脱敏后原样上屏，用户知道该去重新登录
    await page.evaluate(() => window.keyGroupsHarness.failNext(
      "Error invoking remote method 'account:list-groups': Error: 登录状态已失效，请重新登录",
    ))
    await rereadKeyGroups(page)
    await dialog.getByText('登录状态已失效，请重新登录', { exact: true }).waitFor()
    assert.equal(await save.isDisabled(), true)
    assert.equal(await dialog.getByText('分组读取失败，请刷新后重试。', { exact: true }).count(), 0)

    // 限流：服务端回英文原文，映射成「稍等几秒」，而不是让用户反复点刷新
    await page.evaluate(() => window.keyGroupsHarness.failNext('list groups failed: 429 Too Many Requests'))
    await page.getByTestId('account-key-groups-refresh').click()
    await dialog.getByText('请求次数过多，请稍候几秒后重试。', { exact: true }).waitFor()
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
    await page.getByTestId('account-key-groups-refresh').waitFor({ state: 'detached' })
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
    await waitForToast(page, '已打开Codex CLI，继续 C:/test-project 中最近的一条对话')
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
      '该记录的文件夹已不存在，无法继续上次的对话',
    )
    // v4：文件夹那一格挂着警告图标，悬停说一句，路径照旧显示。
    await page.getByTestId('sessions-missing-codex:session-1').waitFor()
    assert.equal(
      await page.getByTestId('sessions-missing-codex:session-1').getAttribute('title'),
      '该文件夹已不存在',
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
    // 气泡前面有一句只给读屏的「你：」，按包含来找。
    await drawer.getByText('这是一条测试消息').waitFor()
  } finally {
    await page.close()
  }
})

test('session detail shows what each AI turn ran and changed, folded to names only', async () => {
  const page = await fixture('page=sessions&turnActivity=1')
  try {
    await page.getByTestId('sessions-view-codex:session-1').click()
    const drawer = page.getByTestId('session-detail-drawer')
    const line = drawer.getByTestId('session-detail-turn-activity')
    await line.getByText('本轮：运行了 3 条命令，修改了 2 个文件，有 1 步未成功', { exact: true }).waitFor()
    assert.equal(await line.getByText('sum.ts、sum.test.ts', { exact: true }).isVisible(), false)
    await line.getByText('本轮：运行了 3 条命令，修改了 2 个文件，有 1 步未成功', { exact: true }).click()
    await line.getByText('sum.ts、sum.test.ts', { exact: true }).waitFor()
    await line.getByText('npm、git', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('sessions search can also look through what was said, after the typing settles', async () => {
  const page = await fixture('page=sessions')
  try {
    await page.getByTestId('sessions-row-codex:session-1').waitFor()
    await page.getByTestId('sessions-search').fill('没说过')
    assert.equal((await calls(page)).some((call) => call.name === 'list-sessions-content'), false)
    await page.getByText('同时搜索对话内容', { exact: true }).click()
    assert.equal(await page.getByTestId('sessions-search-content').isChecked(), true)
    await page.getByText('最近的对话中未找到「没说过」', { exact: true }).waitFor()
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'list-sessions-content').map((call) => call.args),
      [{ search: '没说过', searchContent: true }],
    )
    // 打字时先不翻：一口气敲完只发停手后的那个词。
    await page.getByTestId('sessions-search').fill('测试')
    await page.getByTestId('sessions-search-content-status').getByText('正在搜索对话内容…', { exact: true }).waitFor()
    await page.getByTestId('sessions-row-codex:session-1').waitFor()
    await page.getByTestId('sessions-search-content-status').waitFor({ state: 'detached' })
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'list-sessions-content').map((call) => call.args.search),
      ['没说过', '测试'],
    )
  } finally {
    await page.close()
  }
})

const callsNamed = async (page, name) =>
  (await calls(page)).filter((call) => call.name === name)

// 0.2.25 精选、外接工具、技能、插件合成一页「插件」以后，原来四页上的这些用例搬到新页上测同一件事；
// 新页自己的几条在文件后面（const hub 那一段）。只装 Claude Code 的那几条不读 Codex，免得一进页就替用户下载
// GPT 官方插件目录、多出几次读列表，数调用数时对不上。
const hubClaudeOnly = 'page=extensions&installedProviders=claude'
const hubAllTools = 'page=extensions&installedProviders=claude,codex,grok'

// 点左边「已安装」里的一条，打开它的详情。
async function openInstalled(page, name) {
  await page.getByTestId('hub-installed').getByRole('button', { name: new RegExp(name) }).click()
  const detail = page.getByTestId('hub-detail')
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText(name)
  return detail
}

// 装了 Codex 时「插件」页一进来就替用户下载 GPT 官方插件目录（夹具里一开始没下载），下载那一阵别的操作都不接；
// 等目录里那条搜得出来、「添加」能点了再往下。
async function hubCatalogReady(page) {
  await page.getByTestId('hub-search').fill('Game Studio')
  await page.getByTestId('hub-row-plugin-game-studio-openai-api-curated').waitFor()
  await page.getByTestId('hub-search').fill('')
  await expect(page.getByTestId('hub-add')).toBeEnabled()
}

// 右上角「添加」里的一项：mcp（自定义连接）、plugin（添加插件）、market（添加插件市场）、skill（从文件夹导入）。
async function openHubAdd(page, item) {
  await page.getByTestId('hub-add').click()
  await page.getByTestId(`hub-add-${item}`).click()
}

test('a switch in the details keeps its state when the change fails and sends the listed scope back', async () => {
  const page = await fixture(hubClaudeOnly)
  try {
    const detail = await openInstalled(page, '测试连接')
    // 开关的名字说的是点下去会怎样（v4 批12）。
    const control = detail.getByRole('switch', { name: '停用 测试连接', exact: true })
    await control.click()
    await page.getByText('扩展操作失败，已有配置保留').first().waitFor()
    assert.equal(await control.getAttribute('aria-checked'), 'true')
    // 列表给出的层要原样带回去，否则项目里的那份会被当成全局的去改（#488）。
    assert.deepEqual((await callsNamed(page, 'extension')).at(-1).args, {
      provider: 'claude', kind: 'mcp', action: 'disable', id: 'test-extension', scope: 'user',
    })
  } finally {
    await page.close()
  }
})

// Codex 没有插件启停命令：开关走它自己的接口改 config.toml，通用的扩展改动对 Codex 插件只认装和卸。
test('a Codex plugin switch goes through the Codex plugin interface and names the plugin in the toast', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex&extensionOk')
  try {
    await hubCatalogReady(page)
    const detail = await openInstalled(page, 'Sentry')
    await detail.getByRole('switch', { name: '停用 Sentry', exact: true }).click()
    await waitForToast(page, '已停用「Sentry」')
    assert.deepEqual((await callsNamed(page, 'toggle-plugin')).map((call) => call.args), [['sentry@openai-api-curated', false]])
    assert.equal((await callsNamed(page, 'extension')).length, 0)
  } finally {
    await page.close()
  }
})

test('waiting for a connection to be authorized in the browser can be cancelled without a failure banner', async () => {
  const page = await fixture('page=extensions&installedProviders=codex&mcpAuth')
  try {
    await hubCatalogReady(page)
    const detail = await openInstalled(page, '测试连接')
    const row = detail.getByTestId('hub-where-codex')
    await expect(row).toContainText('需要登录授权')
    await row.getByTestId('hub-auth-codex').click()
    await row.getByText('等待在浏览器中授权', { exact: true }).waitFor()
    // 等授权时整页别的按钮都灰着；这颗「取消」是唯一能停下来的地方，读屏要说清停的是哪一条。
    const cancel = row.getByRole('button', { name: '停止等待 测试连接 授权', exact: true })
    assert.equal(await cancel.textContent(), '取消')
    await cancel.click()
    await row.getByText('正在停止', { exact: true }).waitFor()
    await waitForToast(page, '已取消，测试连接 尚未授权')
    await row.getByText('登录授权', { exact: true }).waitFor()
    assert.equal(await cancel.count(), 0)
    assert.equal(await row.getByTestId('hub-auth-codex').isEnabled(), true)
    // 取消是正常结束：不弹红条，也不说「已授权」。
    assert.equal(await page.getByText('未完成', { exact: false }).count(), 0)
    assert.equal(
      await page.evaluate(() => window.__v2Toasts.entries.some((entry) => entry.text === '测试连接 已授权')),
      false,
    )
    const recorded = await calls(page)
    assert.deepEqual(recorded.filter((call) => call.name === 'mcp-login').map((call) => call.args), ['test-extension'])
    assert.deepEqual(recorded.filter((call) => call.name === 'mcp-cancel-login').map((call) => call.args), ['test-extension'])
  } finally {
    await page.close()
  }
})

// 第五部分第 25、28 条：每条连接各说各的检测结果，工具给的原因一起上屏；检测未完成直说；不后台轮询，
// 「重新加载」先重读列表再检测。
test('a connection shows its own checked answer with the reason, and 重新加载 reads the list again before checking', async () => {
  const page = await fixture(`${hubClaudeOnly}&mcpHealthFail`)
  try {
    let detail = await openInstalled(page, '测试连接')
    await expect(detail.getByTestId('hub-where-claude')).toContainText('未检测')
    await detail.getByText('连接检测没有跑完', { exact: true }).waitFor()
    assert.equal((await callsNamed(page, 'mcp-health')).length, 1)
    const reads = (await callsNamed(page, 'list-extensions')).length
    await detail.getByTestId('hub-back').click()
    await page.getByTestId('hub-reload').click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'mcp-health').length === 2)
    detail = await openInstalled(page, '测试连接')
    // 「连不上」本身不够用，工具给出的那句原因必须一起上屏。
    await expect(detail.getByTestId('hub-where-claude')).toContainText('无法连接')
    await detail.getByText('启动失败：找不到 uvx', { exact: true }).waitFor()
    const names = (await calls(page)).map((call) => call.name)
    assert.equal(names.filter((name) => name === 'list-extensions').length, reads + 1)
    assert.ok(names.lastIndexOf('list-extensions') < names.lastIndexOf('mcp-health'), '先重读列表，再检测连接')
  } finally {
    await page.close()
  }
})

test('adding a uvx connection without Python says so first and still lets it through', async () => {
  const page = await fixture(hubClaudeOnly)
  try {
    await openHubAdd(page, 'mcp')
    await page.getByRole('button', { name: '本地程序', exact: true }).click()
    await page.getByTestId('mcp-source').fill('uvx')
    const notice = page.getByTestId('mcp-runtime-notice')
    await notice.waitFor()
    await notice.getByText(/未找到 uv/).waitFor()
    // 提示只是提示：它不该把「添加」按下去的路堵死。
    await notice.getByText(/仍可直接添加/).waitFor()
    await notice.getByTestId('mcp-install-python').click()
    await page.getByText('测试环境不装 Python').first().waitFor()
    // npx 型的命令不该被这条提示牵连。
    await page.getByTestId('mcp-source').fill('npx')
    await notice.waitFor({ state: 'detached' })
  } finally {
    await page.close()
  }
})

// D20：缺 uv 不再叫客户去命令行敲 pip，交给客服教，并给一颗「联系客服」。
test('a uvx connection missing uv points to customer support with a button instead of a pip command', async () => {
  const page = await fixture(`${hubClaudeOnly}&help`)
  try {
    await openHubAdd(page, 'mcp')
    await page.getByRole('button', { name: '本地程序', exact: true }).click()
    await page.getByTestId('mcp-source').fill('uvx')
    const notice = page.getByTestId('mcp-runtime-notice')
    await notice.getByText(/该工具还需安装 uv 组件，请点击「联系客服」获取安装指导。/).waitFor()
    assert.equal(await notice.getByText(/pip install uv/).count(), 0)
    await notice.getByTestId('mcp-runtime-support').click()
    assert.equal((await callsNamed(page, 'open-help')).length, 1)
  } finally {
    await page.close()
  }
})

test('installing a recommended connection shows the exact command and writes nothing before 安装', async () => {
  const page = await fixture(hubClaudeOnly)
  try {
    await page.getByTestId('hub-add-mcp-sequential-thinking').click()
    const dialog = page.getByRole('dialog', { name: '安装「逐步思考」', exact: true })
    // 安装框必须原样给出将要执行的命令和那句免责说明，用户才知道自己在同意什么。
    await dialog.getByText('npx -y @modelcontextprotocol/server-sequential-thinking@2026.8.31', { exact: true }).waitFor()
    await dialog.getByText(/第三方软件/).first().waitFor()
    assert.equal((await callsNamed(page, 'extension')).length, 0)
    await dialog.getByTestId('hub-install-submit').click()
    await dialog.getByText('扩展操作失败，已有配置保留').first().waitFor()
    assert.deepEqual((await callsNamed(page, 'extension')).at(-1).args, {
      provider: 'claude',
      kind: 'mcp',
      action: 'install',
      id: 'sequential-thinking',
      scope: 'user',
      mcp: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking@2026.8.31'], env: {} },
    })
  } finally {
    await page.close()
  }
})

test('a recommended Claude plugin lists both commands, says which version lands and installs only into Claude', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex')
  try {
    await hubCatalogReady(page)
    await page.getByTestId('hub-add-plugin-feature-dev-claude-plugins-official').click()
    const dialog = page.getByRole('dialog', { name: '安装「功能开发流程」', exact: true })
    // 装插件要先保证官方市场在册，所以安装框里是两条命令，少列一条就是没说全。
    await dialog.getByText('claude plugin marketplace add anthropics/claude-plugins-official', { exact: true }).waitFor()
    await dialog.getByText('claude plugin install feature-dev@claude-plugins-official', { exact: true }).waitFor()
    // 官方市场装到的是它当下那一份，钉不住版本这件事要在点「安装」之前说出来。
    await dialog.getByText(/将安装官方市场的当前版本/).waitFor()
    await dialog.getByText(/第三方软件/).first().waitFor()
    // 插件各家格式不通用：另两家灰着说为什么。
    await expect(dialog.getByTestId('hub-install-tools-codex')).toBeDisabled()
    await expect(dialog.getByTestId('hub-install-tools-codex')).toContainText('插件各家格式不通用，这一条只有 Claude 版')
    assert.equal((await callsNamed(page, 'extension')).length, 0)
    await dialog.getByTestId('hub-install-submit').click()
    await dialog.getByText('扩展操作失败，已有配置保留').first().waitFor()
    // 精选不另开通道：走的还是「添加插件」那一条出口。
    assert.deepEqual((await callsNamed(page, 'extension')).at(-1).args, {
      provider: 'claude', kind: 'plugin', action: 'install', source: 'feature-dev@claude-plugins-official',
    })
  } finally {
    await page.close()
  }
})

test('a recommended entry that needs a folder asks for it in the same dialog before adding', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex')
  try {
    await hubCatalogReady(page)
    // 本地文件已经装在 Claude 里，「+」装的是 GPT 那一份。
    await page.getByTestId('hub-add-mcp-files').click()
    const dialog = page.getByTestId('hub-install-dialog')
    const submit = dialog.getByTestId('hub-install-submit')
    assert.equal(await submit.innerText(), '继续填写')
    await submit.click()
    const notice = dialog.getByTestId('curated-input-directory')
    await notice.getByText(/点击「选择文件夹」选择后将自动填写，无需手动修改。/).waitFor()
    await notice.getByTestId('curated-choose-directory').waitFor()
    // 占位符没换就提交要当场拦住，而不是写进一条起不来的连接。
    await submit.click()
    await dialog.getByText('{{directory}} 尚未替换为实际内容，请填写后再添加。', { exact: true }).waitFor()
    assert.equal((await callsNamed(page, 'extension')).length, 0)
    assert.equal((await callsNamed(page, 'add-mcp')).length, 0)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByTestId('featured-recommend').click()
    // 「反馈与客服」分两个页签（v4 第 10 批）：想要新的连接落在「留言反馈」。
    assert.deepEqual((await callsNamed(page, 'navigate')).at(-1).args, ['feedback', 'form'])
  } finally {
    await page.close()
  }
})

test('the GPT official catalog downloads by itself on the first visit without an extra success note', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex')
  try {
    await page.getByTestId('hub-search').fill('Game Studio')
    await page.getByTestId('hub-row-plugin-game-studio-openai-api-curated').waitFor()
    await page.waitForTimeout(300)
    assert.equal(await page.getByText('插件目录已下载，下方为可安装的插件。').count(), 0)
    assert.equal((await callsNamed(page, 'ensure-marketplace')).length, 1)
  } finally {
    await page.close()
  }
})

test('when the GPT official catalog fails to download the group says why and offers to try again', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex&codexCatalogOffline')
  try {
    // 第一次按国内常见的样子失败：说清楚原因，留一颗按钮让用户自己再点。
    await page.getByText(/插件目录没有下载下来/).first().waitFor()
    const notice = page.getByTestId('hub-section-codex').getByTestId('hub-codex-marketplace')
    await notice.getByText('官方插件目录尚未下载').waitFor()
    assert.equal((await callsNamed(page, 'ensure-marketplace')).length, 1)
    await notice.getByTestId('hub-codex-marketplace-add').click()
    await notice.waitFor({ state: 'detached' })
    await page.getByTestId('hub-search').fill('Game Studio')
    await page.getByTestId('hub-row-plugin-game-studio-openai-api-curated').getByText('Design and prototype browser games').waitFor()
    await page.getByTestId('hub-add-plugin-game-studio-openai-api-curated').waitFor()
    assert.deepEqual((await callsNamed(page, 'ensure-marketplace')).map((call) => call.args), ['codex', 'codex'])
  } finally {
    await page.close()
  }
})

test('with nothing installed the plugins page says how to add one', async () => {
  const page = await fixture(`${hubClaudeOnly}&empty`)
  try {
    await expect(page.locator('.v2-hub-side-empty')).toHaveText('暂未安装插件')
    // 推荐照样摆着，能直接点「+」装。
    await page.getByTestId('hub-add-mcp-browser').waitFor()
    await page.getByTestId('hub-tab-custom').click()
    await page.getByTestId('hub-custom-empty').getByText('暂无自定义连接。获取服务方提供的连接配置后，请点击右上角「添加」。', { exact: true }).waitFor()
    await page.getByTestId('hub-nav-skills').click()
    await page.getByTestId('hub-skills-empty').getByText('暂未安装技能。获取技能文件夹后，请点击右上角「添加」导入。', { exact: true }).waitFor()
    await expect(page.locator('.v2-hub-side-empty')).toHaveText('暂未安装技能')
  } finally {
    await page.close()
  }
})

// 第五部分第 26 条：弹框标题带上它要做的事，选项上面有小标题。「装到：全部」时添加插件先问装进哪一家。
test('the add menu names what each dialog adds and asks which tool a plugin goes into', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex')
  try {
    await hubCatalogReady(page)
    await openHubAdd(page, 'mcp')
    const dialog = page.getByRole('dialog', { name: '自定义连接', exact: true })
    await dialog.getByText('类型', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '网络服务', exact: true }).waitFor()
    await dialog.getByRole('combobox', { name: '装到哪里', exact: true }).waitFor()
    const tools = dialog.getByRole('group', { name: '给这些工具用', exact: true })
    assert.equal(await tools.getByRole('button', { name: 'Claude Code', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await tools.getByRole('button', { name: 'Codex CLI', exact: true }).getAttribute('aria-pressed'), 'false')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    await openHubAdd(page, 'plugin')
    const chooser = page.getByRole('dialog', { name: '装到哪里', exact: true })
    await expect(chooser.getByTestId('hub-tool-chooser-grok')).toBeDisabled()
    await expect(chooser.getByTestId('hub-tool-chooser-grok')).toContainText('本机尚未安装 Grok CLI')
    await chooser.getByTestId('hub-tool-chooser-codex').click()
    await page.getByRole('dialog', { name: '给 Codex CLI 添加插件', exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

// Grok 装插件不带 --trust 一律被拒；带上以后插件里的命令每次打开 Grok 都会跑，所以先弹框问（yoyo 10-17 定）。
test('a Grok plugin installs with --trust only after the user confirms, and other tools never ask', async () => {
  const page = await fixture(`${hubAllTools}&extensionOk`)
  try {
    await hubCatalogReady(page)
    await openHubAdd(page, 'plugin')
    await page.getByTestId('hub-tool-chooser-grok').click()
    const form = page.getByRole('dialog', { name: '给 Grok CLI 添加插件', exact: true })
    await form.waitFor()
    // Grok 的插件命令没有范围参数，选「当前项目」也装进全局（#1092），所以只给「我的（全局）」。
    assert.deepEqual(await form.getByLabel('添加范围', { exact: true }).locator('option').allTextContents(), ['我的（全局）'])
    await form.getByTestId('plugins-source').fill('owner/repo')
    await form.getByTestId('plugins-form-submit').click()
    const confirm = page.getByRole('dialog', { name: '是否为 Grok CLI 安装此插件？', exact: true })
    await confirm.waitFor()
    await confirm.getByText('插件中的技能、命令和连接在安装后，每次打开 Grok CLI 时都会自动运行，并可像您本人一样读写本机文件。', { exact: true }).waitFor()
    await confirm.getByText('owner/repo', { exact: true }).waitFor()
    await confirm.getByText('请仅安装来源可信的插件；如不确定，请暂不安装。', { exact: true }).waitFor()
    assert.equal((await callsNamed(page, 'extension')).length, 0, '点「添加」只弹框，不装')
    // 先不装：回到表单，填过的来源还在，什么都没装。
    await confirm.getByRole('button', { name: '先不装', exact: true }).click()
    await confirm.waitFor({ state: 'detached' })
    assert.equal(await form.getByTestId('plugins-source').inputValue(), 'owner/repo')
    assert.equal((await callsNamed(page, 'extension')).length, 0)
    await form.getByTestId('plugins-form-submit').click()
    await confirm.getByTestId('plugins-trust-confirm-submit').click()
    await form.waitFor({ state: 'detached' })
    assert.equal(await confirm.count(), 0)
    assert.deepEqual((await callsNamed(page, 'extension')).map((call) => call.args), [
      { provider: 'grok', kind: 'plugin', action: 'install', source: 'owner/repo', scope: 'user', trust: true },
    ])
    // Claude Code 没有这一问，也不带 trust。
    await openHubAdd(page, 'plugin')
    await page.getByTestId('hub-tool-chooser-claude').click()
    const claudeForm = page.getByRole('dialog', { name: '给 Claude Code 添加插件', exact: true })
    assert.deepEqual(await claudeForm.getByLabel('添加范围', { exact: true }).locator('option').allTextContents(), ['我的（全局）', '当前项目'])
    await claudeForm.getByTestId('plugins-source').fill('owner/repo')
    await claudeForm.getByTestId('plugins-form-submit').click()
    await claudeForm.waitFor({ state: 'detached' })
    assert.equal(await page.getByTestId('plugins-trust-confirm').count(), 0)
    assert.deepEqual((await callsNamed(page, 'extension')).at(-1).args, {
      provider: 'claude', kind: 'plugin', action: 'install', source: 'owner/repo', scope: 'user',
    })
  } finally {
    await page.close()
  }
})

// 第五部分第 28 条；10-24 起 Claude Code、Grok CLI 的技能也能从文件夹导入（「扩展改」第 2 条），主进程照 Codex 那套
// 复制进它们自己的技能文件夹，界面走通用的 mutate；Codex 走它自己的导入。合页以后一次导进勾上的几家。
test('a skill folder is imported into every family picked, and 重新加载 reads the lists again', async () => {
  const page = await fixture(`${hubAllTools}&extensionOk`)
  try {
    await hubCatalogReady(page)
    await page.getByTestId('hub-nav-skills').click()
    await openHubAdd(page, 'skill')
    const dialog = page.getByRole('dialog', { name: '从文件夹导入', exact: true })
    assert.deepEqual(await dialog.getByLabel('添加范围', { exact: true }).locator('option').allTextContents(), ['我的（全局）', '当前项目'])
    for (const id of ['claude', 'codex', 'grok'])
      assert.equal(await dialog.getByTestId(`hub-skill-import-tools-${id}`).getAttribute('aria-pressed'), 'true')
    await dialog.getByTestId('hub-skill-import-tools-codex').click()
    await dialog.getByLabel('技能文件夹路径', { exact: true }).fill('/Users/demo/skills/reviewer')
    await dialog.getByTestId('hub-skill-import-submit').click()
    await waitForToast(page, '已添加「reviewer」，给 Claude Code、Grok CLI 使用，下次打开工具时生效')
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual((await callsNamed(page, 'extension')).map((call) => call.args), [
      { provider: 'claude', kind: 'skill', action: 'install', source: '/Users/demo/skills/reviewer', scope: 'user' },
      { provider: 'grok', kind: 'skill', action: 'install', source: '/Users/demo/skills/reviewer', scope: 'user' },
    ])
    assert.equal((await callsNamed(page, 'importSkill')).length, 0)
    const reads = (await callsNamed(page, 'list-extensions')).length
    await page.getByTestId('hub-reload').click()
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls).filter((call) => call.name === 'list-extensions').length > count, reads)
  } finally {
    await page.close()
  }
})

// 第五部分第 31 条：有新版本的，行上「…」里和详情那一家那一行上都给「更新」。
test('an entry with a newer version offers 更新 in its menu and on the tool it is installed in', async () => {
  const page = await fixture(`${hubClaudeOnly}&pluginUpdate`)
  try {
    await page.getByRole('button', { name: '代码审查 更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '更新', exact: true }).click()
    await page.getByText('扩展操作失败，已有配置保留').first().waitFor()
    assert.deepEqual((await callsNamed(page, 'extension')).at(-1).args, {
      provider: 'claude', kind: 'plugin', action: 'update', id: 'code-review@claude-plugins-official', scope: 'user',
    })
    const detail = await openInstalled(page, '代码审查')
    await detail.getByTestId('hub-where-claude').getByRole('button', { name: '更新', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'extension').length === 2)
    assert.equal((await callsNamed(page, 'extension')).at(-1).args.action, 'update')
  } finally {
    await page.close()
  }
})

// 已知2 跟进：仅在当前项目中使用的（local）那一份，详情里写清楚只在当前项目。
test('an entry installed only in this project says so in its details', async () => {
  const page = await fixture(`${hubClaudeOnly}&scopedExtensions`)
  try {
    const detail = await openInstalled(page, '本项目插件')
    await expect(detail.getByTestId('hub-where-claude')).toContainText('仅限当前项目、仅本人可用')
  } finally {
    await page.close()
  }
})

test('removing a connection from one tool says which tool it leaves and that the others keep theirs', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex&extensionOk')
  try {
    await hubCatalogReady(page)
    const detail = await openInstalled(page, '浏览器')
    await detail.getByTestId('hub-where-claude').getByRole('button', { name: 'browser 更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '从 Claude Code 移除…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '从 Claude Code 移除「browser」？', exact: true })
    await dialog.getByText('其他工具中的不受影响。如需使用，可重新安装。', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '移除', exact: true }).click()
    await waitForToast(page, '已从 Claude Code 移除「browser」')
    assert.deepEqual((await callsNamed(page, 'extension')).at(-1).args, { provider: 'claude', kind: 'mcp', action: 'uninstall', id: 'browser', scope: 'user' })
    await expect(detail.getByTestId('hub-where-claude')).toContainText('未安装')
    await expect(detail.getByTestId('hub-where-codex')).toContainText('已安装')
    // 自己加的那条，提醒的是要重新填一遍。
    await detail.getByTestId('hub-back').click()
    const custom = await openInstalled(page, '测试连接')
    await custom.getByTestId('hub-where-claude').getByRole('button', { name: '测试连接 更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '从 Claude Code 移除…', exact: true }).click()
    await page.getByRole('dialog', { name: '从 Claude Code 移除「测试连接」？', exact: true })
      .getByText('其他工具里的不受影响。自己加的要重新填一遍。', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('the remove confirmation waits for another extension change and says why instead of spinning', async () => {
  const page = await fixture(`${hubClaudeOnly}&extensionOk&extensionHold`)
  try {
    const detail = await openInstalled(page, '测试连接')
    await detail.getByRole('switch', { name: '停用 测试连接', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'extension'))
    await detail.getByTestId('hub-where-claude').getByRole('button', { name: '测试连接 更多操作', exact: true }).click()
    await page.getByRole('menuitem', { name: '从 Claude Code 移除…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '从 Claude Code 移除「测试连接」？', exact: true })
    const remove = dialog.getByRole('button', { name: '移除', exact: true })
    assert.equal(await dialog.getByTestId('hub-delete-busy').innerText(), '上一操作尚未完成，请完成后再移除。')
    assert.equal(await remove.isDisabled(), true)
    assert.equal(await remove.getAttribute('aria-busy'), null)
    await page.evaluate(() => window.releaseExtension())
    await dialog.getByTestId('hub-delete-busy').waitFor({ state: 'detached' })
    assert.equal(await remove.isDisabled(), false)
  } finally {
    await page.close()
  }
})

// D67：自己加的市场点「移除市场」先问一句，点「移除」才真的移除，点「取消」什么都不动。
test('removing a custom plugin market asks first and only removes it after confirming', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex&customMarket')
  try {
    await hubCatalogReady(page)
    await page.getByTestId('hub-tab-custom').click()
    const markets = page.getByTestId('plugins-custom-markets')
    const openRemoval = async () => {
      await markets.getByRole('button', { name: '市场 my-market 的更多操作', exact: true }).click()
      await page.getByRole('menuitem', { name: '移除市场', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '移除市场「my-market」？', exact: true })
      await dialog.getByText('移除后，该市场将不再显示在列表中，如需使用需重新添加。', { exact: true }).waitFor()
      return dialog
    }
    let dialog = await openRemoval()
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal((await callsNamed(page, 'remove-marketplace')).length, 0)
    dialog = await openRemoval()
    await dialog.getByRole('button', { name: '移除', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual((await callsNamed(page, 'remove-marketplace')).map((call) => call.args), ['my-market'])
    await markets.waitFor({ state: 'detached' })
  } finally {
    await page.close()
  }
})

test('a custom connection checks its name first and then goes to every tool picked', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex&extensionOk')
  try {
    await hubCatalogReady(page)
    await openHubAdd(page, 'mcp')
    const dialog = page.getByRole('dialog', { name: '自定义连接', exact: true })
    const submit = dialog.getByTestId('mcp-form-submit')
    await page.getByTestId('mcp-source').fill('npx')
    await page.getByTestId('mcp-name').fill('我的数据库')
    await submit.click()
    await dialog.getByText('名称只能用字母、数字和 - _，最多 40 位', { exact: true }).waitFor()
    await page.getByTestId('mcp-name').fill('test-extension')
    await submit.click()
    await dialog.getByText('已存在名为「test-extension」的连接，请更换名称', { exact: true }).waitFor()
    assert.equal((await callsNamed(page, 'extension')).length, 0)
    await page.getByTestId('mcp-name').fill('my-db')
    // 只给 Claude Code 时能选「当前项目」；勾上 Codex CLI（只有全局一层）就只剩「我的（全局）」，两边都装成全局。
    const scope = dialog.getByLabel('装到哪里', { exact: true })
    await scope.selectOption({ label: '当前项目' })
    await dialog.getByTestId('mcp-form-tools-codex').click()
    assert.deepEqual(await scope.locator('option').allTextContents(), ['我的（全局）'])
    assert.equal(await scope.inputValue(), 'user')
    await submit.click()
    await page.getByText('已添加「my-db」，给 Claude Code、Codex CLI 使用，下次打开工具时生效', { exact: true }).waitFor()
    assert.deepEqual((await callsNamed(page, 'extension')).map((call) => call.args), [
      { provider: 'claude', kind: 'mcp', action: 'install', id: 'my-db', scope: 'user', mcp: { type: 'stdio', command: 'npx', args: [], env: {} } },
    ])
    assert.deepEqual((await callsNamed(page, 'add-mcp')).map((call) => call.args), [
      { name: 'my-db', type: 'stdio', command: 'npx', args: [], env: {} },
    ])
  } finally {
    await page.close()
  }
})

// F6：「启动命令」里直接填整行命令，交给工具前拆成程序和参数，带引号的路径整段算程序；表单里他填的字不动，
// 框下面说一声参数已经分出去了。
test('a whole command line in the launch box goes to the tool as the program and its arguments', async () => {
  const page = await fixture(`${hubClaudeOnly}&extensionOk`)
  try {
    await openHubAdd(page, 'mcp')
    const dialog = page.getByRole('dialog', { name: '自定义连接', exact: true })
    const source = page.getByTestId('mcp-source')
    const splitHint = dialog.getByText('已自动拆分后续参数', { exact: true })
    await page.getByTestId('mcp-name').fill('amap')
    await source.fill('npx')
    assert.equal(await splitHint.count(), 0)
    await source.fill('npx -y @amap/amap-maps-mcp-server')
    await splitHint.waitFor()
    assert.equal(await source.getAttribute('aria-describedby'), await splitHint.getAttribute('id'))
    assert.equal(await source.inputValue(), 'npx -y @amap/amap-maps-mcp-server')
    await dialog.getByTestId('mcp-form-submit').click()
    await page.getByText('已添加「amap」，给 Claude Code 使用，下次打开工具时生效', { exact: true }).waitFor()
    assert.deepEqual((await callsNamed(page, 'extension')).map((call) => call.args.mcp), [
      { type: 'stdio', command: 'npx', args: ['-y', '@amap/amap-maps-mcp-server'], env: {} },
    ])

    await openHubAdd(page, 'mcp')
    await page.getByTestId('mcp-name').fill('local-tool')
    await source.fill('"C:\\Program Files\\My Tool\\tool.exe"')
    assert.equal(await splitHint.count(), 0)
    await source.fill('"C:\\Program Files\\My Tool\\tool.exe" --stdio')
    await splitHint.waitFor()
    await dialog.getByTestId('mcp-form-submit').click()
    await page.getByText('已添加「local-tool」，给 Claude Code 使用，下次打开工具时生效', { exact: true }).waitFor()
    assert.deepEqual((await callsNamed(page, 'extension')).map((call) => call.args.mcp).slice(1), [
      { type: 'stdio', command: 'C:\\Program Files\\My Tool\\tool.exe', args: ['--stdio'], env: {} },
    ])
  } finally {
    await page.close()
  }
})

// 同类对比第 1 条：提供方给的一整段配置直接粘贴，替他填好表单；带密钥的网络服务连请求头一起给到每个勾上的工具。
test('a pasted provider config fills the custom connection and carries its headers to every tool', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex&extensionOk')
  try {
    await hubCatalogReady(page)
    await openHubAdd(page, 'mcp')
    const dialog = page.getByRole('dialog', { name: '自定义连接', exact: true })
    const paste = dialog.getByTestId('mcp-paste')
    await paste.fill('随便写的一句话')
    await dialog.getByTestId('mcp-paste-result').getByText('无法识别此配置', { exact: true }).waitFor()
    await paste.fill(JSON.stringify({
      mcpServers: {
        docs: { type: 'http', url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer sk-docs' } },
        files: { command: 'npx', args: ['-y', 'files-server'], env: { ROOT: '<你的文件夹>' } },
      },
    }))
    await dialog.getByText('已识别：网络服务「docs」', { exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('mcp-name').inputValue(), 'docs')
    assert.equal(await dialog.getByTestId('mcp-source').inputValue(), 'https://docs.example.test/mcp')
    assert.equal(await dialog.getByTestId('mcp-headers').inputValue(), 'Authorization: Bearer sk-docs')
    // 第二条照样能选，示例文字要他自己换，提示里点名是哪一项。
    await dialog.getByTestId('mcp-paste-choice').selectOption('1')
    await dialog.getByText('已识别：本地程序「files」', { exact: true }).waitFor()
    await dialog.getByText('已自动填写下方各项。ROOT 仍为说明中的示例文字，请替换为实际内容后点击「添加」。每次添加一个，添加后可再次粘贴同一段内容并选择下一个。', { exact: true }).waitFor()
    assert.equal(await dialog.getByTestId('mcp-source').inputValue(), 'npx')
    await dialog.getByTestId('mcp-paste-choice').selectOption('0')
    // 他自己改过的名字，再选一次也不动。
    await dialog.getByTestId('mcp-name').fill('my-docs')
    await dialog.getByTestId('mcp-paste-choice').selectOption('1')
    await dialog.getByTestId('mcp-paste-choice').selectOption('0')
    assert.equal(await dialog.getByTestId('mcp-name').inputValue(), 'my-docs')
    await dialog.getByTestId('mcp-form-tools-codex').click()
    await dialog.getByTestId('mcp-form-submit').click()
    await page.getByText('已添加「my-docs」，给 Claude Code、Codex CLI 使用，下次打开工具时生效', { exact: true }).waitFor()
    const headers = { Authorization: 'Bearer sk-docs' }
    assert.deepEqual((await callsNamed(page, 'extension')).map((call) => call.args), [
      { provider: 'claude', kind: 'mcp', action: 'install', id: 'my-docs', scope: 'user', mcp: { type: 'http', url: 'https://docs.example.test/mcp', headers } },
    ])
    assert.deepEqual((await callsNamed(page, 'add-mcp')).map((call) => call.args), [
      { name: 'my-docs', type: 'http', url: 'https://docs.example.test/mcp', headers },
    ])
  } finally {
    await page.close()
  }
})

test('a custom connection leaves alone a same-named one another picked tool already has', async () => {
  const page = await fixture('page=extensions&installedProviders=claude,codex&extensionOk&codexMcp=github')
  try {
    await hubCatalogReady(page)
    await openHubAdd(page, 'mcp')
    const dialog = page.getByRole('dialog', { name: '自定义连接', exact: true })
    await dialog.getByTestId('mcp-paste').fill('claude mcp add --transport http github https://api.example.test/mcp')
    await dialog.getByText('已识别：网络服务「github」', { exact: true }).waitFor()
    await dialog.getByTestId('mcp-form-tools-codex').click()
    await dialog.getByTestId('mcp-form-submit').click()
    await dialog.getByText('Codex CLI 中已存在名为「github」的连接，为保留原连接，本次未添加。请更换名称，或取消勾选 Codex CLI。', { exact: true }).waitFor()
    assert.equal((await callsNamed(page, 'extension')).length, 0)
    assert.equal((await callsNamed(page, 'add-mcp')).length, 0)
  } finally {
    await page.close()
  }
})

// 同类对比 备选 5：Claude Code 全局里自己加的一条连接，「+」装到别的工具。界面只把名字交给主进程，已经有的不给勾。
test('a connection added in Claude Code is copied to the tools that do not have it yet', async () => {
  const page = await fixture(`${hubAllTools}&extensionOk&claudeMcp=docs&codexMcp=docs`)
  try {
    await hubCatalogReady(page)
    await page.getByTestId('hub-tab-custom').click()
    await page.getByTestId('hub-add-mcp-docs').click()
    const dialog = page.getByRole('dialog', { name: '安装「docs」', exact: true })
    await dialog.getByText('连接里填过的密钥、环境变量和请求头会原样带过去，装在那些工具的「我的（全局）」里，下次打开工具时生效。', { exact: true }).waitFor()
    const tools = dialog.getByRole('group', { name: '装到哪里', exact: true })
    await expect(tools.getByTestId('hub-install-tools-codex')).toBeDisabled()
    await expect(tools.getByTestId('hub-install-tools-codex')).toContainText('已安装')
    await expect(tools.getByTestId('hub-install-tools-grok')).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByTestId('hub-install-submit').click()
    await waitForToast(page, '已安装「docs」，给 Grok CLI 使用，下次打开工具时生效')
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual((await callsNamed(page, 'copy-mcp')).map((call) => call.args), [{ from: 'claude', to: 'grok', name: 'docs' }])
    assert.equal((await callsNamed(page, 'extension')).length, 0)
    assert.equal((await callsNamed(page, 'add-mcp')).length, 0)
  } finally {
    await page.close()
  }
})

test('a copy that fails for one tool keeps the ones already done and retries only the rest', async () => {
  const page = await fixture(`${hubAllTools}&extensionOk&claudeMcp=docs&copyMcpFail=grok`)
  try {
    await hubCatalogReady(page)
    await page.getByTestId('hub-tab-custom').click()
    await page.getByTestId('hub-add-mcp-docs').click()
    const dialog = page.getByRole('dialog', { name: '安装「docs」', exact: true })
    await expect(dialog.getByTestId('hub-install-tools-codex')).toHaveAttribute('aria-pressed', 'true')
    await expect(dialog.getByTestId('hub-install-tools-grok')).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByTestId('hub-install-submit').click()
    await dialog.getByText('扩展操作失败，已有配置保留').first().waitFor()
    // 装上了的从勾选里拿掉，再点一次只补剩下的。
    await expect(dialog.getByTestId('hub-install-tools-codex')).toHaveAttribute('aria-pressed', 'false')
    await expect(dialog.getByTestId('hub-install-tools-grok')).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByTestId('hub-install-submit').click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'copy-mcp').length === 3)
    await dialog.getByText('扩展操作失败，已有配置保留').first().waitFor()
    assert.deepEqual((await callsNamed(page, 'copy-mcp')).map((call) => call.args.to), ['codex', 'grok', 'grok'])
  } finally {
    await page.close()
  }
})

// 三家都有的那条没有能装的，行上只给「…」；只有 Grok 里有的读不全，不给装到别的工具。
test('copying is offered only where another tool can still take the connection', async () => {
  const page = await fixture(`${hubAllTools}&codexMcp=test-extension&grokMcp=test-extension`)
  try {
    await page.getByTestId('hub-tab-custom').click()
    await page.getByTestId('hub-menu-mcp-test-extension').waitFor()
    assert.equal(await page.getByTestId('hub-add-mcp-test-extension').count(), 0)
  } finally {
    await page.close()
  }
  const grokOnly = await fixture(`${hubAllTools}&grokMcp=only-grok`)
  try {
    await grokOnly.getByTestId('hub-tab-custom').click()
    await grokOnly.getByTestId('hub-menu-mcp-only-grok').waitFor()
    assert.equal(await grokOnly.getByTestId('hub-add-mcp-only-grok').count(), 0)
  } finally {
    await grokOnly.close()
  }
})

// 没装的工具不去读它的列表；那一家那一行写「这台电脑还没装」，给「前往首页安装」。
test('a tool that is not installed is not read and each entry leads to the home page to install it', async () => {
  const page = await fixture('page=extensions&installedProviders=codex')
  try {
    const detail = await openInstalled(page, '浏览器')
    await expect(detail.getByTestId('hub-where-claude')).toContainText('本机尚未安装 Claude Code')
    await detail.getByTestId('hub-where-home-claude').click()
    assert.equal((await callsNamed(page, 'navigate')).at(-1).args, 'home')
    assert.deepEqual([...new Set((await callsNamed(page, 'list-extensions')).map((call) => call.args))], ['codex'])
  } finally {
    await page.close()
  }
})

// Mac 验收 R10：风险标签那句说明原来哪儿都没上屏。现在详情页标签下面写出来，鼠标停在标签上也能看到。
test('a curated entry spells out what its risk tag means under the tags in its details', async () => {
  const page = await fixture(hubClaudeOnly)
  try {
    await page.getByTestId('hub-open-mcp-files').click()
    const detail = page.getByTestId('hub-detail')
    await expect(detail.getByTestId('curated-risk-details-files')).toHaveText('可在您指定的位置新建、修改和删除文件。')
    await expect(detail.getByTitle('可在您指定的位置新建、修改和删除文件。')).toHaveText('会修改本地文件')
  } finally {
    await page.close()
  }
})

// 「扩展改」第 3 条（10-24）：能用它的工具一个都没装时直说，给「前往首页安装」，不给「+」。
test('an entry says on each family that the tool is not installed when none is, and leads to the home page', async () => {
  const page = await fixture('page=extensions&installedProviders=')
  try {
    await page.getByTestId('hub-open-mcp-sequential-thinking').click()
    const detail = page.getByTestId('hub-detail')
    for (const [id, name] of [['claude', 'Claude Code'], ['codex', 'Codex CLI'], ['grok', 'Grok CLI']])
      await expect(detail.getByTestId(`hub-where-${id}`)).toContainText(`本机尚未安装 ${name}`)
    assert.equal(await detail.getByTestId('hub-detail-add').count(), 0)
    await detail.getByTestId('hub-back').click()
    assert.equal(await page.getByTestId('hub-add-mcp-sequential-thinking').count(), 0)
    await expect(page.getByTestId('hub-claude-missing')).toContainText('安装 Claude Code 后可查看 Claude 官方插件。')
    await page.getByTestId('hub-claude-open-home').click()
    assert.equal((await callsNamed(page, 'navigate')).at(-1).args, 'home')
    assert.equal((await callsNamed(page, 'list-extensions')).length, 0)
  } finally {
    await page.close()
  }
})

// 备份行的标题就是列表上写的那个时间（今天 09:12 / 9月7日 09:00…），后面跟着原因和 Key 两颗小标签。
function backupRowTime(row) {
  return row.locator('.xm-row-title').evaluate((title) => title.firstChild.textContent)
}

test('backup restore requires preview and confirmation before touching files', async () => {
  // 原来的备份页并进了设置（v4 批09）：page=backups 和托盘、错误框里的「去备份」一样，落在「备份迁移」那一组。
  const page = await fixture('page=backups')
  try {
    const row = page.getByTestId('backups-row-backup-1')
    await row.waitFor()
    assert.equal(await page.getByRole('tab', { name: '备份迁移', exact: true }).getAttribute('aria-selected'), 'true')
    const shown = await backupRowTime(row)
    await row.getByRole('button', { name: '预览', exact: true }).click()
    const preview = page.getByRole('dialog', { name: '备份内容', exact: true })
    await preview.getByText('config.toml', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('backup-preview-drawer').count(), 1)
    await preview.getByText('已校验，文件完整', { exact: true }).waitFor()
    await preview.getByText('恢复前会先把当前配置另存一份，恢复后需要重新打开工具。', { exact: true }).waitFor()
    await preview.getByText('备份保存在本机，其中可能包含密钥，请勿随意提供给他人。', { exact: true }).waitFor()
    await preview
      .getByRole('button', { name: '恢复这份配置', exact: true })
      .click()
    // 预览里点「恢复这份配置」只是打开确认，还没动任何文件。
    const confirm = page.getByRole('dialog', { name: `恢复到 ${shown} 的配置？`, exact: true })
    await confirm.getByText('当前配置会先另存一份，恢复后需要重新打开工具。', { exact: true }).waitFor()
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'restore-backup')
        .length,
      0,
    )
    await confirm.getByTestId('backups-restore-confirm').click()
    await waitForToast(page, `已恢复到 ${shown} 的配置，原来的配置已另存`)
    assert.equal(
      (await calls(page)).find((call) => call.name === 'restore-backup').args,
      'backup-1',
    )
    // 恢复成功要让首页重读这个工具的配置。
    assert.equal(
      (await calls(page)).find((call) => call.name === 'backup-restored').args,
      'codex',
    )
    // 恢复完当场测一次连接，结论留在备份卡上。
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

// 第 45～47 条：空着时说清备份从哪来；按工具筛选时空状态点名那个工具。v4 批09 起「立即备份」是卡头的菜单，
// 点哪个工具就只备份哪个，不再跟着上面的筛选走。
test('an empty backup list says where backups come from and backs up the tool picked above', async () => {
  const page = await fixture('page=backups&empty')
  try {
    const card = page.getByTestId('page-backups')
    const state = page.getByTestId('backups-empty')
    await state.getByText('暂无备份', { exact: true }).waitFor()
    await state.getByText('请点击「立即备份」保存当前的工具配置。', { exact: true }).waitFor()
    await card.getByRole('button', { name: 'Grok CLI', exact: true }).click()
    await state.getByText('Grok CLI 暂无备份', { exact: true }).waitFor()
    await page.getByTestId('backups-create').click()
    await page.getByRole('menu', { name: '立即备份', exact: true }).waitFor()
    await page.getByTestId('backups-create-grok').click()
    await waitForToast(page, '备份完成')
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'create-backup').map((call) => call.args), ['grok'])
    // 选回「全部工具」：空状态不再点名哪个工具。
    await card.getByRole('button', { name: '全部工具', exact: true }).click()
    await state.getByText('暂无备份', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

// 决定单 D100：「备份迁移」最下面那张「星芒占用空间」。清旧备份要先确认，清缩略图直接清；聊天记录和日志只列大小。
test('the storage card lists six sizes and only cleans old backups after a confirmation', async () => {
  const page = await fixture('page=backups')
  try {
    const card = page.getByTestId('settings-storage')
    await card.getByTestId('settings-storage-total').getByText('一共约 3.1 GB', { exact: true }).waitFor()
    await card.getByTestId('settings-storage-size-works').getByText('约 2.1 GB', { exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-storage-row-chat-history').getByRole('button').count(), 0)
    assert.equal(await card.getByTestId('settings-storage-row-logs').getByRole('button').count(), 0)
    await card.getByText('改工具配置之前自动存的旧配置，一共 24 份。', { exact: true }).waitFor()

    await card.getByTestId('settings-storage-clean-backups').click()
    const dialog = page.getByRole('dialog', { name: '清理旧备份？', exact: true })
    await dialog.getByText('只留最近 10 份，更早的 14 份删掉。最近这 10 份照样能在上面的「工具配置备份」里恢复。', { exact: true }).waitFor()
    assert.equal((await calls(page)).some((call) => call.name === 'clean-storage'), false)
    await dialog.getByTestId('settings-storage-backups-confirm').click()
    await waitForToast(page, '已清理，腾出约 120 MB。')
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'clean-storage').map((call) => call.args), ['backups'])
    // 只重算清掉的那一行：剩下最近 10 份，按钮灰掉。
    await card.getByTestId('settings-storage-row-backups').getByText('仅保留最近 10 份，无需清理', { exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-storage-clean-backups').isDisabled(), true)

    await card.getByTestId('settings-storage-clean-thumbnails').click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'clean-storage').length === 2)
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'clean-storage').map((call) => call.args), ['backups', 'thumbnails'])
  } finally {
    await page.close()
  }
})

test('the storage card will not clean downloads while a tool is installing', async () => {
  const page = await fixture('page=backups&storageInstalling')
  try {
    const row = page.getByTestId('settings-storage-row-downloads')
    await row.getByText('正在装工具，装完再清理', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('settings-storage-clean-downloads').isDisabled(), true)
  } finally {
    await page.close()
  }
})

// 搜索框去掉了（v4 批09）；认备份靠的仍是列表上写的时间和工具名，不是谁也看不到的 id。
test('backup rows are named by the time they were taken and the tool, never by an id nobody sees', async () => {
  const page = await fixture('page=backups')
  try {
    const row = page.getByTestId('backups-row-backup-1')
    await row.waitFor()
    // 图标单独一格，标题只有时间。
    await row.locator('.xm-row-icon').waitFor()
    assert.match(await backupRowTime(row), /^(今天|昨天|(\d{4}年)?\d{1,2}月\d{1,2}日) \d{2}:\d{2}$/)
    await row.locator('.xm-row-desc').getByText(/^Codex CLI 配置，0\.1 KB$/).waitFor()
    assert.equal(await page.getByTestId('page-backups').getByText('backup-1').count(), 0)
    assert.equal(await page.getByTestId('backups-search').count(), 0)
  } finally {
    await page.close()
  }
})

// R2-2：校验没过的那份原来跟已下线的工具一起被筛掉，原因和删除入口一起不见了。现在单独一行：
// 说清用不了、不给预览、不能恢复、能删；认不出工具的只在「全部工具」里。
test('a broken backup keeps its row, cannot be previewed or restored, and can be deleted', async () => {
  const page = await fixture('page=backups&brokenBackup')
  try {
    const card = page.getByTestId('page-backups')
    const torn = page.getByTestId('backups-row-backup-torn')
    const unreadable = page.getByTestId('backups-row-backup-unreadable')
    await torn.locator('.xm-row-desc').getByText('Codex CLI 配置，此备份不可用，可删除', { exact: true }).waitFor()
    await torn.getByText('校验失败', { exact: true }).waitFor()
    assert.equal(await torn.getByRole('button', { name: '预览', exact: true }).count(), 0)
    assert.equal(await page.getByTestId('backups-restore-backup-torn').isDisabled(), true)
    await unreadable.locator('.xm-row-desc').getByText('此备份不可用，可删除', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('backups-restore-backup-unreadable').isDisabled(), true)
    await card.getByText('3 份备份', { exact: true }).waitFor()
    await card.getByRole('button', { name: 'Codex CLI', exact: true }).click()
    await card.getByText('2 份备份', { exact: true }).waitFor()
    await torn.waitFor()
    assert.equal(await unreadable.count(), 0)
    await card.getByRole('button', { name: '全部工具', exact: true }).click()
    // 没有时间的那份，删除确认不写「删除 暂未记录 的备份？」。
    await unreadable.getByRole('button', { name: '删除这份备份', exact: true }).click()
    const confirm = page.getByRole('dialog', { name: '删除这份备份？', exact: true })
    await confirm.getByRole('button', { name: '删除', exact: true }).click()
    await waitForToast(page, '备份已删除')
    await unreadable.waitFor({ state: 'detached' })
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'deleteBackup').map((call) => call.args), ['backup-unreadable'])
    await card.getByText('2 份备份', { exact: true }).waitFor()
  } finally {
    await page.close()
  }
})

test('backup list names whose key a backup holds and warns before restoring another account key', async () => {
  const page = await fixture('page=backups&backupOtherKey')
  try {
    await page.getByTestId('backups-key-backup-1').getByText('账号 old-user 的密钥').waitFor()
    await page.getByRole('button', { name: '预览', exact: true }).click()
    await page.getByTestId('backup-preview-key').getByText('账号 old-user 的密钥').waitFor()
    await page
      .getByRole('button', { name: '恢复这份配置', exact: true })
      .click()
    await page.getByTestId('backups-restore-key-warning').waitFor()
    assert.match(
      await page.getByTestId('backups-restore-key-warning').innerText(),
      /用量不计入当前账号/,
    )
  } finally {
    await page.close()
  }
})

// v4 第 10 批：「反馈与客服」分「留言反馈」「运行日志」两个页签，日志在第二个里。
async function openRunLog(page) {
  await page.getByTestId('feedback-tabs').getByRole('tab', { name: /^运行日志/ }).click()
  await page.getByTestId('feedback-panel-log').waitFor()
}

test('feedback opens on the message form and copies what the customer wrote together with the report', async () => {
  const page = await fixture('page=feedback')
  try {
    const form = page.getByTestId('feedback-form')
    await form.waitFor()
    assert.equal(await page.getByRole('tab', { name: '留言反馈', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByTestId('feedback-panel-log').isHidden(), true)
    // 没写描述就点：就地提示，不复制、不打开客服。
    await page.getByTestId('feedback-send').click()
    await form.getByText('请先描述遇到的问题', { exact: true }).waitFor()
    assert.equal((await calls(page)).some((call) => call.name === 'copy-clipboard' || call.name === 'open-support'), false)
    await page.getByTestId('feedback-type').getByRole('button', { name: '功能建议', exact: true }).click()
    await page.getByTestId('feedback-description').fill('点「打开」后终端闪一下就关了')
    await page.getByTestId('feedback-contact').fill('wx-test')
    await page.getByTestId('feedback-send').click()
    await waitForToast(page, '已复制，请发送给客服')
    // J1：留言交给主进程拼好、现取报告、写剪贴板；页面自己不写剪贴板，客户等报告时切去微信也复制得上。
    const sent = (await calls(page)).filter((call) => call.name === 'copy-feedback-message').map((call) => call.args)
    assert.deepEqual(sent, [{
      type: 'idea',
      description: '点「打开」后终端闪一下就关了',
      contact: 'wx-test',
      identity: '星芒 0.1.31 · Windows · 已登录 test-user',
      lastFailure: '最近一次失败：安装 Codex CLI · 网络超时',
      attachReport: true,
    }])
    assert.equal((await calls(page)).some((call) => call.name === 'copy-clipboard'), false, 'the page leaves the clipboard to the main process')
    assert.ok((await calls(page)).some((call) => call.name === 'open-support'), 'the support page opens after copying')
    // 关掉「附带反馈报告」：主进程只复制客户写的那几行。
    await page.getByTestId('feedback-attach').getByRole('switch').click()
    await page.getByTestId('feedback-send').click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'copy-feedback-message').length === 2)
    const last = (await calls(page)).filter((call) => call.name === 'copy-feedback-message').at(-1).args
    assert.equal(last.attachReport, false)
    assert.equal(last.type, 'idea')
  } finally {
    await page.close()
  }
})

test('feedback still copies what the customer wrote when the diagnostic report cannot be made', async () => {
  const page = await fixture('page=feedback&fail=feedbackReport')
  try {
    await page.getByTestId('feedback-form').waitFor()
    await page.getByTestId('feedback-description').fill('点「打开」后终端闪一下就关了')
    await page.getByTestId('feedback-send').click()
    await waitForToast(page, '反馈报告生成失败，已复制您填写的内容，请发送给客服')
    const sent = (await calls(page)).filter((call) => call.name === 'copy-feedback-message').map((call) => call.args)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'bug')
    assert.equal(sent[0].description, '点「打开」后终端闪一下就关了')
    assert.equal(sent[0].attachReport, true)
    assert.equal((await calls(page)).some((call) => call.name === 'copy-clipboard'), false)
    assert.ok((await calls(page)).some((call) => call.name === 'open-support'), 'the support page still opens')
  } finally {
    await page.close()
  }
})

test('feedback lists the first things to try and the support card next to the form', async () => {
  const page = await fixture('page=feedback')
  try {
    const card = page.getByTestId('feedback-support-card')
    await card.getByText('微信扫码添加客服', { exact: true }).waitFor()
    await card.getByTestId('feedback-support-identity-line').getByText('星芒 0.1.31 · Windows · 已登录 test-user').waitFor()
    await card.getByTestId('feedback-support-open').click()
    const tries = page.getByTestId('feedback-try')
    assert.deepEqual(
      await tries.locator('.v2-fb-try-item > span > span').allInnerTexts(),
      ['工具无法安装或打开后闪退', '已付款，余额未变化', '不清楚如何开始使用', '需要将 AI 连接到浏览器或文件夹'],
    )
    await page.getByTestId('feedback-try-orders').click()
    await page.getByTestId('feedback-try-health').click()
    assert.deepEqual(
      (await calls(page)).filter((call) => ['open-support', 'navigate'].includes(call.name)).map((call) => [call.name, call.args]),
      [['open-support', undefined], ['navigate', ['account', 'orders']], ['navigate', 'health']],
    )
  } finally {
    await page.close()
  }
  const without = await fixture('page=feedback&noSupport')
  try {
    await without.getByTestId('feedback-form').waitFor()
    assert.equal(await without.getByTestId('feedback-support-card').count(), 0)
  } finally {
    await without.close()
  }
})

test('feedback narrows the log list by source and to this run, and copies one entry', async () => {
  const page = await fixture('page=feedback')
  try {
    await openRunLog(page)
    await page.getByText('上次启动的更新记录').waitFor()
    await page.getByTestId('feedback-source').getByRole('button', { name: '更新', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="feedback-panel-log"]')?.innerText.includes('测试日志'))
    await page.getByText('本次启动的更新失败').waitFor()

    await page.getByTestId('feedback-current-boot').getByRole('switch').click()
    await page.waitForFunction(() =>
      !document.querySelector('[data-testid="feedback-panel-log"]')?.innerText.includes('上次启动的更新记录'),
    )
    await page.getByText('本次启动的更新失败').waitFor()

    await page.getByTestId('feedback-log-2026-09-07T01:00:00Z:4242:2').click()
    await page.getByRole('button', { name: '复制这一条', exact: true }).click()
    await waitForToast(page, '已复制这一条日志')
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

// 第 48～50 条：日志一条一行、整行点开；v4 第 10 批起「详情」在这一行下面就地展开，
// 页签上数着本次启动的错误，工具条上放「打开日志文件夹」「清除日志」。
test('feedback shows one line per log entry that opens in place and counts this run\'s errors on the tab', async () => {
  const page = await fixture('page=feedback&feedbackTab=log')
  try {
    assert.equal(await page.getByTestId('feedback-error-count').innerText(), '1')
    assert.equal(await page.getByTestId('feedback-panel-form').isHidden(), true)
    const row = page.getByTestId('feedback-log-2026-09-07T01:00:00Z:4242:2')
    await row.waitFor()
    assert.match(await row.locator('time').innerText(), /^(\d{4}年)?\d{1,2}月\d{1,2}日 \d{2}:\d{2}:\d{2}$/)
    assert.equal(await row.locator('.v2-feedback-log-level').innerText(), '错误')
    assert.match(await row.locator('.v2-feedback-log-level').getAttribute('class'), /is-error/)
    assert.equal(await row.locator('.v2-feedback-log-message').innerText(), '本次启动的更新失败')
    assert.equal(await row.locator('.v2-feedback-log-source').innerText(), '更新')
    // 一条一行：没有文件图标，也没有单独的「详情」按钮，只有行尾一个展开箭头。
    assert.equal(await row.locator('svg').count(), 1)
    assert.equal(await page.getByRole('button', { name: '详情', exact: true }).count(), 0)
    // v4 原型一条日志一行 44 高（.log-r），等级换成了小标签，不再比这高。
    const height = (await row.boundingBox()).height
    assert.ok(height <= 44, `one line per entry (${height})`)
    assert.equal(await row.getAttribute('aria-expanded'), 'false')
    await row.click()
    assert.equal(await row.getAttribute('aria-expanded'), 'true')
    const detail = page.getByTestId('feedback-log-detail')
    await detail.getByText('{\n  "code": "ENOENT"\n}').waitFor()
    await detail.getByText('已隐去密钥', { exact: true }).waitFor()
    await row.click()
    await detail.waitFor({ state: 'detached' })
    const panel = page.getByTestId('feedback-panel-log')
    await panel.getByRole('button', { name: '打开日志文件夹', exact: true }).waitFor()
    await panel.getByRole('button', { name: '刷新', exact: true }).waitFor()
    assert.equal(await page.getByTestId('feedback-clear').isEnabled(), true)
    await panel.getByText('日志仅保存在本机。', { exact: true }).waitFor()
    // 筛选后列表跟着走。
    await page.getByTestId('feedback-source').getByRole('button', { name: '更新', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.v2-feedback-log').length === 2)
  } finally {
    await page.close()
  }
})

test('feedback cannot clear logs it has none of and says how to read them when the list fails', async () => {
  const empty = await fixture('page=feedback&empty')
  try {
    await openRunLog(empty)
    assert.equal(await empty.getByTestId('feedback-error-count').count(), 0)
    const state = empty.getByTestId('feedback-empty')
    await state.getByText('暂无运行日志', { exact: true }).waitFor()
    await state.getByText('软件运行时的事件将记录在此处。', { exact: true }).waitFor()
    assert.equal(await empty.getByTestId('feedback-clear').isDisabled(), true)
  } finally {
    await empty.close()
  }
  const failed = await fixture('page=feedback&fail=load')
  try {
    await openRunLog(failed)
    const state = failed.getByTestId('feedback-error')
    await state.getByText('请点击「重新加载」；如仍无法加载，请点击「打开日志文件夹」直接查看日志文件。', { exact: true }).waitFor()
    await state.getByRole('button', { name: '重新加载', exact: true }).waitFor()
    assert.equal(await failed.getByTestId('feedback-clear').isDisabled(), true)
  } finally {
    await failed.close()
  }
})

test('feedback clears the run log only after asking and then says it was cleared', async () => {
  const page = await fixture('page=feedback&feedbackTab=log')
  try {
    await page.getByTestId('feedback-clear').click()
    const confirm = page.getByRole('dialog', { name: '清除全部运行日志？', exact: true })
    await confirm.getByText('清除后无法恢复。如需提交反馈，建议先保留日志。', { exact: true }).waitFor()
    await confirm.getByText('仅清除运行日志，不会删除工具配置、账号或对话记录。', { exact: true }).waitFor()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    assert.equal((await calls(page)).some((call) => call.name === 'clear-logs'), false)
    await page.getByTestId('feedback-clear').click()
    await confirm.getByRole('button', { name: '清除', exact: true }).click()
    await waitForToast(page, '日志已清除')
    const state = page.getByTestId('feedback-empty')
    await state.getByText('日志已清空', { exact: true }).waitFor()
    await state.getByText('后续操作将重新记录在此处。', { exact: true }).waitFor()
    assert.equal((await calls(page)).filter((call) => call.name === 'clear-logs').length, 1)
  } finally {
    await page.close()
  }
})

test('feedback shows the latest 100 entries first and 100 more on request', async () => {
  const page = await fixture('page=feedback&manyLogs&feedbackTab=log')
  try {
    await page.getByTestId('feedback-log-next').waitFor()
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
    // 留言表单里「附带反馈报告」旁边的链接也叫「预览反馈报告」（W68），按名字找会撞上两颗，点的是「联系客服」卡上那颗。
    await page.getByTestId('feedback-preview').click()
    await page.getByTestId('feedback-report-text').waitFor()
    // 脱敏提示挪进了预览框，一行细条（v4 第 10 批）。
    const privacy = page.getByTestId('feedback-privacy')
    assert.equal(await privacy.innerText().then((text) => text.replace(/\s+/g, '')), '密钥、密码和电脑用户名均已隐藏。发送前请确认不含私有项目名称和地址。')
    assert.ok((await privacy.boundingBox()).height <= 50)
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
    // 留言表单里「附带反馈报告」旁边的链接也叫「预览反馈报告」（W68），按名字找会撞上两颗，点的是「联系客服」卡上那颗。
    await page.getByTestId('feedback-preview').click()
    const hint = page.getByTestId('feedback-report-unchecked')
    await hint.getByText('报告中暂无检查结果', { exact: true }).waitFor()
    await hint.getByText('请点击「前往检查」，检查完成后再复制或导出报告，便于客服快速定位问题。', { exact: true }).waitFor()
    await hint.getByRole('button', { name: '前往检查', exact: true }).click()
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
    await drawer.getByRole('button', { name: '导出对话', exact: true }).click()
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
  // 备份行的「…」菜单换成了一颗垃圾桶（v4 批09）：只有图标的按钮照样要有名字，点开的确认点名是哪一份。
  const backups = await fixture('page=backups')
  try {
    const row = backups.getByTestId('backups-row-backup-1')
    await row.waitFor()
    const shown = await backupRowTime(row)
    await row.getByRole('button', { name: '删除这份备份', exact: true }).click()
    const confirm = backups.getByRole('dialog', { name: `删除 ${shown} 的备份？`, exact: true })
    await confirm.getByText('删除后将无法使用此备份恢复配置。', { exact: true }).waitFor()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await confirm.waitFor({ state: 'hidden' })
    assert.equal((await calls(backups)).some((call) => call.name === 'deleteBackup'), false)
  } finally {
    await backups.close()
  }
})

test('available update displays download action and failed download remains reviewable', async () => {
  // 原来的更新页并进了设置（v4 批09）：page=updates 和托盘、更新气泡的「查看更新」一样，落在「版本更新」那一组。
  const page = await fixture('page=updates')
  try {
    const card = page.getByTestId('page-updates')
    await card.getByRole('button', { name: '下载更新', exact: true }).click()
    await card.getByText('测试下载失败').waitFor()
    assert.equal(await page.getByRole('tab', { name: '版本更新', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'download-update')
        .length,
      1,
    )
    assert.equal(
      await page.getByRole('button', { name: '重启并安装', exact: true }).count(),
      0,
    )
  } finally {
    await page.close()
  }
})

// 第 52～54 条：版本卡写清当前版本、点名新版本；版本号和卡上别的说明一样用正文字体，不另起一种字；
// 读不到时照实说。「安装前需要知道」那句挪进了「重启并安装」的确认框，照样摊开不折叠。
test('the version card names the current and the new version and shows what to know before installing', async () => {
  const page = await fixture('page=updates')
  try {
    const current = page.getByTestId('updates-current-version')
    await current.getByText('当前版本 v0.1.31', { exact: true }).waitFor()
    const next = page.getByTestId('updates-new-version')
    await next.getByText('有新版本 v0.1.32', { exact: true }).waitFor()
    const typeface = (locator) => locator.evaluate((element) => {
      const style = getComputedStyle(element)
      return { fontSize: style.fontSize, fontFamily: style.fontFamily }
    })
    const checked = page.getByTestId('page-updates').getByText(/检查过$/)
    assert.deepEqual(await typeface(current), await typeface(checked))
    assert.equal(
      (await typeface(current)).fontFamily,
      await page.evaluate(() => getComputedStyle(document.body).fontFamily),
    )
    assert.equal(await page.locator('details').count(), 0)
  } finally {
    await page.close()
  }
  const downloaded = await fixture('page=updates&updateDownloaded')
  try {
    await downloaded.getByTestId('page-updates').getByText('已下载，重启后生效', { exact: true }).waitFor()
    await downloaded.getByRole('button', { name: '重启并安装', exact: true }).click()
    const note = downloaded
      .getByRole('dialog', { name: '重启并安装更新？', exact: true })
      .getByTestId('updates-install-note')
    await note.waitFor()
    assert.equal(await note.isVisible(), true)
    assert.match(await note.innerText(), /^安装前请保存工具中未完成的工作。/)
    assert.equal(await downloaded.locator('details').count(), 0)
  } finally {
    await downloaded.close()
  }
  // 只有更新状态读不到：设置页照常打开，版本卡说没读到，不一直挂着「正在读取」。
  const failed = await fixture('page=updates&fail=update')
  try {
    await failed.getByTestId('updates-current-version').getByText('版本暂未获取', { exact: true }).waitFor()
    assert.equal(await failed.getByText('正在读取更新状态…', { exact: true }).count(), 0)
    assert.equal(await failed.getByTestId('updates-new-version').count(), 0)
  } finally {
    await failed.close()
  }
})

// 版本卡、备份卡原来是独立的页面，设置读不到也照样能用；并进设置以后不能跟着设置一起没了，
// 不然托盘、更新气泡、错误框跳过来只看到一句「设置暂时没有读到」，更新装不上、备份找不回。
test('the version and backup cards still show when the settings themselves cannot be read', async () => {
  const updates = await fixture('page=updates&fail=settings-read')
  try {
    await updates.getByText('设置暂时无法获取', { exact: true }).waitFor()
    assert.equal(await updates.getByRole('tab', { name: '版本更新' }).getAttribute('aria-selected'), 'true')
    await updates.getByTestId('updates-current-version').getByText('当前版本 v0.1.31', { exact: true }).waitFor()
    assert.equal(await updates.getByTestId('updates-new-version').innerText(), '有新版本 v0.1.32')
    // 只摆卡；要设置读回来才画得出的行（启动时检查新版本）不摆。
    assert.equal(await updates.getByTestId('updates-check-on-startup').count(), 0)
  } finally {
    await updates.close()
  }
  const backups = await fixture('page=backups&fail=settings-read')
  try {
    await backups.getByText('设置暂时无法获取', { exact: true }).waitFor()
    assert.equal(await backups.getByRole('tab', { name: '备份迁移' }).getAttribute('aria-selected'), 'true')
    await backups.getByTestId('backups-row-backup-1').waitFor()
  } finally {
    await backups.close()
  }
})

// 「版本更新」组里版本卡下面就能开关启动检查和自动下载更新，不用再绕去别处。
test('the version updates group switches the startup check and automatic downloads in place', async () => {
  const page = await fixture('page=updates&autoUpdate=1')
  try {
    const check = page.getByTestId('updates-check-on-startup').getByRole('switch', { name: '启动时检查新版本', exact: true })
    const automatic = page.getByTestId('updates-auto-update').getByRole('switch', { name: '自动下载更新', exact: true })
    await page.waitForFunction(() => document.querySelector('[data-testid="updates-check-on-startup"] [role="switch"]')?.disabled === false)
    assert.equal(await check.getAttribute('aria-checked'), 'true')
    assert.equal(await automatic.getAttribute('aria-checked'), 'true')
    await check.click()
    await waitForToast(page, '已保存')
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

test('the version updates group leaves the automatic download switch out where the app cannot update itself', async () => {
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
    // 付款是在另一个窗口里付的：这边「编辑资料」还开着、名字改到一半。
    await page.getByTestId('account-profile-edit').click()
    const profile = page.getByTestId('account-profile-dialog')
    await profile.getByTestId('account-display').fill('还没有保存的名称')
    await page.evaluate(() => dispatchEvent(new Event('test-payment-return')))
    await page.getByTestId('account-orders-section').getByText('TEST-ORDER').waitFor()
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
    assert.equal(
      await profile.getByTestId('account-display').inputValue(),
      '还没有保存的名称',
    )
  } finally {
    await page.close()
  }
})

test('subscription payment terminal events clear the pending state and explain the outcome', async () => {
  const page = await fixture('page=account&subscriptionExternal=1')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.getByRole('button', { name: '购买', exact: true }).waitFor()
    await page.getByRole('button', { name: '购买', exact: true }).click()
    await page.getByRole('button', { name: '打开支付窗口', exact: true }).click()
    await page.getByTestId('account-payment-notice').getByText('XM-VISUAL-SUBSCRIPTION', { exact: true }).waitFor()
    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'closed', tradeNo: 'XM-VISUAL-SUBSCRIPTION' }))
    await page.getByText('支付窗口已关闭', { exact: true }).waitFor()
    assert.equal(await page.getByText('等待支付结果', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

// N3：买套餐的框开着时后台改了价。服务端下单只认套餐编号、照那一刻的价扣，所以点付款前要再核一遍。
const subscriptionCalls = async (page) =>
  (await calls(page)).filter((call) => /create-subscription-payment|purchase-subscription-balance/.test(call.name))

test('a plan repriced while its purchase dialog is open is shown at the new price before any order is placed', async () => {
  const page = await fixture('page=account&accountTab=recharge&subscriptionExternal=1')
  try {
    await page.getByRole('button', { name: '购买', exact: true }).click()
    const purchase = page.getByRole('dialog', { name: '购买外部订阅' })
    await purchase.getByText('¥29', { exact: true }).waitFor()
    await page.evaluate(() => window.subscriptionPlanHarness.set({ priceAmount: 39 }))

    await purchase.getByRole('button', { name: '打开支付窗口', exact: true }).click()
    const notice = purchase.getByTestId('account-subscription-plan-changed')
    await notice.getByText('价格已更新', { exact: true }).waitFor()
    assert.equal(await notice.getByText('价格由 ¥29 调整为 ¥39，请确认后重新支付。', { exact: true }).count(), 1)
    await purchase.getByText('¥39', { exact: true }).waitFor()
    assert.equal(await purchase.getByText('¥29', { exact: true }).count(), 0)
    // 没下单，卡片上的价也换了。
    assert.deepEqual(await subscriptionCalls(page), [])
    await page.getByTestId('account-recharge-plans').getByText('¥39', { exact: true }).waitFor()

    // 看过新价再点一次才下单，等结果那块写的也是新价。
    await purchase.getByRole('button', { name: '打开支付窗口', exact: true }).click()
    await page.getByTestId('account-payment-notice').getByText('XM-VISUAL-SUBSCRIPTION', { exact: true }).waitFor()
    assert.deepEqual((await subscriptionCalls(page)).map((call) => call.name), ['create-subscription-payment'])
    await page.locator('.v2-recharge-big', { hasText: '¥39' }).waitFor()
  } finally {
    await page.close()
  }
})

test('a purchase dialog left open follows a reread plan list instead of charging the balance at the old price', async () => {
  const page = await fixture('page=account&accountTab=recharge&subscriptionExternal=1&planBalancePay=1', (next) => next.clock.install())
  try {
    await page.getByRole('button', { name: '购买', exact: true }).click()
    const purchase = page.getByRole('dialog', { name: '购买外部订阅' })
    await purchase.getByRole('button', { name: '使用余额支付 $5', exact: true }).waitFor()

    // 框一直开着，客户切走一阵再回来：窗口回到前台时列表重读，框里跟着换成新价。
    await page.evaluate(() => window.subscriptionPlanHarness.set({ priceAmount: 8 }))
    await page.clock.fastForward(61_000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await purchase.getByTestId('account-subscription-plan-changed')
      .getByText('价格由 $5 调整为 $8，请确认后重新支付。', { exact: true }).waitFor()
    await purchase.getByText('余额 $10.00，扣除后剩余 $2.00', { exact: true }).waitFor()
    assert.deepEqual(await subscriptionCalls(page), [])

    await purchase.getByRole('button', { name: '使用余额支付 $8', exact: true }).click()
    await waitForToast(page, '外部订阅已开通')
    assert.deepEqual(await subscriptionCalls(page), [{ name: 'purchase-subscription-balance', args: 1 }])
  } finally {
    await page.close()
  }
})

test('a plan taken down while its purchase dialog is open cannot be bought from the stale dialog', async () => {
  const page = await fixture('page=account&accountTab=recharge&subscriptionExternal=1&planBalancePay=1', (next) => next.clock.install())
  try {
    await page.getByRole('button', { name: '购买', exact: true }).click()
    const purchase = page.getByRole('dialog', { name: '购买外部订阅' })
    const pay = purchase.getByRole('button', { name: '使用余额支付 $5', exact: true })
    await pay.waitFor()
    await page.evaluate(() => window.subscriptionPlanHarness.remove())

    await pay.click()
    const notice = purchase.getByTestId('account-subscription-plan-changed')
    await notice.getByText('该套餐已下架', { exact: true }).waitFor()
    assert.equal(await notice.getByText('请关闭此窗口，选择其他套餐。', { exact: true }).count(), 1)
    assert.equal(await pay.isDisabled(), true)
    assert.deepEqual(await subscriptionCalls(page), [])
    await assertNoToast(page, '外部订阅已开通')
    await page.getByTestId('account-recharge-plans').waitFor({ state: 'detached' })

    // 框还开着，后台又把它上架了：窗口回到前台重读以后，那条收起、付款按钮能点。
    await page.evaluate(() => window.subscriptionPlanHarness.restore())
    await page.clock.fastForward(61_000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await notice.waitFor({ state: 'detached' })
    assert.equal(await pay.isDisabled(), false)
  } finally {
    await page.close()
  }
})

test('the payment terminal listener survives re-renders and still resolves a pending order', async () => {
  const page = await fixture('page=account&subscriptionExternal=1')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.getByRole('button', { name: '购买', exact: true }).waitFor()
    const subscribed = await page.evaluate(() => window.paymentTerminalSubscriptions())
    // 充值那一块一个；下面「我的订单」一个（付款成功就重读订单），v4 起两块在同一页。
    assert.equal(subscribed.live, 2)

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
    assert.equal(afterRerenders.live, 2)

    // 重渲染之后到达的回调仍然落到同一个待支付订单上
    await page.getByRole('button', { name: '购买', exact: true }).click()
    await page.getByRole('button', { name: '打开支付窗口', exact: true }).click()
    await page.getByTestId('account-payment-notice').getByText('XM-VISUAL-SUBSCRIPTION', { exact: true }).waitFor()
    await page.evaluate(async () => {
      window.rerenderFixture()
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'closed', tradeNo: 'XM-VISUAL-SUBSCRIPTION' }))
    await page.getByText('支付窗口已关闭', { exact: true }).waitFor()
    assert.equal(await page.getByText('等待支付结果', { exact: true }).count(), 0)
    assert.equal((await page.evaluate(() => window.paymentTerminalSubscriptions())).live, 2)
  } finally {
    await page.close()
  }
})

// 「本次充值」那张卡上几行合成一句比对：到账的大字在卡上，下面是实付、赠送和充值后余额。
const flat = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim()

test('recharge presets show credited, paid and bonus, and the quote dialog spells the bonus out', async () => {
  const page = await fixture('page=account&topupBonus=1')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    const plain = page.getByRole('button', { name: '到账 $10，实付 10.00', exact: true })
    const bonus = page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true })
    await plain.waitFor()
    await bonus.click()
    assert.equal(await bonus.getAttribute('aria-pressed'), 'true')
    const summary = page.getByTestId('account-recharge-summary')
    const breakdown = page.getByTestId('account-recharge-breakdown')
    assert.match(await flat(summary), /^本次充值 \$20 到账/)
    assert.equal(await flat(breakdown), '实付 16.00 其中活动赠送 $4（多送 25%） 充值后余额 $30.00')
    await plain.click()
    assert.equal(await flat(breakdown), '实付 10.00 充值后余额 $20.00')
    // 自定义金额一填，快捷金额就不再选中；清空又回到刚才那一档。
    await page.getByLabel('自定义金额').fill('37')
    await breakdown.getByText('37.00', { exact: true }).waitFor()
    assert.equal(await flat(breakdown), '实付 37.00 充值后余额 $47.00')
    assert.equal(await plain.getAttribute('aria-pressed'), 'false')
    await page.getByLabel('自定义金额').fill('')
    assert.equal(await plain.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.getByText('无赠送', { exact: true }).count(), 0)
    await bonus.click()
    await page.getByTestId('account-recharge-submit').click()
    const quote = page.getByRole('dialog', { name: '确认充值报价' })
    await quote.waitFor()
    assert.equal(await flat(quote.getByTestId('account-recharge-quote-bonus')), '其中活动赠送 $4（多送 25%）')
    assert.match(await flat(quote), /到账 \$20 其中活动赠送 \$4（多送 25%） 应付金额 16\.00 支付方式 Stripe/)
  } finally {
    await page.close()
  }
})

test('the quote dialog asks for the current promotion instead of the one the page loaded with', async () => {
  const page = await fixture('page=account&accountTab=recharge&topupBonus=1')
  try {
    await page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true }).click()
    await page.evaluate(() => window.endTopupPromotion())
    await page.getByTestId('account-recharge-submit').click()
    const quote = page.getByRole('dialog', { name: '确认充值报价' })
    await quote.getByText('20.00', { exact: true }).waitFor()
    assert.match(await flat(quote), /应付金额 20\.00/)
    assert.equal(await quote.getByTestId('account-recharge-quote-bonus').count(), 0)
    // 卡片也跟着这次读到的换掉，不再挂「送 25%」。
    await page.getByRole('button', { name: '到账 $20，实付 20.00', exact: true }).waitFor()
    assert.equal(await page.getByText('送 25%', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('the recharge page rereads offers when the customer comes back to it, at most once a minute', async () => {
  const page = await fixture('page=account&accountTab=recharge&topupBonus=1', (next) => next.clock.install())
  try {
    const reads = async () => (await calls(page)).filter((call) => call.name === 'get-topup-info').length
    await page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true }).waitFor()
    assert.equal(await reads(), 1)
    await page.evaluate(() => window.endTopupPromotion())
    // 分页一切过去，重读（如果要读）就在同一次提交里发出去了：等到分页选中再数。
    const open = async (name) => {
      await page.getByRole('tab', { name, exact: true }).click()
      await page.locator('[role="tab"][aria-selected="true"]', { hasText: name }).waitFor()
    }
    // 刚读过：来回切一下不再问，免得逐档试算撞上限流。
    await open('账号安全')
    await open('充值订阅')
    assert.equal(await reads(), 1)
    assert.equal(await page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true }).count(), 1)

    await page.clock.fastForward(61_000)
    await open('账号安全')
    await open('充值订阅')
    await page.getByRole('button', { name: '到账 $20，实付 20.00', exact: true }).waitFor()
    assert.equal(await reads(), 2)
    assert.equal(await page.getByText('送 25%', { exact: true }).count(), 0)

    // 外壳切到别的页再回来（个人中心整页藏起来过）。
    await page.clock.fastForward(61_000)
    await page.evaluate(() => window.setPageActive(false))
    await page.evaluate(() => window.setPageActive(true))
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-topup-info').length > count, 2)

    // 停在充值页缩到托盘，隔一阵从托盘点开：窗口回到前台也重读。
    await page.clock.fastForward(61_000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction((count) => JSON.parse(document.documentElement.dataset.calls || '[]').filter((call) => call.name === 'get-topup-info').length > count, 3)

    // 停在别的分页时窗口回到前台，不替充值页去读（focus 的处理是同步的，派发完就能数）。
    await open('账号安全')
    await page.clock.fastForward(61_000)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    assert.equal(await reads(), 4)
  } finally {
    await page.close()
  }
})

test('a tier picked on the home activity card arrives preselected on the recharge page', async () => {
  const page = await fixture('page=account&accountTab=recharge&rechargeAmount=20&topupBonus=1')
  try {
    const breakdown = page.getByTestId('account-recharge-breakdown')
    await breakdown.getByText('16.00', { exact: true }).waitFor()
    // 是快捷金额里的一档：选中那一档，自定义金额空着。
    assert.equal(await page.getByLabel('自定义金额').inputValue(), '')
    assert.equal(await flat(breakdown), '实付 16.00 其中活动赠送 $4（多送 25%） 充值后余额 $30.00')
    assert.equal(
      await page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true }).getAttribute('aria-pressed'),
      'true',
    )
  } finally {
    await page.close()
  }
})

test('an amount outside the quick tiers is still quoted on the summary', async () => {
  // 活动卡片带来的 30 不在后台的档位（10、20）里：自定义金额框写着它，「实付」也要问出来，不能一直转。
  const page = await fixture('page=account&accountTab=recharge&rechargeAmount=30')
  try {
    const breakdown = page.getByTestId('account-recharge-breakdown')
    await breakdown.getByText('30.00', { exact: true }).waitFor()
    assert.equal(await page.getByLabel('自定义金额').inputValue(), '30')
    assert.equal(await flat(breakdown), '实付 30.00 充值后余额 $40.00')
  } finally {
    await page.close()
  }
})

test('a default amount below the minimum says why recharging is unavailable', async () => {
  const page = await fixture('page=account&accountTab=recharge&highMinimum=1')
  try {
    await page.getByText('充值金额不能低于 20，请输入整数', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('account-recharge-submit').isDisabled(), true)
    await page.getByRole('button', { name: /^到账 \$20，实付 20\.00/ }).click()
    assert.equal(await page.getByText('充值金额不能低于 20，请输入整数', { exact: true }).count(), 0)
    assert.equal(await page.getByTestId('account-recharge-submit').isDisabled(), false)
  } finally {
    await page.close()
  }
})

test('changing the recharge channel invalidates the previous quote', async () => {
  const page = await fixture('page=account&multiPayment=1')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.getByRole('radio', { name: 'Stripe', exact: true }).check()
    await page.getByTestId('account-recharge-submit').click()
    const quote = page.getByRole('dialog', { name: '确认充值报价' })
    await quote.waitFor()
    await quote.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByRole('radio', { name: '支付宝', exact: true }).check()
    assert.equal(await page.getByRole('dialog', { name: '确认充值报价' }).count(), 0)
    // 支付宝最低 20：金额跟着挪到 20 那一档。
    assert.equal(await page.getByLabel('自定义金额').inputValue(), '')
    assert.equal(await page.getByRole('button', { name: /^到账 \$20/ }).getAttribute('aria-pressed'), 'true')
  } finally {
    await page.close()
  }
})

// 「正在确认价格…」那一段：试算挂着，等测试放开。
async function holdTopupQuote(page) {
  await page.evaluate(() => window.topupQuoteHarness.holdNext())
  await page.getByTestId('account-recharge-submit').click()
  await page.locator('[data-testid="account-recharge-submit"][aria-busy="true"]').waitFor()
}
const topupPaymentAmounts = async (page) =>
  (await calls(page)).filter((call) => call.name === 'create-topup-payment').map((call) => call.args.amount)

test('the recharge form is locked while the price is being confirmed, so the quote and payment keep the chosen tier', async () => {
  const page = await fixture('page=account&accountTab=recharge&topupBonus=1')
  try {
    const ten = page.getByRole('button', { name: '到账 $10，实付 10.00', exact: true })
    const twenty = page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true })
    await ten.waitFor()
    await twenty.click()
    await holdTopupQuote(page)
    assert.equal(await ten.isDisabled(), true)
    assert.equal(await page.getByLabel('自定义金额').isDisabled(), true)
    assert.equal(await page.getByRole('radio', { name: 'Stripe', exact: true }).isDisabled(), true)
    // 算价途中点另一档：点不动，选中的还是 20。
    await ten.click({ force: true })
    assert.equal(await twenty.getAttribute('aria-pressed'), 'true')

    await page.evaluate(() => window.topupQuoteHarness.release())
    const quote = page.getByRole('dialog', { name: '确认充值报价' })
    await quote.waitFor()
    assert.match(await flat(quote), /到账 \$20 其中活动赠送 \$4（多送 25%） 应付金额 16\.00/)
    await quote.getByRole('button', { name: '打开支付窗口' }).click()
    await page.getByText('等待支付结果', { exact: true }).waitFor()
    assert.deepEqual(await topupPaymentAmounts(page), [20])
  } finally {
    await page.close()
  }
})

test('a tier picked on the home activity card while the price is being confirmed drops the stale quote', async () => {
  const page = await fixture('page=account&accountTab=recharge&topupBonus=1')
  try {
    await page.getByRole('button', { name: '到账 $10，实付 10.00', exact: true }).waitFor()
    await page.getByRole('button', { name: '到账 $20，实付 16.00，送 25%', exact: true }).click()
    await holdTopupQuote(page)
    // 停在充值页时从首页活动卡片又点了 10 那一档。
    await page.evaluate(() => window.pickRechargeTier(10))
    await page.getByRole('button', { name: '到账 $10，实付 10.00', exact: true, pressed: true }).waitFor()

    // 按 20 问回来的那次不认：不弹确认框，按钮回到「充值」。
    await page.evaluate(() => window.topupQuoteHarness.release())
    await page.locator('[data-testid="account-recharge-submit"]:not([aria-busy])').waitFor()
    assert.equal(await page.getByRole('dialog', { name: '确认充值报价' }).count(), 0)

    // 照新档位再点一次：确认框和付款都按 10。
    await page.getByTestId('account-recharge-submit').click()
    const quote = page.getByRole('dialog', { name: '确认充值报价' })
    await quote.waitFor()
    assert.match(await flat(quote), /到账 \$10 应付金额 10\.00/)
    await quote.getByRole('button', { name: '打开支付窗口' }).click()
    await page.getByText('等待支付结果', { exact: true }).waitFor()
    assert.deepEqual(await topupPaymentAmounts(page), [10])
  } finally {
    await page.close()
  }
})

test('each recharge dialog opens without the error left by the previous one', async () => {
  const page = await fixture('page=account&accountTab=recharge&subscriptionExternal=1&fail=redeem')
  try {
    const redeem = page.getByRole('dialog', { name: '兑换充值码' })
    await page.getByTestId('account-recharge-redeem-open').click()
    await redeem.getByLabel('充值码', { exact: true }).fill('USED-CARD')
    await redeem.getByTestId('account-redeem').click()
    await redeem.getByText('充值码无效或已被使用', { exact: true }).waitFor()
    await redeem.getByRole('button', { name: '取消', exact: true }).click()
    await redeem.waitFor({ state: 'hidden' })

    // 换去买套餐：弹窗里不再挂着充值码那句。
    await page.getByRole('button', { name: '购买', exact: true }).click()
    const purchase = page.getByRole('dialog', { name: '购买外部订阅' })
    await purchase.waitFor()
    assert.equal(await purchase.getByText('充值码无效或已被使用', { exact: true }).count(), 0)
    await purchase.getByRole('button', { name: '取消', exact: true }).click()
    await purchase.waitFor({ state: 'hidden' })

    // 再打开充值码弹窗也是干净的。
    await page.getByTestId('account-recharge-redeem-open').click()
    await redeem.waitFor()
    assert.equal(await redeem.getByText('充值码无效或已被使用', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('a price check that fails while the redeem dialog is open stays out of that dialog', async () => {
  const page = await fixture('page=account&accountTab=recharge')
  try {
    await page.getByRole('button', { name: '到账 $10，实付 10.00', exact: true }).waitFor()
    await holdTopupQuote(page)
    await page.getByTestId('account-recharge-redeem-open').click()
    const redeem = page.getByRole('dialog', { name: '兑换充值码' })
    await redeem.waitFor()
    await page.evaluate(() => window.topupQuoteHarness.fail('报价服务暂时不可用'))
    // 只上页头那条，充值码弹窗里不摆。
    await page.getByText('报价服务暂时不可用', { exact: true }).waitFor()
    assert.equal(await redeem.getByText('报价服务暂时不可用', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('confirmed topup completion refreshes balance and cached orders and clears waiting state', async () => {
  for (const fast of [false, true]) {
    const page = await fixture(`page=account${fast ? '&fastPayment=1' : ''}`)
    try {
      await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
      await page.getByTestId('account-orders-section').getByText('TEST-ORDER').waitFor()
      const ordersBefore = (await calls(page)).filter((call) => call.name === 'query-orders').length
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
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.getByTestId('account-recharge-submit').click()
    await page.getByRole('dialog', { name: '确认充值报价' }).getByRole('button', { name: '打开支付窗口' }).click()
    await page.getByText('等待支付结果', { exact: true }).waitFor()
    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'closed', tradeNo: 'XM-VISUAL-TOPUP', confirming: true }))
    const notice = page.getByTestId('account-payment-notice')
    await notice.getByText('到账后余额将自动更新', { exact: false }).waitFor()
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

test('the recharge page close button keeps confirming a paid order like the window close button', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.getByTestId('account-recharge-submit').click()
    await page.getByRole('dialog', { name: '确认充值报价' }).getByRole('button', { name: '打开支付窗口' }).click()
    await page.getByText('等待支付结果', { exact: true }).waitFor()
    await page.getByRole('button', { name: '关闭支付窗口', exact: true }).click()
    const notice = page.getByTestId('account-payment-notice')
    await notice.getByText('正在确认订单 XM-VISUAL-TOPUP 是否到账…', { exact: true }).waitFor()
    assert.equal(await page.getByText('等待支付结果', { exact: true }).count(), 0)
    assert.equal((await calls(page)).filter((call) => call.name === 'close-payment-window').length, 1)

    await page.evaluate(() => window.emitPaymentWindowTerminal({ status: 'success', tradeNo: 'XM-VISUAL-TOPUP' }))
    await page.getByText('订单 XM-VISUAL-TOPUP 已到账，余额已更新。', { exact: true }).waitFor()
    await page.getByText('当前余额 $14.00', { exact: true }).waitFor()
  } finally { await page.close() }
})

test('an unconfirmed payment opens my orders with its order number', async () => {
  const page = await fixture('page=account')
  try {
    await page.getByRole('tab', { name: '充值订阅', exact: true }).click()
    await page.getByTestId('account-recharge-submit').click()
    await page.getByRole('dialog', { name: '确认充值报价' }).getByRole('button', { name: '打开支付窗口' }).click()
    await page.getByText('等待支付结果', { exact: true }).waitFor()
    await page.evaluate(() => {
      window.emitPaymentWindowTerminal({ status: 'closed', tradeNo: 'XM-VISUAL-TOPUP', confirming: true })
      window.emitPaymentWindowTerminal({ status: 'unconfirmed', tradeNo: 'XM-VISUAL-TOPUP' })
    })
    await page.getByText('暂未确认到账', { exact: true }).waitFor()
    await page.getByTestId('account-payment-orders').click()
    await page.getByRole('tab', { name: '充值订阅', exact: true, selected: true }).waitFor()
    await page.getByTestId('account-orders-section').waitFor()
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
    await waitForToast(page, '已保存')
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
    await contrast.getByText('暂未获取', { exact: true }).waitFor()
    assert.equal(await page.getByText('本机不支持', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await page.getByRole('switch', { name: '高对比度', exact: true }).waitFor()
    assert.equal(await page.getByText('系统状态暂时读不到', { exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '重新读取', exact: true }).count(), 0)
    assert.equal(await contrast.getByText('暂未获取', { exact: true }).count(), 0)
  } finally {
    await page.close()
  }
})

test('the notification kinds sit under their own heading and say when the master switch silences them', async () => {
  const page = await fixture('page=settings&system=1')
  try {
    await page.getByRole('tab', { name: '消息通知', exact: true }).click()
    const kinds = page.getByTestId('settings-notification-kinds')
    await kinds.getByRole('heading', { name: '提醒事项', exact: true }).waitFor()
    assert.equal(await kinds.getByText('桌面通知关着，下面这些都不会提醒', { exact: true }).count(), 0)
    await page.getByRole('switch', { name: '桌面通知', exact: true }).click()
    await kinds.getByText('桌面通知关着，下面这些都不会提醒', { exact: true }).waitFor()
    assert.equal(await page.getByRole('switch', { name: '余额不足通知', exact: true }).isDisabled(), true)
    // 左栏搜出来的提醒项一样是灰的，那一句也跟着摆在搜索结果里。
    await page.getByTestId('settings-search').fill('余额不足')
    const results = page.getByTestId('settings-search-results')
    await results.getByText('桌面通知关着，下面这些都不会提醒', { exact: true }).waitFor()
    assert.equal(await results.getByRole('switch', { name: '余额不足通知', exact: true }).isDisabled(), true)
  } finally {
    await page.close()
  }
})

// v4 第 8 批：组名都是四个字；「账号」那一组去掉了，切换账号、退出登录在个人中心的账号概览里。
test('settings show the eight four-character groups without an account group, and the certificate row opens the check page entry it names', async () => {
  const page = await fixture('page=settings')
  try {
    const tabs = page.getByRole('tablist', { name: '设置分组', exact: true }).getByRole('tab')
    assert.deepEqual(await tabs.allInnerTexts(), ['外观显示', '启动关闭', '工具管理', '网络连接', '消息通知', '备份迁移', '隐私数据', '版本更新'])
    assert.equal(await page.locator('[data-testid="settings-switch-account"], [data-testid="settings-logout"], [data-testid="settings-account-center"], [data-testid="settings-account-login"]').count(), 0)
    await page.getByRole('tab', { name: '网络连接', exact: true }).click()
    await page.getByTestId('settings-certificate-health').click()
    assert.deepEqual(
      (await calls(page)).filter((call) => ['open-account-switcher', 'navigate'].includes(call.name)).map((call) => [call.name, call.args ?? null]),
      [['navigate', ['health', 'CERTIFICATE_TRUST']]],
    )
  } finally {
    await page.close()
  }
})

// 左栏「搜索设置」：搜到的几行直接摆在右边，能当场改；组名点一下回到那一组。
test('the settings search lists matching rows in place, links back to their group and says when nothing matches', async () => {
  const page = await fixture('page=settings&system=1')
  try {
    const search = page.getByTestId('settings-search')
    await search.fill('托盘')
    const results = page.getByTestId('settings-search-results')
    await results.waitFor()
    await page.getByRole('heading', { name: '搜索「托盘」', exact: true }).waitFor()
    await page.getByText('找到 1 项，可以直接在这里修改', { exact: true }).waitFor()
    assert.deepEqual(await results.locator('[data-anchor]').evaluateAll((rows) => rows.map((row) => row.dataset.anchor)), ['close-behavior'])
    // 搜索时左栏哪一组都不算选中。
    assert.equal(await page.getByRole('tab', { selected: true }).count(), 0)
    // 当场能改：点「直接退出」就存（夹具不回写这一项，只看存了什么）。
    await results.getByRole('button', { name: '直接退出', exact: true }).click()
    await page.waitForFunction(() => JSON.parse(document.documentElement.dataset.calls || '[]').some((call) => call.name === 'settings'))
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'settings').at(-1).args, { version: 2, closeBehavior: 'quit' })
    await results.getByRole('button', { name: '启动关闭', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-search"]')?.value === '')
    assert.equal(await page.getByRole('tab', { name: '启动关闭', exact: true }).getAttribute('aria-selected'), 'true')
    // 几个字都要对上；对不上给一句换个说法。
    await search.fill('镜像 托盘')
    await page.getByTestId('settings-search-empty').getByText('未找到相关设置', { exact: true }).waitFor()
    await page.getByText('请尝试其他关键词，如「托盘」「镜像」「快捷键」。', { exact: true }).waitFor()
    // 点左栏的组也会清掉搜索。
    await page.getByRole('tab', { name: '外观显示', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-search"]')?.value === '')
    await page.getByTestId('settings-theme').waitFor()
  } finally {
    await page.close()
  }
})

// YF-4：「怎么建飞书机器人」六步下面两颗，飞书开发者后台交给浏览器（白名单只收这一个网址），教程是星芒自己的那一章。
test('the Feishu setup steps open the developer console in the browser and the phone remote tutorial in place', async () => {
  const page = await fixture('page=remote')
  try {
    const form = page.getByTestId('settings-remote-card').getByTestId('settings-remote-feishu-form')
    await form.getByText('如何创建飞书机器人', { exact: true }).click()
    await form.getByRole('button', { name: '打开飞书开放平台', exact: true }).click()
    await form.getByRole('button', { name: '查看教程', exact: true }).click()
    const recorded = await calls(page)
    assert.deepEqual(
      recorded.filter((call) => call.name === 'openExternal' || call.name === 'navigate').map((call) => [call.name, call.args ?? null]),
      [
        ['openExternal', 'https://open.feishu.cn/app'],
        ['navigate', ['tutorial', 'phone-remote']],
      ],
    )
    assert.equal(await page.getByRole('alert').count(), 0)
  } finally {
    await page.close()
  }
})

// YF-19：电脑上加几个工作文件夹，使用中的标出来，别的能换过去、能移除；满 5 个「添加文件夹」灰掉。
test('the phone remote card lists several working folders, switches between them and stops adding at five', async () => {
  const page = await fixture('page=remote&remoteReady&remoteFolders')
  try {
    const card = page.getByTestId('settings-remote-card')
    const list = card.getByTestId('settings-remote-workspace-list')
    await list.waitFor()
    assert.deepEqual(await list.locator('.v2-remote-folder > .xm-mono').allInnerTexts(), ['~/projects/demo', '~/projects/blog', '~/projects/shop'])
    const rowOf = (folder) => list.locator('.v2-remote-folder').filter({ hasText: folder })
    await rowOf('~/projects/demo').getByTestId('settings-remote-workspace-in-use').getByText('使用中', { exact: true }).waitFor()
    await list.getByText('也可在手机上发送「文件夹」切换。', { exact: true }).waitFor()
    await rowOf('~/projects/blog').getByRole('button', { name: '使用此文件夹', exact: true }).click()
    await rowOf('~/projects/blog').getByTestId('settings-remote-workspace-in-use').waitFor()
    assert.equal(await rowOf('~/projects/demo').getByRole('button', { name: '移除', exact: true }).count(), 1)
    await rowOf('~/projects/shop').getByRole('button', { name: '移除', exact: true }).click()
    await rowOf('~/projects/shop').waitFor({ state: 'detached' })
    const add = card.getByTestId('settings-remote-workspace')
    assert.equal(await add.innerText(), '添加文件夹')
    for (let count = 2; count < 5; count += 1) {
      await add.click()
      await list.locator('.v2-remote-folder').nth(count).waitFor()
    }
    await list.getByText('最多 5 个，请先移除一个再添加。', { exact: true }).waitFor()
    assert.equal(await add.isDisabled(), true)
    assert.deepEqual((await calls(page)).filter((call) => call.name.startsWith('remote-workspace')).map((call) => [call.name, call.args ?? null]), [
      ['remote-workspace-use', '~/projects/blog'],
      ['remote-workspace-remove', '~/projects/shop'],
      ['remote-workspace', null],
      ['remote-workspace', null],
      ['remote-workspace', null],
    ])
  } finally {
    await page.close()
  }
})

// 手机遥控 Codex：先选文件夹、填飞书应用，打开遥控，再配对；App Secret 不进记录，填错了当场说。
test('the phone remote card walks through folder, Feishu app, switch and pairing, and never records the app secret', async () => {
  const page = await fixture('page=remote')
  try {
    const card = page.getByTestId('settings-remote-card')
    await card.getByTestId('settings-remote-feishu-state').getByText('未开启', { exact: true }).waitFor()
    const toggle = card.getByRole('switch', { name: '打开飞书遥控', exact: true })
    assert.equal(await toggle.isDisabled(), true)
    await card.getByText('请先在上方填写飞书应用信息。', { exact: true }).waitFor()
    await card.getByTestId('settings-remote-workspace').click()
    await card.getByText('~/projects/demo', { exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-remote-workspace').innerText(), '添加文件夹')
    await card.getByTestId('settings-remote-feishu-app-id').fill('cli_a1b2c3d4e5')
    await card.getByTestId('settings-remote-feishu-app-secret').fill('wrong-secret')
    await card.getByTestId('settings-remote-feishu-save').click()
    await card.getByRole('alert').getByText('飞书应用的 App ID 或 App Secret 不正确，请在飞书开放平台核对后重新填写。').waitFor()
    // 填错了框里的字留着，改一下再存就行。
    assert.equal(await card.getByTestId('settings-remote-feishu-app-secret').inputValue(), 'wrong-secret')
    await card.getByTestId('settings-remote-feishu-app-secret').fill('rightSecret123')
    await card.getByTestId('settings-remote-feishu-save').click()
    await card.getByTestId('settings-remote-feishu-app').getByText('App ID：cli_a1b2c3d4e5', { exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-remote-feishu-form').count(), 0)
    assert.equal(await card.getByRole('alert').count(), 0)
    // YF-1：保存以后还差的几步留在卡上，配对成功才收起。
    await card.getByTestId('settings-remote-feishu-next').getByText('已保存。请完成以下步骤，手机端方可接收消息', { exact: true }).waitFor()
    await card.getByText('尚未配对。开启遥控后方可配对。', { exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-remote-feishu-pair').isDisabled(), true)
    await toggle.click()
    await card.getByTestId('settings-remote-feishu-state').getByText('已连接', { exact: true }).waitFor()
    // 说 Codex 在干什么的那句挪到了页头右边。
    await page.getByTestId('settings-remote-meta').getByText('Codex 空闲', { exact: true }).waitFor()
    await card.getByTestId('settings-remote-feishu-pair').click()
    await card.getByTestId('settings-remote-feishu-code').getByText('482915', { exact: true }).waitFor()
    await card.getByText('在飞书中打开您创建的机器人，私聊发送这 6 位数字。10 分钟内有效。', { exact: true }).waitFor()
    // 手机那头发对了配对码：主进程推一份新快照，卡上换成绑定用户。
    await page.evaluate(() => window.remoteHarness.pair('小明'))
    await card.getByTestId('settings-remote-feishu-peer').getByText(/^小明（尾号 9f3c），10 月 25 日 \d\d:\d\d 配对$/).waitFor()
    assert.equal(await card.getByTestId('settings-remote-feishu-pair').innerText(), '重新配对')
    assert.equal(await card.getByTestId('settings-remote-feishu-next').count(), 0)
    await card.getByTestId('settings-remote-feishu-guide').getByText('如何创建飞书机器人', { exact: true }).waitFor()
    // 解绑先问一句：点「取消」什么都不做，点「解绑」才解。
    const confirm = card.getByTestId('settings-remote-feishu-confirm')
    await card.getByTestId('settings-remote-feishu-unbind').click()
    await confirm.getByRole('heading', { name: '解绑？', exact: true }).waitFor()
    await confirm.getByText('解绑后，该用户将无法通过手机遥控本机，如需使用需重新配对。', { exact: true }).waitFor()
    await confirm.getByRole('button', { name: '取消', exact: true }).click()
    await confirm.waitFor({ state: 'detached' })
    assert.equal(await card.getByTestId('settings-remote-feishu-unbind').count(), 1)
    assert.equal((await calls(page)).some((call) => call.name === 'remote-unbind'), false)
    await card.getByTestId('settings-remote-feishu-unbind').click()
    await confirm.getByRole('button', { name: '解绑', exact: true }).click()
    await confirm.waitFor({ state: 'detached' })
    await card.getByText('尚未配对。请点击「开始配对」，将配对码私聊发送给机器人。', { exact: true }).waitFor()
    // 退出登录也先问：确认后凭据清掉、遥控关掉，回到填应用的框。
    await card.getByRole('button', { name: '退出飞书登录', exact: true }).click()
    await confirm.getByRole('heading', { name: '退出飞书登录？', exact: true }).waitFor()
    await confirm.getByText('退出后需重新填写机器人凭据，方可继续使用手机遥控。', { exact: true }).waitFor()
    await confirm.getByRole('button', { name: '退出登录', exact: true }).click()
    await confirm.waitFor({ state: 'detached' })
    await card.getByTestId('settings-remote-feishu-form').waitFor()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    const recorded = await calls(page)
    assert.deepEqual(
      recorded.filter((call) => call.name.startsWith('remote-')).map((call) => [call.name, call.args ?? null]),
      [
        ['remote-workspace', null],
        ['remote-feishu-save', 'cli_a1b2c3d4e5'],
        ['remote-feishu-save', 'cli_a1b2c3d4e5'],
        ['remote-enable', ['feishu', true]],
        ['remote-pair', 'feishu'],
        ['remote-unbind', 'feishu'],
        ['remote-clear', 'feishu'],
      ],
    )
    assert.equal(JSON.stringify(recorded).includes('rightSecret123'), false)
  } finally {
    await page.close()
  }
})

// D23：飞书停下来时只说三种固定的话，各配按钮：重新填写、重新连接、找客服。
test('the Feishu block says one of three fixed sentences when it stops and gives each its buttons', async () => {
  const page = await fixture('page=remote&remoteReady=1&help=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    await card.getByRole('switch', { name: '打开飞书遥控', exact: true }).click()
    await card.getByTestId('settings-remote-feishu-state').getByText('已连接', { exact: true }).waitFor()
    const status = card.getByTestId('settings-remote-feishu-status')

    await page.evaluate(() => window.remoteHarness.feishuProblem('other'))
    await status.getByText('未能建立连接，请点击「重新连接」重试；如问题仍存在，请点击「联系客服」。', { exact: true }).waitFor()
    await card.getByTestId('settings-remote-feishu-support').click()
    assert.equal((await callsNamed(page, 'open-help')).length, 1)
    await card.getByTestId('settings-remote-feishu-reconnect').click()
    await card.getByTestId('settings-remote-feishu-state').getByText('已连接', { exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-remote-feishu-status-actions').count(), 0)

    await page.evaluate(() => window.remoteHarness.feishuProblem('connection-limit'))
    await status.getByText('该飞书应用已在其他位置连接，请先断开其他连接后重试。', { exact: true }).waitFor()
    await card.getByTestId('settings-remote-feishu-reconnect').waitFor()
    assert.equal(await card.getByTestId('settings-remote-feishu-support').count(), 0)
    await card.getByTestId('settings-remote-feishu-reconnect').click()
    await card.getByTestId('settings-remote-feishu-state').getByText('已连接', { exact: true }).waitFor()

    // 凭据不对：不另摆按钮，下面那颗「重新填写」就是它的，点了打开填写框。
    await page.evaluate(() => window.remoteHarness.feishuProblem('credential'))
    await status.getByText('飞书应用的 App ID 或 App Secret 不正确，请在飞书开放平台核对后重新填写。', { exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-remote-feishu-reconnect').count(), 0)
    await card.getByTestId('settings-remote-feishu-edit').click()
    await card.getByTestId('settings-remote-feishu-form').waitFor()

    assert.deepEqual((await callsNamed(page, 'remote-reconnect')).map((call) => call.args), ['feishu', 'feishu'])
  } finally {
    await page.close()
  }
})

// 微信那一块：二维码由主进程画好给过来；手机上要输数字时停下来等输，输错了当场说；登录好了卡上换成机器人编号。
test('the WeChat block logs in through the QR dialog, asks for the number on the phone and then shows the bot', async () => {
  const page = await fixture('page=remote')
  try {
    const card = page.getByTestId('settings-remote-card')
    // 微信那一块要在连接方式里点「微信」才摆出来；标签「实验功能」在那张卡上。
    assert.equal(await card.getByTestId('settings-remote-weixin').count(), 0)
    const tab = card.getByTestId('remote-method-weixin')
    await tab.click()
    assert.equal(await tab.getAttribute('aria-selected'), 'true')
    await tab.getByText('实验功能', { exact: true }).waitFor()
    const block = card.getByTestId('settings-remote-weixin')
    await block.getByTestId('settings-remote-weixin-warning').getByText('实验功能，可能随时中断', { exact: true }).waitFor()
    await block.getByText('请先在上方使用微信扫码登录。', { exact: true }).waitFor()
    assert.equal(await card.getByRole('switch', { name: '打开微信遥控', exact: true }).isDisabled(), true)
    assert.equal(await card.getByRole('button', { name: '退出微信登录', exact: true }).count(), 0)
    await block.getByTestId('settings-remote-weixin-login-start').click()
    const dialog = page.getByTestId('settings-remote-weixin-dialog')
    const qr = dialog.getByRole('img', { name: '微信登录二维码', exact: true })
    await qr.waitFor()
    assert.match(await qr.getAttribute('src'), /^data:image\/png;base64,/)
    await dialog.getByText('请使用手机微信「扫一扫」扫码，并在手机上确认。二维码 5 分钟内有效。', { exact: true }).waitFor()
    await page.evaluate(() => window.remoteHarness.weixinScanned())
    await dialog.getByText('手机微信上显示了一组数字，请在下方输入', { exact: true }).waitFor()
    assert.equal(await qr.count(), 0)
    const code = dialog.getByTestId('settings-remote-weixin-code')
    await code.fill('1111')
    await dialog.getByTestId('settings-remote-weixin-code-submit').click()
    await dialog.getByText('数字不正确，请对照手机上显示的数字重新输入', { exact: true }).waitFor()
    await code.fill('2580')
    await dialog.getByTestId('settings-remote-weixin-code-submit').click()
    // 过了手机上那串数字：扫码的人直接绑上，不用配对码（YF-5）。
    await dialog.getByText('微信已登录并已绑定当前微信。请开启下方「打开遥控」。', { exact: true }).waitFor()
    await block.getByText('已登录：ClawBot decb', { exact: true }).waitFor()
    await block.getByText(/^尾号 c0de 的账号/).waitFor()
    await dialog.getByTestId('settings-remote-weixin-close').click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await block.getByTestId('settings-remote-weixin-login-start').innerText(), '重新扫码')
    // 微信的退出登录框说的是重新扫码，不是重新填凭据；点「取消」什么都不做。
    await card.getByRole('button', { name: '退出微信登录', exact: true }).click()
    const logoutConfirm = card.getByTestId('settings-remote-weixin-confirm')
    await logoutConfirm.getByRole('heading', { name: '退出微信登录？', exact: true }).waitFor()
    await logoutConfirm.getByText('退出后需重新使用微信扫码登录，方可继续使用手机遥控。', { exact: true }).waitFor()
    await logoutConfirm.getByRole('button', { name: '取消', exact: true }).click()
    await logoutConfirm.waitFor({ state: 'detached' })
    assert.equal((await calls(page)).some((call) => call.name === 'remote-clear'), false)
    // 重新扫码又不扫了：点取消，主进程那边的这次登录一起收掉。
    await block.getByTestId('settings-remote-weixin-login-start').click()
    await dialog.getByRole('img', { name: '微信登录二维码', exact: true }).waitFor()
    await dialog.getByTestId('settings-remote-weixin-cancel').click()
    await dialog.waitFor({ state: 'detached' })
    const recorded = await calls(page)
    assert.deepEqual(
      recorded.filter((call) => call.name.startsWith('remote-weixin')).map((call) => [call.name, call.args ?? null]),
      [
        ['remote-weixin-login-start', null],
        ['remote-weixin-login-poll', null],
        ['remote-weixin-login-poll', '1111'],
        ['remote-weixin-login-poll', '2580'],
        ['remote-weixin-login-poll', null],
        ['remote-weixin-login-start', null],
        ['remote-weixin-login-poll', null],
        ['remote-weixin-login-cancel', '0f8fad5b-d9cb-469f-a165-70867728950e'],
      ],
    )
  } finally {
    await page.close()
  }
})

// YK-5：手机上收到「Codex 启动失败」，电脑卡片上也有一条黄条，点一下去首页；Codex 又起来了就收起。
test('the phone remote card says Codex could not start and leads to the home page until Codex starts again', async () => {
  const page = await fixture('page=remote&remoteReady=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    await card.getByTestId('settings-remote-workspace-row').waitFor()
    assert.equal(await card.getByTestId('settings-remote-codex-failed').count(), 0)
    await page.evaluate(() => window.remoteHarness.codexStartFailed(true))
    const notice = card.getByTestId('settings-remote-codex-failed')
    await notice.getByText('Codex 启动失败', { exact: true }).waitFor()
    await notice.getByText('手机刚发送的指令未执行。请前往首页检查 Codex，恢复后在手机上重新发送。', { exact: true }).waitFor()
    await notice.getByRole('button', { name: '前往首页查看 Codex', exact: true }).click()
    assert.equal((await callsNamed(page, 'navigate')).at(-1).args, 'home')
    await page.evaluate(() => window.remoteHarness.codexStartFailed(false))
    await notice.waitFor({ state: 'detached' })
  } finally {
    await page.close()
  }
})

// YF-9：卡片最后一行「打开星芒时自动打开遥控」默认关，点开、点关都记给主进程，开着时飞书那个开关不跟着动。
test('the phone remote card lets the customer turn on opening the remote whenever the manager starts, off by default', async () => {
  const page = await fixture('page=remote&remoteReady=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    const row = card.getByTestId('settings-remote-auto-start')
    await row.getByText('开启后，每次打开星芒将自动连接，无需在此手动开启。如星芒设为开机自启，即使无人在电脑前，也可通过手机操作。如有顾虑，请勿开启。', { exact: true }).waitFor()
    const toggle = row.getByRole('switch', { name: '打开星芒时自动打开遥控', exact: true })
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-remote-auto-start-switch"] button')?.getAttribute('aria-checked') === 'true')
    assert.equal(await card.getByRole('switch', { name: '打开飞书遥控', exact: true }).getAttribute('aria-checked'), 'false')
    await toggle.click()
    await page.waitForFunction(() => document.querySelector('[data-testid="settings-remote-auto-start-switch"] button')?.getAttribute('aria-checked') === 'false')
    assert.deepEqual((await callsNamed(page, 'remote-auto-start')).map((call) => call.args), [true, false])
    assert.equal((await callsNamed(page, 'remote-enable')).length, 0)
  } finally {
    await page.close()
  }
})

// YF-10：「多久没消息就自动关」缺省「不自动关闭」带小字；选 12 小时小字收起、「打开遥控」那行说明带上 12 小时，再选回不自动关闭又出来。
test('the phone remote card picks how long it may idle before closing, never by default', async () => {
  const page = await fixture('page=remote&remoteReady=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    const row = card.getByTestId('settings-remote-idle-close')
    const neverHint = '仅在电脑端、托盘中关闭，或在手机上发送「关闭遥控」时才会关闭。'
    await row.getByText(neverHint, { exact: true }).waitFor()
    const choice = row.getByRole('group', { name: '无消息自动关闭时间', exact: true })
    assert.equal(await choice.getByRole('button', { name: '不自动关闭', exact: true }).getAttribute('aria-pressed'), 'true')
    await card.getByText('开启期间电脑不会自动休眠，但合上笔记本盖子后仍会休眠。窗口缩到托盘后仍保持开启，退出星芒后才会断开，下次打开星芒需重新开启。', { exact: true }).waitFor()
    await choice.getByRole('button', { name: '12 小时', exact: true }).click()
    await row.getByText(neverHint, { exact: true }).waitFor({ state: 'detached' })
    assert.equal(await choice.getByRole('button', { name: '12 小时', exact: true }).getAttribute('aria-pressed'), 'true')
    await card.getByText('开启期间电脑不会自动休眠，但合上笔记本盖子后仍会休眠。窗口缩到托盘后仍保持开启，退出星芒后才会断开，下次打开星芒需重新开启；无消息 12 小时后也会自动断开。', { exact: true }).waitFor()
    await choice.getByRole('button', { name: '不自动关闭', exact: true }).click()
    await row.getByText(neverHint, { exact: true }).waitFor()
    assert.deepEqual((await callsNamed(page, 'remote-idle-close')).map((call) => call.args), [12, null])
  } finally {
    await page.close()
  }
})

// 0.2.25：连接方式两张卡是一组页签，点哪张下面摆哪张的设置；方向键也能换。飞书登录过就先摆飞书，微信那一大块和警告不摊着（YF-7 的用意）。
test('the phone remote page switches between the two ways to connect and shows only the chosen one\'s settings', async () => {
  const page = await fixture('page=remote&remoteReady=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    const feishuTab = card.getByTestId('remote-method-feishu')
    const weixinTab = card.getByTestId('remote-method-weixin')
    assert.equal(await feishuTab.getAttribute('aria-selected'), 'true')
    await weixinTab.getByText('未开启', { exact: true }).waitFor()
    await card.getByRole('heading', { name: '飞书设置', exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-remote-weixin').count(), 0)
    await weixinTab.click()
    await card.getByTestId('settings-remote-weixin').getByTestId('settings-remote-weixin-warning').waitFor()
    await card.getByRole('heading', { name: '微信设置', exact: true }).waitFor()
    assert.equal(await card.getByTestId('settings-remote-feishu').count(), 0)
    assert.equal(await weixinTab.getAttribute('aria-selected'), 'true')
    assert.equal(await feishuTab.getAttribute('aria-selected'), 'false')
    await weixinTab.press('ArrowLeft')
    await card.getByTestId('settings-remote-feishu').waitFor()
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'remote-method-feishu')
    // 「通用设置」一直在下面，不跟着换。
    await page.getByTestId('remote-shared').getByTestId('settings-remote-workspace-row').waitFor()
  } finally {
    await page.close()
  }
})

// 「手机端使用的模型」：选项跟首页 Codex「配置」里那张单一样，第一项与电脑端相同；选了就交给主进程记下。
test('the phone remote page picks the model for the phone from the Codex list and can follow the computer again', async () => {
  const page = await fixture('page=remote&remoteReady=1')
  try {
    const row = page.getByTestId('settings-remote-model')
    const select = row.getByRole('combobox', { name: '手机端使用的模型', exact: true })
    await row.getByText('如需更换，请前往首页 Codex 的「配置」修改，电脑端与手机端同时生效。', { exact: true }).waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="settings-remote-model-choice"] option').length === 4)
    assert.deepEqual(await select.locator('option').allInnerTexts(), ['与电脑端相同（fixture-model）', 'fixture-model', 'gpt-6.3-sol', 'gpt-6.1-mini'])
    await select.selectOption('gpt-6.3-sol')
    await row.getByText('仅手机端使用此模型，电脑端的 Codex 不受影响。', { exact: true }).waitFor()
    assert.equal(await select.inputValue(), 'gpt-6.3-sol')
    await select.selectOption('')
    await row.getByText('如需更换，请前往首页 Codex 的「配置」修改，电脑端与手机端同时生效。', { exact: true }).waitFor()
    assert.deepEqual((await callsNamed(page, 'remote-model')).map((call) => call.args), ['gpt-6.3-sol', null])
    assert.equal(await page.getByRole('alert').count(), 0)
  } finally {
    await page.close()
  }
})

// YF-13：「最近一次」只说几点发来的、做到哪儿了，不摆手机上的原话；「全部拒绝」「停止本轮」交给主进程，「查看记录」去记录页。
test('the phone remote card shows the last phone request and can stop it, decline what waits and open the records', async () => {
  const page = await fixture('page=remote&remoteReady=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    await page.evaluate(() => window.remoteHarness.phoneRequest({ minutesAgo: 3, state: 'running', pendingApprovals: 2 }))
    // 遥控没开着时不出这一行。
    assert.equal(await card.getByTestId('settings-remote-last-request').count(), 0)
    await card.getByRole('switch', { name: '打开飞书遥控', exact: true }).click()
    const row = card.getByTestId('settings-remote-last-request')
    await row.getByText('最近一次', { exact: true }).waitFor()
    // 刚过零点那几分钟，几分钟前发来的算昨天，前面带上日期（「11 月 11 日 23:57」）。
    assert.match(await row.getByTestId('settings-remote-last-request-text').innerText(), /^(?:\d{1,2} 月 \d{1,2} 日 )?\d\d:\d\d 收到指令，正在处理，已用时 3 分钟$/)
    await row.getByText('待确认 2 条，请在手机上回复。', { exact: true }).waitFor()
    await row.getByRole('button', { name: '全部拒绝', exact: true }).click()
    await row.getByTestId('settings-remote-last-request-waiting').waitFor({ state: 'detached' })
    assert.equal(await row.getByRole('button', { name: '全部拒绝', exact: true }).count(), 0)
    await row.getByRole('button', { name: '停止本轮', exact: true }).click()
    await page.waitForFunction(() => /已停止$/.test(document.querySelector('[data-testid="settings-remote-last-request-text"]')?.textContent ?? ''))
    assert.equal(await row.getByRole('button', { name: '停止本轮', exact: true }).count(), 0)
    await page.evaluate(() => window.remoteHarness.phoneRequest({ minutesAgo: 20, state: 'failed', reason: '余额不足，请充值后重新发送。' }))
    await page.waitForFunction(() => /^(?:\d{1,2} 月 \d{1,2} 日 )?\d\d:\d\d 未完成：余额不足，请充值后重新发送。$/.test(document.querySelector('[data-testid="settings-remote-last-request-text"]')?.textContent ?? ''))
    await row.getByRole('button', { name: '查看记录', exact: true }).click()
    assert.equal((await callsNamed(page, 'navigate')).at(-1).args, 'sessions')
    assert.deepEqual((await calls(page)).filter((call) => call.name === 'remote-decline-approvals' || call.name === 'remote-stop-turn').map((call) => call.name), ['remote-decline-approvals', 'remote-stop-turn'])
  } finally {
    await page.close()
  }
})

// YF-12：遥控开着、余额不到 $1 时提醒出门前先充值，照样让开；点「前往充值」到个人中心的充值。
test('the phone remote card warns about a low balance once the remote is on and leads to the top-up', async () => {
  const page = await fixture('page=remote&remoteReady=1&remoteLowBalance=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    await card.getByTestId('settings-remote-workspace-row').waitFor()
    assert.equal(await card.getByTestId('settings-remote-low-balance').count(), 0)
    await card.getByRole('switch', { name: '打开飞书遥控', exact: true }).click()
    const notice = card.getByTestId('settings-remote-low-balance')
    await notice.getByText('余额仅剩 $0.80', { exact: true }).waitFor()
    await notice.getByText('离开电脑后无法充值，建议外出前预先充值。', { exact: true }).waitFor()
    await notice.getByRole('button', { name: '前往充值', exact: true }).click()
    assert.deepEqual((await callsNamed(page, 'navigate')).at(-1).args, ['account', 'recharge'])
  } finally {
    await page.close()
  }
})

test('the phone remote card says why it cannot be turned on while the manager runs as administrator', async () => {
  const page = await fixture('page=remote&remoteElevated=1&remoteReady=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    await card.getByTestId('settings-remote-unavailable').getByText('星芒正以管理员身份运行，为保障安全，此时无法开启手机遥控。请以普通方式重新打开星芒。').waitFor()
    assert.equal(await card.getByRole('switch', { name: '打开飞书遥控', exact: true }).isDisabled(), true)
    assert.equal(await card.getByTestId('settings-remote-workspace').isDisabled(), true)
    assert.equal(await card.getByTestId('settings-remote-feishu-edit').isDisabled(), true)
  } finally {
    await page.close()
  }
})

test('the phone remote page opens on a Windows account that is an administrator by itself, with a reminder under the page head', async () => {
  const page = await fixture('page=remote&remoteAdminAccount=1&remoteReady=1')
  try {
    const card = page.getByTestId('settings-remote-card')
    await card.getByTestId('settings-remote-admin-account').getByText('本机登录的 Windows 账号自带管理员权限，Codex 在此修改文件、执行命令时同样具有管理员权限。在手机上回复「同意」前，请确认其将执行的操作。').waitFor()
    assert.equal(await card.getByTestId('settings-remote-unavailable').count(), 0)
    assert.equal(await card.getByRole('switch', { name: '打开飞书遥控', exact: true }).isDisabled(), false)
    assert.equal(await card.getByTestId('settings-remote-workspace').isDisabled(), false)
  } finally {
    await page.close()
  }
})

// 0.2.25 手机遥控挪到了左侧栏：设置里搜「飞书」不再落到一张卡上（顶部搜索落到那一页，见 command-search.test.ts）。
test('searching the settings for Feishu no longer finds a phone remote card there', async () => {
  const page = await fixture('page=settings')
  try {
    await page.getByTestId('settings-search').fill('飞书')
    await page.getByTestId('settings-search-empty').waitFor()
    assert.equal(await page.getByTestId('settings-remote-card').count(), 0)
    assert.equal(await page.locator('[data-anchor="codex-remote"]').count(), 0)
  } finally {
    await page.close()
  }
})

test('restoring the default appearance resets the theme, contrast, scale, large text and motion together', async () => {
  const page = await fixture('page=settings&system=1')
  try {
    await page.getByRole('switch', { name: '减少动画', exact: true }).click()
    await page.getByTestId('settings-restore-appearance').click()
    await waitForToast(page, '已恢复默认外观')
    const recorded = await calls(page)
    assert.equal(recorded.filter((call) => call.name === 'platform-theme').at(-1).args, 'system')
    assert.equal(recorded.filter((call) => call.name === 'platform-contrast').at(-1).args, false)
    assert.deepEqual(recorded.filter((call) => call.name === 'settings').at(-1).args, { version: 2, uiScale: 'auto', largeText: false, reducedMotion: false })
  } finally {
    await page.close()
  }
})

// X-2：Windows 文本大小调大了的电脑，装好时 D81 替客户开着大字；「恢复默认」要回到那个样子，不能反倒关掉。
test('restoring the default appearance keeps large text on where a fresh install would turn it on', async () => {
  const page = await fixture('page=settings&system=1&largeTextByDefault=1')
  try {
    await page.getByTestId('settings-restore-appearance').click()
    await waitForToast(page, '已恢复默认外观')
    assert.deepEqual((await callsNamed(page, 'settings')).at(-1).args, { version: 2, uiScale: 'auto', largeText: true, reducedMotion: false })
  } finally {
    await page.close()
  }
})

// X-8：系统界面设置读不出来（DM-3）时，缩放、大字、减少动画照样恢复，只跳过主题和高对比度。
test('restoring the default appearance still resets scale, large text and motion when the system settings cannot be read', async () => {
  const page = await fixture('page=settings&system=1&fail=platform-broken')
  try {
    await page.getByText('系统设置尚未准备好。', { exact: true }).waitFor()
    await page.getByRole('switch', { name: '减少动画', exact: true }).click()
    await page.getByTestId('settings-restore-appearance').click()
    await waitForToast(page, '已恢复默认外观')
    const recorded = await calls(page)
    assert.deepEqual(recorded.filter((call) => call.name === 'settings').at(-1).args, { version: 2, uiScale: 'auto', largeText: false, reducedMotion: false })
    assert.equal(recorded.some((call) => call.name === 'platform-theme' || call.name === 'platform-contrast'), false)
    assert.equal(await page.getByRole('switch', { name: '减少动画', exact: true }).getAttribute('aria-checked'), 'false')
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
    await page.getByRole('tab', { name: '启动关闭', exact: true }).click()
    await page
      .getByRole('switch', { name: '开机自动启动', exact: true })
      .click()
    await page.getByRole('tab', { name: '网络连接', exact: true }).click()
    await page.locator('[data-anchor="proxy"]').getByRole('button', { name: '查看', exact: true }).click()
    await waitForToast(page, '当前：应用窗口当前直接连接')
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

async function openAccountSwitcher(page) {
  await page.getByTestId('account-switch').click()
  const dialog = page.getByRole('dialog', { name: '切换账号', exact: true })
  await dialog.getByText('切换后，下方勾选的工具将同步更换为新账号的密钥。', { exact: true }).waitFor()
  return dialog
}

test('saved accounts switch tools already on the account key by default and expose only eligible choices', async () => {
  const page = await fixture('page=account&sync=1&switcher=1')
  try {
    // 「切换账号」框里「同步到工具」直接展开。
    await openAccountSwitcher(page)
    await page.getByTestId('account-sync-claude').waitFor()
    assert.equal(
      await page.getByTestId('account-sync-claude').isChecked(),
      true,
    )
    assert.equal(
      await page.getByTestId('account-sync-codex').isDisabled(),
      true,
    )
    assert.equal(await page.getByTestId('account-sync-grok').isDisabled(), true)
    // 已下线的 Gemini CLI 装着、也还是星芒密钥，同样不给勾（yoyo 2026-10-14）。
    assert.equal(await page.getByTestId('account-sync-gemini').count(), 0)
    // 取消勾选就不同步：用户说了算。
    await page.getByTestId('account-sync-claude').uncheck()
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
  const page = await fixture('page=account&sync=1&partial=1&switcher=1')
  try {
    await openAccountSwitcher(page)
    await page.getByTestId('account-sync-claude').waitFor()
    await page.getByTestId('account-sync-claude').check()
    await page.getByTestId('account-sync-grok').check()
    await page
      .getByRole('button', { name: '切换', exact: true, disabled: false })
      .click()
    await page
      .getByText('账号已切换，部分工具未同步', { exact: true })
      .waitFor()
    await page
      .getByText('Grok CLI：Grok 配置文件正在使用', { exact: true })
      .waitFor()
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'sync-config').map((call) => call.args),
      [
        { providers: ['claude'], preferredModels: { claude: 'fixture-model' }, intent: 'explicit' },
        { providers: ['grok'], preferredModels: { grok: 'fixture-model' }, intent: 'explicit' },
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
  const page = await fixture('page=account&sync=1&fail=switch&switcher=1')
  try {
    await openAccountSwitcher(page)
    await page.getByTestId('account-sync-claude').waitFor()
    await page.getByTestId('account-sync-claude').check()
    await page
      .getByRole('button', { name: '切换', exact: true, disabled: false })
      .click()
    await page
      .getByText('该已保存账号的登录已失效，当前账号未变化。', { exact: false })
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
    await page.getByRole('button', { name: '重新登录该账号', exact: true }).click()
    assert.equal((await calls(page)).some((call) => call.name === 'login'), true)
  } finally {
    await page.close()
  }
})

test('appearance offers only the light and dark palettes and leaves the saved skin alone', async () => {
  for (const failed of [false, true]) {
    const page = await fixture(`page=settings&skin=aurora${failed ? '&fail=settings' : ''}`)
    try {
      // UI v4.0: no skin row; uiSkin stays in the settings file only because a
      // missing field reads as a first launch, so saving the theme never sends it.
      assert.equal(await page.locator('[data-testid^="settings-skin-"]').count(), 0)
      const theme = page.getByTestId('settings-theme')
      assert.deepEqual(await theme.getByRole('button').allInnerTexts(), ['浅色', '深色'])
      await theme.getByRole('button', { name: '深色', exact: true }).click()
      if (failed) await page.getByText('设置写入失败', { exact: true }).waitFor()
      else
        await page.waitForFunction(
          () => document.documentElement.dataset.theme === 'dark',
        )
      assert.deepEqual(
        (await calls(page)).find((call) => call.name === 'settings').args,
        { version: 2, theme: 'dark' },
      )
      assert.equal(
        await page.evaluate(() => document.documentElement.dataset.skin),
        undefined,
      )
    } finally {
      await page.close()
    }
  }
})

test('desktop notifications start on, the master switch gates test notifications and privacy stores only an explicit local preference', async () => {
  const page = await fixture('page=settings&system=1')
  try {
    await page.getByRole('tab', { name: '消息通知', exact: true }).click()
    const testNotice = page.getByRole('button', {
      name: '发测试通知',
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
    // 系统里把星芒的通知关了也照样「发得出去」，所以不说「已发送」（决定单 D68）；旁边那颗按钮打开了，那句才收起。
    const handedOff = page.locator('.xm-toast', {
      hasText: '测试通知已提交给系统。如未收到，请在系统通知设置中确认星芒的通知已开启。',
    })
    await handedOff
      .getByRole('button', { name: '打开系统通知设置', exact: true })
      .click()
    await handedOff.waitFor({ state: 'detached' })
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'open-notification-settings').length,
      1,
    )
    await page.getByRole('tab', { name: '隐私数据', exact: true }).click()
    const crashReports = page.getByRole('switch', {
      name: '自动发送错误报告',
      exact: true,
    })
    assert.equal(await crashReports.getAttribute('aria-checked'), 'true')
    await crashReports.click()
    assert.deepEqual(
      (await calls(page)).filter((call) => call.name === 'settings').at(-1).args,
      { version: 2, crashReporting: false },
    )
    // 匿名使用统计没碰过 = 开（usage-stats.ts），点一下是关掉。
    const usageStats = page.getByRole('switch', {
      name: '匿名使用统计偏好',
      exact: true,
    })
    assert.equal(await usageStats.getAttribute('aria-checked'), 'true')
    await usageStats.click()
    await waitForToast(page, '已关闭，不再发送使用情况')
    assert.deepEqual(
      (await calls(page)).find((call) => call.name === 'platform-privacy').args,
      { kind: 'anonymousUsage', enabled: false },
    )
    await page
      .getByText(
        '每天最多发送一次版本、操作系统、已安装工具及安装更新结果；不包含账号、密钥、文件路径、对话内容及设备标识',
        { exact: true },
      )
      .waitFor()
    await usageStats.click()
    await waitForToast(page, '已打开，每天最多发一次匿名使用情况')
    assert.deepEqual(
      (await calls(page))
        .filter((call) => call.name === 'platform-privacy')
        .at(-1).args,
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

// X-3：「迁移到新电脑」以前带走「自动发送错误报告：关」，却不带「匿名使用统计：关」。新电脑没动过的直接关上；
// 这台关过、文件里是开的先问，点「保留本机设置」照旧关着，只有点了「使用文件中的设置」才打开。
test('importing a moved computer carries the usage-stats switch and asks before turning it back on', async () => {
  const privacyCalls = async (page) => (await calls(page)).filter((call) => call.name === 'platform-privacy').map((call) => call.args)
  let page = await fixture('page=settings&system=1&transfer=usage-off')
  try {
    await page.getByRole('tab', { name: '备份迁移', exact: true }).click()
    await page.getByTestId('settings-transfer-import').click()
    await waitForToast(page, '已导入设置。')
    assert.deepEqual(await privacyCalls(page), [{ kind: 'anonymousUsage', enabled: false }])
    assert.equal((await calls(page)).filter((call) => call.name === 'settings').length, 0)
    await page.getByRole('tab', { name: '隐私数据', exact: true }).click()
    assert.equal(await page.getByRole('switch', { name: '匿名使用统计偏好', exact: true }).getAttribute('aria-checked'), 'false')
  } finally {
    await page.close()
  }
  page = await fixture('page=settings&system=1&usageOff=1&transfer=usage-on')
  try {
    await page.getByRole('tab', { name: '备份迁移', exact: true }).click()
    const ask = page.getByText('以下设置在本机已修改，与文件中的不同：匿名使用统计。', { exact: true })
    await page.getByTestId('settings-transfer-import').click()
    await ask.waitFor()
    await page.getByTestId('settings-transfer-keep').click()
    await waitForToast(page, '文件中的设置与本机一致，无需修改。')
    assert.deepEqual(await privacyCalls(page), [])
    await page.getByTestId('settings-transfer-import').click()
    await ask.waitFor()
    await page.getByTestId('settings-transfer-overwrite').click()
    await waitForToast(page, '已导入设置。')
    assert.deepEqual(await privacyCalls(page), [{ kind: 'anonymousUsage', enabled: true }])
    await page.getByRole('tab', { name: '隐私数据', exact: true }).click()
    assert.equal(await page.getByRole('switch', { name: '匿名使用统计偏好', exact: true }).getAttribute('aria-checked'), 'true')
  } finally {
    await page.close()
  }
})

// D24：导入「迁移到新电脑」的文件，主题当下变了色，重开又变回原来的：只写了 settings.json，开机看的系统界面设置里那份主题偏好没动。
test('importing a moved computer keeps its theme after a restart by saving the system theme preference too', async () => {
  const page = await fixture('page=settings&system=1&transfer=theme-dark')
  try {
    await page.getByRole('tab', { name: '备份迁移', exact: true }).click()
    await page.getByTestId('settings-transfer-import').click()
    await waitForToast(page, '已导入设置。')
    const recorded = await calls(page)
    assert.deepEqual(recorded.filter((call) => call.name === 'settings').map((call) => call.args), [{ version: 2, theme: 'dark' }])
    assert.deepEqual(recorded.filter((call) => call.name === 'platform-theme').map((call) => call.args), ['dark'])
  } finally {
    await page.close()
  }
})

test('a system notification settings page that will not open keeps the test notification line and says where to look', async () => {
  const page = await fixture('page=settings&system=1&fail=notification-settings')
  try {
    await page.getByRole('tab', { name: '消息通知', exact: true }).click()
    await page.getByRole('button', { name: '发测试通知', exact: true }).click()
    const handedOff = page.locator('.xm-toast', {
      hasText: '测试通知已提交给系统。如未收到，请在系统通知设置中确认星芒的通知已开启。',
    })
    await handedOff
      .getByRole('button', { name: '打开系统通知设置', exact: true })
      .click()
    await page
      .locator('.xm-toast', { hasText: '无法打开系统通知设置，请在系统设置中找到「通知」。' })
      .waitFor()
    assert.equal(await handedOff.count(), 1)
    assert.equal(
      (await calls(page)).filter((call) => call.name === 'open-notification-settings').length,
      1,
    )
  } finally {
    await page.close()
  }
})

test('a previously observed account task sends one scoped completion notification after refresh', async () => {
  const page = await fixture('page=account&system=1&taskTransition=1')
  try {
    await page.getByRole('tab', { name: '用量账单', exact: true }).click()
    // 生成任务藏在「调用明细 | 生成任务」后面也照样读，做完了照样提醒。
    const tasks = page.getByTestId('account-tasks-section')
    await tasks.getByText('处理中 50%', { exact: true }).waitFor({ state: 'attached' })
    assert.equal(await tasks.isHidden(), true)
    assert.equal(
      (await calls(page)).some((call) => call.name === 'activity-notification'),
      false,
    )
    assert.equal(await page.getByRole('button', { name: '刷新任务', exact: true }).count(), 0)
    await page.getByTestId('account-refresh').click()
    await tasks.getByText('已完成 100%', { exact: true }).waitFor({ state: 'attached' })
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
    await page.getByRole('tab', { name: '用量账单', exact: true }).click()
    await page.getByRole('button', { name: '生成任务', exact: true }).click()
    const tasks = page.getByTestId('account-tasks-section')
    await tasks.getByText('处理中 50%', { exact: true }).waitFor()
    await page.getByTestId('account-refresh').click()
    await tasks.getByText('已完成 100%', { exact: true }).waitFor()
    // 一行就是一个入口，点开是任务详情弹窗。
    await tasks.locator('tbody tr').first().click()
    const dialog = page.getByTestId('task-detail-dialog')
    await dialog
      .getByText('https://cdn.upstream.example.test/fixture-task.mp4', {
        exact: true,
      })
      .waitFor()
    assert.equal(
      await page.getByRole('button', { name: '查看结果', exact: true }).count(),
      0,
    )
    await dialog
      .getByRole('button', { name: '复制结果链接', exact: true })
      .click()
    await waitForToast(page, '结果链接已复制')
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
    await page.getByRole('tab', { name: '账号安全', exact: true }).click()
    await page.getByTestId('account-security-password').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('原密码', { exact: true }).fill('old-secret')
    await dialog.getByLabel('新密码', { exact: true }).fill('new-secret-value')
    await page.keyboard.press('Escape')
    await dialog.getByText('有未保存的修改，关闭后修改将丢失', { exact: true }).waitFor()
    await dialog.getByRole('button', { name: '继续编辑', exact: true }).click()
    assert.equal(
      await dialog.getByLabel('原密码', { exact: true }).inputValue(),
      'old-secret',
    )
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.getByTestId('account-security-password').click()
    const reopened = page.getByRole('dialog')
    assert.deepEqual(
      await Promise.all([
        reopened.getByLabel('原密码', { exact: true }).inputValue(),
        reopened.getByLabel('新密码', { exact: true }).inputValue(),
        reopened.getByLabel('再次输入', { exact: true }).inputValue(),
      ]),
      ['', '', ''],
    )
  } finally {
    await page.close()
  }
})

// 0.2.25 扩展合并方案第二版：精选、外接工具、技能、插件合成一页「插件」。
const hub = 'page=extensions&installedProviders=claude,codex'

test('the plugins page groups the recommended entries and folds each official group at four', async () => {
  const page = await fixture(hub)
  try {
    const list = page.getByTestId('hub-plugins')
    for (const group of ['common', 'coding', 'claude', 'codex']) await list.getByTestId(`hub-section-${group}`).waitFor()
    // 逐步思考挪到「写代码」；官方插件分在各自那一组，只能装进那一家。
    await list.getByTestId('hub-section-coding').getByTestId('hub-row-mcp-sequential-thinking').waitFor()
    const claude = list.getByTestId('hub-section-claude')
    await expect(claude.getByText('Anthropic 官方市场，只能装进 Claude', { exact: true })).toBeVisible()
    assert.equal(await claude.locator('.v2-hub-row').count(), 4)
    const toggle = claude.getByTestId('hub-section-claude-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    assert.equal(await claude.locator('.v2-hub-row').count(), 5)
    await expect(list.getByTestId('hub-section-codex').getByText('OpenAI 插件目录，只能装进 GPT', { exact: true })).toBeVisible()
    // 读屏读整行那一句；装上了的有「…」，还能装的有「+」。
    await expect(list.getByTestId('hub-open-mcp-browser')).toHaveAttribute('aria-label', '浏览器，能装到：Claude、GPT、Grok；已装到：Claude、GPT')
    await list.getByTestId('hub-menu-mcp-browser').waitFor()
    await list.getByTestId('hub-add-mcp-memory').waitFor()
    // 左边「已安装」：连不上的那条有橙点，鼠标停上去说是哪种。
    const installed = page.getByTestId('hub-installed')
    await expect(page.locator('.v2-hub-side-label')).toContainText('5')
    await expect(installed.getByRole('button', { name: /测试连接/ }).locator('.v2-hub-warn')).toHaveAttribute('title', '无法连接')
    await expect(page.getByText('以下均为第三方软件，由各自作者维护和更新，不随星芒发布。安装前请确认其所需权限。', { exact: true }).first()).toBeVisible()
    // 「自己加的」只放自己加的那条连接。
    await page.getByTestId('hub-tab-custom').click()
    await list.getByTestId('hub-row-mcp-test-extension').waitFor()
    assert.equal(await list.locator('.v2-hub-row').count(), 1)
  } finally {
    await page.close()
  }
})

test('installing from the plugins page puts a recommended connection into every family picked', async () => {
  const page = await fixture(`${hub}&extensionOk`)
  try {
    await page.getByTestId('hub-add-mcp-sequential-thinking').click()
    const dialog = page.getByRole('dialog', { name: '安装「逐步思考」', exact: true })
    const tools = dialog.getByRole('group', { name: '装到哪里', exact: true })
    await expect(tools.getByTestId('hub-install-tools-claude')).toHaveAttribute('aria-pressed', 'true')
    await expect(tools.getByTestId('hub-install-tools-codex')).toHaveAttribute('aria-pressed', 'true')
    await expect(tools.getByTestId('hub-install-tools-grok')).toBeDisabled()
    await expect(tools.getByTestId('hub-install-tools-grok')).toContainText('本机尚未安装 Grok CLI')
    await tools.getByTestId('hub-install-tools-grok-home').waitFor()
    const submit = dialog.getByTestId('hub-install-submit')
    await expect(submit).toHaveText('装到 2 个')
    await tools.getByTestId('hub-install-tools-codex').click()
    await expect(submit).toHaveText('安装')
    await tools.getByTestId('hub-install-tools-codex').click()
    await submit.click()
    await waitForToast(page, '已安装「逐步思考」，给 Claude Code、Codex CLI 使用，下次打开工具时生效')
    assert.deepEqual((await callsNamed(page, 'extension')).map((call) => [call.args.provider, call.args.kind, call.args.action, call.args.id]), [['claude', 'mcp', 'install', 'sequential-thinking']])
    assert.deepEqual((await callsNamed(page, 'add-mcp')).map((call) => call.args.name), ['sequential-thinking'])
  } finally {
    await page.close()
  }
})

test('a GPT official plugin installs only into GPT and the Claude row says why not', async () => {
  const page = await fixture(`${hub}&extensionOk`)
  try {
    await page.getByTestId('hub-add-plugin-linear-openai-api-curated').click()
    const dialog = page.getByRole('dialog', { name: '安装「Linear」', exact: true })
    await expect(dialog.getByTestId('hub-install-tools-claude')).toBeDisabled()
    await expect(dialog.getByTestId('hub-install-tools-claude')).toContainText('插件各家格式不通用，这一条只有 GPT 版')
    await dialog.getByTestId('hub-install-submit').click()
    await waitForToast(page, '已安装「Linear」，给 Codex CLI 使用，下次打开工具时生效')
    assert.deepEqual((await callsNamed(page, 'extension')).at(-1).args, { provider: 'codex', kind: 'plugin', action: 'install', id: 'linear@openai-api-curated' })
  } finally {
    await page.close()
  }
})

test('an entry opens to where it is installed and what it does, and comes out of every tool at once', async () => {
  const page = await fixture(`${hub}&extensionOk`)
  try {
    await page.getByTestId('hub-installed').getByRole('button', { name: /本地文件/ }).click()
    const detail = page.getByTestId('hub-detail')
    await expect(detail.getByRole('heading', { level: 2 })).toHaveText('本地文件')
    await expect(detail.getByTestId('hub-where-claude')).toContainText('已安装')
    await expect(detail.getByTestId('hub-where-codex')).toContainText('未安装')
    await detail.getByTestId('hub-where-add-codex').waitFor()
    await expect(detail.getByTestId('hub-where-grok')).toContainText('本机尚未安装 Grok CLI')
    await expect(detail.getByTestId('hub-detail-add')).toHaveText('装到 GPT')
    await expect(detail.getByTestId('hub-detail-about')).toContainText('MCP 服务器')
    await detail.getByTestId('hub-remove-all').click()
    const confirm = page.getByRole('dialog', { name: '从所有工具里移除「本地文件」？', exact: true })
    await expect(confirm).toContainText('将同时从 Claude Code 中移除。如需使用，可重新安装。')
    await confirm.getByTestId('hub-remove-confirm').click()
    await waitForToast(page, '已从 Claude Code 移除「本地文件」')
    assert.deepEqual((await callsNamed(page, 'extension')).at(-1).args, { provider: 'claude', kind: 'mcp', action: 'uninstall', id: 'files', scope: 'user' })
    // 推荐里的那一条还在，详情照旧开着，只是哪家都没装了；左边清单里没有它了。
    await expect(detail.getByTestId('hub-where-claude')).toContainText('未安装')
    assert.equal(await page.getByTestId('hub-installed').getByRole('button', { name: /本地文件/ }).count(), 0)
    await detail.getByTestId('hub-back').click()
    await page.getByTestId('hub-section-common').waitFor()
  } finally {
    await page.close()
  }
})

test('the plugins page searches across groups, filters by family and says when nothing matches', async () => {
  const page = await fixture(hub)
  try {
    const search = page.getByTestId('hub-search')
    await search.fill('浏览器')
    await page.getByTestId('hub-row-mcp-browser').waitFor()
    assert.equal(await page.locator('.v2-hub-row').count(), 1)
    await search.fill('插件 Stripe')
    await page.getByTestId('hub-row-plugin-stripe-claude-plugins-official').waitFor()
    await search.fill('找不到的东西')
    await page.getByTestId('hub-search-empty').waitFor()
    await page.getByTestId('hub-clear').click()
    await page.getByTestId('hub-section-common').waitFor()
    // 装到：GPT 时 Claude 官方那一组不放，没装的 Grok 写「还没装」。
    await page.getByTestId('hub-filter').click()
    await expect(page.getByTestId('hub-filter-grok')).toContainText('未安装')
    await page.getByTestId('hub-filter-codex').click()
    await expect(page.getByTestId('hub-filter')).toHaveText('装到：GPT')
    assert.equal(await page.getByTestId('hub-section-claude').count(), 0)
    await page.getByTestId('hub-section-codex').waitFor()
  } finally {
    await page.close()
  }
})

test('without the Codex CLI the GPT official group asks for it and offers the home page', async () => {
  const page = await fixture('page=extensions&installedProviders=claude')
  try {
    await expect(page.getByTestId('hub-codex-missing')).toHaveText('安装 Codex CLI 后可查看 GPT 官方插件。前往首页安装')
    await page.getByTestId('hub-codex-open-home').waitFor()
    assert.equal(await page.getByTestId('hub-row-plugin-sentry-openai-api-curated').count(), 0)
  } finally {
    await page.close()
  }
})

test('a skill can come from a zip picked in the system window, then goes into each ticked tool', async () => {
  const page = await fixture(`${hub}&extensionOk=1`)
  const directory = 'C:/Users/test/AppData/Roaming/xingmang/skill-archives/a1/pdf-helper'
  try {
    await page.getByTestId('hub-nav-skills').click()
    await page.getByTestId('hub-add').click()
    await page.getByTestId('hub-add-skill-archive').click()
    await expect(page.getByTestId('hub-skill-import')).toContainText('从压缩包导入')
    // 还没选压缩包时不能点「添加」，也没有能手填路径的框。
    assert.equal(await page.getByTestId('hub-skill-import-submit').isDisabled(), true)
    assert.equal(await page.getByTestId('hub-skill-import-source').count(), 0)
    await page.getByTestId('hub-skill-archive-choose').click()
    await expect(page.getByTestId('hub-skill-archive-name')).toHaveValue('pdf-helper.zip')
    await page.getByTestId('hub-skill-import-submit').click()
    await page.getByText(/^已添加「pdf-helper」，给 .+ 使用，下次打开工具时生效$/).waitFor()
    // 导入完表单关掉，解开的那份随即让主进程删掉，排在各家导入之后。
    await page.waitForFunction(() => {
      const recorded = JSON.parse(document.documentElement.dataset.calls || '[]').map((call) => call.name)
      return recorded.lastIndexOf('discard-skill-archives') > recorded.lastIndexOf('extension')
    })
    const recorded = await calls(page)
    assert.deepEqual(recorded.find((call) => call.name === 'import-skill').args, { sourcePath: directory, scope: 'user' })
    assert.deepEqual(
      recorded.filter((call) => call.name === 'extension').map((call) => call.args),
      [{ provider: 'claude', kind: 'skill', action: 'install', source: directory, scope: 'user' }],
    )
  } finally {
    await page.close()
  }
})

test('an unpacked zip stays while the form is open after a failed import and is discarded once the form closes', async () => {
  const page = await fixture(hub)
  const namesAfterChoosing = async () => {
    const names = (await calls(page)).map((call) => call.name)
    return names.slice(names.lastIndexOf('choose-skill-archive') + 1)
  }
  try {
    await page.getByTestId('hub-nav-skills').click()
    await page.getByTestId('hub-add').click()
    await page.getByTestId('hub-add-skill-archive').click()
    await page.getByTestId('hub-skill-archive-choose').click()
    await expect(page.getByTestId('hub-skill-archive-name')).toHaveValue('pdf-helper.zip')
    await page.getByTestId('hub-skill-import-submit').click()
    await page.getByTestId('hub-skill-import').getByText('扩展操作失败，已有配置保留').first().waitFor()
    // 失败了表单还开着，客户可以直接再点一次「添加」，解开的那份不能先删。
    assert.equal(await page.getByTestId('hub-skill-import-submit').isDisabled(), false)
    assert.equal((await namesAfterChoosing()).includes('discard-skill-archives'), false)
    await page.getByTestId('hub-skill-import').getByRole('button', { name: '取消' }).click()
    await page.getByTestId('hub-skill-import').waitFor({ state: 'detached' })
    await page.waitForFunction(() => {
      const names = JSON.parse(document.documentElement.dataset.calls || '[]').map((call) => call.name)
      return names.lastIndexOf('discard-skill-archives') > names.lastIndexOf('choose-skill-archive')
    })
  } finally {
    await page.close()
  }
})

test('a zip with no skill in it says so inside the import form', async () => {
  const page = await fixture(`${hub}&skillArchive=empty`)
  try {
    await page.getByTestId('hub-nav-skills').click()
    await page.getByTestId('hub-add').click()
    await page.getByTestId('hub-add-skill-archive').click()
    await page.getByTestId('hub-skill-archive-choose').click()
    await page.getByTestId('hub-skill-import').getByText('这个压缩包里没找到技能（要有一个 SKILL.md 文件）。').waitFor()
    await expect(page.getByTestId('hub-skill-archive-name')).toHaveValue('')
    assert.equal(await page.getByTestId('hub-skill-import-submit').isDisabled(), true)
  } finally {
    await page.close()
  }
})

test('the skills view lists skills on this computer and sends OpenAI skills to the GPT official group', async () => {
  const page = await fixture(hub)
  try {
    await page.getByTestId('hub-nav-skills').click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('技能')
    await page.getByTestId('hub-section-skill').getByTestId('hub-row-skill-测试技能').waitFor()
    await page.getByTestId('hub-add').click()
    await page.getByTestId('hub-add-skill').waitFor()
    await page.keyboard.press('Escape')
    await page.getByTestId('skills-codex-plugins').click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('插件')
    await expect(page.getByTestId('hub-section-codex-toggle')).toHaveAttribute('aria-expanded', 'true')
  } finally {
    await page.close()
  }
})
