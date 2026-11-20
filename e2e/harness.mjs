import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createServer } from 'vite'
import { createPageErrorCollector } from './page-errors.mjs'

// T-B1: 十四个浏览器套件各自抄了一遍「起 Vite dev server + 起 Chromium + 开一个记录
// pageerror 的 page」这段样板，逐字重复，差别只在视口和 cacheDir。重复本身不致命，代价
// 是每一条跨套件的修法都要改十四处：executablePath 的容器兜底（T-S5）当初漏了两个文件，
// pageerror 采集（T-G3）至今仍有套件是自己内联的。收进这里之后，这类修法只改一处。
//
// T-B5: 顺带把散在各文件里的超时与视口常量收拢过来。仓库刻意不引入 playwright.config
// 与 @playwright/test 的 runner（测试仍由 node --test 驱动），所以「配置」就是这个模块
// 导出的几个常量。

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 绝大多数夹具用的视口；与设计稿的 1280 逻辑宽一致。 */
export const defaultViewport = { width: 1280, height: 820 }

/**
 * 断言级默认超时。刻意收紧到 5 秒：夹具挂载另有预算（fixture-readiness.mjs），
 * 挂载完成之后还要等 5 秒以上的断言基本就是真回归。
 */
export const actionTimeoutMs = 5_000

/** 图片解码与 canvas 缩放比纯 DOM 断言慢一档，用得上这一档的套件单独取它。 */
export const imageActionTimeoutMs = 7_000

/** 首次导航要等 Vite 按需转换整张模块图，冷跑远慢于一次断言。 */
export const navigationTimeoutMs = 30_000

/**
 * 夹具 server 抢不到端口时重试几次。
 *
 * 探测与 Vite 真正绑定之间有一个窗口，别的进程可以在这中间占掉同一个端口；
 * strictPort:true 会把这种情况变成硬失败而不是静默换号，所以这里换一个端口再来。
 * 内核给的是临时端口段里的号，撞一次已经少见，连撞四次可以当成真的没端口了。
 */
export const fixtureServerPortAttempts = 4

/**
 * 向内核要一个当下空闲的端口：监听 0 拿到号，再把探测用的 socket 关掉。
 *
 * Vite 不认「端口传 0」这种写法。它的 startServer 写的是
 * `(!configPort || …) ? server._currentServerPort : configPort) ?? 5173`，
 * `!0` 为真、`_currentServerPort` 首次启动是 undefined，于是 0 被当成「没配端口」
 * 落到默认的 5173，再由 strictPort:false 逐个往上探（实测 8.1.5：三个 server 依次
 * 拿到 5173 / 5174 / 5175）。也就是说「交给内核分配」这句话一直没有兑现：所有夹具
 * server 都从同一个众所周知的端口起步，彼此、以及和开发机上跑着的 `npm run dev`
 * 抢同一段号。真正要内核分配，只能自己先拿到号再钉给 Vite。
 */
export function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close((error) => (error ? reject(error) : resolve(port)))
    })
  })
}

function isPortTakenError(error) {
  // Vite 的 httpServerStart 在 strictPort 下把 EADDRINUSE 换成自己的文案，
  // 原来的 code 不再挂在 error 上。
  return /already in use|EADDRINUSE/.test(String(error?.message ?? error))
}

/**
 * 起一个监听在真正空闲端口上的 Vite dev server，并把它实际绑到的端口告诉调用方。
 *
 * 端口只从 `httpServer.address()` 取——预约到的那个号是入参，绑定结果才是事实。
 *
 * T-B2: 夹具 server 不许写死首选端口。此前有两个套件写死 5191 / 5196，strictPort:false
 * 让它们不会硬失败，但两个套件并行时第二个会静默换端口，写死的那个数字既没保障也没意义；
 * 改成传 0 之后毛病没变，只是众所周知的那个号从 5191 换成了 Vite 的 5173。
 */
export async function createFixtureServer(inlineConfig = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const port = await reserveFreePort()
    const server = await createServer({
      ...inlineConfig,
      // strictPort:true 是这件事的重点：钉住预约到的号，不许 Vite 再自己往上探，
      // 否则它又会从某个别人可能也在用的端口开始。
      server: { host: '127.0.0.1', ...inlineConfig.server, port, strictPort: true },
    })
    try {
      await server.listen()
    } catch (error) {
      await server.close()
      if (attempt >= fixtureServerPortAttempts || !isPortTakenError(error)) throw error
      continue
    }
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string') {
      await server.close()
      throw new Error('Vite test server did not expose a TCP port')
    }
    return { server, origin: `http://127.0.0.1:${address.port}`, port: address.port }
  }
}

