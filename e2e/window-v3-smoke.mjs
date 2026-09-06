import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'

const projectRoot = path.resolve('.')
const artifactRoot = path.join(projectRoot, 'artifacts', 'window-v3-smoke')
await fs.mkdir(artifactRoot, { recursive: true })
const requestedScales = process.env.XINGMANG_WINDOW_V3_SCALES?.split(',').map(Number) ?? [1, 1.25, 1.5]
assert.ok(requestedScales.every((scale) => [1, 1.25, 1.5].includes(scale)))
const sizes = [{ width: 960, height: 560 }, { width: 1280, height: 820 }, { width: 1440, height: 900 }]
const results = []

async function waitUntil(read, accepts, label, timeout = 15_000) {
  const started = Date.now()
  let value
  while (Date.now() - started < timeout) {
    value = await read()
    if (accepts(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}

async function nativeCapture(application, name) {
  const captured = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('xingmang://'))
    if (!window) throw new Error('Main window is unavailable')
    const screenshot = await window.capturePage()
    const bitmap = screenshot.toBitmap()
    const buckets = new Set()
    let luminance = 0
    let count = 0
    for (let offset = 0; offset < bitmap.length; offset += 64) {
      const blue = bitmap[offset]
      const green = bitmap[offset + 1]
      const red = bitmap[offset + 2]
      luminance += red * .2126 + green * .7152 + blue * .0722
      buckets.add(`${red >> 4}:${green >> 4}:${blue >> 4}`)
      count++
    }
    return {
      png: screenshot.toPNG().toString('base64'),
      pixels: { ...screenshot.getSize(), colorBuckets: buckets.size, averageLuminance: count ? luminance / count : 0 },
      bounds: window.getBounds(), contentBounds: window.getContentBounds(), zoom: window.webContents.getZoomFactor(),
    }
  })
  const screenshotPath = path.join(artifactRoot, `${name}.png`)
  await fs.writeFile(screenshotPath, Buffer.from(captured.png, 'base64'))
  delete captured.png
  assert.ok(captured.pixels.width > 500 && captured.pixels.height > 250, `${name}: native screenshot too small`)
  assert.ok(captured.pixels.colorBuckets > 15, `${name}: native content appears blank`)
  return { ...captured, screenshotPath }
}

