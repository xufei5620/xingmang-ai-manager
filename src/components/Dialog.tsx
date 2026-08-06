import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

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

  useEffect(() => {
    const backdrop = backdropRef.current
    if (!backdrop) return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusFirst = () => {
      const first = backdrop.querySelector<HTMLElement>(FOCUSABLE_SELECTOR)
      first?.focus()
    }
    const focusTimer = window.setTimeout(focusFirst, 0)
    return () => {
      window.clearTimeout(focusTimer)
      previous?.focus()
    }
  }, [])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const focusable = [...(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))]
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
    <div ref={backdropRef} className={className} onMouseDown={dismissFromBackdrop} onKeyDown={handleKeyDown}>
      {children}
    </div>
  )
}
