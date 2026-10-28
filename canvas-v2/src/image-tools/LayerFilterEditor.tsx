import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, Eye, Hand, RotateCcw, Scan, SlidersHorizontal, X } from 'lucide-react'
import type { ImageLayerRecipe } from './recipe'
import type { LayerPreviewRasterStatus, LayerToolImage } from './layerpreview'
import { LayerFilterPreview } from './LayerFilterPreview'
import { LayerEditorViewport, type LayerEditorViewportController } from './LayerEditorViewport'
import { defaultWholeLayerFilter, isNeutralWholeLayerFilter, wholeLayerFilterDefinitions, type ImageLayerWholeFilter, type ImageLayerWholeFilterOperation, type WholeLayerFilterType } from './layer-whole-filter'
import { buildLayerFilterOperation, buildLayerFilterPreview } from './layer-filter-editor-state'
import { layerRasterPreviewSize } from './layer-paint-state'
import './layer-filter-editor.css'

interface FilterDraft { filter: ImageLayerWholeFilter; operation: ImageLayerWholeFilterOperation | null; error: string }
function prepareDraft(recipe: ImageLayerRecipe, layerIndex: number, filter: ImageLayerWholeFilter): FilterDraft {
  try { return { filter, operation: buildLayerFilterOperation(recipe, layerIndex, filter), error: '' } }
  catch (cause) { return { filter, operation: null, error: cause instanceof Error ? cause.message : '当前图层无法预览滤镜' } }
}

function FilterParameter({ parameter, value, onChange, onPending }: { parameter: (typeof wholeLayerFilterDefinitions)[number]['parameters'][number]; value: number; onChange(value: number): void; onPending(value: boolean): void }) {
  const [text, setText] = useState(String(value)), [error, setError] = useState('')
  useEffect(() => { setText(String(value)); setError('') }, [value, parameter.key])
  function commit(value: number) {
    if (!Number.isFinite(value)) { setError('请输入有效数值'); onPending(true); return }
    const next = Number(Math.max(parameter.min, Math.min(parameter.max, Math.round(value / parameter.step) * parameter.step)).toFixed(6))
    setText(String(next)); setError(''); onPending(false); onChange(next)
  }
  function commitText() { if (!text.trim()) { setError('请输入有效数值'); onPending(true); return }; commit(Number(text)) }
  function editText(value: string) { setText(value); setError(''); onPending(true) }
  function discardText() { setText(String(value)); setError(''); onPending(false) }
  return <div className="layer-filter-parameter"><label><span>{parameter.label}<small>{parameter.unit || ''}</small></span><input type="range" aria-label={`${parameter.label}滑杆`} min={parameter.min} max={parameter.max} step={parameter.step} value={value} onChange={(event) => commit(event.currentTarget.valueAsNumber)} /></label><input type="number" aria-label={parameter.label} min={parameter.min} max={parameter.max} step={parameter.step} value={text} onChange={(event) => editText(event.currentTarget.value)} onBlur={commitText} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commitText() } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); discardText() } }} />{error && <small role="alert">{error}</small>}</div>
}

