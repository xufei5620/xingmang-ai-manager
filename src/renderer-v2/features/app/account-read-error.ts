export function formatAccountReadError(cause: unknown, resource: 'balance' | 'session'): string | null {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*/i, '').replace(/^(?:Error|RealmAccountError):\s*/i, '').trim()
  // An obsolete read can reject before the session-change event reaches the
  // renderer. It carries no current-account result and needs no user action.
  if (message === '账号上下文已变化，请重试') return null
  const subject = resource === 'balance' ? '余额' : '账号信息'
  if (/网络|连接|超时|network|fetch|timeout|ECONN|ENOTFOUND/i.test(message)) return `${subject}暂时没有读到，请检查网络后重试。`
  if (/请先登录|重新登录|登录已过期|登录已失效/.test(message)) return '当前登录已失效，请重新登录。'
  return `${subject}暂时没有读到，请稍后重试。`
}
