import { useId, type ReactNode } from 'react'
import { AlertCircle, CheckCircle2, CircleHelp, Info, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { UiTone } from './types'

export function Pill({ children, tone = 'neutral', dot = false, testId }: {
  children: ReactNode; tone?: UiTone; dot?: boolean; testId?: string
}) {
  return <span className="ui-pill" data-tone={tone} data-testid={testId}>{dot && <span className="ui-pill-dot" aria-hidden="true" />}{children}</span>
}

const TONE_ICONS: Record<UiTone, LucideIcon> = {
  neutral: Info, accent: Info, info: Info, ok: CheckCircle2, warn: TriangleAlert, bad: AlertCircle,
}

export interface BannerProps {
  title: ReactNode
  children?: ReactNode
  tone?: UiTone
  icon?: LucideIcon
  actions?: ReactNode
  live?: 'polite' | 'assertive' | 'off'
  testId?: string
}

export function Banner({ title, children, tone = 'info', icon, actions, live = 'off', testId }: BannerProps) {
  const Icon = icon ?? TONE_ICONS[tone]
  return (
    <div className="ui-banner" data-tone={tone} data-testid={testId}
      role={live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined}>
      <Icon size={18} aria-hidden="true" />
      <div className="ui-banner-body"><strong>{title}</strong>{children && <div>{children}</div>}</div>
      {actions && <div className="ui-banner-actions">{actions}</div>}
    </div>
  )
}

export function Empty({ title, description, icon: Icon = CircleHelp, action, testId }: {
  title: ReactNode; description?: ReactNode; icon?: LucideIcon; action?: ReactNode; testId?: string
}) {
  return (
    <div className="ui-empty" data-testid={testId}>
      <Icon size={30} aria-hidden="true" /><strong>{title}</strong>
      {description && <p>{description}</p>}{action && <div>{action}</div>}
    </div>
  )
}

export function Progress({ value, label, tone = 'accent', testId }: {
  value?: number; label: string; tone?: UiTone; testId?: string
}) {
  const id = useId()
  const safeValue = typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined
  return (
    <div className="ui-progress" data-tone={tone} data-testid={testId}>
      <div className="ui-progress-label"><span id={id}>{label}</span>{safeValue !== undefined && <span>{Math.round(safeValue)}%</span>}</div>
      <progress max={100} value={safeValue} aria-labelledby={id} />
    </div>
  )
}

export function Skeleton({ rows = 3, label = '正在加载', testId }: { rows?: number; label?: string; testId?: string }) {
  const count = Number.isFinite(rows) ? Math.max(1, Math.min(20, Math.floor(rows))) : 3
  return (
    <div className="ui-skeleton" role="status" aria-label={label} aria-busy="true" data-testid={testId}>
      {Array.from({ length: count }, (_, index) => <span key={index} className="ui-skeleton-line" aria-hidden="true" />)}
    </div>
  )
}
