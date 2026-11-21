import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'
import { createServer, resolveConfig } from 'vite'
import { createFixtureServer, observeFixtureBootstrap } from './harness.mjs'
import { createPageErrorCollector } from './page-errors.mjs'
import { verifySignedOutSmokeIsolation, withSignedOutSmokeIsolation } from './signed-out-smoke-isolation.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Mirror the public dev command for both the in-process Vite fixture and Electron.
process.env.XINGMANG_RENDERER = 'v2'

// The reads the renderer's boot waits on before it leaves the splash screen
// (bootstrap() in src/renderer-v2/features/app/api.ts).
const bootstrapReads = ['getSettings', 'getPlatformCapabilities', 'getAccountSession', 'getUpdateState', 'getWindowCapabilities']

function listen(server, options) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

function settleWithin(promise, ms, fallback) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms) }),
  ]).finally(() => clearTimeout(timer))
}

// Keeps the last lines the Electron main process printed, for a failure report.
function recordProcessOutput(child) {
  const lines = []
  for (const stream of [child?.stdout, child?.stderr]) {
    stream?.on('data', (chunk) => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) lines.push(line.slice(0, 240))
      }
      if (lines.length > 20) lines.splice(0, lines.length - 20)
    })
  }
  return lines
}

// Notes when the root, the splash screen and the welcome page first show up,
// and every long task, so a failure can tell "late" from "there but not
// visible". Installed once the first window exists; a reload would drop it.
// Times are wall-clock milliseconds, the same clock the test and the main
// process read.
function installRendererTimeline() {
  if (window.__devOriginTimeline) return
  const timeline = { longTasks: [] }
  window.__devOriginTimeline = timeline
  function wallClock(pageTime) {
    return Math.round(performance.timeOrigin + pageTime)
  }
  function note() {
    const now = wallClock(performance.now())
    if (timeline.rootFilled === undefined && document.getElementById('root')?.firstElementChild) timeline.rootFilled = now
    if (timeline.splash === undefined && document.querySelector('.auth-splash')) timeline.splash = now
    const welcome = document.querySelector('[data-testid="welcome-page"]')
    if (welcome && timeline.welcome === undefined) {
      const rect = welcome.getBoundingClientRect()
      timeline.welcome = now
      timeline.welcomeSize = `${Math.round(rect.width)}x${Math.round(rect.height)}`
      observer.disconnect()
    }
  }
  // Playwright's "visible" is a non-empty box that checkVisibility() accepts,
  // which a style change can grant long after the node is in the DOM.
  function noteShown() {
    const welcome = document.querySelector('[data-testid="welcome-page"]')
    const rect = welcome?.getBoundingClientRect()
    if (!rect || rect.width === 0 || rect.height === 0 || !welcome.checkVisibility()) return
    timeline.welcomeShown = wallClock(performance.now())
    clearInterval(shownTimer)
  }
  const observer = new MutationObserver(note)
  observer.observe(document, { childList: true, subtree: true })
  note()
  const shownTimer = setInterval(noteShown, 20)
  setTimeout(() => clearInterval(shownTimer), 15_000)
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (timeline.longTasks.length < 24) timeline.longTasks.push([wallClock(entry.startTime), Math.round(entry.duration)])
      }
    }).observe({ type: 'longtask', buffered: true })
    // An observer, not getEntriesByType: a dev page asks for more modules than
    // the 250-entry resource buffer holds, so the late ones never reach it.
    timeline.requests = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (timeline.requests.length < 600) timeline.requests.push([new URL(entry.name).pathname.slice(-48), entry.startTime, entry.duration])
      }
    }).observe({ type: 'resource', buffered: true })
  } catch {}
}

