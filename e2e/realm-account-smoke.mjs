import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { collectedPromiseAttempts, collectedPromiseBackoffFor, fixtureReadyTimeoutMs } from './fixture-readiness.mjs'
import { createSmokeRuntime } from './smoke-runtime.mjs'

// Run after npm run compile. Every network transport is replaced before the
// application entry is loaded; the fixture never contacts either real site.
//
// This smoke drives three cold Electron starts and roughly thirty main- and
// renderer-process evaluations, none of which carry a Playwright timeout of
// their own. Before it joined the Windows required job that was only a latent
// risk; inside the job it would be the same failure mode as #131 and #133, so
// every wait below goes through the shared smoke runtime instead.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reviewDirectory = path.join(projectRoot, 'output/realm-account-review')
const resultPath = path.join(reviewDirectory, 'result.json')

const { stepBudgetMs, progress, withDeadline, trackProcessIds, releaseProcessIds, attachEvidence, run } = createSmokeRuntime({
  name: 'realm-account-smoke',
  stepBudgetMs: Number(process.env.XINGMANG_SMOKE_STEP_TIMEOUT_MS ?? 90_000),
  // Three cold starts plus the whole dual-site login walk. A Windows runner
  // needs ~16s for each start alone, so the budget is roughly twice the
  // observed run rather than a tight fit.
  totalBudgetMs: Number(process.env.XINGMANG_SMOKE_TOTAL_TIMEOUT_MS ?? 480_000),
})
attachEvidence(resultPath)

