import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeftRight, Minus, Plus, RotateCcw, X } from 'lucide-react'
import type { BrowserEditorLayerMergeReview } from '../library/browser-layer-merge-review'

export interface LayerMergeConfirmationProps {
  names: readonly string[]
  groupNames?: readonly string[]
  placement?: 'upper' | 'lower'
  destination?: string
  review?: BrowserEditorLayerMergeReview
  reviewError?: string
  accepted?: boolean
  busy: boolean
  uploading?: boolean
  onPlacementChange?(value: 'upper' | 'lower'): void
  onAcceptedChange?(value: boolean): void
  onRetry?(): void
  onConfirm(): void
  onCancel(): void
}

export function canConfirmLayerMergeReview(review: BrowserEditorLayerMergeReview | undefined, accepted: boolean, busy: boolean, imagesReady = true): boolean {
  return Boolean(review && !busy && imagesReady && (!review.comparison.changedPixels || accepted))
}

export function LayerMergeConfirmation({ names, groupNames = [], placement = 'upper', destination, review, reviewError = '', accepted = false, busy, uploading = false, onPlacementChange, onAcceptedChange, onRetry, onConfirm, onCancel }: LayerMergeConfirmationProps) {
  const panel = useRef<HTMLElement>(null), cancel = useRef<HTMLButtonElement>(null), activeReview = useRef(review)
  activeReview.current = review
  const [view, setView] = useState<'before' | 'after' | 'difference'>('after'), [viewport, setViewport] = useState({ scale: 1, x: 0, y: 0 })
  const drag = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
  const [resources, setResources] = useState<{ review: BrowserEditorLayerMergeReview; urls: Record<'before' | 'after' | 'difference', string> } | null>(null)
  const [decoded, setDecoded] = useState<ReadonlySet<string>>(() => new Set()), [imageError, setImageError] = useState('')
  useEffect(() => { cancel.current?.focus() }, [])
  useEffect(() => {
    setDecoded(new Set()); setImageError(''); setViewport({ scale: 1, x: 0, y: 0 }); drag.current = null
    if (!review) { setResources(null); return }
    const urls = { before: URL.createObjectURL(review.before), after: URL.createObjectURL(review.after), difference: URL.createObjectURL(review.difference) }
    setResources({ review, urls })
    return () => { Object.values(urls).forEach((url) => URL.revokeObjectURL(url)) }
  }, [review])
  const urls = resources && resources.review === review ? resources.urls : null, imagesReady = !!urls && decoded.size === 3 && !imageError
  const comparison = review?.comparison, changed = (comparison?.changedPixels ?? 0) > 0
  const confirmable = canConfirmLayerMergeReview(review, accepted, busy, imagesReady)
  function zoom(delta: number) { setViewport((value) => { const scale = Math.min(4, Math.max(1, value.scale + delta)); return scale === 1 ? { scale, x: 0, y: 0 } : { ...value, scale } }) }
  const content = <div className="layer-merge-review-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <section ref={panel} className="layer-editor-merge-confirm" role="dialog" aria-modal="true" aria-label="合并所选图层确认" aria-busy={busy} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); onCancel() }
      if (event.key === 'Tab') {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? []).filter((element) => !element.closest('[hidden],[inert]') && element.getClientRects().length)
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
      }
    }}>
      <header><div><ArrowLeftRight size={17} /><span><strong>合并所选图层</strong><small>先核对画面，再保存位图 · {names.length} 个所选图层</small></span></div><button type="button" aria-label="关闭合并预览并保留原图层" onClick={onCancel}><X size={17} /></button></header>
      <div className="layer-merge-review-placement"><label>合并图层位置<select aria-label="合并图层位置" value={placement} disabled={uploading} onChange={(event) => onPlacementChange?.(event.target.value as 'upper' | 'lower')}><option value="upper">所选图层最上方</option><option value="lower">所选图层最下方</option></select></label><span>{destination || '原层级中的合并位置'} · 切换位置将重新生成预览</span></div>
      <div className="layer-merge-review-layout">
        <section className="layer-merge-review-preview" aria-label="合并整图前后与差异预览">
          <div className="layer-merge-review-tools"><div role="group" aria-label="合并对照视图">{([['before', '合并前'], ['after', '合并后'], ['difference', '差异']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setView(key)}>{label}</button>)}</div><div><button type="button" aria-label="缩小合并预览" disabled={viewport.scale <= 1} onClick={() => zoom(-.5)}><Minus size={13} /></button><output aria-label="合并预览缩放">{Math.round(viewport.scale * 100)}%</output><button type="button" aria-label="放大合并预览" disabled={viewport.scale >= 4} onClick={() => zoom(.5)}><Plus size={13} /></button><button type="button" aria-label="适应合并预览" onClick={() => setViewport({ scale: 1, x: 0, y: 0 })}><RotateCcw size={13} /></button></div></div>
          <div className={`layer-merge-review-viewport${viewport.scale > 1 ? ' is-zoomed' : ''}`} onPointerDown={(event) => { if (event.button !== 0 || event.isPrimary === false || viewport.scale <= 1) return; event.preventDefault(); drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: viewport.x, top: viewport.y }; event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={(event) => { const start = drag.current; if (start?.pointerId === event.pointerId) { event.preventDefault(); setViewport((value) => ({ ...value, x: start.left + event.clientX - start.x, y: start.top + event.clientY - start.y })) } }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}>
            {urls && (['before', 'after', 'difference'] as const).map((key) => <img key={urls[key]} src={urls[key]} alt={key === 'before' ? '合并前完整文档' : key === 'after' ? '合并后完整文档' : '合并前后像素差异，彩色标记变化区域'} hidden={view !== key} draggable={false} style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }} onLoad={() => { if (activeReview.current === review) setDecoded((previous) => new Set([...previous, key])) }} onError={() => { if (activeReview.current === review) setImageError('预览图片未能显示，请重新生成预览，原图层保留') }} />)}
            {(!review || !imagesReady) && <div className="layer-merge-review-placeholder" role={reviewError || imageError ? 'alert' : 'status'}>{reviewError || imageError || (review ? '正在显示对照图片…' : '正在按原分辨率渲染并核对像素…')}{(reviewError || imageError) && <button type="button" onClick={onRetry}>重新生成预览</button>}</div>}
          </div>
          <p>前后视图共用缩放与位置；放大后可拖动查看。预览长边最多 1024 px，统计覆盖原始文档范围（含裁剪外保留像素）。</p>
        </section>
        <aside className="layer-merge-review-details">
          {comparison && <section className="layer-merge-review-metrics" aria-label="完整文档像素差异统计"><strong>{changed ? '画面存在变化' : '未检测到可见像素变化'}</strong><dl><div><dt>原始文档范围</dt><dd>{comparison.width} × {comparison.height} px</dd></div>{comparison.outputWindow && <div><dt>当前输出窗口</dt><dd>{comparison.outputWindow.width} × {comparison.outputWindow.height} px<br />@ {comparison.outputWindow.x}, {comparison.outputWindow.y}</dd></div>}<div><dt>变化像素</dt><dd>{comparison.changedPixels.toLocaleString()} / {comparison.totalPixels.toLocaleString()}</dd></div><div><dt>最大通道差</dt><dd>{comparison.maxChannelDelta} / 255</dd></div><div><dt>平均通道差</dt><dd>{comparison.meanChannelDelta.toFixed(3)} / 255</dd></div></dl><small>按透明度计算可见 RGBA 差异；完全透明区域的 RGB 不计入。栅格量化也可能产生差异，请以实际对照为准。</small></section>}
          <p>所选内容将栅格化为一张透明 PNG，保留完整原始画布范围和位置。合并后无法分别编辑，可一次撤销还原。</p>
          {review && <small>所选 PNG：{review.output.width} × {review.output.height} px{comparison?.outputWindow ? '，含文档裁剪外保留范围' : ''}</small>}
          {groupNames.length > 0 && <p><strong>将移除编组：{groupNames.join('、')}。</strong>组结构与可编辑成员可一次撤销恢复。</p>}
          <details><summary>所选 {names.length} 个图层</summary><ul>{names.map((name, index) => <li key={index}>{name}</li>)}</ul></details>
          <p>未选图层的内容和自身设置保留，但遮挡顺序与依赖底图的混合可能改变整图。图片只在最终确认后保存到本人素材库。</p>
          {changed && <label className="layer-merge-review-consent"><input type="checkbox" checked={accepted} disabled={busy || !imagesReady} onChange={(event) => onAcceptedChange?.(event.target.checked)} />我已核对前后与差异，接受这次合并造成的画面变化</label>}
        </aside>
      </div>
      <footer><span>{uploading ? '正在保存已核对的同一张 PNG…' : busy ? '正在生成预览，尚未保存图片' : changed && !accepted ? '接受画面变化后才能确认合并' : '取消不修改原图层；合并后可一次撤销'}</span><button ref={cancel} type="button" onClick={onCancel}>{uploading ? '取消合并' : '保留原图层'}</button><button type="button" className="is-primary" disabled={!confirmable} onClick={() => { if (confirmable) onConfirm() }}>{uploading ? '正在保存…' : '确认栅格化并合并'}</button></footer>
    </section>
  </div>
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
