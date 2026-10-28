import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { ArrowLeftRight, ImageOff } from 'lucide-react'
import { SafeImage } from '../components/MediaPreview'
import { CompareViewport } from './CompareViewport'
import { changeCompareParallelCount, changeCompareSelection, compareSliderPosition, compareStageAspectRatio, compareViewSelections, resolveCompareSlot, type CompareImageSlot, type CompareSelectionTarget, type CompareViewState, type ResolvedCompareSlot } from './compare-view-state'
import './image-compare.css'

export type { CompareImageSlot, CompareMode, CompareViewState } from './compare-view-state'
export interface ImageComparePreviewProps {
  slots: readonly CompareImageSlot[]
  view: CompareViewState
  scopeKey?: string
  onChange(view: CompareViewState): void
  onCommit?(view: CompareViewState): void
  disabled?: boolean
  expanded?: boolean
}

interface CompareSliderGesture {
  kind: 'stage' | 'range'
  pointerId: number | null
  before: CompareViewState
  next: CompareViewState
  scopeKey: string
  field: 'position' | 'opacity'
}

function retainCompareGesture(drag: { current: CompareSliderGesture | null }, previousPosition: { current: number }, view: CompareViewState, scopeKey: string, canSlide: boolean) {
  const current = drag.current
  // A controlled draft echoes next.position. A different external value (undo,
  // another view, or a changed input scope) invalidates the old pointer owner.
  const value = view.mode === 'opacity' ? view.opacity ?? 50 : view.position
  const next = current?.field === 'opacity' ? current.next.opacity ?? 50 : current?.next.position
  if (current && (!canSlide || current.scopeKey !== scopeKey || !['slider', 'opacity'].includes(view.mode) || current.before.mode !== view.mode || current.before.a !== view.a || current.before.b !== view.b
    || (value !== previousPosition.current && value !== next))) drag.current = null
  previousPosition.current = value
}

function CompareImage({ selection, label, style }: { selection: ResolvedCompareSlot; label: string; style?: CSSProperties }) {
  const slot = selection.slot
  if (selection.status !== 'ready' || !slot?.asset?.localUrl) return <div className="image-compare-unavailable" role="status"><ImageOff size={21} aria-hidden="true" /><strong>{label}</strong><span>{selection.message}</span>{slot && <small>{slot.label}</small>}</div>
  return <SafeImage key={`${slot.key}:${slot.asset.localUrl}`} src={slot.asset.localUrl} alt={`${label} · ${slot.label}`} draggable={false} style={style} fallbackLabel={`${label} 图片无法读取，请核对素材`} onLoad={(event) => slot.onLoad?.(event.currentTarget)} />
}

function compareViewportScope(view: CompareViewState, selections: readonly ResolvedCompareSlot[]): string {
  return JSON.stringify([view.mode, view.sideBySideCount ?? 2, selections.map(({ key, slot }) => [key, slot?.asset?.assetId ?? slot?.asset?.localUrl ?? null, slot?.dimensions.width, slot?.dimensions.height])])
}

function CompareSelector({ label, slots, selected, disabled, onSelect }: { label: string; slots: readonly CompareImageSlot[]; selected: string | null; disabled: boolean; onSelect(key: string | null): void }) {
  const missing = selected !== null && !slots.some((slot) => slot.key === selected)
  return <label className="image-compare-selector"><span>{label}</span><select aria-label={`对比图片 ${label}`} value={selected ?? ''} disabled={disabled} onChange={(event) => onSelect(event.currentTarget.value || null)}>
    <option value="">请选择图片</option>
    {missing && <option value={selected}>原输入已断开</option>}
    {slots.map((slot, index) => <option key={slot.key} value={slot.key}>{index + 1} · {slot.label}{!slot.asset?.localUrl ? ' · 待就绪' : ''}</option>)}
  </select></label>
}