for (const scale of requestedScales) {
  const testRoot = await fs.mkdtemp(path.join(artifactRoot, `.isolated-${scale}-`))
  const testHome = path.join(testRoot, 'home')
  const userData = path.join(testRoot, 'user-data')
  const codexHome = path.join(testHome, '.codex')
  await fs.mkdir(codexHome, { recursive: true })
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(path.join(testHome, 'AppData', 'Roaming'), { recursive: true })
  await fs.mkdir(path.join(testHome, 'AppData', 'Local'), { recursive: true })
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ version: 2, workspace: testHome, theme: 'dark', checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false, reducedMotion: true }) + '\n', 'utf8')
  const application = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`, `--force-device-scale-factor=${scale}`, 'xingmang://invite?code=XM-TEST'],
    env: { ...process.env, HOME: testHome, USERPROFILE: testHome, APPDATA: path.join(testHome, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(testHome, 'AppData', 'Local'), XINGMANG_CODEX_HOME_OVERRIDE: codexHome, XINGMANG_DISABLE_SINGLE_INSTANCE: '1', XINGMANG_DASHBOARD_PREVIEW: '1', XINGMANG_ONBOARDING_PREVIEW: '0', VITE_DEV_SERVER_URL: '', XINGMANG_UPDATE_DEV: '0' },
  })
  const child = application.process()
  const report = { scale, isolatedRoot: testRoot, pageErrors: [], scenarios: [], deepLinks: {}, close: {}, exited: false }
  const page = await application.firstWindow()
  page.on('pageerror', (error) => report.pageErrors.push(error.message))
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.locator('.app-shell').waitFor({ state: 'visible', timeout: 60_000 })
    await application.evaluate(({ ipcMain, dialog }) => {
      globalThis.windowV3Smoke = { registrationCalls: 0, verificationCalls: 0, dialogCalls: [] }
      // These guards make any accidental submit a test failure before it can
      // reach the account service. The actual registration view is unchanged.
      ipcMain.removeHandler('account:register')
      ipcMain.handle('account:register', () => { globalThis.windowV3Smoke.registrationCalls++; throw new Error('Registration is forbidden during window smoke') })
      ipcMain.removeHandler('account:send-verification-code')
      ipcMain.handle('account:send-verification-code', () => { globalThis.windowV3Smoke.verificationCalls++; throw new Error('Verification sending is forbidden during window smoke') })
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        globalThis.windowV3Smoke.dialogCalls.push({ title: options.title, buttons: options.buttons })
        return { response: Math.max(0, options.buttons.indexOf('返回')), checkboxChecked: false }
      }
    })
    const register = page.getByRole('dialog', { name: '注册', exact: true })
    await register.waitFor({ state: 'visible', timeout: 30_000 })
    assert.equal(await register.getByLabel('邀请码（选填）', { exact: true }).inputValue(), 'XM-TEST')
    assert.equal(await register.getByLabel('用户名', { exact: true }).inputValue(), '')
    report.deepLinks.coldInvite = true
    report.deepLinks.coldScreenshot = (await nativeCapture(application, `scale-${scale}-cold-invite`)).screenshotPath
    await register.getByRole('button', { name: '取消', exact: true }).click()
    await register.waitFor({ state: 'hidden' })

    await application.evaluate(({ app }) => { app.emit('open-url', { preventDefault() {} }, 'xingmang://invite?code=XM-HOT') })
    await register.waitFor({ state: 'visible' })
    assert.equal(await register.getByLabel('邀请码（选填）', { exact: true }).inputValue(), 'XM-HOT')
    assert.equal(await register.getByLabel('用户名', { exact: true }).inputValue(), '')
    report.deepLinks.hotInvite = true
    await register.getByRole('button', { name: '取消', exact: true }).click()
    await application.evaluate(({ app }) => { app.emit('open-url', { preventDefault() {} }, 'xingmang://unknown-action?anything=1') })
    await page.getByText('链接无效或暂不支持，请从工具箱内打开对应页面。', { exact: true }).waitFor()
    assert.equal(await register.count(), 0)
    report.deepLinks.unknownRejected = true
    assert.deepEqual(await application.evaluate(() => ({ registrationCalls: globalThis.windowV3Smoke.registrationCalls, verificationCalls: globalThis.windowV3Smoke.verificationCalls })), { registrationCalls: 0, verificationCalls: 0 })
    report.deepLinks.noAccountMutation = true
    await page.getByRole('button', { name: '关闭提示', exact: true }).click()

    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.getByRole('button', { name: `切换到${theme === 'light' ? '亮色' : '暗色'}主题`, exact: true }).click()
      await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, theme)
      for (const size of sizes) {
        const nativeSize = await application.evaluate(({ BrowserWindow, screen }, size) => {
          const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().startsWith('xingmang://'))
          if (window.isMaximized()) window.unmaximize()
          const workArea = screen.getDisplayMatching(window.getBounds()).workArea
          window.setBounds({ x: workArea.x, y: workArea.y, ...size })
          return { requested: size, actual: window.getBounds(), workArea, displayScaleFactor: screen.getDisplayMatching(window.getBounds()).scaleFactor }
        }, size)
        await page.waitForTimeout(300)
        for (const collapsed of [false, true]) {
          const toggle = page.getByRole('button', { name: collapsed ? '收起侧边栏' : '展开侧边栏', exact: true })
          if (await toggle.count()) await toggle.click()
          await page.waitForTimeout(200)
          const layout = await page.evaluate(() => {
            const label = (element) => element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent?.trim() || ''
            const controls = [...document.querySelectorAll('.shell-topbar button, .sidebar-collapse-button, .theme-toggle, .account-switch-entry')]
              .filter((element) => element.getClientRects().length > 0)
              .map((element) => {
                const bounds = element.getBoundingClientRect()
                const textClipped = [...element.querySelectorAll('span, kbd')].some((text) => text.getClientRects().length && (text.scrollWidth > text.clientWidth + 2 || text.scrollHeight > text.clientHeight + 2))
                return { label: label(element), left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height, textClipped }
              })
            const table = document.querySelector('.dashboard-tool-table')
            return {
              width: innerWidth, height: innerHeight, devicePixelRatio, theme: document.documentElement.dataset.theme, skin: document.documentElement.dataset.skin,
              scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
              collapsed: document.querySelector('.app-shell')?.classList.contains('sidebar-collapsed'),
              controls, table: table ? { width: table.clientWidth, scrollWidth: table.scrollWidth, keyboardFocusable: table.tabIndex >= 0, rows: table.querySelectorAll('[role="row"]').length } : null,
            }
          })
          assert.equal(layout.theme, theme)
          assert.equal(layout.collapsed, collapsed)
          assert.equal(layout.skin, theme === 'light' ? 'dawn' : 'obsidian')
          assert.ok(layout.scrollWidth <= layout.width + 1, `${scale}/${theme}/${size.width}: page horizontal overflow`)
          assert.ok(layout.scrollHeight <= layout.height + 1, `${scale}/${theme}/${size.width}: page vertical overflow`)
          assert.ok(layout.table?.keyboardFocusable && layout.table.rows >= 6, 'Tool table or keyboard scroll entry missing')
          const invalid = layout.controls.filter((control) => !control.label || control.left < -1 || control.top < -1 || control.right > layout.width + 1 || control.bottom > layout.height + 1 || control.textClipped)
          assert.deepEqual(invalid, [], `${scale}/${theme}/${size.width}/${collapsed}: inaccessible shell controls`)
          assert.equal(await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '首页：安装和打开 AI 编程工具', exact: true }).count(), 1, 'Navigation lost its accessible name')
          await page.getByRole('button', { name: '搜索页面与操作', exact: true }).click()
          const commands = page.getByRole('dialog', { name: '搜索页面与操作', exact: true })
          await commands.getByRole('combobox', { name: '搜索页面', exact: true }).waitFor()
          await page.keyboard.press('Escape')
          await commands.waitFor({ state: 'hidden' })
          const capture = await nativeCapture(application, `scale-${scale}-${theme}-${size.width}x${size.height}-${collapsed ? 'collapsed' : 'expanded'}`)
          const expectedAutomatic = Math.min(1.25, Math.max(.8, capture.contentBounds.width / 1280))
          assert.ok(Math.abs(capture.zoom - expectedAutomatic) < .001, 'Window DIP zoom applies DPI more than once')
          report.scenarios.push({ requested: size, nativeSize, collapsed, layout, ...capture })
        }
      }
    }

    await page.evaluate(() => window.xingmang.saveSettings({ version: 2, closeBehavior: 'ask' }))
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('xingmang://')).close() })
    await waitUntil(() => application.evaluate(() => globalThis.windowV3Smoke.dialogCalls), (calls) => calls.some((entry) => entry.title === '关闭星芒AI管理工具'), 'Native close dialog was not used')
    report.close.cancelPreserved = await application.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith('xingmang://')); return Boolean(window && !window.isDestroyed() && window.isVisible()) })
    assert.equal(report.close.cancelPreserved, true)
    const capabilities = await page.evaluate(() => window.xingmang.getWindowCapabilities())
    report.close.trayAvailable = capabilities.tray
    await page.evaluate(() => window.xingmang.saveSettings({ version: 2, closeBehavior: 'tray' }))
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('xingmang://')).close() })
    await waitUntil(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('xingmang://'))?.isVisible()), (visible) => visible === !capabilities.tray, 'Tray close preference')
    report.close.trayHiddenOrVisibleFallback = true
    await application.evaluate(({ app }) => { app.emit('activate') })
    await waitUntil(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('xingmang://'))?.isVisible()), Boolean, 'App activate must restore main window')
    report.close.activationRestored = true
    assert.deepEqual(report.pageErrors, [])
    await page.evaluate(() => window.xingmang.saveSettings({ version: 2, closeBehavior: 'quit' }))
    const electronProcessIds = await application.evaluate(({ app }) => app.getAppMetrics().map((entry) => entry.pid))
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    await application.evaluate(({ app }) => { app.quit() }).catch((error) => { if (!/closed|Target|destroyed/i.test(error.message)) throw error })
    report.close.exit = await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Clean application quit timed out')), 20_000); timer.unref() })])
    report.exited = true
    report.close.remainingProcessIds = await waitUntil(() => Promise.resolve(electronProcessIds.filter((pid) => {
      try { process.kill(pid, 0); return true } catch { return false }
    })), (pids) => pids.length === 0, 'Electron child processes leaked after quit')
    results.push(report)
    await fs.writeFile(path.join(artifactRoot, 'result.json'), JSON.stringify({ passed: true, results }, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify({ scale, screenshots: report.scenarios.length, deepLinks: report.deepLinks, close: report.close, pageErrors: report.pageErrors }))
  } catch (error) {
    report.failure = error.stack ?? String(error)
    try { report.failureScreenshot = await nativeCapture(application, `scale-${scale}-failure`) } catch {}
    await fs.writeFile(path.join(artifactRoot, 'failure.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
    throw error
  } finally {
    if (!report.exited) {
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
      await application.close().catch(() => {})
    }
  }
}
console.log(JSON.stringify({ passed: true, scales: results.length, nativeScreenshots: results.reduce((count, entry) => count + entry.scenarios.length + 1, 0), resultPath: path.join(artifactRoot, 'result.json') }))
