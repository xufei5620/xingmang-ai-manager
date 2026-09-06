import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const inertOwners = new Map<HTMLElement, { count: number; original: boolean }>()

function isolateDialog(backdrop: HTMLElement): () => void {
  const siblings = new Set<HTMLElement>()
  let branch: HTMLElement | null = backdrop
  while (branch?.parentElement) {
    const parent: HTMLElement = branch.parentElement
    for (const sibling of parent.children) {
      if (sibling !== branch && sibling instanceof HTMLElement) siblings.add(sibling)
    }
    if (parent === document.body) break
    branch = parent
  }
  for (const sibling of siblings) {
    const ownership = inertOwners.get(sibling) ?? { count: 0, original: sibling.inert }
    ownership.count += 1
    inertOwners.set(sibling, ownership)
    sibling.inert = true
  }
  return () => {
    for (const sibling of siblings) {
      const ownership = inertOwners.get(sibling)
      if (!ownership) continue
      ownership.count -= 1
      if (ownership.count === 0) { sibling.inert = ownership.original; inertOwners.delete(sibling) }
    }
  }
}

export interface DialogKeyboardDecision {
  handled: boolean
  dismiss: boolean
  focusIndex: number | null
  preventDefault: boolean
}

export function dialogAriaProps(labelledBy: string): {
  role: 'dialog'
  'aria-modal': true
  'aria-labelledby': string
} {
  return {
    role: 'dialog',
    'aria-modal': true,
    'aria-labelledby': labelledBy,
  }
}

export function dialogKeyboardDecision({
  key,
  shiftKey,
  activeIndex,
  focusableCount,
}: {
  key: string
  shiftKey: boolean
  activeIndex: number
  focusableCount: number
}): DialogKeyboardDecision {
  if (key === 'Escape') {
    return { handled: true, dismiss: true, focusIndex: null, preventDefault: false }
  }
  if (key !== 'Tab') {
    return { handled: false, dismiss: false, focusIndex: null, preventDefault: false }
  }
  if (focusableCount <= 0) {
    return { handled: true, dismiss: false, focusIndex: null, preventDefault: true }
  }
  if (activeIndex < 0) {
    return {
      handled: true,
      dismiss: false,
      focusIndex: shiftKey ? focusableCount - 1 : 0,
      preventDefault: true,
    }
  }
  if (shiftKey && activeIndex === 0) {
    return { handled: true, dismiss: false, focusIndex: focusableCount - 1, preventDefault: true }
  }
  if (!shiftKey && activeIndex === focusableCount - 1) {
    return { handled: true, dismiss: false, focusIndex: 0, preventDefault: true }
  }
  return { handled: true, dismiss: false, focusIndex: null, preventDefault: false }
}

export function DialogBackdrop({
  children,
  className,
  onDismiss,
}: {
  children: ReactNode
  className: string
  onDismiss: () => void
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const dismissRef = useRef(onDismiss)
  dismissRef.current = onDismiss

  useEffect(() => {
    const backdrop = backdropRef.current
    if (!backdrop) return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const releaseInert = isolateDialog(backdrop)
    const focusFirst = () => {
      if ([...document.querySelectorAll('[data-dialog-layer]')].at(-1) !== backdrop) return
      const first = backdrop.querySelector<HTMLElement>('[data-initial-focus], [data-autofocus], input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
        ?? backdrop.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      first?.focus()
    }
    const focusTimer = window.setTimeout(focusFirst, 0)
    const keepFocusInside = (event: FocusEvent) => {
      if ([...document.querySelectorAll('[data-dialog-layer]')].at(-1) !== backdrop) return
      if (event.target instanceof Node && !backdrop.contains(event.target)) focusFirst()
    }
    const escapeBeforeFocus = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || [...document.querySelectorAll('[data-dialog-layer]')].at(-1) !== backdrop) return
      if (event.target instanceof Node && backdrop.contains(event.target)) return
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return
      event.preventDefault()
      event.stopPropagation()
      dismissRef.current()
    }
    document.addEventListener('focusin', keepFocusInside)
    document.addEventListener('keydown', escapeBeforeFocus, true)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('focusin', keepFocusInside)
      document.removeEventListener('keydown', escapeBeforeFocus, true)
      releaseInert()
      if (previous?.isConnected) previous.focus({ preventScroll: true })
    }
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ([...document.querySelectorAll('[data-dialog-layer]')].at(-1) !== event.currentTarget) return
    const focusable = [...(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))]
      .filter((element) => element.getClientRects().length > 0 && !element.closest('[inert]'))
    const decision = dialogKeyboardDecision({
      key: event.key,
      shiftKey: event.shiftKey,
      activeIndex: focusable.indexOf(document.activeElement as HTMLElement),
      focusableCount: focusable.length,
    })
    if (!decision.handled) return
    event.stopPropagation()
    if (decision.preventDefault) event.preventDefault()
    if (decision.dismiss) {
      onDismiss()
      return
    }
    if (decision.focusIndex !== null) focusable[decision.focusIndex]?.focus()
  }

  const dismissFromBackdrop = (event: MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    if (event.target === event.currentTarget) onDismiss()
  }

  return (
    <div ref={backdropRef} className={className} data-dialog-layer onMouseDown={dismissFromBackdrop} onKeyDown={handleKeyDown}>
      {children}
    </div>
  )
}
