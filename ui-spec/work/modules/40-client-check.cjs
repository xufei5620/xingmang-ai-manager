/* Offline prototype interactions; no native installation or configuration verification. */
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')
const { chromium } = require('@playwright/test')

async function main() {
  const browser = await chromium.launch()
  const artifacts = path.resolve('artifacts/client-tool-rows-prototype')
  await fs.mkdir(artifacts, { recursive: true })
  try {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width: 1640, height: 1100 } })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route(/^https?:/, (route) => route.abort())
      await page.goto(pathToFileURL(path.resolve('ui-spec/prototype/星芒AI管理工具-可交互原型.html')).href)
      await page.evaluate((theme) => { S.view = 'app'; S.page = 'home'; S.theme = theme; S.settings.themePref = theme; S.missingClosed = false; S.dialogs = []; render() }, theme)
      assert.equal(await page.getByTestId('home-client-connections').count(), 0)
      assert.equal(await page.getByTestId('home-codex-models').count(), 0)
      for (const id of ['codex', 'codexDesktop']) {
        const row = page.getByTestId(`tool-row-${id}`)
        assert.equal(await row.getByRole('button', { name: '非 GPT 模型', exact: true }).count(), 0)
        await row.getByRole('button', { name: /更多操作/ }).click()
        await page.getByText('非 GPT 模型', { exact: true }).click()
        await page.getByTestId('external-client-dialog').waitFor()
        assert.equal(await page.evaluate(() => topDialog().props.client), 'codexModels')
        await page.getByTestId('external-client-detect').click()
        await page.getByTestId('external-client-save').click()
        await page.getByTestId('external-client-result').getByText('保存结果示意 · 尚未写入', { exact: true }).waitFor()
        await page.evaluate(() => A.closeDialog())
      }
      for (const id of ['workbuddy', 'claudeDesktop', 'opencode']) {
        const row = page.getByTestId(`tool-row-${id}`)
        await row.getByRole('button', { name: '安装', exact: true }).click()
        await row.getByText('正在下载安装包（演示）', { exact: true }).waitFor()
        await row.getByRole('button', { name: '配置', exact: true }).click()
        await page.getByTestId('external-client-detect').click()
        await page.getByTestId('external-client-save').click()
        await page.getByTestId('external-client-result').getByText('保存结果示意 · 尚未写入', { exact: true }).waitFor()
        await page.evaluate(() => A.closeDialog())
        await row.getByRole('button', { name: '打开', exact: true }).click()
        await row.getByText(/运行中/).waitFor()
      }
      await page.locator('.statusbar').getByText('6 个工具已装', { exact: true }).waitFor()
      await page.getByTestId('home-account').getByText('6 个工具已连接', { exact: true }).waitFor()
      await page.evaluate(() => {
        Object.assign(XM.state('externalClients').claudeDesktop, { configured: false, configurationReady: true, configurationSource: 'other', model: null, running: false })
        render()
      })
      const claude = page.getByTestId('tool-row-claudeDesktop')
      await claude.getByText('已配好', { exact: true }).waitFor()
      await claude.getByText(/自动获取模型/).waitFor()
      assert.equal(await claude.getByText('已有第三方配置', { exact: true }).count(), 0)
      await page.getByTestId('home-account').getByText('5 个工具已连接', { exact: true }).waitFor()
      await claude.getByRole('button', { name: '打开', exact: true }).click()
      await claude.getByText(/运行中/).waitFor()
      await page.evaluate(() => {
        XM.state('externalClients').claudeDesktop.configurationReady = false
        render()
      })
      await claude.getByText('待配置', { exact: true }).waitFor()
      assert.equal(await claude.getByRole('button', { name: '打开', exact: true }).count(), 0)
      await page.evaluate(() => {
        XM.state('externalClients').claudeDesktop.configurationReady = true
        Object.assign(XM.state('externalClients').opencode, { configured: false, configurationReady: true })
        render()
      })
      await page.getByTestId('tool-row-opencode').getByText('待配置', { exact: true }).waitFor()
      await page.getByTestId('home-account').getByText('4 个工具已连接', { exact: true }).waitFor()
      await page.evaluate(() => { XM.state('externalClients').opencode.configured = true; render() })
      await page.getByTestId('home-account').getByText('5 个工具已连接', { exact: true }).waitFor()
      await page.waitForTimeout(3200)
      await page.screenshot({ path: path.join(artifacts, `tool-rows-${theme}.png`) })
      assert.deepEqual(errors, [])
      await page.close()
    }
    console.log('Prototype client ToolRows: Codex menu-only model setup, 6 install/configure/open flows and Claude local-readiness/account-count checks passed across light and dark themes.')
  } finally { await browser.close() }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