function bootFixture(config) {
  const { app, net, safeStorage, session, shell } = require('electron')
  const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
  const { managedCliKeyProfiles, sub2ApiManagedCliKeyProfiles } = require(config.catalog)
  if (require('node:path').resolve(require('node:os').homedir()) !== require('node:path').resolve(config.userHome)) throw new Error('Fixture home isolation failed')
  if (typeof app.setAppPath === 'function') app.setAppPath(config.projectRoot)
  else app.getAppPath = () => config.projectRoot
  app.setPath('userData', config.userData)
  app.setPath('home', config.userHome)
  const cipherKey = Buffer.alloc(32, 23)
  safeStorage.isEncryptionAvailable = () => true
  safeStorage.getSelectedStorageBackend = () => 'realm-smoke-aes'
  safeStorage.encryptString = (plaintext) => {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', cipherKey, iv)
    const bytes = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), bytes])
  }
  safeStorage.decryptString = (encrypted) => {
    const decipher = createDecipheriv('aes-256-gcm', cipherKey, encrypted.subarray(0, 12))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8')
  }
  const calls = []
  const blocked = []
  const rendererBlocked = []
  let loginOutcome = 'success'
  const keys = { xm: [], api: [] }
  const groups = Object.values(sub2ApiManagedCliKeyProfiles).map((entry, index) => ({ id: index + 1,
    name: entry.group, platform: 'openai', status: 'active', rate_multiplier: 1 }))
  groups.push({ id: 5, name: 'GPT-image2', platform: 'openai', status: 'active', rate_multiplier: 1 })
  const xmUser = { id: 7, username: 'same@example.test', email: 'same@example.test', display_name: 'NewAPI User',
    group: 'default', role: 1, status: 1, quota: 50000000, used_quota: 0, request_count: 0,
    aff_code: '', aff_count: 0, aff_quota: 0, aff_history_quota: 0 }
  const apiUser = { id: 7, username: 'same@example.test', email: 'same@example.test', balance: 100, status: 'active', role: 'user' }
  const xmAuth = { access_token: 'fixture-xm-access', access_expires_at: null, user: xmUser }
  const apiAuth = { access_token: 'fixture-api-access', refresh_token: 'fixture-api-refresh', expires_in: 3600, token_type: 'Bearer', user: apiUser }
  function reply(url, payload, cookie) {
    const response = Response.json(payload, cookie ? { headers: { 'set-cookie': cookie } } : undefined)
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
  function rejected(url, api = false) {
    const response = Response.json(api ? { code: 401, message: 'Invalid email or password', data: null }
      : { success: false, message: '用户名或密码错误', data: null }, { status: 401 })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
  function deny(origin, route) {
    blocked.push({ origin, route })
    throw new Error('Network unavailable in isolated realm fixture')
  }
  const serveRequest = async (input, init) => {
    const raw = typeof input === 'string' ? input : input.url ?? String(input)
    const url = new URL(raw)
    const method = init.method ?? 'GET'
    const route = url.pathname
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    const xm = (data, cookie) => reply(raw, { success: true, message: '', data }, cookie)
    const api = (data) => reply(raw, { code: 0, data })
    if (url.origin === 'https://xm.solov.cc') {
      if (headers.get('authorization')?.includes('fixture-api')) throw new Error('Cross-domain bearer leak')
      if (route === '/api/status') return xm({ system_name: 'Fixture NewAPI', version: 'fixture', setup: true,
        quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 1,
        register_enabled: true, password_register_enabled: true, email_verification: false, turnstile_check: false })
      if (route === '/api/user/login') return body.password === 'fixture-shared-password-123'
        ? xm(xmAuth, 'refresh_token=fixture-xm-cookie; HttpOnly; Path=/') : rejected(raw)
      if (route === '/api/user/auth/refresh') return xm(xmAuth, 'refresh_token=fixture-xm-restored; HttpOnly; Path=/')
      if (route === '/api/user/self') return xm(xmUser)
      if (route === '/api/log/self') return xm({ items: [], total: 0, page: 1, page_size: 20 })
      if (route === '/api/log/self/stat') return xm({ quota: 0, rpm: 0, tpm: 0 })
      if (route === '/api/notice' || route === '/api/user-agreement' || route === '/api/privacy-policy') return xm('Fixture document')
      if (route === '/api/reset_password') return xm(null)
      if (route === '/api/user/self/groups') return xm(Object.fromEntries(Object.values(managedCliKeyProfiles).map((entry) => [entry.group, { desc: entry.group, ratio: 1 }])))
      if (route === '/api/token/' && method === 'GET') return xm({ items: keys.xm, total: keys.xm.length })
      if (route === '/api/token/' && method === 'POST') {
        keys.xm.push({ ...body, id: keys.xm.length + 1, user_id: 7, status: 1, used_quota: 0, created_time: 1700000000, accessed_time: 0, key: 'masked' })
        return xm(null)
      }
      const reveal = route.match(/^\/api\/token\/(\d+)\/key$/)
      if (reveal && method === 'POST') return xm({ key: `sk-fixture-xm-${reveal[1]}` })
    } else if (url.origin === 'https://api.solov.cc') {
      if (headers.has('cookie') || headers.has('new-api-user') || headers.get('authorization')?.includes('fixture-xm')) throw new Error('Cross-domain cookie leak')
      if (route === '/api/v1/settings/public') return api({ site_name: 'Fixture Sub2API', turnstile_enabled: false })
      if (route === '/api/v1/auth/login') {
        if (loginOutcome === 'two-factor') return api({ requires_2fa: true, temp_token: 'fixture-private-2fa-token' })
        return loginOutcome === 'success' && body.password === 'fixture-shared-password-123' ? api(apiAuth) : rejected(raw, true)
      }
      if (route === '/api/v1/auth/refresh') return api(apiAuth)
      if (route === '/api/v1/auth/me' || route === '/api/v1/user/profile') return api(apiUser)
      if (route === '/api/v1/groups/available') return api(groups)
      if (route === '/api/v1/keys' && method === 'GET') return api({ items: keys.api, total: keys.api.length })
      if (route === '/api/v1/keys' && method === 'POST') {
        const key = { ...body, id: keys.api.length + 1, user_id: 7, status: 'active', quota: 0, quota_used: 0,
          key: `sk-fixture-api-${keys.api.length + 1}`, created_at: '2026-09-01T00:00:00Z', expires_at: null, last_used_at: null }
        keys.api.push(key)
        return api(key)
      }
      const reveal = route.match(/^\/api\/v1\/keys\/(\d+)$/)
      if (reveal && method === 'GET') return api(keys.api.find((key) => key.id === Number(reveal[1])))
    }
    if (['https://xm.solov.cc', 'https://api.solov.cc'].includes(url.origin) && route === '/v1/models') {
      return reply(raw, { object: 'list', data: ['gpt-5.6-sol', 'gemini-3.7-flash', 'gpt-image-2'].map((id) => ({ id, object: 'model' })) })
    }
    return deny(url.origin, route)
  }
  // Each request records how it ended instead of the evidence file asserting the
  // outcome afterwards: a route that stops being mocked has to surface as a
  // refusal rather than still counting as one the fixture answered (T-G8).
  const fetchMock = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
    const record = { origin: url.origin, route: url.pathname, method: init.method ?? 'GET', outcome: 'denied' }
    calls.push(record)
    const response = await serveRequest(input, init)
    record.outcome = 'served'
    return response
  }
  net.fetch = fetchMock
  globalThis.fetch = fetchMock
  net.request = () => deny('electron-net', 'request')
  shell.openExternal = async () => deny('external-browser', 'open')
  for (const protocol of ['node:http', 'node:https']) {
    const transport = require(protocol)
    transport.request = () => deny(protocol, 'request')
    transport.get = () => deny(protocol, 'get')
  }
  app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      rendererBlocked.push(new URL(details.url).origin)
      callback({ cancel: true })
    })
  })
  globalThis.__realmSmoke = {
    setLoginOutcome: (value) => { loginOutcome = value },
    isolation: async () => {
      if (net.fetch !== fetchMock || globalThis.fetch !== fetchMock) throw new Error('Fixture fetch isolation changed')
      const denied = []
      const probes = {
        globalFetch: () => globalThis.fetch('https://isolated.invalid/probe'),
        electronFetch: () => net.fetch('https://isolated.invalid/probe'),
        electronRequest: () => net.request('https://isolated.invalid/probe'),
        http: () => require('node:http').get('http://isolated.invalid/probe'),
        https: () => require('node:https').request('https://isolated.invalid/probe'),
        externalBrowser: () => shell.openExternal('https://isolated.invalid/probe'),
      }
      for (const [name, probe] of Object.entries(probes)) {
        try { await probe() } catch (error) {
          if (error.message !== 'Network unavailable in isolated realm fixture') throw error
          denied.push(name)
        }
      }
      return { denied, home: require('node:os').homedir(), userData: app.getPath('userData'), appHome: app.getPath('home') }
    },
    stats: () => ({ calls, blocked, rendererBlocked, groups: { xm: keys.xm.map((key) => key.group),
      api: keys.api.map((key) => groups.find((group) => group.id === key.group_id)?.name) } }),
  }
  require(config.entry)
}

