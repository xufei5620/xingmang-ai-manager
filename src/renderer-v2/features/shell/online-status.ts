import { classifyNetworkFailure, type NetworkFailureReason } from '../../../../electron/network-failure'

/**
 * 软件开着的时候网断了，以前每个页面各说各的：余额写「更新失败」，充值、安装、聊天
 * 都要点下去、等请求超时才知道不行。这里给出唯一一个「现在是不是没网」的判断，
 * 顶部横幅、余额文案和几处要联网的按钮都读它。
 *
 * 不碰 React、不发请求，判断留在纯函数里才测得动（T3 同理）。
 */

export const offlineBannerText = '现在连不上网。已经装好的 AI 工具照常能用；充值、聊天、安装和更新要等网络恢复。'
export const offlineActionMessage = '现在没网，等网络恢复后再试。'
export const offlineBalanceText = '没网，稍后自动刷新'

/**
 * 只认「本机这一侧的网」出的问题。超时、连接被拒、证书不对、服务在维护，都可能只是
 * 服务那一侧慢了或挂了，别的网站照样打得开；这时顶上写「现在连不上网」是冤枉用户
 * 的网，他会去折腾路由器而不是等一等。代理挂掉、门户认证没做完、域名解析不了，
 * 正是 navigator.onLine 看不出来、又确实什么都连不上的那几种。
 */
const localNetworkFailures: ReadonlySet<NetworkFailureReason> = new Set(['offline', 'dns', 'proxy', 'intercepted'])

/** 连着几次请求都是本机网络的问题才算断网：一次偶发失败不值得在顶上挂一条横幅。 */
export const offlineFailureThreshold = 2

/** 同时吃得下主进程写好的中文和底层的 `ERR_*` / errno 原文（归类只有 network-failure.ts 这一份）。 */
export function isLocalNetworkFailure(cause: unknown): boolean {
  return localNetworkFailureReason(cause) !== null
}

/** 同上，但把是哪一种也交出来：代理挂了、要网页认证和真断网，出路完全不同。 */
export function localNetworkFailureReason(cause: unknown): NetworkFailureReason | null {
  const reason = classifyNetworkFailure(cause)
  return reason !== null && localNetworkFailures.has(reason) ? reason : null
}

/**
 * 顶上那条横幅按哪种情况说。代理连不上时重启路由器、换 Wi-Fi 都没用，要么把代理软件
 * 打开、要么把系统代理关掉；门户认证则是在浏览器里登一下就好。都写成「连不上网」，
 * 用户只会去折腾路由器。
 */
export type OfflineCause = 'offline' | 'proxy' | 'portal'

export const offlineBannerTexts: Readonly<Record<OfflineCause, string>> = {
  offline: offlineBannerText,
  proxy: '电脑里设置的代理连不上，所以现在上不了网。请重新打开你的代理（加速）软件，或者把系统代理关掉。',
  portal: '这个网络要先登录认证（校园网、酒店、公共 Wi-Fi 常见）。点「打开认证页」登录后，这里会自动恢复。',
}

/** 代理连不上、星芒已经替用户改成直连之后挂的那一条：网是通的，只是说明一下。 */
export const proxyBypassedBannerText = '电脑里设置的代理连不上，星芒已经改为直接联网，可以照常使用。浏览器等其它软件可能还上不了网，可以点右边去关掉代理。'

/** navigator.onLine 说没网时就是真断网；否则看最近那次本机网络失败是哪一种。 */
export function offlineCause({ browserOnline, networkFailureReason }: Pick<OnlineSignals, 'browserOnline' | 'networkFailureReason'>): OfflineCause {
  if (!browserOnline) return 'offline'
  if (networkFailureReason === 'proxy') return 'proxy'
  if (networkFailureReason === 'intercepted') return 'portal'
  return 'offline'
}

export interface OnlineSignals {
  /**
   * navigator.onLine。它说「没网」时基本可信（网卡都断了）；说「有网」时不一定：
   * 门户认证、代理挂掉它都看不出来，所以另有请求失败的计数兜底。
   */
  browserOnline: boolean
  /** 最近连着几次请求都是本机网络的问题；成功一次就归零。 */
  networkFailures: number
  /** 最近那次本机网络失败的原因；没有就是 null 或缺省。 */
  networkFailureReason?: NetworkFailureReason | null
}

export function isOffline({ browserOnline, networkFailures }: OnlineSignals): boolean {
  return !browserOnline || networkFailures >= offlineFailureThreshold
}
