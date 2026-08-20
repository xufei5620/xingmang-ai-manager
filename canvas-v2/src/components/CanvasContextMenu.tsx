import { useEffect, useRef } from 'react'
import { canvasContextMenuItems, type CanvasContextAction, type CanvasContextMenuInput } from '../editor/context-menu'

export interface CanvasContextMenuState extends CanvasContextMenuInput {
  nodeId: string
  x: number
  y: number
}

export function CanvasContextMenu({ state, onAction, onClose }: {
  state: CanvasContextMenuState
  onAction(action: CanvasContextAction, nodeId: string): void
  onClose(): void
}) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    menuRef.current?.querySelector('button')?.focus()
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !menuRef.current?.contains(event.target)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose() }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const items = canvasContextMenuItems(state)
  return (
    <div
      ref={menuRef}
      className="canvas-context-menu"
      role="menu"
      aria-label={state.target === 'node' ? '节点操作' : '选区操作'}
      style={{ left: state.x, top: state.y }}
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          className={`${item.separatorBefore ? 'has-separator' : ''}${item.danger ? ' is-danger' : ''}`.trim()}
          disabled={item.action === 'run' && state.running}
          onClick={() => { onClose(); onAction(item.action, state.nodeId) }}
        >{item.label}</button>
      ))}
    </div>
  )
}