let sandbox
let userHome
let userData
let bootstrap
let env
let application
let currentProcessId
let stderr = ''
let stage = 'initial startup'
let isolationChecks = 0
let customerUiScans = 0
const errors = []
const processIds = []

// A request the fixture must never route, because answering one would be the
// fixture paying for real generation. Declared once so the mid-run assertion and
// the measurement written into the evidence file cannot drift apart.
const generationRoute = /images\/generations|chat\/completions|\/responses|\/videos/

// T-G8, and the same treatment the other three evidence producers already got:
// this file used to be a wall of literal `true` written after the last
// assertion, which reads like a measurement once it is pasted into a review
// document. Two of them were not even verdicts — the request count and the
// "no paid generation" flag were constants with no counter behind them. Only a
// name pushed by the step that proved it reaches the evidence now, and every
// number in it is read back out of the fixture.
const expectedAssertions = ['dual-realm-login', 'explicit-source-selection', 'identical-credentials',
  'no-fallback-on-rejection', 'two-factor-preserves-session', 'source-bound-recovery', 'remembered-routing',
  'platform-details-hidden', 'saved-switch', 'key-stores-separated', 'canvas-realm-events', 'restore-and-logout']
const passedAssertions = []

function recordPass(name) {
  // A typo would otherwise drop a name from the evidence with nothing failing.
  if (!expectedAssertions.includes(name)) throw new Error(`Unknown smoke assertion: ${name}`)
  if (!passedAssertions.includes(name)) passedAssertions.push(name)
}

function beginStage(label) {
  stage = label
  progress(label)
}

