import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowDownLeft, ArrowUpRight, Check, Expand, Hand, MoveRight, Redo2, RotateCcw, RotateCw, Undo2, Waves, X, ZoomIn, ZoomOut } from 'lucide-react'
import type { ImageLayerRecipe } from './recipe'
import { LayerRecipePreview, type LayerPreviewRasterStatus, type LayerToolImage } from './layerpreview'
import { buildLayerLocalPreviewRecipe } from './layer-local-preview-recipe'
import { layerLiquifyLimits, type ImageLayerLiquifyOperation, type ImageLayerLiquifyStroke, type ImageLayerLiquifyTool } from './layer-liquify'
import { appendLiquifyPoint, appendLiquifyRecipe, buildLiquifyOperation, hasLiquifyStroke, layerLiquifySpace, liquifyHistoryChange, liquifyHistoryStep, liquifyPoint, zoomLiquifyView, type LiquifyHistory, type LiquifyView } from './layer-liquify-editor-state'
import './layer-liquify-editor.css'

const tools = [
  { id: 'push', label: '推移', icon: MoveRight, hint: '拖动笔刷，将像素沿移动方向推开。' },
  { id: 'bulge', label: '膨胀', icon: ArrowUpRight, hint: '点击或拖动，让笔刷范围内的像素向外扩张。' },
  { id: 'pinch', label: '收缩', icon: ArrowDownLeft, hint: '点击或拖动，让笔刷范围内的像素向中心收拢。' },
  { id: 'twirl-cw', label: '顺时针扭曲', icon: RotateCw, hint: '点击或拖动，让笔刷范围内的像素顺时针旋转。' },
  { id: 'twirl-ccw', label: '逆时针扭曲', icon: RotateCcw, hint: '点击或拖动，让笔刷范围内的像素逆时针旋转。' },
] satisfies Array<{ id: ImageLayerLiquifyTool; label: string; icon: typeof MoveRight; hint: string }>

type Gesture = { kind: 'stroke'; pointerId: number; stroke: ImageLayerLiquifyStroke } | { kind: 'pan'; pointerId: number; start: { x: number; y: number }; before: LiquifyView }

