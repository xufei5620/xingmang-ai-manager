import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'

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

const application = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: {
  ...process.env,
  HOME: userHome,
  USERPROFILE: userHome,
  XINGMANG_RENDERER: '',
  VITE_DEV_SERVER_URL: '',
  XINGMANG_CODEX_HOME_OVERRIDE: path.join(userHome, '.codex'),
  XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
} })
const child = application.process()
const started = Date.now()
try {
  const page = await application.firstWindow()
  await page.getByTestId('welcome-page').waitFor({ timeout: 30_000 })

  // Commit is emitted after navigation starts but before the new React root
  // mounts. Closing in this gap must bypass the renderer handshake instead of
  // waiting for its 15-second timeout.
  let closeRequestedAt = 0
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, elapsed: Date.now() - started, closeLatency: Date.now() - closeRequestedAt })))
  await page.reload({ waitUntil: 'commit' })
  closeRequestedAt = Date.now()
  // The callback itself starts app.quit(), so Electron may tear down the
  // Playwright RPC channel before `evaluate()` can receive its return value.
  // Treat that transport-only error as the expected result and assert the
  // child process exit below.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch((error) => {
    if (!/garbage collected|closed|Target|destroyed/i.test(error instanceof Error ? error.message : String(error))) throw error
  })
  const result = await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
  ])
  assert.ok(result, 'The main window close must not wait for the renderer timeout during reload')
  assert.equal(result.code, 0)
  assert.ok(result.closeLatency < 5_000, `Close took too long: ${result.closeLatency}ms`)
  console.log(JSON.stringify({ passed: true, elapsed: result.elapsed, closeLatency: result.closeLatency }))
} finally {
  await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await application.close().catch(() => undefined)
}
