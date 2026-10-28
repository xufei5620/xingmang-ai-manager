import { useEffect, useRef, type KeyboardEvent } from 'react'
import { canvasContextMenuItems, type CanvasContextAction, type CanvasContextMenuInput } from '../editor/context-menu'

export interface CanvasContextMenuState extends CanvasContextMenuInput {
  nodeId: string
  nodeIds: readonly string[]
  x: number
  y: number
  scope?: string
}

export function CanvasContextMenu({ state, onAction, onClose }: {
  state: CanvasContextMenuState
  onAction(action: CanvasContextAction, nodeId: string): void
  onClose(): void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const previousActiveElementRef = useRef<HTMLElement | null>(null)
  const dismissedRef = useRef(false)
  onCloseRef.current = onClose

  function close(restoreFocus = false) {
    if (dismissedRef.current) return
    dismissedRef.current = true
    if (restoreFocus && previousActiveElementRef.current?.isConnected) previousActiveElementRef.current.focus({ preventScroll: true })
    onCloseRef.current()
  }

  function activate(action: CanvasContextAction) {
    if (dismissedRef.current) return
    close()
    onAction(action, state.nodeId)
  }

  useEffect(() => {
    const previous = document.activeElement
    // StrictMode can replay setup after the menu already owns focus. Keep the
    // original return target rather than remembering the menu's first row.
    if (previous instanceof HTMLElement && !menuRef.current?.contains(previous)) previousActiveElementRef.current = previous
    dismissedRef.current = false
    menuRef.current?.querySelector<HTMLElement>('summary, button:not(:disabled)')?.focus({ preventScroll: true })
    function dismissOutside(event: Event) {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) close()
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('focusin', dismissOutside)
    return () => {
      dismissedRef.current = true
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('focusin', dismissOutside)
    }
  }, [state.nodeId, state.x, state.y, state.scope])

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (dismissedRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Tab') { close(); return }
    if (event.key === 'Escape') { event.preventDefault(); close(true); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const controls = [...(menuRef.current?.querySelectorAll<HTMLElement>('summary, button:not(:disabled)') ?? [])].filter((element) => {
      if (!element.getClientRects().length) return false
      // Chromium may retain layout rectangles inside a closed details element,
      // although its descendants cannot receive focus. Check every ancestor.
      for (let ancestor = element.parentElement; ancestor && ancestor !== menuRef.current; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === 'DETAILS' && !ancestor.hasAttribute('open') && ancestor.querySelector('summary') !== element) return false
      }
      return true
    })
    if (!controls.length) return
    event.preventDefault()
    const current = controls.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
      : current < 0 ? event.key === 'ArrowUp' ? controls.length - 1 : 0
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length
    controls[next]?.focus({ preventScroll: true })
    controls[next]?.scrollIntoView({ block: 'nearest' })
  }

  const items = canvasContextMenuItems(state)
  return (
    <div
      ref={menuRef}
      className="canvas-context-menu"
      role="menu"
      aria-label={state.target === 'node' ? '节点操作' : '选区操作'}
      style={{ left: state.x, top: state.y }}
      onKeyDown={handleKeyDown}
    >
      {state.target === 'node' && Boolean(state.relatedOptions?.length) && <details className="canvas-context-related"><summary>添加关联节点</summary>{state.relatedOptions?.map((option) => <button key={option.id} type="button" role="menuitem" onClick={() => activate(`related:${option.id}`)}>关联 · {option.label}</button>)}</details>}
      {state.batchImages && <button type="button" role="menuitem" aria-disabled={Boolean(state.batchImages.disabledReason)} title={state.batchImages.disabledReason} onClick={() => { if (!state.batchImages?.disabledReason) activate('batch-images') }}>关联图片工具{state.batchImages.disabledReason && <small style={{ display: 'block', whiteSpace: 'normal' }}>{state.batchImages.disabledReason}</small>}</button>}
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={`${item.separatorBefore ? 'has-separator' : ''}${item.danger ? ' is-danger' : ''}`.trim()}
          disabled={item.action === 'run' && state.running}
          onClick={() => activate(item.action)}
        >{item.label}</button>
      ))}
    </div>
  )
}
