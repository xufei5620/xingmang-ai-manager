import {
  forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import { AlertCircle, Eye, EyeOff } from 'lucide-react'
import { IconButton } from './Button'
import type { UiSize } from './types'

interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  error?: string
  mono?: boolean
  size?: UiSize
  testId?: string
}

export function FieldError({ id, children, testId }: { id?: string; children: ReactNode; testId?: string }) {
  return <span className="ui-field-error" id={id} data-testid={testId}><AlertCircle size={14} aria-hidden="true" />{children}</span>
}

function FieldFrame({ id, label, hint, error, children }: Omit<FieldProps, 'size'> & { id: string; children: ReactNode }) {
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor={id}>{label}</label>
      {children}
      {hint && <span className="ui-field-hint" id={`${id}-hint`}>{hint}</span>}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </div>
  )
}

function describedBy(id: string, hint: ReactNode, error: string | undefined, existing?: string): string | undefined {
  return [existing, hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined
}

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'className' | 'style'>, FieldProps {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({
  label, hint, error, mono, size = 'md', testId, id: requestedId, ...props
}, ref) {
  const generatedId = useId()
  const id = requestedId ?? generatedId
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <input {...props} ref={ref} id={id} className="ui-input" data-size={size} data-mono={mono || undefined}
        data-testid={testId} aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy(id, hint, error, props['aria-describedby'])} />
    </FieldFrame>
  )
})

export interface PasswordProps extends Omit<InputProps, 'type'> {
  showLabel?: string
  hideLabel?: string
}

export const Password = forwardRef<HTMLInputElement, PasswordProps>(function Password({
  label, hint, error, mono, size = 'md', testId, id: requestedId,
  showLabel = '显示密码', hideLabel = '隐藏密码', ...props
}, ref) {
  const [visible, setVisible] = useState(false)
  const generatedId = useId()
  const id = requestedId ?? generatedId
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <div className="ui-password">
        <input {...props} ref={ref} id={id} type={visible ? 'text' : 'password'} className="ui-input"
          data-size={size} data-mono={mono || undefined} data-testid={testId}
          aria-invalid={error ? true : props['aria-invalid']}
          aria-describedby={describedBy(id, hint, error, props['aria-describedby'])} />
        <IconButton icon={visible ? EyeOff : Eye} label={visible ? hideLabel : showLabel} size={size}
          disabled={props.disabled} aria-pressed={visible} onClick={() => setVisible((current) => !current)} />
      </div>
    </FieldFrame>
  )
})

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size' | 'className' | 'style'>, FieldProps {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({
  label, hint, error, mono, size = 'md', testId, id: requestedId, children, ...props
}, ref) {
  const generatedId = useId()
  const id = requestedId ?? generatedId
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <select {...props} ref={ref} id={id} className="ui-input ui-select" data-size={size} data-mono={mono || undefined}
        data-testid={testId} aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy(id, hint, error, props['aria-describedby'])}>{children}</select>
    </FieldFrame>
  )
})

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'style'>, FieldProps {
  showCount?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({
  label, hint, error, mono, size = 'md', testId, id: requestedId, showCount, ...props
}, ref) {
  const generatedId = useId()
  const id = requestedId ?? generatedId
  const [uncontrolledCount, setUncontrolledCount] = useState(() => String(props.defaultValue ?? '').length)
  const count = props.value === undefined ? uncontrolledCount : String(props.value).length
  return (
    <FieldFrame id={id} label={label} hint={hint} error={error}>
      <textarea {...props} ref={ref} id={id} className="ui-input ui-textarea" data-size={size} data-mono={mono || undefined}
        onChange={(event) => { setUncontrolledCount(event.target.value.length); props.onChange?.(event) }}
        data-testid={testId} aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={describedBy(id, hint, error, props['aria-describedby'])} />
      {showCount && <span className="ui-field-count">{count}{props.maxLength ? ` / ${props.maxLength}` : ''}</span>}
    </FieldFrame>
  )
})
