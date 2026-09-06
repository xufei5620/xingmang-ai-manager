import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { LoaderCircle, type LucideIcon } from 'lucide-react'
import type { UiSize } from './types'
import { Tooltip } from './Tooltip'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'style'> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent' | 'balance'
  /** Balance-aware primary action tone, supplied from the account balance snapshot. */
  balanceTone?: 'ok' | 'warn' | 'bad'
  size?: UiSize
  icon?: LucideIcon
  iconRight?: LucideIcon
  loading?: boolean
  testId?: string
  children: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'secondary', size = 'md', icon: Icon, iconRight: IconRight,
  loading = false, disabled, children, testId, balanceTone, type = 'button', ...props
}, ref) {
  return (
    <button {...props} ref={ref} type={type} className="ui-button" data-variant={variant}
      data-size={size} data-loading={loading || undefined} data-balance-tone={balanceTone} data-testid={testId}
      disabled={disabled || loading} aria-busy={loading || undefined}>
      <span className="ui-button-content">
        {Icon && (loading ? <LoaderCircle size={18} className="ui-spinner" aria-hidden="true" /> : <Icon size={18} aria-hidden="true" />)}
        <span>{children}</span>
        {IconRight && <IconRight size={18} aria-hidden="true" />}
      </span>
    </button>
  )
})

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'icon' | 'iconRight'> {
  icon: LucideIcon
  label: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  icon: Icon, label, variant = 'ghost', size = 'md', loading = false, disabled, testId, type = 'button', title, ...props
}, ref) {
  return (
    <Tooltip content={title ?? label}><button {...props} ref={ref} type={type} className="ui-button ui-icon-button" data-variant={variant}
      data-size={size} data-testid={testId} aria-label={label}
      disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? <LoaderCircle size={18} className="ui-spinner" aria-hidden="true" /> : <Icon size={18} aria-hidden="true" />}
    </button></Tooltip>
  )
})
