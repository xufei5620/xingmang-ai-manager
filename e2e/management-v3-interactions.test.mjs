import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
async function withPage(query, run, viewport = { width: 1280, height: 820 }) {
  const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), root, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  const browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
  try {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    const address = server.httpServer.address()
    await page.goto(`http://127.0.0.1:${address.port}/e2e/management-v3-fixture.html?${query}`)
    await run(page)
    assert.deepEqual(errors, [])
  } finally { await browser.close(); await server.close() }
}

test('session drawers recover read errors, constrain focus and retain filters after navigation', async () => {
  await withPage('view=sessions&failure=detail', async (page) => {
    const search = page.getByRole('searchbox').or(page.getByRole('textbox', { name: '搜索会话' }))
    await search.fill('project')
    await page.getByRole('button', { name: '搜索', exact: true }).click()
    const trigger = page.getByRole('button', { name: '查看 codex project conversation', exact: true })
    await trigger.click()
    const drawer = page.getByTestId('session-detail-drawer')
    await drawer.getByText('会话文件暂时不可读', { exact: true }).waitFor()
    assert.equal((await drawer.boundingBox()).width, 420)
    await drawer.getByRole('button', { name: '重试', exact: true }).click()
    await drawer.getByText('保留这条对话', { exact: true }).waitFor()
    await fs.mkdir(path.join(root, 'test-results/management-v3'), { recursive: true })
    await page.screenshot({ path: path.join(root, 'test-results/management-v3/session-drawer-dark.png') })
    await search.evaluate((element) => element.focus())
    assert.equal(await drawer.evaluate((element) => element.contains(document.activeElement)), true)
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'detached' })
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
    assert.equal(await search.inputValue(), 'project')
    await page.getByRole('navigation', { name: '验收页面' }).getByRole('button', { name: 'backups', exact: true }).click()
    await page.getByRole('navigation', { name: '验收页面' }).getByRole('button', { name: 'sessions', exact: true }).click()
    assert.equal(await search.inputValue(), 'project')
    await trigger.click()
    await drawer.getByRole('button', { name: '导出 Markdown', exact: true }).click()
    await drawer.getByRole('status').filter({ hasText: 'export.md' }).waitFor()
    assert.ok((await page.evaluate(() => window.managementHarness.actions)).includes('export:codex-session'))
    await drawer.getByRole('button', { name: '归档会话', exact: true }).click()
    assert.equal(await page.getByRole('dialog').count(), 1)
    await drawer.getByRole('button', { name: '确认归档', exact: true }).click()
    await drawer.waitFor({ state: 'detached' })
    assert.ok((await page.evaluate(() => window.managementHarness.actions)).includes('archive:codex-native'))
    await page.getByText('已归档', { exact: true }).waitFor()
  })
})

test('backup preview retains selection on failed restore and only closes after an accepted result', async () => {
  await withPage('view=backups&failure=restore', async (page) => {
    await page.getByRole('textbox', { name: '搜索备份' }).fill('fixture')
    const trigger = page.getByRole('button', { name: '预览恢复', exact: true })
    await trigger.click()
    const drawer = page.getByTestId('backup-preview-drawer')
    await drawer.getByText('~/.codex/config.toml', { exact: true }).waitFor()
    await fs.mkdir(path.join(root, 'test-results/management-v3'), { recursive: true })
    await page.screenshot({ path: path.join(root, 'test-results/management-v3/backup-drawer-dark.png') })
    assert.equal((await drawer.boundingBox()).width, 420)
    await drawer.getByRole('button', { name: '确认恢复', exact: true }).click()
    await drawer.getByRole('alert').filter({ hasText: '备份校验未通过' }).waitFor()
    assert.equal(await page.evaluate(() => window.managementHarness.restoreCalls), 1)
    await drawer.getByRole('button', { name: '确认恢复', exact: true }).click()
    await drawer.waitFor({ state: 'detached' })
    await page.getByRole('status').filter({ hasText: 'before-restore-02' }).waitFor()
    assert.equal(await page.getByRole('textbox', { name: '搜索备份' }).inputValue(), 'fixture')
    await trigger.click()
    await drawer.getByRole('button', { name: '关闭预览', exact: true }).click()
    assert.equal(await trigger.evaluate((element) => element === document.activeElement), true)
  })
})

