import { useId, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { Menu } from '../../ui'

export interface PickerOption { value: string; label: string; description?: string; disabled?: boolean }

/**
 * 带说明的下拉（v4 原型的 dd）：每一项一行名字、一行灰字。原生 select 一项只能写一行，
 * 密钥的掩码和分组只好挤在名字后面，同名的两把分不清（原型把它们挪到第二行）。
 * 选中的值挂在按钮的 data-value 上，按钮自己就是测试找的那一格；每一项是 `<testId>-option-<值>`。
 * onOpen 在每次点开时调一次，点收起不调（配置框靠它点开就刷新一遍密钥列表）。
 */
export function OptionPicker({ label, aside, value, options, disabled, testId, onChange, onOpen }: {
  label: string
  aside?: ReactNode
  value: string
  options: PickerOption[]
  disabled?: boolean
  testId?: string
  onChange(value: string): void
  onOpen?(): void
}) {
  const labelId = useId()
  const valueId = useId()
  const selected = options.find((option) => option.value === value)
  return <div className="xm-field v2-option-picker">
    <div className="v2-option-picker-head"><span id={labelId}>{label}</span>{aside}</div>
    <Menu align="start" label={label} panelClassName="v2-option-picker-pop" items={options.map((option) => ({
      label: option.label, description: option.description, checked: option.value === value, disabled: option.disabled,
      testId: testId ? `${testId}-option-${option.value}` : undefined, onSelect: () => { if (option.value !== value) onChange(option.value) },
    }))} anchor={<button type="button" className="v2-option-picker-btn" aria-labelledby={`${labelId} ${valueId}`} data-testid={testId} data-value={value} disabled={disabled} onClick={(event) => { if (event.currentTarget.getAttribute('aria-expanded') !== 'true') onOpen?.() }}>
      <span id={valueId} className="v2-option-picker-value">{selected?.label ?? ''}</span><ChevronDown size={14} aria-hidden="true" /></button>} />
  </div>
}
