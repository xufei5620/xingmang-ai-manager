import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from '@playwright/test'
import { createSmokeRuntime, debuggerReleaseBudgetMs, whenOnlyDebuggerHoldsProcess } from './smoke-runtime.mjs'

const projectRoot = path.resolve('.')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-window-close-'))

// The forced-exit path used to hide its own failures: runScenario's finally
// awaited ElectronApplication.close(), which has no timeout, so an assertion
// that failed earlier never surfaced and the Windows job burned its whole
// 35 minute cap printing nothing (#131, #133).
const { stepBudgetMs, progress, withDeadline, trackProcessIds, releaseProcessIds, attachEvidence, run } = createSmokeRuntime({
  name: 'window-close-smoke',
  stepBudgetMs: Number(process.env.XINGMANG_SMOKE_STEP_TIMEOUT_MS ?? 60_000),
  totalBudgetMs: Number(process.env.XINGMANG_SMOKE_TOTAL_TIMEOUT_MS ?? 240_000),
})

// Install mocks before the real entry point so startup cannot access accounts,
// the real user's configuration, or any production network endpoint.
function bootFixture(config) {
  const fs = require('node:fs')
  const path = require('node:path')
  const { app, BrowserWindow, dialog, net, session, shell } = require('electron')
  if (path.resolve(require('node:os').homedir()) !== path.resolve(config.userHome)) throw new Error('Home isolation failed')
  app.setAppPath(config.projectRoot)
  app.setPath('userData', config.userData)
  app.setPath('home', config.userHome)
  const state = { choices: [], dialogs: [], droppedCloseRequests: 0, preventedUnloads: 0, blockedQuits: 0, forceExitCalls: 0, blockQuit: false, lastActionId: 0,
    userData: app.getPath('userData'), visible: null, processIds: [], commandLog: [], commandFailures: [], evidenceFailures: [] }
  // Defender can still hold a file this fixture has just written, so the atomic
  // swap that publishes the evidence fails with EPERM or EBUSY every so often on
  // a Windows runner. Three properties follow, and the control loop below leans
  // on all three: the swap is retried a bounded number of times, the same shape
  // the smoke runtime uses for the inspector calls it retries; persist never
  // throws, because it also runs from the dialog, forced-exit and will-quit
  // hooks, where a throw would change the behaviour under test rather than only
  // lose evidence; and a swap that fails anyway leaves the state unpublished for
  // the control loop to republish, so an acknowledgement is late, never lost.
  const evidenceAttempts = 5
  let evidencePublished = true
  const pause = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
  const persist = () => {
    const staged = `${config.evidence}.tmp`
    for (let attempt = 1; attempt <= evidenceAttempts; attempt++) {
      try {
        fs.writeFileSync(staged, JSON.stringify(state, null, 2) + '\n', 'utf8')
        fs.renameSync(staged, config.evidence)
        evidencePublished = true
        return true
      } catch (error) {
        if (attempt < evidenceAttempts) { pause(attempt * 20); continue }
        evidencePublished = false
        // Bounded, because a filesystem that never recovers would otherwise grow
        // this array for as long as the scenario keeps polling.
        if (state.evidenceFailures.length < 20) {
          state.evidenceFailures.push({ at: Date.now(), code: error?.code ?? null, message: String(error?.message ?? error) })
        }
      }
    }
    return false
  }
  dialog.showMessageBox = async (...args) => {
    const options = args.at(-1)
    const choice = state.choices.shift()
    const response = options.buttons?.indexOf(choice) ?? -1
    state.dialogs.push({ title: options.title, buttons: options.buttons, choice, unexpected: response < 0 })
    persist()
    return { response: response < 0 ? options.cancelId ?? 0 : response, checkboxChecked: false }
  }
  const denyNetwork = () => { throw new Error('Network is disabled during the window close smoke test') }
  net.fetch = async () => denyNetwork()
  globalThis.fetch = net.fetch
  net.request = denyNetwork
  shell.openExternal = async () => denyNetwork()
  for (const protocol of ['node:http', 'node:https']) {
    const transport = require(protocol)
    transport.request = denyNetwork
    transport.get = denyNetwork
  }
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  })
  app.on('browser-window-created', (_event, window) => {
    const send = window.webContents.send.bind(window.webContents)
    window.webContents.send = (channel, ...args) => {
      if (channel === 'window:close-request') { state.droppedCloseRequests++; persist(); return }
      return send(channel, ...args)
    }
    window.webContents.on('will-prevent-unload', () => { state.preventedUnloads++; persist() })
  })
  app.on('before-quit', (event) => {
    if (state.blockQuit) { event.preventDefault(); state.blockedQuits++; persist() }
  })
  const exit = app.exit.bind(app)
  app.exit = (code) => { state.forceExitCalls++; persist(); exit(code) }
  app.on('will-quit', persist)
  // Native lifecycle events can collect inspector promises even for read-only
  // ElectronApplication.evaluate calls. Keep control outside that transport.
  //
  // Anything thrown out of the control callback ends the run without explaining it:
  // the main process registers uncaughtExceptionMonitor rather than
  // uncaughtException, so Node still terminates, the pending command is never
  // acknowledged, and the smoke reports only "was not acknowledged". Defender
  // can hold the command file open for a moment right after the test renames
  // it into place, which makes a read or unlink here fail with EPERM or EBUSY
  // on a Windows runner. A command that could not be consumed stays on disk and
  // is retried by the next tick; everything else is recorded in the evidence
  // file, which the failure dump prints.
  const recordCommandFailure = (stage, error) => {
    state.commandFailures.push({ stage, at: Date.now(), code: error?.code ?? null, message: String(error?.message ?? error) })
    persist()
  }
  const controlTimer = setInterval(() => {
    let scheduled
    try {
      if (!fs.existsSync(config.command)) {
        // Whatever this state acknowledges has already run, so republishing it
        // after a blocked write is not a second execution.
        if (!evidencePublished) persist()
        return
      }
      scheduled = JSON.parse(fs.readFileSync(config.command, 'utf8'))
      fs.unlinkSync(config.command)
    } catch (error) {
      recordCommandFailure('read', error)
      return
    }
    // The command file is gone by the time we get here, so this tick is the only
    // chance to run what it asked for: publishing the evidence first meant a
    // blocked write threw past the action, which then never ran, was never
    // acknowledged and was never retried, and the scenario could only time out.
    // Run the action first and publish afterwards, so a failed write costs a
    // delayed acknowledgement rather than a lost command.
    try {
      if (!Number.isSafeInteger(scheduled.id) || scheduled.id <= state.lastActionId
        || !['inspect', 'activate', 'close', 'block-quit', 'cleanup'].includes(scheduled.action)) throw new Error('Invalid smoke command')
      state.commandLog.push({ id: scheduled.id, action: scheduled.action, at: Date.now() })
      state.lastActionId = scheduled.id
      state.visible = BrowserWindow.getAllWindows()[0]?.isVisible() ?? null
      state.processIds = app.getAppMetrics().map((entry) => entry.pid)
      if (scheduled.action === 'block-quit') state.blockQuit = scheduled.blockQuit
      if (scheduled.action === 'cleanup') { persist(); app.exit(0); return }
      if (scheduled.action === 'activate') app.emit('activate')
      if (scheduled.action === 'close') {
        if (scheduled.choice !== null) state.choices.push(scheduled.choice)
        BrowserWindow.getAllWindows()[0].close()
      }
    } catch (error) {
      recordCommandFailure(`action:${scheduled?.action}`, error)
      return
    }
    persist()
  }, 25)
  controlTimer.unref()
  require(config.entry)
}

