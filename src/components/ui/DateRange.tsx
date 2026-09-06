import { useId } from 'react'
import { FieldError } from './Fields'
import './ui.css'
import './interactions.css'

export interface DateRangeValue { start: string; end: string }
export interface DateRangeProps {
  label: string
  value: DateRangeValue
  onChange(value: DateRangeValue): void
  startLabel?: string
  endLabel?: string
  precision?: 'date' | 'datetime'
  min?: string
  max?: string
  disabled?: boolean
  error?: string
  testId?: string
}

export function validateDateRange(value: DateRangeValue, limits: { min?: string; max?: string } = {}): string | undefined {
  const timestamp = (value: string) => {
    if (!value) return undefined
    const date = new Date(value.includes('T') ? value : `${value}T00:00:00`)
    const datePart = value.split('T')[0]
    const [year, month, day] = datePart.split('-').map(Number)
    return Number.isFinite(date.getTime()) && date.getFullYear() === year && date.getMonth() + 1 === month && date.getDate() === day ? date.getTime() : Number.NaN
  }
  const start = timestamp(value.start)
  const end = timestamp(value.end)
  if (Number.isNaN(start) || Number.isNaN(end)) return '请输入有效日期'
  const min = timestamp(limits.min ?? '')
  const max = timestamp(limits.max ?? '')
  if ([start, end].some((date) => date !== undefined && ((min !== undefined && date < min) || (max !== undefined && date > max)))) return '日期超出允许范围'
  return start !== undefined && end !== undefined && start > end ? '开始时间不能晚于结束时间' : undefined
}

export function DateRange({ label, value, onChange, startLabel = '开始日期', endLabel = '结束日期', precision = 'date', min, max, disabled, error, testId }: DateRangeProps) {
  const id = useId()
  const failure = error ?? validateDateRange(value, { min, max })
  const type = precision === 'datetime' ? 'datetime-local' : 'date'
  const startMax = value.end && max ? (value.end < max ? value.end : max) : value.end || max
  const endMin = value.start && min ? (value.start > min ? value.start : min) : value.start || min
  return <fieldset className="ui-date-range" aria-label={label} disabled={disabled} data-testid={testId}>
    <label className="ui-field" htmlFor={`${id}-start`}><span className="ui-field-label">{startLabel}</span><input id={`${id}-start`} className="ui-input" type={type} value={value.start} min={min} max={startMax} aria-invalid={failure ? true : undefined} aria-describedby={failure ? `${id}-error` : undefined} onChange={(event) => onChange({ ...value, start: event.target.value })} /></label>
    <label className="ui-field" htmlFor={`${id}-end`}><span className="ui-field-label">{endLabel}</span><input id={`${id}-end`} className="ui-input" type={type} value={value.end} min={endMin} max={max} aria-invalid={failure ? true : undefined} aria-describedby={failure ? `${id}-error` : undefined} onChange={(event) => onChange({ ...value, end: event.target.value })} /></label>
    {failure && <FieldError id={`${id}-error`}>{failure}</FieldError>}
  </fieldset>
}
