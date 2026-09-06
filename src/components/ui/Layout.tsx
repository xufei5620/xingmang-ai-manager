import { useId, type ReactNode } from 'react'
import type { UiSize } from './types'

export function Card({ title, meta, actions, children, selected, padding = 'md', testId }: {
  title?: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; selected?: boolean; padding?: 'none' | 'md'; testId?: string
}) {
  return (
    <section className="ui-card" data-selected={selected || undefined} data-padding={padding} data-testid={testId}>
      {(title || actions) && <header className="ui-card-head"><div>{title && <h2>{title}</h2>}{meta && <div className="ui-field-hint">{meta}</div>}</div>{actions}</header>}
      {children}
    </section>
  )
}

export function PageHead({ title, lead, actions, testId }: { title: ReactNode; lead?: ReactNode; actions?: ReactNode; testId?: string }) {
  return <header className="ui-page-head" data-testid={testId}><div><h1>{title}</h1>{lead && <p>{lead}</p>}</div>{actions && <div className="ui-inline">{actions}</div>}</header>
}

export function Toolbar({ left, right, testId }: { left?: ReactNode; right?: ReactNode; testId?: string }) {
  return <div className="ui-toolbar" data-testid={testId}><div className="ui-inline">{left}</div><div className="ui-inline">{right}</div></div>
}

export function SettingRow({ title, description, control, testId }: { title: ReactNode; description?: ReactNode; control: ReactNode; testId?: string }) {
  return <div className="ui-setting-row" data-testid={testId}><div><strong>{title}</strong>{description && <p>{description}</p>}</div><div className="ui-setting-control">{control}</div></div>
}

export function Stack({ children, gap = 'md', testId }: { children: ReactNode; gap?: UiSize; testId?: string }) {
  return <div className="ui-stack" data-gap={gap} data-testid={testId}>{children}</div>
}

export function Inline({ children, gap = 'sm', testId }: { children: ReactNode; gap?: UiSize; testId?: string }) {
  return <div className="ui-inline" data-gap={gap} data-testid={testId}>{children}</div>
}

export function Accordion({ title, children, open, onToggle, testId }: {
  title: ReactNode; children: ReactNode; open?: boolean; onToggle?: (open: boolean) => void; testId?: string
}) {
  const id = useId()
  return <details className="ui-accordion" open={open} onToggle={(event) => onToggle?.(event.currentTarget.open)} data-testid={testId}>
    <summary aria-controls={id}>{title}</summary><div id={id}>{children}</div>
  </details>
}

export function Avatar({ name, src, size = 'md', status, testId }: {
  name: string; src?: string; size?: 'sm' | 'md' | 'lg'; status?: { label: string; online: boolean }; testId?: string
}) {
  return <span className="ui-avatar" data-size={size} role="img" aria-label={status ? `${name}，${status.label}` : name} data-testid={testId}>
    {src ? <img src={src} alt="" /> : <span aria-hidden="true">{Array.from(name.trim())[0] ?? '?'}</span>}
    {status && <span className="ui-avatar-status" data-online={status.online} aria-hidden="true" />}
  </span>
}
