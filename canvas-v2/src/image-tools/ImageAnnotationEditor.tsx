import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowUpRight, Brush, Circle, Download, Eraser, Minus, MousePointer2, Redo2, Square, Tag, Trash2, Type, Undo2, X } from 'lucide-react'
import type { CanvasImageAssetSummary } from '../host'
import { SafeImage } from '../components/MediaPreview'
import type { ImageLayerRecipe } from './recipe'
import { annotationBounds, annotationBrushPasses, annotationColor, annotationPoint, annotationShapePath, annotationSvgPath, buildAnnotationRecipe, commitAnnotation, createAnnotationHistory, createAnnotationMark, createAnnotationText, defaultAnnotationStyle, eraseAnnotations, hitAnnotation, measureAnnotationText, moveAnnotation, redoAnnotation, replaceAnnotationObject, undoAnnotation, type AnnotationBrush, type AnnotationDocument, type AnnotationHistory, type AnnotationObject, type AnnotationPoint, type AnnotationStyle, type AnnotationTool } from './annotation-state'
import './image-annotation-editor.css'

export interface ImageAnnotationEditorProps {
  asset: CanvasImageAssetSummary
  onSave(recipe: ImageLayerRecipe, mode: 'replace' | 'new', signal: AbortSignal): Promise<void>
  /** Left out when the host blocks page downloads: the PNG button is not offered. */
  onDownload?(recipe: ImageLayerRecipe, signal: AbortSignal): Promise<void>
  onClose(): void
}
interface Gesture { pointerId: number; tool: AnnotationTool; points: AnnotationPoint[]; object?: AnnotationObject; style: AnnotationStyle }
interface TextDraft { id: string; point: AnnotationPoint; text: string; style: AnnotationStyle; kind: 'text' | 'label' }
const tools = [
  { id: 'select', label: '选择', key: 'V', icon: MousePointer2 }, { id: 'brush', label: '画笔', key: 'B', icon: Brush }, { id: 'eraser', label: '橡皮', key: 'E', icon: Eraser },
  { id: 'line', label: '直线', key: '', icon: Minus }, { id: 'rectangle', label: '矩形', key: '', icon: Square }, { id: 'ellipse', label: '椭圆', key: '', icon: Circle },
  { id: 'arrow', label: '箭头', key: '', icon: ArrowUpRight }, { id: 'label', label: '标签', key: '', icon: Tag }, { id: 'text', label: '文字', key: 'T', icon: Type },
] as const
const presets: Array<{ id: AnnotationBrush; label: string }> = [{ id: 'round', label: '圆头' }, { id: 'marker', label: '马克笔' }, { id: 'soft', label: '柔光' }, { id: 'neon', label: '霓虹灯带' }, { id: 'light', label: '彩色灯带' }]

