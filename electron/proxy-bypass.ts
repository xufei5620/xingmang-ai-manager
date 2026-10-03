/**
 * 电脑里设过一个代理（以前开过的加速器、翻墙软件、抓包工具），软件关了或崩了，
 * 系统代理还指着它。星芒的账号、余额、聊天都走 net.fetch，跟着系统代理走，于是
 * 全部报「代理连不上」。这时重启路由器、换 Wi-Fi 都没用。更新那条路早就会自己
 * 改直连重试一次（updater.ts 的 retryWithoutProxy），这里给其余的路补上同一个兜底。
 *
 * 代理软件还开着、只是不转发星芒的站点（规则把它挡了、线路慢到超时）是另一回事：
 * 那时只让连星芒站点的请求（账号、余额、AI 聊天画图、连通检查，连的都是同一个站点）
 * 改走一个专用的直连会话，默认会话照旧跟随系统代理。装工具、拉插件、检查页的「网络
 * 位置」都按默认会话走；以前一次超时就整个改直连到重启（#741），它们跟着丢了代理，
 * 笔记本换到必须走代理的网络后账号也连不回去。
 *
 * 只改星芒自己这个进程的会话，不碰电脑的代理设置；也不落盘：下次打开软件，照旧
 * 跟随系统代理，用户把代理软件重新打开就什么都不用管。
 */

import { classifyNetworkFailure, type NetworkFailureReason } from './network-failure'

export type ProxyBypassOutcome =
  /** 直连通了：本次运行一直直连。 */
  | 'direct'
  /** 直连也不通，已经改回跟随系统代理。 */
  | 'unreachable'
  /** 当前本来就没走代理，失败不是代理造成的，什么都没改。 */
  | 'no-proxy'
  /** 星芒自己的加速开着：系统代理是加速设的，由加速那边负责恢复。 */
  | 'acceleration'
  /** 没有可探测的地址（没选站点等），什么都没改。 */
  | 'unavailable'

