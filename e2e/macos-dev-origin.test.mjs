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

// What the window showed and who had stopped answering when the welcome page
// did not appear. Every probe is bounded so the report itself cannot hang.
async function welcomeTimeoutEvidence({ application, page, bootstrap, steps, failedRequests, mainOutput }) {
  const mainProcessAsked = Date.now()
  const [screen, mainProcess, reads, fixture] = await Promise.all([
    settleWithin(page.evaluate(() => ({
      path: location.pathname,
      readyState: document.readyState,
      testIds: [...new Set([...document.querySelectorAll('[data-testid]')].map((element) => element.dataset.testid))].slice(0, 24),
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
    })).catch((error) => ({ error: error.message })), 2_000, { unanswered: true }),
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
  return { steps, screen, mainProcess, bootstrapReads: reads, fixture, failedRequests: failedRequests.slice(0, 8), mainOutput }
}

// A hung quit used to run the test into its 30 s limit, which replaced the
// real failure with a bare "test timed out".
async function closeElectron(application) {
  if (!application) return null
  const outcome = await settleWithin(application.close().then(() => null, (error) => `close() failed: ${error.message}`), 10_000, 'hung')
  if (outcome !== 'hung') return outcome
  application.process()?.kill('SIGKILL')
  return 'Electron did not quit within 10 s of close()'
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
  let failure
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
    const page = await application.firstWindow({ timeout: 10_000 })
    step('first window')
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
      const evidence = await welcomeTimeoutEvidence({ application, page, bootstrap, steps, failedRequests, mainOutput })
      assert.fail(`welcome page not visible within 5 s of the document loading: ${JSON.stringify(evidence)}`)
    }
    step('welcome visible')
    bootstrap.dispose()
    assert.equal(new URL(page.url()).origin, devUrl.origin)
    // ToastProvider renders a sibling live region; raw root child count is
    // not a boot invariant. Verify the app surface and preload bridge instead.
    assert.equal(await page.locator('#root').getByTestId('welcome-page').count(), 1)
    assert.equal(await page.getByTestId('welcome-login').isVisible(), true)
    assert.equal(await page.evaluate(() => typeof window.xingmang?.getAccountSession), 'function')
    pageErrors.assertNone()
    await verifySignedOutSmokeIsolation(application, { requirePublicStatus: false })
  } catch (error) {
    failure = error
    throw error
  } finally {
    const closeProblem = await closeElectron(application)
    try {
      await server?.close()
    } finally {
      await fs.rm(stateRoot, { recursive: true, force: true })
      await fs.rm(launcherRoot, { recursive: true, force: true })
    }
    if (closeProblem && !failure) assert.fail(closeProblem)
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
