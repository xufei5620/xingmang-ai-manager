import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(projectRoot, '.project-surgeon/audits/20260906-ui-implementation/maintenance-pages')
let server
let browser
let baseUrl
before(async () => {
  server = await createServer({ configFile: path.join(projectRoot, 'vite.config.ts'), root: projectRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  await fs.mkdir(artifacts, { recursive: true })
})
after(async () => { await browser?.close(); await server?.close() })
async function openFixture(query = '', viewport = { width: 1280, height: 820 }) {
  const page = await browser.newPage({ viewport })
  await page.goto(`${baseUrl}/e2e/maintenance-pages-fixture.html?${query}`)
  await page.locator('.maintenance-v3').waitFor()
  return page
}

test('health guards duplicate runs, preserves its own results and passes exact resolution codes', async () => {
  const page = await openFixture('view=health&scenario=slow-health')
  try {
    await page.getByRole('button', { name: '开始检查', exact: true }).click()
    await page.getByRole('button', { name: '检查中', exact: true }).evaluate((button) => { button.click(); button.click() })
    assert.equal(await page.evaluate(() => window.maintenanceHarness.runCalls), 1)
    await page.evaluate(() => window.maintenanceHarness.releaseHealth(true))
    await page.getByRole('heading', { name: '逐项结果' }).waitFor()
    const row = page.getByRole('listitem').filter({ hasText: 'Node.js' })
    await row.locator('summary').click()
    assert.match(await row.innerText(), /16.0.0/)
    await row.getByRole('button', { name: '去处理' }).click()
    assert.deepEqual(await page.evaluate(() => window.maintenanceHarness.resolved), ['RUNTIME_NODE'])
    await page.getByRole('button', { name: '返回检查' }).click()
    await page.getByRole('heading', { name: '逐项结果' }).waitFor()
    await page.getByRole('button', { name: '导出报告' }).click()
    assert.equal(await page.evaluate(() => window.maintenanceHarness.exportHealthCalls), 1)
    await page.goto(`${baseUrl}/e2e/maintenance-pages-fixture.html?view=health&scenario=standalone-health`)
    await page.getByRole('button', { name: '开始检查', exact: true }).click()
    await page.getByRole('heading', { name: '逐项结果' }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '还没检查过' }).count(), 0)
  } finally { await page.close() }
})

test('health execution failure stays retryable', async () => {
  const page = await openFixture('view=health&scenario=health-fails-once')
  try {
    await page.getByRole('button', { name: '开始检查', exact: true }).click()
    await page.getByRole('alert').waitFor()
    await page.getByRole('button', { name: '开始检查', exact: true }).click()
    await page.getByRole('heading', { name: '逐项结果' }).waitFor()
    assert.equal(await page.evaluate(() => window.maintenanceHarness.runCalls), 2)
  } finally { await page.close() }
})

