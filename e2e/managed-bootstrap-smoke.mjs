import { _electron as electron } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

if (process.platform !== 'win32') {
  throw new Error('托管登录自动初始化实机验收当前仅用于 Windows')
}

const sessionSource = process.env.XINGMANG_E2E_SESSION_SOURCE
const loginUsername = process.env.XINGMANG_E2E_USERNAME
const loginPassword = process.env.XINGMANG_E2E_PASSWORD
if (!sessionSource && (!loginUsername || !loginPassword)) {
  throw new Error('请提供 XINGMANG_E2E_SESSION_SOURCE，或通过 XINGMANG_E2E_USERNAME / XINGMANG_E2E_PASSWORD 登录')
}

const requiredFiles = ['account-session.dat', 'managed-cli-keys.dat']
const optionalFiles = ['settings.json']
const testUserDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-managed-bootstrap-'))
const artifactDir = path.resolve('artifacts')
await fs.mkdir(artifactDir, { recursive: true })

if (sessionSource) {
  for (const fileName of requiredFiles) {
    await fs.copyFile(path.join(sessionSource, fileName), path.join(testUserDataDir, fileName))
  }
  for (const fileName of optionalFiles) {
    await fs.copyFile(path.join(sessionSource, fileName), path.join(testUserDataDir, fileName)).catch(() => undefined)
  }
}

const launchApplication = () => electron.launch({
  args: ['.', `--user-data-dir=${testUserDataDir}`],
  env: {
    ...process.env,
    XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173',
  },
})

let application = await launchApplication()
let page = await application.firstWindow()
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

