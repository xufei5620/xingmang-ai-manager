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
  await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 60_000 })
  await page.locator('.cli-card').nth(1).getByText('星芒 AI 已配置', { exact: true }).waitFor({
    state: 'visible',
    timeout: 30_000,
  })

  const windowMetrics = await application.evaluate(({ BrowserWindow, screen }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0]
    if (!browserWindow) return null
    const bounds = browserWindow.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workAreaSize
    return {
      bounds,
      expected: {
        width: Math.min(1340, workArea.width),
        height: Math.min(845, workArea.height),
      },
    }
  })

  const primaryNavigationLabels = [
    '工具概览',
    '会话管理',
    'MCP 管理',
    'Skills 管理',
    'Plugins/市场',
    '配置备份',
    '健康诊断',
    '安装维护',
  ]
  const utilityNavigationLabels = [
    '反馈与诊断',
    '检查更新',
    '设置',
  ]
  const primaryNavigationTexts = await page.locator('.main-nav .nav-item').allInnerTexts()
  const utilityNavigationTexts = await page.locator('.utility-nav .nav-item').allInnerTexts()
  const codexCliCard = page.locator('.cli-card').nth(1)
  const result = {
    title: await page.title(),
    pageErrors,
    windowMetrics,
    horizontalOverflow: await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    onboardingHidden: await page.locator('.onboarding-shell').count() === 0,
    overviewVisible: await page.getByRole('heading', { name: '工具概览', exact: true }).isVisible(),
    toolCardCount: await page.locator('.cli-card').count(),
    firstToolCard: await page.locator('.cli-card').first().getByRole('heading').innerText(),
    secondToolCard: await codexCliCard.getByRole('heading').innerText(),
    codexConfigRecognized: await codexCliCard.getByText('星芒 AI 已配置', { exact: true }).isVisible(),
    codexModelVisible: await codexCliCard.getByText('gpt-5.6-sol', { exact: true }).isVisible(),
    primaryNavigationTexts: primaryNavigationTexts.map((text) => text.trim()),
    utilityNavigationTexts: utilityNavigationTexts.map((text) => text.trim()),
    providerBrandIconsLoaded: await page.locator('.cli-card .provider-icon img').evaluateAll(
      (icons) => icons.length === 5
        && icons.every((icon) => icon instanceof HTMLImageElement && icon.complete && icon.naturalWidth > 0),
    ),
    settingsReachable: false,
    overviewRestored: false,
  }

  await page.locator('.utility-nav').getByRole('button', { name: '设置', exact: true }).click()
  const settingsPage = page.locator('.main-content [data-page-id="settings"]')
  await settingsPage.waitFor({ state: 'visible' })
  result.settingsReachable = await settingsPage.getByRole('heading', { name: '设置', exact: true }).isVisible()
    && await settingsPage.getByRole('group', { name: '主题' }).isVisible()

  await page.locator('.main-nav').getByRole('button', { name: '工具概览', exact: true }).click()
  result.overviewRestored = await page.getByRole('heading', { name: '工具概览', exact: true }).isVisible()
    && await page.locator('.main-nav .nav-item[aria-current="page"]').innerText() === '工具概览'

  await page.screenshot({ path: path.join(artifactDir, 'dashboard-ci.png') })
  await fs.writeFile(
    path.join(artifactDir, 'dashboard-ci-smoke-result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )

  if (
    result.title !== '星芒AI管理工具'
    || pageErrors.length > 0
    || result.horizontalOverflow
    || Math.abs((result.windowMetrics?.bounds.width ?? 0) - (result.windowMetrics?.expected.width ?? 0)) > 4
    || Math.abs((result.windowMetrics?.bounds.height ?? 0) - (result.windowMetrics?.expected.height ?? 0)) > 4
    || !result.onboardingHidden
    || !result.overviewVisible
    || result.toolCardCount !== 5
    || result.firstToolCard !== 'Codex 桌面端'
    || result.secondToolCard !== 'Codex CLI'
    || !result.codexConfigRecognized
    || !result.codexModelVisible
    || JSON.stringify(result.primaryNavigationTexts) !== JSON.stringify(primaryNavigationLabels)
    || JSON.stringify(result.utilityNavigationTexts) !== JSON.stringify(utilityNavigationLabels)
    || !result.providerBrandIconsLoaded
    || !result.settingsReachable
    || !result.overviewRestored
  ) {
    throw new Error(JSON.stringify(result))
  }
} finally {
  await application.close()
}
