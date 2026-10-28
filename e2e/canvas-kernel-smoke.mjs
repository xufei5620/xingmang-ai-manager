import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { collectedPromiseAttempts, collectedPromiseBackoffFor, fixtureReadyTimeoutMs, mainProcessCallInOwnTask } from './fixture-readiness.mjs'
import { createSmokeRuntime } from './smoke-runtime.mjs'

// D-PR3（#1393）：画布换成 xingmang-canvas 内核以后，用真的 Electron、真的 xingmang-canvas:// 和打包用的
// dist-canvas 把内核在桌面上走一遍。旧画布在真机上出过的故障、#1489 审查里新内核修掉的那几条，每条一个断言。
//
// Run after npm run compile. Every network transport the main process has is
// replaced before the application entry loads, exactly as realm-account-smoke
// does it, plus Session#fetch, which is how main.ts reaches the relay for a
// generation (chromiumSessionFetch). The fixture answers the account site and
// the relay; the one image it "generates" is a 64 x 64 PNG built below, so the
// run spends nothing anywhere.
//
// Windows only: the Linux canvas refuses to open unless the renderer runs
// inside the seccomp sandbox (linux-renderer-sandbox.ts), and an Electron
// driven by Playwright on a Linux runner does not, so the gate would rightly
// refuse it. macOS-test is already the longest job in the matrix.
if (process.platform !== 'win32') {
  console.log('SKIP: Windows canvas kernel smoke')
  process.exit(0)
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reviewDirectory = path.join(projectRoot, 'output/canvas-kernel-review')
const resultPath = path.join(reviewDirectory, 'result.json')

const { stepBudgetMs, progress, withDeadline, trackProcessIds, releaseProcessIds, attachEvidence, run } = createSmokeRuntime({
  name: 'canvas-kernel-smoke',
  stepBudgetMs: Number(process.env.XINGMANG_SMOKE_STEP_TIMEOUT_MS ?? 90_000),
  // One cold start, three canvas windows and two dozen editor steps: about 20s
  // on a Linux container. A Windows runner needs ~16s for the start alone and
  // opens every canvas window cold, so this leaves room for a slow runner and
  // still names the stuck step well before the step timeout does.
  totalBudgetMs: Number(process.env.XINGMANG_SMOKE_TOTAL_TIMEOUT_MS ?? 300_000),
})
attachEvidence(resultPath)

function bootFixture(config) {
  const { app, dialog, net, safeStorage, session, shell } = require('electron')
  const { createCipheriv, createDecipheriv, randomBytes } = require('node:crypto')
  const nodeFs = require('node:fs')
  const nodePath = require('node:path')
  const { managedCliKeyProfiles } = require(config.catalog)
  if (nodePath.resolve(require('node:os').homedir()) !== nodePath.resolve(config.userHome)) throw new Error('Fixture home isolation failed')
  if (typeof app.setAppPath === 'function') app.setAppPath(config.projectRoot)
  else app.getAppPath = () => config.projectRoot
  app.setPath('userData', config.userData)
  app.setPath('home', config.userHome)
  const cipherKey = Buffer.alloc(32, 29)
  safeStorage.isEncryptionAvailable = () => true
  safeStorage.getSelectedStorageBackend = () => 'canvas-smoke-aes'
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
  const keys = []
  const generations = []
  const heldGenerations = []
  let holdGenerations = false
  const user = { id: 7, username: 'canvas@example.test', email: 'canvas@example.test', display_name: 'Canvas Fixture',
    group: 'default', role: 1, status: 1, quota: 50000000, used_quota: 0, request_count: 0,
    aff_code: '', aff_count: 0, aff_quota: 0, aff_history_quota: 0 }
  const auth = { access_token: 'fixture-canvas-access', access_expires_at: null, user }
  // 每个分组真正开出来的型号：生图只在 GPT-image2 里有。画布默认挑的分组如果不对，这次运行就会用错分组的密钥，
  // 下面按密钥认出分组再和界面上选的比。
  const groupModels = { 'GPT-image2': ['gpt-image-2'], Gemini: ['gemini-3.7-flash'], GPT: ['gpt-5.6-sol'],
    'Claude-MAX': ['claude-opus-4-7'], Grok: ['grok-4'] }
  const groupNames = [...new Set([...Object.values(managedCliKeyProfiles).map((entry) => entry.group), 'GPT-image2'])]
  function reply(url, payload, init) {
    const response = Response.json(payload, init)
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
  function deny(origin, route) {
    blocked.push({ origin, route })
    throw new Error('Network unavailable in isolated canvas fixture')
  }
  const origins = ['https://xm-direct.solov.cc', 'https://xm.solov.cc']
  async function serveRequest(raw, init) {
    const url = new URL(raw)
    const method = init.method ?? 'GET'
    const route = url.pathname
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
    const ok = (data, cookie) => reply(raw, { success: true, message: '', data }, cookie ? { headers: { 'set-cookie': cookie } } : undefined)
    if (!origins.includes(url.origin)) return deny(url.origin, route)
    if (route === '/api/status') return ok({ system_name: 'Fixture NewAPI', version: 'fixture', setup: true,
      quota_per_unit: 500000, quota_display_type: 'USD', usd_exchange_rate: 1,
      register_enabled: true, password_register_enabled: true, email_verification: false, turnstile_check: false })
    if (route === '/api/user/login') return body.password === 'fixture-canvas-password-123'
      ? ok(auth, 'refresh_token=fixture-canvas-cookie; HttpOnly; Path=/')
      : reply(raw, { success: false, message: '用户名或密码错误', data: null }, { status: 401 })
    if (route === '/api/user/auth/refresh') return ok(auth, 'refresh_token=fixture-canvas-cookie; HttpOnly; Path=/')
    if (route === '/api/user/auth/logout' && method === 'POST') return ok(null)
    if (route === '/api/user/self') return ok(user)
    if (route === '/api/log/self') return ok({ items: [], total: 0, page: 1, page_size: 20 })
    if (route === '/api/log/self/stat') return ok({ quota: 0, rpm: 0, tpm: 0 })
    if (route === '/api/notice' || route === '/api/user-agreement' || route === '/api/privacy-policy') return ok('Fixture document')
    // 主窗口登录后的首页：用量看板和订阅。
    if (route === '/api/data/self') return ok([])
    if (route === '/api/subscription/self') return ok({ billing_preference: 'subscription_first', subscriptions: [], all_subscriptions: [] })
    if (route === '/api/user/self/groups') return ok(Object.fromEntries(groupNames.map((group) => [group, { desc: group, ratio: 1 }])))
    if (route === '/api/user/models') return ok(groupModels[url.searchParams.get('group')] ?? [])
    if (route === '/api/token/' && method === 'GET') return ok({ items: keys, total: keys.length })
    if (route === '/api/token/' && method === 'POST') {
      keys.push({ ...body, id: keys.length + 1, user_id: 7, status: 1, used_quota: 0, created_time: 1700000000, accessed_time: 0, key: 'masked' })
      return ok(null)
    }
    const reveal = route.match(/^\/api\/token\/(\d+)\/key$/)
    if (reveal && method === 'POST') return ok({ key: `sk-fixture-canvas-${reveal[1]}` })
    // 中转那一半：按 Authorization 里的密钥认出它建在哪个分组。
    const keyGroup = keys.find((key) => headers.get('authorization') === `Bearer sk-fixture-canvas-${key.id}`)?.group ?? null
    if (route === '/v1/models') return reply(raw, { object: 'list', data: (groupModels[keyGroup] ?? []).map((id) => ({ id, object: 'model' })) })
    if (route === '/v1/images/generations') {
      const generation = { route, group: keyGroup, model: body.model, prompt: body.prompt, held: holdGenerations, answered: false }
      generations.push(generation)
      if (holdGenerations) await new Promise((resolve) => heldGenerations.push(resolve))
      generation.answered = true
      return reply(raw, { created: 1700000000, data: [{ b64_json: config.png }] })
    }
    return deny(url.origin, route)
  }
  // Each request records how it ended, so a route that stops being mocked has to
  // surface as a refusal rather than still counting as one the fixture answered.
  const fetchMock = async (input, init = {}) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url ?? String(input)
    const url = new URL(raw)
    const record = { origin: url.origin, route: url.pathname, method: init.method ?? 'GET', outcome: 'denied' }
    calls.push(record)
    const response = await serveRequest(raw, init)
    record.outcome = 'served'
    return response
  }
  net.fetch = fetchMock
  globalThis.fetch = fetchMock
  const { EventEmitter } = require('node:events')
  const { PassThrough } = require('node:stream')
  net.request = (options) => {
    const target = typeof options === 'string' ? options : options.url
    if (!origins.includes(new URL(target).origin)) return deny('electron-net', new URL(target).origin)
    const request = new EventEmitter()
    const headers = new Headers()
    const chunks = []
    let aborted = false
    request.setHeader = (name, value) => { headers.set(name, value) }
    request.write = (chunk) => { chunks.push(Buffer.from(chunk)) }
    request.abort = () => { aborted = true }
    request.end = () => {
      const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined
      fetchMock(target, { method: options.method ?? 'GET', headers, body }).then(async (response) => {
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
  shell.openExternal = async () => deny('external-browser', 'open')
  for (const protocol of ['node:http', 'node:https']) {
    const transport = require(protocol)
    transport.request = () => deny(protocol, 'request')
    transport.get = () => deny(protocol, 'get')
  }
  // 画布里所有「保存到哪里」「选哪个文件夹」都是主进程弹的系统对话框（星芒自己的保存框）。这里记下每一次，
  // 选文件夹照下面排好的答，其余一律当用户点了取消。
  const dialogs = []
  const dialogAnswers = []
  for (const name of ['showOpenDialog', 'showSaveDialog', 'showMessageBox']) {
    dialog[name] = async (...args) => {
      const options = args.find((arg) => arg && typeof arg === 'object' && typeof arg.webContents !== 'object') ?? {}
      dialogs.push({ name, title: options.title ?? null })
      const answer = name === 'showOpenDialog' ? dialogAnswers.shift() : undefined
      if (answer) return answer
      return name === 'showMessageBox' ? { response: options.cancelId ?? 0, checkboxChecked: false } : { canceled: true, filePaths: [] }
    }
  }
  // Chromium's own download path ends in its own "Save as" dialog, which the
  // canvas window must never reach (#1393 1a cancels it there). Every session
  // the application creates is watched, not only the default one.
  const downloads = []
  function watchDownloads(target) {
    target.on('will-download', (_event, item) => downloads.push(item.getFilename()))
  }
  app.on('session-created', watchDownloads)
  app.whenReady().then(() => {
    // main.ts reaches the relay through Session#fetch (chromiumSessionFetch), and
    // Electron builds that request on net.request, which is replaced above.
    Object.getPrototypeOf(session.defaultSession).fetch = function sessionFetch(input, init) { return fetchMock(input, init) }
    watchDownloads(session.defaultSession)
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      rendererBlocked.push(new URL(details.url).origin)
      callback({ cancel: true })
    })
  })
  function projectsRoot() {
    const pending = [config.userData]
    while (pending.length) {
      const directory = pending.pop()
      for (const entry of nodeFs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = nodePath.join(directory, entry.name)
        if (entry.name === 'canvas-projects') return nodePath.join(candidate, 'user-7')
        pending.push(candidate)
      }
    }
    throw new Error('canvas-projects directory not found')
  }
  function storedProjects() {
    const root = projectsRoot()
    return nodeFs.readdirSync(root).filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(nodeFs.readFileSync(nodePath.join(root, name), 'utf8')))
  }
  globalThis.__canvasSmoke = {
    isolation: async () => {
      const denied = []
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
          if (error.message !== 'Network unavailable in isolated canvas fixture') throw error
          denied.push(name)
        }
      }
      return { denied, home: require('node:os').homedir(), userData: app.getPath('userData') }
    },
    chooseFolder: (name) => {
      const folder = nodePath.join(config.userHome, 'canvas-work', name)
      nodeFs.mkdirSync(folder, { recursive: true })
      dialogAnswers.push({ canceled: false, filePaths: [folder] })
      return folder
    },
    holdGenerations: (value) => { holdGenerations = value },
    releaseGenerations: () => {
      const count = heldGenerations.length
      for (const resolve of heldGenerations.splice(0)) resolve()
      return count
    },
    storedWorkflow: (name) => {
      const project = storedProjects().find((entry) => entry.workflow?.name === name)
      return project ? JSON.stringify(project.workflow) : null
    },
    // 0.2.22 及更早的旧画布存的工程：第 2 版工作流格式（schemaVersion 2），图存在工程自己的工作文件夹里。
    // 照旧画布 workflow-serializer 的写法拼一份，素材从刚才真实生成过的工程里拷过去，再交给新内核打开。
    writeLegacyProject: ({ sourceName, name, prompt }) => {
      const source = storedProjects().find((entry) => entry.workflow?.name === sourceName)
      if (!source?.workspaceDirectory) throw new Error(`stored project ${sourceName} not found`)
      const image = source.workflow.nodes.find((node) => node.data?.result?.kind === 'image' && node.data.result.assetId)
      if (!image) throw new Error(`stored project ${sourceName} has no generated image`)
      const workspace = nodePath.join(config.userHome, 'canvas-work', 'legacy')
      nodeFs.cpSync(nodePath.join(source.workspaceDirectory, 'assets'), nodePath.join(workspace, 'assets'), { recursive: true })
      const assetId = image.data.result.assetId
      const now = new Date(Date.now() - 86_400_000).toISOString()
      const id = require('node:crypto').randomUUID()
      const workflow = {
        schemaVersion: 2,
        name,
        viewport: { x: 0, y: 0, zoom: 1 },
        mediaGroups: { image: 'GPT-image2', imageModel: 'gpt-image-2' },
        nodes: [
          { id: 'legacy-prompt', kind: 'prompt', definitionVersion: 1, position: { x: 80, y: 120 }, data: { prompt, model: '' } },
          { id: 'legacy-image', kind: 'image-generate', definitionVersion: 1, position: { x: 480, y: 120 },
            data: { prompt: '', model: 'gpt-image-2', group: 'GPT-image2', imageResolution: '1K', size: '1024x1024',
              result: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', width: 64, height: 64 } } },
        ],
        edges: [{ id: 'legacy-edge', source: 'legacy-prompt', sourceHandle: 'out:text', target: 'legacy-image', targetHandle: 'in:text' }],
      }
      // 项目中心读不进的工程直接不列出来，不报原因；这里先用桌面自己的解析过一遍，读不进时把原因说出来。
      require(nodePath.join(config.projectRoot, 'dist-electron', 'canvas-project-package.js')).parseCanvasProjectWorkflow(JSON.stringify(workflow))
      nodeFs.writeFileSync(nodePath.join(projectsRoot(), `${id}.json`), JSON.stringify({ id, createdAt: now, updatedAt: now,
        lastOpenedAt: now, workspaceDirectory: workspace, workflow }, null, 2))
      return id
    },
    stats: () => ({ calls, blocked, rendererBlocked, generations, dialogs, downloads,
      keyGroups: keys.map((key) => key.group) }),
  }
  require(config.entry)
}

// A 64 x 64 opaque PNG, built here so the fixture never reads an image from disk.
function fixturePng(width, height, rgb) {
  function chunk(type, data) {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width * 3 }, (_, index) => rgb[index % 3]))])
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
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
let currentCanvas
const pageErrors = []
const passedAssertions = []

