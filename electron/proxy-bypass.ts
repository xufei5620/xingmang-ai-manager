/**
 * 电脑里设过一个代理（以前开过的加速器、翻墙软件、抓包工具），软件关了或崩了，
 * 系统代理还指着它。星芒的账号、余额、聊天都走 net.fetch，跟着系统代理走，于是
 * 全部报「代理连不上」。这时重启路由器、换 Wi-Fi 都没用。更新那条路早就会自己
 * 改直连重试一次（updater.ts 的 retryWithoutProxy），这里给其余的路补上同一个兜底。
 *
 * 只改星芒自己这个进程的会话，不碰电脑的代理设置；也不落盘：下次打开软件，照旧
 * 跟随系统代理，用户把代理软件重新打开就什么都不用管。
 */

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
  /** 在已改直连的会话上发一次请求；服务真的回了话才算通。 */
  probe(url: string): Promise<boolean>
  accelerationActive(): Promise<boolean>
  log?(level: 'info' | 'warn', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface ProxyBypass {
  tryBypass(): Promise<ProxyBypassOutcome>
  /** 本次运行是否已经改成直连。 */
  active(): boolean
}

function firstRoute(value: string): string {
  return value.slice(0, 2048).split(';', 1)[0].trim().toUpperCase()
}

export function createProxyBypass(dependencies: ProxyBypassDependencies): ProxyBypass {
  let active = false
  let pending: Promise<ProxyBypassOutcome> | null = null

  async function attempt(): Promise<ProxyBypassOutcome> {
    const url = dependencies.probeUrl()
    if (!url) return 'unavailable'
    if (firstRoute(await dependencies.resolveProxy(url)) === 'DIRECT') return 'no-proxy'
    // 读不到加速状态时按「开着」处理：宁可这一次不绕，也不能把加速刚接管的
    // 系统代理从星芒这一侧架空。
    const accelerating = await dependencies.accelerationActive().catch(() => true)
    if (accelerating) return 'acceleration'
    await dependencies.setProxy('direct')
    const reachable = await dependencies.probe(url).catch(() => false)
    if (reachable) {
      active = true
      dependencies.log?.('info', 'proxy-bypass.direct', '系统代理连不上，本次运行改为直接联网')
      return 'direct'
    }
    await dependencies.setProxy('system')
    dependencies.log?.('warn', 'proxy-bypass.unreachable', '系统代理连不上，直接联网也不通，已改回跟随系统代理')
    return 'unreachable'
  }

  return {
    async tryBypass() {
      if (active) return 'direct'
      // 横幅和「重新检测」可能前后脚各点一次：同一时刻只试一次，不来回切代理。
      if (!pending) pending = attempt().finally(() => { pending = null })
      return pending
    },
    active: () => active,
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