async function prepareSandbox() {
  await fs.access(path.join(projectRoot, 'dist', 'renderer-v2.flag'))
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-realm-smoke-'))
  userHome = path.join(sandbox, 'home')
  userData = path.join(sandbox, 'user-data')
  bootstrap = path.join(sandbox, 'bootstrap.cjs')
  await fs.mkdir(userHome)
  await fs.mkdir(userData)
  await fs.mkdir(reviewDirectory, { recursive: true })
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ version: 2, theme: 'dark',
    checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false, officialProviders: ['claude', 'codex', 'gemini', 'grok'] }), 'utf8')
  await fs.writeFile(bootstrap, `(${bootFixture.toString()})(${JSON.stringify({ userHome, userData, projectRoot,
    entry: path.join(projectRoot, 'dist-electron/platform/entry.js'), catalog: path.join(projectRoot, 'dist-electron/catalog.js') })})\n`, 'utf8')
  env = { ...process.env, HOME: userHome, USERPROFILE: userHome, APPDATA: path.join(sandbox, 'appdata'),
    LOCALAPPDATA: path.join(sandbox, 'local-appdata'), XINGMANG_RENDERER: '', VITE_DEV_SERVER_URL: '',
    XINGMANG_CODEX_HOME_OVERRIDE: path.join(userHome, '.codex'), XINGMANG_DISABLE_SINGLE_INSTANCE: '1', NODE_OPTIONS: '',
    XINGMANG_ONBOARDING_PREVIEW: '', XINGMANG_DASHBOARD_PREVIEW: '', XINGMANG_UPDATE_DEV: '' }
  delete env.ELECTRON_RUN_AS_NODE
}

// Playwright drives ElectronApplication.evaluate through the main process's
// Node inspector, and V8 can collect the inspector's promise wrapper while that
// process is busy. Windows runners hit it where macOS never does (#124, #128,
// #139). Everything routed through here either reads fixture state or repaints
// a window, so replaying one changes nothing; the single evaluation that drives
// the quit lifecycle stays out of it and is bounded without a retry.
//
// The replays back off rather than repeating on a fixed interval: what collects
// the wrapper is the main process being stalled, and a stall long enough to take
// one attempt is long enough to take three that follow 500ms apart. Run #236
// spent all three between 131.0s and 132.0s on one stall. Both the attempt count
// and the backoff come from the shared readiness budget, and every line below
// names the attempt and the wait so a CI log says how much patience was spent.
async function evaluateInMainProcess(label, body, argument) {
  let collected
  let backedOffMs = 0
  for (let attempt = 1; attempt <= collectedPromiseAttempts; attempt += 1) {
    try {
      return await withDeadline(`${label} (attempt ${attempt}/${collectedPromiseAttempts})`, stepBudgetMs,
        () => application.evaluate(body, argument))
    }
    catch (error) {
      if (!/Resulting promise was garbage collected/.test(String(error?.message))) throw error
      collected = error
      if (attempt === collectedPromiseAttempts) break
      const backoffMs = collectedPromiseBackoffFor(attempt)
      progress(`${label}: the inspector promise was collected on attempt ${attempt}/${collectedPromiseAttempts}, retrying in ${backoffMs}ms (${backedOffMs}ms of backoff spent so far)`)
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
      backedOffMs += backoffMs
    }
  }
  throw new Error(`${label}: the inspector promise was collected on all ${collectedPromiseAttempts} attempts, spread over ${backedOffMs}ms of backoff`,
    { cause: collected })
}

function evaluateInRenderer(target, label, body, argument) {
  return withDeadline(label, stepBudgetMs, () => target.evaluate(body, argument))
}

function readFixtureStats() {
  return evaluateInMainProcess('fixture network statistics', () => globalThis.__realmSmoke.stats())
}

function loginCallOrigins(stats) {
  return stats.calls.filter((call) => call.route.endsWith('/login'))
}

async function start() {
  progress('launching the isolated fixture application')
  application = await withDeadline('Electron launch', stepBudgetMs, () => electron.launch({
    cwd: projectRoot, args: [bootstrap, `--user-data-dir=${userData}`], env, timeout: stepBudgetMs }))
  currentProcessId = application.process().pid
  if (currentProcessId) {
    processIds.push(currentProcessId)
    trackProcessIds([currentProcessId])
  }
  application.process().stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-64000) })
  progress('waiting for the first window')
  const page = await withDeadline('first window', stepBudgetMs, () => application.firstWindow({ timeout: stepBudgetMs }))
  page.on('pageerror', (error) => errors.push(error.message))
  await withDeadline('preload bridge', fixtureReadyTimeoutMs,
    () => page.waitForFunction(() => Boolean(window.xingmang), { timeout: fixtureReadyTimeoutMs }))
  assert.equal(path.resolve(await evaluateInMainProcess('user data path', ({ app }) => app.getPath('userData'))), path.resolve(userData))
  assert.ok(page.url().startsWith('xingmang://app/'))
  const isolated = await evaluateInMainProcess('network isolation probes', () => globalThis.__realmSmoke.isolation())
  assert.deepEqual(isolated.denied, ['globalFetch', 'electronFetch', 'electronRequest', 'http', 'https', 'externalBrowser'])
  assert.equal(path.resolve(isolated.home), path.resolve(userHome))
  assert.equal(path.resolve(isolated.appHome), path.resolve(userHome))
  assert.equal(path.resolve(isolated.userData), path.resolve(userData))
  isolationChecks++
  await evaluateInRenderer(page, 'initial account session', () => window.xingmang.getAccountSession())
  return page
}