/** Bootstrap evidence contains module paths and structural state only, never fixture data. */
export function observeFixtureBootstrap(page, server) {
  const started = Date.now()
  const pending = new Map()
  const events = []
  const counters = { scriptRequests: 0, failedResponses: 0, requestFailures: 0, pageErrors: 0, navigations: 0, fullReloads: 0 }
  const listeners = []
  const sockets = []
  const optimizer = server?.environments?.client?.depsOptimizer
  let scanState = optimizer?.scanProcessing ? 'pending' : 'idle'
  if (optimizer?.scanProcessing) Promise.resolve(optimizer.scanProcessing).then(() => { scanState = 'settled' }, () => { scanState = 'rejected' })
  function safeModulePath(value) {
    try {
      const url = new URL(value)
      if (url.hostname !== '127.0.0.1') return '(non-fixture-origin)'
      if (url.pathname.startsWith('/@fs/')) return '/@fs/(local-module)'
      return /^\/(?:src\/|e2e\/|node_modules\/|@vite\/|@react-refresh)/.test(url.pathname) ? url.pathname : '(fixture-resource)'
    } catch { return '(unparsed-module)' }
  }
  function event(value) {
    if (events.length < 16) events.push({ ms: Date.now() - started, ...value })
  }
  function watch(name, handler) { page.on(name, handler); listeners.push([name, handler]) }
  watch('request', request => {
    if (request.resourceType() !== 'script') return
    counters.scriptRequests += 1
    pending.set(request, Date.now())
  })
  watch('requestfinished', request => pending.delete(request))
  watch('requestfailed', request => {
    pending.delete(request)
    if (request.resourceType() !== 'script') return
    counters.requestFailures += 1
    event({ kind: 'module-request-failed', path: safeModulePath(request.url()), code: request.failure()?.errorText.match(/(?:net::)?ERR_[A-Z_]+/)?.[0] || 'request-failed' })
  })
  watch('response', response => {
    if (response.request().resourceType() !== 'script' || response.status() < 400) return
    counters.failedResponses += 1
    event({ kind: 'module-http-error', path: safeModulePath(response.url()), status: response.status(), outdatedOptimizeDep: /Outdated Optimize Dep/.test(response.statusText()) })
  })
  watch('pageerror', error => {
    counters.pageErrors += 1
    event({ kind: 'page-error', category: ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError'].includes(error.name) ? error.name : 'Error' })
  })
  watch('console', message => {
    if (message.type() !== 'error') return
    const text = message.text()
    const category = /Outdated Optimize Dep/.test(text) ? 'outdated-optimize-dependency'
      : /Failed to load module script/.test(text) ? 'module-script-load-error'
        : /Failed to fetch dynamically imported module/.test(text) ? 'module-import-failed' : 'console-error'
    event({ kind: 'console-error', category, path: safeModulePath(message.location().url) })
  })
  watch('framenavigated', frame => { if (frame === page.mainFrame()) counters.navigations += 1 })
  watch('websocket', socket => {
    const received = frame => {
      if (typeof frame.payload !== 'string' || frame.payload.length > 65536) return
      try { if (JSON.parse(frame.payload).type === 'full-reload') counters.fullReloads += 1 } catch {}
    }
    socket.on('framereceived', received)
    sockets.push([socket, received])
  })
  return {
    async snapshot() {
      const structure = await Promise.race([
        page.evaluate(() => {
          const root = document.getElementById('root')
          const first = root?.firstElementChild
          const style = first ? getComputedStyle(first) : null
          return { readyState: document.readyState, rootChildren: root?.childElementCount ?? 0, viteOverlay: Boolean(document.querySelector('vite-error-overlay')), firstDisplay: style?.display ?? null, firstVisibility: style?.visibility ?? null, firstOpacity: style?.opacity ?? null }
        }).catch(() => ({ unavailable: true })),
        new Promise(resolve => setTimeout(() => resolve({ unavailable: true }), 1000)),
      ])
      return { elapsedMs: Date.now() - started, ...counters, scanState, optimizedDependencies: Object.keys(optimizer?.metadata?.optimized || {}).length,
        discoveredDependencies: Object.keys(optimizer?.metadata?.discovered || {}).length, events,
        pendingScripts: [...pending].slice(0, 12).map(([request, at]) => ({ path: safeModulePath(request.url()), ageMs: Date.now() - at })), structure }
    },
    dispose() {
      for (const [name, handler] of listeners) page.off(name, handler)
      for (const [socket, handler] of sockets) socket.off('framereceived', handler)
    },
  }
}

async function startFixtureServer({ cacheDir } = {}) {
  const { server, origin } = await createFixtureServer({
    root: projectRoot,
    // configFile 不传 = Vite 自己从 root 解析 vite.config.ts，与此前显式传路径的写法
    // 等价；两种写法当初并存只是抄的来源不同。
    ...(cacheDir ? { cacheDir } : {}),
    logLevel: 'error',
  })
  return { server, baseUrl: origin }
}

function launchFixtureBrowser() {
  // T-S5: 托管 CI 装的是 Playwright 期望的那个 Chromium 版本，而临时容器（云端 agent
  // 会话）往往装的是别的版本，直接 launch 会报 "Executable doesn't exist"。认这个变量
  // 是为了让容器里也能跑 `npm test`；CI 不设它，照旧用 Playwright 自己下的那份。
  return chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined })
}

