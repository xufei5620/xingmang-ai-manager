// Manual verification script for 阶段 D task 3 (docs/CANVAS-INTEGRATION-PLAN.md):
// drives a real, compiled Electron build with Playwright to confirm the
// "无限画布" nav item actually opens the isolated canvas BrowserWindow and
// that infinite-canvas renders inside it. Not wired into package.json / CI
// yet -- run manually via `npm run compile && node e2e/canvas-window-smoke.mjs`
// after a local `xingmang-canvas/web` build has been vendored into
// dist-canvas/ (scripts/copy-canvas-assets.mjs). Modeled on
// e2e/electron-ci-smoke.mjs's minimal codex fixture (just config.toml +
// auth.json, no fake npm install) and e2e/electron-smoke.mjs's launch/shadow
// HOME pattern -- never touches the real user profile or any real config.
import { _electron as electron } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'

const artifactDir = path.resolve('artifacts')
const testRoot = path.join(artifactDir, '.e2e-canvas-window-smoke')
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
    'base_url = "https://api.solov.cc"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
  ].join('\n'),
  'utf8',
)
await fs.writeFile(
  path.join(testCodexHomeDir, 'auth.json'),
  `${JSON.stringify({ OPENAI_API_KEY: 'canvas-smoke-placeholder-key' }, null, 2)}\n`,
  'utf8',
)

const result = {
  startedAt: new Date().toISOString(),
  mainWindowReached: false,
  initialWindowCount: null,
  navItemVisible: false,
  secondWindowOpened: false,
  secondWindowUrl: null,
  secondWindowTitle: null,
  canvasWindowCountAfterClick: null,
  canvasPageLoaded: false,
  canvasPageErrors: [],
  canvasConsoleErrors: [],
  canvasBodyTextSample: null,
  canvasVisibleElementCount: null,
  // Known bug (see report for the task this script was written for):
  // canvas-window.ts loads xingmang-canvas://app/index.html, which sets
  // window.location.pathname to "/index.html". infinite-canvas's own
  // createBrowserRouter (a real History-API router, confirmed in
  // docs/CANVAS-INTEGRATION-PLAN.md's 阶段 B recon notes) has no route
  // registered for that literal path -- only "/" -- so it immediately
  // renders its own NotFound/404 route instead of the real app, on every
  // single open. This flag makes that regression explicit and machine
  // checkable rather than something a human has to notice in a screenshot.
  canvasRouterShowsNotFound: null,
  // Diagnostic-only, and only populated when canvasRouterShowsNotFound is
  // true: re-navigates the same already-open canvas Page directly to the
  // bare origin root (xingmang-canvas://app/, no /index.html) to confirm
  // the 404 is *specifically* the loadURL pathname bug above, and that the
  // rest of the app renders correctly once past it. Not a substitute for
  // fixing canvas-window.ts -- see the report.
  rootPathWorkaround: null,
  screenshots: {},
  notes: [],
}

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

