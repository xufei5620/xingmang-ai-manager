import { useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from 'react'
import { Expand, Hand, ZoomIn, ZoomOut } from 'lucide-react'
import { classifyLayerEditorPointer, fitLayerEditorViewport, layerEditorViewportLimits, normalizeLayerEditorWheel, panLayerEditorViewport, resizeLayerEditorViewport, zoomLayerEditorViewport, type LayerEditorViewport as View, type LayerEditorViewportSize } from './layer-editor-viewport'

export interface LayerEditorViewportController { toggleHand(): void; exitHand(): void }
interface PanGesture { pointerId: number; x: number; y: number; before: View; wasFit: boolean }

/** View-only state is intentionally outside LayerEditorState. The children keep
 * their SVG screen-matrix mapping, including captured pointers beyond the edge. */
export function LayerEditorViewport({ width, height, sourcesKey, children, controllerRef, onInterrupt, onScaleChange, onHandChange }: { width: number; height: number; sourcesKey: string; children: ReactNode; controllerRef?: Ref<LayerEditorViewportController>; onInterrupt(): void; onScaleChange(scale: number): void; onHandChange(hand: boolean): void }) {
  const [view, setView] = useState<View>(() => fitLayerEditorViewport({ width: 600, height: 400 }, { width, height })), viewRef = useRef(view)
  const [hand, setHand] = useState(false), handRef = useRef(false), [space, setSpace] = useState(false), spaceRef = useRef(false), [panning, setPanning] = useState(false), [notice, setNotice] = useState('滚轮缩放 · H 手形 · 按住空格或中键平移')
  const viewport = useRef<HTMLDivElement>(null), size = useRef<LayerEditorViewportSize>({ width: 0, height: 0 }), fitted = useRef(true), pan = useRef<PanGesture | null>(null), pointers = useRef(new Set<number>()), blocked = useRef(false), alive = useRef(true)
  const current = useRef({ output: { width, height }, sourcesKey, onInterrupt, onScaleChange, onHandChange }); current.current = { output: { width, height }, sourcesKey, onInterrupt, onScaleChange, onHandChange }

  function update(next: View) { if (!alive.current) return; viewRef.current = next; setView(next); current.current.onScaleChange(next.zoom) }
  function release(pointerId: number) { const element = viewport.current; if (element?.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId) }
  function cancelPan(restore = true) { const previous = pan.current; pan.current = null; if (previous) { if (restore) { fitted.current = previous.wasFit; update(previous.before) }; release(previous.pointerId) }; setPanning(false) }
  function interrupt() { cancelPan(); current.current.onInterrupt() }
  function setHandTool(next: boolean) { interrupt(); handRef.current = next; setHand(next); current.current.onHandChange(next); viewport.current?.focus(); setNotice(next ? '手形已开启，拖动平移；点击其他工具恢复编辑' : '已返回编辑工具，视图位置保留') }
  function changeZoom(next: number, anchor?: { x: number; y: number }) {
    if (!alive.current || !size.current.width || !size.current.height) return
    interrupt(); fitted.current = false; setNotice(next === 1 ? '100% 原始像素 · 滚轮缩放 · 空格或中键平移' : '滚轮缩放 · H 手形 · 按住空格或中键平移')
    update(zoomLayerEditorViewport(viewRef.current, next, anchor ?? { x: size.current.width / 2, y: size.current.height / 2 }, size.current, current.current.output))
  }
  function fit() { interrupt(); fitted.current = true; update(fitLayerEditorViewport(size.current, current.current.output)); setNotice('已适应窗口；缩放和平移不会修改图层') }
  function measure() {
    const element = viewport.current
    if (!alive.current || !element || element.clientWidth <= 0 || element.clientHeight <= 0) return
    const next = { width: element.clientWidth, height: element.clientHeight }, previous = size.current
    if (next.width === previous.width && next.height === previous.height) return
    interrupt(); size.current = next
    update(fitted.current ? fitLayerEditorViewport(next, current.current.output) : resizeLayerEditorViewport(viewRef.current, previous, next, current.current.output))
  }
  function wheel(event: WheelEvent) {
    if (!alive.current) return
    event.preventDefault(); event.stopPropagation()
    const element = viewport.current, delta = normalizeLayerEditorWheel(event, size.current.height)
    if (!element || !delta) return
    const bounds = element.getBoundingClientRect()
    changeZoom(viewRef.current.zoom * Math.exp(-delta * .0025), { x: event.clientX - bounds.left - element.clientLeft, y: event.clientY - bounds.top - element.clientTop })
  }
  function down(event: PointerEvent<HTMLDivElement>) {
    if (!alive.current) return
    const action = classifyLayerEditorPointer({ button: event.button, pointerType: event.pointerType, isPrimary: event.isPrimary, handTool: handRef.current, spaceKey: spaceRef.current, blocked: blocked.current || pointers.current.size > 1 })
    if (action === 'ignore') { event.preventDefault(); event.stopPropagation(); return }
    if (action === 'edit') return
    event.preventDefault(); event.stopPropagation(); interrupt(); viewport.current?.focus()
    pan.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, before: viewRef.current, wasFit: fitted.current }
    setPanning(true)
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { cancelPan(); setNotice('平移已中断，请重新拖动') }
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (!alive.current) return
    if (blocked.current) { event.preventDefault(); event.stopPropagation(); return }
    const previous = pan.current
    if (!previous || previous.pointerId !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    if (event.buttons === 0) { cancelPan(); return }
    fitted.current = false
    update(panLayerEditorViewport(previous.before, { x: event.clientX - previous.x, y: event.clientY - previous.y }, size.current, current.current.output))
  }
  function up(event: PointerEvent<HTMLDivElement>) {
    if (!alive.current) return
    const previous = pan.current
    if (blocked.current) { event.preventDefault(); event.stopPropagation(); return }
    if (!previous || previous.pointerId !== event.pointerId) return
    event.preventDefault(); event.stopPropagation(); fitted.current = false
    update(panLayerEditorViewport(previous.before, { x: event.clientX - previous.x, y: event.clientY - previous.y }, size.current, current.current.output))
    pan.current = null; setPanning(false); release(previous.pointerId)
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return
    if (event.key === 'Escape' && pan.current) { event.preventDefault(); event.stopPropagation(); cancelPan(); return }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key.toLowerCase() === 'h') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) setHandTool(!handRef.current); return }
    if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); if (!spaceRef.current) { interrupt(); spaceRef.current = true; setSpace(true) }; return }
    if (event.key === '+' || event.key === '=') { event.preventDefault(); event.stopPropagation(); changeZoom(viewRef.current.zoom * 1.25); return }
    if (event.key === '-') { event.preventDefault(); event.stopPropagation(); changeZoom(viewRef.current.zoom / 1.25); return }
    if (event.key === '0') { event.preventDefault(); event.stopPropagation(); fit(); return }
    if (event.key === '1') { event.preventDefault(); event.stopPropagation(); changeZoom(1) }
  }
  function keyUp(event: KeyboardEvent<HTMLDivElement>) { if (event.key === ' ') { event.preventDefault(); event.stopPropagation(); spaceRef.current = false; setSpace(false) } }
  function releaseSpace(event: globalThis.KeyboardEvent) { if (event.key === ' ' && spaceRef.current) { spaceRef.current = false; setSpace(false) } }
  function focusLeft(event: { currentTarget: HTMLDivElement; relatedTarget: EventTarget | null }) { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) interrupt() }
  function windowBlur() { interrupt(); pointers.current.clear(); blocked.current = false; spaceRef.current = false; setSpace(false) }
  function pointerStarted(event: globalThis.PointerEvent) {
    const within = event.target instanceof Node && viewport.current?.contains(event.target)
    if (!within && !pointers.current.size) return
    pointers.current.add(event.pointerId)
    if (pointers.current.size > 1 || event.isPrimary === false) { blocked.current = true; interrupt(); setNotice('多指已取消当前编辑；选择手形后用单指平移') }
  }
  function pointerFinished(event: globalThis.PointerEvent) {
    pointers.current.delete(event.pointerId)
    // React's capture handler must still see the blocked state on this up.
    if (!pointers.current.size) queueMicrotask(() => { if (alive.current && !pointers.current.size) blocked.current = false })
  }
  function pointerCancelled(event: globalThis.PointerEvent) { if (pointers.current.has(event.pointerId) || pan.current?.pointerId === event.pointerId) interrupt(); pointerFinished(event) }
  useImperativeHandle(controllerRef, () => ({ toggleHand() { if (alive.current) setHandTool(!handRef.current) }, exitHand() { if (handRef.current) setHandTool(false) } }), [])
  useEffect(() => {
    alive.current = true
    const element = viewport.current
    if (!element) return
    const observer = new ResizeObserver(measure); observer.observe(element); measure()
    function visibility() { if (document.hidden) windowBlur() }
    element.addEventListener('wheel', wheel, { passive: false }); window.addEventListener('blur', windowBlur); window.addEventListener('keyup', releaseSpace); window.addEventListener('pointerdown', pointerStarted, true); window.addEventListener('pointerup', pointerFinished, true); window.addEventListener('pointercancel', pointerCancelled, true); document.addEventListener('visibilitychange', visibility)
    return () => { alive.current = false; pan.current = null; pointers.current.clear(); observer.disconnect(); element.removeEventListener('wheel', wheel); window.removeEventListener('blur', windowBlur); window.removeEventListener('keyup', releaseSpace); window.removeEventListener('pointerdown', pointerStarted, true); window.removeEventListener('pointerup', pointerFinished, true); window.removeEventListener('pointercancel', pointerCancelled, true); document.removeEventListener('visibilitychange', visibility) }
  }, [])
  useEffect(() => { if (size.current.width && size.current.height) fit() }, [width, height, sourcesKey])
  const minimum = Math.min(layerEditorViewportLimits.minZoom, fitLayerEditorViewport(size.current, { width, height }).zoom)
  return <div className="layer-editor-viewport-shell" onKeyDownCapture={keyDown} onKeyUpCapture={keyUp}>
    <div className="layer-editor-ruler layer-editor-viewbar"><span>{width} × {height} px</span><div role="group" aria-label="图层视图缩放"><button type="button" aria-label="缩小图层视图" title="缩小（−）" disabled={view.zoom <= minimum} onClick={() => changeZoom(viewRef.current.zoom / 1.25)}><ZoomOut size={15} /></button><output aria-label="当前图层视图比例">{Number((view.zoom * 100).toFixed(1))}%</output><button type="button" aria-label="放大图层视图" title="放大（+）" disabled={view.zoom >= layerEditorViewportLimits.maxZoom} onClick={() => changeZoom(viewRef.current.zoom * 1.25)}><ZoomIn size={15} /></button><button type="button" title="按原始像素显示（1）" onClick={() => changeZoom(1)}>100% 原始像素</button><button type="button" title="适应窗口（0）" onClick={fit}><Expand size={14} />适应窗口</button></div></div>
    <div ref={viewport} className={`layer-editor-workbench layer-editor-viewport${hand || space ? ' is-hand' : ''}${panning ? ' is-panning' : ''}`} tabIndex={0} role="region" aria-label="图层视口，滚轮缩放，H或空格及中键平移" onBlurCapture={focusLeft} onPointerDownCapture={down} onPointerMoveCapture={move} onPointerUpCapture={up} onLostPointerCaptureCapture={(event) => { if (pan.current?.pointerId === event.pointerId) { event.stopPropagation(); cancelPan() } }} onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); event.stopPropagation() } }} onDoubleClickCapture={(event) => { if (handRef.current || spaceRef.current) { event.preventDefault(); event.stopPropagation() } }}>
      <div className="layer-editor-viewport-frame" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>{children}</div>
    </div><div className="layer-editor-view-hint" role="status">{hand || space ? <><Hand size={12} />{space ? '空格临时平移，松开恢复原工具' : '手形平移中，点击绘制工具返回编辑'}</> : notice}</div>
  </div>
}
