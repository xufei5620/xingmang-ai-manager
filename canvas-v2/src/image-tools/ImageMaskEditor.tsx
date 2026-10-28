import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Brush, Download, Eraser, ImagePlus, LoaderCircle, Redo2, Trash2, Undo2, X } from 'lucide-react'
import { SafeImage } from '../components/MediaPreview'
import type { AssetRef } from '../model'
import { parseImageEditMask, rasterizeImageEditMask, readImageEditMaskPixel, type ImageEditMask, type ImageEditMaskRaster } from './image-edit-mask'
import { commitImageMask, createImageMaskHistory, imageMaskBindingMatches, imageMaskPoint, imageMaskPointNeeded, rebindImageMask, redoImageMask, undoImageMask } from './image-mask-editor-state'
import { encodeImageMaskPng, type ImageMaskPng } from './image-mask-png'
import type { MaskAssetSaveMode } from './mask-asset-export'
import './image-mask-editor.css'

type Stroke = ImageEditMask['strokes'][number]
interface MaskGesture { pointerId: number; stroke: Stroke }
interface MaskSource { assetId: string; width: number; height: number; key: string }
interface MaskExport { kind: 'download' | 'asset'; controller: AbortController; source: MaskSource; original: ImageEditMask; mask: ImageEditMask; key: string; mode: MaskAssetSaveMode; explicitMode: boolean }

function assetModeAllowed(mode: MaskAssetSaveMode, linked?: boolean, replace?: boolean): boolean { return mode === 'new' || mode === 'linked' && linked === true || mode === 'replace' && replace === true }

function assetModeLabel(mode: MaskAssetSaveMode): string { return mode === 'linked' ? '另存为关联图片节点' : mode === 'replace' ? '保存至当前节点' : '另存为蒙版图片节点' }

function drawMaskCanvas(canvas: HTMLCanvasElement, raster: ImageEditMaskRaster, blackWhite: boolean, fullSize = false): void {
  const mask = raster
  const scale = fullSize ? 1 : Math.min(1, 1024 / Math.max(mask.width, mask.height))
  canvas.width = Math.max(1, Math.round(mask.width * scale)); canvas.height = Math.max(1, Math.round(mask.height * scale))
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器无法显示蒙版，请重试')
  const pixels = context.createImageData(canvas.width, canvas.height)
  for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
    const edited = readImageEditMaskPixel(raster, Math.min(mask.width - 1, Math.floor((x + 0.5) / scale)), Math.min(mask.height - 1, Math.floor((y + 0.5) / scale)))
    const offset = (y * canvas.width + x) * 4
    pixels.data[offset] = blackWhite ? edited ? 255 : 0 : 255
    pixels.data[offset + 1] = blackWhite ? edited ? 255 : 0 : 86
    pixels.data[offset + 2] = blackWhite ? edited ? 255 : 0 : 104
    pixels.data[offset + 3] = blackWhite ? 255 : edited ? 120 : 0
  }
  context.putImageData(pixels, 0, 0)
}

