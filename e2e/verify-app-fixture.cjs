'use strict'

// Electron main-process bootstrap for `npm run verify:app` (e2e/verify-app.mjs).
// Electron loads this file as its entry; it replaces every network transport the
// main process can reach before the real application entry is required, then
// hands over to dist-electron/platform/entry.js exactly as a customer start does.
//
// Two account sites are faked (星芒账号 on new-api, 历史账号 on sub2api), both
// lines of each. Everything else is refused: AGENTS.md section 1 forbids
// automated runs from sending real requests to production, and a screenshot that
// depends on whatever npm or an update feed answered today is not evidence
// anyone can reproduce. The answers below are only what the screens need to
// render; a route the fixture does not know is recorded as unrouted and listed in
// the report rather than silently answered.
//
// The half that decides answers (answerAccountRequest) is pure and exported so
// scripts/verify-app.test.cjs can pin it without starting Electron.

const accountOrigins = Object.freeze({
  xm: Object.freeze(['https://xm.solov.cc', 'https://xm-direct.solov.cc']),
  api: Object.freeze(['https://api.solov.cc', 'https://api-direct.solov.cc']),
})

const loginPassword = 'verify-app-password-123'
const loginAccount = 'verify@example.test'
// new-api counts money in quota units; 星芒 runs 500000 units to the dollar.
const quotaPerUnit = 500000

function siteOf(origin) {
  if (accountOrigins.xm.includes(origin)) return 'xm'
  if (accountOrigins.api.includes(origin)) return 'api'
  return null
}

function createFixtureState({ balance, groups }) {
  return { balance, groups, keys: { xm: [], api: [] } }
}

function xmUser(state) {
  // The display name is shown verbatim on the account page; keep it free of any
  // platform word so a screen scan never mistakes the fixture for a UI leak.
  return { id: 7, username: loginAccount, email: loginAccount, display_name: '体验用户', group: 'default', role: 1, status: 1,
    quota: Math.round(state.balance * quotaPerUnit), used_quota: 0, request_count: 0,
    aff_code: 'VERIFY', aff_count: 0, aff_quota: 0, aff_history_quota: 0 }
}

function apiUser(state) {
  return { id: 7, username: loginAccount, email: loginAccount, balance: state.balance, status: 'active', role: 'user' }
}

// One model of each kind, so every mode of the composer (text, image, video) has something to pick in a
// screenshot run. Listing a model does not make the fixture generate with it: see generationRoute below.
const models = Object.freeze(['claude-sonnet-5', 'claude-haiku-5', 'gpt-6-astra', 'grok-5', 'gpt-image-2', 'grok-imagine-video-1.5'])

