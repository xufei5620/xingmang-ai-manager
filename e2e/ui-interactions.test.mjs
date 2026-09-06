import assert from 'node:assert/strict'
import path from 'node:path'
import { before, after, test } from 'node:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

let browser, server, baseUrl
before(async () => {
  server = await createServer({ root: path.resolve('.'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
})
after(async () => { await browser?.close(); await server?.close() })
async function gallery() {
  const page = await browser.newPage({ viewport: { width: 960, height: 620 } })
  await page.goto(`${baseUrl}/src/components/ui/gallery.html`)
  await page.getByRole('heading', { name: '星芒 AI / 组件检阅' }).waitFor()
  return page
}

test('tooltips, menus and popovers remain keyboard accessible', async () => {
  const page = await gallery()
  try {
    await page.getByRole('button', { name: '添加配置', exact: true }).focus()
    await page.getByRole('tooltip').waitFor()
    assert.match(await page.getByRole('tooltip').innerText(), /添加配置/)
    await page.keyboard.press('Escape')
    await page.getByRole('tooltip').waitFor({ state: 'detached' })
    await page.getByRole('button', { name: '更多动作', exact: true }).click()
    await page.getByRole('menu', { name: '更多动作' }).waitFor()
    await page.keyboard.press('ArrowDown')
    assert.equal(await page.getByRole('menuitem', { name: '移除配置' }).evaluate((element) => element === document.activeElement), true)
    await page.keyboard.press('Enter')
    assert.match(await page.locator('.ui-gallery-status').innerText(), /已选择移除配置/)
    await page.getByRole('button', { name: '配置提示', exact: true }).click()
    await page.getByRole('dialog', { name: '配置提示' }).waitFor()
    await page.getByRole('button', { name: '知道了' }).click()
    assert.equal(await page.getByRole('button', { name: '配置提示', exact: true }).evaluate((element) => element === document.activeElement), true)
  } finally { await page.close() }
})

test('searchable model selection supports IME and popovers work inside a native modal drawer', async () => {
  const page = await gallery()
  try {
    const model = page.getByRole('combobox', { name: '搜索模型' })
    await model.fill('Bet')
    await model.evaluate((input) => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    assert.equal(await page.getByRole('listbox').count(), 1)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    assert.equal(await model.inputValue(), 'Beta')
    assert.equal(await page.getByRole('listbox').count(), 0)
    await page.getByRole('button', { name: '查看详细配置' }).click()
    const drawer = page.getByRole('dialog', { name: '详细配置', exact: true })
    await drawer.waitFor()
    await drawer.getByRole('combobox', { name: '详情模型' }).fill('Alp')
    await page.getByRole('option', { name: /Alpha/ }).click()
    assert.equal(await drawer.getByRole('combobox', { name: '详情模型' }).inputValue(), 'Alpha')
    assert.equal(await page.getByRole('listbox').count(), 0)
    await drawer.getByRole('button', { name: '详情动作' }).click()
    await page.getByRole('menu', { name: '详情动作' }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await drawer.isVisible(), true)
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('read-only choices remain mixed and Space activates menus after type-ahead', async () => {
  const page = await gallery()
  try {
    const mixed = page.getByRole('checkbox', { name: '部分工具已选中', exact: true })
    await mixed.click()
    assert.equal(await mixed.evaluate((element) => element.indeterminate), true)
    assert.equal(await mixed.getAttribute('aria-checked'), 'mixed')
    await page.getByText('完成后通知', { exact: true }).click()
    assert.equal(await page.getByRole('switch', { name: '完成后通知', exact: true }).getAttribute('aria-checked'), 'false')
    await page.getByRole('button', { name: '文本操作', exact: true }).click()
    await page.getByRole('menu', { name: '文本操作' }).waitFor()
    await page.keyboard.type('save')
    await page.keyboard.press('Space')
    await page.getByRole('menu', { name: '文本操作' }).waitFor({ state: 'detached' })
    assert.match(await page.locator('.ui-gallery-status').innerText(), /已保存文本草稿/)
  } finally { await page.close() }
})

test('nested popover Tab returns through the owning modal focus loop', async () => {
  const page = await gallery()
  try {
    await page.getByRole('button', { name: '查看兼容弹窗', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '兼容弹窗', exact: true })
    await dialog.getByRole('button', { name: '附加选项', exact: true }).click()
    const popover = page.getByRole('dialog', { name: '附加选项', exact: true })
    await popover.getByRole('button', { name: '最后一个动作', exact: true }).focus()
    await page.keyboard.press('Tab')
    assert.equal(await dialog.getByRole('button', { name: '第一个动作', exact: true }).evaluate((element) => element === document.activeElement), true)
    await page.keyboard.press('Escape')
    await popover.waitFor({ state: 'detached' })
    assert.equal(await dialog.isVisible(), true)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('coachmarks stop pointing at targets clipped by an inner scrolling region', async () => {
  const page = await gallery()
  try {
    await page.getByRole('button', { name: '查看局部滚动引导', exact: true }).click()
    const coach = page.getByRole('dialog', { name: '配置入口', exact: true })
    await coach.waitFor()
    await page.locator('#gallery-coach-scroll').evaluate((element) => { element.scrollTop = 120 })
    await coach.waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('date ranges validate order and coachmarks disappear when their target is hidden', async () => {
  const page = await gallery()
  try {
    await page.getByLabel('开始日期', { exact: true }).fill('2026-09-08')
    await page.getByText('开始时间不能晚于结束时间', { exact: true }).waitFor()
    await page.getByLabel('结束日期', { exact: true }).fill('2026-09-09')
    assert.equal(await page.getByText('开始时间不能晚于结束时间', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '查看引导标记' }).click()
    await page.getByRole('dialog', { name: '配置入口' }).waitFor()
    await page.locator('#gallery-coach-target').evaluate((element) => { element.hidden = true })
    await page.getByRole('dialog', { name: '配置入口' }).waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('account tables expose column headers and keyboard detail actions without hiding data cells', async () => {
  const page = await browser.newPage({ viewport: { width: 960, height: 620 } })
  try {
    for (const [section, label, columns] of [['usage', '调用明细', 6], ['tasks', '异步任务', 8], ['orders', '我的订单', 6], ['keys', 'API 密钥', 10]]) {
      await page.goto(`${baseUrl}/e2e/account-commerce-fixture.html?scenario=visual&section=${section}`)
      const table = page.getByRole('table', { name: label, exact: true })
      await table.waitFor()
      assert.equal(await table.getByRole('columnheader').count(), columns)
      const firstRow = table.getByRole('row').nth(1)
      assert.equal(await firstRow.getByRole('cell').count(), columns)
      if (section === 'usage' || section === 'tasks') {
        const detail = firstRow.getByRole('button')
        await detail.focus()
        await page.keyboard.press('Enter')
        const dialog = page.getByRole('dialog', { name: section === 'usage' ? '日志详情' : '任务详情', exact: true })
        await dialog.waitFor()
        await page.keyboard.press('Escape')
        await dialog.waitFor({ state: 'detached' })
        assert.equal(await detail.evaluate((element) => element === document.activeElement), true)
      }
    }
  } finally { await page.close() }
})

test('registration OTP preserves single-input paste and links its correctable validation error', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
  try {
    await page.goto(`${baseUrl}/e2e/app-v3-fixture.html?invite=XM-7K2Q`)
    const dialog = page.getByRole('dialog', { name: '注册', exact: true })
    await dialog.waitFor()
    await dialog.getByRole('button', { name: '创建账户', exact: true }).click()
    const code = dialog.locator('input[autocomplete="one-time-code"]')
    assert.equal(await code.getAttribute('aria-invalid'), 'true')
    assert.equal(await code.getAttribute('aria-describedby'), 'register-verification-error')
    await dialog.locator('#register-verification-error').waitFor()
    await code.fill('123456')
    assert.equal(await code.inputValue(), '123456')
    assert.equal(await code.getAttribute('aria-invalid'), 'false')
    assert.equal(await code.getAttribute('aria-describedby'), null)
    await code.press('End')
    await code.press('Backspace')
    assert.equal(await code.inputValue(), '12345')
  } finally { await page.close() }
})