const expectedAssertions = [
  // 新节点和云端入口在桌面上看不到；状态栏不出现「视频 · 图片模型」；出图分辨率里有 2K、4K。
  'desktop-entries-only', 'status-bar-labels', 'image-resolutions',
  // 提示词＋图片两节点一起运行不被拒；运行用的是界面上选的那个分组；生成的图能显示。
  'multi-node-run-accepted', 'run-uses-chosen-group', 'generated-image-displays',
  // 便签写 1 万字以上、以网址开头、写 TODO: 都能存；预设名 160 字能存。
  'long-note-saved', 'note-text-survives-reopen', 'long-preset-name',
  // 点画布里的导出、另存都走星芒自己的保存框，不弹 Chromium 的另存为。
  'no-browser-download',
  // 编辑后自动保存再关窗；小地图、专注模式的开关重开还在（O15）。
  'autosave-then-close', 'view-toggles-survive-reopen',
  // 另存副本带着内容和素材；在 A 出图时切到 A 的副本，副本不显示「生成中」（F02）；生成时改过提示词，结果出来标「待更新」（O13）。
  'copy-carries-content', 'copy-ignores-source-run', 'stale-after-edit-during-run',
  // 开 A、回项目中心、开 B，按 Ctrl+Z 不串到 A（D01）；只开一个项目按 Ctrl+Z 不清空。
  'undo-stays-in-project', 'undo-keeps-opened-project',
  // 0.2.22 及更早的旧画布存的工程能打开，图能显示。
  'legacy-project-opens',
]

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
  await fs.access(path.join(projectRoot, 'dist-canvas', 'index.html'))
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'xingmang-canvas-smoke-'))
  userHome = path.join(sandbox, 'home')
  userData = path.join(sandbox, 'user-data')
  bootstrap = path.join(sandbox, 'bootstrap.cjs')
  await fs.mkdir(userHome)
  await fs.mkdir(userData)
  await fs.rm(reviewDirectory, { recursive: true, force: true })
  await fs.mkdir(reviewDirectory, { recursive: true })
  await fs.writeFile(path.join(userData, 'settings.json'), JSON.stringify({ version: 2, theme: 'light',
    checkUpdatesOnStartup: false, runDiagnosticsOnStartup: false, crashReportingNoticeShown: true, usageStatsNoticeShown: true,
    officialProviders: ['claude', 'codex', 'gemini', 'grok'] }), 'utf8')
  await fs.writeFile(bootstrap, `(${bootFixture.toString()})(${JSON.stringify({ userHome, userData, projectRoot,
    png: fixturePng(64, 64, [30, 140, 120]).toString('base64'),
    entry: path.join(projectRoot, 'dist-electron/platform/entry.js'), catalog: path.join(projectRoot, 'dist-electron/catalog.js') })})\n`, 'utf8')
  env = { ...process.env, HOME: userHome, USERPROFILE: userHome, APPDATA: path.join(sandbox, 'appdata'),
    LOCALAPPDATA: path.join(sandbox, 'local-appdata'), XINGMANG_RENDERER: '', VITE_DEV_SERVER_URL: '',
    XINGMANG_CODEX_HOME_OVERRIDE: path.join(userHome, '.codex'), XINGMANG_DISABLE_SINGLE_INSTANCE: '1', NODE_OPTIONS: '',
    XINGMANG_ONBOARDING_PREVIEW: '', XINGMANG_DASHBOARD_PREVIEW: '', XINGMANG_UPDATE_DEV: '' }
  delete env.ELECTRON_RUN_AS_NODE
}

