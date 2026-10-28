import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Download, Eye, EyeOff, RotateCcw, SlidersHorizontal, Upload, X } from 'lucide-react'
import { hostBridge } from '../host'
import type { ImageLayerRecipe } from './recipe'
import { buildLayerLocalPreviewRecipe } from './layer-local-preview-recipe'
import { LayerRecipePreview, type LayerPreviewSampler, type LayerToolImage } from './layerpreview'
import { defaultImageLayerColorGrade, imageLayerHslChannels, parseImageLayerColorGrade, type ImageLayerColorCurvePoint, type ImageLayerColorGrade } from './layer-color-grade'
import { addColorCurvePoint, buildColorGradeHistogram, colorGradeSections, moveColorCurvePoint, previewColorGrade, removeColorCurvePoint, resetColorGradeSection, sampleColorGradePixels, type ColorGradeHistogram, type ColorGradeSection } from './layer-color-grade-editor-state'
import { maximumColorGradeXmpBytes, parseColorGradeXmp, serializeColorGradeXmp, type ColorGradeXmpImport, type ColorGradeXmpExport } from './layer-color-grade-xmp'
import { ColorGradeXmpReview } from './ColorGradeXmpReview'
import { LayerColorLutControls } from './LayerColorLutControls'
import { LayerColorDetailControls } from './LayerColorDetailControls'
import { LayerColorPresenceControls } from './LayerColorPresenceControls'
import { LayerColorCalibrationControls } from './LayerColorCalibrationControls'
import { useLayerColorLutPreview } from './layer-color-lut-preview'
import { getPreparedColorLutTable } from './layer-color-lut-runtime'
import { buildColorGradePresetTransfer, importColorGradePresetTransfer, maximumColorGradePresetTransferBytes } from '../lib/color-grade-preset-transfer'
import './layer-color-grade-editor.css'

const channelLabels = { rgb: 'RGB', red: '红', green: '绿', blue: '蓝' }
const hslLabels = { red: '红', orange: '橙', yellow: '黄', green: '绿', aqua: '青', blue: '蓝', purple: '紫', magenta: '洋红' }
const hslColors = { red: '#ed6262', orange: '#ee9c52', yellow: '#e0c864', green: '#77b970', aqua: '#62bcbc', blue: '#648cdb', purple: '#a079d2', magenta: '#cf79b8' }
type XmpReview = { request: number; revision: number; scope: string; name: string } & ({ mode: 'import'; data: ColorGradeXmpImport } | { mode: 'export'; data: ColorGradeXmpExport })

function AdjustmentField({ label, value, min = -100, max = 100, step = 1, unit = '', onChange }: { label: string; value: number; min?: number; max?: number; step?: number; unit?: string; onChange(value: number): void }) {
  function change(value: number) { if (Number.isFinite(value)) onChange(Math.max(min, Math.min(max, Math.round(value / step) * step))) }
  return <label className="color-grade-field"><span>{label}</span><div><input type="range" aria-label={`${label}滑杆`} min={min} max={max} step={step} value={value} onChange={(event) => change(event.currentTarget.valueAsNumber)} /><input type="number" aria-label={label} min={min} max={max} step={step} value={Number(value.toFixed(4))} onChange={(event) => change(event.currentTarget.valueAsNumber)} />{unit && <small>{unit}</small>}</div></label>
}