function readRendererTimeline(origin) {
  const timeline = window.__devOriginTimeline ?? {}
  const navigation = performance.getEntriesByType('navigation')[0]
  const paint = performance.getEntriesByName('first-contentful-paint')[0]
  function since(wallClock) {
    return wallClock === undefined ? undefined : wallClock - origin
  }
  return {
    domContentLoaded: navigation ? Math.round(performance.timeOrigin + navigation.domContentLoadedEventEnd) - origin : undefined,
    firstContentfulPaint: paint ? Math.round(performance.timeOrigin + paint.startTime) - origin : undefined,
    rootFilled: since(timeline.rootFilled),
    splash: since(timeline.splash),
    welcome: since(timeline.welcome),
    welcomeSize: timeline.welcomeSize,
    welcomeShown: since(timeline.welcomeShown),
    // Modules the page asked for after the document loaded, with how long
    // each took to arrive: lazy imports land in the middle of the wait.
    lateRequests: navigation && timeline.requests
      ? timeline.requests
        .filter(([, startTime]) => startTime > navigation.domContentLoadedEventEnd)
        .slice(0, 24)
        .map(([name, startTime, duration]) => [name, Math.round(performance.timeOrigin + startTime) - origin, Math.round(duration)])
      : undefined,
    longTasks: (timeline.longTasks ?? []).map(([at, ms]) => [at - origin, ms]),
    now: Math.round(performance.timeOrigin + performance.now()) - origin,
  }
}

// Playwright reaches the page through the main process, so a busy main
// process delays every wait even while the page itself is fine.
function installMainProcessStallLog() {
  if (globalThis.__devOriginStalls) return
  const stalls = []
  globalThis.__devOriginStalls = stalls
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    if (now - last > 150 && stalls.length < 24) stalls.push([last, now - last])
    last = now
  }, 50).unref()
}

// ElectronApplication.evaluate hands the electron module in first.
function readMainProcessStalls(_electron, origin) {
  return (globalThis.__devOriginStalls ?? []).map(([at, ms]) => [at - origin, ms])
}

// The fixture Vite server and Playwright's own polling share this process,
// so a long transform here holds up every wait as surely as a busy app does.
function watchTestProcessStalls(origin) {
  const stalls = []
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    if (now - last > 150 && stalls.length < 24) stalls.push([last - origin, now - last])
    last = now
  }, 50)
  timer.unref()
  return { stalls, stop: () => clearInterval(timer) }
}

// What the window showed and who had stopped answering when the welcome page
// did not appear. Every probe is bounded so the report itself cannot hang.
async function welcomeTimeoutEvidence({ application, page, bootstrap, origin, steps, testProcessStalls, failedRequests, mainOutput }) {
  // A page that is merely slow shows up here; one that is stuck does not.
  const lateWaitStarted = Date.now()
  const visibleAfterMore = await page.getByTestId('welcome-page').waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => `${Date.now() - lateWaitStarted} ms later`, () => 'not within 3 s more')
  const mainProcessAsked = Date.now()
  const [screen, renderer, mainProcessStalls, mainProcess, reads, fixture] = await Promise.all([
    settleWithin(page.evaluate(() => ({
      path: location.pathname,
      readyState: document.readyState,
      testIds: [...new Set([...document.querySelectorAll('[data-testid]')].map((element) => element.dataset.testid))].slice(0, 24),
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
    })).catch((error) => ({ error: error.message })), 2_000, { unanswered: true }),
    settleWithin(page.evaluate(readRendererTimeline, origin).catch((error) => ({ error: error.message })), 2_000, { unanswered: true }),
    settleWithin(application.evaluate(readMainProcessStalls, origin).catch((error) => ({ error: error.message })), 2_000, { unanswered: true }),
    settleWithin(application.evaluate(() => 'answered').catch((error) => `failed: ${error.message}`), 2_000, 'unanswered')
      .then((answer) => ({ answer, ms: Date.now() - mainProcessAsked })),
    settleWithin(page.evaluate((names) => Promise.all(names.map(async (name) => {
      const asked = performance.now()
      const outcome = await Promise.race([
        Promise.resolve().then(() => window.xingmang[name]()).then(() => 'answered', () => 'rejected'),
        new Promise((resolve) => setTimeout(() => resolve('unanswered'), 1_500)),
      ])
      return [name, outcome === 'answered' ? Math.round(performance.now() - asked) : outcome]
    })).then(Object.fromEntries), bootstrapReads).catch((error) => ({ error: error.message })), 2_500, { unanswered: true }),
    bootstrap.snapshot(),
  ])
  return { steps, visibleAfterMore, screen, renderer, mainProcessStalls, testProcessStalls, mainProcess, bootstrapReads: reads, fixture, failedRequests: failedRequests.slice(0, 8), mainOutput }
}

