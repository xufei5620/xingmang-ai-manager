import { useRef, useState, type ReactNode, type DragEvent } from 'react'
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react'
import { SafeImage } from '../components/MediaPreview'
import { collageInputIdentityKey, collageInputOrderFromSlots, moveCollageInput, type CollageInputIdentity, type ImageCollageInputOrder } from './collage-input-order'
import './collage-input-sorter.css'

export interface CollageSortableImage extends CollageInputIdentity { label: string; url?: string; pending: boolean }
export interface CollageSortGesture { key: string; scope: string }

export function finishCollageSort(items: readonly CollageSortableImage[], gesture: CollageSortGesture | null, scope: string, target: number): ImageCollageInputOrder | null {
  if (!gesture || gesture.scope !== scope) return null
  const from = items.findIndex((item) => collageInputIdentityKey(item) === gesture.key)
  if (from < 0 || target < 0 || target >= items.length || from === target) return null
  return collageInputOrderFromSlots(moveCollageInput(items, from, target))
}

/** Drag only commits on drop. Source changes, Escape and drag cancellation discard the gesture. */
export function CollageInputSorter({ items, disabled = false, scopeKey, compact = false, onReorder, renderPreview }: {
  items: readonly CollageSortableImage[]; disabled?: boolean; scopeKey: string; compact?: boolean
  onReorder(order: ImageCollageInputOrder): void
  renderPreview?(controls: (index: number) => ReactNode): ReactNode
}) {
  const gesture = useRef<CollageSortGesture | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const [notice, setNotice] = useState('')
  const scope = JSON.stringify([scopeKey, items.map((item) => [item.edgeId, item.outputIndex, item.url ?? '', item.pending])])
  const latest = useRef({ items, scope, disabled }); latest.current = { items, scope, disabled }
  const blocked = disabled || items.length > 20 || items.some((item) => item.pending)
  function clear() { gesture.current = null; setOver(null) }
  function commit(from: number, target: number) {
    if (blocked || from < 0 || from >= items.length) return
    const result = finishCollageSort(items, { key: collageInputIdentityKey(items[from]), scope }, scope, target)
    if (result) { onReorder(result); setNotice(`已将第 ${from + 1} 张图片移到第 ${target + 1} 位`) }
  }
  function targetIndex(event: DragEvent<HTMLElement>): number {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-collage-slot-index]') : null
    if (target && event.currentTarget.contains(target)) return Number(target.dataset.collageSlotIndex)
    // Styled canvases and loading overlays may be the event target. Hit the
    // actual cell bounds rather than requiring a drop on its tiny handle.
    for (const cell of event.currentTarget.querySelectorAll<HTMLElement>('[data-collage-slot-index]')) {
      const bounds = cell.getBoundingClientRect()
      if (bounds.width > 0 && bounds.height > 0 && event.clientX >= bounds.left && event.clientX < bounds.right && event.clientY >= bounds.top && event.clientY < bounds.bottom) return Number(cell.dataset.collageSlotIndex)
    }
    return -1
  }
  function controls(index: number) {
    const item = items[index]
    if (!item) return null
    return <button type="button" className="collage-input-grip" draggable={!blocked} disabled={blocked} title="拖拽调整顺序" aria-label={`第 ${index + 1} 张图片，拖拽调整顺序；方向键前后移动`} onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()} onDragStart={(event) => {
      event.stopPropagation()
      if (blocked) { event.preventDefault(); return }
      gesture.current = { key: collageInputIdentityKey(item), scope }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'xingmang-collage-input'); setNotice('拖到目标图片松开后调整顺序')
    }} onDragEnd={clear} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); clear(); setNotice('已取消排序'); return }
      if (!['ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight'].includes(event.key)) return
      event.stopPropagation(); event.preventDefault(); commit(index, index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1))
    }}><GripVertical size={13} /></button>
  }
  return <div className={`collage-input-sorter${compact ? ' is-compact' : ''}`} onDragOver={(event) => {
    const target = targetIndex(event)
    if (blocked || !gesture.current || gesture.current.scope !== latest.current.scope || target < 0) return
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setOver(target)
  }} onDrop={(event) => {
    if (!gesture.current) return
    const target = targetIndex(event), current = latest.current
    event.preventDefault(); event.stopPropagation()
    const result = !blocked && !current.disabled ? finishCollageSort(current.items, gesture.current, current.scope, target) : null
    clear()
    if (result) { onReorder(result); setNotice(`图片已移到第 ${target + 1} 位，可撤销恢复`) }
  }} onKeyDown={(event) => { if (event.key === 'Escape' && gesture.current) { event.preventDefault(); event.stopPropagation(); clear(); setNotice('已取消排序') } }}>
    {renderPreview?.(controls)}
    <div className="collage-input-sorter-heading"><strong>输入顺序</strong><span>拖动手柄或用方向键调整</span></div>
    {items.length > 20 ? <p role="alert">当前有 {items.length} 张图片，拼图最多支持 20 张；请减少输入后排序，不会自动截断。</p> : <ol aria-label="拼图输入顺序">{items.map((item, index) => <li key={collageInputIdentityKey(item)} data-collage-slot-index={index} className={over === index && gesture.current?.scope === scope ? 'is-drop-target' : ''}>
      <span className="collage-input-number">{index + 1}</span>{item.url && !item.pending ? <SafeImage src={item.url} alt="" draggable={false} /> : <span className="collage-input-pending">待就绪</span>}
      <span className="collage-input-label" title={item.label}>{item.label}{item.pending ? ' · 等待原输入' : ''}</span>
      {controls(index)}<button type="button" aria-label={`将第 ${index + 1} 张图片前移`} disabled={blocked || index === 0} onDoubleClick={(event) => event.stopPropagation()} onClick={() => commit(index, index - 1)}><ArrowUp size={13} /></button><button type="button" aria-label={`将第 ${index + 1} 张图片后移`} disabled={blocked || index === items.length - 1} onDoubleClick={(event) => event.stopPropagation()} onClick={() => commit(index, index + 1)}><ArrowDown size={13} /></button>
    </li>)}</ol>}
    <span className="collage-input-notice" role="status">{notice || (items.some((item) => item.pending) ? '原连线未就绪的位置会保留，不会换成其他图片。' : '排序影响预览和实际输出；批量新增图片追加在末尾。')}</span>
  </div>
}
