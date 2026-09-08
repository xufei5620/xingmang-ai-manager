import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium } from '@playwright/test'

const fixturePatch = [
  "const auditCase = query.get('audit')",
  "if (auditCase === 'startup-update-fails') { settings.checkUpdatesOnStartup = true; const snapshot = { phase: 'idle', currentVersion: '0.1.31', availableVersion: null, releaseName: null, releaseNotesText: null, checkedAt: null, progress: null, error: null, development: false }; methods.getUpdateState = async () => snapshot; Reflect.set(methods, 'runStartupUpdate', async () => ({ ...snapshot, phase: 'failed', error: { code: 'NETWORK', message: '离线测试更新不可用' } })) }",
  "if (auditCase === 'desktop-running') system.desktopApps.codex.running = true",
  "if (auditCase === 'unknown-config') { config.providers.claude.actualBaseUrl = 'https://fixture.invalid/v1'; config.providers.claude.matchesRelay = false }",
  "const eventNames =",
].join('\n')
let server, browser
const result = { checkedAt: new Date().toISOString(), scope: 'Read-only renderer audit with isolated fixture bridge; no production requests', observations: [], browserErrors: [], blockedRequests: [] }
try {
  server = await createServer({ root: path.resolve('.'), configFile: false, logLevel: 'error', plugins: [{ name: 'audit-local-fixture', enforce: 'pre', transform(code, id) {
    if (id.replaceAll('\\', '/').endsWith('/src/renderer-v2/testing/app-fixture.tsx')) return code.replace('const eventNames =', fixturePatch)
  } }, react()], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port
  browser = await chromium.launch()
  async function open(audit = '') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })
    page.setDefaultTimeout(30000)
    page.on('pageerror', error => result.browserErrors.push(error.message))
    await page.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); result.blockedRequests.push(route.request().url()); return route.abort() })
    await page.goto(origin + '/src/renderer-v2/testing/app.html?audit=' + audit)
    return page
  }
  {
    const page = await open('startup-update-fails')
    try {
      await page.waitForFunction(() => document.querySelector('[data-testid="page-home"]') || document.querySelector('[data-testid="startup-splash"] [role="alert"]'))
      result.observations.push({ id: 'startup-update-failure', homeAccessible: await page.getByTestId('page-home').count() > 0, splashBlocks: await page.getByTestId('startup-splash').count() > 0, text: await page.locator('body').innerText() })
    } finally { await page.close() }
  }
  {
    const page = await open('desktop-running')
    try {
      await page.getByTestId('tool-codexDesktop-primary').click()
      const dialog = page.getByRole('dialog', { name: 'Codex 已在运行', exact: true })
      await dialog.waitFor()
      result.observations.push({ id: 'desktop-restart-entry', buttons: await dialog.getByRole('button').allTextContents(), restartActions: await dialog.getByRole('button', { name: /重启/ }).count() })
    } finally { await page.close() }
  }
  {
    const page = await open()
    try {
      await page.getByTestId('tool-row-claude').getByRole('button', { name: '更多操作' }).click()
      await page.getByRole('menuitem', { name: '配置', exact: true }).click()
      const dialog = page.getByTestId('config-dialog')
      await dialog.waitFor()
      result.observations.push({ id: 'claude-official-source', officialActions: await dialog.getByRole('button', { name: 'Claude 账号', exact: true }).count() })
      await dialog.getByRole('tab', { name: 'Gemini CLI', exact: true }).click()
      result.observations.push({ id: 'gemini-official-source', officialActions: await dialog.getByRole('button', { name: 'Google 账号', exact: true }).count() })
      await dialog.getByRole('button', { name: '自己填写密钥', exact: true }).click()
      await dialog.getByLabel('星芒访问密钥', { exact: true }).fill('sk-fixture-unsaved')
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
      result.observations.push({ id: 'config-cancel-draft', configStillOpen: await page.getByTestId('config-dialog').count() > 0, discardConfirmationVisible: await page.getByText('要放弃未保存的修改吗？').count() > 0 })
    } finally { await page.close() }
  }
  {
    const page = await open('unknown-config')
    try {
      await page.getByTestId('tool-claude-primary').click()
      const dialog = page.getByTestId('config-dialog')
      await dialog.waitFor()
      result.observations.push({ id: 'unknown-source-recovery', sourceOptions: await dialog.getByRole('group').count(), saveDisabled: await dialog.getByTestId('tool-save-config').isDisabled(), recoveryActions: await dialog.getByRole('button').allTextContents() })
    } finally { await page.close() }
  }
  await fs.writeFile('docs/renderer-v2-gap-audit.json', JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(result, null, 2))
} finally { await browser?.close(); await server?.close() }