async function stop() {
  if (!application) return
  // Named after the stage it interrupts: a failure anywhere above unwinds
  // through here, so a bare 'stopping' would overwrite the failing step in the
  // runtime's report with the cleanup that merely followed it.
  progress(`shutting down after ${stage}`)
  // Bounded but never retried: this drives the quit lifecycle, so a replay
  // would be asking an application that already exited to exit again.
  await withDeadline('main process exit', stepBudgetMs, () => application.evaluate(({ app }) => app.exit(0))).catch(() => undefined)
  await withDeadline('close', 20_000, () => application.close()).catch(() => undefined)
  if (currentProcessId) releaseProcessIds([currentProcessId])
  currentProcessId = undefined
  application = undefined
}

async function assertCustomerUi(page) {
  assert.doesNotMatch(await page.locator('body').innerText(), /new[ -]?api|sub2api|xm\.solov\.cc|api\.solov\.cc/i)
  customerUiScans++
  recordPass('platform-details-hidden')
}
async function openLoginWithUi(page) {
  await page.getByRole('button', { name: '登录', exact: true }).click({ timeout: fixtureReadyTimeoutMs })
  const dialog = page.getByTestId('login-dialog')
  const accountLogin = page.getByRole('button', { name: '登录账号', exact: true })
  await dialog.or(accountLogin).first().waitFor({ state: 'visible', timeout: fixtureReadyTimeoutMs })
  if (!await dialog.isVisible()) await accountLogin.click()
}
async function loginWithUi(page, siteId) {
  await page.getByTestId('auth-source').getByRole('button', { name: siteId === 'solov' ? '星芒账号' : '历史账号', exact: true }).click()
  await page.getByTestId('login-account').fill('same@example.test')
  await page.getByTestId('login-password').fill('fixture-shared-password-123')
  await page.getByTestId('login-remember').check()
  await page.getByTestId('auth-agree').check()
  await assertCustomerUi(page)
  await evaluateInMainProcess('raise the fixture window', ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith('xingmang://app/'))
    window?.show()
    window?.focus()
  })
  await evaluateInRenderer(page, 'settle two animation frames',
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const capture = await evaluateInMainProcess('capture the login window', async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith('xingmang://app/'))
    if (!window) throw new Error('Main fixture window is unavailable')
    return (await window.capturePage()).toPNG().toString('base64')
  })
  await fs.writeFile(path.join(reviewDirectory, `login-${siteId}.png`), Buffer.from(capture, 'base64'))
  await page.getByTestId('login-submit').click()
  await page.getByTestId('login-dialog').waitFor({ state: 'hidden', timeout: fixtureReadyTimeoutMs })
  await expect.poll(() => evaluateInRenderer(page, 'account session after login', () => window.xingmang.getAccountSession()),
    { timeout: fixtureReadyTimeoutMs }).toMatchObject({ authenticated: true, siteId, account: { userId: 7 } })
  if (await page.getByTestId('guide-pause').count()) await page.getByTestId('guide-pause').click({ timeout: fixtureReadyTimeoutMs })
  await page.getByRole('button', { name: '切换账号', exact: true }).waitFor({ timeout: fixtureReadyTimeoutMs })
  // The UI performs the first sync; explicitly repeating it checks reuse.
  const synchronized = await evaluateInRenderer(page, 'managed CLI key sync', () => window.xingmang.syncManagedCliKeys())
  assert.deepEqual(synchronized.failed, [])
  assert.equal(synchronized.storageWarning, undefined)
  const profile = await evaluateInRenderer(page, 'account profile', () => window.xingmang.getAccountProfile())
  assert.equal(profile.userId, 7)
  assert.equal(profile.email, 'same@example.test')
  const balance = await evaluateInRenderer(page, 'account balance', () => window.xingmang.getAccountBalance())
  assert.equal(balance.displayAmount, 100)
  assert.equal(balance.quotaPerUnit, siteId === 'solov' ? 500000 : 1)
  await assertCustomerUi(page)
}
async function switchWithUi(page, origin) {
  const accounts = await evaluateInRenderer(page, 'saved accounts', () => window.xingmang.listSavedAccounts())
  const target = accounts.find((account) => account.origin === origin)
  assert.ok(target)
  await page.getByRole('button', { name: '切换账号', exact: true }).click()
  await assertCustomerUi(page)
  const row = page.getByTestId('saved-accounts-list').locator('.xm-list-row').filter({ hasText: `账户尾号 ${target.id.slice(-6)}` })
  await row.getByRole('button', { name: '切换', exact: true }).click()
  await page.getByTestId('saved-accounts-list').waitFor({ state: 'hidden', timeout: fixtureReadyTimeoutMs })
}