function answerXm(state, { method, route, body }) {
  const ok = (data, cookie) => ({ status: 200, payload: { success: true, message: '', data }, cookie })
  const page = (items) => ok({ items, total: items.length, page: 1, page_size: 20 })
  const auth = () => ({ access_token: 'verify-app-xm-access', access_expires_at: null, user: xmUser(state) })
  if (route === '/api/status') {
    return ok({ system_name: 'Verify', version: 'verify-app', setup: true, quota_per_unit: quotaPerUnit, quota_display_type: 'USD',
      usd_exchange_rate: 1, register_enabled: true, password_register_enabled: true, email_verification: false, turnstile_check: false })
  }
  // An empty notice keeps the announcement dialog from covering every screenshot.
  if (route === '/api/notice') return ok('')
  if (route === '/api/user-agreement' || route === '/api/privacy-policy') return ok('沙箱验证用的协议正文。')
  // The server has not published its line-status file yet (route-status-file.ts),
  // so production answers 404 here today; answer the same.
  if (route === '/xm-route-status.json') return { status: 404, payload: { success: false, message: 'Not Found', data: null } }
  if (route === '/api/user/login' && method === 'POST') {
    return body.password === loginPassword
      ? ok(auth(), 'refresh_token=verify-app; HttpOnly; Path=/')
      : { status: 401, payload: { success: false, message: '用户名或密码错误', data: null } }
  }
  if (route === '/api/user/auth/refresh') return ok(auth(), 'refresh_token=verify-app-renewed; HttpOnly; Path=/')
  if (route === '/api/user/auth/logout') return ok(null)
  if (route === '/api/user/self') return ok(xmUser(state))
  if (route === '/api/user/self/groups') return ok(Object.fromEntries(state.groups.map((group) => [group, { desc: group, ratio: 1 }])))
  if (route === '/api/user/models') return ok(models)
  if (route === '/api/user/sessions') return ok([])
  if (route === '/api/log/self') return page([])
  if (route === '/api/log/self/stat') return ok({ quota: 0, rpm: 0, tpm: 0 })
  if (route === '/api/data/self') return ok([])
  if (route === '/api/task/self') return page([])
  if (route === '/api/user/topup/self') return page([])
  if (route === '/api/user/topup/info') {
    return ok({ enable_online_topup: true, pay_methods: [{ name: '支付宝', type: 'alipay', min_topup: 1 }, { name: '微信', type: 'wxpay', min_topup: 1 }],
      amount_options: [10, 50, 100, 200], discount: {}, min_topup: 1, payment_compliance_confirmed: true })
  }
  if (route === '/api/subscription/plans') return ok([])
  if (route === '/api/subscription/self') return ok({ subscriptions: [], billing_preference: 'wallet_first' })
  if (route === '/api/token/' && method === 'GET') return page(state.keys.xm)
  if (route === '/api/token/' && method === 'POST') {
    state.keys.xm.push({ ...body, id: state.keys.xm.length + 1, user_id: 7, status: 1, used_quota: 0, created_time: 1_763_000_000,
      accessed_time: 0, key: 'sk-****' })
    return ok(null)
  }
  const reveal = /^\/api\/token\/(\d+)\/key$/.exec(route)
  if (reveal && method === 'POST') return ok({ key: `sk-verify-app-xm-${reveal[1]}-00000000000000000000` })
  if (route === '/v1/models') return { status: 200, payload: { object: 'list', data: models.map((id) => ({ id, object: 'model' })) } }
  return null
}

function answerApi(state, { method, route, body }) {
  const ok = (data) => ({ status: 200, payload: { code: 0, message: 'success', data } })
  const auth = () => ({ access_token: 'verify-app-api-access', refresh_token: 'verify-app-api-refresh', expires_in: 3600,
    token_type: 'Bearer', user: apiUser(state) })
  if (route === '/api/v1/settings/public') return ok({ site_name: 'Verify', turnstile_enabled: false })
  if (route === '/api/v1/auth/login' && method === 'POST') {
    return body.password === loginPassword ? ok(auth()) : { status: 401, payload: { code: 401, message: 'Invalid email or password', data: null } }
  }
  if (route === '/api/v1/auth/refresh') return ok(auth())
  if (route === '/api/v1/auth/me' || route === '/api/v1/user/profile') return ok(apiUser(state))
  if (route === '/api/v1/groups/available') {
    return ok(state.groups.map((name, index) => ({ id: index + 1, name, platform: 'openai', status: 'active', rate_multiplier: 1 })))
  }
  if (route === '/api/v1/announcements') return ok([])
  if (route === '/api/v1/subscriptions' || route === '/api/v1/subscriptions/active') return ok([])
  if (route === '/api/v1/payment/orders') return ok({ items: [], total: 0 })
  if (route === '/api/v1/keys' && method === 'GET') return ok({ items: state.keys.api, total: state.keys.api.length })
  if (route === '/api/v1/keys' && method === 'POST') {
    const key = { ...body, id: state.keys.api.length + 1, user_id: 7, status: 'active', quota: 0, quota_used: 0,
      key: `sk-verify-app-api-${state.keys.api.length + 1}`, created_at: '2026-11-01T00:00:00Z', expires_at: null, last_used_at: null }
    state.keys.api.push(key)
    return ok(key)
  }
  const reveal = /^\/api\/v1\/keys\/(\d+)$/.exec(route)
  if (reveal && method === 'GET') {
    const key = state.keys.api.find((entry) => entry.id === Number(reveal[1]))
    return key ? ok(key) : { status: 404, payload: { code: 404, message: 'not found', data: null } }
  }
  if (route === '/v1/models') return { status: 200, payload: { object: 'list', data: models.map((id) => ({ id, object: 'model' })) } }
  return null
}

