import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-v2-native-'))
const userHome = path.join(sandbox, 'home')
await fs.mkdir(userHome)
const userData = path.join(sandbox, 'user-data')
await fs.mkdir(userData)
await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ version: 2, workspace: '', theme: 'dark', checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false }), 'utf8')
const output = path.resolve('artifacts/renderer-v2-native')
await fs.mkdir(output, { recursive: true })
const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], env: {
  ...process.env, HOME: userHome, USERPROFILE: userHome, XINGMANG_RENDERER: '', VITE_DEV_SERVER_URL: '',
  XINGMANG_CODEX_HOME_OVERRIDE: path.join(userHome, '.codex'), XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
} })
const checks = []
const errors = []
async function readWindowState() {
  return app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return null
    return { bounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor() }
  })
}
async function waitForWindowZoom(expected, timeout = 5000) {
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
  const page = await app.firstWindow()
  // `electron.launch()` can resolve as soon as the main process is spawned,
  // before Playwright has attached its Electron RPC bridge. Calling
  // `app.evaluate()` in that gap is flaky (`Resulting promise was garbage
  // collected`). Acquiring the first renderer window establishes the ready
  // event before using main-process evaluation.
  assert.equal(path.resolve(await app.evaluate(({ app }) => app.getPath('userData'))), path.resolve(userData), 'Native smoke must use its isolated profile')
  page.on('pageerror', (error) => errors.push(error.message))
  await page.getByTestId('welcome-page').waitFor({ timeout: 30000 })
  const platform = await page.evaluate(() => window.xingmangPlatform?.getState())
  assert.ok(platform, 'The isolated native platform preload must be available')
  for (const width of [960, 1280, 1440]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size, 820), width)
    await page.waitForFunction(() => Math.abs(window.innerWidth - 1280) <= 1)
    await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0))
    const geometry = await waitForWindowZoom(width / 1280)
    const capture = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG().toString('base64'))
    await fs.writeFile(path.join(output, `welcome-${width}.png`), Buffer.from(capture, 'base64'))
    checks.push({ width, ...geometry })
  }
  await page.getByTestId('welcome-motion').click()
  await page.waitForFunction(() => document.documentElement.dataset.reducedMotion === 'true')
  const pixels = await page.getByTestId('welcome-starfield').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let visible = 0
    for (let i = 3; i < data.length; i += 4) if (data[i]) visible++
    return { visible, total: canvas.width * canvas.height }
  })
  assert.ok(pixels.visible > pixels.total * 0.01, 'The star canvas must contain rendered pixels')
  await page.evaluate(() => window.xingmangPlatform.setHighContrast(true))
  await page.waitForFunction(() => document.documentElement.classList.contains('hc'))
  await page.evaluate(() => window.xingmangPlatform.setThemePreference('light'))
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
  await page.reload()
  await page.getByTestId('welcome-page').waitFor()
  await page.waitForFunction(() => document.documentElement.classList.contains('hc') && document.documentElement.dataset.theme === 'light')
  assert.equal((await page.evaluate(() => window.xingmangPlatform.getState())).preferences.highContrast, true)
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ checks, errors, pixels, platformPreload: true, persistedAppearance: true, profile: sandbox, authenticated: false }, null, 2))
  console.log(JSON.stringify({ viewports: checks.length, errors, output }))
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await app.close().catch(() => undefined)
}
