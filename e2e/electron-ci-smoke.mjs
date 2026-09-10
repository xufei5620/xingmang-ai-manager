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
  await page.getByTestId('welcome-page').waitFor({ state: 'visible', timeout: 60_000 })

  const windowMetrics = await application.evaluate(({ BrowserWindow, screen }) => {
    const browserWindow = BrowserWindow.getAllWindows()[0]
    if (!browserWindow) return null
    const bounds = browserWindow.getBounds()
    const contentBounds = browserWindow.getContentBounds()
    const maximized = browserWindow.isMaximized()
    const workArea = screen.getDisplayMatching(bounds).workAreaSize
    const expectedMaximized = workArea.width < 1280 || workArea.height < 720
    return {
      bounds,
      contentBounds,
      maximized,
      expectedMaximized,
      // Windows maximized outer bounds include invisible resize borders.
      // The content area is the visible workspace in that state.
      measured: expectedMaximized ? contentBounds : bounds,
      expected: {
        width: expectedMaximized ? workArea.width : Math.max(960, Math.min(1440, Math.round(workArea.width * 0.8))),
        height: expectedMaximized ? workArea.height : Math.max(560, Math.min(900, Math.round(workArea.height * 0.85))),
      },
    }
  })

  const expectedConstellationLabels = ['Claude Code', 'Codex CLI', 'Gemini CLI', 'Grok CLI']
  const result = {
    title: await page.title(),
    pageErrors,
    windowMetrics,
    horizontalOverflow: await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    ),
    welcomeVisible: await page.getByTestId('welcome-page').isVisible(),
    dashboardBlocked: await page.getByTestId('shell-topbar').count() === 0,
    onboardingHidden: await page.getByTestId('start-guide').count() === 0,
    welcomeHeading: await page.getByRole('heading', { name: /装好就能用的\s*AI 编程工具/ }).innerText(),
    constellationLabels: (await page.locator('.auth-orbit-satellite').allInnerTexts()).map((text) => text.trim()),
    registerVisible: await page.getByTestId('welcome-register').isVisible(),
    loginVisible: await page.getByTestId('welcome-login').isVisible(),
    legacyCredentialUiVisible: await page.locator('#onboarding-api-key, .welcome-cta-ghost').count() > 0,
    loginDialogReachable: false,
  }

  await page.getByTestId('welcome-login').click()
  const loginDialog = page.getByTestId('login-dialog')
  await loginDialog.waitFor({ state: 'visible' })
  result.loginDialogReachable = await loginDialog.getByTestId('login-account').isVisible()
    && await loginDialog.getByTestId('login-password').isVisible()
  await loginDialog.getByTestId('login-cancel').click()

  // Chromium's CSS viewport screenshot can crop an Electron window after
  // setZoomFactor. Capture the native content area for the actual layout.
  const windowScreenshot = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return (await window.capturePage()).toPNG().toString('base64')
  })
  await fs.writeFile(path.join(artifactDir, 'welcome-ci.png'), Buffer.from(windowScreenshot, 'base64'))
  await fs.writeFile(
    path.join(artifactDir, 'welcome-ci-smoke-result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )

  if (
    result.title !== '星芒AI管理工具'
    || pageErrors.length > 0
    || result.horizontalOverflow
    || !result.windowMetrics
    || result.windowMetrics.maximized !== result.windowMetrics.expectedMaximized
    || Math.abs(result.windowMetrics.measured.width - result.windowMetrics.expected.width) > 4
    || Math.abs(result.windowMetrics.measured.height - result.windowMetrics.expected.height) > 4
    || !result.welcomeVisible
    || !result.dashboardBlocked
    || !result.onboardingHidden
    || result.welcomeHeading.replace(/\s+/g, '') !== '装好就能用的AI编程工具'
    || JSON.stringify(result.constellationLabels) !== JSON.stringify(expectedConstellationLabels)
    || !result.registerVisible
    || !result.loginVisible
    || result.legacyCredentialUiVisible
    || !result.loginDialogReachable
  ) {
    throw new Error(JSON.stringify(result))
  }
} finally {
  await application.close()
}
