import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  XCircle,
} from 'lucide-react'
import { Button, Empty, Pill } from './ui'
import { errors } from './registry/errors'

const pendingOperations = new Map<symbol, string>()
export const pendingBusinessOperations = () => [...pendingOperations.values()]
export function beginBusinessOperation(label: string) {
  const id = Symbol(label)
  pendingOperations.set(id, label)
  return () => {
    pendingOperations.delete(id)
  }
}
export const errorMessage = (error: unknown) =>
  error instanceof Error && /[\u3400-\u9fff]/.test(error.message)
    ? error.message
    : error instanceof Error && /401|unauthorized/i.test(error.message)
      ? `${errors.sessionExpired.title}，${errors.sessionExpired.body}。`
      : error instanceof Error &&
          /timeout|ENOTFOUND|ECONN|fetch/i.test(error.message)
        ? `${errors.timeout.title}，请检查网络后重试。`
        : '操作没有成功，请重试或查看反馈日志。'
export const displayDate = (value: string | number | null | undefined) => {
  if (value === null || value === undefined || value === '') return '暂未记录'
  const date = new Date(
    typeof value === 'number' && value < 1e12 ? value * 1000 : value,
  )
  return Number.isNaN(date.getTime())
    ? '时间不可用'
    : date.toLocaleString('zh-CN', { hour12: false })
}
export const dollars = (amount: number | null | undefined) =>
  typeof amount === 'number' && Number.isFinite(amount)
    ? `$${amount.toFixed(2)}`
    : '暂未读到'
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
export function useOperation() {
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const lock = useRef(false)
  const execute = async (
    name: string,
    action: () => Promise<unknown>,
    success = '操作已完成',
  ) => {
    if (lock.current) return false
    lock.current = true
    const finish = beginBusinessOperation(name)
    setBusy(name)
    setError('')
    setMessage('')
    try {
      await action()
      setMessage(success)
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
    error,
    execute,
    clear: () => {
      setMessage('')
      setError('')
    },
  }
}
export function ResultNotice({
  error,
  message,
}: {
  error?: string
  message?: string
}) {
  return error ? (
    <div className="v2-business-notice is-error" role="alert">
      <Pill tone="bad">未完成</Pill>
      <span>{error}</span>
    </div>
  ) : message ? (
    <div className="v2-business-notice" role="status">
      <Pill tone="ok">已完成</Pill>
      <span>{message}</span>
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