export interface ProxyBypassDependencies {
  /** 探测用的地址；取不到就返回 null。 */
  probeUrl(): string | null
  /** Chromium 的 `resolveProxy` 原样结果，例如 `PROXY 127.0.0.1:7890; DIRECT`。 */
  resolveProxy(url: string): Promise<string>
  setProxy(mode: 'direct' | 'system'): Promise<void>
  /**
   * 在默认会话上发一次请求；服务真的回了话才算通，网络层失败照原样抛出。整个改直连时
   * 用它看直连通不通；站点改直连期间，默认会话还跟着系统代理，用它看代理软件还在不在。
   */
  probe(url: string): Promise<boolean>
  /** 在连星芒站点专用的直连会话上发一次请求，默认会话不动；服务真的回了话才算通。 */
  probeSiteDirect(url: string): Promise<boolean>
  accelerationActive(): Promise<boolean>
  /** 测试注入用；缺省 Date.now。 */
  now?(): number
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface ProxyBypass {
  tryBypass(): Promise<ProxyBypassOutcome>
  /**
   * 账号请求在网络层失败后问一句：要不要改直连再发一次。startedAt 是那次请求
   * 发出的时刻，reason 是失败原因。返回 true 表示现在走直连、且那次请求走的是改直连
   * 之前那条路，值得重发；false 表示别重发，按原错误报。代理本身连不上才整个改直连，
   * 超时、连接被断只让连那个站点的请求改走专用的直连会话：siteProbeUrl 是那次请求
   * 所连站点的探测地址，缺省用 probeUrl()。
   */
  recoverFailedRequest(startedAt: number, reason: NetworkFailureReason, siteProbeUrl?: string): Promise<boolean>
  /** 本次运行是否已经整个改成直连。 */
  active(): boolean
  /**
   * 这个地址的请求该不该走连星芒站点专用的直连会话：该走就给出这一轮改直连的编号，
   * 不该（不是星芒站点、没改直连、已经整个改了直连）返回 null。
   */
  routeSiteRequest(url: string): number | null
  /** 第 route 轮走直连会话的请求在网络层失败了：连星芒站点的请求改回跟随系统代理。 */
  siteRouteFailed(route: number): void
}

/**
 * 直连也不通之后，请求失败自己触发的那种尝试先停这么久：每次失败都把会话切到
 * 直连探一下再切回来，会让同一时刻别的请求也跟着来回换线路。用户点「重新检测」
 * 走的是 tryBypass，不受这个限制。
 */
export const automaticBypassCooldownMs = 5 * 60_000

/**
 * 站点那一路直连探不通之后，隔这么久才再探。它不碰默认会话，用不着像上面那样等
 * 5 分钟；网络断一下又回来时，账号请求也不至于在不转发的代理上卡 5 分钟。
 */
export const siteProbeBackoffMs = 60_000

/**
 * 连星芒站点的请求改走直连以后不再经过系统代理，代理软件后来关了、崩了就没人发现
 * （#578 靠的是账号请求撞上「代理连不上」）。所以这期间每隔这么久，借一次站点请求的
 * 时机经系统代理探一下。
 */
export const systemProxyCheckIntervalMs = 5 * 60_000

function firstRoute(value: string): string {
  return value.slice(0, 2048).split(';', 1)[0].trim().toUpperCase()
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

interface SiteRoute {
  /** 改走直连的站点，例如 https://xm.solov.cc。 */
  origin: string
  /** 这个站点的探测地址。 */
  probeUrl: string
  /** 这一轮从什么时候开始：之前发出的请求走的是系统代理。 */
  since: number
  /** 第几轮：上一轮走直连的请求失败得晚了，不能把刚探通的这一轮也交还掉。 */
  id: number
}

export function createProxyBypass(dependencies: ProxyBypassDependencies): ProxyBypass {
  let active = false
  let activatedAt = 0
  // 同一时刻只记一个站点：会来问的只有星芒账号那一个客户端（main.ts），它连的总是同一个站点。
  let site: SiteRoute | null = null
  let siteRounds = 0
  let proxyCheckedAt = 0
  // 直连上次探不通的时刻，整个改直连和站点那一路探的都算：两边问的是同一件事。
  let unreachableAt: number | null = null
  let pending: Promise<ProxyBypassOutcome> | null = null
  let sitePending: Promise<boolean> | null = null
  let proxyCheck: Promise<void> | null = null
  const now = dependencies.now ?? Date.now

  function backingOff(windowMs: number): boolean {
    return unreachableAt !== null && now() - unreachableAt < windowMs
  }

  // 失败不是系统代理造成的，或者代理归星芒自己的加速管：这两种都不该由这里绕开。
  async function bypassBlocker(url: string): Promise<'no-proxy' | 'acceleration' | null> {
    if (firstRoute(await dependencies.resolveProxy(url)) === 'DIRECT') return 'no-proxy'
    // 读不到加速状态时按「开着」处理：宁可这一次不绕，也不能把加速刚接管的
    // 系统代理从星芒这一侧架空。
    const accelerating = await dependencies.accelerationActive().catch(() => true)
    return accelerating ? 'acceleration' : null
  }

  async function attempt(): Promise<ProxyBypassOutcome> {
    const url = dependencies.probeUrl()
    if (!url) return 'unavailable'
    const blocker = await bypassBlocker(url)
    if (blocker) return blocker
    await dependencies.setProxy('direct')
    const reachable = await dependencies.probe(url).catch(() => false)
    if (reachable) {
      active = true
      activatedAt = now()
      unreachableAt = null
      dependencies.log?.('info', 'proxy-bypass.direct', '系统代理连不上，本次运行改为直接联网')
      return 'direct'
    }
    await dependencies.setProxy('system')
    unreachableAt = now()
    dependencies.log?.('warn', 'proxy-bypass.unreachable', '系统代理连不上，直接联网也不通，已改回跟随系统代理')
    return 'unreachable'
  }

  function tryBypass(): Promise<ProxyBypassOutcome> {
    if (active) return Promise.resolve('direct')
    // 横幅和「重新检测」可能前后脚各点一次：同一时刻只试一次，不来回切代理。
    if (!pending) pending = attempt().finally(() => { pending = null })
    return pending
  }

  // 超时、连接被断时代理软件多半还活着，只是不转发星芒站点：先在专用的直连会话上
  // 探一下，通了就只让连这个站点的请求改走它，默认会话一行不动。
  async function divertSiteRequests(url: string | null): Promise<boolean> {
    if (!url || await bypassBlocker(url)) return false
    const reachable = await dependencies.probeSiteDirect(url).catch(() => false)
    const origin = originOf(url)
    if (!reachable || !origin) {
      unreachableAt = now()
      dependencies.log?.('warn', 'proxy-bypass.site-unreachable', '账号请求经系统代理没走通，直接联网也不通，照旧跟随系统代理')
      return false
    }
    site = { origin, probeUrl: url, since: now(), id: ++siteRounds }
    proxyCheckedAt = site.since
    unreachableAt = null
    dependencies.log?.('info', 'proxy-bypass.site-direct', '账号请求经系统代理没走通，账号和 AI 请求改为直接联网，其余照旧跟随系统代理')
    return true
  }

  async function checkSystemProxy(url: string): Promise<void> {
    const failure = await dependencies.probe(url).then(() => null, classifyNetworkFailure)
    // 代理还活着（哪怕照旧不转发星芒站点）就什么都不改；代理本身连不上了，才照 #578
    // 整个改直连，装工具、拉插件也就跟着不再撞上一个已经关掉的代理。
    if (failure !== 'proxy' || backingOff(automaticBypassCooldownMs)) return
    await tryBypass()
  }

  return {
    tryBypass,
    async recoverFailedRequest(startedAt, reason, siteProbeUrl) {
      // 另一个请求正在试整个改直连：等它试完再答。试的那一会儿默认会话已经切成直连，
      // 这时去看「走没走代理」只会得到「没走」，这次请求就白白不重发了。
      if (pending) await pending.catch(() => undefined)
      // 已经直连了还失败：要是那次请求是改直连之前发出的（几个请求一起卡在代理上，
      // 另一个先把会话切了），重发一次就走直连；之后发出的本来就是直连，重发没用。
      if (active) return startedAt < activatedAt
      if (site && reason !== 'proxy') return startedAt < site.since
      // 代理本身连不上（代理软件关了、崩了）时走代理的什么都通不了，这才整个改直连。
      if (reason === 'proxy') return !backingOff(automaticBypassCooldownMs) && await tryBypass() === 'direct'
      if (backingOff(siteProbeBackoffMs)) return false
      // 几个请求一起卡在代理上：同一时刻只探一次。刚从直连那一路失败回来的请求也会
      // 走到这里：直连只是断了一下的话，这一探就又通了，它照样重发。
      if (!sitePending) sitePending = divertSiteRequests(siteProbeUrl ?? dependencies.probeUrl()).finally(() => { sitePending = null })
      return sitePending
    },
    active: () => active,
    routeSiteRequest(url) {
      if (!site || active || originOf(url) !== site.origin) return null
      if (!proxyCheck && now() - proxyCheckedAt >= systemProxyCheckIntervalMs) {
        proxyCheckedAt = now()
        proxyCheck = checkSystemProxy(site.probeUrl).catch(() => undefined).finally(() => { proxyCheck = null })
      }
      return site.id
    },
    siteRouteFailed(route) {
      if (site?.id !== route) return
      // 直连这一路也断了（比如笔记本换到了必须走代理的网络）：先回到系统代理，下一个
      // 失败的账号请求再来探，不在一条不通的路上一直等。
      site = null
      dependencies.log?.('info', 'proxy-bypass.site-direct-ended', '账号和 AI 请求直接联网没走通，改回跟随系统代理')
    },
  }
}

export interface SiteFetchOptions {
  /**
   * 调用方自己中止的请求算不算直连不通。账号请求只会因为 10 秒没回话而中止，算；
   * AI 聊天、画图中止多半是客户点了「停止」、关了窗口，不算：不然点一下「停止」，
   * 这一路就交还给不转发的代理，下一句又要卡住。
   */
  abortMeansUnreachable?: boolean
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/**
 * 连星芒站点的请求用的 fetch：改直连期间，这个站点的请求走专用的直连会话，别的地址、
 * 别的时候照常走默认会话。直连那一路在拿到回话之前就失败了（没回话、被断、超时），
 * 交还给系统代理；服务回了话（哪怕是 5xx）说明直连是通的，不算失败。
 */
export function createSiteFetch(
  bypass: Pick<ProxyBypass, 'routeSiteRequest' | 'siteRouteFailed'>,
  viaSession: typeof fetch,
  viaDirect: typeof fetch,
  options: SiteFetchOptions = {},
): typeof fetch {
  return async (input, init) => {
    const route = bypass.routeSiteRequest(requestUrl(input))
    if (route === null) return viaSession(input, init)
    try {
      return await viaDirect(input, init)
    } catch (error) {
      if (options.abortMeansUnreachable || !init?.signal?.aborted) bypass.siteRouteFailed(route)
      throw error
    }
  }
}

export interface SiteRoutingOptions extends Omit<ProxyBypassDependencies, 'probe' | 'probeSiteDirect'> {
  /** 默认会话：跟随系统代理，整个改直连以后就是直连。 */
  sessionFetch: typeof fetch
  /** 连星芒站点专用的直连会话。 */
  siteDirectFetch: typeof fetch
}

export interface SiteRouting {
  bypass: ProxyBypass
  /** AI 聊天画图、连通检查、查模型用：调用方自己中止的不算直连不通。 */
  relayFetch: typeof fetch
  /** 星芒账号客户端用：它只会因为 10 秒没回话而中止，那正说明直连这一路不通。 */
  accountFetch: typeof fetch
}

/**
 * main.ts 的接线收在这里，好单测。两个探测都直接用会话本身的 fetch，不经过上面的分流：
 * 改直连期间看代理还在不在的那一下要是也被分去了直连，就永远看不到代理已经没了。
 */
export function createSiteRouting({ sessionFetch, siteDirectFetch, ...dependencies }: SiteRoutingOptions): SiteRouting {
  const bypass = createProxyBypass({
    ...dependencies,
    probe: (url) => probeDirectConnection(sessionFetch, url),
    probeSiteDirect: (url) => probeDirectConnection(siteDirectFetch, url),
  })
  return {
    bypass,
    relayFetch: createSiteFetch(bypass, sessionFetch, siteDirectFetch),
    accountFetch: createSiteFetch(bypass, sessionFetch, siteDirectFetch, { abortMeansUnreachable: true }),
  }
}

const probeTimeoutMs = 8_000

/**
 * 只看服务回没回话，不读正文（I10 的响应体上限因此是 0）。重定向不跟：门户认证
 * 正是靠把请求拦到自己的登录页，跟过去就会把「被拦了」当成「通了」。
 */
export async function probeDirectConnection(
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>,
  url: string,
): Promise<boolean> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') return false
  const response = await fetchImpl(parsed.href, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(probeTimeoutMs),
  })
  await response.body?.cancel().catch(() => undefined)
  if (response.type === 'opaqueredirect' || response.status === 0) return false
  return response.status < 300 || response.status >= 400
}

export type NetworkSettingsKind = 'proxy' | 'captive-portal'

export function isNetworkSettingsKind(value: unknown): value is NetworkSettingsKind {
  return value === 'proxy' || value === 'captive-portal'
}

/**
 * 地址全写死在主进程：渲染层只说「要哪一个」，不传网址（I12）。
 *
 * 认证页刻意用 http：门户只拦得住明文请求，https 只会换来一张证书警告。两个地址
 * 都是系统自己检测门户用的那一个——没有门户时它们只回一句「成功」，有门户时
 * 浏览器就被带到登录页。
 */
export function networkSettingsTarget(platform: NodeJS.Platform, kind: NetworkSettingsKind): string | null {
  if (platform === 'win32') {
    return kind === 'proxy' ? 'ms-settings:network-proxy' : 'http://www.msftconnecttest.com/redirect'
  }
  if (platform === 'darwin') {
    return kind === 'proxy' ? 'x-apple.systempreferences:com.apple.preference.network' : 'http://captive.apple.com/'
  }
  return null
}
