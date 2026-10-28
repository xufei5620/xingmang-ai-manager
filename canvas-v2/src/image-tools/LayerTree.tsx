import { useEffect, useId, useRef, useState, type PointerEvent } from 'react'
import { Brush, ChevronDown, ChevronRight, Circle, Eye, EyeOff, Folder, FolderOpen, GripVertical, ImagePlus, LockKeyhole, MoveRight, PenTool, Square, Type, UnlockKeyhole } from 'lucide-react'
import { SafeImage } from '../components/MediaPreview'
import type { EditorLayerTreeRow, LayerEditorSnapshot } from './layer-editor-state'
import type { LayerToolImage } from './layerpreview'
import type { ImageLayerRecipe } from './recipe'

export interface LayerTreeProps {
  recipe: ImageLayerRecipe
  rows: readonly EditorLayerTreeRow[]
  images: readonly LayerToolImage[]
  selectedIds: readonly string[]
  selectedId: string | null
  selectedGroupId?: string | null
  collapsed: ReadonlySet<string>
  name(index: number): string
  onSelect(row: EditorLayerTreeRow, modifiers: { toggle?: boolean; range?: boolean }): void
  onCollapse(id: string): void
  onVisibility(row: EditorLayerTreeRow): void
  onLock(row: EditorLayerTreeRow): void
  onMoveStart?(row?: EditorLayerTreeRow): LayerEditorSnapshot | null
  onInspectMove?(snapshot: LayerEditorSnapshot, targetId: string | null, position: LayerTreeMovePosition): string
  onMove?(snapshot: LayerEditorSnapshot, targetId: string | null, position: LayerTreeMovePosition): { ok: boolean; message: string }
}

export type LayerTreeMovePosition = 'before' | 'inside' | 'after'
interface TreeDrop { targetId: string | null; position: LayerTreeMovePosition; label: string; reason: string }
interface TreeDrag { pointerId: number; x: number; y: number; clientX: number; clientY: number; active: boolean; snapshot: LayerEditorSnapshot; handle: HTMLButtonElement; drop: TreeDrop | null }

/** The tree reads top-to-bottom, while placement uses bottom-to-top paint order. */
export function layerTreeDropPosition(kind: 'layer' | 'group', y: number, box: { top: number; height: number }): LayerTreeMovePosition {
  const ratio = (y - box.top) / Math.max(1, box.height)
  return kind === 'group' && ratio >= .25 && ratio <= .75 ? 'inside' : ratio < .5 ? 'after' : 'before'
}

export function LayerGroupNameField({ id, name, onCommit }: { id: string; name: string; onCommit(id: string, name: string): void }) {
  const [draft, setDraft] = useState(name), [error, setError] = useState(''), cancel = useRef(false)
  useEffect(() => { setDraft(name); setError(''); cancel.current = false }, [id, name])
  function commit() {
    if (cancel.current) { cancel.current = false; return }
    const value = draft.trim()
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) { setDraft(name); setError('请输入有效的编组名称，已保留原名称'); return }
    setDraft(value); setError(''); if (value !== name) onCommit(id, value)
  }
  return <label>编组名称<input aria-label="编组名称" maxLength={80} value={draft} aria-invalid={!!error} onChange={(event) => { setDraft(event.target.value); setError('') }} onBlur={commit} onKeyDown={(event) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); event.currentTarget.blur() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current = true; setDraft(name); setError(''); event.currentTarget.blur() }
  }} />{error && <small role="alert">{error}</small>}</label>
}

export function layerTreeSelectionBounds(recipe: ImageLayerRecipe, indices: readonly number[]): { x: number; y: number; width: number; height: number } | null {
  const bounds = indices.map((index) => recipe.layers[index]).filter(Boolean).map((layer) => {
    const width = layer.width * recipe.outputWidth, height = layer.height * recipe.outputHeight, angle = layer.rotation * Math.PI / 180
    const halfWidth = (Math.abs(Math.cos(angle)) * width + Math.abs(Math.sin(angle)) * height) / 2, halfHeight = (Math.abs(Math.sin(angle)) * width + Math.abs(Math.cos(angle)) * height) / 2
    const x = layer.x * recipe.outputWidth + width / 2, y = layer.y * recipe.outputHeight + height / 2
    return { left: x - halfWidth, top: y - halfHeight, right: x + halfWidth, bottom: y + halfHeight }
  })
  if (!bounds.length) return null
  const x = Math.min(...bounds.map((box) => box.left)), y = Math.min(...bounds.map((box) => box.top))
  return { x, y, width: Math.max(...bounds.map((box) => box.right)) - x, height: Math.max(...bounds.map((box) => box.bottom)) - y }
}

/** Native nested lists keep row controls discoverable by Tab while preserving
 * the editor's existing arrow-key movement on the selected document objects. */
