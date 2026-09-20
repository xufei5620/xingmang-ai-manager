import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'
import { createSmokeRuntime } from './smoke-runtime.mjs'

// T-G5: 写完之后从来没接进任何地方。它验的是一条没有别的套件覆盖的保证：导航已经
// commit、新的 React root 还没挂上来的那个窗口里，关闭请求必须绕过渲染层握手，而不是
// 干等它 15 秒超时。接进 CI 时按 #131 / #133 的口径改走 smoke-runtime：这里的每一个
// 等待原本都没有超时，一旦 Electron 卡住就是整个作业被 runner 在上限处取消、什么也不打印。

const closeBudgetMs = 5_000

const { stepBudgetMs, progress, withDeadline, trackProcessIds, attachEvidence, run } = createSmokeRuntime({
  name: 'renderer-v2-native-close-race',
  stepBudgetMs: Number(process.env.XINGMANG_SMOKE_STEP_TIMEOUT_MS ?? 60_000),
  totalBudgetMs: Number(process.env.XINGMANG_SMOKE_TOTAL_TIMEOUT_MS ?? 180_000),
})

async function main() {
  progress('preparing the isolated profile')
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-v2-close-race-'))
  const userHome = path.join(sandbox, 'home')
  const userData = path.join(sandbox, 'user-data')
  await fs.mkdir(userHome)
  await fs.mkdir(userData)
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({
    version: 2,
    workspace: userHome,
    theme: 'dark',
    checkUpdatesOnStartup: false,
    runDiagnosticsOnStartup: false,
    closeBehavior: 'quit',
  }) + '\n', 'utf8')
  const resultPath = path.resolve('artifacts/renderer-v2-native-close-race.json')
  await fs.mkdir(path.dirname(resultPath), { recursive: true })
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
  const child = application.process()
  if (child.pid) trackProcessIds([child.pid])
  const started = Date.now()
  const evidence = { profile: sandbox, passedAssertions: [] }

  try {
    progress('waiting for the welcome page')
    const page = await withDeadline('first window', stepBudgetMs, () => application.firstWindow({ timeout: stepBudgetMs }))
    await withDeadline('welcome page', stepBudgetMs, () => page.getByTestId('welcome-page').waitFor({ timeout: stepBudgetMs }))

    // Commit is emitted after navigation starts but before the new React root
    // mounts. Closing in this gap must bypass the renderer handshake instead of
    // waiting for its 15-second timeout.
    progress('closing the window while the reload is still committing')
    let closeRequestedAt = 0
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, elapsed: Date.now() - started, closeLatency: Date.now() - closeRequestedAt })))
    await withDeadline('reload', stepBudgetMs, () => page.reload({ waitUntil: 'commit' }))
    closeRequestedAt = Date.now()
    // The callback itself starts app.quit(), so Electron may tear down the
    // Playwright RPC channel before `evaluate()` can receive its return value.
    // Treat that transport-only error as the expected result and assert the
    // child process exit below.
    await withDeadline('close request', stepBudgetMs, () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())).catch((error) => {
      if (!/garbage collected|closed|Target|destroyed/i.test(error instanceof Error ? error.message : String(error))) throw error
    })
    const result = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(null), closeBudgetMs)),
    ])
    evidence.result = result
    assert.ok(result, 'The main window close must not wait for the renderer timeout during reload')
    assert.equal(result.code, 0)
    assert.ok(result.closeLatency < closeBudgetMs, `Close took too long: ${result.closeLatency}ms`)
    evidence.passedAssertions.push('close-during-commit-bypasses-the-renderer-handshake')
    return { passed: true, elapsed: result.elapsed, closeLatency: result.closeLatency }
  } finally {
    progress('closing Electron')
    await fs.writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8').catch(() => undefined)
    await withDeadline('exit', 20_000, () => application.evaluate(({ app }) => app.exit(0))).catch(() => undefined)
    await withDeadline('close', 20_000, () => application.close()).catch(() => undefined)
  }
}

await run(main)
