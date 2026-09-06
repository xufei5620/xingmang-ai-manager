import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode, type Ref, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import './interactions.css'

export type FloatingSide = 'top' | 'bottom' | 'left' | 'right'
export type FloatingDismissReason = 'escape' | 'outside' | 'anchor-hidden'
interface Rectangle { left: number; top: number; width: number; height: number }

export function floatingPosition(anchor: Rectangle, size: { width: number; height: number }, viewport: { width: number; height: number }, side: FloatingSide = 'bottom', align: 'start' | 'center' | 'end' = 'start', gap = 7) {
  const padding = 8
  const room = { top: anchor.top - gap - padding, bottom: viewport.height - anchor.top - anchor.height - gap - padding, left: anchor.left - gap - padding, right: viewport.width - anchor.left - anchor.width - gap - padding }
  const opposite = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const
  const needed = side === 'top' || side === 'bottom' ? size.height : size.width
  const placedSide = room[side] < needed && room[opposite[side]] > room[side] ? opposite[side] : side
  const width = Math.min(size.width, Math.max(0, viewport.width - padding * 2))
  const maxHeight = Math.max(0, Math.min(viewport.height - padding * 2, placedSide === 'top' || placedSide === 'bottom' ? room[placedSide] : viewport.height - padding * 2))
  const height = Math.min(size.height, maxHeight)
  const along = (start: number, anchorSize: number, popupSize: number) => start + (align === 'end' ? anchorSize - popupSize : align === 'center' ? (anchorSize - popupSize) / 2 : 0)
  let left = placedSide === 'left' ? anchor.left - width - gap : placedSide === 'right' ? anchor.left + anchor.width + gap : along(anchor.left, anchor.width, width)
  let top = placedSide === 'top' ? anchor.top - height - gap : placedSide === 'bottom' ? anchor.top + anchor.height + gap : along(anchor.top, anchor.height, height)
  left = Math.max(padding, Math.min(left, viewport.width - width - padding))
  top = Math.max(padding, Math.min(top, viewport.height - height - padding))
  return { left, top, maxHeight, side: placedSide }
}

export function isVisibleAnchor(anchor: HTMLElement | null): anchor is HTMLElement {
  if (!anchor?.isConnected || !anchor.getClientRects().length || anchor.closest('[inert], [hidden]')) return false
  const style = getComputedStyle(anchor)
  if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false
  const bounds = anchor.getBoundingClientRect()
  let left = Math.max(0, bounds.left)
  let right = Math.min(innerWidth, bounds.right)
  let top = Math.max(0, bounds.top)
  let bottom = Math.min(innerHeight, bounds.bottom)
  for (let parent = anchor.parentElement; parent; parent = parent.parentElement) {
    const parentStyle = getComputedStyle(parent)
    if (parentStyle.opacity === '0' || parentStyle.contentVisibility === 'hidden') return false
    const parentBounds = parent.getBoundingClientRect()
    if (/auto|scroll|hidden|clip/.test(parentStyle.overflowX)) {
      left = Math.max(left, parentBounds.left + parent.clientLeft)
      right = Math.min(right, parentBounds.left + parent.clientLeft + parent.clientWidth)
    }
    if (/auto|scroll|hidden|clip/.test(parentStyle.overflowY)) {
      top = Math.max(top, parentBounds.top + parent.clientTop)
      bottom = Math.min(bottom, parentBounds.top + parent.clientTop + parent.clientHeight)
    }
    if (parent.matches(':popover-open, dialog[open]')) break
  }
  return bounds.width > 0 && bounds.height > 0 && right > left && bottom > top
}

function assignRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null) {
  if (typeof ref === 'function') ref(node)
  else if (ref) (ref as { current: HTMLElement | null }).current = node
}

export function withAnchorRef(trigger: ReactElement, anchor: { current: HTMLElement | null }, props: Record<string, unknown> = {}): ReactElement {
  return cloneElement(trigger, { ...props, ref: (node: HTMLElement | null) => { anchor.current = node; assignRef((trigger as ReactElement & { ref?: Ref<HTMLElement> }).ref, node) } })
}

const layers: Array<{ id: symbol; interactive: boolean }> = []