// Never answers a generation route: a fixture that pretended to generate would
// hide the real failure path, and nothing in a screenshot run should ask for one.
const generationRoute = /images\/generations|chat\/completions|\/responses|\/messages|\/videos/

function answerAccountRequest(state, { origin, method = 'GET', route, body = {} }) {
  const site = siteOf(origin)
  if (!site || generationRoute.test(route)) return null
  return site === 'xm' ? answerXm(state, { method, route, body }) : answerApi(state, { method, route, body })
}

function boot(config) {
  const electron = require('electron')
  const { app, net, safeStorage, session, shell } = electron
  const crypto = require('node:crypto')
  const os = require('node:os')
  const path = require('node:path')
  const { managedCliKeyProfiles, sub2ApiManagedCliKeyProfiles } = require(config.catalog)
  const groups = [...new Set([...Object.values(managedCliKeyProfiles), ...Object.values(sub2ApiManagedCliKeyProfiles)].map((entry) => entry.group))]
  const state = createFixtureState({ balance: config.balance, groups })
  const calls = []
  const openedExternally = []
  const refused = 'Network unavailable in the verify:app fixture'

  if (path.resolve(os.homedir()) !== path.resolve(config.userHome)) throw new Error('verify:app fixture home isolation failed')
  if (typeof app.setAppPath === 'function') app.setAppPath(config.projectRoot)
  else app.getAppPath = () => config.projectRoot
  // Started from a script, Electron reports its own version (45.x). A customer
  // sees the client's version in the status bar and the version card, and a
  // screenshot meant to stand in for their screen should say the same.
  const clientVersion = require(path.join(config.projectRoot, 'package.json')).version
  app.getVersion = () => clientVersion
  app.setPath('userData', config.userData)
  app.setPath('home', config.userHome)

  // A container has no keyring, and a CI macOS runner would answer with a
  // keychain prompt. The account vault only needs a stable cipher for one run.
  const cipherKey = Buffer.alloc(32, 41)
  safeStorage.isEncryptionAvailable = () => true
  safeStorage.getSelectedStorageBackend = () => 'verify-app-aes'
  safeStorage.encryptString = (plaintext) => {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey, iv)
    const bytes = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), bytes])
  }
  safeStorage.decryptString = (encrypted) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey, encrypted.subarray(0, 12))
    decipher.setAuthTag(encrypted.subarray(12, 28))
    return Buffer.concat([decipher.update(encrypted.subarray(28)), decipher.final()]).toString('utf8')
  }

  function parseBody(body) {
    if (typeof body !== 'string' || body === '') return {}
    try { return JSON.parse(body) } catch { return {} }
  }

  async function fixtureFetch(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url ?? String(input)
    const url = new URL(raw)
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase()
    const record = { origin: url.origin, route: url.pathname, method, outcome: 'refused' }
    calls.push(record)
    if (!siteOf(url.origin)) throw new Error(refused)
    const answer = answerAccountRequest(state, { origin: url.origin, method, route: url.pathname, body: parseBody(init.body) })
    // A generation request (a connection test after a restore, a chat) is
    // withheld on purpose; only an account route the fixture lacks is a gap.
    record.outcome = answer ? 'served' : generationRoute.test(url.pathname) ? 'withheld' : 'unrouted'
    const reply = answer ?? { status: 404, payload: { success: false, message: `verify:app fixture has no route for ${url.pathname}`, data: null } }
    const response = Response.json(reply.payload, { status: reply.status, ...(reply.cookie ? { headers: { 'set-cookie': reply.cookie } } : {}) })
    Object.defineProperty(response, 'url', { value: raw })
    return response
  }

  net.fetch = fixtureFetch
  globalThis.fetch = fixtureFetch

  // Requests that need the redirect itself go through net.request (#1064).
  // Account-site ones get the same answers; Set-Cookie arrives as an array, the
  // way Electron hands it over.
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  net.request = (options) => {
    const target = typeof options === 'string' ? options : options.url
    if (!siteOf(new URL(target).origin)) {
      calls.push({ origin: new URL(target).origin, route: new URL(target).pathname, method: 'GET', outcome: 'refused' })
      throw new Error(refused)
    }
    const request = new EventEmitter()
    const headers = new Headers()
    const chunks = []
    let aborted = false
    request.setHeader = (name, value) => { headers.set(name, value) }
    request.write = (chunk) => { chunks.push(Buffer.from(chunk)) }
    request.abort = () => { aborted = true }
    request.end = () => {
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined
      fixtureFetch(target, { method: (typeof options === 'object' && options.method) || 'GET', headers, body }).then(async (response) => {
        const bytes = Buffer.from(await response.arrayBuffer())
        if (aborted) return
        const head = {}
        for (const [name, value] of response.headers) head[name] = name === 'set-cookie' ? response.headers.getSetCookie() : value
        const message = Object.assign(new PassThrough(), { statusCode: response.status, statusMessage: response.statusText, headers: head })
        request.emit('response', message)
        message.end(bytes)
      }, (error) => { if (!aborted) request.emit('error', error) })
    }
    return request
  }
  for (const protocol of ['node:http', 'node:https']) {
    const transport = require(protocol)
    transport.request = () => { throw new Error(refused) }
    transport.get = () => { throw new Error(refused) }
  }
  // A link the customer would open in their browser is recorded instead, so the
  // report can say where a button leads without a browser popping up.
  shell.openExternal = async (url) => { openedExternally.push(String(url)); return true }

  // Linux refuses to start as root (linux-launch-guard.ts), and a cloud
  // container runs everything as root. Only this fixture may pretend otherwise.
  if (process.platform === 'linux' && typeof process.geteuid === 'function' && process.geteuid() === 0) process.geteuid = () => 1000

  function guardSession(target) {
    // Some writes (managed key sync) use Session.fetch, which does not go through
    // net.request. Account sites get the fixture, everything else is refused.
    target.fetch = (input, init) => fixtureFetch(input, init)
    target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
      calls.push({ origin: new URL(details.url).origin, route: new URL(details.url).pathname, method: details.method, outcome: 'refused' })
      callback({ cancel: true })
    })
  }
  app.on('session-created', guardSession)
  app.whenReady().then(() => guardSession(session.defaultSession))

  globalThis.__verifyApp = {
    calls: () => calls.map((call) => ({ ...call })),
    openedExternally: () => [...openedExternally],
    keyGroups: () => ({ xm: state.keys.xm.map((key) => key.group), api: state.keys.api.length }),
  }
  require(config.entry)
}

// Playwright starts Electron through its own loader, so `require.main` is not
// this module even when Electron was pointed at it. What tells the two uses
// apart is the runtime: Node (the unit tests) only reads the exports below.
if (process.versions.electron && process.type === 'browser') {
  const raw = process.env.XINGMANG_VERIFY_APP_CONFIG
  if (!raw) throw new Error('verify:app fixture started without XINGMANG_VERIFY_APP_CONFIG; run it through npm run verify:app')
  boot(JSON.parse(raw))
}

module.exports = { accountOrigins, answerAccountRequest, createFixtureState, loginAccount, loginPassword, quotaPerUnit, siteOf }
