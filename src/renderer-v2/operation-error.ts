import { classifyNetworkFailure } from '../../electron/network-failure'
import { errors } from './registry/errors'

export type OperationErrorKey = keyof typeof errors
export type OperationActionId = 'retry' | 'log' | 'support' | 'relogin' | 'recharge' | 'network' | 'repair' | 'copyPath'
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
  // 磁盘满以前落进「操作没有成功」，用户只看到一句 ENOSPC 英文原文，被指去找客服。
  // 放在 permission 之前：npm 在写不下去时同时报过 EPERM 与 ENOSPC 的情况下，
  // 「清一清磁盘」才是用户真做得到的那一步。
  { key: 'diskFull', match: (message) => /ENOSPC|no space left|not enough space|磁盘空间不足|磁盘已满|disk full/i.test(message) },
  // 证书「已过期 / 还没生效」必须和「被换掉」分开：前者几乎都是这台电脑的时钟不对
  // （主板电池没电、装完系统没对时、时区改错），照「连接被证书拦截」那句去换网络，
  // 换几个热点都是同一个错。
  { key: 'certDate', match: (message) => classifyNetworkFailure(message) === 'certDate' },
  // 公司网关和安全软件会替换证书，npm 与账号接口因此拿到一张签不过的证书。归类
  // 口径直接用 electron/network-failure.ts 那一份（它已经同时认得 Chromium 的
  // ERR_CERT_* 和 OpenSSL 的 SELF_SIGNED_CERT_IN_CHAIN 这类写法），两边各写一套
  // 正则的话，迟早一边认得出、另一边认不出同一句话。
  // 这两条都必须排在 timeout 之前：那条的 network / 连接失败 会把证书失败吞成
  //「检查网络」，用户于是反复检查一个本来就通的网络。
  { key: 'tlsIntercepted', match: (message) => classifyNetworkFailure(message) === 'tls' },
  // safe-local-data 的写入校验（I8）拒绝经过目录联接的路径：「C 盘搬家」工具把
  // 用户文件夹或软件数据文件夹挪走之后，写 Key、存设置都会撞上这句。它看起来像
  // 权限问题，其实改权限、关杀毒都没用，所以排在 permission 之前单独认。
  { key: 'folderRelocated', match: (message) => /不能经过符号链接或目录联接/.test(message) },
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
 * 「一键修复」在这里的意思只有一个：对当前账号把已配置的工具重新签发一次 Key
 * 再写回配置，也就是装完工具后跑的那条同样的流程。它能进这张表，是因为那条
 * 流程本来就在（App 的 syncAfterToolInstalled），不需要为这颗按钮新做什么。
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
  // 与「检查网络」落到同一页（App 里 network → health），只是这里说的不是网络。
  打开检查页: 'network',
  一键修复: 'repair',
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

/**
 * 「查看日志」该落到哪一页。以前一律跳「安装卸载」页，于是连接检查、写 Key、
 * 拉起终端这些失败的用户点开的是一张空的「安装日志」卡（候选 8）。
 *
 * 判断分两步，因为两条线索缺一不可：
 * 1. 没有 tool 的失败根本不来自安装 / 卸载 / 更新（只有这三条路会把工具记下来），
 *    它们的痕迹只在 runtime.jsonl 里，要到「反馈」页看。
 * 2. 来自安装的失败再看类别：网络、证书、磁盘、权限、文件被占用、账号这些是
 *    环境问题，运行日志记得全；真正只有安装那一侧才写得出的（杀毒拦截、更新包
 *    校验、认不出的安装失败）才值得跳到「安装日志」卡。
 */
export type OperationLogPage = 'maintenance' | 'feedback'

const installLogKeys: ReadonlySet<OperationErrorKey> = new Set<OperationErrorKey>(['installBlocked', 'updateIntegrity', 'unknown'])

export function operationLogPage(failure: { message: string; tool?: string | undefined }): OperationLogPage {
  if (!failure.tool) return 'feedback'
  return installLogKeys.has(classifyOperationError(failure.message)) ? 'maintenance' : 'feedback'
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