test('feedback requires preview, copies and exports the same report ID, and preserves selectable text after copy failure', async () => {
  const page = await openFixture('view=feedback&scenario=copy-fails-once')
  try {
    assert.equal(await page.getByRole('button', { name: '复制给客服', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '预览脱敏报告', exact: true }).click()
    const preview = page.getByTestId('feedback-report-text')
    await preview.waitFor()
    const text = await preview.inputValue()
    await page.getByRole('button', { name: '刷新日志', exact: true }).click()
    assert.equal(await preview.inputValue(), text)
    await page.getByRole('button', { name: '复制给客服', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '剪贴板不可用' }).waitFor()
    assert.equal(await preview.inputValue(), text)
    assert.equal(await preview.evaluate((element) => document.activeElement === element && element.selectionEnd === element.value.length), true)
    await page.getByRole('button', { name: '刷新日志', exact: true }).click()
    assert.match(await page.getByRole('alert').innerText(), /剪贴板不可用/)
    await page.getByRole('button', { name: '复制给客服', exact: true }).click()
    await page.getByRole('button', { name: '导出文件', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.maintenanceHarness.copyIds), ['report-1', 'report-1'])
    assert.deepEqual(await page.evaluate(() => window.maintenanceHarness.exportIds), ['report-1'])
    assert.equal(await page.evaluate(() => window.maintenanceHarness.previewCalls), 1)
  } finally { await page.close() }
})

test('feedback guards double copy and keeps the report when current logs are cleared', async () => {
  const page = await openFixture('view=feedback&scenario=slow-copy')
  try {
    await page.getByRole('button', { name: '预览脱敏报告', exact: true }).click()
    const text = await page.getByTestId('feedback-report-text').inputValue()
    const copy = page.getByRole('button', { name: '复制给客服', exact: true })
    await copy.click()
    await copy.evaluate((button) => { button.click(); button.click() })
    assert.deepEqual(await page.evaluate(() => window.maintenanceHarness.copyIds), ['report-1'])
    await page.evaluate(() => window.maintenanceHarness.releaseCopy(true))
    await page.getByRole('button', { name: '清空日志', exact: true }).click()
    await page.getByRole('alertdialog').waitFor()
    assert.equal(await page.evaluate(() => window.maintenanceHarness.clearCalls), 0)
    await page.getByRole('alertdialog').getByRole('button', { name: '清空日志', exact: true }).click()
    await page.getByText('暂无运行日志', { exact: true }).waitFor()
    assert.equal(await page.getByTestId('feedback-report-text').inputValue(), text)
    assert.equal(await page.evaluate(() => window.maintenanceHarness.clearCalls), 1)
  } finally { await page.close() }
})

test('log and preview failures do not produce a fake empty log list or fake report', async () => {
  const page = await openFixture('view=feedback&scenario=logs-fail')
  try {
    await page.locator('.feedback-log-empty').getByText('运行日志读取失败', { exact: true }).waitFor()
    assert.equal(await page.getByText('暂无运行日志', { exact: true }).count(), 0)
    await page.evaluate(() => { window.maintenanceHarness.loadFailure = false })
    await page.getByRole('button', { name: '重试读取', exact: true }).click()
    await page.getByRole('log').waitFor()
    await page.goto(`${baseUrl}/e2e/maintenance-pages-fixture.html?view=feedback&scenario=preview-fails-once`)
    await page.getByRole('button', { name: '预览脱敏报告', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByTestId('feedback-report-text').count(), 0)
    assert.equal(await page.getByRole('button', { name: '复制给客服', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '预览脱敏报告', exact: true }).click()
    await page.getByTestId('feedback-report-text').waitFor()
  } finally { await page.close() }
})

test('cancelled report export preserves its preview without reporting a completed export', async () => {
  const page = await openFixture('view=feedback&scenario=export-cancel')
  try {
    await page.getByRole('button', { name: '预览脱敏报告', exact: true }).click()
    const text = await page.getByTestId('feedback-report-text').inputValue()
    await page.getByRole('button', { name: '导出文件', exact: true }).click()
    assert.equal(await page.getByTestId('feedback-report-text').inputValue(), text)
    assert.equal(await page.getByTestId('notice').textContent(), '')
    assert.deepEqual(await page.evaluate(() => window.maintenanceHarness.exportIds), ['report-1'])
  } finally { await page.close() }
})

test('update distinguishes authoritative recheck, redownload, progress and development restrictions', async () => {
  const page = await openFixture('view=update&phase=error')
  try {
    await page.getByRole('button', { name: '重新检查更新', exact: true }).click()
    await page.getByRole('heading', { name: '发现新版本', exact: true }).waitFor()
    await page.getByRole('button', { name: '下载更新', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.maintenanceHarness.updates), ['check', 'download'])
    await page.goto(`${baseUrl}/e2e/maintenance-pages-fixture.html?view=update&phase=cancelled`)
    await page.getByRole('button', { name: '重新下载', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => window.maintenanceHarness.updates), ['retry-download'])
    await page.goto(`${baseUrl}/e2e/maintenance-pages-fixture.html?view=update&phase=downloading`)
    assert.equal(await page.locator('progress').getAttribute('value'), '64')
    assert.equal(await page.getByRole('button', { name: '下载更新', exact: true }).isDisabled(), true)
    await page.goto(`${baseUrl}/e2e/maintenance-pages-fixture.html?view=update&phase=disabled`)
    assert.equal(await page.getByRole('button', { name: '检查更新', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '重启并安装', exact: true }).isDisabled(), true)
  } finally { await page.close() }
})

test('tutorial search and selected chapter survive task navigation and no-result clearing', async () => {
  const page = await openFixture('view=tutorial')
  try {
    await page.getByRole('navigation', { name: '教程目录' }).getByRole('button', { name: '工具配置与模型', exact: true }).click()
    await page.getByRole('button', { name: '返回首页', exact: true }).click()
    await page.getByRole('button', { name: '返回教程', exact: true }).click()
    await page.getByRole('heading', { name: '工具配置与模型', exact: true }).waitFor()
    await page.getByRole('searchbox', { name: '搜索教程' }).fill('npm')
    await page.getByRole('button', { name: '打开安装卸载', exact: true }).click()
    await page.getByRole('button', { name: '返回教程', exact: true }).click()
    assert.equal(await page.getByRole('searchbox', { name: '搜索教程' }).inputValue(), 'npm')
    await page.getByRole('searchbox', { name: '搜索教程' }).fill('not-a-real-tutorial')
    await page.getByRole('heading', { name: '没找到相关教程', exact: true }).waitFor()
    await page.getByRole('button', { name: '清除搜索', exact: true }).click()
    await page.getByRole('heading', { name: '工具配置与模型', exact: true }).waitFor()
  } finally { await page.close() }
})

test('failed installer invocation keeps the downloaded update available for retry', async () => {
  const page = await openFixture('view=update&phase=downloaded&scenario=install-fails')
  try {
    await page.getByRole('button', { name: '重启并安装', exact: true }).click()
    await page.getByRole('alert').waitFor()
    assert.equal(await page.getByRole('button', { name: '重启并安装', exact: true }).isEnabled(), true)
    assert.deepEqual(await page.evaluate(() => window.maintenanceHarness.updates), ['install'])
  } finally { await page.close() }
})

test('maintenance views fit target window widths in light and dark modes', async () => {
  for (const theme of ['light', 'dark']) for (const viewport of [{ width: 960, height: 560 }, { width: 1280, height: 820 }, { width: 1440, height: 900 }]) for (const view of ['health', 'feedback', 'update', 'tutorial']) {
    const page = await openFixture(`view=${view}&report=true&phase=downloading&theme=${theme}`, viewport)
    try {
      if (view === 'feedback') { await page.getByRole('button', { name: '预览脱敏报告', exact: true }).click(); await page.getByTestId('feedback-report-text').waitFor() }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, `${view} ${theme} ${viewport.width} document overflow`)
      await page.screenshot({ path: path.join(artifacts, `${view}-${theme}-${viewport.width}.png`), fullPage: true })
    } finally { await page.close() }
  }
})