async function main() {
  progress('preparing the isolated fixture state')
  await prepareSandbox()
  try {
    let page = await start()
    beginStage('new-api UI login')
    await openLoginWithUi(page)
    await loginWithUi(page, 'solov')
    beginStage('open an existing canvas before switching accounts')
    const canvasOpened = application.waitForEvent('window')
    await evaluateInRenderer(page, 'open the canvas window', () => window.xingmang.openCanvasWindow())
    const canvas = await withDeadline('canvas window', stepBudgetMs, () => canvasOpened)
    await withDeadline('canvas url', fixtureReadyTimeoutMs, () => canvas.waitForURL('xingmang-canvas://app/**', { timeout: fixtureReadyTimeoutMs }))
    await withDeadline('canvas host bridge', fixtureReadyTimeoutMs,
      () => canvas.waitForFunction(() => Boolean(window.xingmangCanvasHost), { timeout: fixtureReadyTimeoutMs }))
    await evaluateInRenderer(canvas, 'subscribe to canvas account changes', () => {
      window.__realmEvents = []
      window.xingmangCanvasHost.onAccountChange((event) => window.__realmEvents.push(event))
    })
    beginStage('sub2api UI login')
    await page.getByRole('button', { name: '切换账号', exact: true }).click()
    await page.getByTestId('account-add').click()
    const originalSession = await evaluateInRenderer(page, 'session before the historical login', () => window.xingmang.getAccountSession())
    await page.getByTestId('auth-source').getByRole('button', { name: '历史账号', exact: true }).click()
    await page.getByTestId('login-account').fill('same@example.test')
    await page.getByTestId('login-password').fill('fixture-shared-password-123')
    await page.getByTestId('auth-agree').check()
    for (const outcome of ['rejected', 'two-factor']) {
      beginStage(`explicit historical login ${outcome}`)
      const before = loginCallOrigins(await readFixtureStats()).length
      await evaluateInMainProcess('select the fixture login outcome',
        (_electron, value) => globalThis.__realmSmoke.setLoginOutcome(value), outcome)
      await page.getByTestId('login-submit').click()
      await page.getByTestId('auth-error').filter({ hasText: outcome === 'two-factor' ? '双重验证' : '账号或密码' }).waitFor()
      assert.deepEqual(await evaluateInRenderer(page, 'session after a refused login', () => window.xingmang.getAccountSession()), originalSession)
      const attempts = loginCallOrigins(await readFixtureStats())
      assert.deepEqual(attempts.slice(before).map((call) => call.origin), ['https://api.solov.cc'])
      assert.equal(await page.getByTestId('login-password').inputValue(), 'fixture-shared-password-123')
      recordPass(outcome === 'two-factor' ? 'two-factor-preserves-session' : 'no-fallback-on-rejection')
    }
    await evaluateInMainProcess('restore the fixture login outcome', () => globalThis.__realmSmoke.setLoginOutcome('success'))
    beginStage('historical account recovery isolation')
    await page.getByTestId('login-forgot').click()
    await page.getByTestId('forgot-official-help').waitFor()
    assert.equal(await page.getByTestId('forgot-send').count(), 0)
    await page.getByTestId('forgot-back-login').click()
    beginStage('sub2api explicit UI login')
    await loginWithUi(page, 'solov-api')
    const explicitLoginCalls = loginCallOrigins(await readFixtureStats())
    assert.deepEqual(explicitLoginCalls.map((call) => call.origin), ['https://xm.solov.cc', 'https://api.solov.cc', 'https://api.solov.cc', 'https://api.solov.cc'])
    // Both realms have now accepted the same identifier and the same password,
    // each one contacted only after it was picked by hand.
    recordPass('dual-realm-login')
    recordPass('identical-credentials')
    recordPass('explicit-source-selection')
    for (const explicit of [true, false]) {
      const rejectedRecovery = await evaluateInRenderer(page, 'refused password recovery', async (selected) => {
        try {
          await window.xingmang.sendPasswordResetCode('same@example.test', selected ? 'solov-api' : undefined)
          return false
        } catch (error) { return error.message.includes('所选账号暂不支持') }
      }, explicit)
      assert.equal(rejectedRecovery, true)
    }
    assert.equal((await readFixtureStats()).calls.some((call) => call.route === '/api/reset_password'), false)
    await evaluateInRenderer(page, 'password recovery on the official site', () => window.xingmang.sendPasswordResetCode('same@example.test', 'solov'))
    assert.equal((await readFixtureStats()).calls
      .filter((call) => call.route === '/api/reset_password' && call.origin === 'https://xm.solov.cc').length, 1)
    recordPass('source-bound-recovery')
    await expect.poll(() => evaluateInRenderer(canvas, 'latest canvas realm event', () => window.__realmEvents.at(-1)),
      { timeout: fixtureReadyTimeoutMs }).toMatchObject({ siteId: 'solov-api', userId: 7 })
    const canvasGroups = await evaluateInRenderer(canvas, 'canvas groups', () => window.xingmangCanvasHost.listGroups())
    assert.ok(canvasGroups.some((group) => group.name === 'Codex_pro'))
    const summaries = await evaluateInRenderer(page, 'saved account summaries', () => window.xingmang.listSavedAccounts())
    assert.equal(summaries.length, 2)
    assert.equal(new Set(summaries.map((entry) => entry.id)).size, 2)
    assert.ok(summaries.every((entry) => entry.userId === 7))
    assert.doesNotMatch(JSON.stringify(summaries), /fixture-(xm|api)|cookie|accessToken|refreshToken/)
    beginStage('saved account UI switching')
    await switchWithUi(page, 'https://xm.solov.cc')
    assert.equal((await evaluateInRenderer(page, 'session after switching back', () => window.xingmang.getAccountSession())).siteId, 'solov')
    assert.equal(await evaluateInRenderer(page, 'remembered login', async () => {
      const remembered = await window.xingmang.getRememberedAccountLogin()
      return remembered?.identifier === 'same@example.test' && remembered.password === 'fixture-shared-password-123'
    }), true, 'Remembered login must follow the last successful input rather than the currently viewed account')
    recordPass('remembered-routing')
    await expect.poll(() => evaluateInRenderer(canvas, 'latest canvas realm event', () => window.__realmEvents.at(-1)),
      { timeout: fixtureReadyTimeoutMs }).toMatchObject({ siteId: 'solov', userId: 7 })
    await switchWithUi(page, 'https://api.solov.cc')
    assert.equal((await evaluateInRenderer(page, 'session after switching forward', () => window.xingmang.getAccountSession())).siteId, 'solov-api')
    await expect.poll(() => evaluateInRenderer(canvas, 'latest canvas realm event', () => window.__realmEvents.at(-1)),
      { timeout: fixtureReadyTimeoutMs }).toMatchObject({ siteId: 'solov-api', userId: 7 })
    // Both directions of the switch landed, and the canvas window followed each
    // one without ever being handed a credential.
    recordPass('saved-switch')
    recordPass('canvas-realm-events')
    const stats = await readFixtureStats()
    assert.deepEqual(new Set(stats.groups.api), new Set(['Codex_pro', 'Claude-MAX(不限客户端)', 'Gemini', 'grok-heavy']))
    assert.equal(stats.groups.api.length, 4)
    assert.equal(stats.groups.xm.length, 4)
    assert.deepEqual(stats.calls.filter((call) => generationRoute.test(call.route)), [])
    await fs.access(path.join(userData, 'managed-cli-keys.dat'))
    await fs.access(path.join(userData, 'realms/api-account/managed-cli-keys.dat'))
    recordPass('key-stores-separated')
    beginStage('restart with sub2api active')
    await stop()
    page = await start()
    assert.equal((await evaluateInRenderer(page, 'restored session', () => window.xingmang.getAccountSession())).siteId, 'solov-api')
    assert.equal((await evaluateInRenderer(page, 'restored saved accounts', () => window.xingmang.listSavedAccounts())).length, 2)
    beginStage('logout and restart')
    await evaluateInRenderer(page, 'logout', () => window.xingmang.logoutAccount())
    await stop()
    page = await start()
    assert.equal((await evaluateInRenderer(page, 'session after logout', () => window.xingmang.getAccountSession())).authenticated, false)
    const afterLogout = await evaluateInRenderer(page, 'saved accounts after logout', () => window.xingmang.listSavedAccounts())
    assert.equal(afterLogout.length, 1)
    assert.equal(afterLogout[0].origin, 'https://xm.solov.cc')
    recordPass('restore-and-logout')
    beginStage('preferred backend after logout and restart')
    await openLoginWithUi(page)
    await page.getByTestId('auth-source').getByRole('button', { name: '历史账号', exact: true }).click()
    await expect.poll(() => page.getByTestId('login-password').inputValue().then((value) => value === 'fixture-shared-password-123'),
      { timeout: fixtureReadyTimeoutMs }).toBe(true)
    await expect(page.getByTestId('login-remember')).toBeChecked()
    await loginWithUi(page, 'solov-api')
    const preferredLoginCalls = loginCallOrigins(await readFixtureStats())
    assert.deepEqual(preferredLoginCalls.map((call) => call.origin), ['https://api.solov.cc'])
    await evaluateInRenderer(page, 'final logout', () => window.xingmang.logoutAccount())
    assert.deepEqual(errors, [])
    // Read once more so the numbers below cover the whole run, including the two
    // restarts and the logins after them, rather than the point mid-run where
    // the group assertions happened to look.
    const finalStats = await readFixtureStats()
    assert.deepEqual(finalStats.calls.filter((call) => generationRoute.test(call.route)), [],
      'the fixture must never route a paid generation request')
    // A run that quietly stopped reaching a step would otherwise ship a shorter
    // list and still exit 0.
    assert.deepEqual([...passedAssertions].sort(), [...expectedAssertions].sort())
    const result = {
      passedAssertions,
      // Every number here is read back out of the fixture. Answered plus
      // refused is every HTTP request the application made, so a request that
      // escaped to a real site would have to be missing from both;
      // egressAttemptsDenied also counts the non-fetch transports, which the
      // fixture replaces with a refusal rather than a reply.
      measured: {
        requestsAnsweredByFixture: finalStats.calls.filter((call) => call.outcome === 'served').length,
        requestsRefusedByFixture: finalStats.calls.filter((call) => call.outcome === 'denied').length,
        egressAttemptsDenied: finalStats.blocked.length,
        rendererOriginsBlocked: [...new Set(finalStats.rendererBlocked)],
        generationRequests: finalStats.calls.filter((call) => generationRoute.test(call.route)).length,
        isolationProbeRuns: isolationChecks,
        customerUiScans,
        managedKeyGroups: { solov: finalStats.groups.xm, solovApi: finalStats.groups.api },
      },
      fixtureProcessIds: processIds,
    }
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8')
    return result
  } catch (error) {
    console.error(`Realm smoke failed during: ${stage}`)
    const startupLog = await fs.readFile(path.join(userData, 'logs/startup-failure.log'), 'utf8').catch(() => '')
    const runtimeLog = await fs.readFile(path.join(userData, 'logs/runtime.jsonl'), 'utf8').catch(() => '')
    const recent = runtimeLog.split('\n').filter((line) => line.includes('"level":"error"')).slice(-6).join('\n')
    const diagnostics = `${stderr}\n${startupLog}\n${recent}`
      .replace(/(?:sk-)?fixture-(?:password|xm|api)[A-Za-z0-9_-]*/g, '[fixture-secret]')
      .replace(/((?:password|token|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[redacted]')
    console.error(diagnostics)
    throw error
  } finally {
    await stop()
    const relative = path.relative(os.tmpdir(), sandbox)
    if (path.isAbsolute(relative) || relative.startsWith('..') || !path.basename(sandbox).startsWith('xingmang-realm-smoke-')) throw new Error('Invalid fixture cleanup root')
    await fs.rm(sandbox, { recursive: true, force: true })
  }
}

await run(main)
