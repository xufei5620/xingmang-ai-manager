import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { X } from 'lucide-react'
import { IconButton } from './Button'
import './drawer.css'

export interface DrawerProps {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
  closeLabel?: string
  busy?: boolean
  testId?: string
  returnFocus?: RefObject<HTMLElement>
}

export function Drawer({ open, title, subtitle, children, footer, onClose, closeLabel = '关闭详情', busy = false, testId, returnFocus }: DrawerProps) {
  const id = useId()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog || !open) return
    const previous = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null)
    dialog.showModal()
    titleRef.current?.focus({ preventScroll: true })
    return () => {
      if (dialog.open) dialog.close()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [open])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog?.open && !dialog.contains(document.activeElement)) titleRef.current?.focus({ preventScroll: true })
  })

  if (!open) return null
  return (
    <dialog ref={dialogRef} className="ui-drawer" aria-labelledby={`${id}-title`} aria-describedby={subtitle ? `${id}-subtitle` : undefined}
      aria-modal="true" data-testid={testId} onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}
      onClick={(event) => {
        if (busy || event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
      }}>
      <header className="ui-drawer-header">
        <div><h2 ref={titleRef} id={`${id}-title`} tabIndex={-1}>{title}</h2>{subtitle && <div id={`${id}-subtitle`} className="ui-drawer-subtitle">{subtitle}</div>}</div>
        <IconButton icon={X} label={closeLabel} disabled={busy} onClick={onClose} />
      </header>
      <div className="ui-drawer-body">{children}</div>
      {footer && <footer className="ui-drawer-footer">{footer}</footer>}
    </dialog>
  )
}