test('MCP details and destructive actions preserve authentication and provider capability checks', async () => {
  await withPage('view=mcp', async (page) => {
    await page.getByRole('button', { name: '查看 Local MCP', exact: true }).click()
    const drawer = page.getByTestId('resource-detail-drawer')
    await drawer.getByText('MCP_TOKEN', { exact: true }).waitFor()
    await drawer.getByRole('button', { name: '关闭详情', exact: true }).click()
    await page.getByRole('button', { name: '退出登录', exact: true }).click()
    assert.ok((await page.evaluate(() => window.managementHarness.actions)).includes('mcp:logout:Local MCP'))
    await page.getByRole('tab', { name: 'Claude', exact: true }).click()
    const row = page.locator('.extension-row').filter({ hasText: 'claude-mcp' })
    await row.waitFor()
    assert.equal(await row.getByRole('button', { name: '删除', exact: true }).count(), 0)
    assert.equal(await row.getByRole('button', { name: '停用', exact: true }).count(), 0)
    await page.getByRole('tab', { name: 'Gemini', exact: true }).click()
    await page.locator('.extension-row').filter({ hasText: 'gemini-mcp' }).getByRole('button', { name: '停用', exact: true }).click()
    assert.deepEqual((await page.evaluate(() => window.managementHarness.mutations.at(-1))).provider, 'gemini')
    await page.getByRole('tab', { name: 'Codex', exact: true }).click()
    await page.locator('.extension-row').filter({ hasText: 'Local MCP' }).getByRole('button', { name: '删除', exact: true }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '确认删除', exact: true }).click()
    await page.getByRole('heading', { name: '还没有外接工具', exact: true }).waitFor()
    assert.ok((await page.evaluate(() => window.managementHarness.actions)).includes('mcp:remove:Local MCP'))
  })
})

test('skills retain read-only system protection and provider workspace mutations', async () => {
  await withPage('view=skills', async (page) => {
    const system = page.locator('.skill-card').filter({ hasText: 'System Skill' })
    await system.waitFor()
    assert.equal(await system.getByRole('checkbox').isDisabled(), true)
    assert.equal(await system.getByRole('button', { name: '卸载', exact: true }).count(), 0)
    const managed = page.locator('.skill-card').filter({ hasText: 'Managed Skill' })
    await managed.getByRole('checkbox').uncheck()
    await page.waitForFunction(() => window.managementHarness.actions.some((action) => action.startsWith('skill:toggle:') && action.endsWith(':false')))
    await managed.getByRole('button', { name: '查看 Managed Skill', exact: true }).click()
    await page.getByTestId('resource-detail-drawer').getByText('可管理', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('tab', { name: 'Gemini', exact: true }).click()
    const gemini = page.locator('.skill-card').filter({ hasText: 'gemini-skill' })
    await gemini.getByRole('checkbox').uncheck()
    const mutation = await page.evaluate(() => window.managementHarness.mutations.at(-1))
    assert.equal(mutation.provider, 'gemini')
    assert.equal(mutation.scope, 'workspace')
    assert.equal(mutation.kind, 'skill')
  })
})

test('plugins preserve provider after leaving the page and gate unsupported marketplaces', async () => {
  await withPage('view=plugins', async (page) => {
    await page.getByRole('tab', { name: 'Gemini', exact: true }).click()
    await page.locator('.plugin-card').filter({ hasText: 'gemini-plugin' }).waitFor()
    await page.getByRole('textbox', { name: '搜索插件', exact: true }).fill('gemini')
    await page.getByRole('navigation', { name: '验收页面' }).getByRole('button', { name: 'sessions', exact: true }).click()
    await page.getByRole('navigation', { name: '验收页面' }).getByRole('button', { name: 'plugins', exact: true }).click()
    assert.equal(await page.getByRole('tab', { name: 'Gemini', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByRole('textbox', { name: '搜索插件', exact: true }).inputValue(), 'gemini')
    await page.locator('.plugin-card').filter({ hasText: 'gemini-plugin' }).getByRole('checkbox').uncheck()
    assert.equal((await page.evaluate(() => window.managementHarness.mutations.at(-1))).provider, 'gemini')
    await page.getByRole('tab', { name: 'Claude', exact: true }).click()
    await page.getByText('该工具不提供插件市场', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '添加市场', exact: true }).count(), 0)
  })
})

test('management lists fit desktop viewports in both brand themes', async () => {
  await withPage('view=sessions', async (page) => {
    const directory = path.join(root, 'test-results/management-v3')
    await fs.mkdir(directory, { recursive: true })
    for (const theme of ['light', 'dark']) {
      await page.locator('html').evaluate((element, value) => { element.dataset.theme = value }, theme)
      for (const width of [960, 1280, 1440]) {
        await page.setViewportSize({ width, height: width === 960 ? 560 : 820 })
        for (const view of ['sessions', 'backups', 'mcp', 'skills', 'plugins']) {
          await page.getByRole('navigation', { name: '验收页面' }).getByRole('button', { name: view, exact: true }).click()
          await page.locator(`[data-page-id="${view}"]`).waitFor()
          await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null)
          const metrics = await page.locator(`[data-page-id="${view}"]`).evaluate((element) => ({ overflow: element.scrollWidth > element.clientWidth + 1, width: element.getBoundingClientRect().width }))
          assert.equal(metrics.overflow, false, `${view}/${theme}/${width}`)
          await page.screenshot({ path: path.join(directory, `${view}-${theme}-${width}.png`) })
        }
      }
    }
  })
})
