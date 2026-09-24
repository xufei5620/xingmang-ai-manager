import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react'
import { Button, Empty, Pill } from './ui'
import { errors } from './registry/errors'
import { presentOperationError } from './operation-error'
import { matchAccountErrorMessage } from './features/auth/account-errors'

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
// Error: 真正的原因」，通道名与错误类名都是实现细节，不该上屏。类名只在紧跟通道名时
// 才剥，避免把一句本来就以 Error: 开头的业务文案削掉半截。legacy 的
// src/error-message.ts 只剥前半截，v2 这边与 features/app/account-read-error.ts、
// features/shell/Announcement.tsx 已有的处理保持一致。
// 正则不带 g 标志以避免 lastIndex 状态问题。
const ipcPrefixPattern = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z0-9_]*Error:\s*)?/

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

export function errorMessage(error: unknown, fallback = '操作没有成功，请重试或查看反馈日志。') {
  // 服务端已经说清原因的（原密码错误、账号被封禁、注册关闭、数据库出错……）先走
  // 精确文案。new-api 默认回英文，英文原文会被下面的兜底抹成一句“操作没有成功”；
  // 中文原文虽然会原样透出，但也少了该怎么办的那半句。两种都让用户只能反复重试。
  const known = matchAccountErrorMessage(rawErrorMessage(error))
  if (known) return known
  // 判断语言与类别之前先脱敏：主进程抛的中文错误常带着绝对路径，不脱敏就会把用户名
  // 连同“原因”一起端上屏。
  const safe = userFacingErrorMessage(error)
  if (/[\u3400-\u9fff]/.test(safe)) return safe
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
      setError(errorMessage(cause))
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
    execute,
    clear: () => {
      setMessage('')
      setRevealPath('')
      setError('')
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
  message,
  revealPath,
  onReveal,
}: {
  error?: string
  message?: string
  revealPath?: string
  onReveal?: (path: string) => Promise<unknown>
}) {
  // A raw npm/OS failure reaching this banner is unreadable on its own; when
  // the catalog can name it, its wording leads and the backend sentence stays
  // underneath, because support still needs the original text.
  const hint = error ? presentOperationError(error) : null
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
