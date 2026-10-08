import { useState } from 'react'
import { ChevronDown, ChevronUp, RefreshCw, Search } from 'lucide-react'
import { Button, Input, Select } from './ui'
import { errorMessage, ResultNotice } from './business-common'

export interface AccountFilterField {
  key: string
  label: string
  type?: 'datetime-local' | 'date' | 'number'
  options?: Array<{ value: string; label: string }>
}
export function accountTimeRange(
  start: string | undefined,
  end: string | undefined,
) {
  const startTimestamp = start
    ? Math.floor(new Date(start).getTime() / 1000)
    : undefined
  const endTimestamp = end
    ? Math.floor(new Date(end).getTime() / 1000)
    : undefined
  if (
    (startTimestamp !== undefined && !Number.isFinite(startTimestamp)) ||
    (endTimestamp !== undefined && !Number.isFinite(endTimestamp))
  )
    throw new Error('请选择有效的开始和结束时间。')
  if (
    startTimestamp !== undefined &&
    endTimestamp !== undefined &&
    startTimestamp > endTimestamp
  )
    throw new Error('开始时间不能晚于结束时间。')
  return { startTimestamp, endTimestamp }
}

/**
 * 收着时「展开筛选」后面那个数：收起来的那几个框里，查询时填了的有几个。
 * 第一行常驻的不算（看得见），填了没点「查询」的也不算（还没生效）。
 */
export function hiddenFilterCount(fields: readonly AccountFilterField[], primary: readonly string[], applied: Record<string, string>): number {
  return fields.filter((field) => !primary.includes(field.key) && (applied[field.key] ?? '') !== '').length
}

export function AccountFilters({
  fields,
  primary,
  onApply,
  initialValues = {},
}: {
  fields: AccountFilterField[]
  /** 第一行常驻的那几个框（填 key），其余收在「展开筛选」里；缺省 = 全部常驻。 */
  primary?: readonly string[]
  onApply: (values: Record<string, string>) => void
  initialValues?: Record<string, string>
}) {
  const [draft, setDraft] = useState<Record<string, string>>(initialValues)
  const [applied, setApplied] = useState<Record<string, string>>(initialValues)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const collapsible = Boolean(primary) && fields.some((field) => !primary?.includes(field.key))
  const active = collapsible && primary ? hiddenFilterCount(fields, primary, applied) : 0
  const apply = () => {
    setError('')
    try {
      accountTimeRange(draft.start, draft.end)
      onApply(draft)
      setApplied(draft)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  const reset = () => {
    setDraft(initialValues)
    setApplied(initialValues)
    setError('')
    onApply(initialValues)
  }
  function control(field: AccountFilterField) {
    return field.options ? (
      <Select
        key={field.key}
        label={field.label}
        aria-label={field.label}
        options={field.options}
        value={draft[field.key] ?? ''}
        onChange={(event) =>
          setDraft((value) => ({
            ...value,
            [field.key]: event.target.value,
          }))
        }
      />
    ) : (
      <Input
        key={field.key}
        label={field.label}
        aria-label={field.label}
        type={field.type}
        value={draft[field.key] ?? ''}
        onChange={(event) =>
          setDraft((value) => ({
            ...value,
            [field.key]: event.target.value,
          }))
        }
      />
    )
  }
  if (!collapsible)
    return (
      <div className="v2-business-filters">
        <div>{fields.map(control)}</div>
        <div className="v2-business-control">
          <Button variant="primary" icon={Search} onClick={apply}>
            查询
          </Button>
          <Button icon={RefreshCw} onClick={reset}>
            重置筛选
          </Button>
        </div>
        <ResultNotice error={error} />
      </div>
    )
  // 第一行只放最常用的几个框和「查询」，其余收起来，表格不被筛选框挤到第一屏外面。
  return (
    <div className="v2-business-filters is-collapsible">
      <div className="v2-business-filters-main">
        {fields.filter((field) => primary?.includes(field.key)).map(control)}
        <div className="v2-business-control">
          <Button variant="primary" icon={Search} onClick={apply}>
            查询
          </Button>
          <Button
            icon={open ? ChevronUp : ChevronDown}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            testId="account-filters-toggle"
          >
            {open ? '收起筛选' : active ? `展开筛选 · ${active}` : '展开筛选'}
          </Button>
        </div>
      </div>
      {open && (
        <>
          <div className="v2-business-filters-more">{fields.filter((field) => !primary?.includes(field.key)).map(control)}</div>
          <div className="v2-business-control">
            <Button icon={RefreshCw} onClick={reset}>
              重置筛选
            </Button>
          </div>
        </>
      )}
      <ResultNotice error={error} />
    </div>
  )
}