// Same reasoning as realm-account-smoke: the inspector's promise wrapper can be
// collected while the main process is busy, and every call routed through here
// only reads fixture state or files, so replaying one changes nothing.
async function evaluateInMainProcess(label, body, argument) {
  let collected
  let backedOffMs = 0
  for (let attempt = 1; attempt <= collectedPromiseAttempts; attempt += 1) {
    try {
      return await withDeadline(`${label} (attempt ${attempt}/${collectedPromiseAttempts})`, stepBudgetMs,
        () => application.evaluate(mainProcessCallInOwnTask, { source: String(body), argument }))
    }
    catch (error) {
      if (!/Resulting promise was garbage collected/.test(String(error?.message))) throw error
      collected = error
      if (attempt === collectedPromiseAttempts) break
      const backoffMs = collectedPromiseBackoffFor(attempt)
      progress(`${label}: the inspector promise was collected on attempt ${attempt}/${collectedPromiseAttempts}, retrying in ${backoffMs}ms`)
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
  return evaluateInMainProcess('fixture statistics', () => globalThis.__canvasSmoke.stats())
}

function storedWorkflow(name) {
  return evaluateInMainProcess(`stored workflow of ${name}`, (_electron, projectName) => globalThis.__canvasSmoke.storedWorkflow(projectName), name)
}

async function start() {
  progress('launching the isolated fixture application')
  application = await withDeadline('Electron launch', stepBudgetMs, () => electron.launch({
    cwd: projectRoot, args: [bootstrap, `--user-data-dir=${userData}`], env, timeout: stepBudgetMs }))
  currentProcessId = application.process().pid
  if (currentProcessId) trackProcessIds([currentProcessId])
  application.process().stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-64000) })
  progress('waiting for the first window')
  const page = await withDeadline('first window', stepBudgetMs, () => application.firstWindow({ timeout: stepBudgetMs }))
  await withDeadline('preload bridge', fixtureReadyTimeoutMs,
    () => page.waitForFunction(() => Boolean(window.xingmang), { timeout: fixtureReadyTimeoutMs }))
  const isolated = await evaluateInMainProcess('network isolation probes', () => globalThis.__canvasSmoke.isolation())
  assert.deepEqual(isolated.denied, ['globalFetch', 'electronFetch', 'sessionFetch', 'electronRequest', 'http', 'https', 'externalBrowser'])
  assert.equal(path.resolve(isolated.home), path.resolve(userHome))
  assert.equal(path.resolve(isolated.userData), path.resolve(userData))
  // The account UI has its own smoke (realm-account-smoke); the canvas only
  // needs a signed-in session behind it.
  const login = await evaluateInRenderer(page, 'account login', () => window.xingmang.loginAccount({
    username: 'canvas@example.test', password: 'fixture-canvas-password-123', siteId: 'solov' }))
  assert.equal(login.account.userId, 7)
  return page
}

