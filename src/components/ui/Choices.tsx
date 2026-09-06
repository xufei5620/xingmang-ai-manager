import { useEffect, useId, useRef, type InputHTMLAttributes, type ReactNode } from 'react'
import { Check } from 'lucide-react'
import type { UiSkin } from './types'

interface ChoiceCopy {
  label: ReactNode
  description?: ReactNode
  testId?: string
}

export interface SwitchProps extends ChoiceCopy {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  busy?: boolean
}

export function Switch({ checked, onChange, disabled, busy, label, description, testId }: SwitchProps) {
  const id = useId()
  return (
    <div className="ui-choice-row">
      <button id={id} type="button" className="ui-switch" role="switch" aria-checked={checked}
        aria-labelledby={`${id}-label`} aria-describedby={description ? `${id}-description` : undefined}
        disabled={disabled || busy} aria-busy={busy || undefined} data-testid={testId} onClick={() => onChange(!checked)}>
        <span className="ui-switch-track" aria-hidden="true"><span /></span>
      </button>
      <label className="ui-choice-copy" htmlFor={id}><span id={`${id}-label`}>{label}</span>
        {description && <span className="ui-field-hint" id={`${id}-description`}>{description}</span>}
      </label>
    </div>
  )
}

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className' | 'style' | 'size'>, ChoiceCopy {
  indeterminate?: boolean
}

export function Checkbox({ label, description, testId, indeterminate = false, id: requestedId, ...props }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null)
  const generatedId = useId()
  const id = requestedId ?? generatedId
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate }, [indeterminate])
  return (
    <label className="ui-choice-row" htmlFor={id}>
      <input {...props} ref={ref} id={id} type="checkbox" className="ui-checkbox" data-testid={testId}
        aria-checked={indeterminate ? 'mixed' : undefined}
        aria-readonly={props.readOnly || undefined}
        onClick={(event) => { props.onClick?.(event); if (props.readOnly) event.preventDefault() }}
        onChange={(event) => { if (!props.readOnly) props.onChange?.(event) }}
        aria-describedby={[props['aria-describedby'], description ? `${id}-description` : ''].filter(Boolean).join(' ') || undefined} />
      <span className="ui-choice-copy"><span>{label}</span>
        {description && <span className="ui-field-hint" id={`${id}-description`}>{description}</span>}
      </span>
    </label>
  )
}

export type RadioProps = Omit<CheckboxProps, 'indeterminate'>

export function Radio({ label, description, testId, id: requestedId, ...props }: RadioProps) {
  const generatedId = useId()
  const id = requestedId ?? generatedId
  return (
    <label className="ui-choice-row" htmlFor={id}>
      <input {...props} id={id} type="radio" className="ui-radio" data-testid={testId}
        aria-describedby={[props['aria-describedby'], description ? `${id}-description` : ''].filter(Boolean).join(' ') || undefined} />
      <span className="ui-choice-copy"><span>{label}</span>
        {description && <span className="ui-field-hint" id={`${id}-description`}>{description}</span>}
      </span>
    </label>
  )
}

export function SkinChip({ skin, label, selected, onSelect, disabled, testId }: {
  skin: UiSkin; label: string; selected: boolean; onSelect: (skin: UiSkin) => void; disabled?: boolean; testId?: string
}) {
  return (
    <button type="button" className="ui-skin-chip" data-chip-skin={skin} aria-pressed={selected}
      disabled={disabled} onClick={() => onSelect(skin)} data-testid={testId}>
      <span className="ui-skin-swatch" aria-hidden="true" />
      <span>{label}</span><Check className="ui-skin-check" size={14} aria-hidden="true" />
    </button>
  )
}
