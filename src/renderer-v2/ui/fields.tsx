import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Eye, EyeOff, Search } from 'lucide-react';
import { cx, useUiText, type BaseProps } from './shared';

type Feedback = { error?: string; hint?: string; label?: ReactNode };
function FieldFeedback({ id, error, hint }: { id: string; error?: string; hint?: string }) {
  return error ? <em id={id} role="alert">{error}</em> : hint ? <small id={id}>{hint}</small> : null;
}
type FieldProps = BaseProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'style'> & Feedback & { mono?: boolean; password?: boolean; ref?: Ref<HTMLInputElement> };
export function Input({ error, hint, mono, password, label, testId, id: inputId, 'aria-describedby': describedBy, ...props }: FieldProps) {
  const [show, setShow] = useState(false); const generated = useId(); const id = inputId ?? generated; const helpId = id + '-help'; const t = useUiText();
  return <div className="xm-field">{label && <label htmlFor={id}>{label}</label>}<div className="xm-field-control"><input {...props} id={id} className={cx(mono && 'xm-mono', error && 'has-error', password && 'xm-input-password')} data-testid={testId} type={password ? show ? 'text' : 'password' : props.type} aria-invalid={Boolean(error)} aria-describedby={[describedBy, error || hint ? helpId : undefined].filter(Boolean).join(' ') || undefined} />{password && <button aria-label={show ? t('hide') : t('show')} aria-pressed={show} className="xm-field-eye" onClick={() => setShow(!show)} disabled={props.disabled} type="button">{show ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}</button>}</div><FieldFeedback id={helpId} error={error} hint={hint} /></div>;
}
export function Select({ options, error, hint, label, mono, testId, id: selectId, 'aria-describedby': describedBy, ...props }: BaseProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className' | 'style'> & Feedback & { options: Array<{ value: string; label: string; disabled?: boolean }>; mono?: boolean }) {
  const generated = useId(); const id = selectId ?? generated; const helpId = id + '-help';
  return <div className="xm-field">{label && <label htmlFor={id}>{label}</label>}<select {...props} id={id} className={mono ? 'xm-mono' : undefined} data-testid={testId} aria-invalid={Boolean(error)} aria-describedby={[describedBy, error || hint ? helpId : undefined].filter(Boolean).join(' ') || undefined}>{options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select><FieldFeedback id={helpId} error={error} hint={hint} /></div>;
}
export function Textarea({ error, hint, mono, label, testId, id: textId, 'aria-describedby': describedBy, ...props }: BaseProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className' | 'style'> & Feedback & { mono?: boolean }) {
  const generated = useId(); const id = textId ?? generated; const helpId = id + '-help';
  return <div className="xm-field">{label && <label htmlFor={id}>{label}</label>}<textarea {...props} id={id} className={cx(mono && 'xm-mono', error && 'has-error')} data-testid={testId} aria-invalid={Boolean(error)} aria-describedby={[describedBy, error || hint ? helpId : undefined].filter(Boolean).join(' ') || undefined} /><FieldFeedback id={helpId} error={error} hint={hint} /></div>;
}
export function SearchInput({ value, onChange, placeholder, label, testId, disabled }: BaseProps & { value: string; onChange: (value: string) => void; placeholder?: string; label?: string; disabled?: boolean }) {
  const t = useUiText();
  return <label className="xm-search"><Search size={16} aria-hidden="true" /><input type="search" aria-label={label ?? placeholder ?? t('search')} disabled={disabled} data-testid={testId} value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder ?? t('search')} /></label>;
}
export function Switch({ checked, onChange, label, description, disabled, testId, 'aria-label': ariaLabel }: BaseProps & { checked: boolean; onChange: (checked: boolean) => void; label?: ReactNode; description?: ReactNode; disabled?: boolean; 'aria-label'?: string }) {
  const id = useId(); const t = useUiText();
  return <div className="xm-switch-wrap" data-testid={testId}><button id={id} className={cx('xm-switch', checked && 'is-on')} aria-checked={checked} aria-label={!label ? ariaLabel ?? t('notifications') : undefined} aria-labelledby={label ? id + '-label' : undefined} aria-describedby={description ? id + '-description' : undefined} disabled={disabled} onClick={() => onChange(!checked)} role="switch" type="button"><i aria-hidden="true" /></button>{(label || description) && <div>{label && <label id={id + '-label'} htmlFor={id}>{label}</label>}{description && <small id={id + '-description'}>{description}</small>}</div>}</div>;
}
