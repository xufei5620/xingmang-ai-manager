import { useEffect, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { selectionMenuKey } from './selection-toolbar-model'

interface ResourceTreeMenuProps {
  id: string
  title: string
  triggerRef: RefObject<HTMLButtonElement | null>
  focusEdge: 'first' | 'last'
  onClose(restoreFocus?: boolean): void
  children: ReactNode
}

/** Menu focus owns its keys; canvas selection may belong to another row. */
export function ResourceTreeMenu(props: ResourceTreeMenuProps) {
  const menu = useRef<HTMLDivElement>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(() => {
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    const target = items?.[props.focusEdge === 'last' ? items.length - 1 : 0]
    ;(target ?? menu.current)?.focus({ preventScroll: true })
    function dismiss(event: Event) {
      if (event.target instanceof Node && (menu.current?.contains(event.target) || props.triggerRef.current?.contains(event.target))) return
      close.current(false)
    }
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('focusin', dismiss)
    return () => {
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('focusin', dismiss)
    }
  }, [props.focusEdge, props.triggerRef])
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])]
    const action = selectionMenuKey(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length)
    if (!action) return
    if (action.kind === 'tab') { close.current(true); return }
    event.preventDefault()
    if (action.kind === 'close') close.current(true)
    else if (action.kind === 'focus') { items[action.index]?.focus({ preventScroll: true }); items[action.index]?.scrollIntoView({ block: 'nearest' }) }
  }
  return <div ref={menu} id={props.id} className="resource-tree-actions" role="menu" aria-label={`${props.title}的资源操作菜单`} tabIndex={-1} onKeyDown={keyDown}>{props.children}</div>
}
