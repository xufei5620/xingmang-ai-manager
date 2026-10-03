import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  HelpCircle,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react'
import { Button, Empty, Pill } from './ui'
import { errors } from './registry/errors'
import { presentOperationFailure } from './operation-error'
import { matchAccountErrorMessage } from './features/auth/account-errors'
import { redactSecretPatterns } from '../../electron/redaction-patterns'
import { isChineseSentence } from '../../electron/chinese-sentence'

const pendingOperations = new Map<symbol, string>()
export function pendingBusinessOperations() {
  return [...pendingOperations.values()]
}
export function beginBusinessOperation(label: string) {
  const id = Symbol(label)
  pendingOperations.set(id, label)
  return () => {
    pendingOperations.delete(id)
  }
}
// Electron 给渲染进程收到的 IPC 拒绝包成「Error invoking remote method '通道名':
// 类名: 真正的原因」（主进程那边的 error.toString()），通道名与错误类名都是实现细节，
// 不该上屏。类名只在紧跟通道名时才剥，避免把一句本来就以 Error: 开头的业务文案削掉
// 半截。类名不限以 Error 结尾：以前只认 …Error，Codex 桌面端装不上时的
// CodexDesktopInstallFailure 就带着英文类名进了错误框。每层只剥一个类名，原话开头的
// EPERM: 这类错误码照旧留着给错误分类认。冒号后面必须有空格（Electron 总会写一个）：
// 不然 C:\Users\… 的盘符会被当成类名剥掉，下面的路径脱敏就认不出这条路径了。
// legacy 的 src/error-message.ts 只剥前半截。
// 正则不带 g 标志以避免 lastIndex 状态问题。
const ipcPrefixPattern = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z_][A-Za-z0-9_]*:\s+)?/

/**
 * 只做取值与剥前缀，不做文案判断：`matchAccountErrorMessage` 与 `errorMessage` 的
 * 启发式分支都要在剥净前缀之后才匹配得准。legacy 侧的等价实现在
 * `src/error-message.ts`，两棵渲染树各留一份，理由同 I6/I7 与
 * `features/auth/account-errors.ts` 的说明。
 *
 * 与 legacy 的唯一差异：null/undefined 这里返回空串而不是「未知错误」，因为 v2 的
 * `errorMessage` 自己有按场景的兜底文案，返回中文会被误判成「服务端给出的中文原因」。
 */
export function rawErrorMessage(error: unknown) {
  let message: string
  if (error instanceof Error) {
    message = error.message
  } else if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    message = (error as { message: string }).message
  } else if (error === null || error === undefined) {
    message = ''
  } else {
    message = String(error)
  }
  // 一个 handler 再 invoke 另一个通道时前缀会嵌套多层，逐层剥净
  while (ipcPrefixPattern.test(message)) message = message.replace(ipcPrefixPattern, '')
  return message
}

/**
 * Renderer-facing errors must not expose absolute home/config paths. The main
 * process names the file it failed on (config-files.ts, backups.ts) and on
 * Windows that path carries the account name, so I13's redaction has to hold on
 * this side of the IPC boundary too.
 */
export function userFacingErrorMessage(error: unknown) {
  return rawErrorMessage(error)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .replace(/[A-Za-z]:\\(?:[^\s;；，。！？]+\\?)+/g, '本地配置文件')
    .replace(/(?:\\\\|\/Users\/|\/home\/)[^\s;；，。！？]+/g, '本地配置文件')
    .slice(0, 1_000)
}

/**
 * 主进程快照里的错误字段（`detectionError` / `configurationError`）不是被捕获的异常，
 * 走不到 `errorMessage`，但同样来自 `describeProbeFailure` 这类把 `Error.message` 原样
 * 透传的地方，句子里常带着 `C:\Users\<账号名>\...` 这样的绝对路径。上屏前统一过一遍
 * 同样的脱敏，I13 才在这条路径上也成立。
 *
 * 脱敏后为空时返回 null 而不是空串，好让调用点用 `??` 保留自己的中文兜底文案。
 */
export function snapshotErrorMessage(value: string | null | undefined) {
  return userFacingErrorMessage(value) || null
}

const detectionFailureCopy = {
  permission: '没有权限读取这个工具的文件，常见是安全软件拦了。点「重新检测」再试；还不行请在「反馈」页导出报告发给客服。',
  busy: '这个工具的文件正被别的程序占着。关掉正在用它的窗口，再点「重新检测」。',
  missing: '检测时有个文件找不到了，可能被安全软件拦了或被删掉了。点「重新检测」再试；还不行请在「反馈」页导出报告发给客服。',
  other: '检测这个工具时出了错，原因已经记进日志。点「重新检测」再试；还不行请在「反馈」页导出报告发给客服。',
}