try {
  const mainPage = await application.firstWindow()
  const mainPageErrors = []
  mainPage.on('pageerror', (error) => mainPageErrors.push(error.message))

  await mainPage.waitForLoadState('domcontentloaded')
  await mainPage.locator('.app-shell').waitFor({ state: 'visible', timeout: 60_000 })
  // Wait past the welcome/onboarding gate -- the codex fixture above should
  // make getCodexReadiness() report hasApiKey+matchesRelay, landing directly
  // on the dashboard (see App.tsx's initialize()).
  await mainPage.locator('.main-nav').waitFor({ state: 'visible', timeout: 30_000 })
  result.mainWindowReached = true
  result.mainPageErrors = mainPageErrors

  result.initialWindowCount = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

  const canvasNavButton = mainPage.locator('.main-nav').getByRole('button', { name: '无限画布', exact: true })
  result.navItemVisible = await canvasNavButton.isVisible()

  await mainPage.screenshot({ path: path.join(artifactDir, 'canvas-smoke-01-dashboard.png') })
  result.screenshots.dashboard = path.join(artifactDir, 'canvas-smoke-01-dashboard.png')

  if (!result.navItemVisible) {
    result.notes.push('无限画布导航项不可见，未点击。')
  } else {
    const [canvasPage] = await Promise.all([
      application.waitForEvent('window', { timeout: 30_000 }).catch((error) => {
        result.notes.push(`等待第二个窗口事件超时或失败：${error instanceof Error ? error.message : String(error)}`)
        return null
      }),
      canvasNavButton.click(),
    ])

    // Give main.ts's async open() (token resolution + BrowserWindow
    // construction) a moment even if the 'window' event above didn't fire,
    // then inspect real window state from the main process as the source of
    // truth rather than trusting only the Playwright-side event.
    await mainPage.waitForTimeout(1_000)
    const windows = await application.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows().map((window) => ({
        title: window.getTitle(),
        url: window.webContents.getURL(),
        bounds: window.getBounds(),
        destroyed: window.isDestroyed(),
      }))
    ))
    result.canvasWindowCountAfterClick = windows.length
    const canvasWindowInfo = windows.find((window) => window.url.startsWith('xingmang-canvas://'))
    result.secondWindowOpened = Boolean(canvasWindowInfo)
    result.secondWindowUrl = canvasWindowInfo?.url ?? null
    result.secondWindowTitle = canvasWindowInfo?.title ?? null
    result.allWindowsAfterClick = windows

    const canvasContentPage = canvasPage ?? application.windows().find((page) => (
      page.url().startsWith('xingmang-canvas://')
    ))

    if (canvasContentPage) {
      const consoleErrors = []
      const pageErrors = []
      canvasContentPage.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(message.text())
      })
      canvasContentPage.on('pageerror', (error) => pageErrors.push(error.message))
      try {
        await canvasContentPage.waitForLoadState('domcontentloaded', { timeout: 30_000 })
        // infinite-canvas is a client-rendered SPA; give its module script a
        // beat to mount past the bare index.html shell before inspecting it.
        await canvasContentPage.waitForTimeout(2_000)
        result.canvasPageLoaded = true
        result.canvasBodyTextSample = (await canvasContentPage.locator('body').innerText()).slice(0, 500)
        result.canvasVisibleElementCount = await canvasContentPage.locator('body *').count()
        result.canvasRouterShowsNotFound = result.canvasBodyTextSample.trimStart().startsWith('404')
        await canvasContentPage.screenshot({ path: path.join(artifactDir, 'canvas-smoke-02-canvas-window.png') })
        result.screenshots.canvasWindow = path.join(artifactDir, 'canvas-smoke-02-canvas-window.png')

        if (result.canvasRouterShowsNotFound) {
          result.notes.push(
            '画布窗口打开且 URL 正确，但页面渲染的是画布自身路由器的 404（NotFound）视图，不是真实画布 UI。'
            + '见 rootPathWorkaround 与任务报告中的根因分析。',
          )
          const workaround = { attempted: true }
          try {
            await canvasContentPage.goto('xingmang-canvas://app/')
            await canvasContentPage.waitForLoadState('domcontentloaded', { timeout: 30_000 })
            await canvasContentPage.waitForTimeout(2_000)
            workaround.bodyTextSample = (await canvasContentPage.locator('body').innerText()).slice(0, 500)
            workaround.visibleElementCount = await canvasContentPage.locator('body *').count()
            workaround.stillShowsNotFound = workaround.bodyTextSample.trimStart().startsWith('404')
            await canvasContentPage.screenshot({
              path: path.join(artifactDir, 'canvas-smoke-03-root-path-workaround.png'),
            })
            result.screenshots.rootPathWorkaround = path.join(artifactDir, 'canvas-smoke-03-root-path-workaround.png')
          } catch (error) {
            workaround.error = error instanceof Error ? error.message : String(error)
          }
          result.rootPathWorkaround = workaround
        }
      } catch (error) {
        result.notes.push(`画布页面加载/截图失败：${error instanceof Error ? error.message : String(error)}`)
      }
      result.canvasConsoleErrors = consoleErrors
      result.canvasPageErrors = pageErrors
    } else {
      result.notes.push('未能获取画布窗口的 Page 对象（既没有触发 window 事件，也没能按 URL 找到）。')
    }
  }
} finally {
  await fs.writeFile(
    path.join(artifactDir, 'canvas-window-smoke-result.json'),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )
  await application.close()
}

console.log(JSON.stringify(result, null, 2))
