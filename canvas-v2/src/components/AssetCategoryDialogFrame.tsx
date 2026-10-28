import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import './asset-category-controls.css'

export function AssetCategoryDialogFrame({ title, canClose, onClose, children }: { title: string; canClose: boolean; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="asset-category-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && canClose) onClose() }}>
    <section ref={dialog} className="asset-category-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (canClose) onClose() }
      if (event.key !== 'Tab') return
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length)
      const first = controls[0], last = controls.at(-1)
      if (!first || !last) { event.preventDefault(); dialog.current?.focus() }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }}>
      <header><h3>{title}</h3><button type="button" aria-label={`关闭${title}`} disabled={!canClose} onClick={onClose}><X size={16} /></button></header>
      {children}
    </section>
  </div>
}
