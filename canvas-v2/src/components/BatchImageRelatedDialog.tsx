import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { batchImageRelatedOptions, type BatchImageRelatedSource, type BatchImageRelatedTarget } from '../editor/batch-image-related'
import { SafeImage } from './MediaPreview'
import './batch-image-related.css'

export function BatchImageRelatedDialog({ sources, error, onConfirm, onClose }: {
  sources: readonly BatchImageRelatedSource[]
  error?: string
  onConfirm(type: BatchImageRelatedTarget): void
  onClose(): void
}) {
  const options = batchImageRelatedOptions(sources.length)
  const [target, setTarget] = useState<BatchImageRelatedTarget>(() => options.find((option) => !option.disabledReason)?.type ?? 'image-layer')
  const root = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    root.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  const content = <div className="batch-image-related-backdrop" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) closeRef.current() }}>
    <section ref={root} className="batch-image-related-dialog" role="dialog" aria-modal="true" aria-label="关联图片工具" onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current() }
      if (event.key !== 'Tab') return
      const controls = [...(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])]
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
    }}>
      <header><div><small>{sources.length} 个图片来源</small><h2>关联图片工具</h2></div><button type="button" aria-label="关闭关联图片工具" onClick={onClose}><X size={18} /></button></header>
      <div className="batch-image-related-body">
        <p>按画布从上到下、同高度从左到右的顺序连接。每个节点只用图片端口的单张输出；宫格只用当前切片，候选画廊不会展开全部候选。</p>
        <ol aria-label="图片输入顺序">{sources.map((source, index) => <li key={source.id}><div className="batch-image-related-source">{source.previewAssetId && <SafeImage src={`xingmang-asset://image/${source.previewAssetId}`} alt={`输入 ${index + 1} · ${source.title}`} />}<span><strong>{source.title}</strong><small>{source.outputLabel}{source.disabled ? ' · 已跳过运行，需先启用此来源' : ''}</small><small>画布位置 {Math.round(source.position.x)}, {Math.round(source.position.y)}</small></span></div></li>)}</ol>
        <fieldset><legend>选择关联工具</legend>{options.map((option) => <label key={option.type} className={option.disabledReason ? 'is-disabled' : ''}>
          <input type="radio" name="batch-image-related-target" value={option.type} checked={target === option.type} disabled={Boolean(option.disabledReason)} onChange={() => setTarget(option.type)} />
          <span><strong>{option.title}</strong><small>{option.disabledReason ?? option.description}</small></span>
        </label>)}</fieldset>
        <p>创建后可继续调整，也可一次撤销；不会自动运行。</p>
        {error && <p role="alert" className="batch-image-related-error">{error}</p>}
      </div>
      <footer><button type="button" onClick={onClose}>取消</button><button type="button" className="is-primary" disabled={Boolean(options.find((option) => option.type === target)?.disabledReason)} onClick={() => onConfirm(target)}>创建并连接 {sources.length} 张图片</button></footer>
    </section>
  </div>
  return typeof document === 'undefined' ? content : createPortal(content, document.body)
}
