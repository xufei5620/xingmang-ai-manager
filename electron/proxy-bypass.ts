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
 * 代理软件换节点、改设置时会重启内核，开机时也常比星芒晚起来几秒，端口往往只断这一下。
 * 所以撞上「代理连不上」先等几秒再经系统代理看一眼，还连不上才整个改直连；改了以后也隔
 * 一阵经一个只跟随系统代理的会话看一眼，代理又连得上星芒了就改回跟随系统代理（星芒自己
 * 的加速开着时除外）。以前改了就一直直连到退出，装工具、拉插件都不再走用户的代理。
 *
 * 只改星芒自己这个进程的会话，不碰电脑的代理设置；也不落盘：下次打开软件，照旧
 * 跟随系统代理。
 */

import { classifyNetworkFailure, type NetworkFailureReason } from './network-failure'

export type ProxyBypassOutcome =
  /** 直连通了：改成直连，经系统代理又连得上以后再改回去。 */
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
   * 用它看直连通不通；站点改直连期间，默认会话还跟着系统代理，用它看代理软件还在不在、
   * 直连那一路出错以后系统代理连不连得上星芒站点；撞上「代理连不上」以后，也用它再看一眼
   * 代理是不是只断了一下。
   */
  probe(url: string): Promise<boolean>
  /** 在连星芒站点专用的直连会话上发一次请求，默认会话不动；服务真的回了话才算通。 */
  probeSiteDirect(url: string): Promise<boolean>
  /**
   * 在只跟随系统代理的会话上发一次请求；服务真的回了话才算通，网络层失败照原样抛出。整个
   * 改了直连以后默认会话不再经过系统代理，用它看代理是不是又连得上星芒站点了。
   */
  probeSystemProxy(url: string): Promise<boolean>
  accelerationActive(): Promise<boolean>
  /** 测试注入用；缺省 setTimeout。 */
  schedule?(callback: () => void, delayMs: number): () => void
  /** 测试注入用；缺省 Date.now。 */
  now?(): number
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
  /** 整个改了直连、后来又改回跟随系统代理的那一刻：界面上「已经改为直接联网」那条提示跟着收起。 */
  directEnded?(): void
}

