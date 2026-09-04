import { _electron as electron } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const artifactDir = path.resolve('artifacts')
await fs.mkdir(artifactDir, { recursive: true })
const testUserDataDir = path.join(artifactDir, '.e2e-onboarding-user-data')
await fs.rm(testUserDataDir, { recursive: true, force: true })

const application = await electron.launch({
  args: ['.', `--user-data-dir=${testUserDataDir}`],
  env: {
    ...process.env,
    XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
    XINGMANG_ONBOARDING_PREVIEW: '1',
  },
})
const page = await application.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

try {
  await page.waitForLoadState('domcontentloaded')
  await page.getByRole('heading', { name: '初始化 Codex 配置' }).waitFor({ state: 'visible' })
  await page.screenshot({ path: path.join(artifactDir, 'onboarding-dark.png') })
  const windowMetrics = await application.evaluate(({ BrowserWindow, screen }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0]
    if (!browserWindow) return null
    const bounds = browserWindow.getBounds()
    const workArea = screen.getDisplayMatching(bounds).workAreaSize
    return {
      bounds,
      expected: {
        width: Math.min(720, workArea.width),
        height: Math.min(520, workArea.height),
      },
    }
  })

  const startButton = page.getByRole('button', { name: '开始初始化' })
  const themeToggle = page.locator('.onboarding-rail .theme-toggle')
  const result = {
    title: await page.title(),
    viewport: page.viewportSize(),
    windowMetrics,
    pageErrors,
    horizontalOverflow: await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    headingVisible: await page.getByRole('heading', { name: '初始化 Codex 配置' }).isVisible(),
    managedAuthorizationVisible: await page.locator('.onboarding-managed-authorization').isVisible(),
    legacyCredentialUiVisible: await page.locator('#onboarding-api-key, .welcome-cta-ghost').count() > 0,
    defaultModelVisible: await page.getByText('gpt-5.6-sol', { exact: true }).isVisible(),
    stepCount: await page.locator('.onboarding-step').count(),
    startButtonVisible: await startButton.isVisible(),
    startButtonEnabledForManagedFlow: !(await startButton.isDisabled()),
    dashboardHidden: await page.locator('.app-shell').count() === 0,
    themeToggleVisible: await themeToggle.isVisible(),
    defaultThemeDark: await page.locator('html').getAttribute('data-theme') === 'dark',
    themeToggleAtBottom: await themeToggle.evaluate((button) => {
      const rail = button.closest('.onboarding-rail')
      if (!rail) return false
      return button.getBoundingClientRect().top > rail.getBoundingClientRect().height / 2
    }),
  }

  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  result.darkThemeApplied = await page.evaluate(() => (
    document.documentElement.dataset.theme === 'dark'
      && window.localStorage.getItem('xingmang-theme-v2') === 'dark'
  ))
  await page.waitForTimeout(220)
  await themeToggle.click()
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  result.lightThemeRestored = await page.evaluate(() => (
    document.documentElement.dataset.theme === 'light'
      && window.localStorage.getItem('xingmang-theme-v2') === 'light'
  ))
  await page.waitForTimeout(220)
  result.lightTitleBarApplied = await page.locator('.window-titlebar').evaluate((titlebar) => (
    getComputedStyle(titlebar).backgroundColor === 'rgb(255, 255, 255)'
  ))
  await page.screenshot({ path: path.join(artifactDir, 'onboarding.png') })

  await fs.writeFile(
    path.join(artifactDir, 'onboarding-smoke-result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )

  if (
    pageErrors.length
    || result.horizontalOverflow
    || Math.abs((result.windowMetrics?.bounds.width ?? 0) - (result.windowMetrics?.expected.width ?? 0)) > 4
    || Math.abs((result.windowMetrics?.bounds.height ?? 0) - (result.windowMetrics?.expected.height ?? 0)) > 4
    || !result.headingVisible
    || !result.managedAuthorizationVisible
    || result.legacyCredentialUiVisible
    || !result.defaultModelVisible
    || result.stepCount !== 3
    || !result.startButtonVisible
    || !result.startButtonEnabledForManagedFlow
    || !result.dashboardHidden
    || !result.themeToggleVisible
    || !result.defaultThemeDark
    || !result.themeToggleAtBottom
    || !result.darkThemeApplied
    || !result.lightThemeRestored
    || !result.lightTitleBarApplied
  ) {
    throw new Error(JSON.stringify(result))
  }
} finally {
  await application.close()
}