export function ImageComparePreview({ slots, view, scopeKey = '', onChange, onCommit, disabled = false, expanded = false }: ImageComparePreviewProps) {
  const selected = compareViewSelections(view).map((key) => resolveCompareSlot(slots, key))
  const first = selected[0], second = selected[1], position = compareSliderPosition(view.position), opacity = compareSliderPosition(view.opacity ?? 50)
  const drag = useRef<CompareSliderGesture | null>(null)
  const previousPosition = useRef(view.mode === 'opacity' ? opacity : position)
  const canSlide = !disabled && first.status === 'ready' && second.status === 'ready'
  retainCompareGesture(drag, previousPosition, view, scopeKey, canSlide)
  useEffect(() => {
    const current = drag.current
    if (current && (!canSlide || current.scopeKey !== scopeKey || !['slider', 'opacity'].includes(view.mode) || current.before.mode !== view.mode || current.before.a !== view.a || current.before.b !== view.b)) drag.current = null
  }, [scopeKey, canSlide, view.mode, view.a, view.b])
  function changeSelection(target: CompareSelectionTarget, key: string | null) {
    if (disabled || (key !== null && !slots.some((slot) => slot.key === key))) return
    const next = changeCompareSelection(view, target, key)
    if (next !== view) { drag.current = null; onChange(next); onCommit?.(next) }
  }
  function changeParallelCount(count: 2 | 3) {
    if (disabled || view.mode !== 'side-by-side') return
    const next = changeCompareParallelCount(view, count, slots)
    if (next !== view) { drag.current = null; onChange(next); onCommit?.(next) }
  }
  function currentGesture() {
    const current = drag.current
    return current && current.scopeKey === scopeKey && canSlide && ['slider', 'opacity'].includes(view.mode) && current.before.mode === view.mode && current.before.a === view.a && current.before.b === view.b ? current : null
  }
  function beginGesture(kind: 'stage' | 'range', pointerId: number | null) {
    if (!canSlide || !['slider', 'opacity'].includes(view.mode) || drag.current) return false
    drag.current = { kind, pointerId, before: view, next: view, scopeKey, field: view.mode === 'opacity' ? 'opacity' : 'position' }
    return true
  }
  function changePosition(value: number) {
    if (!canSlide || !Number.isFinite(value)) return
    if (!drag.current) beginGesture('range', null)
    const current = currentGesture()
    if (!current) { drag.current = null; return }
    const next = compareSliderPosition(value)
    if (next !== (current.next[current.field] ?? 50)) { current.next = { ...view, [current.field]: next }; onChange(current.next) }
  }
  function finishGesture() {
    const current = currentGesture()
    drag.current = null
    if (current && (current.next[current.field] ?? 50) !== (current.before[current.field] ?? 50)) onCommit?.(current.next)
  }
  function cancelGesture() {
    const current = currentGesture()
    drag.current = null
    if (current && (current.next[current.field] ?? 50) !== (current.before[current.field] ?? 50)) onChange({ ...view, [current.field]: current.before[current.field] ?? 50 })
  }
  function swap() { if (!disabled && view.a !== view.b) { drag.current = null; const next = { ...view, a: view.b, b: view.a }; onChange(next); onCommit?.(next) } }
  function toggleOverlay() {
    if (disabled || view.mode !== 'toggle') return
    drag.current = null
    const next = { ...view, overlayVisible: !(view.overlayVisible ?? true) }
    onChange(next); onCommit?.(next)
  }
  function pointPosition(event: PointerEvent<HTMLElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    if (bounds.width > 0) changePosition((event.clientX - bounds.left) / bounds.width * 100)
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (view.mode !== 'slider' || event.button !== 0 || !beginGesture('stage', event.pointerId)) return
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    pointPosition(event)
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current
    if (!current || current.kind !== 'stage' || current.pointerId !== event.pointerId) return
    if (!currentGesture()) { drag.current = null; return }
    event.preventDefault(); pointPosition(event)
  }
  function pointerEnd(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId !== event.pointerId) return
    if (drag.current.kind === 'stage') pointPosition(event)
    finishGesture()
  }
  function pointerCancel(event: PointerEvent<HTMLElement>) { if (drag.current?.pointerId === event.pointerId) cancelGesture() }
  function rangePointerDown(event: PointerEvent<HTMLInputElement>) {
    if (event.button !== 0 || !beginGesture('range', event.pointerId)) return
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function rangeKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) beginGesture('range', null)
    if (event.key === 'Escape' && drag.current?.kind === 'range') { event.preventDefault(); event.stopPropagation(); cancelGesture() }
  }
  function rangeKeyUp(event: KeyboardEvent<HTMLInputElement>) {
    if (drag.current?.kind === 'range' && drag.current.pointerId === null && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) finishGesture()
  }
  const missing = selected.filter((selection) => selection.status === 'missing').length
  const waiting = selected.filter((selection) => selection.status === 'waiting').length
  const three = view.mode === 'side-by-side' && view.sideBySideCount === 3
  const overlay = ['slider', 'opacity', 'toggle'].includes(view.mode)
  function overlayStage(style?: CSSProperties) {
    return <div className="image-compare-stage image-tool-checker" style={{ '--image-compare-ratio': compareStageAspectRatio(first) } as CSSProperties} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={pointerCancel} onLostPointerCapture={pointerCancel}>
      {view.mode === 'slider' ? <>
        <div className="image-compare-base" style={{ clipPath: `inset(0 0 0 ${position}%)` }}><CompareImage selection={first} label="A" style={style} /></div>
        <div className="image-compare-reveal" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}><CompareImage selection={second} label="B" style={style} /></div>
        <div className="image-compare-divider" aria-hidden="true" style={{ left: `${position}%` }}><ArrowLeftRight size={13} /></div>
        <span className="image-compare-label is-left">B</span><span className="image-compare-label is-right">A</span>
      </> : <>
        <div className="image-compare-base"><CompareImage selection={second} label="B · 底层" style={style} /></div>
        <div className="image-compare-reveal" style={{ opacity: view.mode === 'opacity' ? opacity / 100 : 1, visibility: view.mode === 'toggle' && view.overlayVisible === false ? 'hidden' : 'visible' }}><CompareImage selection={first} label="A · 上层" style={style} /></div>
        <span className="image-compare-label is-left">A 上层 · B 底层</span>
      </>}
    </div>
  }
  function parallelCell(selection: ResolvedCompareSlot, index: number) {
    const label = view.mode === 'grid' ? `格 ${index + 1}` : ['A', 'B', 'C'][index]
    function cell(style?: CSSProperties) { return <div className="image-compare-cell image-tool-checker"><CompareImage selection={selection} label={label} style={style} /></div> }
    return expanded ? <CompareViewport label={label} scopeKey={compareViewportScope(view, [selection])} disabled={disabled || selection.status !== 'ready'}>{(style) => cell(style)}</CompareViewport> : cell()
  }
  return <div className={`image-compare-preview${expanded ? ' is-expanded' : ''}`}>
    {view.mode === 'side-by-side' && <div className="image-compare-parallel-count" role="group" aria-label="并排图片数量">{([2, 3] as const).map((count) => <button key={count} type="button" disabled={disabled} aria-pressed={(view.sideBySideCount ?? 2) === count} onClick={() => changeParallelCount(count)}>{count === 2 ? '二图并排' : '三图并排'}</button>)}</div>}
    {overlay ? <>
      {expanded ? <CompareViewport label="双图" scopeKey={compareViewportScope(view, selected)} disabled={!canSlide} slider={view.mode === 'slider'}>{(style) => overlayStage(style)}</CompareViewport> : overlayStage()}
      {view.mode === 'slider' || view.mode === 'opacity' ? <label className="image-compare-range"><span>{view.mode === 'opacity' ? '上层不透明度' : '对比位置'}</span><input type="range" aria-label={view.mode === 'opacity' ? '叠加透明度' : '对比滑杆'} aria-valuetext={view.mode === 'opacity' ? `A 上层不透明度 ${Math.round(opacity)}%` : `B 显示 ${Math.round(position)}%`} min={0} max={100} step={1} value={view.mode === 'opacity' ? opacity : position} disabled={!canSlide} onChange={(event) => changePosition(event.currentTarget.valueAsNumber)} onPointerDown={rangePointerDown} onPointerUp={pointerEnd} onPointerCancel={pointerCancel} onLostPointerCapture={pointerCancel} onKeyDown={rangeKeyDown} onKeyUp={rangeKeyUp} onBlur={finishGesture} /><output>{Math.round(view.mode === 'opacity' ? opacity : position)}%</output></label> : <button type="button" className="image-compare-toggle" disabled={disabled} aria-pressed={view.overlayVisible ?? true} onClick={toggleOverlay}>{view.overlayVisible === false ? '显示上层 A' : '隐藏上层 A'}</button>}
    </> : <div className={`image-compare-grid${view.mode === 'grid' ? ' is-four' : three ? ' is-three' : ' is-pair'}`}>
      {selected.map((selection, index) => <figure key={index}>{parallelCell(selection, index)}<figcaption>{selection.slot?.label ?? selection.message}</figcaption></figure>)}
      {three && <div className="image-compare-unused-cell" aria-hidden="true" />}
    </div>}
    <div className={`image-compare-selectors${view.mode === 'grid' ? ' is-four' : three ? ' is-three' : ''}`}>
      {view.mode === 'grid' ? selected.map((selection, index) => <CompareSelector key={index} label={`格 ${index + 1}`} slots={slots} selected={selection.key} disabled={disabled} onSelect={(key) => changeSelection(index as 0 | 1 | 2 | 3, key)} />) : <>
        <CompareSelector label="A" slots={slots} selected={view.a} disabled={disabled} onSelect={(key) => changeSelection('a', key)} />
        <CompareSelector label="B" slots={slots} selected={view.b} disabled={disabled} onSelect={(key) => changeSelection('b', key)} />
        {three && <CompareSelector label="C" slots={slots} selected={view.c ?? null} disabled={disabled} onSelect={(key) => changeSelection('c', key)} />}
        <button type="button" className="image-compare-swap" aria-label="交换对比图片 A 和 B" title="交换 A 和 B" disabled={disabled || view.a === view.b} onClick={swap}><ArrowLeftRight size={14} /></button>
      </>}
    </div>
    <div className="image-compare-notices" role="status">
      {slots.length > 4 && <p>共 {slots.length} 个输入，四图模式最多同时显示 4 张，可在每格选择其他图片。</p>}
      {missing > 0 && <p>有 {missing} 个选中输入已断开，原位置已保留，请重新选择。</p>}
      {waiting > 0 && <p>有 {waiting} 个选中输入尚未就绪，保留原位置等待完成。</p>}
      {slots.length < 2 && <p>连接至少 2 张图片进行对比；四图模式最多同时显示 4 张。</p>}
      {three && slots.length < 3 && <p>三图并排已保留 C 位置，连接第三张图片后可选择。</p>}
      {expanded && <p>滚轮按格中心缩放 · 放大后拖动平移{view.mode === 'slider' ? '（手形或按住空格）' : ''} · {overlay ? '双图同步查看' : '每格独立查看'} · 关闭后复位</p>}
      {view.mode !== 'grid' && first.status === 'ready' && second.status === 'ready' && view.a !== null && view.a === view.b && <p>A 与 B 选择了同一输入，可切换图片比较。</p>}
    </div>
  </div>
}
