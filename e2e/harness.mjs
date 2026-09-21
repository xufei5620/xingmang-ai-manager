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
 * 一个 Vite dev server + 一个 Chromium + 一份 pageerror 记录。
 * `before`/`after` 型套件调 start/stop；每个用例自带一套的套件用 withBrowserFixture。
 */
export function createBrowserFixture(options = {}) {
  let server
  let browser
  let baseUrl
  const pageErrors = createPageErrorCollector()

  async function start() {
    const started = await startFixtureServer(options)
    server = started.server
    baseUrl = started.baseUrl
    browser = await launchFixtureBrowser()
    return baseUrl
  }

  async function stop() {
    await browser?.close()
    await server?.close()
    browser = undefined
    server = undefined
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
export async function withBrowserFixture(options, run) {
  const fixture = createBrowserFixture(options)
  await fixture.start()
  try {
    const result = await run(fixture)
    // 断言放在 finally 之前：run 自己失败时要让它的错误原样冒上去，而不是被这里的
    // pageerror 断言盖掉。
    fixture.assertNoPageErrors()
    return result
  } finally {
    await fixture.stop()
  }
}