/**
 * 原话是不是中文，不能直接看脱敏后的句子：路径已经换成了「本地配置文件」，这个占位词本身
 * 就是汉字，看整句的话英文报错一样会被当成中文。去掉占位词，剩下的交给主进程更新失败那句
 * 也在用的 isChineseSentence（去掉引号段和路径片段再看；用户名带空格时脱敏只剥到空格为止，
 * 剩下那截路径也算路径）。判不准时宁可当成英文：那样只是换成调用点自己的中文兜底句。
 *
 * 收的是已经脱过路径的句子（userFacingErrorMessage 的结果）。检测失败那句小字、按钮操作
 * （errorMessage）、新手引导、Key 同步原因都按它判（第三十批 A），别再各写一个「有没有汉字」。
 */
export function speaksChinese(safe: string) {
  return isChineseSentence(safe.replaceAll('本地配置文件', ' '))
}

/**
 * 工具行「检测失败」的那句小字（第二十六批 D）。`detectionError` 是 `describeProbeFailure`
 * 原样交过来的 `Error.message`，常是 `EPERM: operation not permitted, scandir 'C:\Users\…'`
 * 这种英文，脱敏后连引号都只剩半个：客户看得到却看不懂。英文原话由主进程在扫描完记一条
 * warn 进运行日志（ipc.ts 的 detection-failed），客服在反馈报告里看得到；这里只按错误码
 * 分四类说人话。原话本来是中文的照旧显示（只脱敏）。原话为空时返回 null，调用点用 `??`
 * 留自己的兜底句，同 `snapshotErrorMessage`。
 */
export function detectionFailureMessage(value: string | null | undefined) {
  const safe = snapshotErrorMessage(value)
  if (!safe || speaksChinese(safe)) return safe
  if (/\b(?:EPERM|EACCES)\b|not permitted|permission denied|access\b.*\bis denied|unauthorized ?access/i.test(safe)) return detectionFailureCopy.permission
  if (/\bEBUSY\b|resource busy|used by another process/i.test(safe)) return detectionFailureCopy.busy
  if (/\bENOENT\b|no such file or directory|cannot find|does not exist/i.test(safe)) return detectionFailureCopy.missing
  return detectionFailureCopy.other
}

const genericFailure = '操作没有成功，请重试或查看反馈日志。'

export function errorMessage(error: unknown, fallback = genericFailure) {
  // 服务端已经说清原因的（原密码错误、账号被封禁、注册关闭、数据库出错……）先走
  // 精确文案。new-api 默认回英文，英文原文会被下面的兜底抹成一句“操作没有成功”；
  // 中文原文虽然会原样透出，但也少了该怎么办的那半句。两种都让用户只能反复重试。
  const known = matchAccountErrorMessage(rawErrorMessage(error))
  if (known) return known
  // 判断语言与类别之前先脱敏：主进程抛的中文错误常带着绝对路径，不脱敏就会把用户名
  // 连同“原因”一起端上屏。是不是中文要按 speaksChinese 判：占位词「本地配置文件」本身
  // 就是汉字，只看有没有汉字的话，「EPERM: operation not permitted, open 'C:\…」这类
  // 带路径的英文会被当成中文原样上屏（第三十批 A）。原样上屏的中文也过一遍 Key 打码表：
  // 主进程把第三方的原话拼在中文后面时，不能连 Key 一起端上屏（第三十批 B，I13）。
  const safe = userFacingErrorMessage(error)
  if (speaksChinese(safe)) return redactSecretPatterns(safe)
  if (/401|unauthorized/i.test(safe)) return `${errors.sessionExpired.title}，${errors.sessionExpired.body}。`
  // 限流与超时是两回事：超时让人去查网络，限流只需要等几秒。没有这条，new-api 的英文
  // 限流原文会掉进最后的通用兜底，把「稍等几秒」说成「请重试或查看反馈日志」。
  // 只认 HTTP 429 与明确的限流措辞，不认裸的 429，避免把额度数字之类误判成限流。
  if (/HTTP\s*429|too\s*many\s*requests|rate[\s_-]?limit/i.test(safe)) {
    return `${errors.tooManyRequests.title}，${errors.tooManyRequests.body}。`
  }
  if (/timeout|ENOTFOUND|ECONN|fetch/i.test(safe)) return `${errors.timeout.title}，请检查网络后重试。`
  return fallback
}
export function displayDate(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return '暂未记录'
  const date = new Date(
    typeof value === 'number' && value < 1e12 ? value * 1000 : value,
  )
  return Number.isNaN(date.getTime())
    ? '时间不可用'
    : date.toLocaleString('zh-CN', { hour12: false })
}
export function dollars(amount: number | null | undefined) {
  return typeof amount === 'number' && Number.isFinite(amount)
    ? `$${amount.toFixed(2)}`
    : '暂未读到'
}
/**
 * 一次按钮操作失败后交给错误框的两样东西：上屏的那句（`message`，同 `errorMessage`），
 * 以及被兜底句换掉的原话（`detail`）。以前认不出的英文原话（`spawn EPERM`、`ENOSPC`
 * 这类）整句丢掉，错误框只剩「打开 Codex 桌面端没有完成」，客户和客服都不知道原因。
 *
 * 只有真的落到兜底句时才留 `detail`：401、限流、超时和账号服务那张表都已经换成了
 * 说清原因的中文，再附原话就成了两套说法。原话先脱路径（userFacingErrorMessage），
 * 再过日志和反馈报告同一张 Key 打码表（redaction-patterns.ts），只留前 160 字。
 */