export function ImageMaskEditor({ asset, initial, saveLabel = '保存蒙版', onApply, onSaveAsset, allowDownload = true, allowLinkedAsset, allowReplaceAsset, onClose }: { asset: AssetRef; initial?: ImageEditMask; saveLabel?: string; onApply(mask: ImageEditMask): void; onSaveAsset?(mask: ImageEditMask, png: ImageMaskPng, signal: AbortSignal, mode?: MaskAssetSaveMode): Promise<void>; /** False when the host blocks page downloads. */ allowDownload?: boolean; allowLinkedAsset?: boolean; allowReplaceAsset?: boolean; onClose(): void }) {
  const [history, setHistory] = useState(() => createImageMaskHistory(initial ?? { version: 1, sourceAssetId: asset.assetId, width: 1, height: 1, strokes: [] }))
  const historyRef = useRef(history); historyRef.current = history
  const [source, setSource] = useState<MaskSource | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [tool, setTool] = useState<'brush' | 'erase'>('brush')
  const [size, setSize] = useState(32)
  const [blackWhite, setBlackWhite] = useState(false)
  const [draft, setDraft] = useState<Stroke | null>(null)
  const [error, setError] = useState('')
  const [exporting, setExporting] = useState<'download' | 'asset' | null>(null)
  const [assetSaveMode, setAssetSaveMode] = useState<MaskAssetSaveMode>(() => allowLinkedAsset ? 'linked' : 'new')
  const exportRequest = useRef<MaskExport | null>(null), closed = useRef(false)
  const assetKey = `${asset.assetId ?? ''}\u0000${asset.localUrl ?? ''}`
  const sourceScope = useRef(assetKey)
  const explicitMode = allowLinkedAsset !== undefined || allowReplaceAsset !== undefined
  const latest = useRef({ assetKey, source, sourceError, onSaveAsset, assetSaveMode, allowLinkedAsset, allowReplaceAsset, explicitMode }); latest.current = { assetKey, source, sourceError, onSaveAsset, assetSaveMode, allowLinkedAsset, allowReplaceAsset, explicitMode }
  const gesture = useRef<MaskGesture | null>(null), frame = useRef<number | null>(null)
  const panel = useRef<HTMLElement>(null), canvas = useRef<HTMLCanvasElement>(null), alive = useRef(true)
  const maskId = useId().replace(/:/g, '')
  const mask = history.present
  const matches = source !== null && source.key === assetKey && !sourceError && imageMaskBindingMatches(mask, source)
  const busy = exporting !== null
  const validSaveMode = assetModeAllowed(assetSaveMode, allowLinkedAsset, allowReplaceAsset)
  const showSaveModes = !!onSaveAsset && (explicitMode || assetSaveMode !== 'new')
  const shortEdge = Math.min(source?.width ?? mask.width, source?.height ?? mask.height)
  const pointsUsed = mask.strokes.reduce((sum, stroke) => sum + stroke.points.length, 0)
  const preview = useMemo(() => {
    try { return { raster: rasterizeImageEditMask(mask), error: '' } }
    catch (cause) { return { raster: null, error: cause instanceof Error ? cause.message : '蒙版过于复杂，请撤销部分笔迹' } }
  }, [mask])
  const editedPixels = preview.raster?.editedPixels ?? 0
  const width = source?.width ?? mask.width, height = source?.height ?? mask.height
  const strokes = draft ? [...mask.strokes, draft] : mask.strokes

  function cancelGesture() {
    gesture.current = null
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = null; setDraft(null)
  }
  function change(next: ReturnType<typeof createImageMaskHistory>) { if (exportRequest.current || closed.current || !alive.current) return; cancelGesture(); historyRef.current = next; setHistory(next); setError('') }
  function chooseTool(next: 'brush' | 'erase') { if (exportRequest.current || closed.current) return; cancelGesture(); setTool(next) }
  function chooseAssetSaveMode(value: string) {
    if (exportRequest.current || closed.current || !alive.current || value !== 'new' && value !== 'linked' && value !== 'replace') return
    const current = latest.current
    if (!assetModeAllowed(value, current.allowLinkedAsset, current.allowReplaceAsset)) return
    latest.current = { ...current, assetSaveMode: value }; setAssetSaveMode(value); setError('')
  }
  function abortExport() { const request = exportRequest.current; exportRequest.current = null; request?.controller.abort(); if (alive.current && !closed.current) setExporting(null) }
  function close() { if (closed.current) return; closed.current = true; abortExport(); cancelGesture(); onClose() }
  function currentExport(request: MaskExport): boolean {
    const current = latest.current
    return alive.current && !closed.current && exportRequest.current === request && !request.controller.signal.aborted && current.assetKey === request.key && !current.sourceError && current.source === request.source && historyRef.current.present === request.original
      && (request.kind !== 'asset' || !!current.onSaveAsset && assetModeAllowed(request.mode, current.allowLinkedAsset, current.allowReplaceAsset))
  }
  function capturedMask(): { mask: ImageEditMask; source: MaskSource; original: ImageEditMask; key: string } {
    const current = latest.current, original = historyRef.current.present, parsed = parseImageEditMask(original)
    if (!current.source || current.sourceError || current.source.key !== current.assetKey || !imageMaskBindingMatches(parsed, current.source)) throw new Error('原图尚未就绪或已经变化，请先核对原图和蒙版')
    return { mask: parsed, source: current.source, original, key: current.assetKey }
  }
  function applyMask() {
    if (exportRequest.current || closed.current || gesture.current) return
    try { const captured = capturedMask(); if (!rasterizeImageEditMask(captured.mask).editedPixels) throw new Error('请先涂抹希望修改的区域，空蒙版不能保存'); onApply(captured.mask); close() }
    catch (cause) { if (alive.current && !closed.current) setError(cause instanceof Error ? cause.message : '蒙版未保存') }
  }
  function undo(redo = false) { change(redo ? redoImageMask(historyRef.current) : undoImageMask(historyRef.current)) }

  useEffect(() => {
    alive.current = true; closed.current = false
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { alive.current = false; closed.current = true; abortExport(); gesture.current = null; if (frame.current !== null) cancelAnimationFrame(frame.current); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => {
    if (sourceScope.current === assetKey) return
    sourceScope.current = assetKey; abortExport(); setError('')
    // A cached image may load before passive effects; keep that newly verified
    // source rather than erasing it while finishing the previous asset scope.
    if (latest.current.source?.key !== assetKey) { latest.current = { ...latest.current, source: null, sourceError: '' }; setSource(null); setSourceError('') }
  }, [assetKey])
  useEffect(() => {
    const request = exportRequest.current
    if (request?.kind === 'asset' && (!onSaveAsset || !assetModeAllowed(request.mode, allowLinkedAsset, allowReplaceAsset))) {
      abortExport()
      if (alive.current && !closed.current) setError('当前保存方式已不可用，请重新选择；已上传素材仍可在素材库核对')
    }
  }, [allowLinkedAsset, allowReplaceAsset, !!onSaveAsset])
  useEffect(() => { try { if (canvas.current && preview.raster) drawMaskCanvas(canvas.current, preview.raster, blackWhite) } catch (cause) { setError(cause instanceof Error ? cause.message : '蒙版预览失败') } }, [preview, blackWhite])

  function point(event: PointerEvent<SVGSVGElement>) { return imageMaskPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect()) }
  function start(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || gesture.current || !matches || exportRequest.current || closed.current) return
    event.preventDefault(); event.stopPropagation()
    if (mask.strokes.length >= 128 || pointsUsed >= 4096) { setError('蒙版最多保存 128 笔、4096 个路径点，请撤销或清空后再绘制'); return }
    const first = point(event)
    if (!first) return
    const stroke: Stroke = { tool, size: Math.min(1, size / shortEdge), points: [first] }
    gesture.current = { pointerId: event.pointerId, stroke }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDraft(stroke); setError('')
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointerId) return
    event.preventDefault()
    const next = point(event)
    if (!next || !imageMaskPointNeeded(current.stroke.points.at(-1)!, next, mask, current.stroke.size)) return
    if (pointsUsed + current.stroke.points.length >= 4096) { setError('已达到路径点上限，本笔已停止延长；可撤销或清空后继续'); return }
    current.stroke = { ...current.stroke, points: [...current.stroke.points, next] }
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; if (gesture.current === current) setDraft(current.stroke) })
  }
  function finish(event: PointerEvent<SVGSVGElement>, cancel = false) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    event.preventDefault()
    if (!cancel) move(event)
    const completed = current.stroke
    cancelGesture()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (!cancel) {
      try { const next = commitImageMask(historyRef.current, { ...historyRef.current.present, strokes: [...historyRef.current.present.strokes, completed] }); historyRef.current = next; setHistory(next) }
      catch (cause) { setError(cause instanceof Error ? cause.message : '本笔未保存，请减少路径点') }
    }
  }
  async function exportMask(kind: 'download' | 'asset') {
    if (exportRequest.current || closed.current || !alive.current || gesture.current) return
    let request: MaskExport | null = null
    try {
      const captured = capturedMask(), current = latest.current, save = current.onSaveAsset
      if (kind === 'asset' && !save) throw new Error('当前环境尚未接通蒙版图片保存，可先下载 PNG')
      if (kind === 'asset' && !assetModeAllowed(current.assetSaveMode, current.allowLinkedAsset, current.allowReplaceAsset)) throw new Error('当前保存方式已不可用，请重新选择后保存')
      request = { ...captured, kind, controller: new AbortController(), mode: current.assetSaveMode, explicitMode: current.explicitMode }
      exportRequest.current = request; setExporting(kind); setError('')
      const png = await encodeImageMaskPng(captured.mask, { signal: request.controller.signal })
      if (!currentExport(request)) return
      if (kind === 'asset') {
        if (request.explicitMode) await save!(captured.mask, png, request.controller.signal, request.mode)
        else await save!(captured.mask, png, request.controller.signal)
        if (!currentExport(request)) return
        exportRequest.current = null; setExporting(null); close()
      } else {
        const url = URL.createObjectURL(png.blob), link = document.createElement('a')
        try { link.href = url; link.download = `蒙版-${png.width}x${png.height}.png`; link.click() } finally { setTimeout(() => URL.revokeObjectURL(url), 1000) }
      }
    } catch (cause) {
      if (request ? currentExport(request) : alive.current && !closed.current) setError(cause instanceof Error ? cause.message : '蒙版图片未能导出，笔迹已保留')
    } finally {
      if (request && exportRequest.current === request) { exportRequest.current = null; if (alive.current && !closed.current) setExporting(null) }
    }
  }

  return createPortal(<div className="image-mask-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <section className="image-mask-dialog" ref={panel} role="dialog" aria-modal="true" aria-label="蒙版局部修改" aria-busy={busy} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); if (gesture.current) cancelGesture(); else close() }
      if (!busy && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey) }
      if (!busy && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); undo(true) }
      if (!busy && !event.metaKey && !event.ctrlKey && !event.altKey && !(event.target instanceof HTMLElement && event.target.closest('input,textarea,select,[contenteditable=true]'))) {
        if (event.key.toLowerCase() === 'b' || event.key.toLowerCase() === 'e') { event.preventDefault(); chooseTool(event.key.toLowerCase() === 'b' ? 'brush' : 'erase') }
      }
      if (event.key === 'Tab') {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length)
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
      }
    }}>
      <header><div><small>图像编辑</small><h2>蒙版局部修改</h2></div><button type="button" aria-label="关闭蒙版编辑器" onClick={close}><X size={20} /></button></header>
      <p className="image-mask-explanation">白色表示希望修改的区域，黑色表示保留。另存图片只保存黑白蒙版，不调用模型；AI 局部修改需之后单独确认运行，模型可能同时调整其他区域。</p>
      <div className="image-mask-toolbar" role="toolbar" aria-label="蒙版工具">
        <button type="button" disabled={busy} aria-pressed={tool === 'brush'} onClick={() => chooseTool('brush')}><Brush size={16} />画笔</button>
        <button type="button" disabled={busy} aria-pressed={tool === 'erase'} onClick={() => chooseTool('erase')}><Eraser size={16} />橡皮</button>
        <label>大小<input type="range" aria-label="蒙版笔刷大小" disabled={busy} min="1" max={Math.max(1, Math.min(512, shortEdge))} value={Math.min(size, shortEdge)} onChange={(event) => { if (!exportRequest.current) { cancelGesture(); setSize(Number(event.target.value)) } }} /><span>{Math.min(size, shortEdge)} px</span></label>
        <button type="button" aria-label="撤销蒙版" disabled={busy || !history.past.length} onClick={() => undo()}><Undo2 size={16} /></button>
        <button type="button" aria-label="重做蒙版" disabled={busy || !history.future.length} onClick={() => undo(true)}><Redo2 size={16} /></button>
        <button type="button" disabled={busy || !mask.strokes.length} onClick={() => change(commitImageMask(historyRef.current, { ...mask, strokes: [] }))}><Trash2 size={16} />清空</button>
        <button type="button" disabled={busy} aria-pressed={blackWhite} onClick={() => { if (!exportRequest.current) setBlackWhite(!blackWhite) }}>黑白预览</button>
      </div>
      {!source && !sourceError && <p className="image-mask-notice" role="status">正在读取原图尺寸，完成后可绘制。</p>}
      {source && !matches && <div className="image-mask-notice" role="status"><span>{mask.sourceAssetId ? '原图或尺寸已变化' : '此蒙版尚未绑定原图'}。原配方 {mask.width} × {mask.height}，当前图片 {source.width} × {source.height}；确认后会按相对位置适配。</span><button type="button" disabled={busy} onClick={() => change(commitImageMask(historyRef.current, rebindImageMask(mask, source)))}>确认适配当前原图</button></div>}
      <div className="image-mask-stage"><div className="image-mask-surface" style={{ '--mask-ratio': width / height, aspectRatio: width / height } as CSSProperties}>
        <SafeImage src={asset.localUrl ?? ''} alt="局部修改原图" draggable={false} onLoad={(event) => {
          if (!alive.current || closed.current || latest.current.assetKey !== assetKey) return
          try {
            if (!asset.assetId) throw new Error('原图标识缺失，请重新选择图片')
            const dimensions = { assetId: asset.assetId, width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight, key: assetKey }
            parseImageEditMask({ version: 1, width: dimensions.width, height: dimensions.height, sourceAssetId: dimensions.assetId, strokes: [] })
            if (source && (source.key !== assetKey || source.width !== dimensions.width || source.height !== dimensions.height)) abortExport()
            const loaded = source && source.key === dimensions.key && source.width === dimensions.width && source.height === dimensions.height ? source : dimensions
            latest.current = { ...latest.current, source: loaded, sourceError: '' }; setSource(loaded); setSourceError('')
            if (!initial && historyRef.current.present.width === 1 && historyRef.current.present.height === 1 && !historyRef.current.present.strokes.length) { const next = createImageMaskHistory(rebindImageMask(historyRef.current.present, dimensions)); historyRef.current = next; setHistory(next) }
          } catch (cause) { abortExport(); const message = cause instanceof Error ? cause.message : '原图尺寸超出范围'; latest.current = { ...latest.current, source: null, sourceError: message }; setSource(null); setSourceError(message); setError(message) }
        }} onError={() => { if (!alive.current || closed.current || latest.current.assetKey !== assetKey) return; abortExport(); const message = '原图无法读取，请恢复或重新选择素材'; latest.current = { ...latest.current, source: null, sourceError: message }; setSource(null); setSourceError(message); setError(message) }} />
        <canvas ref={canvas} className="image-mask-overlay" style={{ visibility: draft ? 'hidden' : 'visible' }} />
        <svg className="image-mask-drawing" viewBox={`0 0 ${width} ${height}`} aria-label="蒙版绘制区" style={{ cursor: matches && !busy ? 'crosshair' : 'not-allowed' }} onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => { if (gesture.current?.pointerId === event.pointerId) cancelGesture() }}>
          {draft && <><defs><mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}><rect width={width} height={height} fill="black" />{strokes.map((stroke, index) => <g key={index} fill={stroke.tool === 'brush' ? 'white' : 'black'} stroke={stroke.tool === 'brush' ? 'white' : 'black'}>{stroke.points.length === 1 ? <circle cx={stroke.points[0].x * width} cy={stroke.points[0].y * height} r={stroke.size * Math.min(width, height) / 2} stroke="none" /> : <polyline points={stroke.points.map((point) => `${point.x * width},${point.y * height}`).join(' ')} fill="none" strokeWidth={stroke.size * Math.min(width, height)} strokeLinecap="round" strokeLinejoin="round" />}</g>)}</mask></defs>{blackWhite && <rect width={width} height={height} fill="black" />}<rect width={width} height={height} fill={blackWhite ? 'white' : '#ff5668'} opacity={blackWhite ? 1 : 0.47} mask={`url(#${maskId})`} /></>}
        </svg>
      </div></div>
      {(error || preview.error) && <p className="image-mask-error" role="alert">{error || preview.error}</p>}
      {showSaveModes && <div className="image-mask-save-choice"><label htmlFor={`${maskId}-save-mode`}>图片保存方式<select id={`${maskId}-save-mode`} aria-label="图片保存方式" aria-describedby={`${maskId}-save-note`} value={assetSaveMode} disabled={busy} onChange={(event) => chooseAssetSaveMode(event.target.value)}>
        {!validSaveMode && <option value={assetSaveMode} disabled>原保存方式已不可用，请重新选择</option>}
        {allowLinkedAsset && <option value="linked">另存为关联图片节点</option>}
        <option value="new">另存为独立图片节点</option>
        {allowReplaceAsset && <option value="replace">保存至当前节点</option>}
      </select></label><p id={`${maskId}-save-note`} role={!validSaveMode ? 'status' : undefined}>{!validSaveMode ? '原保存方式已不可用，笔迹已保留；请重新选择保存方式。' : assetSaveMode === 'linked' ? '保存黑白蒙版并保留原图输入，创建关联图片节点；之后填写修改指令并明确运行，才会调用模型。' : assetSaveMode === 'replace' ? '将黑白蒙版扁平化保存至当前节点，替换当前候选；旧笔迹不会继续编辑，可在画布撤销。' : '只保存独立黑白蒙版素材与图片节点，可连接裁剪、拼图等零 AI 下游直接复用。'}</p></div>}
      {busy && <p className="image-mask-progress" role="status" aria-live="polite"><LoaderCircle size={15} aria-hidden="true" />{exporting === 'asset' ? '正在保存蒙版，关闭会停止等待；已上传素材仍可在素材库核对。' : '正在导出原尺寸黑白蒙版，关闭可取消。'}</p>}
      <footer><div className="image-mask-footer-note"><span>{mask.strokes.length} / 128 笔 · {blackWhite ? '白色' : '红色'}区域待重绘</span><small>PNG 与原图同尺寸 · 不透明黑白图 · 保存图片不提交 AI 请求</small></div><div className="image-mask-footer-actions">{allowDownload && <button type="button" disabled={!matches || !editedPixels || busy || !!draft} onClick={() => void exportMask('download')}><Download size={15} />{exporting === 'download' ? '导出中…' : '下载黑白蒙版'}</button>}{onSaveAsset && <button type="button" className="is-primary" disabled={!matches || !editedPixels || busy || !!draft || !validSaveMode} onClick={() => void exportMask('asset')}><ImagePlus size={15} />{exporting === 'asset' ? assetSaveMode === 'replace' ? '正在保存…' : '正在另存…' : assetModeLabel(assetSaveMode)}</button>}<button type="button" onClick={close}>取消</button><button type="button" disabled={!matches || !editedPixels || !!draft || busy} onClick={applyMask}>{saveLabel}</button></div></footer>
    </section>
  </div>, document.body)
}
