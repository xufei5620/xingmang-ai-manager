import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'

// Run after npm run compile. Every network transport is replaced before the
// application entry is loaded; the fixture never contacts either real site.
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-realm-smoke-'))
const userHome = path.join(sandbox, 'home')
const userData = path.join(sandbox, 'user-data')
const bootstrap = path.join(sandbox, 'bootstrap.cjs')
const reviewDirectory = path.join(projectRoot, 'output/realm-account-review')
await fs.mkdir(userHome)
await fs.mkdir(userData)
await fs.mkdir(reviewDirectory, { recursive: true })
await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ version: 2, theme: 'dark',
  checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false, officialProviders: ['claude', 'codex', 'gemini', 'grok'] }), 'utf8')

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
  const fetchMock = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input.url ?? String(input)
    const url = new URL(raw)
    const method = init.method ?? 'GET'
    const route = url.pathname
    const headers = new Headers(init.headers)
    calls.push({ origin: url.origin, route, method })
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    const xm = (data, cookie) => reply(raw, { success: true, message: '', data }, cookie)
    const api = (data) => reply(raw, { code: 0, data })
    if (url.origin === 'https://xm.solov.cc') {
      if (headers.get('authorization')?.includes('fixture-api')) throw new Error('Cross-domain bearer leak')
      if (route === '/api/status') return xm({ system_name: 'Fixture NewAPI', version: 'fixture', setup: true,
        quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 1,
        register_enabled: true, password_register_enabled: true, email_verification: false, turnstile_check: false })
      if (route === '/api/user/login') return body.password === 'fixture-xm-password-123'
        ? xm(xmAuth, 'refresh_token=fixture-xm-cookie; HttpOnly; Path=/') : rejected(raw)
      if (route === '/api/user/auth/refresh') return xm(xmAuth, 'refresh_token=fixture-xm-restored; HttpOnly; Path=/')
      if (route === '/api/user/self') return xm(xmUser)
      if (route === '/api/log/self') return xm({ items: [], total: 0, page: 1, page_size: 20 })
      if (route === '/api/log/self/stat') return xm({ quota: 0, rpm: 0, tpm: 0 })
      if (route === '/api/notice' || route === '/api/user-agreement' || route === '/api/privacy-policy') return xm('Fixture document')
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
      if (route === '/api/v1/auth/login') return body.password === 'fixture-api-password-123' ? api(apiAuth) : rejected(raw, true)
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
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }))
  })
  globalThis.__realmSmoke = {
    stats: () => ({ calls, blocked, groups: { xm: keys.xm.map((key) => key.group),
      api: keys.api.map((key) => groups.find((group) => group.id === key.group_id)?.name) } }),
  }
  require(config.entry)
}

await fs.writeFile(bootstrap, `(${bootFixture.toString()})(${JSON.stringify({ userHome, userData, projectRoot,
  entry: path.join(projectRoot, 'dist-electron/platform/entry.js'), catalog: path.join(projectRoot, 'dist-electron/catalog.js') })})\n`, 'utf8')
const env = { ...process.env, HOME: userHome, USERPROFILE: userHome, APPDATA: path.join(sandbox, 'appdata'),
  LOCALAPPDATA: path.join(sandbox, 'local-appdata'), XINGMANG_RENDERER: '', VITE_DEV_SERVER_URL: '',
  XINGMANG_CODEX_HOME_OVERRIDE: path.join(userHome, '.codex'), XINGMANG_DISABLE_SINGLE_INSTANCE: '1', NODE_OPTIONS: '' }
