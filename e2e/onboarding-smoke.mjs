import assert from 'node:assert/strict'
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const artifactDir = path.resolve('artifacts')
const testRoot = path.join(artifactDir, '.e2e-onboarding-user-data')
const testHome = path.join(testRoot, 'home')
await fs.mkdir(artifactDir, { recursive: true })
await fs.rm(testRoot, { recursive: true, force: true })
await fs.mkdir(path.join(testHome, '.codex'), { recursive: true })

const application = await electron.launch({
  args: ['.', `--user-data-dir=${path.join(testRoot, 'user-data')}`],
  env: {
    ...process.env,
    HOME: testHome,
    USERPROFILE: testHome,
    XINGMANG_CODEX_HOME_OVERRIDE: path.join(testHome, '.codex'),
    XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
    XINGMANG_ONBOARDING_PREVIEW: '1',
  },
})
const page = await application.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

async function screenshot(name) {
  const content = await application.evaluate(async ({ BrowserWindow }) => (
    (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64')
  ))
  await fs.writeFile(path.join(artifactDir, name), Buffer.from(content, 'base64'))
}

try {
  await page.getByRole('heading', { name: '选择一种开始方式' }).waitFor()
  assert.equal(await page.locator('[data-testid="start-guide"]').getAttribute('data-guide-route'), '')
  assert.equal(await page.getByRole('radio', { checked: true }).count(), 0)
  assert.equal(await page.getByRole('radio').count(), process.platform === 'linux' ? 5 : 6)
  assert.equal(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled(), true)
  assert.equal(await page.locator('.start-guide-steps > li').count(), 4)
  await screenshot('onboarding-dark.png')

  await page.getByRole('radio', { name: /直接聊天/ }).check()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await page.locator('[data-guide-step="ready"]').waitFor()
  assert.equal(await page.getByRole('button', { name: '开始聊天', exact: true }).isEnabled(), true)
  // Preview can inspect the guide, but cannot bypass the production login gate.
  await page.getByRole('button', { name: '开始聊天', exact: true }).click()
  await page.getByText('请先登录星芒账号', { exact: true }).waitFor()
  assert.equal(await page.locator('.app-shell').count(), 0)
  await page.getByRole('button', { name: '上一步', exact: true }).click()
  await page.locator('[data-guide-step="choose"]').waitFor()
  assert.equal(await page.getByRole('radio', { name: /直接聊天/ }).isChecked(), true)

  await page.evaluate(() => window.xingmang.saveSettings({ version: 2, theme: 'light' }))
  await page.reload()
  await page.getByRole('heading', { name: '选择一种开始方式' }).waitFor()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await screenshot('onboarding.png')
  const result = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return { bounds: window.getBounds(), workArea: screen.getDisplayMatching(window.getBounds()).workArea, zoom: window.webContents.getZoomFactor() }
  })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  assert.equal(overflow, false)
  assert.deepEqual(pageErrors, [])
  assert.ok(result.bounds.x >= result.workArea.x && result.bounds.y >= result.workArea.y)
  assert.ok(result.bounds.width <= result.workArea.width && result.bounds.height <= result.workArea.height)
  await fs.writeFile(path.join(artifactDir, 'onboarding-smoke-result.json'), JSON.stringify({
    ...result, pageErrors, horizontalOverflow: overflow, explicitSelection: true,
    directChatWithoutNode: true, loginBoundaryPreserved: true, persistedLightTheme: true,
  }, null, 2) + '\n', 'utf8')
} finally {
  await application.close()
}
