import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

// Install transports before the real application entry, as realm-account-smoke
// does. Opening AuthFlow reads public account status even without a login.
function bootSignedOutSmoke(config) {
  const { app, net, session, shell } = require('electron')
  app.setAppPath(config.projectRoot)
  app.setPath('home', config.home)
  const calls = []
  function deny(transport) {
    calls.push({ transport, outcome: 'denied' })
    throw new Error('Network unavailable in isolated signed-out smoke')
  }
  const fetchMock = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input))
    const method = init.method ?? 'GET'
    const headers = new Headers(init.headers)
    if (url.origin === 'https://xm.solov.cc' && url.pathname === '/api/status' && method === 'GET'
      && !headers.has('authorization') && !headers.has('cookie') && !headers.has('new-api-user')) {
      calls.push({ transport: 'fetch', route: '/api/status', outcome: 'mocked' })
      const response = Response.json({ success: true, message: '', data: { system_name: 'Isolated smoke',
        version: 'fixture', setup: true, quota_per_unit: 500000, quota_display_type: 'USD',
        usd_exchange_rate: 1, register_enabled: true, password_register_enabled: true,
        email_verification: false, turnstile_check: false } })
      Object.defineProperty(response, 'url', { value: url.href })
      return response
    }
    return deny('fetch')
  }
  net.fetch = fetchMock
  globalThis.fetch = fetchMock
  net.request = () => deny('electron-net')
  shell.openExternal = async () => deny('external-browser')
  for (const protocol of ['node:http', 'node:https']) {
    const transport = require(protocol)
    transport.request = () => deny(protocol)
    transport.get = () => deny(protocol)
  }
  function isolateSession(target) {
    target.fetch = fetchMock
    target.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => {
      calls.push({ transport: 'renderer', outcome: 'denied' })
      callback({ cancel: true })
    })
  }
  app.on('session-created', isolateSession)
  app.whenReady().then(() => isolateSession(session.defaultSession))
  globalThis.__signedOutSmoke = {
    async isolation() {
      if (net.fetch !== fetchMock || globalThis.fetch !== fetchMock || session.defaultSession.fetch !== fetchMock) {
        throw new Error('Smoke network isolation changed')
      }
      const publicStatusRequests = calls.filter((call) => call.outcome === 'mocked').length
      const deniedRequests = calls.filter((call) => call.outcome === 'denied').length
      const deniedTransports = []
      const probes = {
        globalFetch: () => globalThis.fetch('https://isolated.invalid/probe'),
        electronFetch: () => net.fetch('https://isolated.invalid/probe'),
        sessionFetch: () => session.defaultSession.fetch('https://isolated.invalid/probe'),
        electronRequest: () => net.request('https://isolated.invalid/probe'),
        http: () => require('node:http').get('http://isolated.invalid/probe'),
        https: () => require('node:https').request('https://isolated.invalid/probe'),
        externalBrowser: () => shell.openExternal('https://isolated.invalid/probe'),
      }
      for (const [name, probe] of Object.entries(probes)) {
        try { await probe() } catch (error) {
          if (error.message !== 'Network unavailable in isolated signed-out smoke') throw error
          deniedTransports.push(name)
        }
      }
      return { publicStatusRequests, deniedRequests, deniedTransports }
    },
  }
  require(config.entry)
}

export async function withSignedOutSmokeIsolation(options, testRoot) {
  const projectRoot = path.resolve('.')
  const fixtureRoot = path.resolve(testRoot)
  assert.ok(fixtureRoot.startsWith(`${path.join(projectRoot, 'artifacts')}${path.sep}`), 'Smoke launcher must stay inside its fixture directory')
  assert.equal(options.args[0], '.', 'Smoke must launch the compiled application')
  const launcher = path.join(fixtureRoot, 'launcher')
  const metadata = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'))
  await fs.mkdir(launcher, { recursive: true })
  // Electron reads the same application name/version before the wrapper resets
  // appPath to the real project, preserving the original launch metadata.
  await fs.writeFile(path.join(launcher, 'package.json'), JSON.stringify({ name: metadata.name,
    productName: metadata.productName, version: metadata.version, main: 'bootstrap.cjs' }), 'utf8')
  const config = { projectRoot, home: options.env.USERPROFILE ?? options.env.HOME,
    entry: path.join(projectRoot, 'dist-electron/platform/entry.js') }
  await fs.writeFile(path.join(launcher, 'bootstrap.cjs'), `(${bootSignedOutSmoke.toString()})(${JSON.stringify(config)})\n`, 'utf8')
  return { ...options, args: [launcher, ...options.args.slice(1)] }
}

export async function verifySignedOutSmokeIsolation(application) {
  const result = await application.evaluate(() => globalThis.__signedOutSmoke.isolation())
  assert.deepEqual(result.deniedTransports, ['globalFetch', 'electronFetch', 'sessionFetch', 'electronRequest', 'http', 'https', 'externalBrowser'])
  assert.ok(result.publicStatusRequests > 0, 'The login dialog must have read mocked account status')
  return result
}