function pointPath(points: AnnotationPoint[]): string { return points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ') }
function Stroke({ points, size, color, opacity = 1, hardness = 1 }: { points: AnnotationPoint[]; size: number; color: string; opacity?: number; hardness?: number }) {
  const id = `annotation-soft-${useId().replace(/:/g, '')}`, core = size * Math.max(.05, hardness)
  const left = Math.min(...points.map((point) => point.x)) - size * 2, top = Math.min(...points.map((point) => point.y)) - size * 2
  const width = Math.max(...points.map((point) => point.x)) - left + size * 2, height = Math.max(...points.map((point) => point.y)) - top + size * 2
  return <g opacity={opacity}>
    {hardness < 1 && <defs><filter id={id} filterUnits="userSpaceOnUse" x={left} y={top} width={width} height={height} colorInterpolationFilters="sRGB"><feGaussianBlur stdDeviation={size * (1 - Math.max(.05, hardness)) / 6} /></filter></defs>}
    {points.length === 1 ? <circle cx={points[0].x} cy={points[0].y} r={core / 2} fill={color} filter={hardness < 1 ? `url(#${id})` : undefined} /> : <path d={pointPath(points)} fill="none" stroke={color} strokeWidth={core} strokeLinecap="round" strokeLinejoin="round" filter={hardness < 1 ? `url(#${id})` : undefined} />}
  </g>
}
function AnnotationVisual({ object, document, prefix }: { object: AnnotationObject; document: AnnotationDocument; prefix: string }) {
  const maskId = `${prefix}-${object.id}`
  const path = !('points' in object) && object.kind !== 'text' ? annotationShapePath(object, document) : null
  return <g data-annotation-id={object.id}>
    {!!object.erasures.length && <defs><mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={document.width} height={document.height}><rect width={document.width} height={document.height} fill="white" />{object.erasures.map((erase, index) => <Stroke key={index} points={erase.points} size={erase.size} color="black" />)}</mask></defs>}
    <g mask={object.erasures.length ? `url(#${maskId})` : undefined}>
      {'points' in object && annotationBrushPasses(object.kind === 'line' ? { ...object.style, brush: 'round' } : object.style).map((pass, index) => <Stroke key={index} points={object.points} {...pass} />)}
      {path && <path d={annotationSvgPath(path, document)} fill={path.fill} stroke={path.stroke} strokeWidth={path.strokeWidth} strokeLinejoin="round" strokeLinecap="round" opacity={object.style.opacity * (object.kind === 'label' ? object.style.backgroundOpacity : 1)} />}
      {'x' in object && <text x={object.x + object.padding} y={object.y + object.padding + object.style.fontSize} fill={object.style.color} fontSize={object.style.fontSize} fontWeight={700} fontFamily="sans-serif" opacity={object.style.opacity}>{object.lines.map((line, index) => <tspan key={index} x={object.x + object.padding} dy={index ? object.style.fontSize * 1.2 : 0}>{line || '\u00a0'}</tspan>)}</text>}
    </g>
  </g>
}

export function ImageAnnotationEditor({ asset, onSave, onDownload, onClose }: ImageAnnotationEditorProps) {
  const [history, setHistory] = useState<AnnotationHistory | null>(null), historyRef = useRef<AnnotationHistory | null>(null)
  const [tool, setTool] = useState<AnnotationTool>('brush'), [style, setStyle] = useState<AnnotationStyle>({ ...defaultAnnotationStyle })
  const [selectedId, setSelectedId] = useState<string | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const [draft, setDraft] = useState<Gesture | null>(null), gesture = useRef<Gesture | null>(null), frame = useRef<number | null>(null)
  const [textDraft, setTextDraft] = useState<TextDraft | null>(null), textRef = useRef<TextDraft | null>(null), [labelText, setLabelText] = useState('重点说明')
  const [clearConfirm, setClearConfirm] = useState(false)
  const panel = useRef<HTMLElement>(null), textInput = useRef<HTMLTextAreaElement>(null), alive = useRef(true), operation = useRef<AbortController | null>(null)
  const measurement = useRef<CanvasRenderingContext2D | null>(null), serial = useRef(0), prefix = useId().replace(/:/g, '')
  const document = history?.present, selected = document?.objects.find((object) => object.id === selectedId)
  const width = document?.width ?? asset.width ?? 1, height = document?.height ?? asset.height ?? 1
  const activeStyle = selected?.style ?? style
  const drawn = useMemo(() => {
    if (!document || !draft) return null
    if (draft.tool === 'select' && draft.object) return moveAnnotation(draft.object, { x: draft.points.at(-1)!.x - draft.points[0].x, y: draft.points.at(-1)!.y - draft.points[0].y }, document)
    if (draft.tool === 'select' || draft.tool === 'eraser' || draft.tool === 'text' || draft.tool === 'label') return null
    return createAnnotationMark('draft', draft.tool, draft.points, draft.style)
  }, [draft, document])
  const selection = drawn && draft?.tool === 'select' ? drawn : selected
  const bounds = selection ? annotationBounds(selection) : null
  function nextId() { serial.current += 1; return `a${serial.current}` }
  function measure(text: string, size: number) {
    if (!measurement.current) measurement.current = window.document.createElement('canvas').getContext('2d')
    if (!measurement.current) return measureAnnotationText(text, size)
    measurement.current.font = `700 ${size}px sans-serif`
    return measurement.current.measureText(text).width
  }
  function setText(value: TextDraft | null) { textRef.current = value; setTextDraft(value) }
  function cancelGesture() { gesture.current = null; if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null; setDraft(null) }
  function change(next: AnnotationHistory) { historyRef.current = next; setHistory(next); setError(''); setClearConfirm(false) }
  function commit(next: AnnotationDocument) { const current = historyRef.current; if (current) change(commitAnnotation(current, next)) }
  function fail(cause: unknown) { setError(cause instanceof Error ? cause.message : '标注操作失败，请重试') }
  function finishText(): boolean {
    const current = textRef.current, state = historyRef.current
    if (!current || !state) return true
    if (!current.text.trim()) { setText(null); return true }
    try {
      const previous = state.present.objects.find((object) => object.id === current.id)
      const object = createAnnotationText(current.id, current.kind, current.point, current.text, current.style, state.present, measure)
      if (previous) object.erasures = previous.erasures
      commit(replaceAnnotationObject(state.present, object)); setSelectedId(object.id); setText(null); return true
    } catch (cause) { fail(cause); return false }
  }
  function switchTool(next: AnnotationTool) { if (operation.current || !finishText()) return; cancelGesture(); setTool(next); if (next === 'rectangle' || next === 'ellipse') setStyle((value) => ({ ...value, size: Math.min(64, value.size) })); setSelectedId(null); setClearConfirm(false) }
  function undo(redo = false) { if (operation.current) return; cancelGesture(); setText(null); const current = historyRef.current; if (current) change(redo ? redoAnnotation(current) : undoAnnotation(current)); setSelectedId(null) }
  function removeSelected() { if (!selectedId || !historyRef.current || operation.current) return; commit({ ...historyRef.current.present, objects: historyRef.current.present.objects.filter((object) => object.id !== selectedId) }); setSelectedId(null) }
  function updateStyle(patch: Partial<AnnotationStyle>) {
    if (operation.current || !finishText()) return
    setStyle((current) => ({ ...current, ...patch }))
    const state = historyRef.current, object = state?.present.objects.find((item) => item.id === selectedId)
    if (!object || !state) return
    try {
      const updatedStyle = { ...object.style, ...patch }
      const updated = 'x' in object ? { ...createAnnotationText(object.id, object.kind, object, object.text, updatedStyle, state.present, measure), erasures: object.erasures } : { ...object, style: updatedStyle }
      commit(replaceAnnotationObject(state.present, updated))
    } catch (cause) { fail(cause) }
  }
  function editText(value: string) {
    setLabelText(value)
    const state = historyRef.current, object = state?.present.objects.find((item) => item.id === selectedId)
    if (!object || !state || !('x' in object)) return
    setText({ id: object.id, kind: object.kind, point: { x: object.x, y: object.y }, text: value, style: object.style })
  }
  function close() { operation.current?.abort(); operation.current = null; cancelGesture(); onClose() }
  useEffect(() => {
    alive.current = true
    const previous = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { alive.current = false; operation.current?.abort(); gesture.current = null; if (frame.current !== null) cancelAnimationFrame(frame.current); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { if (textDraft && tool === 'text') textInput.current?.focus() }, [textDraft?.id, tool])
  function point(event: PointerEvent<SVGSVGElement>) { return document ? annotationPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), document) : null }
  function start(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 || gesture.current || !document || operation.current || !finishText()) return
    const first = point(event)
    if (!first) return
    event.preventDefault(); event.stopPropagation(); setError(''); setClearConfirm(false)
    const currentDocument = historyRef.current!.present
    if (tool === 'text') { setSelectedId(null); setText({ id: nextId(), kind: 'text', point: first, text: '', style: { ...style } }); return }
    if (tool === 'label') {
      try { const object = createAnnotationText(nextId(), 'label', first, labelText, style, currentDocument, measure); commit(replaceAnnotationObject(currentDocument, object)); setSelectedId(object.id); setTool('select') } catch (cause) { fail(cause) }
      return
    }
    const object = tool === 'select' ? hitAnnotation(currentDocument, first, Math.max(3, width / event.currentTarget.getBoundingClientRect().width * 5)) ?? undefined : undefined
    setSelectedId(object?.id ?? null)
    if (tool === 'select' && !object) return
    const next: Gesture = { pointerId: event.pointerId, tool, points: [first], object, style: { ...style } }
    gesture.current = next; setDraft(next); event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    const next = point(event)
    if (!next) return
    const last = current.points.at(-1)!
    if (Math.hypot(next.x - last.x, next.y - last.y) < Math.max(.5, current.style.size / 12)) return
    if (current.points.length >= 2048) { setError('本笔已达到路径点上限，请抬笔后继续'); return }
    current.points = current.tool === 'brush' || current.tool === 'eraser' ? [...current.points, next] : [current.points[0], next]
    if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; if (gesture.current === current) setDraft({ ...current }) })
  }
  function finish(event: PointerEvent<SVGSVGElement>, cancelled = false) {
    const current = gesture.current, state = historyRef.current
    if (!current || current.pointerId !== event.pointerId || !state) return
    if (!cancelled) move(event)
    cancelGesture()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (cancelled) return
    try {
      if (current.tool === 'eraser') { commit(eraseAnnotations(state.present, { points: current.points, size: current.style.size })); return }
      if (current.tool === 'select' && current.object) { commit(replaceAnnotationObject(state.present, moveAnnotation(current.object, { x: current.points.at(-1)!.x - current.points[0].x, y: current.points.at(-1)!.y - current.points[0].y }, state.present))); return }
      if (current.tool === 'select' || current.tool === 'text' || current.tool === 'label') return
      const object = createAnnotationMark(nextId(), current.tool, current.points, current.style)
      if (object) commit(replaceAnnotationObject(state.present, object))
    } catch (cause) { fail(cause) }
  }
  async function run(mode: 'replace' | 'new' | 'download') {
    if (operation.current || gesture.current || !finishText() || !historyRef.current) return
    if (mode !== 'download' && !historyRef.current.present.objects.length || mode === 'download' && !onDownload) return
    const controller = new AbortController(); operation.current = controller; setBusy(mode); setError('')
    try {
      const recipe = buildAnnotationRecipe(historyRef.current.present)
      if (mode === 'download') await onDownload?.(recipe, controller.signal)
      else await onSave(recipe, mode, controller.signal)
      if (alive.current && operation.current === controller && !controller.signal.aborted && mode !== 'download') onClose()
    } catch (cause) { if (alive.current && operation.current === controller && !controller.signal.aborted) fail(cause) }
    finally { if (operation.current === controller) { operation.current = null; if (alive.current) setBusy('') } }
  }
  const inspectorText = textDraft && textDraft.id === selectedId ? textDraft.text : selected && 'x' in selected ? selected.text : labelText
  return createPortal(<div className="annotation-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <section className="annotation-editor" role="dialog" aria-modal="true" aria-label="图片标注编辑器" ref={panel} tabIndex={-1} onKeyDown={(event) => {
      event.stopPropagation()
      const editing = event.target instanceof HTMLElement && !!event.target.closest('input, textarea, select, [contenteditable="true"]')
      if (event.key === 'Escape') { event.preventDefault(); if (gesture.current) cancelGesture(); else if (textRef.current) setText(null); else if (clearConfirm) setClearConfirm(false); else close(); return }
      if (event.key === 'Tab') {
        const controls = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]') ?? []).filter((item) => item.getClientRects().length)
        const index = controls.indexOf(window.document.activeElement as HTMLElement)
        if (controls.length && (event.shiftKey ? index <= 0 : index === controls.length - 1)) { event.preventDefault(); controls[event.shiftKey ? controls.length - 1 : 0].focus() }
      }
      if (editing || operation.current) return
      if ((event.metaKey || event.ctrlKey) && ['z', 'y'].includes(event.key.toLowerCase())) { event.preventDefault(); undo(event.key.toLowerCase() === 'y' || event.shiftKey); return }
      if (!event.metaKey && !event.ctrlKey && !event.altKey) {
        const shortcut = tools.find((item) => item.key && item.key.toLowerCase() === event.key.toLowerCase())
        if (shortcut) { event.preventDefault(); switchTool(shortcut.id) }
        if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected() }
      }
    }}>
      <header className="annotation-header"><div><strong>编辑图片 <span>标注</span></strong><small>{asset.displayName || asset.fileName} · {document ? `${width} × ${height}` : '正在读取原图尺寸'}</small></div><div className="annotation-history"><button type="button" aria-label="撤销标注" title="撤销 ⌘/Ctrl Z" disabled={!history?.past.length || !!busy} onClick={() => undo()}><Undo2 size={17} /></button><button type="button" aria-label="重做标注" title="重做 ⌘/Ctrl Shift Z" disabled={!history?.future.length || !!busy} onClick={() => undo(true)}><Redo2 size={17} /></button><button type="button" aria-label="关闭标注编辑器" onClick={close}><X size={19} /></button></div></header>
      <div className="annotation-options"><label>大小 <input aria-label="标注线宽" type="range" min={1} max={tool === 'rectangle' || tool === 'ellipse' ? 64 : 256} value={activeStyle.size} disabled={!!busy} onChange={(event) => updateStyle({ size: Number(event.target.value) })} /><output>{activeStyle.size} px</output></label><label>透明度 <input aria-label="标注透明度" type="range" min={5} max={100} value={Math.round(activeStyle.opacity * 100)} disabled={!!busy} onChange={(event) => updateStyle({ opacity: Number(event.target.value) / 100 })} /><output>{Math.round(activeStyle.opacity * 100)}%</output></label><label className="annotation-color">颜色 <input aria-label="标注颜色" type="color" value={activeStyle.color} disabled={!!busy} onChange={(event) => { const color = annotationColor(event.target.value); if (color) updateStyle({ color }) }} /></label>{tool === 'brush' && <select aria-label="画笔类型" value={style.brush} disabled={!!busy} onChange={(event) => setStyle((current) => ({ ...current, brush: event.target.value as AnnotationBrush }))}>{presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select>}<span className="annotation-tool-hint">{tool === 'eraser' ? '仅擦除标注，保留原图' : tool === 'select' ? '点击选择 · 拖动移动 · Delete 删除' : tool === 'text' ? '点击图片输入文字' : tool === 'label' ? '点击图片放置标签' : '在原图上拖动绘制'}</span></div>
      {error && <div className="annotation-error" role="alert">{error}</div>}
      <div className="annotation-workspace"><nav className="annotation-tools" aria-label="标注工具">{tools.map((item) => <button key={item.id} type="button" aria-label={`${item.label}${item.key ? ` (${item.key})` : ''}`} aria-pressed={tool === item.id} title={`${item.label}${item.key ? ` · ${item.key}` : ''}`} disabled={!!busy} onClick={() => switchTool(item.id)}><item.icon size={19} /><span>{item.label}</span></button>)}</nav>
        <div className="annotation-stage"><div className="annotation-image" style={{ '--annotation-ratio': width / height } as CSSProperties}>
          <SafeImage src={asset.localUrl} alt="标注原图" draggable={false} onError={() => setError('原图加载失败，请关闭后重新打开')} onLoad={(event) => {
            if (historyRef.current) return
            try { const image = event.currentTarget; change(createAnnotationHistory(image.naturalWidth, image.naturalHeight)) } catch (cause) { fail(cause) }
          }} />
          {document && <svg className="annotation-overlay" viewBox={`0 0 ${width} ${height}`} aria-label="图片标注画布" role="img" onPointerDown={start} onPointerMove={move} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={() => { if (gesture.current) cancelGesture() }} onDoubleClick={(event) => {
            if (operation.current || tool !== 'select') return
            const hit = hitAnnotation(document, annotationPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect(), document) ?? { x: -100, y: -100 })
            if (hit && 'x' in hit) { setTool('text'); setText({ id: hit.id, kind: hit.kind, point: { x: hit.x, y: hit.y }, text: hit.text, style: hit.style }); setSelectedId(hit.id) }
          }}>
            {document.objects.map((object) => <AnnotationVisual key={object.id} object={drawn && draft?.tool === 'select' && drawn.id === object.id ? drawn : object} document={document} prefix={prefix} />)}
            {drawn && draft?.tool !== 'select' && <AnnotationVisual object={drawn} document={document} prefix={`${prefix}-draft`} />}
            {draft?.tool === 'eraser' && <Stroke points={draft.points} size={draft.style.size} color="#ffffff" opacity={.5} />}
            {bounds && !textDraft && <rect className="annotation-selection" x={bounds.x - 3} y={bounds.y - 3} width={bounds.width + 6} height={bounds.height + 6} fill="none" stroke="#84a7ff" strokeWidth={1.5} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />}
          </svg>}
          {textDraft && tool === 'text' && <textarea ref={textInput} className="annotation-inline-text" aria-label="画面文字" value={textDraft.text} placeholder="输入文字…" style={{ left: `${Math.min(70, textDraft.point.x / width * 100)}%`, top: `${Math.min(75, textDraft.point.y / height * 100)}%`, color: textDraft.style.color }} onChange={(event) => setText({ ...textDraft, text: event.target.value })} onBlur={() => finishText()} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) { event.preventDefault(); if (finishText()) panel.current?.focus() } }} />}
        </div></div>
        <aside className="annotation-inspector"><div><strong>{selected ? '已选标注' : tool === 'text' ? '文字样式' : '标签样式'}</strong><p>{selected ? '修改样式后，当前标注即时更新。' : '先设置文字与样式，再点击图片放置。'}</p></div><label>标注文字<textarea aria-label="标签文字" value={inspectorText} maxLength={1000} disabled={!!busy || (!!selected && !('x' in selected))} onChange={(event) => editText(event.target.value)} onBlur={() => finishText()} placeholder="输入标签内容" /></label><label>字号 <input aria-label="标注字号" type="number" min={4} max={256} value={activeStyle.fontSize} disabled={!!busy || (!!selected && !('x' in selected))} onChange={(event) => { const fontSize = Number(event.target.value); if (fontSize >= 4 && fontSize <= 256) updateStyle({ fontSize }) }} /></label><label className="annotation-color">文字颜色<input aria-label="文字颜色" type="color" value={activeStyle.color} disabled={!!busy || (!!selected && !('x' in selected))} onChange={(event) => updateStyle({ color: event.target.value })} /></label><label className="annotation-color">标签背景<input aria-label="标签背景颜色" type="color" value={activeStyle.background} disabled={!!busy || (!!selected && selected.kind !== 'label')} onChange={(event) => updateStyle({ background: event.target.value })} /></label><label>背景透明度 <input aria-label="标签背景透明度" type="range" min={0} max={100} value={Math.round(activeStyle.backgroundOpacity * 100)} disabled={!!busy || (!!selected && selected.kind !== 'label')} onChange={(event) => updateStyle({ backgroundOpacity: Number(event.target.value) / 100 })} /><output>{Math.round(activeStyle.backgroundOpacity * 100)}%</output></label><label>圆角 <input aria-label="标签圆角" type="range" min={0} max={40} value={activeStyle.radius} disabled={!!busy || (!!selected && selected.kind !== 'label')} onChange={(event) => updateStyle({ radius: Number(event.target.value) })} /><output>{activeStyle.radius} px</output></label>{selected && <button type="button" className="annotation-remove" onClick={removeSelected} disabled={!!busy}><Trash2 size={15} /> 删除所选标注</button>}<p className="annotation-note">保存为 PNG 图片；再次打开时，标注已合并到图片中。原始素材仍保留在素材库。保存至当前节点后，重新运行此节点会替换标注结果，另存节点可固定成品。</p></aside>
      </div>
      <footer className="annotation-footer"><div><button type="button" disabled={!document?.objects.length || !!busy} onClick={() => { if (!clearConfirm) { setClearConfirm(true); return } if (document) { cancelGesture(); setText(null); commit({ ...document, objects: [] }); setSelectedId(null) } }}><Trash2 size={16} />{clearConfirm ? '确认清空全部标注' : '清空'}</button>{clearConfirm && <button type="button" onClick={() => setClearConfirm(false)}>取消清空</button>}{onDownload && <button type="button" disabled={!document || !!busy} onClick={() => void run('download')}><Download size={16} />{busy === 'download' ? '正在导出…' : '下载 PNG'}</button>}</div><span className="annotation-footer-status">{busy ? '处理中，可取消' : `${document?.objects.length ?? 0} 条标注 · 原图尺寸导出`}</span><div>{busy ? <button type="button" onClick={() => { operation.current?.abort(); operation.current = null; setBusy('') }}>取消操作</button> : <><button type="button" disabled={!document || (!document.objects.length && !textDraft?.text.trim())} onClick={() => void run('replace')}>保存至当前节点</button><button type="button" className="annotation-primary" disabled={!document || (!document.objects.length && !textDraft?.text.trim())} onClick={() => void run('new')}>另存为新节点</button></>}</div></footer>
    </section>
  </div>, window.document.body)
}
