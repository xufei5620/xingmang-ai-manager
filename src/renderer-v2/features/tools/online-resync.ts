import { classifyNetworkFailure } from '../../../../electron/network-failure'

/**
 * 在没网的地方打开软件：会话是本机缓存的，首页照常进得去，但「同步账号专属 Key」
 * 这一步必然失败。引导段用 bootstrapAttempts 保证每次启动只跑一次，所以网络回来
 * 之后也没人再去补，用户得自己回首页点「重新同步」——很多人根本不知道要点。
 *
 * 这个模块只回答两个问题：这次失败是不是网络造成的、联网事件来了要不要补跑一次。
 * 不碰 React、不发请求，判断留在纯函数里才测得动（T3 同理）；App.tsx 那边只剩
 * 一个 ref 和一个事件监听。
 */

export interface OnlineResyncState {
  /** 因网络失败而等着补跑的账号 scope；null 表示没有待补的。 */
  scope: string | null
  /** 补跑是否正在进行。同一次补跑没结束前再来一个 online 事件不重复排队。 */
  running: boolean
}

export interface OnlineResyncPlan {
  state: OnlineResyncState
  /** 这次要补跑的账号 scope；null 表示什么都不做。 */
  scope: string | null
}

/** 结果里与本模块有关的那一部分，只取这两个字段是为了不和 account-bootstrap 互相 import。 */
export interface OnlineResyncOutcome {
  result?: { networkBlocked: boolean }
  error?: string
}

export function idleOnlineResync(): OnlineResyncState {
  return { scope: null, running: false }
}

/**
 * 只认 electron/network-failure.ts 那一份归类（同时吃得下主进程写好的中文和底层的
 * `ERR_*` / errno 原文）。认不出来就当不是网络问题：把一个说不清的失败当成断网，
 * 会让用户在一个换网络也好不了的故障上干等。
 */
export function isNetworkFailureText(text: unknown): boolean {
  return classifyNetworkFailure(text) !== null
}

/**
 * 要求「全是网络类」而不是「有一条是网络类」：掺着 401 或分组未配置时，补跑既
 * 解决不了那一条，又会把首页横幅上用户看得懂的原因刷成另一句。
 */
export function networkBlockedFailures(messages: readonly string[]): boolean {
  const signals = messages.filter((message) => message.trim().length > 0)
  return signals.length > 0 && signals.every(isNetworkFailureText)
}

/** 整段引导抛错时只有一句 message，这时按这句话归类；正常返回时看结果里的结论。 */
export function bootstrapBlockedByNetwork(outcome: OnlineResyncOutcome | null | undefined): boolean {
  if (!outcome) return false
  if (outcome.error) return isNetworkFailureText(outcome.error)
  return outcome.result?.networkBlocked === true
}

/**
 * 每跑完一次引导就把结论记下来：网络类失败挂上待补跑，其他结果（成功，或者换个
 * 网络也好不了的失败）把这个 scope 的待补跑清掉。别的账号的待补跑不动——切号本身
 * 会把状态重置，这里只管自己这一条。
 */
export function noteBootstrapOutcome(
  state: OnlineResyncState,
  scope: string,
  outcome: OnlineResyncOutcome | null | undefined,
): OnlineResyncState {
  if (bootstrapBlockedByNetwork(outcome)) return { scope, running: false }
  if (state.scope !== scope) return state
  return idleOnlineResync()
}

/**
 * 联网事件来了。online 事件本身只在离线→在线那一刻发一次，running 再挡住同一次
 * 补跑期间的重复排队，合起来就是「每次断线最多补一次」，不做轮询。
 *
 * navigator.onLine 对门户认证、代理挂掉这类情况并不可靠，所以它只当触发信号；
 * 到底成不成仍由这次请求本身说了算。
 */
export function planOnlineResync(state: OnlineResyncState, scope: string | null): OnlineResyncPlan {
  if (!state.scope || state.running || state.scope !== scope) return { state, scope: null }
  return { state: { scope: state.scope, running: true }, scope: state.scope }
}