export function LayerFilterEditor({ recipe, layerIndex, images, hasSelection = false, onApply, onClose }: { recipe: ImageLayerRecipe; layerIndex: number; images: readonly LayerToolImage[]; hasSelection?: boolean; onApply(operation: ImageLayerWholeFilterOperation): void; onClose(): void }) {
  const layer = recipe.layers[layerIndex]
  const [draft, setDraft] = useState(() => prepareDraft(recipe, layerIndex, defaultWholeLayerFilter('gaussian'))), draftRef = useRef(draft)
  const [shownOperation, setShownOperation] = useState(draft.operation), shownRef = useRef(shownOperation); shownRef.current = shownOperation
  const [before, setBefore] = useState(false), beforeRef = useRef(before); beforeRef.current = before
  const [documentOutline, setDocumentOutline] = useState(true)
  const [inputPending, setInputPending] = useState(false), inputPendingRef = useRef(false), pendingParameters = useRef(new Set<string>()), [parameterRevision, setParameterRevision] = useState(0)
  const readyOperation = useRef<ImageLayerWholeFilterOperation | null>(null), [busy, setBusy] = useState(Boolean(draft.operation)), [previewError, setPreviewError] = useState(''), [error, setError] = useState(''), [revision, setRevision] = useState(0)
  const alive = useRef(true), completed = useRef(false), panel = useRef<HTMLElement>(null), viewport = useRef<LayerEditorViewportController>(null), [hand, setHand] = useState(false)
  const scope = JSON.stringify([layerIndex, images.map((image) => [image.key, image.asset.assetId, image.asset.localUrl])]), initial = useRef({ recipe, scope }), current = useRef({ recipe, scope }); current.current = { recipe, scope }
  const definition = wholeLayerFilterDefinitions.find((entry) => entry.type === draft.filter.type)!
  const presentation = useMemo(() => buildLayerFilterPreview(recipe, layerIndex, shownOperation), [recipe, layerIndex, shownOperation])
  const previewRecipe = presentation.recipe, frame = presentation.frame, sampling = frame && layerRasterPreviewSize(frame.width, frame.height, 2)
  const previewToken = useMemo(() => ({ recipe: previewRecipe, operation: shownOperation, revision, before }), [previewRecipe, shownOperation, revision, before]), latestPreview = useRef(previewToken); latestPreview.current = previewToken
  function active() { return alive.current && !completed.current && initial.current.recipe === current.current.recipe && initial.current.scope === current.current.scope }
  function change(filter: ImageLayerWholeFilter) {
    if (!active()) return
    const next = prepareDraft(recipe, layerIndex, filter)
    draftRef.current = next; readyOperation.current = null; setDraft(next); setError(''); setPreviewError(''); setBusy(Boolean(next.operation)); beforeRef.current = false; setBefore(false)
  }
  function setParameterPending(key: string, value: boolean) {
    if (!active()) return
    if (value) pendingParameters.current.add(key)
    else pendingParameters.current.delete(key)
    inputPendingRef.current = pendingParameters.current.size > 0; setInputPending(inputPendingRef.current)
  }
  function select(type: WholeLayerFilterType) {
    if (!active()) return
    pendingParameters.current.clear(); inputPendingRef.current = false; setInputPending(false); setParameterRevision((value) => value + 1)
    change(defaultWholeLayerFilter(type))
  }
  function patch(key: string, value: number) { change({ ...draftRef.current.filter, parameters: { ...draftRef.current.filter.parameters, [key]: value } }) }
  function compare(value: boolean) { if (!active() || value === beforeRef.current) return; beforeRef.current = value; setBefore(value); readyOperation.current = null; setPreviewError(''); setBusy(!value && Boolean(draftRef.current.operation)) }
  function receiveStatus(status: LayerPreviewRasterStatus, token: typeof previewToken) {
    const operation = token.operation
    if (!active() || token !== latestPreview.current || token.before || beforeRef.current || !operation || operation !== draftRef.current.operation || operation !== shownRef.current) return
    readyOperation.current = !status.busy && !status.error ? operation : null
    setBusy(status.busy); setPreviewError(status.error)
  }
  const onPreviewStatus = useMemo(() => (status: LayerPreviewRasterStatus) => receiveStatus(status, previewToken), [previewToken])
  function retry() { if (!active()) return; latestPreview.current = { ...latestPreview.current }; readyOperation.current = null; setPreviewError(''); setBusy(Boolean(draftRef.current.operation)); setRevision((value) => value + 1) }
  function close() { if (!active()) return; completed.current = true; readyOperation.current = null; onClose() }
  function apply() {
    if (!active()) return
    const candidate = draftRef.current
    try {
      if (inputPendingRef.current) throw new Error('请先完成或修正参数输入')
      if (candidate.error || !candidate.operation) throw new Error(candidate.error || '滤镜参数无效')
      if (isNeutralWholeLayerFilter(candidate.filter)) { completed.current = true; onClose(); return }
      if (beforeRef.current || readyOperation.current !== candidate.operation) throw new Error('请等待最新滤镜效果预览成功后再应用')
      completed.current = true; onApply(candidate.operation); onClose()
    } catch (cause) { completed.current = false; setError(cause instanceof Error ? cause.message : '滤镜未应用，草稿已保留') }
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length)
    if (event.shiftKey && (document.activeElement === controls[0] || document.activeElement === panel.current)) { event.preventDefault(); controls.at(-1)?.focus() }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
  }
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.focus()
    return () => { alive.current = false; readyOperation.current = null; if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { const timer = setTimeout(() => { if (active()) setShownOperation(draft.operation) }, 120); return () => clearTimeout(timer) }, [draft.operation])
  const neutral = isNeutralWholeLayerFilter(draft.filter), canApply = !inputPending && !draft.error && !!draft.operation && (neutral || !presentation.error && !before && !busy && !previewError && readyOperation.current === draft.operation)
  return createPortal(<div className="layer-filter-backdrop nodrag nopan nowheel" onPointerDown={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}><section ref={panel} tabIndex={-1} className="layer-filter-editor" role="dialog" aria-modal="true" aria-label="图层滤镜工作台" onKeyDown={keyboard}>
    <header><div><span>图层工作区 · 本地像素处理</span><h2><SlidersHorizontal size={20} />图层滤镜</h2><small>{layer.name || `图层 ${layerIndex + 1}`}{draft.operation && ` · ${draft.operation.space.width} × ${draft.operation.space.height} 图层像素`} · 不调用模型</small></div><button type="button" aria-label="关闭图层滤镜" onClick={close}><X size={19} /></button></header>
    <div className="layer-filter-layout"><section className="layer-filter-preview" aria-label="当前图层滤镜预览"><div className="layer-filter-preview-tools"><div role="group" aria-label="本次滤镜前后对照"><button type="button" aria-pressed={before} onClick={() => compare(true)}><Eye size={14} />本次滤镜前</button><button type="button" aria-pressed={!before} onClick={() => compare(false)}>滤镜效果</button></div><div><button type="button" aria-pressed={documentOutline} onClick={() => setDocumentOutline((value) => !value)}><Scan size={14} />文档范围</button><button type="button" aria-pressed={hand} onClick={() => viewport.current?.toggleHand()}><Hand size={14} />平移</button></div></div>
      <div className="layer-filter-presentation-caption"><strong>图层原始视图</strong><span>{frame ? `${frame.width} × ${frame.height} 图层 · ${recipe.outputWidth} × ${recipe.outputHeight} 文档` : '完整图层预览不可用'}</span></div>
      {frame ? <LayerEditorViewport width={frame.width} height={frame.height} sourcesKey={scope} controllerRef={viewport} onInterrupt={() => {}} onScaleChange={() => {}} onHandChange={setHand}><div className="layer-editor-stage"><LayerFilterPreview recipe={recipe} afterRecipe={previewRecipe} layerIndex={layerIndex} images={images} frame={frame} before={before} documentOutline={documentOutline} revision={revision} onRasterStatus={onPreviewStatus} /></div></LayerEditorViewport> : <div className="layer-filter-presentation-error" role="alert">{presentation.error}</div>}
      <p>{sampling && `预览采样 ${sampling.width} × ${sampling.height}；100% 表示图层原始像素比例，放大不会增加采样细节。`} 单层效果预览，不叠加图层透明度与混合模式。图像调整与颜色效果在滤镜之后叠加。</p>
    </section><aside className="layer-filter-controls" aria-label="整层滤镜参数"><label className="layer-filter-type">滤镜类型<select aria-label="滤镜类型" value={draft.filter.type} onChange={(event) => select(event.currentTarget.value as WholeLayerFilterType)}>{wholeLayerFilterDefinitions.map((entry) => <option key={entry.type} value={entry.type}>{entry.label}</option>)}</select></label><h3>{definition.label}</h3><p>{definition.description}</p><div className="layer-filter-fields">{definition.parameters.length ? definition.parameters.map((parameter) => <FilterParameter key={`${draft.filter.type}:${parameterRevision}:${parameter.key}`} parameter={parameter} value={draft.filter.parameters[parameter.key]} onChange={(value) => patch(parameter.key, value)} onPending={(value) => setParameterPending(parameter.key, value)} />) : <p>此滤镜没有额外参数，预览成功后可应用。</p>}</div><div className="layer-filter-scope"><strong>处理范围：当前图层整体</strong><p>{hasSelection ? '画布选区保留；本次整层滤镜不受该选框限制。' : '仅影响当前图层，已有笔迹与滤镜按保存顺序处理。'}</p></div><button type="button" onClick={() => select(draft.filter.type)}><RotateCcw size={14} />重置当前滤镜参数</button></aside></div>
    <footer><div role={draft.error || presentation.error || previewError || error ? 'alert' : 'status'}>{draft.error || presentation.error || previewError || error || (neutral ? '当前参数不产生效果，完成后不会新增历史。' : before ? '正在对照本次滤镜前；切回滤镜效果后可应用。' : busy ? '正在计算最新滤镜预览…' : '预览已就绪，应用后可一次撤销。')}{previewError && <button type="button" onClick={retry}>重新预览</button>}</div><div><button type="button" onClick={close}>取消</button><button type="button" className="is-primary" disabled={!canApply} onClick={apply}><Check size={15} />{neutral ? '完成（未改图层）' : '应用滤镜'}</button></div></footer>
  </section></div>, document.body)
}
