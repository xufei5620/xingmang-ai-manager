import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, ArrowDown, ArrowLeftRight, ArrowUp, Blend, Brush, Circle, Copy, Crop, Eraser, Eye, EyeOff, FlipHorizontal2, FlipVertical2, FolderMinus, FolderOpen, FolderPlus, Hand, ImagePlus, Layers3, LockKeyhole, MousePointer2, PaintBucket, PenTool, Pipette, Plus, Redo2, Scan, Square, Trash2, Type, Undo2, UnlockKeyhole, WandSparkles } from 'lucide-react'
import { SafeImage } from '../components/MediaPreview'
import { hostBridge, type CanvasImageAssetSummary } from '../host'
import { maximumImageTransformInputs, maximumImageLayerPathPoints, parseImageTransformRecipe, type ImageLayer, type ImageLayerAdjustments, type ImageLayerRecipe, type ImageLayerBrushStroke, type ImageLayerGradient } from './recipe'
import { addEditorLayer, alignEditorLayer, applyEditorDocumentCrop, beginLayerEditorTransaction, createLayerEditorState, finishLayerEditorTransaction, moveEditorLayer, patchEditorLayer, patchEditorRecipe, redoLayerEditor, resizeEditorLayer, selectEditorLayer, selectedEditorLayerIds, selectedEditorLayerNodeIds, patchEditorLayers, deleteEditorLayers, duplicateEditorLayers, reorderEditorLayers, moveEditorLayers, moveSelectedEditorLayers, undoLayerEditor, editorLayerTreeRows, editorLayerEffectiveState, selectedEditorGroup, selectEditorGroup, groupEditorLayers, ungroupEditorGroup, patchEditorGroup, moveEditorGroup, duplicateEditorGroup, deleteEditorGroup, reorderEditorGroup, moveEditorLayerNodes, nextEditorLayerIdentity, type EditorLayerTreeRow, type LayerEditorState, type LayerEditorSnapshot, type LayerEditorTool, type LayerResizeHandle } from './layer-editor-state'
import { LayerRecipePreview, LayerCanvasSelectionOverlay, layerPreviewTransform, type LayerToolImage, type LayerPreviewSampler } from './layerpreview'
import { addEditorPathLayer, adjustCanvasSelection, appendEditorLayerFill, appendEditorLayerOperation, appendEditorLayerOutline, appendEditorPaintStroke, buildCanvasSelection, createLayerGradient, createLayerFilterStroke, createLayerPaintStroke, isCurrentLayerColorSample, isLayerGesturePointer, layerPaintTargetError, layerSelectionSnapshot, outputPointToLayerPoint, remainingLayerPaintBudget, shouldAppendPaintPoint, type LayerCanvasPoint, type LayerCanvasSelection, type LayerCanvasTool, type LayerColorSampleRequest, type LayerPaintSettings } from './layer-paint-state'
import { canvasRasterSelectionCount, combineCanvasSelections, isCurrentLayerPixelRequest, layerSelectionCombination, rasterizeCanvasSelection, resizeCanvasRasterSelection, type LayerPixelRequest, type LayerSelectionCombination } from './layer-canvas-selection'
import { selectLayerRasterColors } from './layer-raster-selection'
import { updateEditorCanvasSelection } from './layer-selection-history'
import { runLayerGrabCutSelection } from './layer-grabcut-client'
import { appendLayerQuickPoint, appendLayerQuickStroke, clampLayerQuickPoint, layerQuickPixelsCurrent, layerQuickRegion, layerQuickSessionCurrent, type LayerQuickPixels, type LayerQuickSampleSource, type LayerQuickSelectionGuide, type LayerQuickSelectionMode, type LayerQuickSelectionSession } from './layer-quick-selection-state'
import { appendLayerPenAnchor, dragLayerPenHandles, hasLayerGradientDistance, isCurrentLayerVectorScope, layerPenGuidePath, type LayerPenAnchor, type LayerVectorScope } from './layer-vector-gesture'
import { buildLayerEditorPsdExport } from './layer-editor-export'
import { LayerPsdImportDialog } from './LayerPsdImportDialog'
import { appendEditorImportedLayers, type LayerPsdApplyInput } from './layer-psd-apply'
import type { BrowserLayerPsdDocument } from '../library/browser-layer-psd-import'
import { assertLayerFilterSize } from './layer-filter-raster'
import { LayerTextControls } from './LayerTextControls'
import { LayerColorGradeEditor } from './LayerColorGradeEditor'
import { isNeutralImageLayerColorGrade, parseImageLayerColorGrade, type ImageLayerColorGrade } from './layer-color-grade'
import { LayerFilterEditor } from './LayerFilterEditor'
import { isNeutralWholeLayerFilter, layerWholeFilterSpace, parseImageLayerWholeFilterOperation, type ImageLayerWholeFilterOperation } from './layer-whole-filter'
import { LayerLiquifyEditor } from './LayerLiquifyEditor'
import { parseImageLayerLiquifyOperation, type ImageLayerLiquifyOperation } from './layer-liquify'
import { layerLiquifySpace } from './layer-liquify-editor-state'
import { LayerEditorViewport, type LayerEditorViewportController } from './LayerEditorViewport'
import { LayerDocumentCropOverlay, type LayerDocumentCropDrag } from './LayerDocumentCropOverlay'
import { buildLayerDocumentCrop, moveLayerDocumentCrop, normalizeLayerDocumentCrop, resizeLayerDocumentCrop, type LayerDocumentCropRect } from './layer-document-crop'
import { buildLayerDocumentCropRatio, fitLayerDocumentCropRatio, resizeLayerDocumentCropRatio, type LayerDocumentCropRatio } from './layer-document-crop-ratio'
import { imageLayerGeometryBounds } from './layer-document-geometry'
import { buildEditorLayerMergePlan, buildEditorLayerMergeCandidate, isCurrentEditorLayerMergePlan, commitEditorLayerMerge, type EditorLayerMergePlan } from './layer-editor-merge'
import { LayerMergeConfirmation } from './LayerMergeConfirmation'
import { LayerGroupNameField, LayerTree, layerTreeSelectionBounds, type LayerTreeMovePosition } from './LayerTree'
import type { BrowserEditorLayerMergeReview } from '../library/browser-layer-merge-review'
import { maximumImageLayerGroups } from './layer-group-model'
import './layer-editor.css'

export { LayerRecipePreview }
export type { LayerToolImage }

const defaultAdjustments: ImageLayerAdjustments = { brightness: 1, contrast: 1, saturation: 1, blur: 0, grayscale: 0 }

interface PaintGesture {
  pointerId: number
  id: string
  layer: ImageLayer
  recipe: ImageLayerRecipe
  stroke: ImageLayerBrushStroke
  sourcesKey: string
  maxPoints: number
}

interface QuickSelectionGesture extends LayerQuickSelectionGuide {
  pointerId: number
  request: LayerPixelRequest
  source: LayerQuickSampleSource
  sampler: LayerPreviewSampler
  session?: LayerQuickSelectionSession
  combination: LayerSelectionCombination
}

interface SelectionGesture { pointerId: number; start: LayerCanvasPoint; kind: 'rectangle' | 'ellipse'; previous: LayerCanvasSelection | null; combination: LayerSelectionCombination }
interface GradientGesture extends LayerVectorScope { pointerId: number; id: string; layer: ImageLayer; from: LayerCanvasPoint; to: LayerCanvasPoint; settings: { startColor: string; endColor: string; opacity: number } }
interface PenDraft extends LayerVectorScope { points: LayerPenAnchor[] }
interface PenGesture { pointerId: number; index: number; anchor: LayerPenAnchor }

interface Gesture {
  pointerId: number
  id: string
  layer: ImageLayer
  handle?: LayerResizeHandle
  x: number
  y: number
  width: number
  height: number
  output: Pick<ImageLayerRecipe, 'outputWidth' | 'outputHeight' | 'documentFrame'>
  snapshot?: LayerEditorState
  selectedIds?: string[]
  groupId?: string
}

interface LayerMergeSession { plan: EditorLayerMergePlan; snapshot: LayerEditorSnapshot; sourcesKey: string; sourceOffset: number; names: string[]; groupNames: string[]; controller: AbortController; started: boolean; context: object; fontRevision: number; replacementId: string; placement: 'upper' | 'lower'; review?: BrowserEditorLayerMergeReview; reviewError: string; accepted: boolean; phase: 'reviewing' | 'ready' | 'failed' | 'uploading' }

interface RangePreviewKey { recipe: ImageLayerRecipe; selectedId: string | null; sourcesKey: string; selection: LayerCanvasSelection | null; color: string; tolerance: number; source: 'current' | 'composite'; combination: LayerSelectionCombination }
interface ColorGradeSession { id: string; index: number; layer: ImageLayer; recipe: ImageLayerRecipe; sourcesKey: string }
interface DocumentCropSession { recipe: ImageLayerRecipe; sourcesKey: string; rect: LayerDocumentCropRect | null }
interface DocumentCropGesture { pointerId: number; target: SVGGElement; mode: LayerDocumentCropDrag; start: LayerCanvasPoint; before: LayerDocumentCropRect | null; session: DocumentCropSession; ratio: LayerDocumentCropRatio | null }
interface WholeFilterSession { id: string; index: number; layer: ImageLayer; recipe: ImageLayerRecipe; sourcesKey: string; hasSelection: boolean }
interface LiquifySession { id: string; index: number; layer: ImageLayer; recipe: ImageLayerRecipe; sourcesKey: string }

function layerName(layer: ImageLayer, images: readonly LayerToolImage[], index: number): string {
  return layer.name || (layer.content?.kind === 'text' ? layer.content.text.slice(0, 32) || '文字图层' : layer.content?.kind === 'shape' ? layer.content.shape === 'ellipse' ? '椭圆' : '矩形' : layer.content?.kind === 'path' ? '钢笔图层' : layer.content?.kind === 'paint' ? '绘画图层' : images[layer.sourceIndex]?.label) || `图层 ${index + 1}`
}

function ToolButton({ label, children, disabled, pressed, onClick }: { label: string; children: ReactNode; disabled?: boolean; pressed?: boolean; onClick(): void }) {
  return <button type="button" aria-label={label} title={label} disabled={disabled} aria-pressed={pressed} onClick={onClick}>{children}</button>
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void }) {
  return <label>{label}<input type="number" aria-label={label} value={Number(value.toFixed(3))} min={min} max={max} step={step} onChange={(event) => {
    const value = event.currentTarget.valueAsNumber
    if (Number.isFinite(value)) onChange(Math.max(min, Math.min(max, step === 1 ? Math.round(value) : value)))
  }} /></label>
}

export function parseLayerEditorColorDraft(draft: string, allowTransparent = false): string | null {
  const value = draft.trim().toLowerCase()
  return /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/.test(value) || (allowTransparent && value === 'transparent') ? value : null
}

export function layerEditorPickerColor(rgb: string, previous: string): string | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(rgb)) return null
  // A native color picker controls RGB only; retain an explicitly entered alpha.
  return `${rgb.toLowerCase()}${/^#[0-9a-fA-F]{8}$/.test(previous) ? previous.slice(7).toLowerCase() : ''}`
}

function ColorField({ label, value, transparent, onChange }: { label: string; value: string; transparent?: boolean; onChange(value: string): void }) {
  const id = useId(), [draft, setDraft] = useState(value), [error, setError] = useState('')
  useEffect(() => { setDraft(value); setError('') }, [value])
  function commit() {
    const color = parseLayerEditorColorDraft(draft, transparent)
    if (!color) { setDraft(value); setError('请输入 #RRGGBB 或 #RRGGBBAA，已保留原颜色'); return }
    setDraft(color); setError(''); if (color !== value) onChange(color)
  }
  function pick(rgb: string) {
    const color = layerEditorPickerColor(rgb, value)
    if (color) { setDraft(color); setError(''); if (color !== value) onChange(color) }
  }
  return <div className="layer-editor-color"><div className="layer-editor-color-field"><label htmlFor={id}>{label}</label><div><input aria-label={`${label}色板`} type="color" value={value === 'transparent' ? '#ffffff' : value.slice(0, 7)} onInput={(event) => pick(event.currentTarget.value)} onChange={(event) => pick(event.target.value)} /><input id={id} className="layer-editor-hex" type="text" aria-label={`${label} HEX`} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} value={draft} placeholder="#RRGGBB / #RRGGBBAA" maxLength={24} spellCheck={false} autoComplete="off" onChange={(event) => { setDraft(event.target.value); setError('') }} onBlur={commit} onKeyDown={(event) => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); commit() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDraft(value); setError('') }
  }} /></div></div>{transparent && <button type="button" className={value === 'transparent' ? 'is-active' : ''} onClick={() => onChange(value === 'transparent' ? '#ffffff' : 'transparent')}>透明</button>}{error && <p id={`${id}-error`} className="layer-editor-color-error" role="alert">{error}</p>}</div>
}