delete env.ELECTRON_RUN_AS_NODE
let application
const errors = []
let stderr = ''
let stage = 'initial startup'
async function start() {
  application = await electron.launch({ cwd: projectRoot, args: [bootstrap, `--user-data-dir=${userData}`], env })
  application.process().stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-64000) })
  const page = await application.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() => Boolean(window.xingmang), { timeout: 30000 })
  assert.equal(path.resolve(await application.evaluate(({ app }) => app.getPath('userData'))), path.resolve(userData))
  await page.evaluate(() => window.xingmang.getAccountSession())
  return page
}
async function stop() {
  await application?.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
  await application?.close().catch(() => undefined)
  application = undefined
}
async function assertCustomerUi(page) {
  assert.doesNotMatch(await page.locator('body').innerText(), /new[ -]?api|sub2api|xm\.solov\.cc|api\.solov\.cc/i)
}
async function openLoginWithUi(page) {
  await page.getByRole('button', { name: '登录', exact: true }).click({ timeout: 30000 })
  const dialog = page.getByTestId('login-dialog')
  const accountLogin = page.getByRole('button', { name: '登录账号', exact: true })
  await dialog.or(accountLogin).first().waitFor({ state: 'visible' })
  if (!await dialog.isVisible()) await accountLogin.click()
}
async function loginWithUi(page, siteId) {
  await expect(page.getByTestId('login-site')).toHaveCount(0)
  await page.getByTestId('login-account').fill('same@example.test')
  await page.getByTestId('login-password').fill(siteId === 'solov' ? 'fixture-xm-password-123' : 'fixture-api-password-123')
  await page.getByTestId('login-remember').check()
  await page.getByTestId('auth-agree').check()
  await assertCustomerUi(page)
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith('xingmang://app/'))
    window?.show()
    window?.focus()
  })
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const capture = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith('xingmang://app/'))
    if (!window) throw new Error('Main fixture window is unavailable')
    return (await window.capturePage()).toPNG().toString('base64')
  })
  await fs.writeFile(path.join(reviewDirectory, `login-${siteId}.png`), Buffer.from(capture, 'base64'))
  await page.getByTestId('login-submit').click()
  await page.getByTestId('login-dialog').waitFor({ state: 'hidden', timeout: 30000 })
  await expect.poll(() => page.evaluate(() => window.xingmang.getAccountSession())).toMatchObject({ authenticated: true, siteId, account: { userId: 7 } })
  if (await page.getByTestId('guide-pause').count()) await page.getByTestId('guide-pause').click({ timeout: 60000 })
  await page.getByRole('button', { name: '切换账号', exact: true }).waitFor({ timeout: 30000 })
  // The UI performs the first sync; explicitly repeating it checks reuse.
  const synchronized = await page.evaluate(() => window.xingmang.syncManagedCliKeys())
  assert.deepEqual(synchronized.failed, [])
  assert.equal(synchronized.storageWarning, undefined)
  const profile = await page.evaluate(() => window.xingmang.getAccountProfile())
  assert.equal(profile.userId, 7)
  assert.equal(profile.email, 'same@example.test')
  const balance = await page.evaluate(() => window.xingmang.getAccountBalance())
  assert.equal(balance.displayAmount, 100)
  assert.equal(balance.quotaPerUnit, siteId === 'solov' ? 500000 : 1)
  await assertCustomerUi(page)
}
async function switchWithUi(page, origin) {
  const accounts = await page.evaluate(() => window.xingmang.listSavedAccounts())
  const target = accounts.find((account) => account.origin === origin)
  assert.ok(target)
  await page.getByRole('button', { name: '切换账号', exact: true }).click()
  await assertCustomerUi(page)
  const row = page.getByTestId('saved-accounts-list').locator('.xm-list-row').filter({ hasText: `账户尾号 ${target.id.slice(-6)}` })
  await row.getByRole('button', { name: '切换', exact: true }).click()
  await page.getByTestId('saved-accounts-list').waitFor({ state: 'hidden', timeout: 30000 })
}

