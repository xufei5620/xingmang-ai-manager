import { _electron as electron } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { replayCollectedPromise } from './fixture-readiness.mjs'
import { createSmokeRuntime } from './smoke-runtime.mjs'

const artifactDir = path.resolve('artifacts')
const testRoot = path.join(artifactDir, '.e2e-ci-dashboard')
const testHomeDir = path.join(testRoot, 'home')
const testCodexHomeDir = path.join(testHomeDir, '.codex')
const testUserDataDir = path.join(testRoot, 'user-data')
const resultPath = path.join(artifactDir, 'welcome-ci-smoke-result.json')

const { stepBudgetMs, progress, withDeadline, trackProcessIds, attachEvidence, run } = createSmokeRuntime({
  name: 'electron-ci-smoke',
  stepBudgetMs: Number(process.env.XINGMANG_SMOKE_STEP_TIMEOUT_MS ?? 60_000),
  totalBudgetMs: Number(process.env.XINGMANG_SMOKE_TOTAL_TIMEOUT_MS ?? 180_000),
})
attachEvidence(resultPath)

async function main() {
  progress('preparing the isolated application state')
  await fs.mkdir(artifactDir, { recursive: true })
  await fs.rm(testRoot, { recursive: true, force: true })
  await fs.mkdir(testCodexHomeDir, { recursive: true })

  progress('launching Electron')
  const application = await withDeadline('Electron launch', stepBudgetMs, () => electron.launch({
    args: ['.', `--user-data-dir=${testUserDataDir}`],
    timeout: stepBudgetMs,
    env: {
      ...process.env,
      HOME: testHomeDir,
      USERPROFILE: testHomeDir,
      XINGMANG_CODEX_HOME_OVERRIDE: testCodexHomeDir,
      XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
    },
  }))
  const launchedPid = application.process().pid
  if (launchedPid) trackProcessIds([launchedPid])

  // Playwright drives ElectronApplication.evaluate through the main process's
  // Node inspector, and V8 can collect the inspector's promise wrapper while
  // that process is busy. Windows runners hit it where macOS never does: #139
  // failed twice in a row on the first of the two calls below. Both of them
  // only read window geometry and capture a frame, so replaying one changes
  // nothing. The window close smoke deliberately does not retry, because its
  // evaluations drive the quit lifecycle and a replay would change the test.
  const evaluateInMainProcess = (label, body) => replayCollectedPromise(label,
    (attempt) => withDeadline(`${label} (attempt ${attempt})`, stepBudgetMs, () => application.evaluate(body)), { progress })

  progress('waiting for the first window')
  const page = await withDeadline('first window', stepBudgetMs, () => application.firstWindow({ timeout: stepBudgetMs }))
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  try {
    progress('waiting for the welcome page')
    await withDeadline('document load', stepBudgetMs, () => page.waitForLoadState('domcontentloaded'))
    await withDeadline('welcome page', stepBudgetMs, () => page.getByTestId('welcome-page').waitFor({ state: 'visible', timeout: stepBudgetMs }))

    progress('measuring the window geometry')
    const windowMetrics = await evaluateInMainProcess('window metrics', ({ BrowserWindow, screen }) => {
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

    progress('reading the welcome page')
    const expectedConstellationLabels = ['Claude Code', 'Codex CLI', 'Gemini CLI', 'Grok CLI']
    const result = {
      title: await withDeadline('document title', stepBudgetMs, () => page.title()),
      pageErrors,
      windowMetrics,
      horizontalOverflow: await withDeadline('overflow probe', stepBudgetMs, () => page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      )),
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

    progress('opening the login dialog')
    await page.getByTestId('welcome-login').click()
    const loginDialog = page.getByTestId('login-dialog')
    await loginDialog.waitFor({ state: 'visible' })
    result.loginDialogReachable = await loginDialog.getByTestId('login-account').isVisible()
      && await loginDialog.getByTestId('login-password').isVisible()
    await loginDialog.getByTestId('login-cancel').click()

    progress('capturing the window')
    // Chromium's CSS viewport screenshot can crop an Electron window after
    // setZoomFactor. Capture the native content area for the actual layout.
    const windowScreenshot = await evaluateInMainProcess('window capture', async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return (await window.capturePage()).toPNG().toString('base64')
    })
    await fs.writeFile(path.join(artifactDir, 'welcome-ci.png'), Buffer.from(windowScreenshot, 'base64'))
    await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')

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
    progress('closing Electron')
    await withDeadline('close', 20_000, () => application.close()).catch(() => undefined)
  }
}

await run(main)
