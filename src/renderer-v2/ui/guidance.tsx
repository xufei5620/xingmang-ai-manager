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

// Below by default. Rail items ask for beside instead: below lands on the next
// icon, so moving down the rail would click the tip rather than that icon. The
// rail tip only repeats the button's own name, so it also lets the pointer
// through and goes the moment the pointer leaves (v4 原型 `.rail [data-tip]`).
export type TooltipPlacement = 'below' | 'right'

export function Tooltip({ text, children, testId, placement = 'below' }: BaseProps & { text: string; children: ReactNode; placement?: TooltipPlacement }) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  function show() { clearTimeout(timer.current); setOpen(true) }
  function hide() { clearTimeout(timer.current); if (placement === 'right') setOpen(false); else timer.current = setTimeout(() => setOpen(false), 100) }
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
      if (placement === 'right') {
        const top = Math.max(8, Math.min(rect.top + (rect.height - panelRect.height) / 2, innerHeight - panelRect.height - 8))
        setPosition({ top, left: Math.max(8, Math.min(rect.right + 10, innerWidth - panelRect.width - 8)), visibility: 'visible' })
        return
      }
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
  }, [open, id, placement])
  return <span className="xm-tooltip-anchor" ref={anchor} onMouseEnter={show} onMouseLeave={hide} onFocusCapture={show} onBlurCapture={hide} data-testid={testId}>
    {children}{open && <div id={id} ref={panel} role="tooltip" className="xm-tooltip-panel" data-placement={placement} style={position} onMouseEnter={show} onMouseLeave={hide}>{text}</div>}
  </span>
}

// v4: the bubble points at its target with an arrow and outlines the target
// itself, so the reader's eye lands on the control being explained. A step can
// ask for the bubble beside its target (rail items, where below would cover the
// next rows); otherwise it goes below, or above when the window is too short.
// Beside falls back to below/above when the window is too narrow for it.
type CoachSide = 'below' | 'above' | 'right'
export type CoachPlacement = 'below' | 'right'
const coachGap = 12
const coachEdge = 8
const coachArrowInset = 16

function placeCoachmark(rect: DOMRect, bubble: DOMRect, placement: CoachPlacement): { side: CoachSide; top: number; left: number; arrow: number } {
  if (placement === 'right' && innerWidth - rect.right - coachGap - coachEdge >= bubble.width) {
    const centre = rect.top + rect.height / 2
    const top = Math.max(coachEdge, Math.min(centre - 22, innerHeight - bubble.height - coachEdge))
    return { side: 'right', top, left: rect.right + coachGap + 2, arrow: Math.max(coachArrowInset, Math.min(centre - top, bubble.height - coachArrowInset)) }
  }
  const centre = rect.left + rect.width / 2
  const left = Math.max(coachEdge, Math.min(centre - bubble.width / 2, innerWidth - bubble.width - coachEdge))
  const arrow = Math.max(coachArrowInset, Math.min(centre - left, bubble.width - coachArrowInset))
  if (rect.bottom + coachGap + bubble.height + coachEdge <= innerHeight) return { side: 'below', top: rect.bottom + coachGap, left, arrow }
  return { side: 'above', top: Math.max(coachEdge, rect.top - coachGap - bubble.height), left, arrow }
}

export function Coachmark({ open, target, placement = 'below', title, label, body, step, count, onNext, onClose, testId }: BaseProps & {
  /** 没有标题时读屏念 label（「界面导览，第 2 步」）。 */
  /** 给一串时按先后找第一个看得见的（指着的东西不在这一页时退回下一个）。 */
  open: boolean; target: string | readonly string[]; placement?: CoachPlacement; title?: string; label?: string; body: string; step: number; count: number; onNext(): void; onClose(): void
}) {
  const t = useUiText()
  const panel = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const [side, setSide] = useState<CoachSide>('below')
  const titleId = useId()
  const close = useRef(onClose); close.current = onClose
  useLayoutEffect(() => {
    const element = panel.current
    if (!open || !element) return
    element.setAttribute('popover', 'manual')
    element.showPopover()
    let marked: HTMLElement | null = null
    const mark = (next: HTMLElement | null) => {
      if (marked === next) return
      marked?.removeAttribute('data-coach-target')
      next?.setAttribute('data-coach-target', 'true')
      marked = next
    }
    const place = () => {
      const candidates = (typeof target === 'string' ? [target] : target).map(selector => document.querySelector<HTMLElement>(selector))
      const node = candidates.find(candidate => visibleBounds(candidate)) ?? null
      const rect = visibleBounds(node)
      if (!rect) { mark(null); setPosition({ visibility: 'hidden' }); return }
      mark(node)
      const placed = placeCoachmark(rect, element.getBoundingClientRect(), placement)
      element.style.setProperty(placed.side === 'right' ? '--coach-arrow-y' : '--coach-arrow-x', placed.arrow + 'px')
      setSide(placed.side)
      setPosition({ top: placed.top, left: placed.left, visibility: 'visible' })
    }
    const observer = new MutationObserver(place)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'inert', 'class'] })
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close.current() } }
    place(); document.addEventListener('keydown', escape, true)
    window.addEventListener('scroll', place, true); window.addEventListener('resize', place)
    return () => { observer.disconnect(); mark(null); document.removeEventListener('keydown', escape, true); window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); if (element.matches(':popover-open')) element.hidePopover() }
  }, [open, target, placement, step])
  if (!open) return null
  return <div ref={panel} role="region" aria-labelledby={title ? titleId : undefined} aria-label={title ? undefined : label} className="xm-coachmark" data-side={side} style={position} data-testid={testId}>
    <small>{step} / {count}</small>{title && <h2 id={titleId}>{title}</h2>}<p>{body}</p><footer><Button size="xs" variant="ghost" onClick={onClose}>{t('skip')}</Button><Button size="xs" variant="primary" onClick={onNext}>{t(step === count ? 'start' : 'next')}</Button></footer>
  </div>
}
