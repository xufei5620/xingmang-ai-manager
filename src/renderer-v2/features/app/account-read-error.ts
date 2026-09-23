import { networkFailureMessages, networkFailureReasonForMessage } from '../../../../electron/network-failure'
/** 读账号时发现登录已经失效的那句话；弹窗据此给「重新登录」而不是「重试」。 */
export const accountReadReloginMessage = '当前登录已失效，请重新登录。'

export function formatAccountReadError(cause: unknown, resource: 'balance' | 'session'): string | null {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^(?:Error|RealmAccountError):\s*/i, '').trim()
  // An obsolete read can reject before the session-change event reaches the
  // renderer. It carries no current-account result and needs no user action.
  if (message === '账号上下文已变化，请重试') return null
  const subject = resource === 'balance' ? '余额' : '账号信息'
  // 服务在维护时不是网络问题，也不是登录失效：下面两条按字面猜，会把它说成其中之一。
  if (networkFailureReasonForMessage(message) === 'serviceUnavailable') return `${subject}暂时没有读到：${networkFailureMessages.serviceUnavailable}`
  if (/网络|连接|超时|network|fetch|timeout|ECONN|ENOTFOUND/i.test(message)) return `${subject}暂时没有读到，请检查网络后重试。`
  if (/请先登录|重新登录|登录已过期|登录已失效/.test(message)) return accountReadReloginMessage
  return `${subject}暂时没有读到，请稍后重试。`
}

/**
 * 「账号信息没读到」弹窗除了「返回」还要给哪一颗（全面检测 Q36）。以前正文叫人
 * 重新登录，按钮却只有「返回」，用户只能自己去找登录入口；其余情形重读一次就行。
 */
export function accountReadErrorAction(message: string): 'relogin' | 'retry' {
  return message === accountReadReloginMessage ? 'relogin' : 'retry'
}
