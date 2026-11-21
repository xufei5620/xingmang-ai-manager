'use strict'
// 临时探测：按段计时 macOS 开发版首屏，核完就删（不进 main）。
// Times main-process milestones, event-loop stalls and the five bootstrap IPC
// handlers, samples a CPU profile, then hands over to the real entry.
// Shares the probe script's zero so both logs line up on one clock.
const t0 = Number(process.env.PROBE_T0) || Date.now()
const fs = require('node:fs')
function log(event, extra) { const l = `[probe-main] ${Date.now() - t0}ms ${event}${extra ? ' ' + JSON.stringify(extra) : ''}`; try { if (process.env.PROBE_LOG_FILE) fs.appendFileSync(process.env.PROBE_LOG_FILE, l + '\n') } catch {} }
if (process.platform === 'linux' && typeof process.geteuid === 'function' && process.geteuid() === 0) process.geteuid = () => 1000
// PROBE_LAUNCH=dot preloads this file with -r in front of the real '.' launch,
// so the app keeps its own name and keychain item exactly as the test has them.
const preloaded = process.env.PROBE_LAUNCH === 'dot'
const profiling = process.env.PROBE_PROFILE !== '0'
const inspector = require('node:inspector')
const profiler = new inspector.Session()
profiler.connect()
const profileStartedAt = Date.now()
if (profiling) profiler.post('Profiler.enable', () => profiler.post('Profiler.setSamplingInterval', { interval: 500 }, () => profiler.post('Profiler.start')))
const stalls = []
let last = Date.now()
const lag = setInterval(() => {
  const now = Date.now()
  if (now - last > 120) { stalls.push([last, now]); log('stall', { from: last - t0, ms: now - last }) }
  last = now
}, 20)
lag.unref?.()
const { app, ipcMain, session, net: electronNet } = require('electron')
// Keychain reads on macOS are synchronous on this thread; time every call.
const { safeStorage } = require('electron')
for (const name of ['isEncryptionAvailable', 'encryptString', 'decryptString']) {
  const original = safeStorage[name]
  if (typeof original !== 'function') continue
  safeStorage[name] = function (...args) {
    const started = Date.now()
    try { return original.apply(this, args) } finally { log('safeStorage', { name, at: started - t0, ms: Date.now() - started }) }
  }
}
if (!preloaded && process.env.PROBE_APP_PATH) app.setAppPath(process.env.PROBE_APP_PATH)
log('app.identity', { name: app.getName(), preloaded })
const blockedHosts = /(^|\.)solov\.cc$/
const handle = ipcMain.handle.bind(ipcMain)
const interesting = new Set(['settings:get', 'platform:get-capabilities', 'account:get-session', 'update:get-state', 'window:get-capabilities'])
ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
  const started = Date.now()
  try { return await fn(...args) } finally { if (interesting.has(channel) || Date.now() - started > 150) log('handler', { channel, at: started - t0, ms: Date.now() - started }) }
})
// AGENTS.md section 1: no automated run talks to the production account sites.
function guard(ses) {
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (d, cb) => {
    let host = ''
    try { host = new URL(d.url).hostname } catch {}
    // PROBE_NET_DELAY_MS stands in for a slow or stalled production round trip
    // without ever letting the request leave the machine.
    if (blockedHosts.test(host)) { log('net.blocked', { host, path: new URL(d.url).pathname, method: d.method }); setTimeout(() => cb({ cancel: true }), Number(process.env.PROBE_NET_DELAY_MS || 0)); return }
    if (host !== '127.0.0.1') log('net', { host })
    cb({})
  })
}
// PROBE_FAKE_SITES answers the account sites locally, the way
// e2e/verify-app-fixture.cjs does, so the success path runs without production.
const fakeDelay = () => Number(process.env.PROBE_NET_DELAY_MS || 0)
function fakeAnswer(url) {
  const ok = (data) => ({ status: 200, payload: { success: true, message: '', data } })
  if (url.pathname === '/api/status') return ok({ system_name: 'Probe', version: 'probe', setup: true, quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 1, register_enabled: true, password_register_enabled: true, email_verification: false, turnstile_check: false })
  if (url.pathname === '/api/notice') return ok('')
  return { status: 404, payload: { success: false, message: 'Not Found', data: null } }
}
function fakeFetch(original) {
  return async function (input, init) {
    const raw = typeof input === 'string' ? input : input?.url ?? String(input)
    let url = null
    try { url = new URL(raw) } catch {}
    if (!url || !blockedHosts.test(url.hostname)) return original.call(this, input, init)
    log('fake.fetch', { host: url.hostname, path: url.pathname })
    await new Promise((r) => setTimeout(r, fakeDelay()))
    const answer = fakeAnswer(url)
    const response = Response.json(answer.payload, { status: answer.status })
    Object.defineProperty(response, 'url', { value: raw })
    return response
  }
}
if (process.env.PROBE_FAKE_SITES === '1') {
  electronNet.fetch = fakeFetch(electronNet.fetch)
  globalThis.fetch = fakeFetch(globalThis.fetch)
  const fakeSession = (ses) => { ses.fetch = fakeFetch(ses.fetch.bind(ses)) }
  app.on('session-created', fakeSession)
  app.whenReady().then(() => fakeSession(session.defaultSession))
  const originalRequest = electronNet.request.bind(electronNet)
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  electronNet.request = (options) => {
    const target = typeof options === 'string' ? options : options.url
    const url = new URL(target)
    if (!blockedHosts.test(url.hostname)) return originalRequest(options)
    log('fake.request', { host: url.hostname, path: url.pathname })
    const request = new EventEmitter()
    let aborted = false
    request.setHeader = () => undefined
    request.write = () => undefined
    request.abort = () => { aborted = true }
    request.end = () => {
      setTimeout(() => {
        if (aborted) return
        const answer = fakeAnswer(url)
        const bytes = Buffer.from(JSON.stringify(answer.payload))
        const message = Object.assign(new PassThrough(), { statusCode: answer.status, statusMessage: answer.status === 200 ? 'OK' : 'Not Found', headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } })
        request.emit('response', message)
        message.end(bytes)
        log('fake.request.answered', { host: url.hostname, path: url.pathname, status: answer.status })
      }, fakeDelay())
    }
    return request
  }
}
app.on('session-created', guard)
app.on('ready', () => { log('app.ready', { name: app.getName(), appPath: require('node:path').basename(app.getAppPath()) }); guard(session.defaultSession) })
for (const mod of ['node:https', 'node:http']) {
  const m = require(mod); const orig = m.request
  m.request = function (...a) {
    let host = ''
    try { const o = a[0]; host = typeof o === 'string' ? new URL(o).hostname : o instanceof URL ? o.hostname : (o.hostname || o.host || '') } catch {}
    if (blockedHosts.test(host)) { log('node.blocked', { host }); throw new Error('probe: production host refused') }
    return orig.apply(this, a)
  }
}
app.on('browser-window-created', (_e, w) => {
  log('window.created')
  w.webContents.on('did-start-loading', () => log('wc.did-start-loading'))
  w.webContents.on('dom-ready', () => log('wc.dom-ready'))
  w.webContents.on('did-finish-load', () => log('wc.did-finish-load'))
  w.on('show', () => log('window.show'))
  w.on('ready-to-show', () => log('window.ready-to-show'))
})
function summarize() {
  profiler.post('Profiler.stop', (error, result) => {
    if (error || !result) { log('profile.failed', { error: String(error) }); return }
    const { nodes, samples, timeDeltas, startTime } = result.profile
    const byId = new Map(nodes.map((n) => [n.id, n]))
    const parent = new Map()
    for (const n of nodes) for (const c of n.children ?? []) parent.set(c, n.id)
    const t = []
    let acc = startTime
    for (const d of timeDeltas) { acc += d; t.push(acc) }
    // profile clock is µs since an arbitrary origin; align on the first sample ≈ profileStartedAt
    const origin = profileStartedAt - t[0] / 1000
    function frameName(n) { const cf = n.callFrame; const file = (cf.url || '').replace(/^.*\/(dist-electron|node_modules)\//, '$1/'); return `${cf.functionName || '(anon)'} ${file}:${cf.lineNumber + 1}:${cf.columnNumber + 1}` }
    function stackOf(id) { const out = []; let cur = id; while (cur !== undefined && out.length < 40) { const n = byId.get(cur); if (!n) break; out.push(n); cur = parent.get(cur) } return out }
    const self = new Map(); const files = new Map(); const inStall = new Map(); const inStallApp = new Map()
    for (let i = 0; i < samples.length; i++) {
      const n = byId.get(samples[i]); const name = frameName(n)
      if (n.callFrame.functionName === '(idle)' || n.callFrame.functionName === '(program)') continue
      self.set(name, (self.get(name) ?? 0) + 1)
      const file = (n.callFrame.url || '(native)').replace(/^.*\/(dist-electron|node_modules)\//, '$1/')
      files.set(file, (files.get(file) ?? 0) + 1)
      const at = origin + t[i] / 1000
      if (stalls.some(([a, b]) => at >= a && at <= b)) {
        inStall.set(name, (inStall.get(name) ?? 0) + 1)
        const appFrames = stackOf(samples[i]).filter((f) => /dist-electron/.test(f.callFrame.url)).slice(0, 4).map(frameName)
        const key = appFrames.join(' <- ') || '(no app frame)'
        inStallApp.set(key, (inStallApp.get(key) ?? 0) + 1)
      }
    }
    const top = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k)
    const ms = (count) => Math.round(count * 0.5)
    log('profile.window', { ms: Date.now() - profileStartedAt, samples: samples.length })
    for (const [name, c] of top(self, 25)) log('profile.self', { ms: ms(c), name })
    for (const [name, c] of top(files, 20)) log('profile.file', { ms: ms(c), name })
    for (const [name, c] of top(inStall, 20)) log('profile.stall.self', { ms: ms(c), name })
    for (const [name, c] of top(inStallApp, 20)) log('profile.stall.app', { ms: ms(c), name })
  })
}
if (profiling) setTimeout(summarize, Number(process.env.PROBE_PROFILE_MS || 15000)).unref?.()
if (!preloaded) require(process.env.PROBE_REAL_ENTRY)
