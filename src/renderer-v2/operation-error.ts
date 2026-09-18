import { errors } from './registry/errors'

export type OperationErrorKey = keyof typeof errors
export type OperationActionId = 'retry' | 'log' | 'support' | 'relogin' | 'recharge' | 'network'
export interface OperationAction { id: OperationActionId; label: string }
export interface OperationErrorHint {
  key: Exclude<OperationErrorKey, 'unknown'>
  title: string
  body: string
  actions: OperationAction[]
}

/**
 * The backend hands the renderer one long sentence that already carries the
 * failure's identity: an npm/OS error code, or wording the main process wrote
 * itself. Matching on those tokens is what lets a raw "Claude Code 安装失败：
 * …EPERM…" become the catalog's "需要管理员权限". Order matters: the first
 * rule that matches wins, so the narrow, unambiguous tokens come first.
 */
const rules: Array<{ key: OperationErrorHint['key']; match: (message: string) => boolean }> = [
  { key: 'sessionExpired', match: (message) => /(^|\D)401(\D|$)|unauthorized|登录已过期|登录状态已失效|请重新登录/i.test(message) },
  { key: 'tooManyRequests', match: (message) => /(^|\D)429(\D|$)|too many requests|rate limit|请求(太|过于)频繁/i.test(message) },
  { key: 'noBalance', match: (message) => /余额不足|额度不足|insufficient[_ ]quota|余额已用完/i.test(message) },
  { key: 'keyInvalid', match: (message) => /invalid[_ ]api[_ ]key|令牌(无效|已失效|不存在)|密钥(无效|已失效)|无可用渠道/i.test(message) },
  { key: 'backupIntegrity', match: (message) => /备份[^。；]{0,12}(校验|完整性)[^。；]{0,8}(失败|不一致|无效)/.test(message) },
  // Only an update can promise "当前版本不受影响"; a first install has no
  // previous version to fall back to, so an integrity mismatch there keeps the
  // raw wording rather than borrowing a reassurance that would be false.
  { key: 'updateIntegrity', match: (message) => /更新|升级/.test(message) && /(SHA-512|完整性|校验)[^。；]{0,12}(失败|不一致|无效)/.test(message) },
  { key: 'permission', match: (message) => /EPERM|EACCES|operation not permitted|permission denied|拒绝访问|访问被拒绝|权限不足|需要管理员/i.test(message) },
  { key: 'installBlocked', match: (message) => /EBUSY|resource busy or locked|杀毒|防病毒|病毒|Defender|已被隔离|文件被占用|正在被使用/i.test(message) },
  { key: 'server', match: (message) => /(^|\D)(500|502|503|504)(\D|$)|internal server error|bad gateway|服务器(内部)?错误|服务暂时不可用/i.test(message) },
  { key: 'downloadTimeout', match: (message) => downloadContext(message) && networkFailure(message) },
  { key: 'timeout', match: (message) => networkFailure(message) },
]

function downloadContext(message: string): boolean {
  return /下载|安装|更新包|npm|registry|镜像/i.test(message)
}

function networkFailure(message: string): boolean {
  return /ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|超时|连接(失败|不上)|网络(不可用|异常|受限)?/i.test(message)
}

export function classifyOperationError(message: string): OperationErrorKey {
  return rules.find((rule) => rule.match(message))?.key ?? 'unknown'
}

/**
 * Catalog entries name their buttons in prose. Only the ones this app can
 * honour from a failure dialog are handed back; a label such as 「复制路径」
 * has no path to copy at that point, and 「以管理员身份重试」 has no elevated
 * retry channel, so offering either would be a button that does nothing.
 */
const actionIds: Record<string, OperationActionId | undefined> = {
  重试: 'retry',
  换官方源重试: 'retry',
  重新下载: 'retry',
  查看日志: 'log',
  看日志: 'log',
  找客服: 'support',
  重新登录: 'relogin',
  马上充值: 'recharge',
  检查网络: 'network',
}

export function presentOperationError(message: string): OperationErrorHint | null {
  const text = message.trim()
  if (!text) return null
  const key = classifyOperationError(text)
  if (key === 'unknown') return null
  const entry = errors[key]
  // The backend sometimes already speaks the catalog's own sentence (the
  // account layer reuses this wording). Repeating it as a heading above the
  // very same line reads as a bug, so leave those untouched.
  if (text.includes(entry.title)) return null
  const actions: OperationAction[] = []
  for (const label of entry.actions) {
    const id = actionIds[label]
    if (id) actions.push({ id, label })
  }
  return {
    key,
    title: entry.title,
    body: entry.body,
    // Every catalog action for this entry may be one this app cannot perform
    // (permission only offers an elevated retry). Falling back to 找客服 keeps
    // the dialog from ending on a dead end.
    actions: actions.length ? actions : [{ id: 'support', label: '找客服' }],
  }
}
