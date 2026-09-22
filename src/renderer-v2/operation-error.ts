import { errors } from './registry/errors'

export type OperationErrorKey = keyof typeof errors
export type OperationActionId = 'retry' | 'log' | 'support' | 'relogin' | 'recharge' | 'network' | 'copyPath'
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
  // backups.ts 抛的是「备份文件已损坏或被篡改」，不是「校验失败」——只认后者时
  // 这条目录文案对用户真正会遇到的那句话是死的。两种说法都收。
  { key: 'backupIntegrity', match: (message) => /备份[^。；]{0,12}(校验|完整性)[^。；]{0,8}(失败|不一致|无效)|备份[^。；]{0,12}(已损坏|被篡改)/.test(message) },
  // Only an update can promise "当前版本不受影响"; a first install has no
  // previous version to fall back to, so an integrity mismatch there keeps the
  // raw wording rather than borrowing a reassurance that would be false.
  { key: 'updateIntegrity', match: (message) => /更新|升级/.test(message) && /(SHA-512|完整性|校验)[^。；]{0,12}(失败|不一致|无效)/.test(message) },
  // safe-storage-backend.ts 的「当前系统没有可用的密钥环，安全存储只能以明文保存」。
  // 这不是权限问题：目录写得进去，是这台机器没有可用的凭据服务。
  { key: 'unsafeStorage', match: (message) => /密钥环|安全存储[^。；]{0,12}明文|只能以明文保存/.test(message) },
  // 更新和回滚要替换整个托管目录。Windows 上正在跑的 CLI 把自己的文件锁住，那是
  // 文件占用，不是杀毒拦截也不是权限不够——归到 installBlocked 会把用户送去关杀毒，
  // 方向全错。主进程在那一步会把话说成「文件被占用，……正在运行」
  // （electron/cli-process-probe.ts），npm 自己吐的 EBUSY 原文也归这里。
  // 必须排在 permission 之前：EPERM 的原文与文件占用长得一样，主进程确认到占用才会
  // 写上「文件被占用」，写了就以它为准。
  { key: 'toolRunning', match: (message) => /EBUSY|ETXTBSY|resource busy or locked|text file busy|文件被占用|正(在)?被[^。；]{0,10}占用|正在被使用/i.test(message) },
  { key: 'permission', match: (message) => /EPERM|EACCES|operation not permitted|permission denied|拒绝访问|访问被拒绝|权限不足|需要管理员/i.test(message) },
  // 「杀毒」这条只留真的在说杀毒软件的说法。EBUSY 与「文件被占用」已经上移到
  // toolRunning：两条都留着的话，先匹配到的那条就决定用户去关哪个东西。
  { key: 'installBlocked', match: (message) => /杀毒|防病毒|病毒|Defender|已被隔离/i.test(message) },
  // 「服务暂时不可用」is deliberately absent: features/auth/account-errors.ts
  // already turns that server error into a finished sentence, and re-wrapping a
  // finished sentence in a second heading reads as a bug.
  { key: 'server', match: (message) => /(^|\D)(500|502|503|504)(\D|$)|internal server error|bad gateway|服务器(内部)?错误/i.test(message) },
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
 * honour from a failure dialog are handed back; offering a label the app
 * cannot act on would be a button that does nothing.
 *
 * 「复制路径」自 A2 余项起接上：失败对话框知道是哪个工具失败的，安装目录
 * （已装）或主进程算出的首装落点（未装）都在快照里，拿得到就出这颗按钮，
 * 拿不到就不出（operationErrorActions 过滤）。
 *
 * 「以管理员身份重试」刻意留在表外，而且目录里也不再有它。本程序自 0.1.12
 * 起按普通权限运行，诊断页还把「以管理员身份运行」标成风险；Windows 上提权
 * 重试等于换一套安装事务（落点从用户 npm 目录变成 ProgramData），而 npm 会
 * 执行 registry 上的包脚本，把它交给提权令牌正是可信路径那套规矩拒绝的事；
 * macOS 从不提权。permission 这一类的下一步是看目录、看日志，不是提权。
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
  复制路径: 'copyPath',
}

/**
 * 「恢复」「还原」刻意不在这张表里：恢复备份失败本身就叫「恢复失败」，那是一次
 * 普通的操作失败，不是撤回没做成。
 *
 * 主进程在回滚也失败时会明说（system-service.ts 的「托管 npm 更新失败，且旧版本
 * 回滚失败」）。目录里几条文案的正文全是安抚——「当前版本不受影响」「已安装的
 * 工具不受影响」「未做任何改动」——把它们盖在这种句子上等于告诉用户没事。
 * 这种失败不套文案，让后端原话自己说话。
 */
function undoFailed(message: string): boolean {
  return /(回滚|回退|撤回)[^。；]{0,6}失败/.test(message)
}

function honourableActions(labels: readonly string[]): OperationAction[] {
  const actions: OperationAction[] = []
  for (const label of labels) {
    const id = actionIds[label]
    if (id) actions.push({ id, label })
  }
  return actions
}

/**
 * 认不出的失败也要有出口。errors.unknown 的按钮就是为这一格写的：没有它，
 * 用户读完一句英文原文只剩「返回」，下一步只能自己猜（issue #17 ④）。
 */
export function operationFallbackActions(): OperationAction[] {
  return honourableActions(errors.unknown.actions)
}

export function presentOperationError(message: string): OperationErrorHint | null {
  const text = message.trim()
  if (!text) return null
  if (undoFailed(text)) return null
  const key = classifyOperationError(text)
  if (key === 'unknown') return null
  const entry = errors[key]
  // The backend sometimes already speaks the catalog's own sentence (the
  // account layer reuses this wording). Repeating it as a heading above the
  // very same line reads as a bug, so leave those untouched.
  if (text.includes(entry.title)) return null
  const actions = honourableActions(entry.actions)
  return {
    key,
    title: entry.title,
    body: entry.body,
    // Every catalog action for this entry may be one this app cannot perform
    // （「看状态」「换一份」这些还没有对应页面）。Falling back to 找客服 keeps
    // the dialog from ending on a dead end.
    actions: actions.length ? actions : [{ id: 'support', label: '找客服' }],
  }
}
