import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { Film, Focus, LayoutGrid, MoreHorizontal, Play, SlidersHorizontal } from 'lucide-react'
import type { CanvasAlignMode, CanvasDistributeAxis } from '../editor/align'
import { SelectionToolbarMenu } from './SelectionToolbarMenu'
import { selectionToolbarActions, type SelectionToolbarActionId, type SelectionToolbarMenuKind } from './selection-toolbar-model'
import './selection-toolbar.css'

export interface SelectionToolbarProps {
  readOnly?: boolean
  count: number
  canGroup: boolean
  canUngroup: boolean
  allLocked: boolean
  canToggleDisabled: boolean
  allDisabled: boolean
  onAlign(mode: CanvasAlignMode): void
  onDistribute(axis: CanvasDistributeAxis): void
  onCopy(): void
  onDuplicate(): void
  onGroup(): void
  onUngroup(): void
  onToggleLocked(): void
  onToggleDisabled(): void
  onFocus(): void
  onInspect(): void
  onSaveWorkshop?(): void
  onSendAgent?(): void
  agentDisabledReason?: string
  onBatchImages?(): void
  batchImagesDisabledReason?: string
  onRunTo?(): void
  onRunFrom?(): void
  onSelectVideoFrame?(): void
  onCreateFrameSequence?(): void
  frameSequenceDisabledReason?: string
  runDisabledReason?: string
  onDelete(): void
}

