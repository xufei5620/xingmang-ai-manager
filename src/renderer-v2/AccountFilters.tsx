import { useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { Button, Input, Select } from './ui'
import { errorMessage, ResultNotice } from './business-common'

export interface AccountFilterField {
  key: string
  label: string
  type?: 'datetime-local'
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

export function AccountFilters({
  fields,
  onApply,
}: {
  fields: AccountFilterField[]
  onApply: (values: Record<string, string>) => void
}) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const apply = () => {
    setError('')
    try {
      accountTimeRange(draft.start, draft.end)
      onApply(draft)
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }
  return (
    <div className="v2-business-filters">
      <div>
        {fields.map((field) =>
          field.options ? (
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
          ),
        )}
      </div>
      <div className="v2-business-control">
        <Button variant="primary" icon={Search} onClick={apply}>
          查询
        </Button>
        <Button
          icon={RefreshCw}
          onClick={() => {
            setDraft({})
            setError('')
            onApply({})
          }}
        >
          重置筛选
        </Button>
      </div>
      <ResultNotice error={error} />
    </div>
  )
}
