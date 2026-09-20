import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'
import { createSmokeRuntime } from './smoke-runtime.mjs'

// T-G5: 这份冒烟写完之后从来没人跑过。挡住它进 CI 的是两件事，都在这里修掉了：
//
// 1. 它此前不写 windowState，于是 resolveWindowPlacement 走「无保存状态」那条分支，
//    在工作区小于 1280x720 的 runner 上直接把窗口最大化；Windows 上最大化的窗口
//    setContentSize 是空操作，三次改宽全部落空，脚本只会干等到超时。现在先写一份
//    非最大化的 windowState，改尺寸前再 unmaximize 一次兜底，并断言真实拿到的内容
//    宽度就是请求的宽度——runner 要是仍然拒绝，这里要红得能看出原因，而不是被绕过。
//
// 2. 它把期望缩放写成 contentWidth / 1280。写进窗口的是
//    electron/platform/renderer-v2.ts 的 apply()，它的 resize 监听在
//    queueMicrotask 里注册、晚于 main.ts 的 applyPreferences，所以最后写入的是
//    平台层那条。当时两处各有一份公式、下限不同（0.7 与 0.8），960 宽算出
//    0.75 与 0.8 两个答案；公式随后已合成一份（platform/zoom.ts 转调
//    calculateUiZoom，统一下限 0.7），两个入口再也算不出不同值。这里的期望值
//    照同一条公式算，不再依赖哪一条监听最后跑。

const UI_DESIGN_WIDTH_DIP = 1280
// 与 electron/window-preferences.ts 那份唯一公式的常量同值（platform/zoom.ts 转出的就是
// 它们）。冒烟脚本不 import 主进程产物（那是压缩过的 CommonJS），这份重复是有意的：
// 它表达的是「产品应该算出什么」，独立于被测代码。
const UI_MIN_ZOOM = 0.7
const UI_MAX_ZOOM = 1.25
const widths = [960, 1280, 1440]

const { stepBudgetMs, progress, withDeadline, trackProcessIds, attachEvidence, run } = createSmokeRuntime({
  name: 'renderer-v2-native',
  stepBudgetMs: Number(process.env.XINGMANG_SMOKE_STEP_TIMEOUT_MS ?? 60_000),
  totalBudgetMs: Number(process.env.XINGMANG_SMOKE_TOTAL_TIMEOUT_MS ?? 240_000),
})

function expectedZoom(contentWidthDip) {
  const automatic = Math.min(UI_MAX_ZOOM, Math.max(UI_MIN_ZOOM, contentWidthDip / UI_DESIGN_WIDTH_DIP))
  return Math.round(automatic * 10_000) / 10_000
}