export function LayerLiquifyEditor({ recipe, layerIndex, images, onApply, onClose }: { recipe: ImageLayerRecipe; layerIndex: number; images: readonly LayerToolImage[]; onApply(operation: ImageLayerLiquifyOperation): void; onClose(): void }) {
  const layer = recipe.layers[layerIndex], space = useMemo(() => layerLiquifySpace(recipe, layerIndex), [recipe, layerIndex])
  const [history, setHistory] = useState<LiquifyHistory>({ past: [], strokes: [], future: [] }), historyRef = useRef(history)
  const [shownOperation, setShownOperation] = useState<ImageLayerLiquifyOperation | null>(null), pendingOperation = useRef<ImageLayerLiquifyOperation | null>(null), previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shownOperationRef = useRef(shownOperation); shownOperationRef.current = shownOperation
  const readyOperation = useRef<ImageLayerLiquifyOperation | null>(null), [previewBusy, setPreviewBusy] = useState(false), [previewError, setPreviewError] = useState('')
  const [tool, setTool] = useState<ImageLayerLiquifyTool>('push'), [radius, setRadius] = useState(Math.min(100, Math.max(1, Math.round(Math.min(space.width, space.height) / 6)))), [strength, setStrength] = useState(.5)
  const [before, setBefore] = useState(false), [hand, setHand] = useState(false), [spaceHeld, setSpaceHeld] = useState(false), [drawing, setDrawing] = useState(false), [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const beforeRef = useRef(before); beforeRef.current = before
  const [view, setView] = useState<LiquifyView>({ zoom: 1, x: 0, y: 0 }), viewRef = useRef(view), [viewport, setViewport] = useState({ width: 600, height: 460 })
  const [error, setError] = useState(''), [notice, setNotice] = useState('在预览中拖动开始液化；不调用模型')
  const panel = useRef<HTMLElement>(null), stage = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), gesture = useRef<Gesture | null>(null), pointers = useRef(new Set<number>())
  const alive = useRef(true), completed = useRef(false)
  const scope = JSON.stringify([layerIndex, images.map((image) => [image.key, image.asset.assetId, image.asset.localUrl])]), initial = useRef({ recipe, scope }), current = useRef({ recipe, scope }); current.current = { recipe, scope }
  const fit = Math.min(Math.max(1, viewport.width - 32) / space.width, Math.max(1, viewport.height - 32) / space.height, 1)
  const displayedRecipe = useMemo(() => {
    const withEdits = appendLiquifyRecipe(recipe, layerIndex, before ? null : shownOperation), selected = withEdits.layers[layerIndex]
    return buildLayerLocalPreviewRecipe(recipe, selected)
  }, [recipe, layerIndex, space, before, shownOperation])

  function active() { return alive.current && !completed.current && initial.current.recipe === current.current.recipe && initial.current.scope === current.current.scope }
  function operation(strokes: readonly ImageLayerLiquifyStroke[]) { const value = buildLiquifyOperation(space, strokes); appendLiquifyRecipe(recipe, layerIndex, value); return value }
  function preview(strokes: readonly ImageLayerLiquifyStroke[], immediate = false) {
    pendingOperation.current = operation(strokes)
    readyOperation.current = null; setPreviewError(''); setPreviewBusy(!!pendingOperation.current)
    if (immediate) { if (previewTimer.current) clearTimeout(previewTimer.current); previewTimer.current = null; setShownOperation(pendingOperation.current); return }
    // Throttle rather than debounce: long strokes remain visible while the
    // shared raster scheduler cancels obsolete frames and publishes only latest.
    if (previewTimer.current === null) previewTimer.current = setTimeout(() => { previewTimer.current = null; if (active()) setShownOperation(pendingOperation.current) }, 90)
  }
  function receivePreviewStatus(status: LayerPreviewRasterStatus, captured: ImageLayerLiquifyOperation | null) {
    if (!active() || beforeRef.current || !captured || captured !== pendingOperation.current || captured !== shownOperationRef.current) return
    readyOperation.current = !status.busy && !status.error ? captured : null
    setPreviewBusy(status.busy); setPreviewError(status.error)
  }
  const onPreviewStatus = useMemo(() => (status: LayerPreviewRasterStatus) => receivePreviewStatus(status, shownOperation), [shownOperation])
  function updateHistory(next: LiquifyHistory) { historyRef.current = next; setHistory(next); preview(next.strokes, true) }
  function release(pointerId: number) { if (stage.current?.hasPointerCapture(pointerId)) stage.current.releasePointerCapture(pointerId) }
  function cancelGesture(message = '') {
    const previous = gesture.current; gesture.current = null
    if (previous?.kind === 'pan') { viewRef.current = previous.before; setView(previous.before) }
    if (previous) release(previous.pointerId)
    setDrawing(false); setCursor(null)
    if (alive.current && !completed.current) { preview(historyRef.current.strokes, true); if (message) setNotice(message) }
  }
  function close() { if (completed.current || !alive.current) return; cancelGesture(); completed.current = true; if (previewTimer.current) clearTimeout(previewTimer.current); previewTimer.current = null; onClose() }
  function apply() {
    if (!active()) return
    if (gesture.current) { setError('请先松开笔刷，再应用液化'); return }
    try {
      const value = operation(historyRef.current.strokes)
      if (!value) { setNotice('本次还没有液化笔迹，原图层没有改变'); return }
      if (beforeRef.current || !readyOperation.current || JSON.stringify(value) !== JSON.stringify(readyOperation.current)) { setError('请等待最新液化效果预览成功后再应用；预览失败时可撤销或重置'); return }
      completed.current = true
      onApply(value)
      if (previewTimer.current) clearTimeout(previewTimer.current)
      previewTimer.current = null; onClose()
    } catch (cause) { completed.current = false; setError(cause instanceof Error ? cause.message : '液化未能应用，当前草稿保留') }
  }
  function pointAt(clientX: number, clientY: number) {
    const matrix = svg.current?.getScreenCTM()
    if (!matrix) return null
    const value = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
    return liquifyPoint(value, space) ? { x: value.x, y: value.y } : null
  }
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!active() || event.button !== 0 || event.isPrimary === false || pointers.current.size > 1) return
    if (gesture.current) { cancelGesture('多指操作已取消当前笔迹'); return }
    event.preventDefault(); stage.current?.focus()
    if (hand || spaceHeld) gesture.current = { kind: 'pan', pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, before: viewRef.current }
    else {
      if (before) { setNotice('正在查看液化前，请切换到液化效果后绘制'); return }
      if (historyRef.current.strokes.length >= layerLiquifyLimits.strokes) { setError('本次已达到 64 笔，请应用后继续液化'); return }
      if (!strength) { setNotice('强度为 0，请先增加强度'); return }
      const point = pointAt(event.clientX, event.clientY), fixed = point && liquifyPoint(point, space)
      if (!fixed) return
      const stroke: ImageLayerLiquifyStroke = { tool, radius, strength, points: [fixed] }
      try { preview([...historyRef.current.strokes, stroke]); gesture.current = { kind: 'stroke', pointerId: event.pointerId, stroke }; setDrawing(true); setCursor(point); setError('') }
      catch (cause) { setError(cause instanceof Error ? cause.message : '无法开始液化'); return }
    }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { cancelGesture('无法捕获笔刷，请重新拖动') }
  }
  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!active()) return
    const activeGesture = gesture.current, point = pointAt(event.clientX, event.clientY)
    if (!activeGesture) { setCursor(point); return }
    if (activeGesture.pointerId !== event.pointerId) return
    if (!event.buttons) { cancelGesture('笔刷已中断，本笔未应用'); return }
    event.preventDefault()
    if (activeGesture.kind === 'pan') { const next = { ...activeGesture.before, x: activeGesture.before.x + event.clientX - activeGesture.start.x, y: activeGesture.before.y + event.clientY - activeGesture.start.y }; viewRef.current = next; setView(next); return }
    setCursor(point)
    const fixed = point && liquifyPoint(point, space)
    if (!fixed) return
    try { const stroke = appendLiquifyPoint(activeGesture.stroke, fixed, space); if (stroke === activeGesture.stroke) return; preview([...historyRef.current.strokes, stroke]); activeGesture.stroke = stroke }
    catch (cause) { setError(cause instanceof Error ? cause.message : '本笔无法继续，请松开后重试') }
  }
  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const previous = gesture.current
    if (!previous || previous.pointerId !== event.pointerId) return
    if (!active()) { cancelGesture(); return }
    if (previous.kind === 'stroke') {
      let stroke = previous.stroke
      const point = pointAt(event.clientX, event.clientY), fixed = point && liquifyPoint(point, space)
      if (fixed && stroke.points.length < layerLiquifyLimits.pointsPerStroke) stroke = appendLiquifyPoint(stroke, fixed, space, true)
      try { if (hasLiquifyStroke(stroke)) { const strokes = [...historyRef.current.strokes, stroke]; operation(strokes); updateHistory(liquifyHistoryChange(historyRef.current, strokes)); setNotice(`已记录 ${strokes.length} 笔；应用后才修改图层`) } else preview(historyRef.current.strokes, true) }
      catch (cause) { preview(historyRef.current.strokes, true); setError(cause instanceof Error ? cause.message : '本笔未应用，之前的笔迹保留') }
    }
    gesture.current = null; setDrawing(false); release(previous.pointerId)
  }
  function step(redo = false) { if (!active()) return; if (gesture.current?.kind === 'stroke') { cancelGesture('当前笔迹已取消'); return }; cancelGesture(); updateHistory(liquifyHistoryStep(historyRef.current, redo)); setError('') }
  function reset() { if (!active()) return; cancelGesture(); updateHistory(liquifyHistoryChange(historyRef.current, [])); setError(''); setNotice('本次液化已重置，可撤销恢复；图层已有编辑保留') }
  function zoom(next: number, anchor?: { x: number; y: number }) { cancelGesture(); const value = zoomLiquifyView(viewRef.current, next, anchor); viewRef.current = value; setView(value) }
  function fitView() { cancelGesture(); const value = { zoom: 1, x: 0, y: 0 }; viewRef.current = value; setView(value) }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); if (gesture.current) cancelGesture('当前笔迹已取消'); else close(); return }
    const editing = event.target instanceof Element && Boolean(event.target.closest('input,select,textarea'))
    if (!editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); step(event.shiftKey); return }
    if (!editing && event.key === ' ') { event.preventDefault(); setSpaceHeld(true) }
    if (event.key === 'Tab') { const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length); if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() } else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() } }
  }
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    function blur() { cancelGesture('笔刷已中断，本笔未应用'); setSpaceHeld(false); pointers.current.clear() }
    function visibility() { if (document.hidden) blur() }
    function down(event: globalThis.PointerEvent) { pointers.current.add(event.pointerId); if (pointers.current.size > 1) cancelGesture('多指操作已取消当前笔迹') }
    function up(event: globalThis.PointerEvent) { pointers.current.delete(event.pointerId) }
    window.addEventListener('blur', blur); window.addEventListener('pointerdown', down, true); window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true); document.addEventListener('visibilitychange', visibility)
    return () => { alive.current = false; gesture.current = null; if (previewTimer.current) clearTimeout(previewTimer.current); previewTimer.current = null; window.removeEventListener('blur', blur); window.removeEventListener('pointerdown', down, true); window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true); document.removeEventListener('visibilitychange', visibility); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { if (!active()) close() }, [recipe, scope])
  useEffect(() => { const element = stage.current; if (!element) return; const observer = new ResizeObserver(() => setViewport({ width: element.clientWidth, height: element.clientHeight })); observer.observe(element); setViewport({ width: element.clientWidth, height: element.clientHeight }); return () => observer.disconnect() }, [])
  useEffect(() => { const element = stage.current; if (!element) return; function wheel(event: WheelEvent) { event.preventDefault(); if (!active()) return; const bounds = element!.getBoundingClientRect(); zoom(viewRef.current.zoom * Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .003), { x: event.clientX - bounds.left - bounds.width / 2, y: event.clientY - bounds.top - bounds.height / 2 }) }; element.addEventListener('wheel', wheel, { passive: false }); return () => element.removeEventListener('wheel', wheel) }, [recipe, scope])

  return createPortal(<div className="liquify-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}><section ref={panel} className="liquify-editor" role="dialog" aria-modal="true" aria-label="图层液化" onKeyDown={keyboard} onKeyUp={(event) => { event.stopPropagation(); if (event.key === ' ') setSpaceHeld(false) }}>
    <header><div><span>图层工作区 · 像素工具</span><h2><Waves size={21} />图层液化</h2><small>{layer.name || `图层 ${layerIndex + 1}`} · {space.width} × {space.height} 原始像素 · 不调用模型</small></div><button type="button" aria-label="取消液化" onClick={close}><X size={20} /></button></header>
    <div className="liquify-layout"><main className="liquify-preview-panel"><div className="liquify-preview-toolbar"><div role="group" aria-label="液化前后对比"><button type="button" aria-pressed={before} onClick={() => { cancelGesture(); setBefore(true) }}>液化前</button><button type="button" aria-pressed={!before} onClick={() => { cancelGesture(); setBefore(false) }}>液化效果</button></div><div><button type="button" aria-label="撤销一笔液化" disabled={!history.past.length && !drawing} onClick={() => step()}><Undo2 size={16} /></button><button type="button" aria-label="重做一笔液化" disabled={!history.future.length} onClick={() => step(true)}><Redo2 size={16} /></button><span>{history.strokes.length} / 64 笔</span></div></div>
      <div ref={stage} className={`liquify-preview-stage${hand || spaceHeld ? ' is-panning' : before ? ' is-before' : ''}`} role="group" aria-label="液化预览，拖动绘制，滚轮缩放，空格或平移按钮拖动视图" tabIndex={0} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={(event) => { if (gesture.current?.pointerId === event.pointerId) cancelGesture('当前笔迹已取消') }} onLostPointerCapture={(event) => { if (gesture.current?.pointerId === event.pointerId) cancelGesture('笔刷已中断，本笔未应用') }} onPointerLeave={() => { if (!gesture.current) setCursor(null) }}>
        <div className="liquify-preview-image" style={{ width: space.width * fit * view.zoom, height: space.height * fit * view.zoom, transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` } as CSSProperties}><LayerRecipePreview recipe={displayedRecipe} images={images} svgRef={svg} onRasterStatus={onPreviewStatus}>{cursor && !before && !hand && !spaceHeld && <g className="liquify-brush-cursor" pointerEvents="none"><circle cx={cursor.x} cy={cursor.y} r={radius} stroke="#09141d" strokeWidth={3} vectorEffect="non-scaling-stroke" fill="none" /><circle cx={cursor.x} cy={cursor.y} r={radius} stroke="#d3f3e4" strokeWidth={1} vectorEffect="non-scaling-stroke" fill="#b6edce0a" /><circle cx={cursor.x} cy={cursor.y} r={1.5 / (fit * view.zoom)} fill="#d3f3e4" /></g>}</LayerRecipePreview></div>
        {before && <span className="liquify-before-label">本次液化前 · 既有编辑保留</span>}
      </div><div className="liquify-view-controls"><button type="button" aria-pressed={hand} onClick={() => { cancelGesture(); setHand(!hand) }}><Hand size={15} />平移</button><span className="liquify-view-spacer" /><button type="button" aria-label="缩小液化预览" onClick={() => zoom(viewRef.current.zoom / 1.25)}><ZoomOut size={16} /></button><output aria-label="液化预览缩放">{Math.round(fit * view.zoom * 100)}%</output><button type="button" aria-label="放大液化预览" onClick={() => zoom(viewRef.current.zoom * 1.25)}><ZoomIn size={16} /></button><button type="button" onClick={fitView}><Expand size={15} />适合窗口</button></div><p>独立查看当前层的本地像素，图层位置、旋转与透明度在返回后保留。滚轮缩放 · 空格拖动平移 · Esc 取消当前笔。</p>
    </main><aside className="liquify-controls" aria-label="液化笔刷参数"><h3>变形工具</h3><div className="liquify-tools" role="group" aria-label="液化工具">{tools.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-pressed={tool === id && !hand} onClick={() => { cancelGesture(); setTool(id); setHand(false); setBefore(false); setError('') }}><Icon size={18} /><span>{label}</span></button>)}</div><p className="liquify-tool-hint">{tools.find((entry) => entry.id === tool)?.hint}</p>
      <label className="liquify-field"><span>笔刷半径（原始像素）</span><div><input aria-label="液化半径滑杆" type="range" min={1} max={512} step={1} value={radius} onChange={(event) => { cancelGesture(); setRadius(event.currentTarget.valueAsNumber) }} /><input aria-label="笔刷半径（原始像素）" type="number" min={1} max={512} value={radius} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) { cancelGesture(); setRadius(Math.max(1, Math.min(512, Math.round(value)))) } }} /><small>px</small></div></label>
      <label className="liquify-field"><span>液化强度</span><div><input aria-label="液化强度滑杆" type="range" min={0} max={100} step={1} value={Math.round(strength * 100)} onChange={(event) => { cancelGesture(); setStrength(event.currentTarget.valueAsNumber / 100) }} /><input aria-label="液化强度（%）" type="number" min={0} max={100} value={Math.round(strength * 100)} onChange={(event) => { const value = event.currentTarget.valueAsNumber; if (Number.isFinite(value)) { cancelGesture(); setStrength(Math.max(0, Math.min(100, Math.round(value))) / 100) } }} /><small>%</small></div></label>
      <div className="liquify-help"><strong>只调整当前图层</strong><p>半径始终按原始像素计算，缩放预览不会改变笔刷大小。每次松开记录一笔；切换工具可继续叠加。</p><p>多指、失焦或中断会取消当前笔。已记录的笔迹可用 ⌘ / Ctrl Z 撤销，Shift Z 重做。</p></div><button type="button" className="liquify-reset" disabled={!history.strokes.length && !drawing} onClick={reset}><RotateCcw size={15} />重置本次液化</button></aside></div>
    <footer><div>{error || previewError ? <p role="alert">{error || previewError}</p> : <span role="status" aria-live="polite">{before ? '正在对比本次液化前，切回液化效果后可应用' : previewBusy ? '正在计算最新液化效果，完成后可应用…' : notice}</span>}<small>应用后可在图层工作区一次撤销；取消不会修改图层。</small></div><button type="button" onClick={close}>取消</button><button type="button" className="is-primary" disabled={!history.strokes.length || drawing || before || previewBusy || !!previewError || readyOperation.current !== shownOperation} onClick={apply}><Check size={16} />应用液化</button></footer>
  </section></div>, document.body)
}
