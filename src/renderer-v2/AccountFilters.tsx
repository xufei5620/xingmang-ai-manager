import { useState, type ReactNode } from 'react'
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
 * 第一行常驻的不算（看得见），填了没点「查询」的也不算（还没生效），还是默认值的也不算
 * （历史账号默认就带着最近 7 天的日期）。
 */
export function hiddenFilterCount(fields: readonly AccountFilterField[], primary: readonly string[], applied: Record<string, string>, initial: Record<string, string> = {}): number {
  return fields.filter((field) => !primary.includes(field.key) && (applied[field.key] ?? '') !== '' && applied[field.key] !== initial[field.key]).length
}

function sameFilterValues(left: Record<string, string>, right: Record<string, string>): boolean {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) => (left[key] ?? '') === (right[key] ?? ''))
}

/**
 * 默认值往前走了（历史账号默认最近 7 个日历日，页面挂在托盘里过了夜，#1093 第 1 条）：还停在旧默认上的
 * 那几格换成新的，用户自己填了别的的不动。
 */
export function rollFilterDefaults(values: Record<string, string>, previous: Record<string, string>, next: Record<string, string>): Record<string, string> {
  const result = { ...values }
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if ((values[key] ?? '') === (previous[key] ?? '')) result[key] = next[key] ?? ''
  }
  return result
}

export function AccountFilters({
  fields,
  primary,
  onApply,
  onReset,
  initialValues = {},
  note,
}: {
  fields: AccountFilterField[]
  /**
   * 第一行常驻的那几个框（填 key），其余收在「展开筛选」里；缺省 = 全部常驻。
   * 给空数组 = 全部收起来（用量账单 v4）：平时只有「展开筛选」一颗按钮，跟所在那一行的别的控件排在一起。
   */
  primary?: readonly string[]
  onApply: (values: Record<string, string>) => void
  /** 「重置筛选」另有去处（历史账号回到跟着日子走的默认日期）；缺省 = 把默认值当一次查询交给 onApply。 */
  onReset?: () => void
  initialValues?: Record<string, string>
  /** 展开后框下面那行说明（历史账号按整日统计那句）；缺省 = 没有。 */
  note?: ReactNode
}) {
  const [draft, setDraft] = useState<Record<string, string>>(initialValues)
  const [applied, setApplied] = useState<Record<string, string>>(initialValues)
  const [defaults, setDefaults] = useState(initialValues)
  if (!sameFilterValues(defaults, initialValues)) {
    setDefaults(initialValues)
    setDraft((value) => rollFilterDefaults(value, defaults, initialValues))
    setApplied((value) => rollFilterDefaults(value, defaults, initialValues))
  }
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const collapsible = Boolean(primary) && fields.some((field) => !primary?.includes(field.key))
  const active = collapsible && primary ? hiddenFilterCount(fields, primary, applied, initialValues) : 0
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
    if (onReset) onReset()
    else onApply(initialValues)
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
  const toggle = (
    <Button
      icon={open ? ChevronUp : ChevronDown}
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
      testId="account-filters-toggle"
    >
      {open ? '收起筛选' : active ? `展开筛选 · ${active}` : '展开筛选'}
    </Button>
  )
  // 全部收起来：外层不占一个盒子（display: contents），按钮落在所在那一行最右边，展开的框另起一整行。
  if (primary?.length === 0)
    return (
      <div className="v2-business-filters is-folded">
        {toggle}
        {open && (
          <div className="v2-business-filters-panel">
            <div className="v2-business-filters-more">{fields.map(control)}</div>
            {note && <p className="v2-business-filters-note">{note}</p>}
            <div className="v2-business-control">
              <Button variant="primary" icon={Search} onClick={apply}>
                查询
              </Button>
              <Button icon={RefreshCw} onClick={reset}>
                重置筛选
              </Button>
            </div>
          </div>
        )}
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
          {toggle}
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