export function LayerTree({ recipe, rows, images, selectedIds, selectedId, selectedGroupId, collapsed, name, onSelect, onCollapse, onVisibility, onLock, onMoveStart, onInspectMove, onMove }: LayerTreeProps) {
  const prefix = useId(), selected = new Set(selectedIds), list = useRef<HTMLUListElement>(null), moveTrigger = useRef<HTMLButtonElement>(null), targetInput = useRef<HTMLSelectElement>(null)
  const drag = useRef<TreeDrag | null>(null), scrollFrame = useRef<number | null>(null)
  const [drop, setDrop] = useState<TreeDrop | null>(null), [dragging, setDragging] = useState(false), [message, setMessage] = useState('')
  const [moveScope, setMoveScope] = useState<LayerEditorSnapshot | null>(null), [destination, setDestination] = useState(''), [position, setPosition] = useState<LayerTreeMovePosition>('inside')
  const movable = Boolean(onMoveStart && onInspectMove && onMove), selectionKey = JSON.stringify([selectedIds, selectedId, selectedGroupId ?? null])
  const selectionLocked = rows.some((row) => row.kind === 'layer' && selected.has(row.id) && row.locked)
  const destinationRow = rows.find((row) => row.id === destination)
  const moveReason = moveScope ? onInspectMove?.(moveScope, destination || null, position) ?? '' : ''

  function rowLabel(row: EditorLayerTreeRow): string { return row.group?.name || (row.layerIndex === undefined ? '图层' : name(row.layerIndex)) }
  function currentScope(snapshot: LayerEditorSnapshot): boolean {
    return snapshot.recipe === recipe && JSON.stringify([snapshot.selectedIds ?? (snapshot.selectedId ? [snapshot.selectedId] : []), snapshot.selectedId, snapshot.selectedGroupId ?? null]) === selectionKey
  }
  function releaseDrag() {
    const active = drag.current
    drag.current = null
    if (scrollFrame.current !== null) { cancelAnimationFrame(scrollFrame.current); scrollFrame.current = null }
    if (active?.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId)
    setDragging(false); setDrop(null)
  }
  function cancelDrag(announce = true) { if (!drag.current) return; releaseDrag(); if (announce) setMessage('已取消移动，图层层级未修改') }
  function closeMove(restore = true) { setMoveScope(null); if (restore) moveTrigger.current?.focus({ preventScroll: true }) }
  function revealMoved(snapshot: LayerEditorSnapshot) {
    const id = snapshot.selectedGroupId || snapshot.selectedId || snapshot.selectedIds?.at(-1)
    requestAnimationFrame(() => {
      const row = Array.from(list.current?.querySelectorAll<HTMLElement>('[data-layer-tree-row]') ?? []).find((item) => item.dataset.layerTreeRow === id)
      const button = row?.querySelector<HTMLButtonElement>('.layer-editor-row-select')
      if (button?.isConnected && !button.closest('[hidden],[inert]')) { button.focus({ preventScroll: true }); button.scrollIntoView({ block: 'nearest' }) }
      else if (moveTrigger.current?.isConnected && !moveTrigger.current.closest('[hidden],[inert]')) moveTrigger.current.focus({ preventScroll: true })
    })
  }
  function openMove(row?: EditorLayerTreeRow) {
    releaseDrag()
    const snapshot = onMoveStart?.(row)
    if (!snapshot) return
    setMoveScope(snapshot); setDestination(''); setPosition('inside'); setMessage('')
    requestAnimationFrame(() => targetInput.current?.focus())
  }
  function submitMove(snapshot: LayerEditorSnapshot, targetId: string | null, placement: LayerTreeMovePosition) {
    const result = onMove?.(snapshot, targetId, placement)
    if (!result) return
    setMessage(result.message)
    if (result.ok) { setMoveScope(null); revealMoved(snapshot) }
  }
  function updateDrop(clientX: number, clientY: number) {
    const active = drag.current
    if (!active?.active) return
    const target = document.elementFromPoint(clientX, clientY)
    const root = target?.closest('[data-layer-tree-root]')
    const element = target?.closest<HTMLElement>('[data-layer-tree-row]')
    const row = element && rows.find((item) => item.id === element.dataset.layerTreeRow)
    let next: TreeDrop | null = null
    if (root && list.current?.parentElement?.contains(root)) next = { targetId: null, position: 'inside', label: '移到文档根最上方', reason: onInspectMove?.(active.snapshot, null, 'inside') ?? '' }
    else if (row && element && list.current?.contains(element)) {
      const placement = layerTreeDropPosition(row.kind, clientY, element.getBoundingClientRect())
      next = { targetId: row.id, position: placement, label: placement === 'inside' ? `移入 ${rowLabel(row)} 最上方` : `移到 ${rowLabel(row)} ${placement === 'after' ? '上方' : '下方'}`, reason: onInspectMove?.(active.snapshot, row.id, placement) ?? '' }
    }
    active.drop = next; setDrop(next)
  }
  function scrollDrag() {
    scrollFrame.current = null
    const active = drag.current, element = list.current
    if (!active?.active || !element) return
    const box = element.getBoundingClientRect(), direction = active.clientY < box.top + 25 ? -1 : active.clientY > box.bottom - 25 ? 1 : 0
    if (direction) { element.scrollTop += direction * 10; updateDrop(active.clientX, active.clientY) }
    scrollFrame.current = requestAnimationFrame(scrollDrag)
  }
  function startDrag(event: PointerEvent<HTMLButtonElement>, row: EditorLayerTreeRow) {
    if (event.button !== 0 || event.isPrimary === false || drag.current && drag.current.pointerId !== event.pointerId || row.locked || !movable) return
    event.preventDefault(); event.stopPropagation(); releaseDrag(); setMoveScope(null)
    const snapshot = onMoveStart?.(row)
    if (!snapshot) return
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, clientX: event.clientX, clientY: event.clientY, active: false, snapshot, handle: event.currentTarget, drop: null }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault(); event.stopPropagation(); active.clientX = event.clientX; active.clientY = event.clientY
    if (!active.active && Math.hypot(event.clientX - active.x, event.clientY - active.y) < 5) return
    if (!active.active) { active.active = true; setDragging(true); scrollFrame.current = requestAnimationFrame(scrollDrag) }
    updateDrop(event.clientX, event.clientY)
  }
  function endDrag(event: PointerEvent<HTMLButtonElement>) {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    if (active.active) updateDrop(event.clientX, event.clientY)
    const destination = active.drop
    releaseDrag()
    if (!active.active) return
    if (destination && !destination.reason) submitMove(active.snapshot, destination.targetId, destination.position)
    else setMessage(destination?.reason || '未选择有效位置，图层层级未修改')
  }
  useEffect(() => {
    if (drag.current && !currentScope(drag.current.snapshot)) cancelDrag()
    if (moveScope && !currentScope(moveScope)) { closeMove(false); setMessage('图层或选择已变化，请重新选择移动位置') }
  }, [recipe, selectionKey])
  useEffect(() => () => { const active = drag.current; drag.current = null; if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current); if (active?.handle.hasPointerCapture(active.pointerId)) active.handle.releasePointerCapture(active.pointerId) }, [])

  function children(parentId: string | null) {
    return rows.filter((row) => row.parentId === parentId).map((row) => {
      const group = row.kind === 'group' ? row.group : null, layer = row.layerIndex === undefined ? null : recipe.layers[row.layerIndex]
      const label = group?.name || (row.layerIndex === undefined ? '图层' : name(row.layerIndex)), kind = group ? '编组' : '图层'
      const chosen = row.leafIds.length > 0 && row.leafIds.every((id) => selected.has(id)), primary = group ? selectedGroupId === row.id : selectedId === row.id
      const folded = collapsed.has(row.id), inheritedLock = Boolean(row.parentId && rows.find((parent) => parent.id === row.parentId)?.locked)
      const childId = `${prefix}-children-${row.id}`
      return <li key={row.id} className={`layer-editor-tree-item${group ? ' is-group' : ''}`}>
        <div data-layer-tree-row={row.id} className={`layer-editor-row${chosen ? ' is-selected' : ''}${primary ? ' is-primary' : ''}${!row.visible ? ' is-hidden' : ''}${group ? ' is-group-row' : ''}${drop?.targetId === row.id ? ` is-drop-${drop.position}${drop.reason ? ' is-drop-refused' : ''}` : ''}`}>
          {movable && <button type="button" className="layer-editor-tree-grip" aria-label={`拖动移动${kind} ${label}`} title={row.locked ? '请先解锁图层或上级编组' : '拖动调整层级；也可点击移动到选择位置'} disabled={row.locked} onPointerDown={(event) => startDrag(event, row)} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={(event) => { if (drag.current?.pointerId === event.pointerId) cancelDrag() }} onLostPointerCapture={(event) => { if (drag.current?.pointerId === event.pointerId) cancelDrag() }} onClick={(event) => { if (event.detail === 0) openMove(row) }}><GripVertical size={12} /></button>}
          {group ? <button type="button" className="layer-editor-group-fold" aria-label={`${folded ? '展开' : '折叠'}编组 ${label}`} aria-expanded={!folded} aria-controls={childId} onClick={() => onCollapse(row.id)}>{folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span className="layer-editor-group-fold-space" aria-hidden="true" />}
          <button type="button" className="layer-editor-row-select" aria-pressed={chosen} aria-label={`选择${kind} ${label}`} title={group ? '穿透编组：保留子图层的混合方式' : primary ? '主选图层 · Ctrl/⌘ 切换多选，Shift 连选' : 'Ctrl/⌘ 切换多选，Shift 连选'} onClick={(event) => onSelect(row, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey })}>
            <span className="layer-editor-thumb">{group ? folded ? <Folder size={18} /> : <FolderOpen size={18} /> : layer?.content?.kind === 'text' ? <Type size={18} /> : layer?.content?.kind === 'shape' ? layer.content.shape === 'ellipse' ? <Circle size={18} /> : <Square size={18} /> : layer?.content?.kind === 'path' ? <PenTool size={18} /> : layer?.content?.kind === 'paint' ? <Brush size={18} /> : layer && row.visible && images[layer.sourceIndex]?.asset.localUrl ? <SafeImage src={images[layer.sourceIndex].asset.localUrl!} alt="" /> : <ImagePlus size={18} />}</span>
            <span className="layer-editor-tree-label"><span>{label}</span>{group && <small>{row.leafIds.length} 层</small>}{!row.visible && row.ownVisible && <small>随组隐藏</small>}{inheritedLock && <small>组锁定</small>}</span>
          </button>
          <button type="button" aria-label={`${row.ownVisible ? '隐藏' : '显示'}${kind} ${label}`} title={!row.visible && row.ownVisible ? '上级编组已隐藏；此项的显示设置仍保留' : `${row.ownVisible ? '隐藏' : '显示'}${kind}`} aria-pressed={row.ownVisible} onClick={() => onVisibility(row)}>{row.ownVisible ? <Eye size={14} /> : <EyeOff size={14} />}</button>
          <button type="button" aria-label={`${inheritedLock ? '组已锁定' : row.ownLocked ? '解锁' : '锁定'}${kind} ${label}`} title={inheritedLock ? '请先解锁上级编组；此项的锁定设置仍保留' : `${row.ownLocked ? '解锁' : '锁定'}${kind}`} disabled={inheritedLock} aria-pressed={row.locked} onClick={() => onLock(row)}>{row.locked ? <LockKeyhole size={13} /> : <UnlockKeyhole size={13} />}</button>
        </div>
        {group && <ul id={childId} aria-label={`${label} 中的图层`} hidden={folded}>{children(row.id)}</ul>}
      </li>
    })
  }
  return <div className={`layer-editor-tree-wrap${dragging ? ' is-dragging' : ''}`} onKeyDown={(event) => {
    if (!drag.current && !moveScope) return
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); if (drag.current) cancelDrag(); else closeMove() }
    else if (drag.current) { cancelDrag(); if (event.key !== 'Tab') event.preventDefault() }
  }}>
    {dragging && <div data-layer-tree-root="true" className={`layer-editor-tree-root${drop?.targetId === null ? ` is-drop-inside${drop.reason ? ' is-drop-refused' : ''}` : ''}`}>文档根最上方</div>}
    <ul ref={list} className="layer-editor-list layer-editor-tree" aria-label="图层与编组">{children(null)}</ul>
    {movable && <button ref={moveTrigger} type="button" className="layer-editor-tree-move-trigger" disabled={!selectedIds.length || selectionLocked} onClick={() => openMove()}><MoveRight size={13} />移动到…</button>}
    {moveScope && <section className="layer-editor-tree-move-panel" role="group" aria-label="移动所选图层到指定位置">
      <label>移动目标<select ref={targetInput} aria-label="移动目标" value={destination} onChange={(event) => { const id = event.target.value; setDestination(id); if (!id) setPosition('inside'); else if (position === 'inside' && rows.find((row) => row.id === id)?.kind !== 'group') setPosition('after') }}><option value="">文档根</option>{rows.map((row) => <option key={row.id} value={row.id}>{'　'.repeat(row.depth)}{row.kind === 'group' ? '编组 · ' : '图层 · '}{rowLabel(row)}</option>)}</select></label>
      <label>放置位置<select aria-label="放置位置" value={position} onChange={(event) => setPosition(event.target.value as LayerTreeMovePosition)}>{destination && <><option value="after">目标上方</option><option value="before">目标下方</option></>}{(!destination || destinationRow?.kind === 'group') && <option value="inside">{destination ? '移入组内最上方' : '文档根最上方'}</option>}</select></label>
      {moveReason ? <p role="status">{moveReason}</p> : <p>保留图层位置和自身设置；目标编组的显隐与锁定会按层级生效。</p>}
      <div><button type="button" onClick={() => closeMove()}>取消移动</button><button type="button" className="is-primary" disabled={!!moveReason} onClick={() => submitMove(moveScope, destination || null, position)}>确认移动</button></div>
    </section>}
    <p className="layer-editor-tree-move-status" role="status" aria-live="polite">{dragging ? drop?.reason || drop?.label || '拖动到图层上方、下方或编组中间，按 Esc 取消' : message}</p>
  </div>
}
