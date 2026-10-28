import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import './canvas-workshop.css'

export function CanvasWorkshopDialogFrame({ title, label = '我的创意工坊', busy = false, wide = false, suspended = false, onClose, children }: { title: string; label?: string; busy?: boolean; wide?: boolean; suspended?: boolean; onClose(): void; children: ReactNode }) {
  const root = useRef<HTMLElement>(null)
  // Native autoFocus runs during commit, before effects. Capture the opener
  // while rendering so cleanup does not remember the dialog's own input.
  const returnFocus = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const initial = root.current?.querySelector<HTMLElement>('input') ?? root.current?.querySelector<HTMLElement>('button')
    initial?.focus()
    return () => {
      requestAnimationFrame(() => {
        const previous = returnFocus.current
        if (root.current?.isConnected || !previous?.isConnected || previous.closest('[inert],[hidden],[aria-hidden="true"]') || previous.matches(':disabled')) return
        const active = document.activeElement
        // A newly opened dialog or an explicit outside focus takes priority.
        if (active instanceof HTMLElement && active !== document.body && active.isConnected) return
        previous.focus({ preventScroll: true })
      })
    }
  }, [])
  return <div className="canvas-workshop-backdrop" onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) close.current() }}>
    <section ref={root} inert={suspended} aria-hidden={suspended || undefined} className={`canvas-workshop-dialog${wide ? ' is-library' : ''}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape' && !busy) { event.preventDefault(); close.current() }
      if (event.key !== 'Tab') return
      const controls = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length > 0)
      if (!controls.length) return
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
    }}>
      <header><div><span>{label}</span><h2>{title}</h2></div><button type="button" aria-label={`关闭${label}窗口`} disabled={busy} onClick={onClose}><X size={18} /></button></header>
      {children}
    </section>
  </div>
}