try {
  let page = await start()
  stage = 'new-api UI login'
  await openLoginWithUi(page)
  await loginWithUi(page, 'solov')
  stage = 'open an existing canvas before switching accounts'
  const canvasOpened = application.waitForEvent('window')
  await page.evaluate(() => window.xingmang.openCanvasWindow())
  const canvas = await canvasOpened
  await canvas.waitForURL('xingmang-canvas://app/**')
  await canvas.waitForFunction(() => Boolean(window.xingmangCanvasHost))
  await canvas.evaluate(() => {
    window.__realmEvents = []
    window.xingmangCanvasHost.onAccountChange((event) => window.__realmEvents.push(event))
  })
  stage = 'sub2api UI login'
  await page.getByRole('button', { name: '切换账号', exact: true }).click()
  await page.getByTestId('account-add').click()
  await loginWithUi(page, 'solov-api')
  const automaticLoginCalls = await application.evaluate(() => globalThis.__realmSmoke.stats().calls.filter((call) => call.route.endsWith('/login')))
  assert.deepEqual(automaticLoginCalls.map((call) => call.origin), ['https://xm.solov.cc', 'https://xm.solov.cc', 'https://api.solov.cc'])
  await expect.poll(() => canvas.evaluate(() => window.__realmEvents.at(-1))).toMatchObject({ siteId: 'solov-api', userId: 7 })
  const canvasGroups = await canvas.evaluate(() => window.xingmangCanvasHost.listGroups())
  assert.ok(canvasGroups.some((group) => group.name === 'Codex_pro'))
  const summaries = await page.evaluate(() => window.xingmang.listSavedAccounts())
  assert.equal(summaries.length, 2)
  assert.equal(new Set(summaries.map((entry) => entry.id)).size, 2)
  assert.ok(summaries.every((entry) => entry.userId === 7))
  assert.doesNotMatch(JSON.stringify(summaries), /fixture-(xm|api)|cookie|accessToken|refreshToken/)
  stage = 'saved account UI switching'
  await switchWithUi(page, 'https://xm.solov.cc')
  assert.equal((await page.evaluate(() => window.xingmang.getAccountSession())).siteId, 'solov')
  assert.equal(await page.evaluate(async () => {
    const remembered = await window.xingmang.getRememberedAccountLogin()
    return remembered?.identifier === 'same@example.test' && remembered.password === 'fixture-api-password-123'
  }), true, 'Remembered login must follow the last successful input rather than the currently viewed account')
  await expect.poll(() => canvas.evaluate(() => window.__realmEvents.at(-1))).toMatchObject({ siteId: 'solov', userId: 7 })
  await switchWithUi(page, 'https://api.solov.cc')
  assert.equal((await page.evaluate(() => window.xingmang.getAccountSession())).siteId, 'solov-api')
  await expect.poll(() => canvas.evaluate(() => window.__realmEvents.at(-1))).toMatchObject({ siteId: 'solov-api', userId: 7 })
  const stats = await application.evaluate(() => globalThis.__realmSmoke.stats())
  assert.deepEqual(new Set(stats.groups.api), new Set(['Codex_pro', 'Claude-MAX(不限客户端)', 'Gemini', 'grok-heavy']))
  assert.equal(stats.groups.api.length, 4)
  assert.equal(stats.groups.xm.length, 4)
  assert.ok(stats.calls.every((call) => !/images\/generations|chat\/completions|\/responses|\/videos/.test(call.route)))
  await fs.access(path.join(userData, 'managed-cli-keys.dat'))
  await fs.access(path.join(userData, 'realms/api-account/managed-cli-keys.dat'))
  stage = 'restart with sub2api active'
  await stop()
  page = await start()
  assert.equal((await page.evaluate(() => window.xingmang.getAccountSession())).siteId, 'solov-api')
  assert.equal((await page.evaluate(() => window.xingmang.listSavedAccounts())).length, 2)
  stage = 'logout and restart'
  await page.evaluate(() => window.xingmang.logoutAccount())
  await stop()
  page = await start()
  assert.equal((await page.evaluate(() => window.xingmang.getAccountSession())).authenticated, false)
  const afterLogout = await page.evaluate(() => window.xingmang.listSavedAccounts())
  assert.equal(afterLogout.length, 1)
  assert.equal(afterLogout[0].origin, 'https://xm.solov.cc')
  stage = 'preferred backend after logout and restart'
  await openLoginWithUi(page)
  await expect.poll(() => page.getByTestId('login-password').inputValue().then((value) => value === 'fixture-api-password-123')).toBe(true)
  await expect(page.getByTestId('login-remember')).toBeChecked()
  await loginWithUi(page, 'solov-api')
  const preferredLoginCalls = await application.evaluate(() => globalThis.__realmSmoke.stats().calls.filter((call) => call.route.endsWith('/login')))
  assert.deepEqual(preferredLoginCalls.map((call) => call.origin), ['https://api.solov.cc'])
  await page.evaluate(() => window.xingmang.logoutAccount())
  assert.deepEqual(errors, [])
  const result = { dualRealmLogin: true, automaticDetection: true, rememberedRouting: true, lastSuccessPreference: true, platformDetailsHidden: true,
    savedSwitch: true, keyStoresSeparated: true,
    canvasRealmEvents: true, restoreAndLogout: true, actualNetworkRequests: 0, generatedContent: false }
  await fs.writeFile(path.join(reviewDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify(result))
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