export function operationFailureFrom(error: unknown, action?: string): { message: string; detail?: string } {
  return failureWithDetail(error, action ? `${action}没有完成` : '操作没有完成')
}
/**
 * `errorMessage` 加上被兜底句换掉的原话：错误框（operationFailureFrom）和页头红条
 * （useOperation → ResultNotice）共用这一份。带路径的英文（「EPERM: …, open 'C:\…」）
 * 换成兜底句以后，认得出是哪一类（文件被占用、磁盘满……）的记号只剩原话里有，
 * 页头红条要靠它保住原来的标题（第三十批 A）。
 */
export function failureWithDetail(error: unknown, fallback = genericFailure): { message: string; detail?: string } {
  const message = errorMessage(error, fallback)
  if (message !== fallback) return { message }
  const raw = supportDetailOf(error)
  if (!raw || raw === message) return { message }
  return { message, detail: raw }
}
/**
 * 「给客服看的原话」：先脱路径，再过 Key 打码表，只留前 160 字；空串 = 没有原话。
 * 错误框和新手引导的红字共用这一份，别各写一套打码。
 */
export function supportDetailOf(error: unknown): string {
  const raw = redactSecretPatterns(userFacingErrorMessage(error))
  return raw.length > 160 ? `${raw.slice(0, 159)}…` : raw
}
export function useResource<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const sequence = useRef(0)
  const reload = useCallback(async () => {
    const id = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const result = await load()
      if (id === sequence.current) setData(result)
    } catch (cause) {
      if (id === sequence.current) setError(errorMessage(cause))
    } finally {
      if (id === sequence.current) setLoading(false)
    }
  }, [load])
  useEffect(() => {
    setData(null)
    void reload()
    return () => {
      sequence.current++
    }
  }, [reload])
  return { data, setData, loading, error, reload }
}
/**
 * 导出类操作成功后，除了那句话还要带上写出的文件，好让提示条给一颗「打开所在
 * 位置」。路径只拿来回传给主进程，主进程只认它自己刚写过的文件。
 */
export interface OperationNotice {
  text: string
  revealPath: string
}
export function useOperation() {
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [revealPath, setRevealPath] = useState('')
  const [error, setError] = useState('')
  // 页头红条只认上屏那句时，落到兜底句的失败就认不出类别了；原话跟着交给 ResultNotice。
  const [detail, setDetail] = useState('')
  const lock = useRef(false)
  const execute = async <T,>(
    name: string,
    action: () => Promise<T>,
    success:
      | string
      | ((result: T) => string | OperationNotice | null) = '操作已完成',
  ) => {
    if (lock.current) return false
    lock.current = true
    const finish = beginBusinessOperation(name)
    setBusy(name)
    setError('')
    setDetail('')
    setMessage('')
    setRevealPath('')
    try {
      const result = await action()
      // A native save dialog the user dismisses resolves with null instead of
      // throwing, so a resolver may decline the success line rather than let the
      // page claim an export that never happened.
      const notice = typeof success === 'function' ? success(result) : success
      if (typeof notice === 'string') {
        if (notice) setMessage(notice)
      } else if (notice) {
        setMessage(notice.text)
        setRevealPath(notice.revealPath)
      }
      return true
    } catch (cause) {
      const failure = failureWithDetail(cause)
      setError(failure.message)
      setDetail(failure.detail ?? '')
      return false
    } finally {
      finish()
      lock.current = false
      setBusy('')
    }
  }
  return {
    busy,
    message,
    revealPath,
    error,
    detail,
    execute,
    clear: () => {
      setMessage('')
      setRevealPath('')
      setError('')
      setDetail('')
    },
  }
}
/**
 * 定位失败（文件被挪走、被删）只在按钮旁边说一句，不顶掉上面那句「已导出」：
 * 用户还要照着那串路径自己去找。
 */