async function main() {
  progress('preparing the isolated profile')
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-v2-native-'))
  const userHome = path.join(sandbox, 'home')
  await fs.mkdir(userHome)
  const userData = path.join(sandbox, 'user-data')
  await fs.mkdir(userData)
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({
    version: 2,
    workspace: '',
    theme: 'dark',
    checkUpdatesOnStartup: false,
    runDiagnosticsOnStartup: false,
    // 有保存状态 = resolveWindowPlacement 用它的 maximized，而不是按工作区大小自己决定。
    windowState: { bounds: { x: 0, y: 0, width: 1280, height: 820 }, maximized: false },
  }), 'utf8')
  const output = path.resolve('artifacts/renderer-v2-native')
  await fs.mkdir(output, { recursive: true })
  const resultPath = path.join(output, 'result.json')
  attachEvidence(resultPath)

  progress('launching Electron')
  const application = await withDeadline('Electron launch', stepBudgetMs, () => electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    timeout: stepBudgetMs,
    env: {
      ...process.env,
      HOME: userHome,
      USERPROFILE: userHome,
      XINGMANG_RENDERER: '',
      VITE_DEV_SERVER_URL: '',
      XINGMANG_CODEX_HOME_OVERRIDE: path.join(userHome, '.codex'),
      XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
    },
  }))
  const launchedPid = application.process().pid
  if (launchedPid) trackProcessIds([launchedPid])

  const checks = []
  const errors = []
  // 验收证据里写死的 `true` 会在部分失败时照样打印出来，看起来像「这条也过了」。
  // 只有在对应断言真的跑过之后才允许把名字推进来。
  const passedAssertions = []
  // 证据只在 finally 里写一次，失败时写的是「跑到哪为止」的那一份。
  const evidence = { checks, errors, passedAssertions, profile: sandbox }

  // Playwright drives ElectronApplication.evaluate through the main process's
  // Node inspector, and V8 can collect the inspector's promise wrapper while
  // that process is busy. Windows runners hit it where Linux never does: quality
  // run 35542609628 lost the 1440px iteration to it after the same commit had
  // passed one run earlier. Every evaluation below either reads window geometry,
  // captures a frame, or sets a size the window may already have, so replaying
  // one changes nothing. The close-race smoke deliberately does not retry,
  // because its evaluations drive the quit lifecycle.
  async function evaluateInMainProcess(label, body, argument) {
    let collected
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { return await withDeadline(`${label} (attempt ${attempt})`, stepBudgetMs, () => application.evaluate(body, argument)) }
      catch (error) {
        if (!/Resulting promise was garbage collected/.test(String(error?.message))) throw error
        collected = error
        progress(`${label}: the inspector promise was collected, retrying`)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
    throw collected
  }

  async function readWindowState() {
    return evaluateInMainProcess('window state', ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null
      return { bounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor(), maximized: window.isMaximized() }
    })
  }

  async function waitForWindowZoom(expected, timeout = stepBudgetMs) {
    const deadline = Date.now() + timeout
    let state = null
    while (Date.now() < deadline) {
      state = await readWindowState()
      if (state && Math.abs(state.zoom - expected) < 0.001) return state
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`Native zoom did not settle: expected ${expected}, got ${JSON.stringify(state)}`)
  }

  try {
    progress('waiting for the first window')
    const page = await withDeadline('first window', stepBudgetMs, () => application.firstWindow({ timeout: stepBudgetMs }))
    // `electron.launch()` can resolve as soon as the main process is spawned,
    // before Playwright has attached its Electron RPC bridge. Calling
    // `application.evaluate()` in that gap is flaky (`Resulting promise was garbage
    // collected`). Acquiring the first renderer window establishes the ready
    // event before using main-process evaluation.
    const profile = await evaluateInMainProcess('profile path', ({ app }) => app.getPath('userData'))
    assert.equal(path.resolve(profile), path.resolve(userData), 'Native smoke must use its isolated profile')
    passedAssertions.push('runs-in-an-isolated-profile')
    page.on('pageerror', (error) => errors.push(error.message))

    progress('waiting for the welcome page')
    await withDeadline('welcome page', stepBudgetMs, () => page.getByTestId('welcome-page').waitFor({ timeout: stepBudgetMs }))
    const platform = await withDeadline('platform preload', stepBudgetMs, () => page.evaluate(() => window.xingmangPlatform?.getState()))
    assert.ok(platform, 'The isolated native platform preload must be available')
    passedAssertions.push('isolated-platform-preload-available')

    for (const width of widths) {
      progress(`measuring the ${width}px viewport`)
      const applied = await evaluateInMainProcess('content size', ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        // 最大化的窗口在 Windows 上忽略 setContentSize，于是三次改宽全部落空。
        if (window.isMaximized()) window.unmaximize()
        window.setContentSize(size, 820)
        return window.getContentBounds()
      }, width)
      assert.equal(applied.width, width, `The runner must honour a ${width}px content width, got ${JSON.stringify(applied)}`)
      const expected = expectedZoom(width)
      const geometry = await waitForWindowZoom(expected)
      // 固定 1280 逻辑宽：缩放没有触到上下限时，CSS 视口宽必须回到设计稿的 1280。
      await withDeadline('logical width', stepBudgetMs, () => page.waitForFunction(() => Math.abs(window.innerWidth - 1280) <= 1))
      await withDeadline('image decode', stepBudgetMs, () => page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0)))
      const capture = await evaluateInMainProcess('window capture', async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
      await fs.writeFile(path.join(output, `welcome-${width}.png`), Buffer.from(capture, 'base64'))
      checks.push({ width, expectedZoom: expected, ...geometry })
    }
    assert.equal(checks.length, widths.length)
    passedAssertions.push('zoom-follows-the-platform-formula-at-every-width')

    progress('checking the star canvas')
    await page.getByTestId('welcome-motion').click()
    await withDeadline('reduced motion', stepBudgetMs, () => page.waitForFunction(() => document.documentElement.dataset.reducedMotion === 'true'))
    evidence.pixels = await withDeadline('canvas pixels', stepBudgetMs, () => page.getByTestId('welcome-starfield').evaluate((canvas) => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let visible = 0
      for (let i = 3; i < data.length; i += 4) if (data[i]) visible++
      return { visible, total: canvas.width * canvas.height }
    }))
    assert.ok(evidence.pixels.visible > evidence.pixels.total * 0.01, 'The star canvas must contain rendered pixels')
    passedAssertions.push('star-canvas-renders-pixels')

    progress('checking that preferences survive a reload')
    await withDeadline('high contrast', stepBudgetMs, () => page.evaluate(() => window.xingmangPlatform.setHighContrast(true)))
    await withDeadline('high contrast applied', stepBudgetMs, () => page.waitForFunction(() => document.documentElement.classList.contains('hc')))
    await withDeadline('theme preference', stepBudgetMs, () => page.evaluate(() => window.xingmangPlatform.setThemePreference('light')))
    await withDeadline('theme applied', stepBudgetMs, () => page.waitForFunction(() => document.documentElement.dataset.theme === 'light'))
    await withDeadline('reload', stepBudgetMs, () => page.reload())
    await withDeadline('welcome page after reload', stepBudgetMs, () => page.getByTestId('welcome-page').waitFor({ timeout: stepBudgetMs }))
    await withDeadline('preferences after reload', stepBudgetMs, () => page.waitForFunction(() => document.documentElement.classList.contains('hc') && document.documentElement.dataset.theme === 'light'))
    const restored = await withDeadline('platform state', stepBudgetMs, () => page.evaluate(() => window.xingmangPlatform.getState()))
    assert.equal(restored.preferences.highContrast, true)
    passedAssertions.push('high-contrast-and-theme-survive-reload')

    assert.deepEqual(errors, [])
    passedAssertions.push('no-renderer-exceptions')
    return { viewports: checks.length, errors, output }
  } finally {
    progress('closing Electron')
    await fs.writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8').catch(() => undefined)
    await withDeadline('exit', 20_000, () => application.evaluate(({ app }) => app.exit(0))).catch(() => undefined)
    await withDeadline('close', 20_000, () => application.close()).catch(() => undefined)
  }
}

await run(main)
