import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Button } from './core'
import { useUiText, type BaseProps } from './shared'

function visibleBounds(element: HTMLElement | null): DOMRect | null {
  if (!element || element.closest('[hidden], [inert]') || !element.getClientRects().length) return null
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth) return null
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const css = getComputedStyle(parent)
    if (!/(auto|scroll|hidden|clip)/.test(css.overflow + css.overflowX + css.overflowY)) continue
    const bounds = parent.getBoundingClientRect()
    if (rect.top < bounds.top || rect.bottom > bounds.bottom || rect.left < bounds.left || rect.right > bounds.right) return null
  }
  return rect
}

export function Tooltip({ text, children, testId }: BaseProps & { text: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function show() { clearTimeout(timer.current); setOpen(true) }
  function hide() { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 100) }
  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    const element = panel.current
    if (!open || !element) return
    element.setAttribute('popover', 'manual')
    const trigger = anchor.current?.querySelector<HTMLElement>('button, input, [tabindex]') ?? anchor.current
    const previousDescription = trigger?.getAttribute('aria-describedby')
    trigger?.setAttribute('aria-describedby', [previousDescription, id].filter(Boolean).join(' '))
    element.showPopover()
    const place = () => {
      const rect = visibleBounds(trigger)
      if (!rect) { setOpen(false); return }
      const panelRect = element.getBoundingClientRect()
      const top = rect.bottom + panelRect.height + 8 < innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - panelRect.height - 8)
      setPosition({ top, left: Math.max(8, Math.min(rect.left, innerWidth - panelRect.width - 8)), visibility: 'visible' })
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); setOpen(false) } }
    place()
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place)
    document.addEventListener('keydown', escape, true)
    return () => {
      if (previousDescription) trigger?.setAttribute('aria-describedby', previousDescription); else trigger?.removeAttribute('aria-describedby')
      if (element.matches(':popover-open')) element.hidePopover()
      window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open, id])
  return <span className="xm-tooltip-anchor" ref={anchor} onMouseEnter={show} onMouseLeave={hide} onFocusCapture={show} onBlurCapture={hide} data-testid={testId}>
    {children}{open && <div id={id} ref={panel} role="tooltip" className="xm-tooltip-panel" style={position} onMouseEnter={show} onMouseLeave={hide}>{text}</div>}
  </span>
}

export function Coachmark({ open, target, title, body, step, count, onNext, onClose, testId }: BaseProps & {
  open: boolean; target: string; title: string; body: string; step: number; count: number; onNext(): void; onClose(): void
}) {
  const t = useUiText()
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const titleId = useId()
  const close = useRef(onClose); close.current = onClose
  useLayoutEffect(() => {
    const element = panel.current
    if (!open || !element) return
    element.setAttribute('popover', 'manual')
    element.showPopover()
    const place = () => {
      const rect = visibleBounds(document.querySelector<HTMLElement>(target))
      if (!rect) { setPosition({ visibility: 'hidden' }); return }
      const bounds = element.getBoundingClientRect()
      setPosition({ top: rect.bottom + bounds.height + 8 < innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - bounds.height - 8), left: Math.max(8, Math.min(rect.left, innerWidth - bounds.width - 8)), visibility: 'visible' })
    }
    const observer = new MutationObserver(place)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'class'] })
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close.current() } }
    place(); document.addEventListener('keydown', escape, true)
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place)
    return () => { observer.disconnect(); document.removeEventListener('keydown', escape, true); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); if (element.matches(':popover-open')) element.hidePopover() }
  }, [open, target, step])
  if (!open) return null
  return <div ref={panel} role="region" aria-labelledby={titleId} className="xm-coachmark" style={position} data-testid={testId}>
    <small>{step} / {count}</small><h2 id={titleId}>{title}</h2><p>{body}</p><footer><Button size="sm" variant="ghost" onClick={onClose}>{t('skip')}</Button><Button size="sm" variant="primary" onClick={onNext}>{t(step === count ? 'start' : 'next')}</Button></footer>
  </div>
}