/**
 * 依次跑完每一步收尾，前面哪步抛错也不跳过后面的；返回该抛的那个错，全都顺利时返回 undefined。
 *
 * `failure` 是收尾之前就已经发生的那个错（比如浏览器没起来）：它排第一个，收尾再出错
 * 也不会把它盖掉。只有一个错时原样返回；不止一个时用 AggregateError 全部带上。
 */
async function runCleanup(steps, failure) {
  const errors = failure === undefined ? [] : [failure]
  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 1) return new AggregateError(errors, 'Browser fixture cleanup failed')
  return errors[0]
}

/**
 * 一个 Vite dev server + 一个 Chromium + 一份 pageerror 记录。
 * `before`/`after` 型套件调 start/stop；每个用例自带一套的套件用 withBrowserFixture。
 *
 * 第二个参数只给 harness 自己的测试换掉起 server、起浏览器这两步，套件不传。
 */
export function createBrowserFixture(options = {}, { startServer = startFixtureServer, launchBrowser = launchFixtureBrowser } = {}) {
  let server
  let browser
  let baseUrl
  const pageErrors = createPageErrorCollector()

  async function start() {
    // 上一套还没 stop 就再 start，旧的 server 和浏览器就没人关了。
    if (server || browser) throw new Error('Browser fixture is already started')
    const started = await startServer(options)
    let launched
    try {
      launched = await launchBrowser()
    } catch (error) {
      // U03: server 这时已经在监听。start 抛错时调用方手里没有任何能关它的东西，
      // 不在这里关掉，这个监听句柄会让 node --test 的子进程一直不退出，只能等外面的超时。
      throw await runCleanup([() => started.server.close()], error)
    }
    server = started.server
    baseUrl = started.baseUrl
    browser = launched
    return baseUrl
  }

  async function stop() {
    // 先把引用摘下来：浏览器关失败时 server 照样关，再调一次 stop 也不会重复关。
    const closing = { browser, server }
    browser = undefined
    server = undefined
    const error = await runCleanup([() => closing.browser?.close(), () => closing.server?.close()])
    if (error) throw error
  }

  async function newPage({ viewport = options.viewport ?? defaultViewport, sameOriginOnly = options.sameOriginOnly, ...rest } = {}) {
    const page = pageErrors.watch(await browser.newPage({ viewport, ...rest }))
    if (options.actionTimeoutMs) page.setDefaultTimeout(options.actionTimeoutMs)
    if (options.navigationTimeoutMs) page.setDefaultNavigationTimeout(options.navigationTimeoutMs)
    // 夹具只该向自己的 dev server 取东西。放行外部请求会让一次意外的真实出网变成
    // 「本地全绿、CI 挂在网络上」的不稳定源。
    if (sameOriginOnly) await page.route('**/*', (route) => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort())
    return page
  }

  return {
    get baseUrl() {
      if (!baseUrl) throw new Error('Browser fixture was not started')
      return baseUrl
    },
    start,
    stop,
    newPage,
    /** 断言这一份夹具里没有任何未捕获的渲染异常（T-G3）。 */
    assertNoPageErrors: () => pageErrors.assertNone(),
  }
}

/** 每个用例起一套自己的 server / 浏览器时用它：跑完先断言 pageerror，再无条件拆掉。 */
export async function withBrowserFixture(options, run, dependencies) {
  const fixture = createBrowserFixture(options, dependencies)
  try {
    // start 放进 try：哪天 start 又只起了一半就抛错，finally 里的 stop 也会把已经起来的那部分关掉。
    await fixture.start()
    const result = await run(fixture)
    // 断言放在 finally 之前：run 自己失败时要让它的错误原样冒上去，而不是被这里的
    // pageerror 断言盖掉。
    fixture.assertNoPageErrors()
    return result
  } finally {
    await fixture.stop()
  }
}