export interface FloatingSurfaceProps {
  anchor: RefObject<HTMLElement>
  children: ReactNode
  className?: string
  role?: 'tooltip' | 'dialog' | 'menu' | 'listbox'
  id?: string
  testId?: string
  label?: string
  side?: FloatingSide
  align?: 'start' | 'center' | 'end'
  width?: number | 'anchor'
  autoFocus?: boolean
  dismissOutside?: boolean
  onDismiss(reason: FloatingDismissReason): void
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>
}

export function FloatingSurface({ anchor, children, className = '', role = 'dialog', id, testId, label, side = 'bottom', align = 'start', width, autoFocus = false, dismissOutside = true, onDismiss, onKeyDown }: FloatingSurfaceProps) {
  const element = useRef<HTMLDivElement>(null)
  const initiallyFocused = useRef(false)
  const callbacks = useRef({ onDismiss })
  callbacks.current = { onDismiss }
  const [position, setPosition] = useState<ReturnType<typeof floatingPosition> | null>(null)
  const target = anchor.current
  const container = target?.closest<HTMLElement>('[data-ui-floating], dialog[open], [data-dialog-layer]') ?? (typeof document !== 'undefined' ? document.body : null)
  const theme = target?.closest('[data-theme]')?.getAttribute('data-theme') ?? undefined
  const skin = target?.closest('[data-skin]')?.getAttribute('data-skin') ?? undefined
  const reducedMotion = target?.closest('[data-reduced-motion]')?.getAttribute('data-reduced-motion') ?? undefined

  useLayoutEffect(() => {
    const popup = element.current
    const owner = anchor.current
    if (!popup || !owner) return
    let frame = 0
    const reposition = () => {
      if (!isVisibleAnchor(owner)) { callbacks.current.onDismiss('anchor-hidden'); return }
      const next = floatingPosition(owner.getBoundingClientRect(), popup.getBoundingClientRect(), { width: innerWidth, height: innerHeight }, side, align)
      setPosition((current) => current && current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight && current.side === next.side ? current : next)
    }
    popup.setAttribute('popover', 'manual')
    popup.showPopover?.()
    reposition()
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(reposition) }
    const observer = new ResizeObserver(schedule)
    observer.observe(owner)
    observer.observe(popup)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'inert', 'style', 'class'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      if (popup.contains(document.activeElement) && owner.isConnected) owner.focus({ preventScroll: true })
      if (popup.matches(':popover-open')) popup.hidePopover?.()
    }
  }, [container, target, side, align, autoFocus])

  useLayoutEffect(() => {
    if (!autoFocus || !position || initiallyFocused.current || !element.current) return
    const popup = element.current
    const first = popup.querySelector<HTMLElement>('[data-initial-focus]')
      ?? popup.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]')
      ?? popup
    first.focus({ preventScroll: true })
    initiallyFocused.current = true
  }, [autoFocus, position])

  useEffect(() => {
    const layer = Symbol('floating')
    layers.push({ id: layer, interactive: role !== 'tooltip' })
    const keydown = (event: KeyboardEvent) => {
      if (layers.at(-1)?.id !== layer || event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      callbacks.current.onDismiss('escape')
    }
    const pointerdown = (event: PointerEvent) => {
      if (!dismissOutside || [...layers].reverse().find((entry) => entry.interactive)?.id !== layer || !(event.target instanceof Node)) return
      if (element.current?.contains(event.target) || anchor.current?.contains(event.target)) return
      callbacks.current.onDismiss('outside')
    }
    document.addEventListener('keydown', keydown, true)
    document.addEventListener('pointerdown', pointerdown, true)
    return () => {
      const index = layers.findIndex((entry) => entry.id === layer)
      if (index !== -1) layers.splice(index, 1)
      document.removeEventListener('keydown', keydown, true)
      document.removeEventListener('pointerdown', pointerdown, true)
    }
  }, [dismissOutside, role])

  if (!container) return null
  const style: CSSProperties = { left: position?.left ?? 0, top: position?.top ?? 0, maxHeight: position?.maxHeight, width: width === 'anchor' ? target?.getBoundingClientRect().width : width, visibility: position ? 'visible' : 'hidden' }
  return createPortal(<div ref={element} data-ui-floating data-theme={theme} data-skin={skin} data-reduced-motion={reducedMotion}
    className={`ui-floating ${className}`} role={role} id={id} data-testid={testId} aria-label={label} tabIndex={role === 'dialog' ? -1 : undefined} style={style}
    onKeyDown={(event) => { onKeyDown?.(event); if (event.key !== 'Tab' || role === 'menu') event.stopPropagation() }}>{children}</div>, container)
}