// TEMPORARY probe only: JS self time by function and by file.
function summarizeProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const byFunction = {}
  const byFile = {}
  profile.samples.forEach((id, index) => {
    const node = nodes.get(id)
    const ms = (profile.timeDeltas[index] ?? 0) / 1000
    const frame = node.callFrame
    const file = frame.url ? new URL(frame.url, 'http://x').pathname.slice(-60) : `(${frame.functionName || 'native'})`
    const key = `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber}`
    byFunction[key] = (byFunction[key] ?? 0) + ms
    byFile[file] = (byFile[file] ?? 0) + ms
  })
  function top(table, count) {
    return Object.entries(table).sort((a, b) => b[1] - a[1]).slice(0, count).map(([key, ms]) => [key, Math.round(ms)])
  }
  return { byFile: top(byFile, 12), byFunction: top(byFunction, 16) }
}

// TEMPORARY probe only (deleted before the PR): what the renderer main thread
// was doing in its longest tasks, from a CDP Tracing capture.
function summarizeTrace(text) {
  const parsed = JSON.parse(text)
  const traceEvents = Array.isArray(parsed) ? parsed : parsed.traceEvents
  const threadNames = new Map()
  for (const event of traceEvents) {
    if (event.ph === 'M' && event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name)
  }
  function threadOf(event) { return threadNames.get(`${event.pid}:${event.tid}`) }
  function label(event) {
    const data = event.args?.data ?? event.args?.beginData ?? event.args ?? {}
    const where = data.url || data.scriptName || data.fileName || data.functionName || data.name || data.type || ''
    return `${event.name}${where ? ` ${String(where).slice(-80)}` : ''}${data.lineNumber !== undefined ? `:${data.lineNumber}` : ''}`
  }
  function topLevel(threadName) {
    return traceEvents.filter((event) => event.ph === 'X' && threadOf(event) === threadName && event.dur > 200_000
      && /RunTask|ThreadControllerImpl|TaskQueueManager|MessageLoop/.test(event.name))
      .sort((a, b) => b.dur - a.dur).slice(0, 4)
  }
  function inside(task) {
    const children = traceEvents.filter((event) => event.ph === 'X' && event.pid === task.pid && event.tid === task.tid
      && event.ts >= task.ts && event.ts + (event.dur ?? 0) <= task.ts + task.dur && event !== task && (event.dur ?? 0) > 20_000)
    const byName = {}
    for (const event of children) byName[event.name] = Math.round(((byName[event.name] ?? 0) + event.dur / 1000))
    return {
      task: `${task.name} ${Math.round(task.dur / 1000)} ms`,
      byName: Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 14),
      longest: children.sort((a, b) => b.dur - a.dur).slice(0, 14).map((event) => [label(event), Math.round(event.dur / 1000)]),
    }
  }
  const renderer = topLevel('CrRendererMain').map(inside)
  const gpu = topLevel('CrGpuMain').map(inside)
  const browser = topLevel('CrBrowserMain').map(inside)
  return { renderer, gpu, browser }
}

