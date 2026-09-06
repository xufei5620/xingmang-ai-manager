import { useId, useRef, type ReactNode } from 'react'
import { adjacentOption, type UiOption, type UiSize } from './types'

export interface TabsProps<T extends string = string> {
  label: string
  items: ReadonlyArray<UiOption<T> & { content: ReactNode }>
  value: T
  onChange: (value: T) => void
  orientation?: 'horizontal' | 'vertical'
  activation?: 'manual' | 'automatic'
  testId?: string
}

export function Tabs<T extends string>({ label, items, value, onChange, orientation = 'horizontal', activation = 'manual', testId }: TabsProps<T>) {
  const id = useId()
  const refs = useRef(new Map<T, HTMLButtonElement>())
  const tabStop = items.find((item) => item.value === value && !item.disabled)?.value ?? items.find((item) => !item.disabled)?.value
  return (
    <div className="ui-tabs" data-orientation={orientation} data-testid={testId}>
      <div className="ui-tablist" role="tablist" aria-label={label} aria-orientation={orientation}>
        {items.map(({ value: itemValue, label: itemLabel, icon: Icon, disabled }, index) => (
          <button key={itemValue} ref={(element) => { if (element) refs.current.set(itemValue, element); else refs.current.delete(itemValue) }}
            className="ui-tab" type="button" role="tab" id={`${id}-tab-${index}`} aria-controls={`${id}-panel-${index}`}
            aria-selected={value === itemValue} tabIndex={tabStop === itemValue ? 0 : -1} disabled={disabled}
            onClick={() => onChange(itemValue)} onKeyDown={(event) => {
              const next = adjacentOption(items, itemValue, event.key, orientation)
              if (next === null) return
              event.preventDefault()
              refs.current.get(next)?.focus()
              if (activation === 'automatic') onChange(next)
            }}>
            {Icon && <Icon size={16} aria-hidden="true" />}{itemLabel}
          </button>
        ))}
      </div>
      {items.map((item, index) => (
        <div key={item.value} className="ui-tabpanel" role="tabpanel" id={`${id}-panel-${index}`}
          aria-labelledby={`${id}-tab-${index}`} tabIndex={0} hidden={item.value !== value}>
          {item.content}
        </div>
      ))}
    </div>
  )
}

export interface SegmentProps<T extends string = string> {
  label: string
  options: ReadonlyArray<UiOption<T>>
  value: T
  onChange: (value: T) => void
  size?: UiSize
  disabled?: boolean
  testId?: string
}

export function Segment<T extends string>({ label, options, value, onChange, size = 'md', disabled, testId }: SegmentProps<T>) {
  const refs = useRef(new Map<T, HTMLButtonElement>())
  const tabStop = options.find((item) => item.value === value && !item.disabled)?.value ?? options.find((item) => !item.disabled)?.value
  return (
    <div className="ui-segment" role="group" aria-label={label} data-size={size} data-testid={testId}>
      {options.map(({ value: itemValue, label: itemLabel, icon: Icon, disabled: itemDisabled }) => (
        <button key={itemValue} type="button" ref={(element) => { if (element) refs.current.set(itemValue, element); else refs.current.delete(itemValue) }}
          aria-pressed={value === itemValue} tabIndex={!disabled && tabStop === itemValue ? 0 : -1} disabled={disabled || itemDisabled}
          onClick={() => onChange(itemValue)} onKeyDown={(event) => {
            const next = adjacentOption(options, itemValue, event.key)
            if (next === null) return
            event.preventDefault()
            refs.current.get(next)?.focus()
            onChange(next)
          }}>
          {Icon && <Icon size={16} aria-hidden="true" />}{itemLabel}
        </button>
      ))}
    </div>
  )
}