try {
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => (
    document.querySelector('.onboarding-shell')
    || document.querySelector('.dashboard-page')
    || document.querySelector('.welcome-page')
  ), null, { timeout: 90_000 })
  const initialDestination = await page.evaluate(() => {
    if (document.querySelector('.onboarding-shell')) return 'onboarding'
    if (document.querySelector('.dashboard-page')) return 'dashboard'
    if (document.querySelector('.welcome-page')) return 'welcome'
    return 'unknown'
  })
  await page.evaluate(() => {
    const trace = {
      onboardingSeen: Boolean(document.querySelector('.onboarding-shell')),
      dashboardSeen: Boolean(document.querySelector('.dashboard-page')),
      progressPanelSeen: Boolean(document.querySelector('.managed-bootstrap-panel')),
      flowLockSeen: Boolean(document.querySelector('.managed-bootstrap-lock')),
      maximumProgress: Number(document.querySelector('.managed-bootstrap-panel progress')?.getAttribute('value') ?? 0),
    }
    Object.assign(window, { __xingmangManagedBootstrapTrace: trace })
    const observe = () => {
      if (document.querySelector('.onboarding-shell')) trace.onboardingSeen = true
      if (document.querySelector('.dashboard-page')) trace.dashboardSeen = true
      if (document.querySelector('.managed-bootstrap-panel')) trace.progressPanelSeen = true
      if (document.querySelector('.managed-bootstrap-lock')) trace.flowLockSeen = true
      const progress = Number(document.querySelector('.managed-bootstrap-panel progress')?.getAttribute('value') ?? 0)
      trace.maximumProgress = Math.max(trace.maximumProgress, Number.isFinite(progress) ? progress : 0)
    }
    observe()
    new MutationObserver(observe).observe(document.documentElement, { childList: true, subtree: true, attributes: true })
  })
  if (initialDestination === 'welcome') {
    if (!loginUsername || !loginPassword) {
      throw new Error('复制的登录会话未能恢复，真实登录验收需要 XINGMANG_E2E_USERNAME / XINGMANG_E2E_PASSWORD')
    }
    await page.locator('.welcome-cta-login').click()
    const loginDialog = page.getByRole('dialog', { name: '登录' })
    await loginDialog.waitFor({ state: 'visible' })
    await loginDialog.getByLabel('用户名或邮箱').fill(loginUsername)
    await loginDialog.getByLabel('密码', { exact: true }).fill(loginPassword)
    await loginDialog.locator('.account-agreement input[type=checkbox]').nth(1).check()
    await loginDialog.getByRole('button', { name: '登录', exact: true }).click()
  }
  const progressPanel = page.locator('.managed-bootstrap-panel')
  await progressPanel.waitFor({ state: 'visible', timeout: 30_000 })
  const lockedInteractionState = await page.evaluate(() => {
    const returnButton = document.querySelector('.onboarding-rail-bottom .sidebar-control-button')
    const mutationButtons = Array.from(document.querySelectorAll(
      '.onboarding-form .onboarding-primary, .onboarding-actions button, .setup-recovery button',
    ))
    return {
      lockNoticeVisible: Boolean(document.querySelector('.managed-bootstrap-lock')),
      returnDisabled: returnButton instanceof HTMLButtonElement ? returnButton.disabled : true,
      mutationButtonsPresent: mutationButtons.length > 0,
      everyMutationButtonDisabled: mutationButtons.every((button) => (
        button instanceof HTMLButtonElement && button.disabled
      )),
    }
  })
  await page.screenshot({ path: path.join(artifactDir, 'managed-bootstrap-progress.png') })
  // No user-flow click is allowed after login submit. Everything below only
  // observes whether the managed onboarding reaches the verified dashboard.
  await page.locator('.dashboard-page').waitFor({ state: 'visible', timeout: 180_000 })
  await page.locator('.dashboard-page').getByRole('heading', { name: '首页', exact: true }).waitFor({ state: 'visible' })

  const result = await page.evaluate(async () => {
    const [session, setup, config, snapshot] = await Promise.all([
      window.xingmang.getAccountSession(),
      window.xingmang.getCodexSetupStatus(),
      window.xingmang.getConfig(),
      window.xingmang.scanSystem(true),
    ])
    const userId = session.account?.userId ?? null
    const installedProviders = Object.entries(snapshot.clis)
      .filter(([, status]) => status.installed)
      .map(([provider]) => provider)
    return {
      trace: window.__xingmangManagedBootstrapTrace,
      sessionAuthenticated: session.authenticated,
      userIdPresent: Number.isSafeInteger(userId) && Number(userId) > 0,
      completionCheckpoint: userId
        ? window.localStorage.getItem(`xingmang-managed-bootstrap-v1:${userId}`)
        : null,
      setup: {
        node: setup.runtime.node.installed && setup.runtime.node.detectionFailed !== true,
        npm: setup.runtime.npm.installed && setup.runtime.npm.detectionFailed !== true,
        cli: setup.cli.installed && setup.cli.detectionFailed !== true,
        desktop: setup.desktop.installed && setup.desktop.detectionFailed !== true,
      },
      providers: Object.fromEntries(Object.entries(config.providers).map(([provider, summary]) => [
        provider,
        {
          hasApiKey: summary.hasApiKey,
          matchesRelay: summary.matchesRelay,
          hasModel: summary.model.trim().length > 0,
        },
      ])),
      installedProviders,
    }
  })
  const firstRunToastError = await page.locator('.toast.error').allTextContents()
  await page.screenshot({ path: path.join(artifactDir, 'managed-bootstrap-dashboard.png') })

  const installedProviderConfigs = result.installedProviders.map((provider) => result.providers[provider])
  const firstRunPassed = result.trace?.onboardingSeen === true
    && result.trace?.dashboardSeen === true
    && result.trace?.progressPanelSeen === true
    && result.trace?.flowLockSeen === true
    && result.trace?.maximumProgress === 100
    && lockedInteractionState.lockNoticeVisible
    && lockedInteractionState.returnDisabled
    && lockedInteractionState.mutationButtonsPresent
    && lockedInteractionState.everyMutationButtonDisabled
    && pageErrors.length === 0
    && firstRunToastError.length === 0
    && result.sessionAuthenticated
    && result.userIdPresent
    && result.completionCheckpoint === '1'
    && Object.values(result.setup).every(Boolean)
    && installedProviderConfigs.every((provider) => (
      provider.hasApiKey && provider.matchesRelay && provider.hasModel
    ))
  if (!firstRunPassed) {
    throw new Error(JSON.stringify({ initialDestination, lockedInteractionState, pageErrors, firstRunToastError, ...result }))
  }

  // Reuse the exact isolated profile to exercise the durable completion
  // checkpoint. A healthy restart must re-scan current CLI configs and still
  // reach the dashboard without rendering onboarding or requiring a click.
  await application.close()
  application = await launchApplication()
  page = await application.firstWindow()
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForFunction(() => (
    document.querySelector('.onboarding-shell')
    || document.querySelector('.dashboard-page')
    || document.querySelector('.welcome-page')
  ), null, { timeout: 90_000 })
  const restartDestination = await page.evaluate(() => {
    if (document.querySelector('.onboarding-shell')) return 'onboarding'
    if (document.querySelector('.dashboard-page')) return 'dashboard'
    if (document.querySelector('.welcome-page')) return 'welcome'
    return 'unknown'
  })
  const restartToastError = await page.locator('.toast.error').allTextContents()
  const passed = firstRunPassed
    && restartDestination === 'dashboard'
    && restartToastError.length === 0
    && pageErrors.length === 0
  const report = {
    initialDestination,
    restartDestination,
    lockedInteractionState,
    pageErrors,
    firstRunToastError,
    restartToastError,
    ...result,
    passed,
  }
  await fs.writeFile(
    path.join(artifactDir, 'managed-bootstrap-result.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  )
  if (!passed) throw new Error(JSON.stringify(report))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  const failure = {
    message: error instanceof Error ? error.message : String(error),
    pageErrors,
    url: page.url(),
    title: await page.title().catch(() => ''),
    text: (await page.locator('body').innerText().catch(() => '')).slice(0, 4_000),
  }
  await page.screenshot({ path: path.join(artifactDir, 'managed-bootstrap-failure.png') }).catch(() => undefined)
  await fs.writeFile(
    path.join(artifactDir, 'managed-bootstrap-failure.json'),
    `${JSON.stringify(failure, null, 2)}\n`,
    'utf8',
  )
  throw error
} finally {
  await application.close()
  await fs.rm(testUserDataDir, { recursive: true, force: true })
}
