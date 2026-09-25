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
  const reason = classifyNetworkFailure(cause)
  return reason !== null && localNetworkFailures.has(reason)
}

export interface OnlineSignals {
  /**
   * navigator.onLine。它说「没网」时基本可信（网卡都断了）；说「有网」时不一定：
   * 门户认证、代理挂掉它都看不出来，所以另有请求失败的计数兜底。
   */
  browserOnline: boolean
  /** 最近连着几次请求都是本机网络的问题；成功一次就归零。 */
  networkFailures: number
}

export function isOffline({ browserOnline, networkFailures }: OnlineSignals): boolean {
  return !browserOnline || networkFailures >= offlineFailureThreshold
}
