import { _electron as electron } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const artifactDir = path.resolve('artifacts')
const testRoot = path.join(artifactDir, '.e2e-ci-dashboard')
const testHomeDir = path.join(testRoot, 'home')
const testCodexHomeDir = path.join(testHomeDir, '.codex')
const testUserDataDir = path.join(testRoot, 'user-data')

await fs.mkdir(artifactDir, { recursive: true })
await fs.rm(testRoot, { recursive: true, force: true })
await fs.mkdir(testCodexHomeDir, { recursive: true })
await fs.writeFile(
  path.join(testCodexHomeDir, 'config.toml'),
  [
    'model_provider = "solov"',
    'model = "gpt-5.6-sol"',
    'review_model = "gpt-5.6-sol"',
    '',
    '[model_providers.solov]',
    'name = "solov"',
    'base_url = "https://xm.solov.cc"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n'),
  'utf8',
)
await fs.writeFile(
  path.join(testCodexHomeDir, 'auth.json'),
  `${JSON.stringify({ OPENAI_API_KEY: 'ci-smoke-placeholder-key' }, null, 2)}\n`,
  'utf8',
)

const application = await electron.launch({
  args: ['.', `--user-data-dir=${testUserDataDir}`],
  env: {
    ...process.env,
    HOME: testHomeDir,
    USERPROFILE: testHomeDir,
    XINGMANG_CODEX_HOME_OVERRIDE: testCodexHomeDir,
    XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
  },
})
const page = await application.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

try {
  await page.waitForLoadState('domcontentloaded')
  await page.locator('.welcome-page').waitFor({ state: 'visible', timeout: 60_000 })

  const windowMetrics = await application.evaluate(({ BrowserWindow, screen }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0]
    if (!browserWindow) return null
    const bounds = browserWindow.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workAreaSize
    return {
      bounds,
      expected: {
        width: Math.min(1590, workArea.width),
        height: Math.min(875, workArea.height),
      },
    }
  })

  const expectedConstellationLabels = ['Claude Code', 'Codex', 'Gemini', 'Grok']
  const result = {
    title: await page.title(),
    pageErrors,
    windowMetrics,
    horizontalOverflow: await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    welcomeVisible: await page.locator('.welcome-page').isVisible(),
    dashboardBlocked: await page.locator('.app-shell').count() === 0,
    onboardingHidden: await page.locator('.onboarding-shell').count() === 0,
    welcomeHeading: await page.getByRole('heading', { name: /装好即用的\s*AI 编程工具箱/ }).innerText(),
    constellationLabels: (await page.locator('.welcome-node').allInnerTexts()).map((text) => text.trim()),
    registerVisible: await page.getByRole('button', { name: '免费注册，领试用额度', exact: true }).isVisible(),
    loginVisible: await page.getByRole('button', { name: '已有账号？登录', exact: true }).isVisible(),
    manualCodeVisible: await page.getByRole('button', { name: '我有授权码', exact: true }).isVisible(),
    loginDialogReachable: false,
  }

  await page.getByRole('button', { name: '已有账号？登录', exact: true }).click()
  const loginDialog = page.getByRole('dialog', { name: '登录星芒账号' })
  await loginDialog.waitFor({ state: 'visible' })
  result.loginDialogReachable = await loginDialog.getByLabel('用户名或邮箱').isVisible()
    && await loginDialog.getByRole('textbox', { name: '密码', exact: true }).isVisible()
  await loginDialog.getByTitle('关闭').click()

  await page.screenshot({ path: path.join(artifactDir, 'welcome-ci.png') })
  await fs.writeFile(
    path.join(artifactDir, 'welcome-ci-smoke-result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )

  if (
    result.title !== '星芒AI管理工具'
    || pageErrors.length > 0
    || result.horizontalOverflow
    || Math.abs((result.windowMetrics?.bounds.width ?? 0) - (result.windowMetrics?.expected.width ?? 0)) > 4
    || Math.abs((result.windowMetrics?.bounds.height ?? 0) - (result.windowMetrics?.expected.height ?? 0)) > 4
    || !result.welcomeVisible
    || !result.dashboardBlocked
    || !result.onboardingHidden
    || result.welcomeHeading.replace(/\s+/g, '') !== '装好即用的AI编程工具箱'
    || JSON.stringify(result.constellationLabels) !== JSON.stringify(expectedConstellationLabels)
    || !result.registerVisible
    || !result.loginVisible
    || !result.manualCodeVisible
    || !result.loginDialogReachable
  ) {
    throw new Error(JSON.stringify(result))
  }
} finally {
  await application.close()
}