export function ColorGradeCurveEditor({ points, channel, onChange }: { points: readonly ImageLayerColorCurvePoint[]; channel: keyof ImageLayerColorGrade['curves']; onChange(points: ImageLayerColorCurvePoint[]): void }) {
  const [selected, setSelected] = useState(0), [error, setError] = useState('')
  const svg = useRef<SVGSVGElement>(null), drag = useRef<{ pointerId: number; index: number; before: ImageLayerColorCurvePoint[] } | null>(null), current = useRef(points)
  current.current = points
  useEffect(() => { drag.current = null; setSelected(0); setError('') }, [channel])
  const index = Math.min(selected, points.length - 1), point = points[index]
  function pointAt(clientX: number, clientY: number) { const bounds = svg.current?.getBoundingClientRect(); return bounds?.width && bounds.height ? { x: (clientX - bounds.left) / bounds.width, y: 1 - (clientY - bounds.top) / bounds.height } : null }
  function commit(next: ImageLayerColorCurvePoint[]) { current.current = next; onChange(next); setError('') }
  function remove(at: number) { commit(removeColorCurvePoint(current.current, at)); setSelected(Math.max(0, at - 1)) }
  function keyboard(event: KeyboardEvent<SVGElement>, at: number) {
    const point = current.current[at]
    if (!point) return
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); remove(at); return }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? .05 : .01
    commit(moveColorCurvePoint(current.current, at, { x: point.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0), y: point.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0) }))
  }
  function cancel(pointerId: number) { const active = drag.current; if (active?.pointerId !== pointerId) return; drag.current = null; commit(active.before) }
  return <div className={`color-grade-curve is-${channel}`}>
    <svg ref={svg} viewBox="0 0 256 256" role="group" aria-label={`${channelLabels[channel]}点曲线，点击添加，拖动或方向键调整，双击删除中间点`} onPointerDown={(event) => {
      if (event.button !== 0 || event.isPrimary === false) return
      const point = pointAt(event.clientX, event.clientY); if (!point) return
      try { const next = addColorCurvePoint(current.current, point); commit(next.points); setSelected(next.index) } catch (cause) { setError(cause instanceof Error ? cause.message : '无法添加曲线点') }
    }} onPointerMove={(event) => { const active = drag.current; if (active?.pointerId !== event.pointerId) return; const point = pointAt(event.clientX, event.clientY); if (point) { event.preventDefault(); commit(moveColorCurvePoint(current.current, active.index, point)) } }} onPointerUp={(event) => { if (drag.current?.pointerId === event.pointerId) drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId) }} onPointerCancel={(event) => cancel(event.pointerId)} onLostPointerCapture={(event) => cancel(event.pointerId)}>
      {[64, 128, 192].map((value) => <g key={value} className="color-grade-curve-grid"><line x1={value} y1="0" x2={value} y2="256" /><line x1="0" y1={value} x2="256" y2={value} /></g>)}
      <line className="color-grade-curve-identity" x1="0" y1="256" x2="256" y2="0" />
      <polyline className="color-grade-curve-line" points={points.map((point) => `${point.x * 256},${(1 - point.y) * 256}`).join(' ')} />
      {points.map((point, at) => <circle key={at} cx={point.x * 256} cy={(1 - point.y) * 256} r={at === index ? 6 : 4.5} role="button" tabIndex={0} aria-label={`${channelLabels[channel]}曲线点${at + 1}，输入${Math.round(point.x * 100)}，输出${Math.round(point.y * 100)}`} aria-pressed={at === index} onFocus={() => setSelected(at)} onPointerDown={(event) => { if (event.button !== 0 || event.isPrimary === false) return; event.preventDefault(); event.stopPropagation(); setSelected(at); event.currentTarget.focus(); drag.current = { pointerId: event.pointerId, index: at, before: current.current.map((point) => ({ ...point })) }; svg.current?.setPointerCapture(event.pointerId) }} onDoubleClick={(event) => { event.preventDefault(); event.stopPropagation(); drag.current = null; remove(at) }} onKeyDown={(event) => keyboard(event, at)} />)}
    </svg>
    <div className="color-grade-curve-values"><label>曲线点<select aria-label="当前曲线点" value={index} onChange={(event) => setSelected(Number(event.currentTarget.value))}>{points.map((_, at) => <option key={at} value={at}>第 {at + 1} 点</option>)}</select></label><label>输入<input aria-label="曲线输入" type="number" min={0} max={100} step={.1} value={Number((point.x * 100).toFixed(2))} disabled={index === 0 || index === points.length - 1} onChange={(event) => commit(moveColorCurvePoint(current.current, index, { x: event.currentTarget.valueAsNumber / 100, y: point.y }))} /></label><label>输出<input aria-label="曲线输出" type="number" min={0} max={100} step={.1} value={Number((point.y * 100).toFixed(2))} onChange={(event) => commit(moveColorCurvePoint(current.current, index, { x: point.x, y: event.currentTarget.valueAsNumber / 100 }))} /></label></div>
    <div className="color-grade-curve-actions"><button type="button" disabled={points.length >= 16} onClick={() => { const gaps = points.slice(1).map((point, at) => ({ at, size: point.x - points[at].x })).sort((a, b) => b.size - a.size), at = gaps[0].at; const next = addColorCurvePoint(points, { x: (points[at].x + points[at + 1].x) / 2, y: (points[at].y + points[at + 1].y) / 2 }); commit(next.points); setSelected(next.index) }}>添加曲线点</button><button type="button" disabled={index === 0 || index === points.length - 1} onClick={() => remove(index)}>删除所选点</button></div>
    <small>点击加点 · 拖动调整 · 双击删除 · 方向键微调，Shift 加速</small>{error && <p role="alert">{error}</p>}
  </div>
}