export function LayerEditor({ initial, images: baseImages, onApply, onApplyWithImports, onClose, allowDownload = true }: { initial: ImageLayerRecipe; images: readonly LayerToolImage[]; onApply(recipe: ImageLayerRecipe): void; onApplyWithImports?(input: LayerPsdApplyInput): void; onClose(): void; /** False when the host blocks page downloads. */ allowDownload?: boolean }) {
  const [importedAssets, setImportedAssets] = useState<CanvasImageAssetSummary[]>([])
  const importedAssetsRef = useRef(importedAssets)
  importedAssetsRef.current = importedAssets
  const images: readonly LayerToolImage[] = [...baseImages, ...importedAssets.map((asset, index): LayerToolImage => ({ key: `psd-${index}-${asset.assetId}`, label: asset.displayName || asset.fileName, asset: { kind: 'image', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, width: asset.width, height: asset.height }, dimensions: { width: asset.width ?? 1, height: asset.height ?? 1 }, dimensionsReady: true, onLoad() {} }))]
  const initialImportRecipe = useRef(structuredClone(initial))
  const initialImportSourceIds = useRef(baseImages.map((image) => image.asset.assetId ?? ''))
  const [psdImportOpen, setPsdImportOpen] = useState(false)
  const [mergeSession, setMergeSession] = useState<LayerMergeSession | null>(null), mergeSessionRef = useRef<LayerMergeSession | null>(null)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [mergeAccepted, setMergeAccepted] = useState(false)
  const mergeTrigger = useRef<HTMLButtonElement>(null)
  const [colorGradeSession, setColorGradeSession] = useState<ColorGradeSession | null>(null), colorGradeSessionRef = useRef<ColorGradeSession | null>(null)
  const [liquifySession, setLiquifySession] = useState<LiquifySession | null>(null), liquifySessionRef = useRef<LiquifySession | null>(null)
  const [wholeFilterSession, setWholeFilterSession] = useState<WholeFilterSession | null>(null), wholeFilterSessionRef = useRef<WholeFilterSession | null>(null)
  const importAlive = useRef(true)
  const importAvailable = Boolean(onApplyWithImports) && typeof window !== 'undefined' && Boolean(window.xingmangCanvasHost?.importLayerPsd)
  const [state, setReactState] = useState(() => createLayerEditorState(initial, images.length))
  const [error, setError] = useState('')
  const [localFontRevision, setLocalFontRevision] = useState(0)
  const [status, setStatus] = useState('')
  const [picking, setPicking] = useState(false)
  const [exporting, setExporting] = useState(false)
  const exportRequest = useRef<LayerColorSampleRequest | null>(null)
  const exportAvailable = typeof window !== 'undefined' && !!window.xingmangCanvasHost?.exportLayerPsd
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set())
  const [toolMenu, setToolMenu] = useState<'selection' | 'filter' | 'fill' | 'new-layer' | null>(null)
  const [selectionAdjust, setSelectionAdjust] = useState(false)
  const [featherRadius, setFeatherRadius] = useState(5)
  const [selectionDistance, setSelectionDistance] = useState(5)
  const [tolerance, setTolerance] = useState(32)
  const [sampleSource, setSampleSource] = useState<'current' | 'composite'>('composite')
  const [quickMode, setQuickMode] = useState<LayerQuickSelectionMode>('region')
  const [quickDiameter, setQuickDiameter] = useState(24)
  const [quickSource, setQuickSource] = useState<LayerQuickSampleSource>('composite')
  const quickSourceRef = useRef(quickSource)
  quickSourceRef.current = quickSource
  const quickPixels = useRef<LayerQuickPixels | null>(null)
  const quickSessions = useRef(new WeakMap<LayerCanvasSelection, LayerQuickSelectionSession>())
  const quickGesture = useRef<QuickSelectionGesture | null>(null)
  const [quickGuide, setQuickGuide] = useState<LayerQuickSelectionGuide | null>(null)
  const [allSameColor, setAllSameColor] = useState(false)
  const [combination, setCombination] = useState<LayerSelectionCombination>('replace')
  const [sampledColor, setSampledColor] = useState<string | null>(null)
  const [rangeColor, setRangeColor] = useState('#000000')
  const [rangePreview, setRangePreview] = useState<LayerCanvasSelection | null>(null)
  const rangePreviewKey = useRef<RangePreviewKey | null>(null)
  const [outline, setOutline] = useState<{ width: number; position: 'inside' | 'center' | 'outside'; color: string; opacity: number }>({ width: 2, position: 'center', color: '#000000', opacity: 1 })
  const toolMenuTrigger = useRef<HTMLButtonElement | null>(null), selectionAdjustTrigger = useRef<HTMLButtonElement | null>(null)
  const toolPopover = useRef<HTMLDivElement | null>(null), selectionPopover = useRef<HTMLDivElement | null>(null)
  const sampler = useRef<LayerPreviewSampler | null>(null)
  const sampling = useRef<LayerColorSampleRequest | null>(null)
  const sourcesKey = JSON.stringify(images.map((image) => [image.key, image.asset.assetId, image.asset.localUrl]))
  const sourcesKeyRef = useRef(sourcesKey)
  sourcesKeyRef.current = sourcesKey
  const initialApplySnapshot = useRef({ recipe: state.present.recipe, sourcesKey })
  const [cropSession, setCropSession] = useState<DocumentCropSession | null>(null), cropSessionRef = useRef<DocumentCropSession | null>(null), cropGesture = useRef<DocumentCropGesture | null>(null)
  const [cropRatio, setCropRatio] = useState<LayerDocumentCropRatio | null>(null), cropRatioRef = useRef<LayerDocumentCropRatio | null>(null)
  const [sourceIndex, setSourceIndex] = useState(0)
  const [tool, setTool] = useState<LayerCanvasTool>('move')
  const [filterSettings, setFilterSettings] = useState({ size: 30, strength: 1 })
  const [filterMode, setFilterMode] = useState<'blur' | 'sharpen'>('blur')
  const [paintSettings, setPaintSettings] = useState<LayerPaintSettings>({ size: 32, hardness: 1, opacity: 1, color: '#a6ddc4' })
  const [backgroundColor, setBackgroundColor] = useState('#ffffff')
  const [penStyle, setPenStyle] = useState({ fill: '#a6ddc4', stroke: '#000000', strokeWidth: 2 })
  const [penAnchors, setPenAnchors] = useState<LayerPenAnchor[]>([])
  const [gradientGuide, setGradientGuide] = useState<{ from: LayerCanvasPoint; to: LayerCanvasPoint } | null>(null)
  const gradientGesture = useRef<GradientGesture | null>(null), penDraft = useRef<PenDraft | null>(null)
  const penGesture = useRef<PenGesture | null>(null)
  const selection = state.present.canvasSelection ?? null
  const selectionRef = useRef(selection), toolRef = useRef(tool)
  selectionRef.current = selection; toolRef.current = tool
  const [transient, setTransient] = useState<{ id: string; stroke: ImageLayerBrushStroke | ImageLayerGradient } | null>(null)
  const paintGesture = useRef<PaintGesture | null>(null)
  const selectionGesture = useRef<SelectionGesture | null>(null)
  const paintFrame = useRef<number | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const viewportController = useRef<LayerEditorViewportController>(null)
  const [viewportScale, setViewportScale] = useState(1), [viewportHand, setViewportHand] = useState(false)
  const svg = useRef<SVGSVGElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const stateRef = useRef(state)
  stateRef.current = state
  const { recipe, ids, selectedId } = state.present
  const index = selectedId ? ids.indexOf(selectedId) : -1, selected = recipe.layers[index]
  const treeRows = editorLayerTreeRows(state.present), selectedGroup = selectedEditorGroup(state.present)
  const groupRow = selectedGroup ? treeRows.find((row) => row.id === selectedGroup.id) : undefined
  const selectedEffective = selectedId ? editorLayerEffectiveState(state.present, selectedId) : null
  const selectedLocked = selectedEffective?.locked ?? false, selectedVisible = selectedEffective?.visible ?? false
  const selectedIds = selectedEditorLayerIds(state.present), selectedSet = new Set(selectedIds)
  const selectedLayers = recipe.layers.filter((_, index) => selectedSet.has(ids[index]))
  const selectedNodeStates = selectedEditorLayerNodeIds(state.present).map((id) => editorLayerEffectiveState(state.present, id))
  const selectionLocked = selectedIds.some((id) => editorLayerEffectiveState(state.present, id).locked), selectionAllLocked = selectedNodeStates.length > 0 && selectedNodeStates.every((item) => item.ownLocked)
  const selectionAllVisible = selectedNodeStates.length > 0 && selectedNodeStates.every((item) => item.ownVisible)
  const groupLayers = recipe.layers.filter((_, index) => groupRow?.leafIds.includes(ids[index]))
  const groupBounds = selectedGroup ? layerTreeSelectionBounds(recipe, (groupRow?.leafIds ?? []).map((id) => ids.indexOf(id))) : null
  const groupAncestorLocked = Boolean(groupRow?.parentId && treeRows.find((row) => row.id === groupRow.parentId)?.locked)
  const groupLocked = (groupRow?.leafIds ?? []).some((id) => editorLayerEffectiveState(state.present, id).locked)
  const mergeReason = layerMergeDisabledReason()
  const full = recipe.layers.length >= maximumImageTransformInputs
  const selectedWidth = selected ? selected.width * recipe.outputWidth : 0, selectedHeight = selected ? selected.height * recipe.outputHeight : 0
  const geometryX = imageLayerGeometryBounds(recipe.outputWidth, recipe.documentFrame?.offsetX), geometryY = imageLayerGeometryBounds(recipe.outputHeight, recipe.documentFrame?.offsetY)
  const handleRadius = 8 / Math.max(.0001, viewportScale)
  const pixelTool = tool === 'select-wand' || tool === 'select-color-range' || tool === 'bucket'
  const rememberedQuickSession = selection ? quickSessions.current.get(selection) : undefined
  const activeQuickSession = layerQuickSessionCurrent(rememberedQuickSession, quickPixels.current, state.present, sourcesKey, quickSource) ? rememberedQuickSession : undefined
  const previewKey = rangePreviewKey.current
  const rangePreviewCurrent = Boolean(rangePreview && previewKey && previewKey.recipe === recipe && previewKey.selectedId === selectedId && previewKey.sourcesKey === sourcesKey && previewKey.selection === selection && previewKey.color === rangeColor && previewKey.tolerance === tolerance && previewKey.source === sampleSource && previewKey.combination === combination)
  const displayedSelection = tool === 'select-color-range' && rangePreviewCurrent ? rangePreview : selection

  // Event handlers and async jobs share the same committed snapshot even before React renders.
  function setState(next: LayerEditorState | ((current: LayerEditorState) => LayerEditorState)) {
    const updated = typeof next === 'function' ? next(stateRef.current) : next
    stateRef.current = updated
    selectionRef.current = updated.present.canvasSelection ?? null
    setReactState(updated)
  }

  function setSelection(next: LayerCanvasSelection | null | ((value: LayerCanvasSelection | null) => LayerCanvasSelection | null), remember = false, recordEqual = false) {
    const value = typeof next === 'function' ? next(selectionRef.current) : next
    const updated = updateEditorCanvasSelection(stateRef.current, value, remember, recordEqual)
    selectionRef.current = updated.present.canvasSelection ?? null
    stateRef.current = updated; setState(updated)
  }
  function changeSelection(next: LayerCanvasSelection | null | ((value: LayerCanvasSelection | null) => LayerCanvasSelection | null)) { cancelSampling(); cancelExport(); cancelVectorTools(); setSelection(next, true); setError(''); setStatus('') }

  function change(action: (current: LayerEditorState) => LayerEditorState) { closeLayerMerge(); cancelSampling(); cancelExport(); cancelVectorTools(); const next = action(stateRef.current); stateRef.current = next; selectionRef.current = next.present.canvasSelection ?? null; setState(next); setError(''); setStatus('') }
  function patch(patch: Partial<ImageLayer>) { if (selectedId) change((current) => patchEditorLayer(current, selectedId, patch)) }
  function begin() { cancelExport(); setState(beginLayerEditorTransaction) }
  function finish(cancel = false) { gesture.current = null; setState((current) => finishLayerEditorTransaction(current, cancel)) }
  function history(redo = false) { cancelPaint(); cancelSelection(); gesture.current = null; change(redo ? redoLayerEditor : undoLayerEditor) }
  function add(tool: LayerEditorTool) { setToolMenu(null); setSelectionAdjust(false); cancelPaint(); cancelSelection(); setTool(tool === 'paint' ? 'brush' : 'move'); change((current) => addEditorLayer(finishLayerEditorTransaction(current), tool, Math.min(sourceIndex, Math.max(0, images.length - 1)))); stage.current?.focus() }
  function adjust(key: keyof ImageLayerAdjustments, value: number) { patch({ adjustments: { ...defaultAdjustments, ...selected?.adjustments, [key]: value } }) }


  function selectLayer(id: string | null, modifiers: { toggle?: boolean; range?: boolean } = {}) {
    cancelGesture()
    change((current) => selectEditorLayer(finishLayerEditorTransaction(current), id, modifiers))
  }

  function selectTreeRow(row: EditorLayerTreeRow, modifiers: { toggle?: boolean; range?: boolean }) {
    if (row.kind === 'layer') { selectLayer(row.id, modifiers); return }
    cancelGesture()
    try { change((current) => selectEditorGroup(finishLayerEditorTransaction(current), row.id, modifiers)); setTool('move') }
    catch (cause) { setError(cause instanceof Error ? cause.message : '编组已变化，请重新选择') }
  }

  function toggleGroupCollapse(id: string) {
    setCollapsedGroups((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  function toggleTreeRow(row: EditorLayerTreeRow, key: 'visible' | 'locked') {
    cancelGesture()
    try {
      change((current) => {
        const live = editorLayerTreeRows(current.present).find((item) => item.id === row.id && item.kind === row.kind)
        if (!live) throw new Error('图层或编组已变化，请重新选择')
        if (key === 'locked' && live.locked && !live.ownLocked) throw new Error('请先解锁上级编组')
        const patch = { [key]: !(key === 'visible' ? live.ownVisible : live.ownLocked) }
        return live.kind === 'group' ? patchEditorGroup(current, live.id, patch) : patchEditorLayer(current, live.id, patch)
      })
    } catch (cause) { setError(cause instanceof Error ? cause.message : '显示或锁定设置未应用') }
  }

  function performGroupAction(action: 'group' | 'ungroup') {
    cancelGesture()
    try {
      const current = finishLayerEditorTransaction(stateRef.current), group = selectedEditorGroup(current.present)
      if (action === 'ungroup' && !group) throw new Error('请先选择需要解散的编组')
      const next = action === 'group' ? groupEditorLayers(current) : ungroupEditorGroup(current, group!.id)
      change(() => next)
      if (next.present.selectedGroupId) setCollapsedGroups((previous) => { const expanded = new Set(previous); expanded.delete(next.present.selectedGroupId!); return expanded })
      setTool('move'); setStatus(action === 'group' ? '已创建穿透编组，图层仍可独立编辑，可一次撤销' : '已解散编组并保留子图层，可一次撤销')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '编组操作未应用，原图层保留') }
  }

  function renameGroup(id: string, name: string) {
    try { change((current) => { const group = selectedEditorGroup(current.present); return group?.id === id ? patchEditorGroup(current, id, { name }) : current }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '编组属性未应用') }
  }

  function moveGroup(dx: number, dy: number) {
    try { change((current) => { const group = selectedEditorGroup(current.present); return group ? moveEditorGroup(current, group.id, dx, dy) : current }) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '编组未移动') }
  }

  function beginTreeMove(row?: EditorLayerTreeRow): LayerEditorSnapshot | null {
    cancelGesture(); closeLayerMerge(); cancelSampling(); cancelExport(); cancelVectorTools()
    try {
      let current = finishLayerEditorTransaction(stateRef.current)
      if (row) {
        const live = editorLayerTreeRows(current.present).find((item) => item.id === row.id && item.kind === row.kind)
        if (!live) throw new Error('图层或编组已变化，请重新选择')
        const selected = new Set(selectedEditorLayerIds(current.present))
        if (!live.leafIds.every((id) => selected.has(id)) || live.kind === 'group' && selected.size === live.leafIds.length && current.present.selectedGroupId !== live.id) current = live.kind === 'group' ? selectEditorGroup(current, live.id) : selectEditorLayer(current, live.id)
      }
      const selected = selectedEditorLayerIds(current.present)
      if (!selected.length) throw new Error('请先选择要移动的图层或编组')
      if (selected.some((id) => editorLayerEffectiveState(current.present, id).locked)) throw new Error('所选图层或父组含锁定项，请先解锁后移动')
      setState(current); setError(''); setStatus(''); return current.present
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法开始移动，原图层保留'); return null }
  }

  function inspectTreeMove(snapshot: LayerEditorSnapshot, targetId: string | null, position: LayerTreeMovePosition): string {
    if (stateRef.current.present !== snapshot) return '图层或选择已变化，请重新开始移动'
    try { moveEditorLayerNodes(stateRef.current, targetId, position); return '' }
    catch (cause) { return cause instanceof Error ? cause.message : '此位置不可移动，原图层保留' }
  }

  function placeTreeSelection(snapshot: LayerEditorSnapshot, targetId: string | null, position: LayerTreeMovePosition): { ok: boolean; message: string } {
    try {
      if (stateRef.current.present !== snapshot) throw new Error('图层或选择已变化，旧移动已取消，请重新开始')
      const current = stateRef.current, next = moveEditorLayerNodes(current, targetId, position)
      const message = next === current ? '所选图层已在这个位置，没有新增修改' : '已移动所选图层，可一次撤销；显隐按目标组继承，位置与自身设置保持'
      if (next !== current) {
        change(() => next)
        const rows = editorLayerTreeRows(next.present), parents = new Set<string>()
        for (const id of selectedEditorLayerIds(next.present)) { let parent = rows.find((row) => row.id === id)?.parentId; while (parent) { parents.add(parent); parent = rows.find((row) => row.id === parent)?.parentId } }
        setCollapsedGroups((previous) => new Set([...previous].filter((id) => !parents.has(id))))
      }
      setError(''); setStatus(message); return { ok: true, message }
    } catch (cause) { const message = cause instanceof Error ? cause.message : '移动未应用，原图层保留'; setError(message); return { ok: false, message } }
  }

  function selectAllLayers() {
    cancelGesture()
    change((current) => {
      let next = selectEditorLayer(finishLayerEditorTransaction(current), null)
      for (const id of current.present.ids) next = selectEditorLayer(next, id, { toggle: true })
      return next
    })
  }

  function performLayerBatch(action: 'visible' | 'locked' | 'delete' | 'duplicate' | 'up' | 'down') {
    cancelGesture()
    try {
      const current = finishLayerEditorTransaction(stateRef.current), selected = selectedEditorLayerIds(current.present)
      if (!selected.length) return
      const nodes = selectedEditorLayerNodeIds(current.present).map((id) => editorLayerEffectiveState(current.present, id))
      const primaryGroup = selectedEditorGroup(current.present), row = primaryGroup ? editorLayerTreeRows(current.present).find((item) => item.id === primaryGroup.id) : undefined
      const group = primaryGroup && row?.leafIds.length === selected.length && row.leafIds.every((id) => selected.includes(id)) ? primaryGroup : null
      let next: LayerEditorState
      if (group) {
        if (action === 'visible') next = patchEditorGroup(current, group.id, { visible: !group.visible })
        else if (action === 'locked') next = patchEditorGroup(current, group.id, { locked: !group.locked })
        else if (action === 'delete') next = deleteEditorGroup(current, group.id)
        else if (action === 'duplicate') next = duplicateEditorGroup(current, group.id)
        else next = reorderEditorGroup(current, group.id, action === 'up' ? 1 : -1)
      } else if (action === 'visible') next = patchEditorLayers(current, selected, { visible: !nodes.every((item) => item.ownVisible) })
      else if (action === 'locked') next = patchEditorLayers(current, selected, { locked: !nodes.every((item) => item.ownLocked) })
      else if (action === 'delete') next = deleteEditorLayers(current, selected)
      else if (action === 'duplicate') next = duplicateEditorLayers(current, selected)
      else next = reorderEditorLayers(current, selected, action === 'up' ? 1 : -1)
      change(() => next)
      setStatus(next.present.recipe === current.present.recipe ? '所选图层没有变化；请检查层序边界与锁定状态' : `已${{ visible: '切换所选图层显隐', locked: '切换所选图层锁定', delete: '删除所选图层', duplicate: '复制所选图层', up: '上移所选图层', down: '下移所选图层' }[action]}，可一次撤销`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '批量图层操作未应用，原图层保留') }
  }

  function layerMergeDisabledReason(): string {
    if (!importAvailable) return '当前环境暂不支持保存合并图片'
    if (images.length >= maximumImageTransformInputs) return '已达到 20 张图片来源上限，请先整理来源'
    try { buildEditorLayerMergePlan(stateRef.current.present); return '' } catch (cause) { return cause instanceof Error ? cause.message : '请选择至少两个可见、未锁定的图层，并先核对合并后的画面' }
  }

  function closeLayerMerge(session?: LayerMergeSession, restoreFocus = false) {
    const current = mergeSessionRef.current
    if (!current || session && current !== session) return
    current.controller.abort()
    mergeSessionRef.current = null; setMergeSession(null); setMergeBusy(false); setMergeAccepted(false)
    // Wait until React removes the editor's inert state before restoring focus.
    if (restoreFocus) requestAnimationFrame(() => {
      if (!importAlive.current || mergeSessionRef.current) return
      const target = mergeTrigger.current && !mergeTrigger.current.disabled ? mergeTrigger.current : stage.current
      if (target?.isConnected && !target.closest('[inert],[hidden]')) target.focus({ preventScroll: true })
    })
  }

  function openLayerMerge(placement: 'upper' | 'lower' = 'upper') {
    if (!importAlive.current) return
    if (penDraft.current || gradientGesture.current || paintGesture.current) { setError('请先完成或取消当前绘制，再合并图层'); return }
    cancelSampling(); cancelExport(); cancelGesture(); closeLayerMerge(); setToolMenu(null); setSelectionAdjust(false)
    try {
      const before = finishLayerEditorTransaction(stateRef.current)
      setState(before)
      if (!importAvailable) throw new Error('当前环境暂不支持保存合并图片')
      if (images.length >= maximumImageTransformInputs) throw new Error('已达到 20 张图片来源上限，请先整理来源')
      const preview = sampler.current
      if (!preview?.reviewLayerMerge || !preview.mergeReviewContext) throw new Error('图层预览尚未准备好，请稍后重试')
      const plan = buildEditorLayerMergePlan(before.present, { placement }), ids = selectedEditorLayerIds(before.present), replacementId = nextEditorLayerIdentity(before).id
      const candidate = buildEditorLayerMergeCandidate(plan, { sourceIndex: images.length, replacementId })
      const removedGroups = new Set(candidate.removedGroupIds)
      const groupNames = editorLayerTreeRows(before.present).filter((row) => row.kind === 'group' && removedGroups.has(row.id)).map((row) => row.group!.name)
      const session: LayerMergeSession = { plan, snapshot: before.present, sourcesKey: sourcesKeyRef.current, sourceOffset: images.length, groupNames, names: ids.map((id) => { const index = before.present.ids.indexOf(id); return layerName(before.present.recipe.layers[index], images, index) }), controller: new AbortController(), started: false, context: preview.mergeReviewContext, fontRevision: localFontRevision, replacementId, placement, reviewError: '', accepted: false, phase: 'reviewing' }
      mergeSessionRef.current = session; setMergeSession(session); setMergeBusy(true); setMergeAccepted(false); setError('')
      void reviewLayerMerge(session)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法合并当前所选图层') }
  }

  function currentLayerMerge(session: LayerMergeSession): boolean {
    return importAlive.current && mergeSessionRef.current === session && !session.controller.signal.aborted && session.sourcesKey === sourcesKeyRef.current && session.context === sampler.current?.mergeReviewContext && session.fontRevision === localFontRevision && isCurrentEditorLayerMergePlan(stateRef.current.present, session.plan)
  }

  async function reviewLayerMerge(session: LayerMergeSession) {
    if (!currentLayerMerge(session)) return
    try {
      const preview = sampler.current
      if (!preview?.reviewLayerMerge) throw new Error('图层预览尚未准备好，请重新生成预览')
      const review = await preview.reviewLayerMerge(session.plan, session.sourceOffset, session.replacementId, session.controller.signal)
      if (!currentLayerMerge(session)) return
      if (!(review.output.blob instanceof Blob) || review.output.blob.type !== 'image/png' || !review.output.blob.size || review.output.width !== session.plan.width || review.output.height !== session.plan.height) throw new Error('合并预览结果无效，原图层保留')
      session.review = review; session.phase = 'ready'; setMergeBusy(false)
    } catch (cause) {
      if (!currentLayerMerge(session)) return
      session.reviewError = cause instanceof Error ? cause.message : '合并预览未完成，请重新生成'; session.phase = 'failed'; setMergeBusy(false)
    }
  }

  function mergeReviewContextChanged(context: object) {
    const session = mergeSessionRef.current
    if (session && session.context !== context) { closeLayerMerge(session, true); setStatus('字体、调色表或素材预览已变化，本次合并已取消，请重新核对') }
  }

  async function confirmLayerMerge(session: LayerMergeSession) {
    function current() { return currentLayerMerge(session) }
    const review = session.review
    if (!current() || session.started || session.phase !== 'ready' || !review || review.comparison.changedPixels > 0 && !session.accepted) return
    session.started = true; session.phase = 'uploading'; setMergeBusy(true); setError('')
    try {
      if (!onApplyWithImports) throw new Error('当前环境暂不支持保存合并图片')
      const rendered = review.output
      if (!(rendered.blob instanceof Blob) || rendered.blob.type !== 'image/png' || !rendered.blob.size) throw new Error('合并图片无效，原图层保留')
      const bridge = hostBridge()
      if (!bridge.importLayerPsd) throw new Error('当前环境暂不支持保存合并图片')
      const document: BrowserLayerPsdDocument = { width: rendered.width, height: rendered.height, warnings: [], layers: [{ name: '合并图层', left: 0, top: 0, width: rendered.width, height: rendered.height, opacity: 1, visible: true, blend: 'source-over', blob: rendered.blob }] }
      const assets = await bridge.importLayerPsd(document, session.controller.signal)
      if (!current()) return
      const asset = assets[0]
      if (assets.length !== 1 || !asset || asset.width !== rendered.width || asset.height !== rendered.height || asset.mimeType !== 'image/png' || asset.mediaType !== 'image' || asset.deletedAt || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || asset.localUrl !== `xingmang-asset://image/${asset.assetId}`) throw new Error('合并图片回执不一致，原图层保留；已上传图片可在素材库核对')
      const next = commitEditorLayerMerge(stateRef.current, session.plan, session.sourceOffset, review.candidate)
      const allAssets = [...importedAssetsRef.current, asset]
      closeLayerMerge(session, true)
      importedAssetsRef.current = allAssets; setImportedAssets(allAssets); setState(next)
      setError(''); setStatus(`已将 ${session.names.length} 个所选图层合并为一层位图，可一次撤销；应用图层后保存到节点`)
    } catch (cause) {
      if (current()) { closeLayerMerge(session, true); setError(cause instanceof Error ? cause.message : '合并未应用，原图层保留；已上传图片可在素材库核对') }
    } finally { if (mergeSessionRef.current === session) { session.started = false; setMergeBusy(false) } }
  }

  function closeColorGrade() { colorGradeSessionRef.current = null; setColorGradeSession(null) }
  function openColorGrade() {
    closeLayerMerge()
    cancelSampling(); cancelExport(); cancelGesture(); cancelVectorTools(); setToolMenu(null)
    setState((current) => finishLayerEditorTransaction(current))
    const current = stateRef.current.present, index = current.selectedId ? current.ids.indexOf(current.selectedId) : -1, layer = current.recipe.layers[index]
    if (!importAlive.current || !current.selectedId || !layer || editorLayerEffectiveState(current, current.selectedId).locked || !editorLayerEffectiveState(current, current.selectedId).visible) { setError('请先选择可见且未锁定的图层'); return }
    const session = { id: current.selectedId, index, layer, recipe: current.recipe, sourcesKey: sourcesKeyRef.current }
    colorGradeSessionRef.current = session; setColorGradeSession(session); setError('')
  }
  function applyColorGrade(session: ColorGradeSession, value: ImageLayerColorGrade) {
    const current = stateRef.current.present, index = current.ids.indexOf(session.id), layer = current.recipe.layers[index]
    if (!importAlive.current || colorGradeSessionRef.current !== session || current.selectedId !== session.id || current.recipe !== session.recipe || layer !== session.layer || layer.locked || !layer.visible || sourcesKeyRef.current !== session.sourcesKey) throw new Error('图层或素材已变化，本次调整未应用，请重新打开图像调整')
    const grade = parseImageLayerColorGrade(value)
    change((current) => patchEditorLayer(current, session.id, { colorGrade: grade.lut === undefined && grade.detail === undefined && grade.presence === undefined && grade.calibration === undefined && isNeutralImageLayerColorGrade(grade) ? undefined : grade }))
    closeColorGrade(); setStatus('图像调整已应用到当前图层，可一次撤销；应用图层后保存到节点')
  }

  function closeWholeFilter(session?: WholeFilterSession) { if (session && wholeFilterSessionRef.current !== session) return; wholeFilterSessionRef.current = null; setWholeFilterSession(null) }
  function openWholeFilter() {
    closeLayerMerge()
    cancelSampling(); cancelExport(); cancelGesture(); cancelVectorTools(); setToolMenu(null)
    setState((current) => finishLayerEditorTransaction(current))
    const current = stateRef.current.present, index = current.selectedId ? current.ids.indexOf(current.selectedId) : -1, layer = current.recipe.layers[index]
    if (!importAlive.current || !current.selectedId || !layer || editorLayerEffectiveState(current, current.selectedId).locked || !editorLayerEffectiveState(current, current.selectedId).visible) { setError('请先选择可见且未锁定的图层'); return }
    try { layerWholeFilterSpace(current.recipe, index) } catch (cause) { setError(cause instanceof Error ? cause.message : '当前图层不支持整层滤镜'); return }
    const session = { id: current.selectedId, index, layer, recipe: current.recipe, sourcesKey: sourcesKeyRef.current, hasSelection: Boolean(current.canvasSelection) }
    wholeFilterSessionRef.current = session; setWholeFilterSession(session); setError('')
  }
  function applyWholeFilter(session: WholeFilterSession, value: ImageLayerWholeFilterOperation) {
    const current = stateRef.current.present, index = current.ids.indexOf(session.id), layer = current.recipe.layers[index]
    if (!importAlive.current || wholeFilterSessionRef.current !== session || current.selectedId !== session.id || current.recipe !== session.recipe || layer !== session.layer || layer.locked || !layer.visible || sourcesKeyRef.current !== session.sourcesKey) throw new Error('图层或素材已变化，本次滤镜未应用，请重新打开图层滤镜')
    const operation = parseImageLayerWholeFilterOperation(value), space = layerWholeFilterSpace(current.recipe, index)
    if (operation.space.width !== space.width || operation.space.height !== space.height) throw new Error('滤镜像素范围已变化，请重新打开图层滤镜')
    if (isNeutralWholeLayerFilter(operation.filter)) { closeWholeFilter(session); setStatus('滤镜未产生变化，原图层与历史保留'); return }
    change((current) => appendEditorLayerOperation(current, session.id, operation))
    closeWholeFilter(session); setStatus('滤镜已应用到当前图层，可一次撤销；应用图层后保存到节点')
  }

  function closeLiquify(session?: LiquifySession) { if (session && liquifySessionRef.current !== session) return; liquifySessionRef.current = null; setLiquifySession(null) }
  function openLiquify() {
    closeLayerMerge()
    cancelSampling(); cancelExport(); cancelGesture(); cancelVectorTools(); setToolMenu(null)
    setState((current) => finishLayerEditorTransaction(current))
    const current = stateRef.current.present, index = current.selectedId ? current.ids.indexOf(current.selectedId) : -1, layer = current.recipe.layers[index]
    if (!importAlive.current || !current.selectedId || !layer || editorLayerEffectiveState(current, current.selectedId).locked || !editorLayerEffectiveState(current, current.selectedId).visible) { setError('请先选择可见且未锁定的图层'); return }
    try { layerLiquifySpace(current.recipe, index) } catch (cause) { setError(cause instanceof Error ? cause.message : '当前图层不支持液化'); return }
    const session = { id: current.selectedId, index, layer, recipe: current.recipe, sourcesKey: sourcesKeyRef.current }
    liquifySessionRef.current = session; setLiquifySession(session); setError('')
  }
  function applyLiquify(session: LiquifySession, value: ImageLayerLiquifyOperation) {
    const current = stateRef.current.present, index = current.ids.indexOf(session.id), layer = current.recipe.layers[index]
    if (!importAlive.current || liquifySessionRef.current !== session || current.selectedId !== session.id || current.recipe !== session.recipe || layer !== session.layer || layer.locked || !layer.visible || sourcesKeyRef.current !== session.sourcesKey) throw new Error('图层或素材已变化，本次液化未应用，请重新打开液化图层')
    const operation = parseImageLayerLiquifyOperation(value)
    change((current) => appendEditorLayerOperation(current, session.id, operation))
    closeLiquify(session); setStatus('液化已应用到当前图层，可一次撤销；应用图层后保存到节点')
  }

  useEffect(() => { importAlive.current = true; return () => { importAlive.current = false; mergeSessionRef.current?.controller.abort(); mergeSessionRef.current = null } }, [])
  useEffect(() => { const session = mergeSessionRef.current; if (session && (session.sourcesKey !== sourcesKey || session.fontRevision !== localFontRevision || session.context !== sampler.current?.mergeReviewContext || !isCurrentEditorLayerMergePlan(stateRef.current.present, session.plan))) { closeLayerMerge(session); setStatus('图层选择、内容或素材已变化，本次合并已取消，原图层保留') } }, [state.present, sourcesKey, localFontRevision])
  useEffect(() => { const session = colorGradeSessionRef.current; if (session && (session.recipe !== recipe || session.id !== selectedId || session.sourcesKey !== sourcesKey || selected?.locked || !selected?.visible)) { closeColorGrade(); setStatus('图层或素材已变化，未完成的图像调整已取消') } }, [recipe, selectedId, sourcesKey, selected?.locked, selected?.visible])
  useEffect(() => { const session = wholeFilterSessionRef.current; if (session && (session.recipe !== recipe || session.id !== selectedId || session.sourcesKey !== sourcesKey || selected?.locked || !selected?.visible)) { closeWholeFilter(session); setStatus('图层或素材已变化，未完成的滤镜已取消') } }, [recipe, selectedId, sourcesKey, selected?.locked, selected?.visible])
  useEffect(() => { const session = liquifySessionRef.current; if (session && (session.recipe !== recipe || session.id !== selectedId || session.sourcesKey !== sourcesKey || selected?.locked || !selected?.visible)) { closeLiquify(session); setStatus('图层或素材已变化，未完成的液化已取消') } }, [recipe, selectedId, sourcesKey, selected?.locked, selected?.visible])
  useEffect(() => () => { if (paintFrame.current !== null) cancelAnimationFrame(paintFrame.current); paintGesture.current = null; gradientGesture.current = null; penDraft.current = null; penGesture.current = null; quickGesture.current?.request.controller.abort(); quickGesture.current = null; quickPixels.current = null; sampling.current?.controller.abort(); sampling.current = null; exportRequest.current?.controller.abort(); exportRequest.current = null }, [])
  useEffect(() => { cancelSampling(); quickPixels.current = null; quickSessions.current = new WeakMap(); setQuickMode('region') }, [recipe, selectedId, tool, sourcesKey, quickSource])
  useEffect(() => { const request = exportRequest.current; if (request && !isCurrentLayerColorSample(request, exportRequest.current, stateRef.current.present, sourcesKeyRef.current)) cancelExport() }, [recipe, selectedId, sourcesKey])
  useEffect(() => {
    if ((gradientGesture.current && !isCurrentLayerVectorScope(gradientGesture.current, stateRef.current.present, sourcesKeyRef.current, selectionRef.current)) || (penDraft.current && !isCurrentLayerVectorScope(penDraft.current, stateRef.current.present, sourcesKeyRef.current, selectionRef.current))) {
      cancelVectorTools(); setStatus('图层、选区或画布已变化，未完成的渐变与钢笔路径已取消')
    }
  }, [recipe, selectedId, sourcesKey, selection])
  useEffect(() => {
    const value = selectionRef.current
    if (value?.kind === 'raster' && (value.raster.width !== recipe.outputWidth || value.raster.height !== recipe.outputHeight)) {
      cancelSampling(); setSelection(null); setStatus('画布尺寸已变化，临时像素选区已取消；已应用的编辑与蒙版保留')
    }
  }, [recipe.outputWidth, recipe.outputHeight])
  useEffect(() => { if (toolMenu) toolPopover.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [toolMenu])
  useEffect(() => { if (selectionAdjust) selectionPopover.current?.querySelector<HTMLInputElement>('input')?.focus() }, [selectionAdjust])
  useEffect(() => {
    if (tool !== 'select-color-range' || rangePreviewCurrent) return
    const timer = setTimeout(() => { void previewColorRange() }, 250)
    return () => clearTimeout(timer)
  }, [tool, rangeColor, tolerance, sampleSource, combination, recipe, selectedId, sourcesKey, selection])

  function pointAt(clientX: number, clientY: number): LayerCanvasPoint | null {
    const matrix = svg.current?.getScreenCTM()
    if (!matrix) return null
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? { x: point.x, y: point.y } : null
  }

  function cancelPaint() {
    paintGesture.current = null
    if (paintFrame.current !== null) { cancelAnimationFrame(paintFrame.current); paintFrame.current = null }
    setTransient(null)
  }

  function cancelSelection() {
    if (selectionGesture.current) setSelection(selectionGesture.current.previous)
    selectionGesture.current = null
  }

  function setDocumentCrop(next: DocumentCropSession | null) { cropSessionRef.current = next; setCropSession(next) }
  function cancelDocumentCropGesture(pointerId?: number) {
    const active = cropGesture.current
    if (!active || pointerId !== undefined && active.pointerId !== pointerId) return
    cropGesture.current = null
    if (cropSessionRef.current?.recipe === active.session.recipe && cropSessionRef.current.sourcesKey === active.session.sourcesKey) setDocumentCrop({ ...active.session, rect: active.before })
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId)
  }
  function closeDocumentCrop() { cancelDocumentCropGesture(); setDocumentCrop(null) }
  function cancelDocumentCrop() { closeDocumentCrop(); setError(''); setStatus('已取消文档裁剪，画布和图层保留'); stage.current?.focus() }
  function toggleDocumentCrop() { if (cropSessionRef.current) { if (viewportHand) viewportController.current?.exitHand(); else cancelDocumentCrop() } else openDocumentCrop() }
  function setDocumentOutputSize(axis: 'outputWidth' | 'outputHeight', value: number) {
    try { change((current) => patchEditorRecipe(current, { [axis]: value })) } catch (cause) { setError(cause instanceof Error ? cause.message : '画布尺寸未修改，请调整后重试') }
  }
  function openDocumentCrop() {
    cropRatioRef.current = null; setCropRatio(null)
    cancelSampling(); cancelExport(); cancelGesture(); cancelVectorTools(); viewportController.current?.exitHand(); setToolMenu(null); setSelectionAdjust(false)
    const current = finishLayerEditorTransaction(stateRef.current); setState(current)
    setDocumentCrop({ recipe: current.present.recipe, sourcesKey: sourcesKeyRef.current, rect: null }); setError(''); setStatus('拖动创建裁剪框；仅应用裁剪后修改画布，全部图层继续保留'); stage.current?.focus()
  }
  function currentDocumentCrop(): DocumentCropSession | null {
    const session = cropSessionRef.current
    if (!session) return null
    if (session.recipe !== stateRef.current.present.recipe || session.sourcesKey !== sourcesKeyRef.current) { closeDocumentCrop(); setError('图层或素材已变化，未应用的裁剪框已取消'); return null }
    return session
  }
  function updateDocumentCrop(rect: LayerDocumentCropRect | null) {
    cancelDocumentCropGesture()
    const session = currentDocumentCrop(); if (!session) return
    const output = { width: session.recipe.outputWidth, height: session.recipe.outputHeight }
    const next = rect && (cropRatioRef.current ? fitLayerDocumentCropRatio(rect, cropRatioRef.current, output) : normalizeLayerDocumentCrop(rect, output))
    if (rect && !next) { setError('当前画布放不下该比例的最小像素块，请选择自由比例'); return }
    setDocumentCrop({ ...session, rect: next }); setError('')
  }
  function changeDocumentCropRatio(value: string) {
    cancelDocumentCropGesture()
    const session = currentDocumentCrop(); if (!session) return
    const choices: Record<string, LayerDocumentCropRatio> = { '1:1': [1, 1], '4:3': [4, 3], '3:2': [3, 2], '16:9': [16, 9], '9:16': [9, 16] }
    const ratio = choices[value] ?? null, output = { width: session.recipe.outputWidth, height: session.recipe.outputHeight }
    const rect = ratio ? fitLayerDocumentCropRatio(session.rect ?? { x: 0, y: 0, ...output }, ratio, output) : session.rect
    if (ratio && !rect) { setError('当前画布放不下该比例的最小像素块，请选择自由比例'); return }
    cropRatioRef.current = ratio; setCropRatio(ratio); setDocumentCrop({ ...session, rect }); setError('')
  }
  function changeDocumentCropField(key: keyof LayerDocumentCropRect, value: number) {
    const session = currentDocumentCrop(); if (!session) return
    const output = { width: session.recipe.outputWidth, height: session.recipe.outputHeight }, rect = session.rect ?? { x: 0, y: 0, ...output }, ratio = cropRatioRef.current
    const next = key === 'x' || key === 'y' ? session.rect ? moveLayerDocumentCrop(rect, { x: key === 'x' ? value - rect.x : 0, y: key === 'y' ? value - rect.y : 0 }, output) : normalizeLayerDocumentCrop({ ...rect, [key]: value }, output) : ratio ? resizeLayerDocumentCropRatio(rect, 'se', { x: key === 'width' ? value - rect.width : 0, y: key === 'height' ? value - rect.height : 0 }, ratio, output) : normalizeLayerDocumentCrop({ ...rect, [key]: value }, output)
    if (next) updateDocumentCrop(next)
  }
  function startDocumentCrop(event: PointerEvent<SVGGElement>, mode: LayerDocumentCropDrag) {
    if (event.button !== 0 || cropGesture.current) return
    event.preventDefault(); event.stopPropagation(); stage.current?.focus()
    const session = currentDocumentCrop(), point = pointAt(event.clientX, event.clientY)
    if (!session || !point || mode !== 'draw' && !session.rect) return
    cropGesture.current = { pointerId: event.pointerId, target: event.currentTarget, mode, start: point, before: session.rect, session, ratio: cropRatioRef.current }
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { cancelDocumentCropGesture(); setError('裁剪拖动已中断，请重试') }
  }
  function moveDocumentCrop(event: PointerEvent<SVGGElement>) {
    const active = cropGesture.current
    if (!active || active.pointerId !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    const session = currentDocumentCrop(), point = pointAt(event.clientX, event.clientY)
    if (!session || !point) { cancelDocumentCropGesture(); return }
    const output = { width: session.recipe.outputWidth, height: session.recipe.outputHeight }, delta = { x: point.x - active.start.x, y: point.y - active.start.y }
    const rect = active.mode === 'draw' ? active.ratio ? buildLayerDocumentCropRatio(active.start, point, active.ratio, output) : buildLayerDocumentCrop(active.start, point, output) : active.mode === 'move' ? moveLayerDocumentCrop(active.before!, delta, output) : active.ratio ? resizeLayerDocumentCropRatio(active.before!, active.mode, delta, active.ratio, output) : resizeLayerDocumentCrop(active.before!, active.mode, delta, output)
    setDocumentCrop({ ...session, rect }); setError(active.ratio && !rect ? '该位置放不下当前比例，请向画布内拖动或选择自由比例' : '')
  }
  function endDocumentCrop(event: PointerEvent<SVGGElement>) {
    const active = cropGesture.current
    if (!active || active.pointerId !== event.pointerId) return
    moveDocumentCrop(event)
    if (cropGesture.current !== active) return
    cropGesture.current = null
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId)
  }
  function nudgeDocumentCrop(mode: LayerDocumentCropDrag, dx: number, dy: number) {
    cancelDocumentCropGesture()
    const session = currentDocumentCrop(); if (!session?.rect) return
    const output = { width: session.recipe.outputWidth, height: session.recipe.outputHeight }, delta = { x: dx, y: dy }
    const ratio = cropRatioRef.current
    updateDocumentCrop(mode === 'move' || mode === 'draw' ? moveLayerDocumentCrop(session.rect, delta, output) : ratio ? resizeLayerDocumentCropRatio(session.rect, mode, { x: dx * ratio[0], y: dy * ratio[1] }, ratio, output) : resizeLayerDocumentCrop(session.rect, mode, delta, output))
  }
  function applyDocumentCrop() {
    cancelDocumentCropGesture()
    const session = currentDocumentCrop()
    if (!session?.rect) { setError('请先拖动创建裁剪框，或填写裁剪像素范围'); return }
    try {
      const next = applyEditorDocumentCrop(stateRef.current, session.rect)
      setDocumentCrop(null); setState(next); setError(''); setStatus(`已裁剪为 ${next.present.recipe.outputWidth} × ${next.present.recipe.outputHeight} px；撤销可同时恢复尺寸和图层位置`); stage.current?.focus()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '文档裁剪未应用，请调整范围后重试') }
  }
  useEffect(() => { const session = cropSessionRef.current; if (session && (session.recipe !== recipe || session.sourcesKey !== sourcesKey)) closeDocumentCrop() }, [recipe, sourcesKey])
  useEffect(() => () => { cropGesture.current = null; cropSessionRef.current = null }, [])

  function chooseTool(next: LayerCanvasTool) { closeDocumentCrop(); viewportController.current?.exitHand(); if (next === 'blur' || next === 'sharpen') setFilterMode(next); cancelSampling(); cancelVectorTools(); setToolMenu(null); setSelectionAdjust(false); setStatus(''); cancelPaint(); cancelSelection(); if (gesture.current) finish(true); if (next !== 'select-color-range') { setRangePreview(null); rangePreviewKey.current = null }; toolRef.current = next; setTool(next); setError(''); stage.current?.focus() }

  function cancelQuickGesture() {
    quickGesture.current?.request.controller.abort()
    quickGesture.current = null
    setQuickGuide(null)
  }

  function cancelSampling() { cancelQuickGesture(); if (sampling.current) { sampling.current.controller.abort(); setStatus('已取消像素处理，原选区和图层已保留') } sampling.current = null; setPicking(false) }

  function cancelExport() { if (!exportRequest.current) return; exportRequest.current.controller.abort(); exportRequest.current = null; setExporting(false); setStatus('PSD 导出已取消，图层内容保留') }

  function openPsdImport() {
    closeLayerMerge()
    if (penDraft.current || gradientGesture.current || paintGesture.current) { setError('请先完成或取消当前绘制，再导入 PSD'); return }
    cancelSampling(); cancelExport(); cancelGesture(); setToolMenu(null); setSelectionAdjust(false); setPsdImportOpen(true)
  }

  async function importPsd(document: BrowserLayerPsdDocument, options: { signal: AbortSignal }) {
    const bridge = hostBridge()
    if (!bridge.importLayerPsd || !onApplyWithImports) throw new Error('当前环境暂不支持 PSD 图层导入')
    const before = finishLayerEditorTransaction(stateRef.current), key = sourcesKeyRef.current
    const next = appendEditorImportedLayers(before, document, images.length)
    const assets = await bridge.importLayerPsd(document, options.signal)
    options.signal.throwIfAborted()
    if (!importAlive.current || stateRef.current.present !== before.present || sourcesKeyRef.current !== key) throw new Error('当前图层或图片来源已变化，未追加旧导入结果；已上传素材可到素材库核对')
    if (assets.length !== document.layers.length || assets.some((asset, index) => asset.width !== document.layers[index].width || asset.height !== document.layers[index].height)) throw new Error('PSD 图层素材回执不一致，请保留当前文件并重试核对')
    const allAssets = [...importedAssetsRef.current, ...assets]
    importedAssetsRef.current = allAssets; setImportedAssets(allAssets)
    stateRef.current = next; setState(next)
    setError(''); setStatus(`已追加 ${assets.length} 个 PSD 图层${document.layerGroups?.groups.length ? ` · ${document.layerGroups.groups.length} 个编组` : ''}，可一次撤销；应用图层后才更新节点。素材已保存到账号素材库。`)
  }

  async function exportPsd() {
    if (exportRequest.current) return
    if (penDraft.current || gradientGesture.current || paintGesture.current) { setError('请先完成或取消当前绘制，再导出 PSD'); return }
    cancelSampling()
    const current = finishLayerEditorTransaction(stateRef.current)
    const request: LayerColorSampleRequest = { controller: new AbortController(), recipe: current.present.recipe, selectedId: current.present.selectedId, sourcesKey: sourcesKeyRef.current }
    exportRequest.current = request; setExporting(true); setError(''); setStatus('正在导出当前编辑态的分层 PSD，保留组结构；文字、形状、路径与滤镜按图层栅格化')
    try {
      const bridge = hostBridge()
      if (!bridge.exportLayerPsd) throw new Error('当前宿主暂不支持 PSD 导出')
      const result = await bridge.exportLayerPsd(buildLayerEditorPsdExport(current.present.recipe, images), request.controller.signal)
      if (!isCurrentLayerColorSample(request, exportRequest.current, stateRef.current.present, sourcesKeyRef.current)) return
      setStatus(`已导出 ${result.layerCount} 层${result.groupCount ? ` · ${result.groupCount} 个编组` : ''} PSD（${(result.byteSize / 1024 / 1024).toFixed(1)} MB）；文字、形状与路径已栅格化，未自动应用到节点`)
    } catch (cause) { if (isCurrentLayerColorSample(request, exportRequest.current, stateRef.current.present, sourcesKeyRef.current)) setError(cause instanceof Error ? cause.message : 'PSD 导出失败，请重试') }
    finally { if (exportRequest.current === request) { exportRequest.current = null; setExporting(false) } }
  }

  function setForegroundColor(color: string) { cancelSampling(); cancelGradient(); setPaintSettings((value) => ({ ...value, color })); setStatus('') }

  function cancelGradient() {
    if (gradientGesture.current) {
      gradientGesture.current = null
      if (paintFrame.current !== null) { cancelAnimationFrame(paintFrame.current); paintFrame.current = null }
      setTransient(null); setGradientGuide(null)
    }
  }

  function cancelPen() { penDraft.current = null; penGesture.current = null; setPenAnchors([]) }
  function cancelVectorTools() { cancelGradient(); cancelPen() }

  function swapColors(reset = false) {
    cancelSampling(); cancelGradient()
    setPaintSettings((value) => ({ ...value, color: reset ? '#000000' : backgroundColor }))
    setBackgroundColor(reset ? '#ffffff' : paintSettings.color)
    setStatus(reset ? '前景色与背景色已重置为黑白' : '已交换前景色与背景色')
  }

  function previewGradient(start: GradientGesture) {
    if (paintFrame.current !== null) return
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null
      if (gradientGesture.current !== start) return
      try {
        if (!isCurrentLayerVectorScope(start, stateRef.current.present, sourcesKeyRef.current, selectionRef.current)) { cancelGradient(); return }
        setGradientGuide({ from: start.from, to: start.to })
        if (!hasLayerGradientDistance(start.from, start.to)) { setTransient(null); return }
        const output = { width: start.recipe.outputWidth, height: start.recipe.outputHeight }
        const from = outputPointToLayerPoint(start.layer, output, start.from), to = outputPointToLayerPoint(start.layer, output, start.to)
        if (from[0] === to[0] && from[1] === to[1]) { setTransient(null); return }
        const stroke = createLayerGradient(start.layer, start.recipe, start.settings, start.from, start.to, start.selection)
        setTransient({ id: start.id, stroke })
      } catch (cause) { cancelGradient(); setError(cause instanceof Error ? cause.message : '渐变预览失败，原图层已保留') }
    })
  }

  function addPenAnchor(point: LayerCanvasPoint, pointerId: number) {
    try {
      const present = stateRef.current.present
      if (present.recipe.layers.length >= maximumImageTransformInputs) throw new Error(`最多 ${maximumImageTransformInputs} 层，请先删除不需要的图层`)
      let draft = penDraft.current
      if (draft && !isCurrentLayerVectorScope(draft, present, sourcesKeyRef.current, selectionRef.current)) { cancelPen(); throw new Error('画布已变化，未完成的钢笔路径已取消') }
      if (!draft) draft = { recipe: present.recipe, selectedId: present.selectedId, sourcesKey: sourcesKeyRef.current, selection: selectionRef.current, points: [] }
      const points = appendLayerPenAnchor(draft.points, point, { width: present.recipe.outputWidth, height: present.recipe.outputHeight }, maximumImageLayerPathPoints)
      if (points.length === draft.points.length) return
      penDraft.current = { ...draft, points }; penGesture.current = { pointerId, index: points.length - 1, anchor: points.at(-1)! }; setPenAnchors(points); setError(''); setStatus(`钢笔路径 ${points.length} 个锚点 · 拖拽曲线柄，Enter 或双击闭合`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法添加钢笔锚点') }
  }

  function movePenHandle(point: LayerCanvasPoint) {
    const active = penGesture.current, draft = penDraft.current
    if (!active || !draft) return
    if (!isCurrentLayerVectorScope(draft, stateRef.current.present, sourcesKeyRef.current, selectionRef.current)) { cancelPen(); setStatus('画布已变化，未完成的钢笔路径已取消'); return }
    const points = draft.points.map((anchor, index) => index === active.index ? dragLayerPenHandles(active.anchor, point, { width: draft.recipe.outputWidth, height: draft.recipe.outputHeight }) : anchor)
    penDraft.current = { ...draft, points }; setPenAnchors(points)
  }

  function completePen() {
    const draft = penDraft.current
    if (!draft) { setError('请先在画布上放置至少 3 个钢笔锚点'); return }
    try {
      if (!isCurrentLayerVectorScope(draft, stateRef.current.present, sourcesKeyRef.current, selectionRef.current)) { cancelPen(); throw new Error('画布已变化，未完成的钢笔路径已取消') }
      if (draft.points.length < 3) throw new Error('闭合路径至少需要 3 个不同锚点，请继续添加')
      const next = addEditorPathLayer(finishLayerEditorTransaction(stateRef.current), draft.points, penStyle, draft.selection)
      stateRef.current = next; setState(next); cancelPen(); setError(''); setStatus('已新建独立钢笔图层，可编辑填充、描边与位置，一次撤销可移除')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '钢笔路径未保存，请检查锚点') }
  }

  async function pickColor(point: LayerCanvasPoint) {
    cancelSampling()
    const current = stateRef.current.present
    const request = { controller: new AbortController(), recipe: current.recipe, selectedId: current.selectedId, sourcesKey: sourcesKeyRef.current }
    sampling.current = request; setPicking(true); setError(''); setStatus('正在读取合成颜色…')
    try {
      if (!sampler.current) throw new Error('预览尚未就绪，请稍后取色')
      const color = await sampler.current.sampleColor(point, request.controller.signal)
      if (!isCurrentLayerColorSample(request, sampling.current, stateRef.current.present, sourcesKeyRef.current)) return
      setPaintSettings((value) => ({ ...value, color }))
      setStatus(`已取色 ${color}${color.endsWith('00') ? ' · 此像素完全透明' : ''}`)
    } catch (cause) {
      if (isCurrentLayerColorSample(request, sampling.current, stateRef.current.present, sourcesKeyRef.current)) { setError(cause instanceof Error ? cause.message : '取色失败，请重试'); setStatus('') }
    } finally { if (sampling.current === request) { sampling.current = null; setPicking(false) } }
  }

  async function runPixelJob(label: string, work: (request: LayerPixelRequest) => Promise<{ selection?: LayerCanvasSelection; preview?: LayerCanvasSelection; rangeColor?: string; state?: LayerEditorState; color?: string; status: string }>) {
    cancelSampling()
    const current = stateRef.current.present
    const request: LayerPixelRequest = { controller: new AbortController(), recipe: current.recipe, selectedId: current.selectedId, sourcesKey: sourcesKeyRef.current, selection: selectionRef.current, tool: toolRef.current }
    sampling.current = request; setPicking(true); setError(''); setStatus(label)
    function currentRequest() { return isCurrentLayerPixelRequest(request, sampling.current, stateRef.current.present, sourcesKeyRef.current, selectionRef.current, toolRef.current) }
    try {
      const result = await work(request)
      if (!currentRequest()) return
      if (result.state) { stateRef.current = result.state; setState(result.state) }
      if (result.selection) setSelection(result.selection, true)
      if (result.preview) {
        rangePreviewKey.current = { recipe: request.recipe, selectedId: request.selectedId, sourcesKey: request.sourcesKey, selection: request.selection, color: result.rangeColor ?? rangeColor, tolerance, source: sampleSource, combination }
        setRangePreview(result.preview)
      }
      if (result.rangeColor) setRangeColor(result.rangeColor)
      if (result.color) setSampledColor(result.color)
      setStatus(result.status)
    } catch (cause) {
      if (currentRequest()) { setError(cause instanceof Error ? cause.message : '像素处理失败，请重试'); setStatus('') }
    } finally { if (sampling.current === request) { sampling.current = null; setPicking(false) } }
  }

  function chooseQuickMode(mode: LayerQuickSelectionMode) {
    cancelSampling(); setQuickMode(mode); setError(''); setStatus(''); stage.current?.focus()
  }

  function beginQuickSelection(point: LayerCanvasPoint, pointerId: number, modifiers: { shiftKey: boolean; altKey: boolean }) {
    cancelSampling()
    const current = finishLayerEditorTransaction(stateRef.current)
    setState(current)
    try {
      if (!sampler.current) throw new Error('预览尚未就绪，请等待图片加载后框选')
      const output = { width: current.present.recipe.outputWidth, height: current.present.recipe.outputHeight }
      if (point.x < 0 || point.y < 0 || point.x > output.width || point.y > output.height) throw new Error('请在画布内部开始框选')
      const candidate = selectionRef.current ? quickSessions.current.get(selectionRef.current) : undefined
      const session = layerQuickSessionCurrent(candidate, quickPixels.current, current.present, sourcesKeyRef.current, quickSourceRef.current) ? candidate : undefined
      if (quickMode !== 'region' && !session) throw new Error('请先框住主体完成一次分割，再用保留或排除笔触修正')
      const bounded = quickMode === 'region' ? point : clampLayerQuickPoint(point, session!.region)
      if (bounded.x !== point.x || bounded.y !== point.y) throw new Error('请在虚线处理框内部绘制修正；需要扩大范围时请重新框选')
      const request: LayerPixelRequest = { controller: new AbortController(), recipe: current.present.recipe, selectedId: current.present.selectedId, sourcesKey: sourcesKeyRef.current, selection: selectionRef.current, tool: 'select-quick' }
      const next: QuickSelectionGesture = { pointerId, request, mode: quickMode, source: quickSourceRef.current, sampler: sampler.current, session: quickMode === 'region' ? undefined : session, combination: layerSelectionCombination(combination, modifiers), start: bounded, end: bounded, points: quickMode === 'region' ? [] : [bounded], diameter: quickDiameter }
      quickGesture.current = next; setQuickGuide(next); setError('')
      setStatus(quickMode === 'region' ? '框住主体并留出少量背景，松开开始本地分割；Escape 取消' : `${quickMode === 'foreground' ? '保留前景' : '排除背景'} · 松开重新分割 · Escape 取消本笔`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '无法开始快速选择') }
  }

  function moveQuickSelection(point: LayerCanvasPoint, force = false) {
    const active = quickGesture.current
    if (!active) return
    if (!isCurrentLayerPixelRequest(active.request, active.request, stateRef.current.present, sourcesKeyRef.current, selectionRef.current, toolRef.current) || active.source !== quickSourceRef.current) { cancelQuickGesture(); return }
    try {
      const bounds = active.session?.region ?? { x: 0, y: 0, width: active.request.recipe.outputWidth, height: active.request.recipe.outputHeight }
      const end = clampLayerQuickPoint(point, bounds)
      const points = active.mode === 'region' ? active.points : appendLayerQuickPoint(active.points, end, active.diameter, active.session!.strokes.reduce((count, stroke) => count + stroke.points.length, 0), bounds, force)
      const next = { ...active, end, points }
      quickGesture.current = next; setQuickGuide(next)
    } catch (cause) { cancelQuickGesture(); setError(cause instanceof Error ? cause.message : '修正笔触未保存，原选区保留') }
  }

  async function completeQuickSelection(active: QuickSelectionGesture) {
    const request = active.request
    if (!isCurrentLayerPixelRequest(request, request, stateRef.current.present, sourcesKeyRef.current, selectionRef.current, toolRef.current) || active.source !== quickSourceRef.current) return
    cancelSampling()
    sampling.current = request; setPicking(true); setError(''); setStatus('正在读取原始像素并分割前景…')
    function currentRequest() { return isCurrentLayerPixelRequest(request, sampling.current, stateRef.current.present, sourcesKeyRef.current, selectionRef.current, toolRef.current) && active.source === quickSourceRef.current }
    try {
      const output = { width: request.recipe.outputWidth, height: request.recipe.outputHeight }
      const region = active.session?.region ?? layerQuickRegion(active.start, active.end, output)
      const strokes = active.session ? appendLayerQuickStroke(active.session, active.mode as 'foreground' | 'background', active.diameter, active.points) : []
      let pixels = quickPixels.current
      if (!layerQuickPixelsCurrent(pixels, stateRef.current.present, request.sourcesKey, active.source)) {
        const layerIndex = request.selectedId ? stateRef.current.present.ids.indexOf(request.selectedId) : -1
        const sampled = await active.sampler.samplePixels({ source: active.source, layerIndex }, request.controller.signal)
        if (!currentRequest()) return
        if (sampled.width !== output.width || sampled.height !== output.height) throw new Error('取样尺寸已变化，请重新框选')
        pixels = { ...sampled, recipe: request.recipe, selectedId: request.selectedId, sourcesKey: request.sourcesKey, source: active.source }
        quickPixels.current = pixels
      }
      if (!currentRequest()) return
      const raster = await runLayerGrabCutSelection({ data: pixels.data, ...output, region, strokes }, {
        signal: request.controller.signal,
        onProgress(value) { if (currentRequest()) setStatus(value.phase === 'loading' ? '正在加载本站前景分割组件…' : value.phase === 'segmenting' ? `正在分割前景 ${value.iteration ?? 0} / ${value.total ?? 3}，可随时取消…` : value.phase === 'encoding' ? '正在生成原始像素选区…' : '正在准备前景与背景样本…') },
      })
      if (!currentRequest()) return
      const session: LayerQuickSelectionSession = { pixels, region, strokes, baseSelection: active.session ? active.session.baseSelection : request.selection, combination: active.session?.combination ?? active.combination }
      const next = await combineCanvasSelections(session.baseSelection, { kind: 'raster', raster, inverted: false }, session.combination, output, request.controller.signal)
      if (!currentRequest()) return
      setSelection(next, true, true)
      // History keeps only the RLE selection. One sampled buffer is shared by correction steps.
      const committed = selectionRef.current!
      quickSessions.current.set(committed, session)
      setStatus(`已完成前景分割 · ${next.kind === 'raster' ? canvasRasterSelectionCount(next) : 0} 像素 · 可用保留 / 排除笔触修正；选区尚未写入图层`)
    } catch (cause) { if (currentRequest()) { setError(cause instanceof Error ? cause.message : '前景分割失败，原选区已保留'); setStatus('') } }
    finally { if (sampling.current === request) { sampling.current = null; setPicking(false) } }
  }

  async function previewColorRange(point?: LayerCanvasPoint) {
    await runPixelJob('正在预览色彩范围，原选区尚未改变…', async (request) => {
      if (request.tool !== 'select-color-range') throw new Error('色彩范围工具已关闭')
      if (!sampler.current) throw new Error('预览尚未就绪，请稍后取样')
      const layerIndex = request.selectedId ? stateRef.current.present.ids.indexOf(request.selectedId) : -1
      const pixels = await sampler.current.samplePixels({ source: sampleSource, layerIndex }, request.controller.signal)
      const output = { width: request.recipe.outputWidth, height: request.recipe.outputHeight }
      if (pixels.width !== output.width || pixels.height !== output.height) throw new Error('取样尺寸已变化，请重新预览')
      let color = rangeColor
      if (point) {
        if (point.x < 0 || point.y < 0 || point.x >= output.width || point.y >= output.height) throw new Error('请点击画布内部取样')
        const offset = (Math.floor(point.y) * pixels.width + Math.floor(point.x)) * 4
        color = `#${Array.from(pixels.data.slice(offset, offset + 4), (channel) => channel.toString(16).padStart(2, '0')).join('')}`
      }
      const rgba = [Number.parseInt(color.slice(1, 3), 16), Number.parseInt(color.slice(3, 5), 16), Number.parseInt(color.slice(5, 7), 16), color.length === 9 ? Number.parseInt(color.slice(7, 9), 16) : 255] as const
      const raster = await selectLayerRasterColors({ ...output, rgba: pixels.data, seed: { x: 0, y: 0 }, color: rgba, tolerance, contiguous: false }, { signal: request.controller.signal })
      const preview = await combineCanvasSelections(request.selection, { kind: 'raster', raster, inverted: false }, combination, output, request.controller.signal)
      return { preview, rangeColor: color, color, status: `色彩范围预览 ${preview.kind === 'raster' ? canvasRasterSelectionCount(preview) : 0} 像素；应用后才改变选区` }
    })
  }

  function applyColorRange() {
    if (!rangePreviewCurrent || !rangePreview || picking) return
    changeSelection(rangePreview); chooseTool('move'); setStatus('已应用色彩范围选区，图层内容未修改')
  }

  async function selectPixels(point: LayerCanvasPoint, mode: LayerSelectionCombination) {
    await runPixelJob(toolRef.current === 'bucket' ? '正在计算连通区域并填色…' : '正在按原始分辨率计算选区…', async (request) => {
      const value = request.recipe, output = { width: value.outputWidth, height: value.outputHeight }
      const layerIndex = request.selectedId ? stateRef.current.present.ids.indexOf(request.selectedId) : -1
      const layer = value.layers[layerIndex]
      if (point.x < 0 || point.y < 0 || point.x >= output.width || point.y >= output.height) throw new Error('请点击画布内部取样')
      if (request.tool === 'bucket') { const targetError = layerPaintTargetError(layer); if (targetError) throw new Error(targetError) }
      if (!sampler.current) throw new Error('预览尚未就绪，请稍后取样')
      const pixels = await sampler.current.samplePixels({ source: sampleSource, layerIndex }, request.controller.signal)
      if (pixels.width !== output.width || pixels.height !== output.height) throw new Error('取样尺寸已变化，请重新选择')
      const domain = request.tool === 'bucket' && request.selection ? await rasterizeCanvasSelection(request.selection, output, request.controller.signal) : undefined
      const raster = await selectLayerRasterColors({ width: pixels.width, height: pixels.height, rgba: pixels.data, seed: { x: Math.floor(point.x), y: Math.floor(point.y) }, tolerance, contiguous: request.tool === 'bucket' || (request.tool === 'select-wand' && !allSameColor), ...(domain ? { domain } : {}) }, { signal: request.controller.signal })
      const next: LayerCanvasSelection = { kind: 'raster', raster, inverted: false }
      const offset = (Math.floor(point.y) * pixels.width + Math.floor(point.x)) * 4
      const color = `#${Array.from(pixels.data.slice(offset, offset + 4), (channel) => channel.toString(16).padStart(2, '0')).join('')}`
      if (request.tool === 'bucket') {
        if (!request.selectedId || !raster.runs.length) throw new Error('点击处不在可填充选区中，图层未修改')
        const selection = { ...next, ...(request.selection?.featherRadius ? { featherRadius: request.selection.featherRadius } : {}) }
        const current = finishLayerEditorTransaction(stateRef.current)
        return { state: appendEditorLayerFill(current, request.selectedId, paintSettings.color, paintSettings.opacity, selection), color, status: `已填充连通区域 ${canvasRasterSelectionCount(next)} 像素，可一次撤销` }
      }
      const selection = await combineCanvasSelections(request.selection, next, mode, output, request.controller.signal)
      return { selection, color, status: `已选择 ${selection.kind === 'raster' ? canvasRasterSelectionCount(selection) : raster.runs.length} 像素；绿色区域为当前选区` }
    })
  }

  function completeSelection(next: LayerCanvasSelection, previous: LayerCanvasSelection | null, mode: LayerSelectionCombination) {
    setSelection(previous)
    if (mode === 'replace') { changeSelection(next); return }
    void runPixelJob('正在组合选区…', async (request) => ({ selection: await combineCanvasSelections(request.selection, next, mode, { width: request.recipe.outputWidth, height: request.recipe.outputHeight }, request.controller.signal), status: '选区已组合，图层内容未修改' }))
  }

  function fillLayer() {
    cancelSampling(); cancelPaint(); cancelSelection()
    const current = finishLayerEditorTransaction(stateRef.current), id = current.present.selectedId
    try {
      if (!id) throw new Error('请先选择图层，或新建空白绘画层')
      const effective = editorLayerEffectiveState(current.present, id)
      if (effective.locked || !effective.visible) throw new Error('当前图层或上级编组已锁定或隐藏，请先恢复后填充')
      const next = appendEditorLayerFill(current, id, paintSettings.color, paintSettings.opacity, selection)
      stateRef.current = next; setState(next); setError(''); setStatus(selection ? '已填充选区，可撤销' : '已填充当前图层，可撤销')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '填充失败，请重试') }
  }

  function adjustSelection(amount: number) {
    if (!selection) return
    if (selection.kind === 'raster') {
      if (Math.abs(amount) > 64) { setError('像素选区单次扩展或收缩最多 64 像素，请减小距离'); return }
      void runPixelJob('正在调整像素选区…', async (request) => {
        if (request.selection?.kind !== 'raster') throw new Error('当前像素选区已变化，请重试')
        return { selection: await resizeCanvasRasterSelection(request.selection, amount, request.controller.signal), status: `已${amount > 0 ? '扩展' : '收缩'}像素选区 ${Math.abs(amount)} px` }
      })
      return
    }
    cancelSampling()
    try {
      setSelection(adjustCanvasSelection(selection, { width: recipe.outputWidth, height: recipe.outputHeight }, amount), true)
      setError(''); setStatus(`${amount > 0 ? '已扩展' : '已收缩'}选区 ${Math.abs(amount)} px`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '选区调整失败') }
  }

  function setSelectionFeather(radius: number) {
    if (!selection) return
    cancelSampling()
    setSelection({ ...selection, featherRadius: radius || undefined }, true); setError(''); setStatus(radius ? `选区羽化 ${radius} px，仅影响之后的编辑` : '已取消选区羽化')
  }

  function outlineSelection(settings = outline) {
    cancelSampling(); cancelPaint(); cancelSelection()
    try {
      const current = finishLayerEditorTransaction(stateRef.current), id = current.present.selectedId
      if (!id || !selectionRef.current) throw new Error('请先选择图层并创建选区')
      const next = appendEditorLayerOutline(current, id, settings, selectionRef.current)
      stateRef.current = next; setState(next); setError(''); setStatus(`已为选区描边 ${settings.width} px，可一次撤销`)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '选区描边失败，请重试') }
  }

  function previewPaint(start: PaintGesture) {
    if (paintFrame.current !== null) return
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null
      if (paintGesture.current === start) setTransient({ id: start.id, stroke: structuredClone(start.stroke) })
    })
  }

  function appendPoint(start: PaintGesture, clientX: number, clientY: number, force = false): boolean {
    const world = pointAt(clientX, clientY)
    if (!world) return true
    const point = outputPointToLayerPoint(start.layer, { width: start.recipe.outputWidth, height: start.recipe.outputHeight }, world)
    if (!shouldAppendPaintPoint(start.stroke, point, force)) return true
    if (start.stroke.points.length >= start.maxPoints) { cancelPaint(); setError('路径点已达到容量，本次笔迹已取消。请撤销部分笔迹或拆分图层节点'); return false }
    start.stroke.points.push(point)
    return true
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (cropSessionRef.current) return
    if (event.button !== 0 || quickGesture.current || paintGesture.current || selectionGesture.current || gesture.current || gradientGesture.current || penGesture.current) return
    event.preventDefault(); event.stopPropagation(); stage.current?.focus()
    cancelExport()
    const current = finishLayerEditorTransaction(stateRef.current), point = pointAt(event.clientX, event.clientY)
    if (!point) return
    if (current.present.selectedId && ['gradient', 'brush', 'eraser', 'blur', 'sharpen', 'fill', 'bucket'].includes(tool)) {
      const effective = editorLayerEffectiveState(current.present, current.present.selectedId)
      if (effective.locked || !effective.visible) { setError('当前图层或上级编组已锁定或隐藏，请先恢复后编辑'); return }
    }
    if (tool === 'select-quick') { beginQuickSelection(point, event.pointerId, event); if (quickGesture.current) event.currentTarget.setPointerCapture(event.pointerId); return }
    if (tool === 'picker') { void pickColor(point); return }
    if (tool === 'select-color-range') { void previewColorRange(point); return }
    if (pixelTool) { void selectPixels(point, layerSelectionCombination(combination, event)); return }
    if (tool === 'fill') { fillLayer(); return }
    cancelSampling()
    if (tool === 'pen') {
      addPenAnchor(point, event.pointerId)
      if (penGesture.current) event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (tool === 'gradient') {
      const id = current.present.selectedId, layer = current.present.recipe.layers[id ? current.present.ids.indexOf(id) : -1]
      const targetError = layerPaintTargetError(layer)
      if (targetError || !id) { setError(targetError || '请先选择图层'); return }
      if (remainingLayerPaintBudget(current.present.recipe).operations < 1) { setError('绘画容量已满，请撤销部分编辑再添加渐变'); return }
      const start: GradientGesture = { pointerId: event.pointerId, id, layer, recipe: current.present.recipe, selectedId: id, sourcesKey: sourcesKeyRef.current, selection: selectionRef.current, from: point, to: point, settings: { startColor: paintSettings.color, endColor: backgroundColor, opacity: paintSettings.opacity } }
      gradientGesture.current = start; setGradientGuide({ from: point, to: point }); setError(''); setStatus('拖动确定渐变方向与长度，松开一次应用；Escape 取消')
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (tool === 'brush' || tool === 'eraser' || tool === 'blur' || tool === 'sharpen') {
      const id = current.present.selectedId, layer = current.present.recipe.layers[id ? current.present.ids.indexOf(id) : -1]
      const targetError = layerPaintTargetError(layer), budget = remainingLayerPaintBudget(current.present.recipe)
      if (targetError || !id) { setError(targetError || '请先选择图层'); return }
      if (budget.operations < 1 || budget.points < 1) { setError('绘画容量已满，请撤销部分笔迹或拆分图层节点'); return }
      const filtering = tool === 'blur' || tool === 'sharpen'
      if (filtering) {
        try { assertLayerFilterSize(current.present.recipe.outputWidth, current.present.recipe.outputHeight) } catch (cause) { setError(cause instanceof Error ? cause.message : '图层尺寸不支持局部滤镜'); return }
        if (!filterSettings.strength) { setStatus('滤镜强度为 0，图层没有改变'); return }
      }
      const stroke = filtering ? createLayerFilterStroke(layer, current.present.recipe, filterSettings, tool, point, selection) : createLayerPaintStroke(layer, current.present.recipe, paintSettings, tool === 'eraser' ? 'erase' : 'paint', point, selection)
      const start: PaintGesture = { pointerId: event.pointerId, id, layer, recipe: current.present.recipe, maxPoints: budget.points, sourcesKey: sourcesKeyRef.current, stroke }
      paintGesture.current = start; stateRef.current = current; setState(current); setError(''); previewPaint(start)
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    if (tool === 'select-rectangle' || tool === 'select-ellipse') {
      selectionGesture.current = { pointerId: event.pointerId, start: point, kind: tool === 'select-ellipse' ? 'ellipse' : 'rectangle', previous: selection, combination: layerSelectionCombination(combination, event) }
      setSelection(null); setError(''); event.currentTarget.setPointerCapture(event.pointerId)
      return
    }
    const target = event.target instanceof Element ? event.target : null
    const item = target?.closest('[data-layer-index]'), index = item ? Number(item.getAttribute('data-layer-index')) : -1
    const id = current.present.ids[index], layer = current.present.recipe.layers[index]
    if (!id || !layer) { selectLayer(null); return }
    if (event.ctrlKey || event.metaKey || event.shiftKey) { selectLayer(id, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey }); return }
    const alreadySelected = selectedEditorLayerIds(current.present), primaryGroup = selectedEditorGroup(current.present)
    if (event.detail > 1 || !alreadySelected.includes(id) || !primaryGroup && alreadySelected.length < 2) selectLayer(id)
    else { closeLayerMerge(); setState(current) }
    const active = stateRef.current, selectedIds = selectedEditorLayerIds(active.present)
    if (selectedIds.some((id) => editorLayerEffectiveState(active.present, id).locked)) { setError('所选包含锁定图层，请先解锁；整组选层没有移动'); return }
    const bounds = svg.current?.getBoundingClientRect()
    if (!bounds?.width || !bounds.height) return
    const handle = target?.closest('[data-layer-handle]')?.getAttribute('data-layer-handle') as LayerResizeHandle | null
    const snapshot = beginLayerEditorTransaction(active)
    const selectedGroup = selectedEditorGroup(snapshot.present), groupRow = selectedGroup ? editorLayerTreeRows(snapshot.present).find((row) => row.id === selectedGroup.id) : undefined
    const groupId = selectedGroup && groupRow?.leafIds.length === selectedIds.length && groupRow.leafIds.every((id) => selectedIds.includes(id)) ? selectedGroup.id : undefined
    gesture.current = { ...(groupId ? { groupId } : {}), pointerId: event.pointerId, id, layer: structuredClone(layer), ...(handle ? { handle } : {}), x: event.clientX, y: event.clientY, width: bounds.width, height: bounds.height, output: { outputWidth: recipe.outputWidth, outputHeight: recipe.outputHeight, ...(recipe.documentFrame ? { documentFrame: recipe.documentFrame } : {}) }, snapshot, selectedIds }
    setState(snapshot)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (quickGesture.current) {
      if (!isLayerGesturePointer(quickGesture.current, event.pointerId)) return
      event.preventDefault(); event.stopPropagation()
      const point = pointAt(event.clientX, event.clientY)
      if (point) moveQuickSelection(point)
      return
    }
    if (gradientGesture.current) {
      if (!isLayerGesturePointer(gradientGesture.current, event.pointerId)) return
      event.preventDefault(); event.stopPropagation()
      const point = pointAt(event.clientX, event.clientY)
      if (point) { gradientGesture.current.to = point; previewGradient(gradientGesture.current) }
      return
    }
    if (penGesture.current) {
      if (!isLayerGesturePointer(penGesture.current, event.pointerId)) return
      event.preventDefault(); event.stopPropagation()
      const point = pointAt(event.clientX, event.clientY)
      if (point) movePenHandle(point)
      return
    }
    const painting = paintGesture.current, selecting = selectionGesture.current
    if (painting) {
      if (!isLayerGesturePointer(painting, event.pointerId)) return
      event.preventDefault(); event.stopPropagation()
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? []
      for (const sample of samples) if (!appendPoint(painting, sample.clientX, sample.clientY)) return
      if (appendPoint(painting, event.clientX, event.clientY)) previewPaint(painting)
      return
    }
    if (selecting) {
      if (!isLayerGesturePointer(selecting, event.pointerId)) return
      event.preventDefault(); event.stopPropagation()
      const point = pointAt(event.clientX, event.clientY)
      if (point) setSelection(buildCanvasSelection(selecting.start, point, selecting.kind, { width: recipe.outputWidth, height: recipe.outputHeight }, event.shiftKey))
      return
    }
    const start = gesture.current
    if (!start || !isLayerGesturePointer(start, event.pointerId)) return
    event.preventDefault(); event.stopPropagation()
    const dx = (event.clientX - start.x) / start.width * start.output.outputWidth, dy = (event.clientY - start.y) / start.height * start.output.outputHeight
    if (!start.handle && start.snapshot && start.selectedIds) {
      try { setState(start.groupId ? moveEditorGroup(start.snapshot, start.groupId, dx, dy) : moveEditorLayers(start.snapshot, start.selectedIds, dx, dy)) } catch (cause) { finish(true); setError(cause instanceof Error ? cause.message : '所选图层未移动') }
    } else {
      const patch = start.handle ? resizeEditorLayer(start.layer, start.handle, dx, dy, start.output, event.shiftKey) : moveEditorLayer(start.layer, dx, dy, start.output)
      setState((current) => patchEditorLayer(current, start.id, patch))
    }
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    if (quickGesture.current) {
      if (!isLayerGesturePointer(quickGesture.current, event.pointerId)) return
      event.preventDefault(); event.stopPropagation()
      const point = pointAt(event.clientX, event.clientY)
      if (point) moveQuickSelection(point, true)
      const active = quickGesture.current
      quickGesture.current = null; setQuickGuide(null)
      if (active && point) void completeQuickSelection(active)
      else active?.request.controller.abort()
      return
    }
    const gradient = gradientGesture.current
    if (gradient && isLayerGesturePointer(gradient, event.pointerId)) {
      event.preventDefault(); event.stopPropagation()
      const point = pointAt(event.clientX, event.clientY)
      cancelGradient()
      try {
        if (!point || !hasLayerGradientDistance(gradient.from, point)) { setStatus('渐变长度不足，图层未修改'); return }
        if (!isCurrentLayerVectorScope(gradient, stateRef.current.present, sourcesKeyRef.current, selectionRef.current)) throw new Error('画布已变化，本次渐变已取消')
        const operation = createLayerGradient(gradient.layer, gradient.recipe, gradient.settings, gradient.from, point, gradient.selection)
        const next = appendEditorLayerOperation(finishLayerEditorTransaction(stateRef.current), gradient.id, operation)
        stateRef.current = next; setState(next); setError(''); setStatus('已应用线性渐变，可一次撤销')
      } catch (cause) { setError(cause instanceof Error ? cause.message : '渐变未保存，原图层已保留') }
      return
    }
    if (penGesture.current && isLayerGesturePointer(penGesture.current, event.pointerId)) {
      event.preventDefault(); event.stopPropagation()
      const point = pointAt(event.clientX, event.clientY)
      if (point) movePenHandle(point)
      penGesture.current = null
      return
    }
    const painting = paintGesture.current, selecting = selectionGesture.current
    if (painting && isLayerGesturePointer(painting, event.pointerId)) {
      event.preventDefault(); event.stopPropagation()
      if (!appendPoint(painting, event.clientX, event.clientY, true)) return
      cancelPaint()
      try {
        const current = finishLayerEditorTransaction(stateRef.current), layer = current.present.recipe.layers[current.present.ids.indexOf(painting.id)]
        if (current.present.selectedId !== painting.id || painting.sourcesKey !== sourcesKeyRef.current || layer !== painting.layer || current.present.recipe.outputWidth !== painting.recipe.outputWidth || current.present.recipe.outputHeight !== painting.recipe.outputHeight) throw new Error('绘制期间图层已变化，本次笔迹已取消')
        const next = appendEditorPaintStroke(current, painting.id, painting.stroke)
        stateRef.current = next; setState(next); setError('')
      } catch (cause) { setError(cause instanceof Error ? cause.message : '笔迹未保存，请重试') }
    } else if (selecting && isLayerGesturePointer(selecting, event.pointerId)) {
      const point = pointAt(event.clientX, event.clientY)
      selectionGesture.current = null
      const next = point && buildCanvasSelection(selecting.start, point, selecting.kind, { width: recipe.outputWidth, height: recipe.outputHeight }, event.shiftKey)
      if (next) completeSelection(next, selecting.previous, selecting.combination)
      else setSelection(selecting.previous)
    } else if (isLayerGesturePointer(gesture.current, event.pointerId)) finish()
  }

  function cancelGesture(event?: PointerEvent<HTMLDivElement>) {
    if (event && ![quickGesture.current, paintGesture.current, selectionGesture.current, gesture.current, gradientGesture.current, penGesture.current].some((active) => isLayerGesturePointer(active, event.pointerId))) return
    cancelQuickGesture(); cancelPaint(); cancelSelection(); cancelVectorTools(); if (gesture.current) finish(true)
  }

  function interruptForViewport() {
    cancelDocumentCropGesture()
    cancelSampling()
    // Keep an idle pen path intact while inspecting another part of the image.
    if ([quickGesture.current, paintGesture.current, selectionGesture.current, gesture.current, gradientGesture.current, penGesture.current].some(Boolean)) cancelGesture()
  }

  function applyMask() {
    cancelSampling()
    if (!selected || !selection || !selectedId) return
    const targetError = layerPaintTargetError(selected)
    if (targetError) { setError(targetError); return }
    try {
      const effective = editorLayerEffectiveState(stateRef.current.present, selectedId)
      if (effective.locked || !effective.visible) throw new Error('当前图层或上级编组已锁定或隐藏，请先恢复后应用蒙版')
      const mask = layerSelectionSnapshot(selected, recipe, selection)
      const candidate = patchEditorLayer(finishLayerEditorTransaction(stateRef.current), selectedId, { mask })
      parseImageTransformRecipe(candidate.present.recipe)
      setState(candidate); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '选区无法转为蒙版') }
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    // The enclosing tool dialog owns Tab containment and an otherwise idle Escape.
    if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation()
    if (event.nativeEvent?.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && cropSessionRef.current) { event.preventDefault(); event.stopPropagation(); if (cropGesture.current) cancelDocumentCropGesture(); else cancelDocumentCrop(); return }
    if (event.key === 'Escape' && tool === 'select-quick' && quickGesture.current) { event.preventDefault(); event.stopPropagation(); cancelQuickGesture(); setStatus('已取消框选或修正笔触，原选区保留'); return }
    if (event.key === 'Escape' && exportRequest.current) { event.preventDefault(); event.stopPropagation(); cancelExport(); return }
    if (event.key === 'Escape' && (toolMenu || selectionAdjust || sampling.current)) { event.preventDefault(); event.stopPropagation(); if (sampling.current) cancelSampling(); else if (selectionAdjust) { setSelectionAdjust(false); selectionAdjustTrigger.current?.focus() } else { setToolMenu(null); toolMenuTrigger.current?.focus() } return }
    if (event.key === 'Escape' && tool === 'select-color-range') { event.preventDefault(); event.stopPropagation(); chooseTool('move'); setStatus('已取消色彩范围，原选区保留'); return }
    if (event.key === 'Escape' && (tool === 'gradient' && gradientGesture.current || tool === 'pen' && penDraft.current)) { event.preventDefault(); event.stopPropagation(); cancelVectorTools(); setStatus('已取消未完成的渐变或钢笔路径，图层内容保留'); return }
    if (event.key === 'Escape' && (gesture.current || paintGesture.current || selectionGesture.current)) { event.preventDefault(); event.stopPropagation(); cancelGesture(); return }
    if (event.target instanceof Element && event.target.closest('.layer-tool-popover')) {
      if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation()
        const buttons = Array.from(toolPopover.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
        const index = buttons.indexOf(event.target as HTMLButtonElement)
        buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
      }
      return
    }
    if (event.target instanceof Element && event.target.closest('.layer-selection-popover,input,textarea,select,[contenteditable="true"]')) return
    const modifier = event.metaKey || event.ctrlKey, lower = event.key.toLowerCase()
    if (!modifier && !event.altKey && lower === 'c') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) toggleDocumentCrop(); return }
    if (cropSessionRef.current && !modifier && !event.altKey && (event.key === 'Enter' || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))) { event.preventDefault(); event.stopPropagation(); if (event.key === 'Enter') applyDocumentCrop(); else { const step = event.shiftKey ? 10 : 1; nudgeDocumentCrop('move', event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) }; return }
    if (!modifier && !event.altKey && lower === 'h') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) viewportController.current?.toggleHand(); return }
    if (tool === 'pen' && !modifier && (event.key === 'Enter' || event.key === 'Backspace')) {
      event.preventDefault(); event.stopPropagation()
      if (event.key === 'Enter') completePen()
      else if (penDraft.current) { penGesture.current = null; const next = { ...penDraft.current, points: penDraft.current.points.slice(0, -1) }; penDraft.current = next.points.length ? next : null; setPenAnchors(next.points); setStatus('已移除末尾锚点，已保存的图层未修改') }
      return
    }
    if (!modifier && (lower === 'x' || lower === 'd')) { event.preventDefault(); swapColors(lower === 'd'); return }
    if (modifier && (lower === 'z' || lower === 'y')) {
      event.preventDefault(); event.stopPropagation()
      history(lower === 'y' || event.shiftKey)
      return
    }
    if (paintGesture.current || selectionGesture.current || (tool === 'gradient' && gradientGesture.current)) return
    if (modifier && lower === 'd' && selection) { event.preventDefault(); event.stopPropagation(); changeSelection(null); return }
    if (modifier && event.shiftKey && lower === 'i' && selection) { event.preventDefault(); event.stopPropagation(); changeSelection({ ...selection, inverted: !selection.inverted }); return }
    if (!modifier && ['v', 'b', 'e', 'm', 'w', 'i', 'g', 'p', 'r'].includes(lower)) { event.preventDefault(); chooseTool(lower === 'r' ? event.shiftKey ? filterMode === 'blur' ? 'sharpen' : 'blur' : filterMode : lower === 'p' ? 'pen' : lower === 'b' ? 'brush' : lower === 'e' ? 'eraser' : lower === 'm' ? 'select-rectangle' : lower === 'w' ? event.shiftKey ? 'select-quick' : 'select-wand' : lower === 'i' ? 'picker' : lower === 'g' ? event.shiftKey ? 'fill' : 'bucket' : 'move'); return }
    if (modifier && lower === 'a') { event.preventDefault(); selectAllLayers(); return }
    if (modifier && lower === 'g') { event.preventDefault(); event.stopPropagation(); if (!event.repeat) performGroupAction(event.shiftKey ? 'ungroup' : 'group'); return }
    if (!selectedId && !selectedGroup) return
    if (modifier && lower === 'd') { event.preventDefault(); event.stopPropagation(); gesture.current = null; performLayerBatch('duplicate'); return }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); event.stopPropagation(); gesture.current = null; performLayerBatch('delete'); return }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    cancelExport()
    event.preventDefault(); event.stopPropagation()
    const step = event.shiftKey ? 10 : 1, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0
    try { setState((current) => moveSelectedEditorLayers(beginLayerEditorTransaction(current), dx, dy)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : '所选图层未移动') }
  }

  function apply() {
    closeLayerMerge()
    if (cropSessionRef.current) { setError('请先应用或取消文档裁剪，再应用图层'); return }
    if (penDraft.current || gradientGesture.current) { setError('请先完成或取消当前钢笔路径与渐变，再应用图层'); return }
    cancelSampling(); cancelExport(); cancelGesture()
    try {
      const parsed = parseImageTransformRecipe(finishLayerEditorTransaction(stateRef.current).present.recipe)
      if (parsed.kind !== 'layer') throw new Error('图层参数无效')
      // Compare the materialized opening document: opening an implicit layer recipe
      // and changing only the view or selection must not dirty the outer graph.
      if (!importedAssetsRef.current.length && sourcesKeyRef.current === initialApplySnapshot.current.sourcesKey && JSON.stringify(parsed) === JSON.stringify(parseImageTransformRecipe(initialApplySnapshot.current.recipe))) { onClose(); return }
      const missing = parsed.layers.find((layer) => !layer.content && !images[layer.sourceIndex]?.asset.localUrl)
      if (missing) throw new Error('有图片图层缺少来源，请重新选择素材或删除该层')
      if (importedAssetsRef.current.length) {
        if (!onApplyWithImports) throw new Error('当前环境暂不支持应用导入的图层，请保留素材并重新打开编辑器')
        onApplyWithImports({ recipe: parsed, initialRecipe: initialImportRecipe.current, baseSourceAssetIds: initialImportSourceIds.current, importedAssets: importedAssetsRef.current })
      } else onApply(parsed)
      onClose()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '图层参数无效，请检查后重试') }
  }

  return <><div className="layer-editor nodrag nopan nowheel" inert={psdImportOpen || !!colorGradeSession || !!liquifySession || !!mergeSession || undefined} onPointerDownCapture={(event) => { const target = event.target instanceof Element ? event.target : null; if (!target?.closest('.layer-editor-tools,.layer-tool-popover')) setToolMenu(null); if (!target?.closest('.layer-editor-selection-options,.layer-selection-popover')) setSelectionAdjust(false) }} onKeyDown={keyboard} onKeyUp={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) && !(event.target instanceof Element && event.target.closest('input,textarea,select'))) finish() }}>
    <div className="layer-editor-topbar"><span><Layers3 size={15} /><strong>图层工作区</strong><small>{recipe.layers.length} / {maximumImageTransformInputs} 层</small></span><div><button type="button" disabled={!!cropSession || !selected || selectedLocked || !selectedVisible || picking || exporting || !!penAnchors.length || !!gradientGuide} onClick={openColorGrade}>图像调整</button><button type="button" disabled={!!cropSession || !selected || selectedLocked || !selectedVisible || picking || exporting || !!penAnchors.length || !!gradientGuide} onClick={openLiquify}>液化</button><button type="button" disabled={!!cropSession || !selected || selectedLocked || !selectedVisible || picking || exporting || !!penAnchors.length || !!gradientGuide} onClick={openWholeFilter}>图层滤镜</button><ToolButton label="撤销图层或选区修改" disabled={!state.past.length && !state.transaction} onClick={() => history()}><Undo2 size={16} /></ToolButton><ToolButton label="重做图层或选区修改" disabled={!state.future.length} onClick={() => history(true)}><Redo2 size={16} /></ToolButton></div></div>
    <div className="layer-editor-layout">
      <nav className="layer-editor-tools" aria-label="图层绘制工具">
        <ToolButton label="裁剪文档（C）" pressed={!!cropSession && !viewportHand} onClick={toggleDocumentCrop}><Crop size={19} /></ToolButton>
        <ToolButton label="平移画布（H）" pressed={viewportHand} onClick={() => viewportController.current?.toggleHand()}><Hand size={19} /></ToolButton>
        <ToolButton label="选择和移动图层" pressed={tool === 'move' && !viewportHand && !cropSession} onClick={() => chooseTool('move')}><MousePointer2 size={19} /></ToolButton>
        <ToolButton label="画笔（B）" pressed={tool === 'brush' && !viewportHand && !cropSession} onClick={() => chooseTool('brush')}><Brush size={19} /></ToolButton>
        <ToolButton label="擦除当前图层（E）" pressed={tool === 'eraser' && !viewportHand && !cropSession} onClick={() => chooseTool('eraser')}><Eraser size={19} /></ToolButton>
        <ToolButton label="钢笔路径（P）" pressed={tool === 'pen' && !viewportHand && !cropSession} onClick={() => chooseTool('pen')}><PenTool size={19} /></ToolButton>
        <button type="button" aria-label="选框工具" title="选框工具（M）" aria-haspopup="true" aria-expanded={toolMenu === 'selection'} aria-pressed={!viewportHand && !cropSession && tool.startsWith('select-')} onClick={(event) => { toolMenuTrigger.current = event.currentTarget; setToolMenu(toolMenu === 'selection' ? null : 'selection') }}>{tool === 'select-wand' || tool === 'select-color-range' || tool === 'select-quick' ? <WandSparkles size={19} /> : tool === 'select-ellipse' ? <Circle size={19} /> : <Scan size={19} />}<span className="layer-tool-caret">▾</span></button>
        <ToolButton label="吸管取色（I）" pressed={tool === 'picker' && !viewportHand && !cropSession} onClick={() => chooseTool('picker')}><Pipette size={19} /></ToolButton>
        <button type="button" aria-label="填充工具（G）" title="填充工具（G）" aria-haspopup="true" aria-expanded={toolMenu === 'fill'} aria-pressed={!viewportHand && !cropSession && (tool === 'fill' || tool === 'bucket' || tool === 'gradient')} onClick={(event) => { toolMenuTrigger.current = event.currentTarget; setToolMenu(toolMenu === 'fill' ? null : 'fill') }}>{tool === 'gradient' ? <Blend size={19} /> : <PaintBucket size={19} />}<span className="layer-tool-caret">▾</span></button>
        <hr /><button type="button" aria-label="新建图层" title="新建图层" aria-haspopup="true" aria-expanded={toolMenu === 'new-layer'} onClick={(event) => { toolMenuTrigger.current = event.currentTarget; setToolMenu(toolMenu === 'new-layer' ? null : 'new-layer') }}><Plus size={19} /></button>
        <button type="button" aria-label="滤镜工具（R，展开选择模糊笔、锐化笔、液化或整层滤镜）" title="滤镜工具（R / Shift+R 切换局部笔）" aria-haspopup="true" aria-expanded={toolMenu === 'filter'} aria-pressed={!viewportHand && !cropSession && (tool === 'blur' || tool === 'sharpen')} onClick={() => chooseTool(filterMode)} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); toolMenuTrigger.current = event.currentTarget; setToolMenu(toolMenu === 'filter' ? null : 'filter') }}><Blend size={19} /><span className="layer-tool-caret" onClick={(event) => { event.stopPropagation(); toolMenuTrigger.current = event.currentTarget.parentElement as HTMLButtonElement; setToolMenu(toolMenu === 'filter' ? null : 'filter') }}>▾</span></button>
      </nav>
      {toolMenu && <div ref={toolPopover} className="layer-tool-popover" role="group" aria-label={toolMenu === 'selection' ? '选择工具' : toolMenu === 'filter' ? '滤镜工具' : toolMenu === 'fill' ? '填充方式' : '新建图层类型'}>{toolMenu === 'filter' ? <><button type="button" disabled={!!cropSession || !selected || selectedLocked || !selectedVisible || picking || exporting || !!penAnchors.length || !!gradientGuide} onClick={openWholeFilter}>图层滤镜</button><button type="button" onClick={() => chooseTool('blur')}><Blend size={16} />模糊笔</button><button type="button" onClick={() => chooseTool('sharpen')}><Scan size={16} />锐化笔</button><button type="button" disabled={!!cropSession || !selected || selectedLocked || !selectedVisible || picking || exporting || !!penAnchors.length || !!gradientGuide} onClick={openLiquify}><WandSparkles size={16} />液化图层</button><small>仅修改当前图层；液化在独立预览中逐笔编辑。</small></> : toolMenu === 'selection' ? <><button type="button" onClick={() => chooseTool('select-rectangle')}><Scan size={16} />矩形选区（M）</button><button type="button" onClick={() => chooseTool('select-ellipse')}><Circle size={16} />椭圆选区</button><button type="button" onClick={() => chooseTool('select-wand')}><WandSparkles size={16} />魔棒（W）</button><button type="button" onClick={() => chooseTool('select-quick')}><WandSparkles size={16} />快速选择（Shift+W）</button><button type="button" onClick={() => chooseTool('select-color-range')}><Pipette size={16} />色彩范围 · 不限连续</button></> : toolMenu === 'fill' ? <><button type="button" onClick={() => chooseTool('bucket')}><PaintBucket size={16} />连通油漆桶（G）</button><button type="button" onClick={() => chooseTool('fill')}><Square size={16} />填充图层或选区（Shift G）</button><button type="button" onClick={() => chooseTool('gradient')}><Blend size={16} />线性渐变 · 拖拽绘制</button><small>油漆桶只填点击处相连的相似颜色。</small></> : <><button type="button" disabled={full} onClick={() => add('paint')}><Brush size={16} />新建空白绘画层</button><button type="button" disabled={full} onClick={() => add('text')}><Type size={16} />添加文字图层</button><button type="button" disabled={full} onClick={() => add('rectangle')}><Square size={16} />添加矩形图层</button><button type="button" disabled={full} onClick={() => add('ellipse')}><Circle size={16} />添加椭圆图层</button><button type="button" disabled={full || !images.length} onClick={() => add('image')}><ImagePlus size={16} />添加图片图层</button>{full && <small>已达到 {maximumImageTransformInputs} 层上限</small>}</>}</div>}
      <section className="layer-editor-center" aria-label="图层编辑画布">{cropSession && <div className="layer-document-crop-options" aria-label="文档裁剪参数"><strong>文档裁剪</strong><label>画面比例<select aria-label="文档裁剪比例" value={cropRatio ? `${cropRatio[0]}:${cropRatio[1]}` : 'free'} onChange={(event) => changeDocumentCropRatio(event.target.value)}><option value="free">自由</option>{['1:1', '4:3', '3:2', '16:9', '9:16'].map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}</select></label><span>原画布 {recipe.outputWidth} × {recipe.outputHeight} px</span><div className="layer-document-crop-fields">{(['x', 'y', 'width', 'height'] as const).map((key) => { const rect = cropSession.rect ?? { x: 0, y: 0, width: recipe.outputWidth, height: recipe.outputHeight }, edge = key === 'x' || key === 'width' ? recipe.outputWidth : recipe.outputHeight; return <NumberField key={key} label={{ x: '裁剪 X（像素）', y: '裁剪 Y（像素）', width: '裁剪宽度（像素）', height: '裁剪高度（像素）' }[key]} value={rect[key]} min={key === 'x' || key === 'y' ? 0 : 1} max={key === 'x' || key === 'y' ? edge - 1 : edge} onChange={(value) => changeDocumentCropField(key, value)} /> })}</div><div className="layer-document-crop-actions"><button type="button" onClick={() => updateDocumentCrop(null)}>重新框选</button><button type="button" onClick={() => updateDocumentCrop({ x: 0, y: 0, width: recipe.outputWidth, height: recipe.outputHeight })}>{cropRatio ? '最大范围' : '整幅画布'}</button><button type="button" onClick={cancelDocumentCrop}>取消裁剪</button><button type="button" className="is-primary" disabled={!cropSession.rect} onClick={applyDocumentCrop}>应用裁剪</button></div><small>拖动框选，框内移动，八个手柄调整。{cropRatio ? '锁比尺寸按整数比例块取值；手柄方向键按比例块微调。' : '方向键 1 px / Shift 10 px。'}裁剪不缩放内容，框外图层仍保留。</small></div>}{!cropSession && ['brush', 'eraser', 'fill', 'bucket', 'picker', 'gradient'].includes(tool) && <div className="layer-editor-paint-options" aria-label="绘画工具参数" onFocusCapture={(event) => { if (event.target instanceof Element && event.target.matches('input') && sampling.current) cancelSampling() }}><strong>{tool === 'brush' ? '画笔' : tool === 'eraser' ? '擦除' : tool === 'fill' ? '整层 / 选区填色' : tool === 'bucket' ? '连通油漆桶' : tool === 'gradient' ? '线性渐变' : '吸管'}</strong>{(tool === 'brush' || tool === 'eraser') && <><NumberField label="画笔大小（像素）" value={paintSettings.size} min={1} max={512} onChange={(size) => setPaintSettings((value) => ({ ...value, size }))} /><NumberField label="画笔硬度（%）" value={paintSettings.hardness * 100} min={0} max={100} onChange={(hardness) => setPaintSettings((value) => ({ ...value, hardness: hardness / 100 }))} /></>}{tool !== 'picker' && <NumberField label="工具不透明度（%）" value={paintSettings.opacity * 100} min={0} max={100} onChange={(opacity) => { cancelSampling(); cancelGradient(); setPaintSettings((value) => ({ ...value, opacity: opacity / 100 })) }} />}{tool !== 'eraser' && <ColorField label={tool === 'brush' ? '画笔颜色' : '前景色'} value={paintSettings.color} onChange={setForegroundColor} />}{tool === 'gradient' && <><ColorField label="渐变背景色" value={backgroundColor} onChange={(color) => { cancelGradient(); setBackgroundColor(color) }} /><ToolButton label="交换前景色与背景色（X）" onClick={() => swapColors()}><ArrowLeftRight size={16} /></ToolButton><button type="button" onClick={() => swapColors(true)}>重置黑白（D）</button></>}{tool === 'fill' && <button type="button" onClick={fillLayer}>{selection ? '填充选区' : '填充图层'}</button>}{tool === 'picker' && <span className="layer-tool-context">{picking ? '正在取色…' : '点击画布，采样全部可见图层的合成颜色'}{picking && <button type="button" onClick={cancelSampling}>取消取色</button>}</span>}</div>}
        {!cropSession && (tool === 'blur' || tool === 'sharpen') && <div className="layer-editor-filter-options" role="group" aria-label="局部滤镜参数"><label>工具<select aria-label="局部滤镜类型" value={tool} onChange={(event) => chooseTool(event.target.value === 'sharpen' ? 'sharpen' : 'blur')}><option value="blur">模糊笔</option><option value="sharpen">锐化笔</option></select></label><NumberField label="滤镜笔大小（像素）" value={filterSettings.size} min={1} max={512} onChange={(size) => { cancelPaint(); setFilterSettings((value) => ({ ...value, size })) }} /><NumberField label="滤镜强度（%）" value={filterSettings.strength * 100} min={0} max={100} onChange={(strength) => { cancelPaint(); setFilterSettings((value) => ({ ...value, strength: strength / 100 })) }} /><small>只处理当前图层{selection ? '的选区内' : '的涂抹区域'}；松开提交一笔，Escape 取消。按原始输出像素处理，支持当前画布尺寸。</small></div>}
        {!cropSession && tool === 'pen' && <div className="layer-editor-vector-options" aria-label="钢笔工具参数"><strong>钢笔路径</strong><ColorField label="钢笔填充" value={penStyle.fill} transparent onChange={(fill) => setPenStyle((value) => ({ ...value, fill }))} /><ColorField label="钢笔描边" value={penStyle.stroke} transparent onChange={(stroke) => setPenStyle((value) => ({ ...value, stroke }))} /><NumberField label="钢笔描边宽度（像素）" value={penStyle.strokeWidth} min={0} max={64} onChange={(strokeWidth) => setPenStyle((value) => ({ ...value, strokeWidth }))} /><div className="layer-vector-actions"><button type="button" disabled={penAnchors.length < 3} onClick={completePen}>闭合新建图层</button><button type="button" disabled={!penAnchors.length} onClick={() => { cancelPen(); setStatus('已取消钢笔草稿，原图层保留') }}>取消路径</button></div><small>{penAnchors.length} / {maximumImageLayerPathPoints} 锚点 · 点击放点，拖动创建曲线柄；Enter / 双击闭合，Backspace 删末点，Escape 取消。{selection ? '当前选区将作为新图层的可移除蒙版。' : ''}</small></div>}
        {!cropSession && tool === 'select-quick' && <div className="layer-quick-options" role="group" aria-label="快速选择前景分割">
          <div className="layer-quick-heading"><strong>快速选择</strong><span>本地前景分割</span></div>
          <div className="layer-quick-modes" role="group" aria-label="前景分割步骤">{([['region', '1 框选主体'], ['foreground', '保留前景'], ['background', '排除背景']] as const).map(([mode, label]) => <button key={mode} type="button" aria-pressed={quickMode === mode} disabled={mode !== 'region' && !activeQuickSession} title={mode !== 'region' && !activeQuickSession ? '先框住主体完成一次分割' : undefined} onClick={() => chooseQuickMode(mode)}>{label}</button>)}</div>
          <div className="layer-quick-fields"><label>取样来源<select aria-label="快速选择取样来源" value={quickSource} onChange={(event) => { cancelSampling(); const source = event.target.value as LayerQuickSampleSource; quickSourceRef.current = source; quickPixels.current = null; quickSessions.current = new WeakMap(); setQuickSource(source); setQuickMode('region') }}><option value="composite">可见图层合成</option><option value="current">当前图层</option></select></label>{quickMode !== 'region' && <NumberField label="修正笔径（原始像素）" value={quickDiameter} min={1} max={512} onChange={(value) => { cancelSampling(); setQuickDiameter(value) }} />}</div>
          <small>{quickMode === 'region' ? '框住主体并留出少量背景，松开自动分割。每框最多 100 万原始像素，不降低精度。' : '在虚线框内涂抹：绿色保留前景，红色排除背景；松开重新分割，每笔可撤销。框边缘与透明像素始终是背景。'}</small>
          {activeQuickSession && <small>处理框 {activeQuickSession.region.width} × {activeQuickSession.region.height} px · 已修正 {activeQuickSession.strokes.length} 笔 · 选区仅保留在当前编辑会话</small>}
        </div>}
        {!cropSession && pixelTool && <div className="layer-editor-pixel-options" role={tool === 'select-color-range' ? 'dialog' : 'group'} aria-label={tool === 'select-color-range' ? '色彩范围参数与预览' : tool === 'bucket' ? '连通填色参数' : '魔棒参数'}>
          <strong>{tool === 'select-color-range' ? '色彩范围' : tool === 'bucket' ? '连通区域' : '魔棒'}</strong>
          <NumberField label="颜色容差" value={tolerance} min={0} max={255} onChange={(value) => { cancelSampling(); setTolerance(value) }} />
          <label>取样来源<select aria-label="像素取样来源" value={sampleSource} onChange={(event) => { cancelSampling(); setSampleSource(event.target.value as 'current' | 'composite') }}><option value="current">当前图层</option><option value="composite">可见图层合成</option></select></label>
          {tool === 'select-wand' && <label className="layer-editor-check"><input type="checkbox" checked={allSameColor} onChange={(event) => { cancelSampling(); setAllSameColor(event.target.checked) }} />所有同色（不限连续）</label>}
          {tool === 'select-color-range' && <><ColorField label="取样色" value={rangeColor} onChange={(value) => { cancelSampling(); setRangeColor(value) }} /><div className="layer-color-range-actions"><button type="button" disabled={picking} onClick={() => void previewColorRange()}>预览选区</button><button type="button" onClick={() => { chooseTool('move'); setStatus('已取消色彩范围，原选区保留') }}>取消</button><button type="button" className="is-primary" disabled={picking || !rangePreviewCurrent} onClick={applyColorRange}>应用选区</button></div><small className="layer-color-range-result">{rangePreviewCurrent && rangePreview?.kind === 'raster' ? `待应用预览：${canvasRasterSelectionCount(rangePreview)} 像素` : '更改取样色或容差后会重新预览；当前选区尚未修改'}</small></>}
          {sampledColor && <span className="layer-pixel-sample"><i style={{ background: sampledColor }} />取样色 {sampledColor}{sampledColor.endsWith('00') ? ' · 透明' : ''}</span>}
          <small>{tool === 'bucket' ? '点击连通区域 → 前景色填充；只修改当前图层' : tool === 'select-color-range' ? '可填写 HEX 或点击画布取样；绿色区域为待应用预览，取消保留原选区' : '点击相似颜色区域 · Shift 添加 · Alt 减去'}</small>
        </div>}
        {picking && <div className="layer-editor-pixel-progress" role="status"><span>{status || '正在处理像素…'}</span><button type="button" onClick={cancelSampling}>取消处理</button></div>}
        {!cropSession && (selection || tool.startsWith('select-')) && <div className="layer-editor-selection-options" aria-label="选区操作"><span>{selection ? `${selection.kind === 'raster' ? `像素选区 · ${canvasRasterSelectionCount(selection)} px` : selection.kind === 'ellipse' ? '椭圆选区' : '矩形选区'}${selection.inverted ? ' · 已反选' : ''}${selection.featherRadius ? ` · 羽化 ${selection.featherRadius} px` : ''}` : tool === 'select-quick' ? '框住主体 → 前景分割' : pixelTool ? '点击画布取样创建选区' : '拖动创建选区 · Shift 等比'}</span><label className="layer-selection-combination">组合<select aria-label="选区组合方式" value={combination} onChange={(event) => { cancelSampling(); setCombination(event.target.value as LayerSelectionCombination); if (tool === 'select-quick') { quickSessions.current = new WeakMap(); setQuickMode('region'); setStatus('组合方式已更改，请重新框选主体；原选区保留') } }}><option value="replace">替换</option><option value="add">添加</option><option value="subtract">减去</option><option value="intersect">交集</option></select></label><button type="button" disabled={!selection} onClick={() => { changeSelection(null); setSelectionAdjust(false) }}>取消选区</button><button type="button" disabled={!selection} onClick={() => changeSelection((value) => value ? { ...value, inverted: !value.inverted } : value)}>反选</button><button ref={selectionAdjustTrigger} type="button" disabled={!selection} aria-expanded={selectionAdjust} onClick={() => { if (!selectionAdjust) setFeatherRadius(selection?.featherRadius ?? 5); setSelectionAdjust(!selectionAdjust) }}>调整选区</button><button type="button" disabled={!selection || !selected || selected.locked || !selected.visible} title={selected?.mask ? '用当前选区替换此层已有蒙版；可撤销' : '将当前选区写入所选图层蒙版'} onClick={applyMask}>{selected?.mask ? '替换当前蒙版' : '选区转蒙版'}</button></div>}
        {selectionAdjust && selection && <div ref={selectionPopover} className="layer-selection-popover" role="group" aria-label="调整选区"><header><strong>调整选区</strong><button type="button" aria-label="关闭选区调整" onClick={() => { setSelectionAdjust(false); selectionAdjustTrigger.current?.focus() }}>×</button></header><NumberField label="羽化半径（像素）" value={featherRadius} min={0} max={128} onChange={setFeatherRadius} /><div><button type="button" onClick={() => setSelectionFeather(featherRadius)}>应用羽化</button><button type="button" disabled={!selection.featherRadius} onClick={() => { setFeatherRadius(0); setSelectionFeather(0) }}>移除羽化</button></div><NumberField label="选区调整距离（像素）" value={selectionDistance} min={1} max={selection.kind === 'raster' ? 64 : 4096} onChange={setSelectionDistance} /><div><button type="button" onClick={() => adjustSelection(selectionDistance)}>扩展选区</button><button type="button" onClick={() => adjustSelection(-selectionDistance)}>收缩选区</button></div><div className="layer-selection-outline"><strong>选区描边</strong><NumberField label="选区描边宽度（像素）" value={outline.width} min={1} max={64} onChange={(width) => setOutline((value) => ({ ...value, width }))} /><label>描边位置<select aria-label="选区描边位置" value={outline.position} onChange={(event) => setOutline((value) => ({ ...value, position: event.target.value as 'inside' | 'center' | 'outside' }))}><option value="inside">内部</option><option value="center">居中</option><option value="outside">外部</option></select></label><ColorField label="选区描边颜色" value={outline.color} onChange={(color) => setOutline((value) => ({ ...value, color }))} /><NumberField label="选区描边不透明度（%）" value={outline.opacity * 100} min={0} max={100} onChange={(opacity) => setOutline((value) => ({ ...value, opacity: opacity / 100 }))} /><button type="button" disabled={!selected || selectedLocked || !selectedVisible || picking} onClick={() => outlineSelection()}>应用选区描边</button><div className="layer-outline-presets">{([{ color: '#000000', width: 2, label: '黑 2 px' }, { color: '#000000', width: 5, label: '黑 5 px' }, { color: '#ffffff', width: 5, label: '白 5 px' }] as const).map((preset) => <button type="button" key={preset.label} disabled={!selected || selectedLocked || !selectedVisible || picking} onClick={() => { const next = { ...outline, color: preset.color, width: preset.width }; setOutline(next); outlineSelection(next) }}>{preset.label}</button>)}</div></div><small>调整仅影响之后的编辑。像素选区按原始分辨率计算；过于复杂会明确拒绝，不会缩小精度。反选时扩展会缩小未选区域。</small></div>}
        <LayerEditorViewport width={recipe.outputWidth} height={recipe.outputHeight} sourcesKey={sourcesKey} controllerRef={viewportController} onInterrupt={interruptForViewport} onScaleChange={setViewportScale} onHandChange={setViewportHand}><div ref={stage} className={`layer-editor-stage layer-tool-${tool}`} tabIndex={0} role="region" aria-busy={picking} aria-label="图层画布，支持移动缩放、画笔擦除、局部模糊锐化、快速前景选择、魔棒色彩选区、连通填色、描边渐变、钢笔与吸管，方向键微调，Shift等比" style={{ '--layer-output-ratio': recipe.outputWidth / recipe.outputHeight } as CSSProperties} onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onDoubleClick={(event) => { if (!cropSessionRef.current && tool === 'pen') { event.preventDefault(); event.stopPropagation(); completePen() } }} onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture} onBlur={() => { if (!gesture.current) setState((current) => finishLayerEditorTransaction(current)) }}>
          <LayerRecipePreview recipe={recipe} onMergeReviewContextChange={mergeReviewContextChanged} fontRevision={localFontRevision} transient={transient ? { index: ids.indexOf(transient.id), stroke: transient.stroke } : undefined} images={images} svgRef={svg} samplerRef={sampler}>{displayedSelection && <LayerCanvasSelectionOverlay selection={displayedSelection} output={{ width: recipe.outputWidth, height: recipe.outputHeight }} />}{tool === 'select-quick' && (quickGuide || activeQuickSession) && <g pointerEvents="none" className="layer-quick-guide">{quickGuide?.mode === 'region' ? <rect x={Math.min(quickGuide.start.x, quickGuide.end.x)} y={Math.min(quickGuide.start.y, quickGuide.end.y)} width={Math.abs(quickGuide.end.x - quickGuide.start.x)} height={Math.abs(quickGuide.end.y - quickGuide.start.y)} /> : activeQuickSession && <rect x={activeQuickSession.region.x} y={activeQuickSession.region.y} width={activeQuickSession.region.width} height={activeQuickSession.region.height} />}{quickGuide && quickGuide.mode !== 'region' && <g fill={quickGuide.mode === 'foreground' ? '#71e1ab' : '#ff827e'} stroke={quickGuide.mode === 'foreground' ? '#71e1ab' : '#ff827e'} opacity={0.65}>{quickGuide.points.length === 1 ? <circle cx={quickGuide.points[0].x} cy={quickGuide.points[0].y} r={quickGuide.diameter / 2} stroke="none" /> : <path d={quickGuide.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')} fill="none" strokeWidth={quickGuide.diameter} strokeLinecap="round" strokeLinejoin="round" />}</g>}</g>}{gradientGuide && <g className="layer-vector-guide" pointerEvents="none"><line x1={gradientGuide.from.x} y1={gradientGuide.from.y} x2={gradientGuide.to.x} y2={gradientGuide.to.y} /><circle cx={gradientGuide.from.x} cy={gradientGuide.from.y} r={handleRadius / 3} /><circle cx={gradientGuide.to.x} cy={gradientGuide.to.y} r={handleRadius / 3} /></g>}{tool === 'pen' && penAnchors.length > 0 && <g className="layer-vector-guide" pointerEvents="none"><path d={layerPenGuidePath(penAnchors)} />{penAnchors.length >= 3 && <path className="layer-pen-closing-guide" d={layerPenGuidePath([penAnchors.at(-1)!, penAnchors[0]])} />}{penAnchors.map((anchor, anchorIndex) => <g key={anchorIndex}>{anchor.in && <><line className="layer-pen-handle" x1={anchor.x} y1={anchor.y} x2={anchor.in.x} y2={anchor.in.y} /><circle className="layer-pen-handle" cx={anchor.in.x} cy={anchor.in.y} r={handleRadius / 5} /></>}{anchor.out && <><line className="layer-pen-handle" x1={anchor.x} y1={anchor.y} x2={anchor.out.x} y2={anchor.out.y} /><circle className="layer-pen-handle" cx={anchor.out.x} cy={anchor.out.y} r={handleRadius / 5} /></>}<rect x={anchor.x - handleRadius / 5} y={anchor.y - handleRadius / 5} width={handleRadius / 2.5} height={handleRadius / 2.5} /></g>)}</g>}{!cropSession && tool === 'move' && selectedIds.filter((id) => id !== selectedId).map((id) => { const index = ids.indexOf(id), layer = recipe.layers[index]; return <g key={id} pointerEvents="none" transform={layerPreviewTransform(layer, recipe)}><rect width={layer.width * recipe.outputWidth} height={layer.height * recipe.outputHeight} fill="none" stroke={editorLayerEffectiveState(state.present, id).locked ? '#9ca7b9' : '#81b9a5'} strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray="5 4" /></g> })}{!cropSession && selectedGroup && groupBounds && tool === 'move' && <g className={`layer-editor-selection layer-editor-group-selection${selectionLocked ? ' is-locked' : ''}`} data-layer-index={ids.indexOf(groupRow?.leafIds[0] ?? '')}><rect x={groupBounds.x} y={groupBounds.y} width={groupBounds.width} height={groupBounds.height} fill="transparent" pointerEvents="stroke" stroke={selectionLocked ? '#9ca7b9' : '#b6c9ff'} strokeWidth={1.5} strokeDasharray="7 3" vectorEffect="non-scaling-stroke" /></g>}{!cropSession && selected && tool === 'move' && <g data-layer-index={index} transform={layerPreviewTransform(selected, recipe)} className={`layer-editor-selection${selectedLocked ? ' is-locked' : ''}`}><rect width={selectedWidth} height={selectedHeight} fill="none" pointerEvents="stroke" stroke={selectedLocked ? '#9ca7b9' : '#9ae6c5'} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeDasharray={selectedLocked ? '5 4' : undefined} />{!selectedLocked && selectedIds.length === 1 && (['nw', 'ne', 'sw', 'se'] as const).map((handle) => <rect key={handle} data-layer-handle={handle} x={(handle.endsWith('e') ? selectedWidth : 0) - handleRadius / 2} y={(handle.startsWith('s') ? selectedHeight : 0) - handleRadius / 2} width={handleRadius} height={handleRadius} fill="#c7ffe7" stroke="#13372a" strokeWidth={1} vectorEffect="non-scaling-stroke" />)}</g>}{cropSession && <LayerDocumentCropOverlay rect={cropSession.rect} width={recipe.outputWidth} height={recipe.outputHeight} scale={viewportScale} onStart={startDocumentCrop} onMove={moveDocumentCrop} onEnd={endDocumentCrop} onCancel={(event) => cancelDocumentCropGesture(event.pointerId)} onNudge={nudgeDocumentCrop} />}</LayerRecipePreview>
        </div></LayerEditorViewport><div className="layer-editor-stage-hint">{cropSession ? 'C 文档裁剪 · Enter 应用 · Escape 取消 · H / 空格平移 · 滚轮缩放' : tool === 'blur' || tool === 'sharpen' ? '拖动涂抹当前图层 · 松开提交一笔 · Escape取消 · Ctrl/⌘ Z撤销' : tool === 'select-quick' ? 'Shift+W 快速选择 · 框选后自动分割 · 保留 / 排除修正 · Escape 取消 · Ctrl/⌘ Z 撤销选区' : tool === 'gradient' ? (layerPaintTargetError(selected) || '前景色 → 背景色 · 拖动确定渐变方向 · X 交换 / D 重置 · 选区约束填色') : tool === 'pen' ? '点击锚点，拖动曲线柄 · Enter / 双击闭合独立图层 · Backspace 删末点 · Escape 取消' : tool === 'picker' ? '吸管读取合成颜色，取色不修改画布' : tool === 'fill' ? '点击画布或填充按钮，填充当前图层或选区' : tool === 'bucket' ? '点击连通区域 → 前景色填充 · G · Escape 取消计算' : tool === 'select-wand' || tool === 'select-color-range' ? '点击画布取样 · Shift 添加 / Alt 减去 · 绿色区域为选区 · Escape 取消计算' : tool === 'brush' || tool === 'eraser' ? (layerPaintTargetError(selected) || `${tool === 'brush' ? '绘制' : '擦除'}当前图层 · 选区约束笔迹 · Escape 取消本笔 · 每笔可独立撤销`) : tool.startsWith('select-') ? '选区只影响之后的笔迹；转为蒙版可随时移除' : selected?.locked ? '此图层已锁定，可在右侧解锁' : selectedIds.length > 1 ? `已选 ${selectedIds.length} 层 · 拖动或方向键整体移动 · 右侧属性仅修改主选图层` : selected ? '拖动移动 · 拖动角点缩放 · Shift 等比 · 方向键 1 px / Shift 10 px' : '选择图层，或从左侧添加文字和形状'}</div>
      </section>
      <aside className="layer-editor-sidebar" aria-label="图层与属性" inert={!!cropSession || undefined}>
        <section className="layer-editor-list-panel"><header><strong>图层与编组</strong><span>上方覆盖下方</span></header><LayerTree recipe={recipe} rows={treeRows} images={images} selectedIds={selectedIds} selectedId={selectedId} selectedGroupId={state.present.selectedGroupId} collapsed={collapsedGroups} name={(layerIndex) => layerName(recipe.layers[layerIndex], images, layerIndex)} onSelect={selectTreeRow} onCollapse={toggleGroupCollapse} onVisibility={(row) => toggleTreeRow(row, 'visible')} onLock={(row) => toggleTreeRow(row, 'locked')} onMoveStart={beginTreeMove} onInspectMove={inspectTreeMove} onMove={placeTreeSelection} />{!recipe.layers.length && <p className="layer-editor-empty">画布为空。新建空白绘画层，或添加文字、形状与图片开始创作；也可以应用空白画布。</p>}
          <div className="layer-editor-multi-selection"><span>{selectedGroup ? `主选编组：${selectedGroup.name} · 共选 ${selectedIds.length} 层` : selectedIds.length ? `已选 ${selectedIds.length} 层` : '未选择图层'}</span><button type="button" disabled={!ids.length} onClick={selectAllLayers}>全选</button><button type="button" disabled={!selectedIds.length} onClick={() => selectLayer(null)}>清空选择</button><small>Ctrl / ⌘ 切换选择 · Shift 连选</small></div>
          <div className="layer-editor-group-actions"><button type="button" aria-label="编组所选图层" disabled={!selectedIds.length} title="将同一层级中连续的图层或编组组成新组，保留独立编辑" onClick={() => performGroupAction('group')}><FolderPlus size={14} />编组<span>⌘ / Ctrl G</span></button><button type="button" aria-label="解散所选编组" disabled={!selectedGroup || groupAncestorLocked} title="移除编组结构并保留子图层；不会合并为图片" onClick={() => performGroupAction('ungroup')}><FolderMinus size={14} />解组</button></div>
          <div className="layer-editor-list-actions" aria-label="所选图层批量操作"><ToolButton label="图层上移" disabled={!selectedIds.length || selectionLocked || selectedSet.has(ids.at(-1) ?? '')} onClick={() => performLayerBatch('up')}><ArrowUp size={15} /></ToolButton><ToolButton label="图层下移" disabled={!selectedIds.length || selectionLocked || selectedSet.has(ids[0])} onClick={() => performLayerBatch('down')}><ArrowDown size={15} /></ToolButton><ToolButton label="复制图层" disabled={!selectedIds.length || recipe.layers.length + selectedIds.length > maximumImageTransformInputs} onClick={() => performLayerBatch('duplicate')}><Copy size={15} /></ToolButton><ToolButton label="删除图层" disabled={!selectedIds.length || selectionLocked} onClick={() => performLayerBatch('delete')}><Trash2 size={15} /></ToolButton><ToolButton label={selectionAllVisible ? '隐藏所选图层' : '显示所选图层'} disabled={!selectedIds.length} pressed={selectionAllVisible} onClick={() => performLayerBatch('visible')}>{selectionAllVisible ? <Eye size={15} /> : <EyeOff size={15} />}</ToolButton><ToolButton label={selectionAllLocked ? '解锁所选图层' : '锁定所选图层'} disabled={!selectedIds.length} pressed={selectionAllLocked} onClick={() => performLayerBatch('locked')}>{selectionAllLocked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</ToolButton></div>
          {selectionLocked && <p className="layer-editor-selection-note">所选包含锁定图层；移动、排序和删除整批保持不变。</p>}
          <button ref={mergeTrigger} type="button" className="layer-editor-merge-trigger" disabled={!!mergeReason || mergeBusy} title={mergeReason || '先核对栅格化说明，再合并所选图层'} onClick={() => openLayerMerge()}>合并所选图层</button>{mergeReason && selectedIds.length > 1 && <p className="layer-editor-selection-note">{mergeReason}</p>}
          {images.length > 0 && <label className="layer-editor-source-picker">添加图片来源<select aria-label="添加图片来源" value={Math.min(sourceIndex, images.length - 1)} onChange={(event) => setSourceIndex(Number(event.target.value))}>{images.map((image, index) => <option key={image.key} value={index}>{index + 1} · {image.label}</option>)}</select></label>}{full && <p role="status" className="layer-editor-empty">已达到 {maximumImageTransformInputs} 层上限。</p>}
        </section>
        {selectedGroup && <section className="layer-editor-properties layer-editor-group-properties" aria-label="所选编组属性" onFocusCapture={(event) => { if (event.target.matches('input')) begin() }} onBlurCapture={(event) => { if (event.target.matches('input')) setState((current) => finishLayerEditorTransaction(current)) }}><header><FolderOpen size={16} /><strong>{selectedGroup.name}</strong><span>{groupRow?.leafIds.length ?? 0} 个图层</span></header>{selectedIds.length !== groupRow?.leafIds.length && <p className="layer-editor-primary-note">下方属性仅修改主选编组；上方批量按钮操作全部所选内容。</p>}<LayerGroupNameField key={selectedGroup.id} id={selectedGroup.id} name={selectedGroup.name} onCommit={renameGroup} /><p className="layer-editor-group-mode"><strong>穿透编组</strong>保留子图层原有的混合方式，并与组外图层一起合成。编组不会栅格化；展开后仍可逐层编辑。</p>{groupBounds && <fieldset disabled={groupLocked}><legend>整体位置</legend><div className="layer-editor-fields"><NumberField label="编组 X（像素）" value={groupBounds.x} min={groupBounds.x + Math.max(...groupLayers.map((layer) => (geometryX.minPosition - layer.x) * recipe.outputWidth))} max={groupBounds.x + Math.min(...groupLayers.map((layer) => (geometryX.maxPosition - layer.x) * recipe.outputWidth))} onChange={(x) => moveGroup(x - groupBounds.x, 0)} /><NumberField label="编组 Y（像素）" value={groupBounds.y} min={groupBounds.y + Math.max(...groupLayers.map((layer) => (geometryY.minPosition - layer.y) * recipe.outputHeight))} max={groupBounds.y + Math.min(...groupLayers.map((layer) => (geometryY.maxPosition - layer.y) * recipe.outputHeight))} onChange={(y) => moveGroup(0, y - groupBounds.y)} /></div><small>边界 {Math.round(groupBounds.width)} × {Math.round(groupBounds.height)} px · 拖动组内任一成员或使用方向键整体移动。</small></fieldset>}{groupLocked && <p className="layer-editor-selection-note">编组或成员含锁定项，请先在树中解锁。组显隐与锁定不会覆盖子图层自己的设置。</p>}</section>}
        {selected && <section className="layer-editor-properties" aria-label="所选图层属性" onFocusCapture={(event) => { if (event.target.matches('input,textarea,select')) begin() }} onBlurCapture={(event) => { if (event.target.matches('input,textarea,select')) setState((current) => finishLayerEditorTransaction(current)) }}>
          {selectedLocked && !selected.locked && <p className="layer-editor-primary-note">上级编组已锁定，请先解锁编组再编辑此层。</p>}{!selectedVisible && selected.visible && <p className="layer-editor-primary-note">上级编组已隐藏；此层自己的显示设置仍保留。</p>}{selectedIds.length > 1 && <p className="layer-editor-primary-note">主选：{layerName(selected, images, index)}。下方属性、绘画和滤镜仅修改此层；批量操作使用上方按钮。</p>}
          <label>图层名称<input aria-label="图层名称" maxLength={80} value={selected.name ?? layerName(selected, images, index)} onChange={(event) => patch({ name: event.target.value })} /></label>
          <fieldset disabled={selectedLocked}><legend>位置与变换</legend><div className="layer-editor-fields"><NumberField label="图层 X（像素）" value={selected.x * recipe.outputWidth} min={geometryX.minPosition * recipe.outputWidth} max={geometryX.maxPosition * recipe.outputWidth} onChange={(x) => patch({ x: x / recipe.outputWidth })} /><NumberField label="图层 Y（像素）" value={selected.y * recipe.outputHeight} min={geometryY.minPosition * recipe.outputHeight} max={geometryY.maxPosition * recipe.outputHeight} onChange={(y) => patch({ y: y / recipe.outputHeight })} /><NumberField label="图层宽度（像素）" value={selectedWidth} min={geometryX.minSize * recipe.outputWidth} max={geometryX.maxSize * recipe.outputWidth} onChange={(width) => patch({ width: width / recipe.outputWidth })} /><NumberField label="图层高度（像素）" value={selectedHeight} min={geometryY.minSize * recipe.outputHeight} max={geometryY.maxSize * recipe.outputHeight} onChange={(height) => patch({ height: height / recipe.outputHeight })} /><NumberField label="图层旋转（度）" value={selected.rotation} min={-360} max={360} onChange={(rotation) => patch({ rotation })} /><NumberField label="图层不透明度（%）" value={selected.opacity * 100} min={0} max={100} onChange={(opacity) => patch({ opacity: opacity / 100 })} /></div>
            <div className="layer-editor-alignment">{([['left', '左对齐', AlignStartVertical], ['center-x', '水平居中', AlignCenterVertical], ['right', '右对齐', AlignEndVertical], ['top', '顶部对齐', AlignStartHorizontal], ['center-y', '垂直居中', AlignCenterHorizontal], ['bottom', '底部对齐', AlignEndHorizontal]] as const).map(([alignment, label, Icon]) => <ToolButton key={alignment} label={label} onClick={() => selectedId && change((value) => alignEditorLayer(value, selectedId, alignment))}><Icon size={16} /></ToolButton>)}</div>
            <div className="layer-editor-inline"><ToolButton label="图层水平翻转" pressed={!!selected.flipX} onClick={() => patch({ flipX: !selected.flipX })}><FlipHorizontal2 size={16} /></ToolButton><ToolButton label="图层垂直翻转" pressed={!!selected.flipY} onClick={() => patch({ flipY: !selected.flipY })}><FlipVertical2 size={16} /></ToolButton><label>混合<select aria-label="图层混合模式" value={selected.blend} onChange={(event) => patch({ blend: event.target.value as ImageLayer['blend'] })}><option value="source-over">正常</option><option value="multiply">正片叠底</option><option value="screen">滤色</option><option value="overlay">叠加</option></select></label></div>
          </fieldset>
          {!selected.content && <fieldset disabled={selectedLocked}><legend>图片来源</legend><select aria-label="当前图层图片来源" value={selected.sourceIndex} onChange={(event) => patch({ sourceIndex: Number(event.target.value) })}>{images.map((image, index) => <option key={image.key} value={index}>{index + 1} · {image.label}</option>)}</select></fieldset>}
          {selected.content?.kind === 'text' && <LayerTextControls key={selectedId!} content={selected.content} disabled={selectedLocked} onFontReady={() => setLocalFontRevision((value) => value + 1)} onBegin={begin} onFinish={finish} onChange={(content) => patch({ content })} colorField={<ColorField key={`${selectedId}-text-color`} label="文字颜色" value={selected.content.color} onChange={(color) => { const layer = stateRef.current.present.recipe.layers[stateRef.current.present.ids.indexOf(selectedId!)]; if (layer?.content?.kind === 'text') patch({ content: { ...layer.content, color } }) }} />} />}
          {selected.content?.kind === 'shape' && <fieldset disabled={selectedLocked}><legend>形状</legend><ColorField key={`${selectedId}-shape-fill`} label="形状填充" value={selected.content.fill} transparent onChange={(fill) => { if (selected.content?.kind === 'shape') patch({ content: { ...selected.content, fill } }) }} /><ColorField key={`${selectedId}-shape-stroke`} label="形状描边" value={selected.content.stroke} transparent onChange={(stroke) => { if (selected.content?.kind === 'shape') patch({ content: { ...selected.content, stroke } }) }} /><NumberField label="描边宽度（像素）" value={selected.content.strokeWidth} min={0} max={64} onChange={(strokeWidth) => { if (selected.content?.kind === 'shape') patch({ content: { ...selected.content, strokeWidth } }) }} /></fieldset>}
          {selected.content?.kind === 'path' && <fieldset disabled={selectedLocked}><legend>钢笔路径</legend><small>{selected.content.points.length} 个锚点 · 闭合路径 · 通过位置与变换调整形状</small><ColorField key={`${selectedId}-path-fill`} label="路径填充" value={selected.content.fill} transparent onChange={(fill) => { if (selected.content?.kind === 'path') patch({ content: { ...selected.content, fill } }) }} /><ColorField key={`${selectedId}-path-stroke`} label="路径描边" value={selected.content.stroke} transparent onChange={(stroke) => { if (selected.content?.kind === 'path') patch({ content: { ...selected.content, stroke } }) }} /><NumberField label="路径描边宽度（像素）" value={selected.content.strokeWidth} min={0} max={64} onChange={(strokeWidth) => { if (selected.content?.kind === 'path') patch({ content: { ...selected.content, strokeWidth } }) }} /></fieldset>}
          {(selected.mask || selected.edits) && <fieldset disabled={selectedLocked}><legend>绘画与蒙版</legend>{selected.edits && <small>此层包含 {selected.edits.operations.length} 次绘画、蒙版或局部滤镜操作。当前编辑期间可逐笔撤销，基础内容仍可编辑。</small>}{selected.mask && <button type="button" onClick={() => patch({ mask: undefined })}>移除蒙版</button>}</fieldset>}
          <fieldset className="layer-editor-adjustments" disabled={selectedLocked}><legend>颜色与效果</legend>{([['brightness', '亮度', 2, 100, '%'], ['contrast', '对比度', 2, 100, '%'], ['saturation', '饱和度', 2, 100, '%'], ['grayscale', '灰度', 1, 100, '%'], ['blur', '模糊', 32, 1, 'px']] as const).map(([key, label, max, scale, unit]) => <label key={key}><span>{label}<output>{Math.round((selected.adjustments?.[key] ?? defaultAdjustments[key]) * scale)} {unit}</output></span><input type="range" aria-label={label} min={0} max={max * scale} step={1} value={(selected.adjustments?.[key] ?? defaultAdjustments[key]) * scale} onPointerDown={begin} onPointerUp={() => setState((value) => finishLayerEditorTransaction(value))} onKeyDown={begin} onKeyUp={() => setState((value) => finishLayerEditorTransaction(value))} onChange={(event) => adjust(key, Number(event.target.value) / scale)} /></label>)}<button type="button" onClick={() => patch({ adjustments: { ...defaultAdjustments } })}>重置调整</button></fieldset>
        </section>}
        <section className="layer-editor-canvas-settings" onFocusCapture={(event) => { if (event.target.matches('input,select')) begin() }} onBlurCapture={() => setState((value) => finishLayerEditorTransaction(value))}><strong>画布</strong><div className="layer-editor-fields"><NumberField label="画布宽度" value={recipe.outputWidth} min={1} max={4096} onChange={(outputWidth) => setDocumentOutputSize('outputWidth', outputWidth)} /><NumberField label="画布高度" value={recipe.outputHeight} min={1} max={4096} onChange={(outputHeight) => setDocumentOutputSize('outputHeight', outputHeight)} /></div><ColorField label="画布背景" value={recipe.background} transparent onChange={(background) => change((value) => patchEditorRecipe(value, { background }))} /></section>
      </aside>
    </div>
    <footer className="layer-editor-footer"><div>{error ? <p role="alert">{error}</p> : <span role="status" aria-live="polite">{status || '修改将在应用后保存到当前节点'}</span>}<small className="layer-editor-export-note">PSD 保留组结构；文字、形状、路径及滤镜按图层栅格化，编辑配方继续保留。</small></div><button type="button" onClick={() => { closeLayerMerge(); cancelSampling(); cancelExport(); cancelVectorTools(); onClose() }}>取消</button>{importAvailable && <button type="button" disabled={!!cropSession || picking || exporting || !!penAnchors.length || !!gradientGuide || !!paintGesture.current} onClick={openPsdImport}>导入 PSD</button>}<button type="button" disabled={!!cropSession || !exportAvailable || picking || !!penAnchors.length || !!gradientGuide || !!paintGesture.current} title="导出当前编辑态为分层 PSD 并保留编组；文字、形状、路径与滤镜按图层栅格化，不自动应用到节点" onClick={() => { if (exporting) cancelExport(); else void exportPsd() }}>{exporting ? '取消导出' : '导出 PSD'}</button><button type="button" className="is-primary" disabled={!!cropSession || mergeBusy || picking || !!penAnchors.length || !!gradientGuide} onClick={apply}>应用图层</button></footer>
  </div>{mergeSession && <LayerMergeConfirmation names={mergeSession.names} groupNames={mergeSession.groupNames} placement={mergeSession.placement} destination={mergeSession.plan.groupParentId ? recipe.layerGroups?.groups.find((group) => group.id === mergeSession.plan.groupParentId)?.name || '编组' : '文档根'} review={mergeSession.review} reviewError={mergeSession.reviewError} accepted={mergeAccepted} busy={mergeBusy} uploading={mergeSession.phase === 'uploading'} onPlacementChange={(placement) => { if (mergeSessionRef.current === mergeSession && !mergeSession.started) openLayerMerge(placement) }} onAcceptedChange={(value) => { if (currentLayerMerge(mergeSession) && mergeSession.phase === 'ready' && !mergeSession.started) { mergeSession.accepted = value; setMergeAccepted(value) } }} onRetry={() => { if (mergeSessionRef.current === mergeSession && !mergeSession.started) openLayerMerge(mergeSession.placement) }} onCancel={() => closeLayerMerge(mergeSession, true)} onConfirm={() => void confirmLayerMerge(mergeSession)} />}{wholeFilterSession && <LayerFilterEditor recipe={wholeFilterSession.recipe} layerIndex={wholeFilterSession.index} images={images} hasSelection={wholeFilterSession.hasSelection} onApply={(operation) => applyWholeFilter(wholeFilterSession, operation)} onClose={() => closeWholeFilter(wholeFilterSession)} />}{liquifySession && <LayerLiquifyEditor recipe={liquifySession.recipe} layerIndex={liquifySession.index} images={images} onApply={(operation) => applyLiquify(liquifySession, operation)} onClose={() => closeLiquify(liquifySession)} />}{colorGradeSession && <LayerColorGradeEditor recipe={colorGradeSession.recipe} layerIndex={colorGradeSession.index} images={images} allowDownload={allowDownload} onApply={(grade) => applyColorGrade(colorGradeSession, grade)} onClose={closeColorGrade} />}{psdImportOpen && <LayerPsdImportDialog maximumAdditionalGroups={maximumImageLayerGroups - (recipe.layerGroups?.groups.length ?? 0)} maximumAdditionalLayers={maximumImageTransformInputs - recipe.layers.length} maximumAdditionalSources={maximumImageTransformInputs - images.length} onImport={importPsd} onClose={() => setPsdImportOpen(false)} />}</>
}