function RevealExportedFile({
  path,
  onReveal,
}: {
  path: string
  onReveal: (path: string) => Promise<unknown>
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        icon={FolderOpen}
        loading={busy}
        onClick={async () => {
          setBusy(true)
          setFailure('')
          try {
            await onReveal(path)
          } catch (cause) {
            setFailure(errorMessage(cause))
          } finally {
            setBusy(false)
          }
        }}
        testId="result-notice-reveal"
      >
        打开所在位置
      </Button>
      {failure && (
        <em className="v2-business-notice-detail" role="alert">
          {failure}
        </em>
      )}
    </>
  )
}
export function ResultNotice({
  error,
  detail,
  message,
  revealPath,
  onReveal,
  onSupport,
}: {
  error?: string
  /**
   * 被兜底句换掉的原话（useOperation 给的），只拿来认类别，不上屏：上屏那句认不出时
   * 再看它，和错误框一个认法（presentOperationFailure）。
   */
  detail?: string
  message?: string
  revealPath?: string
  onReveal?: (path: string) => Promise<unknown>
  /** 给了才出「联系客服」：只在目录说这类失败该找客服时出现。 */
  onSupport?: () => void
}) {
  // A raw npm/OS failure reaching this banner is unreadable on its own; when
  // the catalog can name it, its wording leads and the backend sentence stays
  // underneath, because support still needs the original text.
  const hint = error ? presentOperationFailure({ message: error, detail }) : null
  return error ? (
    <div className="v2-business-notice is-error" role="alert">
      <Pill tone="bad">未完成</Pill>
      <span>
        {hint ? (
          <>
            <strong>{hint.title}</strong>
            {hint.body ? `，${hint.body}` : ''}
            <em className="v2-business-notice-detail">{error}</em>
          </>
        ) : (
          error
        )}
      </span>
      {onSupport && hint?.actions.some((action) => action.id === 'support') && (
        <Button size="sm" icon={HelpCircle} onClick={onSupport} testId="result-notice-support">
          联系客服
        </Button>
      )}
    </div>
  ) : message ? (
    <div className="v2-business-notice" role="status">
      <Pill tone="ok">已完成</Pill>
      <span>{message}</span>
      {revealPath && onReveal && (
        <RevealExportedFile key={revealPath} path={revealPath} onReveal={onReveal} />
      )}
    </div>
  ) : null
}
export function ListState({
  page,
  noun,
  loading,
  error,
  count,
  filtered,
  retry,
  clear,
  action,
  children,
}: {
  page: string
  noun: string
  loading: boolean
  error: string
  count: number
  filtered?: boolean
  retry: () => void
  clear?: () => void
  action?: ReactNode
  children: ReactNode
}) {
  if (loading && !count)
    return (
      <div
        className="v2-business-loading"
        role="status"
        data-testid={`${page}-loading`}
      >
        <RefreshCw size={24} className="xm-spin" />
        <strong>正在读取{noun}…</strong>
        <p>请稍等，正在整理列表。</p>
      </div>
    )
  if (error)
    return (
      <>
        <Empty
          testId={`${page}-error`}
          icon={XCircle}
          title={`${noun}暂时没有读到`}
          description={error}
          action={
            <Button
              size="sm"
              icon={RefreshCw}
              onClick={retry}
              testId={`${page}-retry`}
            >
              重新加载
            </Button>
          }
        />
        {count > 0 && children}
      </>
    )
  if (!count)
    return (
      <Empty
        testId={`${page}-${filtered ? 'filter-empty' : 'empty'}`}
        icon={filtered ? Search : Archive}
        title={filtered ? '没有符合条件的结果' : `还没有${noun}`}
        description={
          filtered
            ? '试试其他关键词，或清空筛选。'
            : page === 'sessions'
              ? '在 AI 工具里开始一次对话，记录就会出现在这里。'
              : '从页面上的添加入口开始。'
        }
        action={
          filtered ? (
            <Button size="sm" onClick={clear} testId={`${page}-clear`}>
              清空筛选
            </Button>
          ) : (
            action
          )
        }
      />
    )
  return (
    <>
      {loading && <span role="status">正在刷新…</span>}
      {children}
    </>
  )
}
/**
 * 当前页超出了总页数（比如撤销了末页最后一项）时该退到哪一页；没超出返回 null。
 * 不收敛的话列表是空的，页码写「2 / 1」（#496）。
 */
export function overflowedPage(page: number, total: number, size = 20): number | null {
  const pages = Math.max(1, Math.ceil(total / size))
  return page > pages ? pages : null
}
export function Pagination({
  page,
  total,
  size = 20,
  onChange,
}: {
  page: number
  total: number
  size?: number
  onChange: (page: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / size))
  return (
    <div className="v2-business-pagination">
      <span>共 {total} 条</span>
      <Button
        size="sm"
        icon={ChevronLeft}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        上一页
      </Button>
      <span>
        {page} / {pages}
      </span>
      <Button
        size="sm"
        icon={ChevronRight}
        disabled={page >= pages}
        onClick={() => onChange(page + 1)}
      >
        下一页
      </Button>
    </div>
  )
}
