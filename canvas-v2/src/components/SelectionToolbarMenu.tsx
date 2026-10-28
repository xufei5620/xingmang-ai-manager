import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { Check } from 'lucide-react'
import { positionSelectionMenu, selectionMenuKey, type SelectionMenuPosition, type SelectionToolbarAction, type SelectionToolbarActionId } from './selection-toolbar-model'

interface SelectionToolbarMenuProps {
  id: string
  title: string
  count: number
  actions: readonly SelectionToolbarAction[]
  anchorRef: RefObject<HTMLButtonElement | null>
  focusEdge: 'first' | 'last'
  onActivate(id: SelectionToolbarActionId): void
  onClose(restoreFocus?: boolean): void
}

export function SelectionToolbarMenu(props: SelectionToolbarMenuProps) {
  const menu = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<SelectionMenuPosition | null>(null)
  const positioned = position !== null
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  useLayoutEffect(() => {
    const anchor = props.anchorRef.current, panel = menu.current
    if (!anchor || !panel) return
    let frame: number | null = null
    function measure() {
      frame = null
      if (!anchor || !panel) return
      const viewport = window.visualViewport
      const next = positionSelectionMenu(anchor.getBoundingClientRect(), { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0, width: viewport?.width ?? window.innerWidth, height: viewport?.height ?? window.innerHeight }, panel.scrollHeight + 2)
      setPosition((current) => current && current.left === next.left && current.top === next.top && current.width === next.width && current.maxHeight === next.maxHeight ? current : next)
    }
    function schedule() { if (frame === null) frame = requestAnimationFrame(measure) }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(panel)
    observer.observe(anchor)
    // The trigger can move when the library rail or inspector opens without
    // changing the trigger's own size or the window width.
    const flow = anchor.closest('.canvas-flow')
    if (flow) observer.observe(flow)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [props.anchorRef])

  useEffect(() => {
    if (!positioned) return
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')
    items?.[props.focusEdge === 'last' ? items.length - 1 : 0]?.focus({ preventScroll: true })
    function dismissOutside(event: Event) {
      const target = event.target
      if (target instanceof Node && (menu.current?.contains(target) || props.anchorRef.current?.contains(target))) return
      onClose.current(false)
    }
    document.addEventListener('pointerdown', dismissOutside, true)
    document.addEventListener('focusin', dismissOutside)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside, true)
      document.removeEventListener('focusin', dismissOutside)
    }
  }, [props.anchorRef, props.focusEdge, positioned])

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])]
    const action = selectionMenuKey(event.key, items.indexOf(document.activeElement as HTMLButtonElement), items.length)
    if (!action) return
    // Focus the trigger before native Tab advances out of this portal. Do not
    // trap Tab or send focus to an unrelated position at the end of <body>.
    if (action.kind === 'tab') { onClose.current(true); return }
    event.preventDefault()
    if (action.kind === 'close') onClose.current(true)
    else if (action.kind === 'focus') { items[action.index]?.focus({ preventScroll: true }); items[action.index]?.scrollIntoView({ block: 'nearest' }) }
  }

  const content = <div ref={menu} id={props.id} className="canvas-selection-menu nodrag nowheel" role="menu" aria-labelledby={`${props.id}-trigger`} tabIndex={-1} style={position ? { ...position, visibility: 'visible' } : { visibility: 'hidden' }} onKeyDown={keyDown} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <div className="canvas-selection-menu-heading" role="presentation"><strong>{props.title}</strong><span>{props.count} 个节点</span></div>
    <SelectionToolbarMenuItems id={props.id} actions={props.actions} onActivate={props.onActivate} />
    {props.title === '选区布局' && <p className="canvas-selection-menu-note">分组与选中的子节点按一个整体计算；锁定位置保持不变。</p>}
  </div>
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}

export function SelectionToolbarMenuItems({ id, actions, onActivate }: { id: string; actions: readonly SelectionToolbarAction[]; onActivate(id: SelectionToolbarActionId): void }) {
  return <>{actions.map((action, index) => <div key={action.id} role="presentation">
    {actions[index - 1]?.section !== action.section && <div className="canvas-selection-menu-section" role="presentation">{action.section}</div>}
    <button type="button" role={action.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} tabIndex={-1} aria-label={action.ariaLabel} aria-checked={action.checked} aria-disabled={Boolean(action.disabledReason)} aria-describedby={action.disabledReason ? `${id}-${index}-reason` : undefined} className={action.danger ? 'is-danger' : undefined} onClick={() => { if (!action.disabledReason) onActivate(action.id) }}>
      <span className="canvas-selection-menu-label"><span>{action.label}</span>{action.shortcut && <kbd aria-hidden="true">{action.shortcut}</kbd>}{action.checked && <Check size={14} aria-hidden="true" />}</span>
      {action.disabledReason && <small id={`${id}-${index}-reason`}>{action.disabledReason}</small>}
    </button>
  </div>)}</>
}