async function configuredDevelopmentOrigin() {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  assert.match(packageJson.scripts.dev, /cross-env XINGMANG_RENDERER=v2 npm run dev:runtime/)
  const runtimeScript = packageJson.scripts['dev:runtime']
  const configuredUrl = runtimeScript.match(/VITE_DEV_SERVER_URL=(https?:\/\/[^\s"]+)/)?.[1]
  assert.ok(configuredUrl, 'dev:runtime script must provide VITE_DEV_SERVER_URL')
  const configuredOrigin = new URL(configuredUrl)
  const viteConfig = await resolveConfig({ root: projectRoot, logLevel: 'silent' }, 'serve')
  assert.equal(configuredOrigin.hostname, '127.0.0.1')
  assert.equal(configuredOrigin.hostname, viteConfig.server.host)
  assert.equal(Number(configuredOrigin.port), viteConfig.server.port)
  assert.equal(viteConfig.server.strictPort, true)
  const waitOnIndex = runtimeScript.indexOf('wait-on')
  const configuredEndpointIndex = runtimeScript.indexOf(`tcp:${configuredOrigin.host}`, waitOnIndex)
  assert.ok(
    waitOnIndex >= 0 && configuredEndpointIndex > waitOnIndex,
    'dev script must wait on the same origin that Electron loads',
  )
  return configuredOrigin
}

test('the default development command and Vite use the same origin', async () => {
  await configuredDevelopmentOrigin()
})

test('the configured macOS development origin renders the real Electron app', {
  skip: process.platform !== 'darwin',
  timeout: 30_000,
}, async (t) => {
  const started = Date.now()
  const steps = {}
  const testProcess = watchTestProcessStalls(started)
  // Each step is reported as it completes, so even a run that reaches the
  // test's own time limit shows how far it got.
  function step(name) {
    steps[name] = Date.now() - started
    t.diagnostic(`${name} at ${steps[name]} ms`)
  }
  const configuredOrigin = await configuredDevelopmentOrigin()

  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-dev-origin-test-'))
  // withSignedOutSmokeIsolation keeps its launcher under artifacts/. Only that
  // goes there: the profile stays outside the tree the dev server watches.
  await fs.mkdir(path.join(projectRoot, 'artifacts'), { recursive: true })
  const launcherRoot = await fs.mkdtemp(path.join(projectRoot, 'artifacts', 'macos-dev-origin-'))
  const homeDirectory = path.join(stateRoot, 'home')
  const userDataDirectory = path.join(stateRoot, 'user-data')
  await fs.mkdir(homeDirectory, { recursive: true })

  let application
  let server
  try {
    let port
    ;({ server, port } = await createFixtureServer({ root: projectRoot, logLevel: 'silent' }))
    step('dev server ready')

    const devUrl = new URL(configuredOrigin)
    devUrl.port = String(port)
    // Production stays out of this test: the account sites answer the public
    // status read from a fixture, every other request is refused, and only
    // the fixture dev server may serve the renderer.
    application = await electron.launch(await withSignedOutSmokeIsolation({
      args: ['.', `--user-data-dir=${userDataDirectory}`],
      cwd: projectRoot,
      timeout: 10_000,
      env: {
        ...process.env,
        HOME: homeDirectory,
        USERPROFILE: homeDirectory,
        VITE_DEV_SERVER_URL: devUrl.origin,
        XINGMANG_DISABLE_SINGLE_INSTANCE: '1',
      },
    }, launcherRoot, { rendererOrigins: [devUrl.origin] }))
    const mainOutput = recordProcessOutput(application.process())
    step('electron launched')
    // Evidence only, so neither of these is awaited.
    void settleWithin(application.evaluate(installMainProcessStallLog).catch(() => undefined), 2_000, undefined)
    const page = await application.firstWindow({ timeout: 10_000 })
    step('first window')
    const cdp = await application.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 })
    await cdp.send('Profiler.start')
    await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', streamFormat: 'json', traceConfig: { includedCategories: ['toplevel', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8.execute', 'blink', 'gpu', 'cc', 'loading'] } })
    // Not awaited: the timeline is evidence only and must not hold up the run.
    void settleWithin(page.evaluate(installRendererTimeline).catch(() => undefined), 2_000, undefined)
    const bootstrap = observeFixtureBootstrap(page, server)
    const pageErrors = createPageErrorCollector()
    pageErrors.watch(page)
    const failedRequests = []
    page.on('requestfailed', (request) => {
      failedRequests.push({ url: request.url(), error: request.failure()?.errorText })
    })

    await page.waitForLoadState('domcontentloaded', { timeout: 5_000 })
    step('document loaded')
    try {
      await page.getByTestId('welcome-page').waitFor({ state: 'visible', timeout: 5_000 })
    } catch {
      const evidence = await welcomeTimeoutEvidence({ application, page, bootstrap, origin: started, steps, testProcessStalls: testProcess.stalls, failedRequests, mainOutput })
      assert.fail(`welcome page not visible within 5 s of the document loading: ${JSON.stringify(evidence)}`)
    }
    step('welcome visible')
    const { profile } = await cdp.send('Profiler.stop')
    t.diagnostic(`profile: ${JSON.stringify(summarizeProfile(profile))}`)
    const tracingComplete = new Promise((resolve) => cdp.once('Tracing.tracingComplete', resolve))
    await cdp.send('Tracing.end')
    const { stream } = await tracingComplete
    let traceText = ''
    for (;;) {
      const chunk = await cdp.send('IO.read', { handle: stream, size: 1 << 20 })
      traceText += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data
      if (chunk.eof) break
    }
    await cdp.send('IO.close', { handle: stream })
    t.diagnostic(`trace: ${JSON.stringify(summarizeTrace(traceText))}`)
    const [renderer, mainProcessStalls] = await Promise.all([
      settleWithin(page.evaluate(readRendererTimeline, started).catch(() => null), 2_000, null),
      settleWithin(application.evaluate(readMainProcessStalls, started).catch(() => null), 2_000, null),
    ])
    t.diagnostic(`timeline: ${JSON.stringify({ renderer, mainProcessStalls, testProcessStalls: testProcess.stalls })}`)
    bootstrap.dispose()
    assert.equal(new URL(page.url()).origin, devUrl.origin)
    // ToastProvider renders a sibling live region; raw root child count is
    // not a boot invariant. Verify the app surface and preload bridge instead.
    assert.equal(await page.locator('#root').getByTestId('welcome-page').count(), 1)
    assert.equal(await page.getByTestId('welcome-login').isVisible(), true)
    assert.equal(await page.evaluate(() => typeof window.xingmang?.getAccountSession), 'function')
    pageErrors.assertNone()
    await verifySignedOutSmokeIsolation(application, { requirePublicStatus: false })
  } finally {
    testProcess.stop()
    try {
      if (application) {
        await application.close()
        step('electron closed')
      }
    } finally {
      try {
        await server?.close()
      } finally {
        await fs.rm(stateRoot, { recursive: true, force: true })
        await fs.rm(launcherRoot, { recursive: true, force: true })
      }
    }
  }
})

test('the configured development server refuses to reuse an occupied port', {
  skip: process.platform !== 'darwin',
  timeout: 15_000,
}, async () => {
  const config = await resolveConfig({ root: projectRoot, logLevel: 'silent' }, 'serve')
  const port = config.server.port
  const host = typeof config.server.host === 'string' ? config.server.host : '127.0.0.1'
  const blocker = net.createServer()
  let blockerListening = false
  let server

  try {
    try {
      await listen(blocker, { host, port })
      blockerListening = true
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') throw error
    }

    server = await createServer({ root: projectRoot, logLevel: 'silent' })
    await assert.rejects(server.listen(), /Port \d+ is already in use/)
  } finally {
    try {
      await server?.close()
    } finally {
      if (blockerListening) await close(blocker)
    }
  }
})