function Histogram({ histogram, busy, error }: { histogram: ColorGradeHistogram | null; busy: boolean; error: string }) {
  const maximum = histogram ? Math.max(1, ...histogram.red, ...histogram.green, ...histogram.blue) : 1
  return <section className="color-grade-histogram" aria-label="当前图层采样直方图"><header><strong>直方图</strong><span>{busy ? '更新中…' : histogram ? `${histogram.pixels.toLocaleString()} 个采样像素` : '等待素材'}</span></header><svg viewBox="0 0 256 72" role="img" aria-label={histogram ? '红绿蓝通道像素分布' : '尚未读取像素分布'}>{histogram && (['red', 'green', 'blue'] as const).map((channel) => <path key={channel} className={`is-${channel}`} d={`M0,72 ${histogram[channel].map((value, at) => `L${at * 256 / 63},${72 - Math.sqrt(value / maximum) * 70}`).join(' ')} L256,72 Z`} />)}</svg><small>{error || '当前图层 · 原尺寸处理后采样 · 含当前图层效果'}</small></section>
}

export function LayerColorGradeEditor({ recipe, layerIndex, images, onApply, onClose, allowDownload = true }: { recipe: ImageLayerRecipe; layerIndex: number; images: readonly LayerToolImage[]; onApply(grade: ImageLayerColorGrade): void; onClose(): void; /** False when the host blocks page downloads: presets can still be loaded. */ allowDownload?: boolean }) {
  const layer = recipe.layers[layerIndex]
  const [draft, setDraft] = useState(() => layer.colorGrade ? parseImageLayerColorGrade(layer.colorGrade) : defaultImageLayerColorGrade()), draftRef = useRef(draft)
  const [shownDraft, setShownDraft] = useState(draft), [before, setBefore] = useState(false), [hidden, setHidden] = useState<ColorGradeSection[]>([])
  const beforeRef = useRef(before); beforeRef.current = before
  const [expanded, setExpanded] = useState<ColorGradeSection[]>(['light', 'color', 'lut', 'detail'])
  const [channel, setChannel] = useState<keyof ImageLayerColorGrade['curves']>('rgb'), [hsl, setHsl] = useState<typeof imageLayerHslChannels[number]>('red'), [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones')
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [presetName, setPresetName] = useState('我的图像调整'), [reading, setReadingState] = useState(false), readingRef = useRef(false)
  const [lutReading, setLutReading] = useState(false), lutReadingRef = useRef(false)
  const [xmpReview, setXmpReviewState] = useState<XmpReview | null>(null), xmpReviewRef = useRef<XmpReview | null>(null), xmpFileInput = useRef<HTMLInputElement>(null)
  const xmpImportTrigger = useRef<HTMLButtonElement>(null), xmpExportTrigger = useRef<HTMLButtonElement>(null), xmpFocus = useRef<{ mode: 'import' | 'export'; request: number; scope: string } | null>(null)
  const [histogram, setHistogram] = useState<ColorGradeHistogram | null>(null), [histogramError, setHistogramError] = useState(''), [histogramBusy, setHistogramBusy] = useState(true), [sampleRevision, setSampleRevision] = useState(0)
  const panel = useRef<HTMLElement>(null), fileInput = useRef<HTMLInputElement>(null), histogramSampler = useRef<LayerPreviewSampler | null>(null), alive = useRef(true), revision = useRef(0), importRequest = useRef(0), completed = useRef(false)
  const histogramController = useRef<AbortController | null>(null)
  const presetTransfer = useRef<{ controller: AbortController; request: number; revision: number; scope: string } | null>(null)
  const scope = JSON.stringify([layerIndex, images.map((image) => [image.key, image.asset.assetId, image.asset.localUrl])]), activeScope = useRef(scope); activeScope.current = scope
  const initialScope = useRef(scope), sessionScope = useMemo(() => ({ key: scope }), [scope])
  const effective = useMemo(() => previewColorGrade(shownDraft, hidden, before), [shownDraft, hidden, before])
  const previewRecipe = useMemo(() => buildLayerLocalPreviewRecipe(recipe, { ...layer, colorGrade: effective }), [recipe, layer, effective])
  const lutPreparationRecipe = useMemo(() => buildLayerLocalPreviewRecipe(recipe, { ...layer, colorGrade: draft }), [recipe, layer, draft])
  const lutState = useLayerColorLutPreview(lutPreparationRecipe), lutStateRef = useRef(lutState); lutStateRef.current = lutState
  const histogramScope = useMemo(() => ({ scope, previewRecipe, draft }), [scope, previewRecipe, draft]), latestHistogramScope = useRef(histogramScope); latestHistogramScope.current = histogramScope
  const previewSettled = shownDraft === draft
  function setReading(next: boolean) { readingRef.current = next; setReadingState(next) }
  function setXmpReview(next: XmpReview | null) { xmpReviewRef.current = next; setXmpReviewState(next) }
  function reportLutReading(next: boolean) { lutReadingRef.current = next; if (alive.current) setLutReading(next) }
  function abortPresetTransfer() { const pending = presetTransfer.current; presetTransfer.current = null; pending?.controller.abort() }
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => { alive.current = false; importRequest.current++; histogramController.current?.abort(); abortPresetTransfer(); if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { const timer = setTimeout(() => setShownDraft(draft), 120); return () => clearTimeout(timer) }, [draft])
  useEffect(() => { if (scope !== initialScope.current) { importRequest.current++; abortPresetTransfer(); setReading(false); setXmpReview(null); setError('图层或素材已变化，请关闭后重新打开图像调整') } }, [scope])
  useEffect(() => {
    if (!alive.current || completed.current) return
    if (xmpReview && xmpReview.request === importRequest.current && xmpReview.revision === revision.current && xmpReview.scope === activeScope.current) {
      const review = panel.current?.querySelector<HTMLElement>('.color-grade-xmp-review')
      review?.focus({ preventScroll: true }); review?.scrollIntoView({ block: 'start', behavior: 'instant' })
    } else if (!xmpReview && !reading && xmpFocus.current) {
      const pending = xmpFocus.current; xmpFocus.current = null
      if (pending.request === importRequest.current && pending.scope === activeScope.current) (pending.mode === 'import' ? xmpImportTrigger : xmpExportTrigger).current?.focus()
    }
  }, [xmpReview, reading])
  useEffect(() => {
    const controller = new AbortController(), captured = histogramScope, capturedRevision = revision.current, capturedTables = lutState.tables
    histogramController.current?.abort(); histogramController.current = controller
    setHistogram(null); setHistogramBusy(true); setHistogramError('')
    if (!previewSettled || lutState.busy || lutState.error) {
      if (lutState.error) { setHistogramBusy(false); setHistogramError(lutState.error) }
      return () => controller.abort()
    }
    let retries = 0
    function current() { return alive.current && !completed.current && !controller.signal.aborted && latestHistogramScope.current === captured && activeScope.current === captured.scope && revision.current === capturedRevision && lutStateRef.current.tables === capturedTables && !lutStateRef.current.busy && !lutStateRef.current.error }
    async function read() {
      try {
        if (!histogramSampler.current) throw new Error('图层预览仍在加载')
        // samplePixels replays the chosen layer through the native painter.
        // Only its completed pixels are reduced for statistics; neighborhood
        // kernels must never receive the reduced histogram bitmap.
        const pixels = await histogramSampler.current.samplePixels({ source: 'current', layerIndex: 0 }, controller.signal)
        if (!current()) return
        const result = buildColorGradeHistogram(sampleColorGradePixels(pixels).data)
        if (current()) { setHistogram(result); setHistogramError(''); setHistogramBusy(false) }
      } catch (cause) {
        if (!current()) return
        const message = cause instanceof Error ? cause.message : '直方图暂不可读'
        if (/加载|预览/.test(message) && retries++ < 3) { timer = setTimeout(() => void read(), 350); return }
        setHistogramError(message); setHistogramBusy(false)
      }
    }
    let timer = setTimeout(() => void read(), 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [histogramScope, previewSettled, layerIndex, sampleRevision, lutState.tables, lutState.busy, lutState.error])
  function change(next: ImageLayerColorGrade) {
    if (completed.current || !alive.current || scope !== activeScope.current || scope !== initialScope.current) return
    const parsed = parseImageLayerColorGrade(next)
    if (JSON.stringify(parsed.lut?.source) !== JSON.stringify(draftRef.current.lut?.source)) setShownDraft(parsed)
    if (presetTransfer.current) { abortPresetTransfer(); importRequest.current++; setReading(false) }
    histogramController.current?.abort(); draftRef.current = parsed; revision.current++; setHistogram(null); setHistogramBusy(true); setDraft(parsed); setError(''); setNotice('')
  }
  function compare(next: boolean) { if (beforeRef.current === next) return; beforeRef.current = next; histogramController.current?.abort(); setHistogram(null); setHistogramBusy(true); setBefore(next) }
  function patch(next: Partial<ImageLayerColorGrade>) { change({ ...draftRef.current, ...next }) }
  function reset(section?: ColorGradeSection) { if (readingRef.current || lutReadingRef.current || xmpReviewRef.current) return; change(section ? resetColorGradeSection(draftRef.current, section) : defaultImageLayerColorGrade()) }
  function close() { if (completed.current) return; completed.current = true; importRequest.current++; histogramController.current?.abort(); abortPresetTransfer(); onClose() }
  function apply() {
    if (completed.current || !alive.current || readingRef.current || lutReadingRef.current || xmpReviewRef.current) return
    try {
      if (scope !== activeScope.current || scope !== initialScope.current) throw new Error('图层或素材已变化，请重新打开图像调整')
      const state = lutStateRef.current
      if (state.busy) throw new Error('LUT 调色表正在准备，请稍后完成')
      if (state.error) throw new Error(state.error)
      const grade = parseImageLayerColorGrade(draftRef.current)
      getPreparedColorLutTable(grade.lut, state.tables)
      onApply(grade); completed.current = true; importRequest.current++; histogramController.current?.abort(); abortPresetTransfer(); onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '图像调整未能应用，请重新打开') }
  }
  async function importPreset(file: File) {
    if (completed.current || !alive.current || lutReadingRef.current || xmpReviewRef.current || scope !== initialScope.current) return
    abortPresetTransfer()
    const request = ++importRequest.current, capturedRevision = revision.current, capturedScope = scope, controller = new AbortController()
    const pending = { controller, request, revision: capturedRevision, scope: capturedScope }; presetTransfer.current = pending
    function current() { return alive.current && !completed.current && !controller.signal.aborted && request === importRequest.current && capturedScope === activeScope.current && presetTransfer.current === pending }
    function assertCurrent() { if (!current() || capturedRevision !== revision.current) throw new Error('读取预设期间调整已改变，请重新选择预设；当前草稿保留') }
    setReading(true); setError('')
    try {
      if (file.size > maximumColorGradePresetTransferBytes) throw new Error('完整 JSON 调整预设不能超过 768 KiB')
      const text = await file.text()
      if (!current()) return
      assertCurrent()
      const preset = await importColorGradePresetTransfer(text, async (table, signal) => {
        assertCurrent(); const bridge = hostBridge()
        if (!bridge.importColorLut) throw new Error('当前环境暂不支持保存预设中的 LUT，请保留原文件')
        const descriptor = await bridge.importColorLut(table, signal); assertCurrent(); return descriptor
      }, { signal: controller.signal, deadline: Date.now() + 30000 })
      if (!current()) return
      assertCurrent(); presetTransfer.current = null; setReading(false)
      change(preset.settings); setPresetName(preset.name); setHidden([]); setBefore(false); setNotice(`已载入「${preset.name}」，完成后才应用到图层`)
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '预设无法读取') }
    finally { if (presetTransfer.current === pending) { presetTransfer.current = null; if (alive.current && request === importRequest.current) setReading(false) } }
  }
  async function exportPreset() {
    if (completed.current || !alive.current || readingRef.current || lutReadingRef.current || xmpReviewRef.current || scope !== initialScope.current) return
    const request = ++importRequest.current, capturedRevision = revision.current, capturedScope = scope, controller = new AbortController(), settings = parseImageLayerColorGrade(draftRef.current)
    const pending = { controller, request, revision: capturedRevision, scope: capturedScope }; presetTransfer.current = pending
    function current() { return alive.current && !completed.current && !controller.signal.aborted && request === importRequest.current && capturedScope === activeScope.current && presetTransfer.current === pending && capturedRevision === revision.current }
    setReading(true); setError(''); setNotice('正在准备完整 JSON 预设，当前调整保留')
    try {
      const text = await buildColorGradePresetTransfer(presetName, settings, async (source, signal) => {
        if (!current()) throw new Error('调整已改变，已取消预设导出')
        const bridge = hostBridge(); if (!bridge.readColorLut) throw new Error('当前环境无法读取完整 LUT，请保留当前调整后重试')
        const resource = await bridge.readColorLut(source, signal)
        if (!current()) throw new Error('调整已改变，已取消预设导出')
        return resource
      }, { signal: controller.signal, deadline: Date.now() + 30000 })
      if (!current()) return
      const blob = new Blob([text], { type: 'application/json' }), url = URL.createObjectURL(blob), anchor = document.createElement('a')
      anchor.href = url; anchor.download = '星芒-图像调整预设.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('预设已下载到本机，当前图层尚未应用')
    } catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : '预设保存失败') }
    finally { if (presetTransfer.current === pending) { presetTransfer.current = null; if (alive.current && request === importRequest.current) setReading(false) } }
  }
  function cancelXmpImport() { if (completed.current || !alive.current || xmpReview && xmpReview.request !== importRequest.current) return; const presetPending = !!presetTransfer.current; abortPresetTransfer(); const request = ++importRequest.current; xmpFocus.current = { mode: xmpReview?.mode ?? 'import', request, scope }; setXmpReview(null); setReading(false); setNotice(presetPending ? '已取消 JSON 预设操作，当前草稿保留' : '已取消 XMP 操作，当前草稿保留') }
  async function importXmp(file: File) {
    if (completed.current || !alive.current || lutReadingRef.current || presetTransfer.current || scope !== activeScope.current || scope !== initialScope.current) return
    const request = ++importRequest.current, capturedRevision = revision.current, capturedScope = scope, current = parseImageLayerColorGrade(draftRef.current)
    setReading(true); setError(''); setXmpReview(null); setNotice('正在本地读取 XMP，核对确认前草稿不会改变')
    try {
      if (file.size > maximumColorGradeXmpBytes) throw new Error('XMP 文件不能超过 64 KiB')
      const text = await file.text()
      if (!alive.current || completed.current || request !== importRequest.current || capturedScope !== activeScope.current) return
      if (capturedRevision !== revision.current) throw new Error('读取 XMP 期间调整已改变，请重新选择文件；当前草稿保留')
      const data = parseColorGradeXmp(text, current)
      setXmpReview({ mode: 'import', request, revision: capturedRevision, scope: capturedScope, name: file.name, data })
      setNotice('请核对 XMP 参数变化及不支持项，确认前草稿不会改变')
    } catch (cause) { if (alive.current && !completed.current && request === importRequest.current && capturedScope === activeScope.current) setError(cause instanceof Error ? cause.message : 'XMP 无法读取') }
    finally { if (alive.current && request === importRequest.current) setReading(false) }
  }
  function exportXmp() {
    if (completed.current || !alive.current || lutReadingRef.current || readingRef.current || scope !== activeScope.current || scope !== initialScope.current) return
    try { const data = serializeColorGradeXmp(presetName, draftRef.current), request = ++importRequest.current; setReading(false); setError(''); setXmpReview({ mode: 'export', request, revision: revision.current, scope, name: presetName, data }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'XMP 无法导出') }
  }
  function confirmXmp() {
    if (!xmpReview || completed.current || !alive.current) return
    if (xmpReview.request !== importRequest.current) return
    if (xmpReview.revision !== revision.current || xmpReview.scope !== activeScope.current) { xmpFocus.current = { mode: xmpReview.mode, request: importRequest.current, scope: xmpReview.scope }; setXmpReview(null); setError('核对期间调整或图层已改变，请重新读取或导出 XMP；当前草稿保留'); return }
    try {
      if (xmpReview.mode === 'import') { change(xmpReview.data.settings); setHidden([]); setBefore(false); setNotice(`已将 XMP 的 ${xmpReview.data.mappedFields.length} 项参数应用到草稿，完成后才应用到图层`) }
      else {
        const blob = new Blob([xmpReview.data.text], { type: 'application/rdf+xml' }), url = URL.createObjectURL(blob), anchor = document.createElement('a')
        anchor.href = url; anchor.download = '星芒-图像调整预设.xmp'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('XMP 参数子集已下载，完整参数请另外保存 JSON')
      }
      const request = ++importRequest.current; xmpFocus.current = { mode: xmpReview.mode, request, scope: xmpReview.scope }; setXmpReview(null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'XMP 操作未完成，当前草稿保留') }
  }
  function section(key: ColorGradeSection, children: ReactNode) {
    const label = colorGradeSections.find((section) => section.key === key)!.label, disabled = hidden.includes(key)
    return <details className={`color-grade-section${disabled ? ' is-bypassed' : ''}`} open={expanded.includes(key)} onToggle={(event) => { const open = event.currentTarget.open; setExpanded((current) => current.includes(key) === open ? current : open ? [...current, key] : current.filter((entry) => entry !== key)) }}><summary>{label}<span onClick={(event) => event.preventDefault()}><button type="button" title={`复位${label}`} aria-label={`复位${label}`} disabled={reading || lutReading || !!xmpReview} onClick={() => reset(key)}><RotateCcw size={13} /></button><button type="button" title={`${disabled ? '显示' : '临时隐藏'}${label}${key === 'effects' ? '' : '效果'}`} aria-label={`${disabled ? '显示' : '临时隐藏'}${label}${key === 'effects' ? '' : '效果'}`} aria-pressed={!disabled} onClick={() => { histogramController.current?.abort(); setHistogram(null); setHistogramBusy(true); setHidden((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]) }}>{disabled ? <EyeOff size={14} /> : <Eye size={14} />}</button></span></summary>{disabled && <p className="color-grade-preview-only">此节暂不参与预览，完成时仍保存参数。</p>}{children}</details>
  }
  return createPortal(<div className="color-grade-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
    <section className="color-grade-editor" ref={panel} role="dialog" aria-modal="true" aria-label="图像调整" onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape') { event.preventDefault(); if (xmpReview || reading) cancelXmpImport(); else close() } if (event.key === 'Tab') { const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length); if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() } else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() } } }}>
      <header><div><span>图层工作区</span><h2><SlidersHorizontal size={20} />图像调整</h2><small>{layer.name || `图层 ${layerIndex + 1}`} · 修改在完成后应用</small></div><button type="button" aria-label="取消图像调整" onClick={close}><X size={20} /></button></header>
      <div className="color-grade-layout"><main className="color-grade-preview-panel"><div className="color-grade-preview-toolbar"><div role="group" aria-label="图像调整对比"><button type="button" aria-pressed={before} onClick={() => compare(true)}>未调色</button><button type="button" aria-pressed={!before} onClick={() => compare(false)}>调整效果</button></div><span>{before ? '当前图层未调色' : hidden.length ? `${hidden.length} 节效果暂隐藏` : '实时预览'}</span></div><div className="color-grade-preview-stage" style={{ '--color-grade-ratio': previewRecipe.outputWidth / previewRecipe.outputHeight } as CSSProperties}><LayerRecipePreview recipe={previewRecipe} images={images} samplerRef={histogramSampler} lutState={lutState} /></div><p>对比和临时隐藏只影响预览。完成后可在图层工作区一次撤销。</p></main>
        <aside className="color-grade-controls" aria-label="图像调整参数">{xmpReview && <ColorGradeXmpReview mode={xmpReview.mode} name={xmpReview.name} mappedFields={xmpReview.data.mappedFields} differences={xmpReview.mode === 'import' ? xmpReview.data.differences : []} warnings={xmpReview.data.warnings} onConfirm={confirmXmp} onCancel={cancelXmpImport} />}<Histogram histogram={previewSettled && !lutState.busy && !lutState.error ? histogram : null} busy={histogramBusy || !previewSettled || lutState.busy} error={lutState.error || histogramError} />{histogramError && <button type="button" onClick={() => setSampleRevision((value) => value + 1)}>重新读取直方图</button>}
          {section('lut', <><LayerColorLutControls value={draft.lut} disabled={reading || !!xmpReview || scope !== initialScope.current} revision={revision.current} scope={sessionScope} onChange={(lut) => patch({ lut })} onReadingChange={reportLutReading} onImport={async (file, signal) => { if (!alive.current || completed.current || scope !== activeScope.current || scope !== initialScope.current) throw new Error('图层或素材已变化，请重新打开图像调整'); const bridge = hostBridge(); if (!bridge.importColorLutFile) throw new Error('当前环境暂不支持导入 LUT 文件'); return bridge.importColorLutFile(file, signal) }} />{lutState.busy && <p role="status">正在准备 LUT 调色表，完成调整暂不可用…</p>}{lutState.error && <div><p role="alert">{lutState.error}</p><button type="button" disabled={reading || lutReading} onClick={() => { if (alive.current && !completed.current) lutStateRef.current.retry() }}>重新读取 LUT</button></div>}</>)}
          {section('detail', <LayerColorDetailControls value={draft.detail} disabled={reading || lutReading || !!xmpReview || scope !== initialScope.current} onChange={(detail) => patch({ detail })} />)}
          {section('light', <>{([['exposure', '曝光'], ['contrast', '对比度'], ['highlights', '高光'], ['shadows', '阴影'], ['whites', '白色色阶'], ['blacks', '黑色色阶']] as const).map(([key, label]) => <AdjustmentField key={key} label={label} value={draft[key]} min={key === 'exposure' ? -4 : -100} max={key === 'exposure' ? 4 : 100} step={key === 'exposure' ? .01 : 1} unit={key === 'exposure' ? 'EV' : ''} onChange={(value) => patch({ [key]: value })} />)}</>)}
          {section('color', <><AdjustmentField label="色温" value={draft.temperature} min={2000} max={10000} step={50} unit="K" onChange={(temperature) => patch({ temperature })} /><AdjustmentField label="色调" value={draft.tint} min={-150} max={150} onChange={(tint) => patch({ tint })} /><AdjustmentField label="自然饱和度" value={draft.vibrance} onChange={(vibrance) => patch({ vibrance })} /><AdjustmentField label="饱和度" value={draft.saturation} onChange={(saturation) => patch({ saturation })} /><label className="color-grade-checkbox"><input type="checkbox" checked={draft.blackWhite} onChange={(event) => patch({ blackWhite: event.currentTarget.checked })} />黑白</label></>)}
          {section('curves', <><div className="color-grade-tabs" role="group" aria-label="曲线通道">{(['rgb', 'red', 'green', 'blue'] as const).map((key) => <button type="button" key={key} aria-pressed={channel === key} onClick={() => setChannel(key)}>{channelLabels[key]}</button>)}</div><ColorGradeCurveEditor key={channel} points={draft.curves[channel]} channel={channel} onChange={(points) => patch({ curves: { ...draftRef.current.curves, [channel]: points } })} /></>)}
          {section('hsl', <><div className="color-grade-hsl-tabs" role="group" aria-label="HSL 色彩通道">{imageLayerHslChannels.map((key) => <button type="button" key={key} aria-label={`${hslLabels[key]}色通道`} aria-pressed={hsl === key} style={{ '--color-grade-swatch': hslColors[key] } as CSSProperties} onClick={() => setHsl(key)}><i /><span>{hslLabels[key]}</span></button>)}</div>{([['hue', '色相'], ['saturation', '饱和度'], ['luminance', '明度']] as const).map(([key, label]) => <AdjustmentField key={key} label={`${hslLabels[hsl]}色${label}`} value={draft.hsl[hsl][key]} onChange={(value) => patch({ hsl: { ...draftRef.current.hsl, [hsl]: { ...draftRef.current.hsl[hsl], [key]: value } } })} />)}</>)}
          {section('colorGrading', <><div className="color-grade-tabs" role="group" aria-label="分级明暗范围">{([['shadows', '阴影'], ['midtones', '中间调'], ['highlights', '高光']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={tone === key} onClick={() => setTone(key)}>{label}</button>)}</div>{([['hue', '分级色相', 0, 360], ['saturation', '分级饱和度', 0, 100], ['luminance', '分级明度', -100, 100]] as const).map(([key, label, min, max]) => <AdjustmentField key={key} label={label} value={draft.colorGrading[tone][key]} min={min} max={max} onChange={(value) => patch({ colorGrading: { ...draftRef.current.colorGrading, [tone]: { ...draftRef.current.colorGrading[tone], [key]: value } } })} />)}<AdjustmentField label="分级混合" value={draft.colorGrading.blending} min={0} onChange={(blending) => patch({ colorGrading: { ...draftRef.current.colorGrading, blending } })} /><AdjustmentField label="分级平衡" value={draft.colorGrading.balance} onChange={(balance) => patch({ colorGrading: { ...draftRef.current.colorGrading, balance } })} /></>)}
          {section('effects', <><LayerColorPresenceControls value={draft.presence} disabled={reading || lutReading || !!xmpReview || scope !== initialScope.current} onChange={(presence) => patch({ presence })} /><AdjustmentField label="暗角" value={draft.vignette} onChange={(vignette) => patch({ vignette })} /><AdjustmentField label="颗粒" value={draft.grain} min={0} onChange={(grain) => patch({ grain })} /></>)}
          {section('calibration', <LayerColorCalibrationControls value={draft.calibration} disabled={reading || lutReading || !!xmpReview || scope !== initialScope.current} onChange={(calibration) => patch({ calibration })} />)}
          <section className="color-grade-presets" aria-label="图像调整本地预设"><strong>调整预设</strong><label>名称<input aria-label="图像调整预设名称" value={presetName} maxLength={80} onChange={(event) => setPresetName(event.currentTarget.value)} /></label><div>{allowDownload && <button type="button" disabled={reading || lutReading || !!xmpReview} onClick={() => void exportPreset()}><Download size={14} />保存到本机</button>}<button type="button" disabled={reading || lutReading || !!xmpReview} onClick={() => fileInput.current?.click()}><Upload size={14} />{reading ? '读取中…' : '载入预设'}</button><input ref={fileInput} type="file" accept=".json,application/json" hidden aria-label="载入图像调整 JSON 预设" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importPreset(file) }} /></div><div>{allowDownload && <button type="button" ref={xmpExportTrigger} disabled={reading || lutReading} onClick={exportXmp}><Download size={14} />导出 XMP</button>}<button type="button" ref={xmpImportTrigger} disabled={reading || lutReading} onClick={() => xmpFileInput.current?.click()}><Upload size={14} />导入 XMP</button><input ref={xmpFileInput} type="file" accept=".xmp,application/rdf+xml,application/xml,text/xml" hidden aria-label="载入图像调整 XMP 预设" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void importXmp(file) }} /></div>{reading && <button type="button" onClick={cancelXmpImport}>取消读取</button>}<small>完整 JSON 预设上限 768 KiB，可携带自定义 LUT 并保存到当前账号素材；XMP 上限 64 KiB，不携带 LUT，导入和导出均需核对确认。</small></section>
        </aside></div>
      <footer><div>{error ? <p role="alert">{error}</p> : <span role="status">{notice || '当前仅编辑草稿，取消会保留原图层'}</span>}</div><button type="button" disabled={reading || lutReading || !!xmpReview} onClick={() => reset()}><RotateCcw size={14} />全部复位</button><button type="button" onClick={close}>取消</button><button type="button" className="is-primary" disabled={reading || lutReading || !!xmpReview || lutState.busy || !!lutState.error || scope !== initialScope.current} onClick={apply}><Check size={15} />完成调整</button></footer>
    </section>
  </div>, document.body)
}
