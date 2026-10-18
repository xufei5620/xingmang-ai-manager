import { networkFailureMessages, networkFailureReasonForMessage } from '../../../../electron/network-failure'
import { classifyOperationError } from '../../operation-error'
import { stripIpcErrorPrefix } from '../../ipc-error-prefix'
/** 读账号时发现登录已经失效的那句话；弹窗据此给「重新登录」而不是「重试」。 */
export const accountReadReloginMessage = '当前登录已失效，请重新登录。'

export function formatAccountReadError(cause: unknown, resource: 'balance' | 'session'): string | null {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const message = stripIpcErrorPrefix(raw).trim()
  // An obsolete read can reject before the session-change event reaches the
  // renderer. It carries no current-account result and needs no user action.
  if (message === '账号上下文已变化，请重试') return null
  const subject = resource === 'balance' ? '余额' : '账号信息'
  const reason = networkFailureReasonForMessage(message)
  // 服务在维护时不是网络问题，也不是登录失效：下面两条按字面猜，会把它说成其中之一。
  if (reason === 'serviceUnavailable') return `${subject}暂时没有读到：${networkFailureMessages.serviceUnavailable}`
  // 主进程已经认成网络问题的照旧叫人查网络。以前「代理连不上」那句只靠没剥掉的类名
  // NewApiNetworkError 里那个 Network 才认出来（句子里没有网络、连接、超时）；类名剥掉以后要按句子认。
  if (reason || /网络|连接|超时|network|fetch|timeout|ECONN|ENOTFOUND/i.test(message)) return `${subject}暂时没有读到，请检查网络后重试。`
  // 认登录失效和错误框同一份规则（#1095）：new-api 那句「无权进行此操作，access token 无效」
  // 以前落到「请稍后重试」，重读多少次都一样，也不给重新登录的入口。
  if (/请先登录|重新登录|登录已过期|登录已失效/.test(message) || classifyOperationError(message) === 'sessionExpired') return accountReadReloginMessage
  return `${subject}暂时没有读到，请稍后重试。`
}

/**
 * 「账号信息没读到」弹窗除了「返回」还要给哪一颗（全面检测 Q36）。以前正文叫人
 * 重新登录，按钮却只有「返回」，用户只能自己去找登录入口；其余情形重读一次就行。
 */
export function accountReadErrorAction(message: string): 'relogin' | 'retry' {
  return message === accountReadReloginMessage ? 'relogin' : 'retry'
}