export function SelectionToolbar(props: SelectionToolbarProps) {
  const [menu, setMenu] = useState<SelectionToolbarMenuKind | null>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<HTMLButtonElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const runRef = useRef<HTMLButtonElement>(null)
  const focusEdge = useRef<'first' | 'last'>('first')
  const id = useId()
  const hasRunActions = !props.readOnly && props.count === 1 && !!props.onRunTo && !!props.onRunFrom
  const actions = selectionToolbarActions({ ...props, canSaveWorkshop: Boolean(props.onSaveWorkshop), canSendAgent: Boolean(props.onSendAgent), hasBatchImages: Boolean(props.onBatchImages), hasRunActions }, menu ?? 'more')
  useEffect(() => { setMenu(null) }, [props.count, hasRunActions])

  const close = useCallback((restoreFocus = false) => {
    setMenu(null)
    if (restoreFocus) (menu === 'layout' ? layoutRef : menu === 'run' ? runRef : moreRef).current?.focus({ preventScroll: true })
  }, [menu])

  function activate(actionId: SelectionToolbarActionId) {
    const action = actions.find((item) => item.id === actionId)
    if (!action || action.disabledReason || props.readOnly && !['inspect', 'focus', 'copy'].includes(actionId)) return
    close(true)
    switch (actionId) {
      case 'inspect': props.onInspect(); break
      case 'focus': props.onFocus(); break
      case 'copy': props.onCopy(); break
      case 'duplicate': props.onDuplicate(); break
      case 'save': props.onSaveWorkshop?.(); break
      case 'agent': props.onSendAgent?.(); break
      case 'batch-images': props.onBatchImages?.(); break
      case 'run-to': props.onRunTo?.(); break
      case 'run-from': props.onRunFrom?.(); break
      case 'lock': props.onToggleLocked(); break
      case 'disable': props.onToggleDisabled(); break
      case 'group': props.onGroup(); break
      case 'ungroup': props.onUngroup(); break
      case 'delete': props.onDelete(); break
      case 'align:left': props.onAlign('left'); break
      case 'align:horizontal-center': props.onAlign('horizontal-center'); break
      case 'align:right': props.onAlign('right'); break
      case 'align:top': props.onAlign('top'); break
      case 'align:vertical-center': props.onAlign('vertical-center'); break
      case 'align:bottom': props.onAlign('bottom'); break
      case 'distribute:horizontal': props.onDistribute('horizontal'); break
      case 'distribute:vertical': props.onDistribute('vertical'); break
    }
  }

  function open(kind: SelectionToolbarMenuKind, edge: 'first' | 'last' = 'first') {
    focusEdge.current = edge
    setMenu(kind)
  }
  function triggerKey(event: KeyboardEvent<HTMLButtonElement>, kind: SelectionToolbarMenuKind) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation()
      open(kind, event.key === 'ArrowUp' ? 'last' : 'first')
    }
  }
  function toolbarKey(event: KeyboardEvent<HTMLDivElement>) {
    // A focused control owns its keys. Delete/Backspace and canvas shortcuts
    // must never edit the document while navigating toolbar/menu controls.
    event.stopPropagation()
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    const buttons = [...(toolbarRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    if (!buttons.length) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowLeft' ? -1 : 1) + buttons.length) % buttons.length
    buttons[next]?.focus({ preventScroll: true })
  }

  if (props.count === 0) return null
  return <div ref={toolbarRef} className="canvas-selection-toolbar" role="toolbar" aria-label="选中节点操作" onKeyDown={toolbarKey} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <span className="canvas-selection-count">{props.count} 个节点</span>
    {!props.readOnly && props.count === 1 && props.onSelectVideoFrame && <button type="button" aria-label="选择视频帧" onClick={props.onSelectVideoFrame}><Film size={15} aria-hidden="true" /><span>选帧</span></button>}
    {!props.readOnly && props.count === 1 && props.onCreateFrameSequence && <button type="button" aria-label="创建视频分镜" title={props.frameSequenceDisabledReason || '从视频选择多个画面，创建抽帧与有序拼图'} disabled={Boolean(props.frameSequenceDisabledReason)} onClick={props.onCreateFrameSequence}><Film size={15} aria-hidden="true" /><span>分镜</span></button>}
    {hasRunActions && <button ref={runRef} id={`${id}-run-trigger`} type="button" title="运行当前节点及关联链路" aria-label="选中节点运行" aria-haspopup="menu" aria-expanded={menu === 'run'} aria-controls={menu === 'run' ? `${id}-run` : undefined} onKeyDown={(event) => triggerKey(event, 'run')} onClick={() => menu === 'run' ? close(true) : open('run')}><Play size={15} aria-hidden="true" /><span>运行</span></button>}
    <button type="button" title="查看节点详情" aria-label="查看选中节点详情" onClick={props.onInspect}><SlidersHorizontal size={15} aria-hidden="true" /><span>详情</span></button>
    <button type="button" title="聚焦选区" aria-label="聚焦选中节点" onClick={props.onFocus}><Focus size={15} aria-hidden="true" /><span>聚焦</span></button>
    <button ref={layoutRef} id={`${id}-layout-trigger`} type="button" title="对齐与均分间距" aria-label="选区布局" disabled={props.readOnly} aria-haspopup="menu" aria-expanded={menu === 'layout'} aria-controls={menu === 'layout' ? `${id}-layout` : undefined} onKeyDown={(event) => triggerKey(event, 'layout')} onClick={() => menu === 'layout' ? close(true) : open('layout')}><LayoutGrid size={15} aria-hidden="true" /><span>布局</span></button>
    <button ref={moreRef} id={`${id}-more-trigger`} type="button" title="复制、编组与更多选区操作" aria-label="更多选区操作" aria-haspopup="menu" aria-expanded={menu === 'more'} aria-controls={menu === 'more' ? `${id}-more` : undefined} onKeyDown={(event) => triggerKey(event, 'more')} onClick={() => menu === 'more' ? close(true) : open('more')}><MoreHorizontal size={15} aria-hidden="true" /><span>更多</span></button>
    {menu && <SelectionToolbarMenu key={menu} id={`${id}-${menu}`} title={menu === 'layout' ? '选区布局' : menu === 'run' ? '选中节点运行' : '更多选区操作'} count={props.count} actions={actions} anchorRef={menu === 'layout' ? layoutRef : menu === 'run' ? runRef : moreRef} focusEdge={focusEdge.current} onActivate={activate} onClose={close} />}
  </div>
}