async function stop() {
  if (!application) return
  progress(`shutting down after ${stage}`)
  await withDeadline('main process exit', stepBudgetMs, () => application.evaluate(({ app }) => app.exit(0))).catch(() => undefined)
  await withDeadline('close', 20_000, () => application.close()).catch(() => undefined)
  if (currentProcessId) releaseProcessIds([currentProcessId])
  application = undefined
}

async function openCanvas(page) {
  const opened = application.waitForEvent('window', { timeout: stepBudgetMs })
  await evaluateInRenderer(page, 'open the canvas window', () => window.xingmang.openCanvasWindow())
  const canvas = await withDeadline('canvas window', stepBudgetMs, () => opened)
  canvas.on('pageerror', (error) => pageErrors.push(error.message))
  await withDeadline('canvas url', fixtureReadyTimeoutMs, () => canvas.waitForURL('xingmang-canvas://app/**', { timeout: fixtureReadyTimeoutMs }))
  await withDeadline('canvas host bridge', fixtureReadyTimeoutMs,
    () => canvas.waitForFunction(() => Boolean(window.xingmangCanvasHost), { timeout: fixtureReadyTimeoutMs }))
  await canvas.getByRole('button', { name: '新建项目' }).first().waitFor({ timeout: fixtureReadyTimeoutMs })
  currentCanvas = canvas
  return canvas
}