// Every poll here waits on the same thing: the main process getting round to
// the next turn of its event loop. On a Windows runner that is far slower than
// anywhere else — quality run #284 spent 16s reaching the first window and then
// answered three consecutive commands at roughly fifteen second intervals, so a
// 15s budget failed the cancel-close step while the application was working,
// just slowly. The waits stay bounded, and nothing they assert changed; only
// their headroom did.
const mainProcessResponseTimeoutMs = Number(process.env.XINGMANG_SMOKE_COMMAND_TIMEOUT_MS ?? 30_000)

// Publishing a command uses the same temp file plus rename the fixture uses to
// publish its evidence, and Defender can refuse it the same way. A refusal here
// is louder — it fails the whole scenario rather than one command — but it costs
// just as much CI time, so it gets the same bounded retry.
const commandPublishAttempts = 5

async function publishAtomically(staged, target, contents) {
  let lastError
  for (let attempt = 1; attempt <= commandPublishAttempts; attempt++) {
    try {
      await fs.writeFile(staged, contents, 'utf8')
      await fs.rename(staged, target)
      return
    } catch (error) {
      lastError = error
      if (attempt < commandPublishAttempts) await new Promise((resolve) => setTimeout(resolve, attempt * 20))
    }
  }
  throw lastError
}

async function waitUntil(read, accepts, label, timeout = mainProcessResponseTimeoutMs, abandoned = () => null) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (accepts(value)) return value
    // Waiting out the full budget for an application that already stopped only
    // delays the report and buries the reason it stopped.
    const abandonment = abandoned()
    if (abandonment) throw new Error(`${label} (${abandonment}): ${JSON.stringify(value)}`)
    await new Promise((resolve) => setTimeout(resolve, 75))
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`)
}

async function runScenario(blockQuit) {
  const scenario = blockQuit ? 'blocked-quit' : 'renderer-unload'
  const testRoot = path.join(sandbox, scenario)
  const userHome = path.join(testRoot, 'home')
  const userData = path.join(testRoot, 'user-data')
  const codexHome = path.join(userHome, '.codex')
  const evidence = path.join(testRoot, 'main-process.json')
  const commandPath = path.join(testRoot, 'command.json')
  const bootstrap = path.join(testRoot, 'bootstrap.cjs')
  attachEvidence(evidence)
  progress(`${scenario}: preparing the isolated application state`)
  await fs.mkdir(codexHome, { recursive: true })
  await fs.mkdir(userData, { recursive: true })
  await fs.mkdir(path.join(testRoot, 'appdata'), { recursive: true })
  await fs.mkdir(path.join(testRoot, 'local-appdata'), { recursive: true })
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({
    version: 2, workspace: userHome, theme: 'dark', checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false, crashReportingNoticeShown: true,
  }) + '\n', 'utf8')
  await fs.writeFile(bootstrap, `(${bootFixture.toString()})(${JSON.stringify({
    userHome, userData, projectRoot, evidence, command: commandPath, entry: path.join(projectRoot, 'dist-electron/platform/entry.js'),
  })})\n`, 'utf8')
  const env = {
    ...process.env,
    HOME: userHome, USERPROFILE: userHome,
    APPDATA: path.join(testRoot, 'appdata'), LOCALAPPDATA: path.join(testRoot, 'local-appdata'),
    XINGMANG_CODEX_HOME_OVERRIDE: codexHome, XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
    XINGMANG_RENDERER: '', VITE_DEV_SERVER_URL: '', XINGMANG_UPDATE_DEV: '0',
    XINGMANG_DASHBOARD_PREVIEW: '0', XINGMANG_ONBOARDING_PREVIEW: '0', NODE_OPTIONS: '',
  }
  delete env.ELECTRON_RUN_AS_NODE
  progress(`${scenario}: launching Electron`)
  const application = await withDeadline(`${scenario}: Electron launch`, stepBudgetMs, () => electron.launch({
    cwd: projectRoot, args: [bootstrap, `--user-data-dir=${userData}`], env, timeout: stepBudgetMs,
  }))
  const child = application.process()
  const scenarioProcessIds = new Set()
  if (child.pid) { scenarioProcessIds.add(child.pid); trackProcessIds([child.pid]) }
  // A run that ended with no electron.exe left alive and nothing in the log is
  // how this smoke became unexplainable: the main process was already gone and
  // its pipes had never been read. Forward them so the next occurrence names
  // its own cause instead of surfacing as an unacknowledged command.
  for (const [label, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
    stream?.on('data', (chunk) => {
      const text = String(chunk).trimEnd()
      if (text) process.stderr.write(`[${scenario} main ${label}] ${text}\n`)
    })
  }
  let exited = false
  let exitResult = null
  const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => {
    exited = true
    exitResult = { code, signal }
    resolve(exitResult)
  }))
  const abandonedByExit = () => exited ? `the application exited first with ${JSON.stringify(exitResult)}` : null
  const readState = async () => {
    try { return JSON.parse(await fs.readFile(evidence, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const rememberProcessIds = (pids) => {
    for (const pid of pids ?? []) scenarioProcessIds.add(pid)
    trackProcessIds(pids)
  }
  let actionId = 0
  const scheduleWindowAction = async (action, choice = null, shouldBlock = false) => {
    const command = { id: ++actionId, action, choice, blockQuit: shouldBlock }
    await publishAtomically(`${commandPath}.tmp`, commandPath, JSON.stringify(command))
    // Publish each action once; only poll its acknowledgement, never replay it.
    const state = await waitUntil(readState, (entry) => entry?.lastActionId === command.id,
      `Smoke command ${command.id} (${action}) was not acknowledged`, mainProcessResponseTimeoutMs, abandonedByExit)
    rememberProcessIds(state.processIds)
    return state
  }
  const visible = async () => (await scheduleWindowAction('inspect')).visible
  const chooseClose = (choice) => scheduleWindowAction('close', choice)
  let page
  // page.evaluate has no default timeout, so a renderer that stops answering
  // stalls this smoke forever. Every renderer round trip goes through here.
  const evaluate = (label, body) => withDeadline(`${scenario}: ${label}`, stepBudgetMs, () => page.evaluate(body))
  try {
    progress(`${scenario}: waiting for the first window`)
    page = await withDeadline(`${scenario}: first window`, stepBudgetMs, () => application.firstWindow({ timeout: stepBudgetMs }))
    const rendererDialogs = []
    // Electron resolves beforeunload through will-prevent-unload. A listener
    // prevents Playwright's automatic dismissal racing that native decision.
    page.on('dialog', (dialog) => {
      rendererDialogs.push(dialog.type())
      if (dialog.type() !== 'beforeunload') void dialog.dismiss().catch(() => undefined)
    })
    progress(`${scenario}: waiting for the welcome page`)
    await withDeadline(`${scenario}: welcome page`, stepBudgetMs, () => page.getByTestId('welcome-page').waitFor({ timeout: stepBudgetMs }))
    assert.equal(path.resolve((await scheduleWindowAction('inspect')).userData), path.resolve(userData))
    await evaluate('saving the ask close behaviour', () => window.xingmang.saveSettings({ version: 2, closeBehavior: 'ask' }))
    const capabilities = await evaluate('reading the window capabilities', () => window.xingmang.getWindowCapabilities())
    progress(`${scenario}: cancelling a close (tray available: ${capabilities.tray})`)
    await chooseClose('返回')
    await waitUntil(readState, (state) => state?.dialogs.length === 1, 'Cancel dialog missing')
    assert.equal(await visible(), true)
    if (capabilities.tray) {
      progress(`${scenario}: hiding to the tray and restoring`)
      await chooseClose('缩到托盘')
      await waitUntil(visible, (shown) => shown === false, 'Unresponsive close reporting prevented tray hiding')
      await scheduleWindowAction('activate')
      await waitUntil(visible, Boolean, 'Activation did not restore the hidden main window')
    } else {
      progress(`${scenario}: verifying the trayless fallback`)
      await evaluate('selecting the tray close behaviour', () => window.xingmang.saveSettings({ version: 2, closeBehavior: 'tray' }))
      await scheduleWindowAction('close')
      assert.equal(await visible(), true, 'A missing system tray must keep the main window accessible')
      await evaluate('restoring the ask close behaviour', () => window.xingmang.saveSettings({ version: 2, closeBehavior: 'ask' }))
    }

    await evaluate('installing the renderer beforeunload blocker', () => {
      window.addEventListener('beforeunload', (event) => { event.returnValue = false })
    })
    const { processIds } = await scheduleWindowAction('block-quit', null, blockQuit)
    progress(`${scenario}: forcing the exit`)
    const started = Date.now()
    const debuggerOnly = whenOnlyDebuggerHoldsProcess(child)
    await chooseClose('强制退出程序')
    // The 15 s budget is the application's. It ends at the exit, or where only
    // Playwright's inspector connection is left keeping the process alive.
    await withDeadline(`${scenario}: forced exit`, 15_000, () => Promise.race([exitPromise, debuggerOnly]))
    const applicationDoneMs = Date.now() - started
    const exit = await withDeadline(`${scenario}: inspector release after the application exited`, debuggerReleaseBudgetMs, () => exitPromise)
    const exitedMs = Date.now() - started
    if (exitedMs - applicationDoneMs > 2_000) {
      progress(`${scenario}: application done ${applicationDoneMs}ms after the request, process released by the inspector ${exitedMs}ms after it`)
    }
    assert.equal(exit.code, 0)
    const state = JSON.parse(await fs.readFile(evidence, 'utf8'))
    assert.ok(rendererDialogs.every((type) => type === 'beforeunload'))
    assert.deepEqual(state.dialogs.map((entry) => entry.choice), capabilities.tray
      ? ['返回', '缩到托盘', '强制退出程序'] : ['返回', '强制退出程序'])
    assert.ok(state.dialogs.every((entry) => !entry.unexpected && entry.buttons.includes('强制退出程序')))
    if (blockQuit) {
      assert.ok(state.blockedQuits > 0, 'The stalled quit hook was not exercised')
      assert.equal(state.forceExitCalls, 1, 'The forced-exit watchdog did not terminate the process')
    } else {
      assert.ok(state.preventedUnloads > 0, 'The renderer beforeunload blocker was not exercised')
    }
    progress(`${scenario}: waiting for the child processes to disappear`)
    await waitUntil(() => Promise.resolve(processIds.filter((pid) => {
      try { process.kill(pid, 0); return true } catch { return false }
    })), (pids) => pids.length === 0, 'Electron processes remained after forced exit')
    return { scenario, passed: true, trayAvailable: capabilities.tray,
      trayRestored: capabilities.tray, visibleWithoutTray: !capabilities.tray, rendererDialogs, exit, elapsedMs: Date.now() - started, ...state }
  } finally {
    // Cleanup must never outlive the scenario it is cleaning up: an unbounded
    // close() here is what hid the real assertion failure on Windows.
    if (!exited) {
      await scheduleWindowAction('cleanup').catch(() => undefined)
      await withDeadline(`${scenario}: close`, 20_000, () => application.close()).catch(() => undefined)
    }
    // A forced exit orphans the GPU and utility processes on Windows, and they
    // still hold the stdio pipes the launch handed them. Leaving them alive
    // stalls the next scenario and this process on its way out.
    releaseProcessIds(scenarioProcessIds)
  }
}

async function main() {
  const results = []
  for (const blockQuit of [false, true]) results.push(await runScenario(blockQuit))
  const result = { passed: true, isolatedRoot: sandbox, results }
  await fs.writeFile(path.join(sandbox, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  return result
}

await run(main)