export interface ProxyBypass {
  tryBypass(): Promise<ProxyBypassOutcome>
  /**
   * 账号请求在网络层失败后问一句：要不要换条路再发一次。startedAt 是那次请求
   * 发出的时刻，reason 是失败原因。返回 true 表示值得重发：多半是改了直连、那次请求
   * 走的是改之前那条路，也可能是站点那一路刚交还给系统代理、那次请求走的是交还掉的
   * 直连，或者代理只断了一下、再看已经连得上了，照旧经系统代理重发；false 表示别重发，
   * 按原错误报。代理本身连不上才整个改直连（先等一会儿再看一眼），超时、连接被断只让
   * 连那个站点的请求改走专用的直连会话：siteProbeUrl 是那次请求所连站点的探测地址，
   * 缺省用 probeUrl()。
   */
  recoverFailedRequest(startedAt: number, reason: NetworkFailureReason, siteProbeUrl?: string): Promise<boolean>
  /** 现在是不是整个改成了直连；经系统代理又连得上星芒以后会改回去。 */
  active(): boolean
  /** 连星芒站点的请求现在是不是改走专用的直连会话（整个改了直连时不算）。 */
  siteDirect(): boolean
  /**
   * 这个地址的请求该不该走连星芒站点专用的直连会话：该走就给出这一轮改直连的编号，
   * 不该（不是星芒站点、没改直连、已经整个改了直连）返回 null。整个改了直连时，也借
   * 这一下隔一阵在后台看看系统代理是不是又连得上了。
   */
  routeSiteRequest(url: string): number | null
  /**
   * 第 route 轮走直连会话的请求在网络层失败了：在后台同时看一眼系统代理和直连，系统代理
   * 连得上星芒站点（或者现在不该绕）才把连星芒站点的请求改回跟随系统代理，不然接着直连。
   */
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
 * 时机经系统代理探一下。整个改了直连以后也一样：每隔这么久借一次连星芒的请求的时机，
 * 看代理软件是不是又好了；代理时好时坏，来回切也最多这么久一趟。
 */
export const systemProxyCheckIntervalMs = 5 * 60_000

/**
 * 撞上「代理连不上」以后，先等这么久再经系统代理看一眼，还连不上才整个改直连：代理软件
 * 换节点、改设置时会重启内核，开机时也常比星芒晚起来几秒，端口往往只断这一下。
 */
export const proxyRecheckDelayMs = 3_000

/**
 * 直连那一路出错以后，系统代理和直连都没连上星芒站点（多半是断网、刚换了网络，还没
 * 缓过来）时，隔这么久再看一次，最多再看这几次：笔记本换到了必须走代理的网络，代理一
 * 连得上就交还给它，账号请求不必先在直连上白等满 10 秒；电脑一直没网也不会一直探下去。
 */
export const siteRecheckDelaysMs: readonly number[] = [3_000, 10_000, 30_000]

function scheduleTimeout(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

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
  /** 这一轮从什么时候开始：之前发出的请求走的是系统代理，或者是上一轮那条刚断过的直连。 */
  since: number
  /** 第几轮：上一轮走直连的请求失败得晚了，不能把刚探通的这一轮也交还掉。 */
  id: number
}

/** 直连那一路出错以后正在做的那次再看。 */
interface SiteRecheck {
  /**
   * 为这次失败来问的请求等的是它：交还了、开了新一轮，或者直连没通、先留在直连，
   * 有了结论就答，不陪着把后面的事做完。
   */
  verdict: Promise<void>
  /** 看的这一会儿又有请求在直连上失败了：最后留在直连的话，从这次失败重新算起。 */
  failedAgain: boolean
}

/**
 * 撞上「代理连不上」等一会儿再看的那一眼：又连得上了（answered）、还是连不上（down），
 * 或者换成了别的错（unclear：代理多半已经起来，线路还没缓过来，或者这会儿没网）。
 */
type ProxyLook = 'answered' | 'down' | 'unclear'

const proxyAnswersMessage = '经系统代理现在连得上了，账号和 AI 请求改回跟随系统代理'

export function createProxyBypass(dependencies: ProxyBypassDependencies): ProxyBypass {
  let active = false
  let activatedAt = 0
  // 同一时刻只记一个站点：会来问的只有星芒账号那一个客户端（main.ts），它连的总是同一个站点。
  let site: SiteRoute | null = null
  let siteRounds = 0
  let proxyCheckedAt = 0
  // 直连上次探不通的时刻，整个改直连和站点那一路探的都算：两边问的是同一件事。
  // 站点那一路探的时候这台电脑没网，不算探不通。
  let unreachableAt: number | null = null
  let pending: Promise<ProxyBypassOutcome> | null = null
  let sitePending: Promise<boolean> | null = null
  let siteRecheck: SiteRecheck | null = null
  let cancelSiteFollowUp: (() => void) | null = null
  // 连星芒站点的请求最近一次交还给系统代理是什么时候、交还的是哪个站点：站点那一路交还的，
  // 和整个改了直连以后改回跟随系统代理的，都算。
  let siteHandedBack: { probeUrl: string, at: number } | null = null
  let proxyCheck: Promise<void> | null = null
  let proxyLook: Promise<ProxyLook> | null = null
  const now = dependencies.now ?? Date.now
  const schedule = dependencies.schedule ?? scheduleTimeout

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
      // 隔 systemProxyCheckIntervalMs 再看代理软件是不是又好了（见 restoreSystemProxy）。
      proxyCheckedAt = activatedAt
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

  async function lookAgain(url: string): Promise<ProxyLook> {
    await new Promise<void>((resolve) => { schedule(resolve, proxyRecheckDelayMs) })
    // 等的这一会儿有人在试整个改直连（「重新检测」）：那时默认会话切着直连，经它探的不算数，
    // 等它试完；已经改成直连了就照那边答。
    if (pending) await pending.catch(() => undefined)
    if (active) return 'down'
    const failure = await dependencies.probe(url).then(
      (answered) => answered ? null : 'no-answer',
      // 探测自己等满了抛的是 AbortSignal.timeout 的 TimeoutError，classifyNetworkFailure 认不出来。
      (error: unknown) => error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : classifyNetworkFailure(error) ?? 'no-answer',
    )
    if (failure === null) {
      dependencies.log?.('info', 'proxy-bypass.proxy-back', '系统代理断了一下，再看已经连得上，照旧跟随系统代理')
      return 'answered'
    }
    if (failure === 'proxy') return 'down'
    dependencies.log?.('warn', 'proxy-bypass.proxy-unclear', '系统代理连不上，再看时换成了别的错，先照旧跟随系统代理', { failure })
    return 'unclear'
  }

  // 撞上「代理连不上」以后先别急着整个改直连：代理软件换节点、重启内核时端口只断这一下。
  // 等一会儿经默认会话（这时还跟着系统代理）再探一次；几个请求一起撞上时只看一次。
  function lookAgainAtProxy(url: string): Promise<ProxyLook> {
    if (!proxyLook) proxyLook = lookAgain(url).finally(() => { proxyLook = null })
    return proxyLook
  }

  // 在连星芒站点专用的直连会话上探一下。这台电脑这会儿没网（断网、刚换了网络）时
  // 哪条路都不通，探不通也说明不了直连不行，所以单独报出来。
  async function probeSite(url: string): Promise<'reachable' | 'offline' | 'unreachable'> {
    try {
      return await dependencies.probeSiteDirect(url) ? 'reachable' : 'unreachable'
    } catch (error) {
      return classifyNetworkFailure(error) === 'offline' ? 'offline' : 'unreachable'
    }
  }

  // 超时、连接被断时代理软件多半还活着，只是不转发星芒站点：先在专用的直连会话上
  // 探一下，通了就只让连这个站点的请求改走它，默认会话一行不动。
  async function divertSiteRequests(url: string | null): Promise<boolean> {
    if (!url || await bypassBlocker(url)) return false
    const outcome = await probeSite(url)
    const origin = originOf(url)
    if (outcome === 'offline') {
      // 不记退避：网络回来后下一个失败的请求照样再探，不至于在不转发的代理上一连卡一分钟。
      dependencies.log?.('warn', 'proxy-bypass.site-unreachable', '账号请求经系统代理没走通，这台电脑这会儿也没有网络，照旧跟随系统代理')
      return false
    }
    if (outcome !== 'reachable' || !origin) {
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

  // 记下交还的时刻和站点：在这之前发出的请求走的是交还掉的那条直连，它们再失败也不该
  // 把站点又分出去（见 recoverFailedRequest）。
  function handBackSite(message: string, detail?: Record<string, unknown>): void {
    if (!site) return
    siteHandedBack = { probeUrl: site.probeUrl, at: now() }
    site = null
    dependencies.log?.('info', 'proxy-bypass.site-direct-ended', message, detail)
  }

  // 直连这一路出了一次错，先别急着交还：断网、换 Wi-Fi、连接被断一下都会让直连上的请求失败，
  // 这时交还给不转发星芒站点的代理，网络一回来，下一个账号请求就得先在代理上白等满 10 秒
  // 才回头再探，登录、下单这类还不自动重发。所以在后台同时看一眼系统代理和直连，这期间请求
  // 照旧走直连：系统代理连得上星芒站点就交还给它（换到了必须走代理的网络，或者直连时好时坏、
  // 代理却好好的）；代理连不上而直连通，就开新一轮接着直连（刚才失败的请求是新一轮之前发出的，
  // 照样重发）；两条路都没连上，多半是网络还没缓过来，先留在直连，过一会儿再看。
  // 返回 true 表示两条路都没连上、还留在这一轮直连上。
  async function recheckSiteRoute(current: SiteRoute, attempt: number, decide: () => void): Promise<boolean> {
    // 正在试整个改直连时默认会话已经切成直连：这时去看「走没走代理」只会得到「没走」，
    // 经默认会话探的也成了直连。等它试完；试成了，站点这一路就用不着了。
    if (pending) await pending.catch(() => undefined)
    if (active) return false
    // 读不出系统代理时照样往下看：这里要知道的是哪条路连得上。
    const blocker = await bypassBlocker(current.probeUrl).catch(() => null)
    if (blocker) {
      if (site?.id === current.id) handBackSite('电脑不再走代理或星芒加速开着，账号和 AI 请求改回跟随系统代理', { blocker })
      return false
    }
    const viaProxy = dependencies.probe(current.probeUrl).catch(() => false)
    const viaDirect = probeSite(current.probeUrl)
    // 谁先有结论听谁的：代理不转发星芒站点时，经它的那一探常常要等满超时，直连先通了就不陪着等。
    const first = await Promise.race([viaProxy.then((answered) => answered ? 'proxy' as const : viaDirect), viaDirect])
    if (site?.id !== current.id) return false
    if (first === 'proxy') {
      handBackSite(proxyAnswersMessage)
      return false
    }
    if (first === 'reachable') {
      const renewed: SiteRoute = { ...current, since: now(), id: ++siteRounds }
      site = renewed
      unreachableAt = null
      dependencies.log?.('info', 'proxy-bypass.site-direct-resumed', '账号和 AI 请求直接联网断了一下，再探已经通了，接着直接联网')
      // 经代理的那一探晚一步回来、说连得上，照样交还给代理。
      void viaProxy.then((answered) => {
        if (answered && site?.id === renewed.id) handBackSite(proxyAnswersMessage)
      })
      return false
    }
    // 直连没通：这时还留在直连，为这次失败来问的请求是这一轮发出的，答案已经是「别重发」，
    // 先答它，不陪着等经代理那一探超时；登录、下单这类失败也就不多转那几秒。
    decide()
    if (await viaProxy) {
      if (site?.id === current.id) handBackSite(proxyAnswersMessage)
      return false
    }
    if (site?.id !== current.id) return false
    // 不记退避，也不交还：交还给一个连不上星芒站点的代理，网络回来时正好撞上这次要修的毛病。
    if (first === 'offline') {
      dependencies.log?.('info', 'proxy-bypass.site-direct-kept', '账号和 AI 请求直接联网没走通，这台电脑这会儿没有网络，先接着直接联网', { attempt })
    } else {
      dependencies.log?.('warn', 'proxy-bypass.site-direct-kept', '账号和 AI 请求直接联网没走通，经系统代理也没连上，先接着直接联网', { attempt })
    }
    return true
  }

  // 两条路都没连上：过一会儿再看，次数有限（siteRecheckDelaysMs）。
  function followUpSiteRecheck(current: SiteRoute, attempt: number): void {
    if (attempt >= siteRecheckDelaysMs.length) return
    cancelSiteFollowUp = schedule(() => {
      cancelSiteFollowUp = null
      if (site?.id === current.id && !siteRecheck) startSiteRecheck(current, attempt + 1)
    }, siteRecheckDelaysMs[attempt])
  }

  function startSiteRecheck(current: SiteRoute, attempt: number): void {
    cancelSiteFollowUp?.()
    cancelSiteFollowUp = null
    let decide = (): void => undefined
    const recheck: SiteRecheck = { verdict: new Promise<void>((resolve) => { decide = () => resolve() }), failedAgain: false }
    siteRecheck = recheck
    void recheckSiteRoute(current, attempt, () => decide())
      .catch(() => false)
      .then((kept) => {
        decide()
        if (siteRecheck === recheck) siteRecheck = null
        // 看的这一会儿又有请求在直连上失败了，就从那次失败重新算起。
        if (kept) followUpSiteRecheck(current, recheck.failedAgain ? 0 : attempt)
      })
  }

  async function checkSystemProxy(url: string): Promise<void> {
    const failure = await dependencies.probe(url).then(() => null, classifyNetworkFailure)
    // 代理还活着（哪怕照旧不转发星芒站点）就什么都不改；代理本身连不上了，才照 #578
    // 整个改直连，装工具、拉插件也就跟着不再撞上一个已经关掉的代理。正好撞上代理软件
    // 重启内核的那一下不算：等一会儿再看一眼，还连不上才改。
    if (failure !== 'proxy' || backingOff(automaticBypassCooldownMs)) return
    // 等的这一会儿别处刚试过整个改直连、直连也不通：不接着再试一遍。
    if (await lookAgainAtProxy(url) !== 'down' || backingOff(automaticBypassCooldownMs)) return
    await tryBypass()
  }

  // 整个改了直连以后，经只跟随系统代理的会话看一眼：连得上星芒，就把默认会话改回跟随系统
  // 代理，装工具、拉插件也就跟着走回用户的代理。星芒自己的加速开着时不改：那时系统代理归
  // 加速管，加速一断又指回那个关掉的代理（#578 的取舍，#841 也照这个做），读不到加速状态
  // 按开着算。改的那一刻正在走默认会话的请求和下载接着走直连，新发的才走代理。
  async function restoreSystemProxy(): Promise<void> {
    const url = dependencies.probeUrl()
    if (!url || !await dependencies.probeSystemProxy(url).catch(() => false)) return
    if (await dependencies.accelerationActive().catch(() => true)) return
    await dependencies.setProxy('system')
    active = false
    // 经系统代理连得上星芒，连它的请求也就不用再分去直连那一路。这之前发出、后来才失败的
    // 请求走的是直连，换系统代理重发一次，不为它回头再探直连（见 recoverFailedRequest）。
    site = null
    siteHandedBack = { probeUrl: url, at: now() }
    dependencies.log?.('info', 'proxy-bypass.direct-ended', '经系统代理又连得上了，本次运行改回跟随系统代理')
    dependencies.directEnded?.()
  }

  // 隔 systemProxyCheckIntervalMs 才看一次系统代理，同一时刻只看一次；看的这一下在后台，
  // 不拖着借它时机的那次请求。
  function startProxyCheck(check: () => Promise<void>): void {
    if (proxyCheck || now() - proxyCheckedAt < systemProxyCheckIntervalMs) return
    proxyCheckedAt = now()
    proxyCheck = check().catch(() => undefined).finally(() => { proxyCheck = null })
  }

  return {
    tryBypass,
    async recoverFailedRequest(startedAt, reason, siteProbeUrl) {
      // 另一个请求正在试整个改直连：等它试完再答。试的那一会儿默认会话已经切成直连，
      // 这时去看「走没走代理」只会得到「没走」，这次请求就白白不重发了。
      if (pending) await pending.catch(() => undefined)
      // 直连那一路刚失败、正在后台再看：等它有了结论再答，不然这次请求看到的还是断掉的那一轮。
      // 直连还通，开的是新一轮，这次请求是新一轮之前发出的，下面照样重发。
      if (siteRecheck) await siteRecheck.verdict
      // 已经直连了还失败：要是那次请求是改直连之前发出的（几个请求一起卡在代理上，
      // 另一个先把会话切了），重发一次就走直连；之后发出的本来就是直连，重发没用。
      if (active) return startedAt < activatedAt
      if (site && reason !== 'proxy') return startedAt < site.since
      const url = siteProbeUrl ?? dependencies.probeUrl()
      // 代理本身连不上（代理软件关了、崩了）时走代理的什么都通不了，这才整个改直连。代理软件
      // 换节点、重启内核时也会这样断一下：先等一会儿再看一眼，又连得上了就照旧经系统代理重发；
      // 代理起来了、这一下却没走通，先什么都不改，后面的请求再超时自有站点那一路接着。
      if (reason === 'proxy') {
        // 等直连那一路再看的那一会儿，别处可能开始试整个改直连了：默认会话正切着直连，这时读到的
        // 「没走代理」不算数，等它试完。
        if (pending) await pending.catch(() => undefined)
        if (active) return startedAt < activatedAt
        if (backingOff(automaticBypassCooldownMs) || !url || await bypassBlocker(url)) return false
        const look = await lookAgainAtProxy(url)
        if (look !== 'down') return look === 'answered'
        return !backingOff(automaticBypassCooldownMs) && await tryBypass() === 'direct'
      }
      // 这次请求在站点交还给系统代理之前就发出了（同一毫秒也算），走的是交还掉的那条直连：交还时
      // 已经看过系统代理连得上星芒站点（或者现在本来就不该绕），换现在这条路重发一次（重不重发还要
      // 看请求本身，见 new-api-client 的 mayReplayOffProxy）。不为它回头再探直连，不然刚交还就又
      // 分了出去。
      if (siteHandedBack?.probeUrl === url && startedAt <= siteHandedBack.at) return true
      if (backingOff(siteProbeBackoffMs)) return false
      // 几个请求一起卡在代理上：同一时刻只探一次。
      if (!sitePending) sitePending = divertSiteRequests(url).finally(() => { sitePending = null })
      return sitePending
    },
    active: () => active,
    siteDirect: () => site !== null && !active,
    routeSiteRequest(url) {
      if (active) {
        // 这次请求照旧走默认会话（已经是直连），借它的时机看看代理软件是不是又好了。
        startProxyCheck(restoreSystemProxy)
        return null
      }
      if (!site || originOf(url) !== site.origin) return null
      const current = site
      startProxyCheck(() => checkSystemProxy(current.probeUrl))
      return site.id
    },
    siteRouteFailed(route) {
      const current = site
      // 上一轮迟到的失败不算。
      if (current?.id !== route) return
      // 同一轮几个请求一起失败，只看一次；正看着的那次最后要是留在直连，从这次失败重新算起。
      if (siteRecheck) {
        siteRecheck.failedAgain = true
        return
      }
      startSiteRecheck(current, 0)
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
 * 报给 siteRouteFailed，由它再看一次决定交不交还给系统代理；服务回了话（哪怕是 5xx）
 * 说明直连是通的，不算失败。
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

export interface SiteRoutingOptions extends Omit<ProxyBypassDependencies, 'probe' | 'probeSiteDirect' | 'probeSystemProxy'> {
  /** 默认会话：跟随系统代理，整个改直连以后就是直连。 */
  sessionFetch: typeof fetch
  /** 连星芒站点专用的直连会话。 */
  siteDirectFetch: typeof fetch
  /** 只跟随系统代理的会话：整个改了直连以后，只用它看代理软件是不是又好了。 */
  systemProxyFetch: typeof fetch
}

export interface SiteRouting {
  bypass: ProxyBypass
  /** AI 聊天画图、连通检查、查模型用：调用方自己中止的不算直连不通。 */
  relayFetch: typeof fetch
  /** 星芒账号客户端用：它只会因为 10 秒没回话而中止，那正说明直连这一路不通。 */
  accountFetch: typeof fetch
}

/**
 * main.ts 的接线收在这里，好单测。探测都直接用会话本身的 fetch，不经过上面的分流：
 * 改直连期间看代理还在不在的那一下要是也被分去了直连，就永远看不到代理已经没了。
 */
export function createSiteRouting({ sessionFetch, siteDirectFetch, systemProxyFetch, ...dependencies }: SiteRoutingOptions): SiteRouting {
  const bypass = createProxyBypass({
    ...dependencies,
    probe: (url) => probeDirectConnection(sessionFetch, url),
    probeSiteDirect: (url) => probeDirectConnection(siteDirectFetch, url),
    probeSystemProxy: (url) => probeDirectConnection(systemProxyFetch, url),
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