async function closeCanvas(canvas) {
  const closed = new Promise((resolve) => canvas.once('close', resolve))
  await evaluateInMainProcess('close the canvas window', ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.getURL().startsWith('xingmang-canvas://'))
    if (!window) throw new Error('canvas window is not open')
    setTimeout(() => { if (!window.isDestroyed()) window.close() }, 0)
  })
  await withDeadline('canvas window closed', stepBudgetMs, () => closed)
}

// Screenshots and the accessibility tree land in output/canvas-kernel-review, which the CI job uploads,
// so a red run can be read without reproducing it.
async function capture(canvas, name) {
  await canvas.screenshot({ path: path.join(reviewDirectory, `${name}.png`) }).catch(() => undefined)
  const tree = await canvas.locator('body').ariaSnapshot().catch(() => '')
  await fs.writeFile(path.join(reviewDirectory, `${name}.aria.yml`), tree, 'utf8')
}

async function createProject(canvas, name, folder) {
  await canvas.getByRole('button', { name: '新建项目' }).first().click()
  await canvas.getByRole('textbox', { name: '项目名称' }).fill(name)
  await evaluateInMainProcess('answer the folder dialog', (_electron, value) => globalThis.__canvasSmoke.chooseFolder(value), folder)
  await canvas.getByRole('button', { name: '选择文件夹并创建' }).click()
  await canvas.getByRole('button', { name: `重命名项目：${name}`, exact: true }).waitFor({ timeout: fixtureReadyTimeoutMs })
}

async function openProject(canvas, name) {
  await canvas.getByRole('button', { name: `打开项目：${name}`, exact: true }).click()
  await canvas.getByRole('button', { name: `重命名项目：${name}`, exact: true }).waitFor({ timeout: fixtureReadyTimeoutMs })
  // The editor mounts its nodes after the project document arrives.
  await canvas.locator('.react-flow__renderer').waitFor({ timeout: fixtureReadyTimeoutMs })
}

async function backToCenter(canvas) {
  await canvas.getByRole('button', { name: '返回项目中心' }).click()
  await canvas.getByRole('button', { name: '新建项目' }).first().waitFor({ timeout: fixtureReadyTimeoutMs })
}

function nodes(canvas) {
  return canvas.locator('.react-flow__node')
}

async function clearSelection(canvas) {
  await canvas.locator('.react-flow__pane').click({ position: { x: 24, y: 24 } })
}

function libraryTab(canvas, name) {
  return canvas.getByRole('navigation', { name: '创作库类型' }).getByRole('button', { name, exact: true })
}

// 画布窗口窄于 1180px 时（Windows CI 机器的屏幕只有 1024 x 768），检查器开着会把创作库压成一条图标栏，
// 栏上的页签点了也展不开；照用户的做法先把检查器关掉。
async function closeInspector(canvas) {
  const inspector = canvas.getByRole('complementary', { name: '统一检查器' })
  if (await inspector.isVisible()) await inspector.getByRole('button', { name: /^关闭(节点检查器|运行面板|素材面板)$/ }).click()
}

// 从左边创作库的「节点」里点一下添加。快速创建的搜索会先列出画布上已有的同名节点，点到的可能是旧的那个。
async function addNode(canvas, label) {
  await clearSelection(canvas)
  await closeInspector(canvas)
  const before = await nodes(canvas).count()
  const library = canvas.getByRole('complementary', { name: '创作内容库' })
  if (!await library.getByRole('textbox', { name: '搜索节点' }).isVisible()) await libraryTab(canvas, '节点').click()
  await library.getByRole('button', { name: new RegExp(`^${label} `) }).click()
  await expect(nodes(canvas)).toHaveCount(before + 1, { timeout: fixtureReadyTimeoutMs })
  await canvas.getByRole('button', { name: '收起创作库' }).click()
}

async function writeNote(canvas, text) {
  const notes = canvas.getByRole('textbox', { name: '备注内容' })
  const before = await notes.count()
  await addNode(canvas, '便签')
  await expect(notes).toHaveCount(before + 1, { timeout: fixtureReadyTimeoutMs })
  const empty = await notes.evaluateAll((elements) => elements.findIndex((element) => element.value === ''))
  assert.ok(empty >= 0, 'the note just added must be empty')
  await notes.nth(empty).fill(text)
  await clearSelection(canvas)
}

async function statusLine(canvas) {
  return evaluateInRenderer(canvas, 'status line', () => document.body.innerText)
}

// The status bar's own text, hidden parts included: below 1180px the kernel hides
// the generation summary (canvas-status-media), and a Windows runner's 1024 x 768
// screen holds the canvas window under that width.
async function statusBar(canvas) {
  return evaluateInRenderer(canvas, 'status bar', () => document.querySelector('[aria-label="画布状态"]')?.textContent ?? '')
}

function pendingCount(text) {
  return Number(/(\d+) 个待更新/.exec(text)?.[1] ?? 0)
}

async function imageNaturalWidth(canvas, name) {
  const image = canvas.getByRole('img', { name }).first()
  await image.waitFor({ timeout: fixtureReadyTimeoutMs })
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth), { timeout: fixtureReadyTimeoutMs }).toBe(64)
  return image.evaluate((element) => element.naturalWidth)
}

async function runAll(canvas) {
  await clearSelection(canvas)
  await canvas.getByRole('button', { name: '运行全部' }).click()
  await canvas.getByRole('dialog', { name: '运行前检查' }).getByRole('button', { name: '确认运行' }).click()
}

async function waitForAutosave(name, ...fragments) {
  await expect.poll(async () => {
    const stored = await storedWorkflow(name)
    return stored !== null && fragments.every((fragment) => stored.includes(fragment))
  }, { timeout: fixtureReadyTimeoutMs }).toBe(true)
}

