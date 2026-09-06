import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, LoaderCircle } from 'lucide-react'
import { FloatingSurface } from './Floating'
import { FieldError } from './Fields'
import type { UiSize } from './types'
import './ui.css'

export interface ComboboxOption { value: string; label: string; description?: string; disabled?: boolean; keywords?: string }
export interface ComboboxProps {
  label: string
  value: string
  onChange(value: string): void
  options: readonly ComboboxOption[]
  id?: string
  placeholder?: string
  allowCustomValue?: boolean
  disabled?: boolean
  error?: string
  loading?: boolean
  size?: UiSize
  testId?: string
}

export function filterComboboxOptions(options: readonly ComboboxOption[], query: string): readonly ComboboxOption[] {
  const needle = query.trim().toLocaleLowerCase()
  return needle ? options.filter((option) => `${option.label} ${option.value} ${option.keywords ?? ''}`.toLocaleLowerCase().includes(needle)) : options
}

export function Combobox({ label, value, onChange, options, id: suppliedId, placeholder, allowCustomValue = false, disabled = false, error, loading = false, size = 'md', testId }: ComboboxProps) {
  const generatedId = useId()
  const id = suppliedId ?? generatedId
  const listId = `${id}-list`
  const input = useRef<HTMLInputElement>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const composing = useRef(false)
  const selectedLabel = options.find((option) => option.value === value)?.label ?? value
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState(selectedLabel)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const filtered = useMemo(() => filterComboboxOptions(options, filter), [options, filter])
  const visible = useMemo(() => allowCustomValue && filter.trim() && !options.some((option) => option.value === filter.trim())
    ? [...filtered, { value: filter.trim(), label: filter.trim(), description: '使用此值' }]
    : filtered, [allowCustomValue, filter, filtered, options])
  const enabled = useMemo(() => visible.filter((option) => !option.disabled), [visible])
  const currentIndex = visible.findIndex((option) => option.value === active && !option.disabled)
  const activeId = open && currentIndex >= 0 ? `${id}-option-${currentIndex}` : undefined
  useEffect(() => { if (!open) setQuery(selectedLabel) }, [selectedLabel, open])
  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])
  useEffect(() => {
    if (open && !enabled.some((option) => option.value === active)) setActive(enabled[0]?.value ?? null)
  }, [open, enabled, active])
  const begin = () => { if (disabled) return; setFilter(''); setActive(value || null); setOpen(true) }
  const close = () => { setOpen(false); setFilter(''); setQuery(selectedLabel) }
  const select = (option: ComboboxOption) => {
    if (option.disabled) return
    onChange(option.value)
    setQuery(option.label)
    setOpen(false)
    setFilter('')
    input.current?.focus({ preventScroll: true })
  }
  return <div className="ui-field ui-combobox">
    <label className="ui-field-label" htmlFor={id}>{label}</label>
    <div className="ui-combobox-control" ref={anchor}>
      <input ref={input} id={id} className="ui-input" data-testid={testId} data-size={size} value={query} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listId : undefined} aria-activedescendant={activeId}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} disabled={disabled} placeholder={placeholder} autoComplete="off"
        onFocus={() => { if (!open) begin() }} onClick={() => { if (!open) begin() }}
        onChange={(event) => { setQuery(event.target.value); setFilter(event.target.value); setOpen(true) }}
        onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }}
        onBlur={(event) => { if (!event.relatedTarget || !document.getElementById(listId)?.contains(event.relatedTarget)) close() }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return
          if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return }
          if (event.key === 'Tab') { close(); return }
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation()
            if (!open) { begin(); return }
            const index = enabled.findIndex((option) => option.value === active)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : event.key === 'ArrowDown' ? (index + 1) % enabled.length : (index - 1 + enabled.length) % enabled.length
            const option = enabled[next]
            if (option) { setActive(option.value); document.getElementById(`${id}-option-${visible.indexOf(option)}`)?.scrollIntoView({ block: 'nearest' }) }
          }
          if (event.key === 'Enter' && open && currentIndex >= 0) { event.preventDefault(); event.stopPropagation(); select(visible[currentIndex]) }
        }} />
      <button type="button" className="ui-combobox-toggle" disabled={disabled} aria-label={`${open ? '收起' : '展开'}${label}选项`} tabIndex={-1}
        onMouseDown={(event) => event.preventDefault()} onClick={() => { if (open) close(); else { input.current?.focus(); begin() } }}>{loading ? <LoaderCircle size={16} className="ui-spinner" aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}</button>
    </div>
    {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    {open && <FloatingSurface anchor={anchor} role="listbox" id={listId} label={label} className="ui-combobox-list" width="anchor" onDismiss={close}>
      {loading && <div className="ui-combobox-empty" role="status">正在读取选项</div>}
      {!loading && visible.length === 0 && <div className="ui-combobox-empty" role="status">没有匹配项</div>}
      {visible.map((option, index) => <div key={`${option.value}-${index}`} id={`${id}-option-${index}`} role="option" aria-selected={option.value === value} aria-disabled={option.disabled || undefined}
        className="ui-combobox-option" data-active={active === option.value || undefined} onMouseDown={(event) => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(option.value) }} onClick={() => select(option)}>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>{option.value === value && <Check size={15} aria-hidden="true" />}
      </div>)}
    </FloatingSurface>}
  </div>
}