// 旧画布在桌面上有、新内核按桌面声明（electron/canvas-contract.ts 的 desktopCanvasCapabilities）应当留下的节点。
// 新内核多出来的节点（图片工具、抽帧、文字生成、音频……）桌面这一版都不该出现：多一个这里就红。
const desktopNodeLibrary = ['提示词', '图片素材', '视频素材', '音频素材', '图像节点', '视频节点', '路由', '候选画廊', '输出',
  '分组', '便签', '从剧本开始', '漫剧圣经', '剧本', '剧本解析', '角色资产', '场景资产', '道具资产', '分镜']
// 云端存储、创意工坊、智能助手、官方素材、多人协作都是网页版的入口，桌面上一个字都不该露出来。
const cloudWording = /云端保存|创意工坊|智能助手|官方素材|多人协作|社区/

async function main() {
  progress('preparing the isolated fixture state')
  await prepareSandbox()
  try {
    const page = await start()
    beginStage('open the canvas')
    let canvas = await openCanvas(page)
    assert.doesNotMatch(await statusLine(canvas), cloudWording)

    beginStage('create project A and check what the desktop exposes')
    await createProject(canvas, '项目甲', 'a')
    await libraryTab(canvas, '节点').click()
    const library = canvas.getByRole('complementary', { name: '创作内容库' })
    await library.getByRole('textbox', { name: '搜索节点' }).waitFor()
    const libraryNodes = await evaluateInRenderer(canvas, 'node library', () => [...document.querySelectorAll('[aria-label="创作内容库"] button strong')]
      .map((element) => element.textContent.trim()).filter((text) => text && text !== '节点'))
    assert.deepEqual(libraryNodes, desktopNodeLibrary)
    await canvas.getByRole('button', { name: '收起创作库' }).click()
    assert.doesNotMatch(await statusLine(canvas), cloudWording)
    recordPass('desktop-entries-only')

    beginStage('choose the image group and insert a two-step workflow')
    await canvas.getByRole('button', { name: '生成配置' }).click()
    await canvas.getByRole('combobox', { name: '生图分组分组选择' }).selectOption({ label: 'GPT-image2 · 1x' })
    await expect(canvas.getByRole('combobox', { name: '生图默认模型' })).toBeEnabled({ timeout: fixtureReadyTimeoutMs })
    await canvas.getByRole('button', { name: '关闭生成配置' }).click()
    await canvas.getByRole('button', { name: '从模板开始' }).click()
    await canvas.getByRole('article').filter({ has: canvas.getByRole('heading', { name: '快速文生图' }) })
      .getByRole('button', { name: '查看并配置' }).click()
    await canvas.getByRole('textbox', { name: '画面描述' }).fill('一只绿色的猫')
    await canvas.getByRole('button', { name: '填写并插入' }).click()
    await expect(nodes(canvas)).toHaveCount(4, { timeout: fixtureReadyTimeoutMs })
    const status = await statusBar(canvas)
    assert.match(status, /图片 · GPT-image2/)
    assert.doesNotMatch(status, /视频 · 图片模型/)
    recordPass('status-bar-labels')
    const imageNode = nodes(canvas).filter({ hasText: '图像节点' }).first()
    await imageNode.click({ position: { x: 20, y: 60 } })
    const resolutions = await canvas.getByRole('combobox', { name: '生成清晰度' }).locator('option').allTextContents()
    assert.deepEqual(resolutions, ['1K', '2K', '4K'])
    recordPass('image-resolutions')

    beginStage('run the prompt and image nodes together')
    await runAll(canvas)
    await canvas.getByText('运行结束：已完成').waitFor({ timeout: fixtureReadyTimeoutMs })
    let stats = await readFixtureStats()
    assert.equal(stats.generations.length, 1, 'one run of the workflow is one image request')
    recordPass('multi-node-run-accepted')
    assert.deepEqual(stats.generations.map(({ group, model, prompt }) => ({ group, model, prompt })),
      [{ group: 'GPT-image2', model: 'gpt-image-2', prompt: '一只绿色的猫' }])
    recordPass('run-uses-chosen-group')
    assert.equal(await imageNaturalWidth(canvas, '图像节点素材预览'), 64)
    recordPass('generated-image-displays')
    await capture(canvas, 'project-a-generated')

    beginStage('write notes, a long note and a long preset name')
    const longNote = `长便签：${'星芒画布'.repeat(2_600)}`
    assert.ok(longNote.length > 10_000)
    await writeNote(canvas, 'TODO: 改色')
    await writeNote(canvas, 'https://x.com 配色')
    await writeNote(canvas, longNote)
    await waitForAutosave('项目甲', 'TODO: 改色', 'https://x.com 配色', longNote.slice(-40))
    assert.ok((await storedWorkflow('项目甲')).includes(longNote))
    recordPass('long-note-saved')
    const promptNode = nodes(canvas).filter({ hasText: '为下游节点提供文本' }).first()
    await promptNode.getByRole('button', { name: '保存为提示词预设' }).click()
    await libraryTab(canvas, '提示词').click()
    await canvas.getByRole('button', { name: '编辑预设 一只绿色的猫' }).click()
    const presetName = `预设${'名'.repeat(158)}`
    assert.equal(presetName.length, 160)
    await canvas.getByRole('textbox', { name: '预设名称' }).fill(presetName)
    await canvas.getByRole('button', { name: '保存预设' }).click()
    await expect.poll(() => evaluateInRenderer(canvas, 'prompt presets', () => window.xingmangCanvasHost.listPromptPresets()
      .then((presets) => presets.map((preset) => preset.name))), { timeout: fixtureReadyTimeoutMs }).toContain(presetName)
    recordPass('long-preset-name')
    await canvas.getByRole('button', { name: '收起创作库' }).click()

    beginStage('save and export through the desktop dialogs only')
    await imageNode.click({ position: { x: 20, y: 60 } })
    await canvas.getByRole('button', { name: '另存素材' }).click()
    await clearSelection(canvas)
    await canvas.getByRole('button', { name: '更多操作' }).click()
    await canvas.getByRole('button', { name: '导出工作流' }).click()
    await expect.poll(async () => (await readFixtureStats()).dialogs.filter((entry) => entry.name === 'showSaveDialog').length,
      { timeout: fixtureReadyTimeoutMs }).toBe(2)
    stats = await readFixtureStats()
    assert.deepEqual(stats.downloads, [], 'nothing in the canvas may hand a file to Chromium\'s own download path')
    // 「另存素材」是主进程的图片另存框，「导出工作流」是画布的导出项目框，两个都是星芒自己弹的。
    assert.deepEqual(stats.dialogs.filter((item) => item.name === 'showSaveDialog').map((item) => item.title), ['图片另存为', '画布：导出项目'])
    recordPass('no-browser-download')

    beginStage('turn on the minimap and focus mode, then close after the autosave')
    await canvas.getByRole('button', { name: '显示缩略图' }).click()
    await canvas.getByRole('button', { name: '隐藏侧边面板' }).click()
    await canvas.getByRole('button', { name: '隐藏缩略图' }).waitFor()
    await canvas.getByRole('button', { name: '显示侧边面板' }).waitFor()
    await waitForAutosave('项目甲', 'TODO: 改色')
    await closeCanvas(canvas)
    recordPass('autosave-then-close')

    beginStage('reopen project A')
    canvas = await openCanvas(page)
    await openProject(canvas, '项目甲')
    await expect(nodes(canvas)).toHaveCount(7, { timeout: fixtureReadyTimeoutMs })
    for (const text of ['TODO: 改色', 'https://x.com 配色']) await expect(canvas.getByRole('textbox', { name: '备注内容' }).filter({ hasText: text })).toHaveCount(1)
    const reopenedNotes = await canvas.getByRole('textbox', { name: '备注内容' }).evaluateAll((elements) => elements.map((element) => element.value))
    assert.ok(reopenedNotes.includes(longNote), 'the long note must come back whole')
    recordPass('note-text-survives-reopen')
    await canvas.getByRole('button', { name: '隐藏缩略图' }).waitFor({ timeout: fixtureReadyTimeoutMs })
    await canvas.getByRole('button', { name: '显示侧边面板' }).waitFor({ timeout: fixtureReadyTimeoutMs })
    recordPass('view-toggles-survive-reopen')
    assert.equal(await imageNaturalWidth(canvas, '图像节点素材预览'), 64)

    beginStage('copy project A')
    await backToCenter(canvas)
    await canvas.getByRole('button', { name: '复制项目：项目甲' }).click()
    await capture(canvas, 'copy-dialog')
    await evaluateInMainProcess('answer the copy folder dialog', () => globalThis.__canvasSmoke.chooseFolder('a-copy'))
    const copyDialog = canvas.getByRole('dialog').last()
    await copyDialog.getByRole('button', { name: /选择文件夹|创建|复制/ }).last().click()
    const copyCard = canvas.getByRole('button', { name: /^打开项目：项目甲.+/ })
    await copyCard.waitFor({ timeout: fixtureReadyTimeoutMs })
    const copyName = (await copyCard.getAttribute('aria-label')).replace('打开项目：', '')
    await openProject(canvas, copyName)
    await expect(nodes(canvas)).toHaveCount(7, { timeout: fixtureReadyTimeoutMs })
    await expect(canvas.getByRole('textbox', { name: '备注内容' }).filter({ hasText: 'TODO: 改色' })).toHaveCount(1)
    assert.equal(await imageNaturalWidth(canvas, '图像节点素材预览'), 64)
    // 便签改过字也算「待更新」（便签不运行，这个数不会自己清），所以下面拿副本自己这时的数作对照。
    const copyPending = pendingCount(await statusLine(canvas))
    recordPass('copy-carries-content')

    beginStage('edit the prompt while project A generates')
    await backToCenter(canvas)
    await openProject(canvas, '项目甲')
    await evaluateInMainProcess('hold generations', () => globalThis.__canvasSmoke.holdGenerations(true))
    const promptBox = canvas.getByRole('textbox', { name: '提示词提示词' })
    await promptBox.fill('一只蓝色的猫')
    await runAll(canvas)
    await expect.poll(async () => (await readFixtureStats()).generations.length, { timeout: fixtureReadyTimeoutMs }).toBe(2)
    await promptBox.fill('一只红色的猫')
    await evaluateInMainProcess('release generations', () => globalThis.__canvasSmoke.releaseGenerations())
    await canvas.getByText('输入已变化，旧运行结果保留在候选和运行历史中；当前节点仍待重新运行').waitFor({ timeout: fixtureReadyTimeoutMs })
    // 图像节点画成缩略样式时节点上不写「待更新」，选中后在检查器里看。
    await nodes(canvas).filter({ hasText: '图像节点' }).first().click({ position: { x: 20, y: 60 } })
    await canvas.getByRole('button', { name: '查看选中节点详情' }).click()
    await canvas.getByText('输入已变化，当前结果待更新。').waitFor({ timeout: fixtureReadyTimeoutMs })
    await clearSelection(canvas)
    recordPass('stale-after-edit-during-run')

    beginStage('keep the copy out of project A\'s run')
    // F02：旧画布在 A 出图时切到副本，副本跟着显示 A 的「生成中」、混进 A 的候选图。新内核在结果回填前不让离开
    // 这个项目，回填后换文档时也不带上一份的运行态。两半都看：跑着的时候回不去项目中心；跑完再开副本，副本干干净净。
    await runAll(canvas)
    await expect.poll(async () => (await readFixtureStats()).generations.length, { timeout: fixtureReadyTimeoutMs }).toBe(3)
    const back = canvas.getByRole('button', { name: '返回项目中心' })
    await expect(back).toBeDisabled()
    await capture(canvas, 'project-a-running')
    await evaluateInMainProcess('release generations', () => globalThis.__canvasSmoke.releaseGenerations())
    await evaluateInMainProcess('stop holding generations', () => globalThis.__canvasSmoke.holdGenerations(false))
    await expect(back).toBeEnabled({ timeout: fixtureReadyTimeoutMs })
    await backToCenter(canvas)
    await openProject(canvas, copyName)
    await expect(nodes(canvas)).toHaveCount(7, { timeout: fixtureReadyTimeoutMs })
    const copyStatus = await statusLine(canvas)
    assert.doesNotMatch(copyStatus, /生成中|运行中/)
    assert.equal(pendingCount(copyStatus), copyPending, 'project A\'s edits and run must not mark the copy\'s nodes stale')
    await expect(canvas.getByRole('textbox', { name: '提示词提示词' })).toHaveValue('一只绿色的猫')
    const storedCopy = await storedWorkflow(copyName)
    assert.ok(!storedCopy.includes('一只红色的猫') && !storedCopy.includes('一只蓝色的猫'), 'the copy must not pick up project A\'s later runs')
    await capture(canvas, 'copy-after-a-ran')
    recordPass('copy-ignores-source-run')

    beginStage('undo after switching from A to B')
    await backToCenter(canvas)
    await createProject(canvas, '项目乙', 'b')
    await writeNote(canvas, '乙的便签')
    await waitForAutosave('项目乙', '乙的便签')
    await backToCenter(canvas)
    await openProject(canvas, '项目甲')
    await backToCenter(canvas)
    await openProject(canvas, '项目乙')
    await expect(nodes(canvas)).toHaveCount(1, { timeout: fixtureReadyTimeoutMs })
    await clearSelection(canvas)
    for (let press = 0; press < 3; press += 1) await canvas.keyboard.press('Control+z')
    await expect(nodes(canvas)).toHaveCount(1)
    await expect(canvas.getByRole('textbox', { name: '备注内容' })).toHaveValue('乙的便签')
    await canvas.waitForTimeout(1_500)
    const storedB = await storedWorkflow('项目乙')
    assert.ok(storedB.includes('乙的便签'))
    assert.ok(!storedB.includes('TODO: 改色'), 'project B must never receive project A\'s nodes')
    recordPass('undo-stays-in-project')

    beginStage('write a project the old canvas saved')
    await evaluateInMainProcess('write the legacy project', (_electron, input) => globalThis.__canvasSmoke.writeLegacyProject(input),
      { sourceName: '项目甲', name: '旧画布的工程', prompt: '旧画布写的提示词' })
    await closeCanvas(canvas)

    beginStage('undo with only one project opened')
    canvas = await openCanvas(page)
    await openProject(canvas, '项目甲')
    const openedCount = await nodes(canvas).count()
    assert.ok(openedCount >= 7)
    await clearSelection(canvas)
    for (let press = 0; press < 3; press += 1) await canvas.keyboard.press('Control+z')
    await expect(nodes(canvas)).toHaveCount(openedCount)
    recordPass('undo-keeps-opened-project')

    beginStage('open the project the old canvas saved')
    await backToCenter(canvas)
    await openProject(canvas, '旧画布的工程')
    await expect(nodes(canvas)).toHaveCount(2, { timeout: fixtureReadyTimeoutMs })
    await expect(canvas.getByRole('textbox', { name: '提示词提示词' })).toHaveValue('旧画布写的提示词')
    assert.equal(await imageNaturalWidth(canvas, '图像节点素材预览'), 64)
    await capture(canvas, 'legacy-project')
    recordPass('legacy-project-opens')

    beginStage('final checks')
    stats = await readFixtureStats()
    assert.deepEqual(pageErrors, [])
    assert.deepEqual(stats.downloads, [])
    assert.deepEqual([...new Set(stats.rendererBlocked)], [], 'no window may reach for the network on its own')
    assert.equal(stats.generations.length, 3)
    assert.ok(stats.generations.every((generation) => generation.answered))
    assert.deepEqual([...passedAssertions].sort(), [...expectedAssertions].sort())
    const result = {
      passedAssertions,
      measured: {
        requestsAnsweredByFixture: stats.calls.filter((call) => call.outcome === 'served').length,
        requestsRefusedByFixture: stats.calls.filter((call) => call.outcome === 'denied').length,
        egressAttemptsDenied: stats.blocked.length,
        refusedRoutes: [...new Set(stats.calls.filter((call) => call.outcome === 'denied').map((call) => `${call.method} ${call.origin}${call.route}`))].sort(),
        deniedEgress: [...new Set(stats.blocked.map((entry) => `${entry.origin}${entry.route}`))].sort(),
        imageRequests: stats.generations.map(({ group, model, prompt }) => ({ group, model, prompt })),
        desktopDialogs: stats.dialogs,
        browserDownloads: stats.downloads.length,
        keyGroups: stats.keyGroups,
      },
    }
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8')
    return result
  } catch (error) {
    console.error(`Canvas kernel smoke failed during: ${stage}`)
    if (currentCanvas && !currentCanvas.isClosed()) await capture(currentCanvas, 'failure').catch(() => undefined)
    const runtimeLog = await fs.readFile(path.join(userData, 'logs/runtime.jsonl'), 'utf8').catch(() => '')
    const recent = runtimeLog.split('\n').filter((line) => line.includes('"level":"error"')).slice(-6).join('\n')
    console.error(`${stderr}\n${recent}\npage errors: ${JSON.stringify(pageErrors)}`
      .replace(/(?:sk-)?fixture-canvas-[A-Za-z0-9_-]*/g, '[fixture-secret]'))
    throw error
  } finally {
    await stop()
    const relative = path.relative(os.tmpdir(), sandbox)
    if (path.isAbsolute(relative) || relative.startsWith('..') || !path.basename(sandbox).startsWith('xingmang-canvas-smoke-')) throw new Error('Invalid fixture cleanup root')
    await fs.rm(sandbox, { recursive: true, force: true })
  }
}

await run(main)
