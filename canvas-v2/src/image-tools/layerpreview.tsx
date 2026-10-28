import { memo, useEffect, useId, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { SafeImage } from '../components/MediaPreview'
import { resolveCanvasAssetDisplayUrl } from '../asset-display-url'
import type { AssetRef } from '../model'
import type { ImageTransformSize } from './geometry'
import type { ImageLayer, ImageLayerRecipe, ImageLayerBrushStroke, ImageLayerGradient } from './recipe'
import { defaultEditorImageLayer } from './layer-editor-state'
import { layerRasterPreviewSize, type LayerCanvasSelection } from './layer-paint-state'
import { applyImageLayerFeatherMask, paintImageLayerLocalAsync, paintImageLayerWorldPreviewAsync } from '../library/image-layer-painter'
import { paintBrowserImageLayerDocumentPreview, sampleBrowserImageLayerColor, sampleBrowserImageLayerPixels } from '../library/browser-image-transform'
import { isLocalTextFontReady, prepareLocalTextFont } from './local-text-fonts'
import { layerPreviewScheduler } from './layer-preview-task'
import { isNeutralImageLayerColorGrade } from './layer-color-grade'
import { getPreparedColorLutTable, type PreparedColorLutTables } from './layer-color-lut-runtime'
import { useLayerColorLutPreview, type LayerColorLutPreviewState } from './layer-color-lut-preview'
import { renderBrowserEditorLayerMerge, type EditorLayerMergeSource } from '../library/browser-layer-merge'
import { reviewBrowserEditorLayerMerge, type BrowserEditorLayerMergeReview } from '../library/browser-layer-merge-review'
import type { EditorLayerMergePlan } from './layer-editor-merge'
import type { BrowserImageTransformOutput } from '../library/browser-image-transform'
import { materializeImageLayerGroups } from './layer-group-model'
import './layer-editor.css'

export interface LayerToolImage {
  key: string
  label: string
  asset: AssetRef
  dimensions: ImageTransformSize
  dimensionsReady: boolean
  onLoad(image: HTMLImageElement): void
}

export interface LayerPreviewSampler {
  sampleColor(point: { x: number; y: number }, signal: AbortSignal): Promise<string>
  samplePixels(input: { source: 'current' | 'composite'; layerIndex?: number }, signal: AbortSignal): Promise<{ width: number; height: number; data: Uint8ClampedArray }>
  mergeLayers(plan: EditorLayerMergePlan, signal: AbortSignal): Promise<BrowserImageTransformOutput>
  mergeReviewContext: object
  reviewLayerMerge(plan: EditorLayerMergePlan, sourceIndex: number, replacementId: string, signal: AbortSignal): Promise<BrowserEditorLayerMergeReview>
}
export interface LayerPreviewRasterStatus { busy: boolean; error: string }

export function layerPreviewTransform(layer: ImageLayer, recipe: ImageLayerRecipe): string {
  const width = layer.width * recipe.outputWidth, height = layer.height * recipe.outputHeight
  return `translate(${layer.x * recipe.outputWidth + width / 2} ${layer.y * recipe.outputHeight + height / 2}) scale(${layer.flipX ? -1 : 1} ${layer.flipY ? -1 : 1}) rotate(${layer.rotation}) translate(${-width / 2} ${-height / 2})`
}

function sourceKey(image: LayerToolImage): string { return JSON.stringify([image.key, image.asset.assetId, image.asset.localUrl]) }

function useLayerPreviewFont(layer: ImageLayer, revision: number): { ready: boolean; error: string } {
  const content = layer.content?.kind === 'text' ? layer.content : undefined
  const family = content?.typography?.fontFamily, weight = content?.typography?.fontWeight ?? content?.fontWeight ?? 400
  const key = JSON.stringify([family, weight])
  const [prepared, setPrepared] = useState<{ key: string; error: string } | null>(null)
  useEffect(() => {
    let alive = true
    if (!family) return
    void prepareLocalTextFont(family, weight).then(() => { if (alive) setPrepared({ key, error: '' }) }, (cause) => { if (alive) setPrepared({ key, error: cause instanceof Error ? cause.message : '本机字体未就绪，请加载字体或改选通用字体' }) })
    return () => { alive = false }
  }, [family, weight, key, revision])
  if (!family) return { ready: true, error: '' }
  if (isLocalTextFontReady(family, weight)) return { ready: true, error: '' }
  if (prepared?.key === key && prepared.error) return { ready: false, error: prepared.error }
  return { ready: isLocalTextFontReady(family, weight), error: '' }
}

function disposePreviewCanvas(value: HTMLCanvasElement): void { value.width = 0; value.height = 0 }
function createPreviewCanvas(width: number, height: number): HTMLCanvasElement { const value = document.createElement('canvas'); value.width = width; value.height = height; return value }
function previewContext(value: HTMLCanvasElement): CanvasRenderingContext2D { const context = value.getContext('2d', { alpha: true }); if (!context) throw new Error('当前浏览器无法显示图层预览'); return context }
function clearPreviewCanvas(value: HTMLCanvasElement | null): void { if (value) value.getContext('2d')?.clearRect(0, 0, value.width, value.height) }
function publishPreviewCanvas(target: HTMLCanvasElement, frame: HTMLCanvasElement): void {
  target.width = frame.width; target.height = frame.height
  previewContext(target).drawImage(frame, 0, 0)
}
interface CompletedLayerPreview { canvas: HTMLCanvasElement; layer: ImageLayer; source?: HTMLImageElement; width: number; height: number; lutTables?: PreparedColorLutTables }

function RasterLayerContent({ layer, source, width, height, rasterCount, transient, fontRevision = 0, lutTables }: { layer: ImageLayer; source?: HTMLImageElement; width: number; height: number; rasterCount: number; transient?: ImageLayerBrushStroke | ImageLayerGradient; fontRevision?: number; lutTables?: PreparedColorLutTables }) {
  const canvas = useRef<HTMLCanvasElement>(null), completed = useRef<CompletedLayerPreview | null>(null)
  const [error, setError] = useState(''), [updating, setUpdating] = useState(false), [revision, setRevision] = useState(0)
  const font = useLayerPreviewFont(layer, fontRevision)
  // Cache, previous display and in-flight surfaces share the aggregate budget.
  const size = layerRasterPreviewSize(width, height, rasterCount * 4)
  const baseScope = useMemo(() => ({ layer, source, width, height, lutTables, pixelWidth: size.width, pixelHeight: size.height, ready: font.ready }), [layer, source, width, height, lutTables, size.width, size.height, font.ready])
  const displayScope = useMemo(() => ({ baseScope, transient, revision }), [baseScope, transient, revision])
  const latestBase = useRef(baseScope), latestDisplay = useRef(displayScope)
  latestBase.current = baseScope; latestDisplay.current = displayScope
  useEffect(() => () => { if (completed.current) disposePreviewCanvas(completed.current.canvas); completed.current = null }, [])
  useEffect(() => {
    function clear() { if (completed.current) disposePreviewCanvas(completed.current.canvas); completed.current = null; clearPreviewCanvas(canvas.current) }
    if (!font.ready || (!layer.content && !source)) { clear(); setUpdating(false); return }
    setUpdating(true); setError('')
    const task = layerPreviewScheduler.schedule({
      current: () => latestBase.current === baseScope,
      create: () => createPreviewCanvas(size.width, size.height),
      async paint(target, signal) {
        const context = previewContext(target)
        context.setTransform(size.width / width, 0, 0, size.height / height, 0, 0)
        await paintImageLayerLocalAsync(context, { layer, source, width, height, lutTable: getPreparedColorLutTable(layer.colorGrade?.lut, lutTables), deferFeatherMask: true, signal, deadline: Date.now() + 10000 })
      },
      publish(target) {
        if (completed.current) disposePreviewCanvas(completed.current.canvas)
        completed.current = { canvas: target, layer, source, width, height, lutTables }
        setRevision((value) => value + 1)
        return true
      },
      dispose: disposePreviewCanvas,
      fail(cause) { clear(); setUpdating(false); setError(cause instanceof Error ? cause.message : '绘画预览暂不可用') },
    })
    return () => task.cancel()
  }, [layer, source, width, height, lutTables, size.width, size.height, font.ready])
  useEffect(() => {
    const base = completed.current, target = canvas.current
    if (!target || !font.ready || !base || base.layer !== layer || base.source !== source || base.width !== width || base.height !== height || base.lutTables !== lutTables || base.canvas.width !== size.width || base.canvas.height !== size.height) return
    setUpdating(true)
    const task = layerPreviewScheduler.schedule({
      current: () => latestDisplay.current === displayScope,
      create: () => createPreviewCanvas(size.width, size.height),
      async paint(frame, signal) {
        const context = previewContext(frame)
        if (transient?.mode === 'blur' || transient?.mode === 'sharpen') {
          // A filter needs the pre-stroke image, not an empty overlay or a
          // reduced preview bitmap. Replay at the shared original resolution.
          context.setTransform(size.width / width, 0, 0, size.height / height, 0, 0)
          await paintImageLayerLocalAsync(context, { layer: { ...layer, edits: { version: 1, operations: [...(layer.edits?.operations ?? []), transient] } }, source, width, height, lutTable: getPreparedColorLutTable(layer.colorGrade?.lut, lutTables), deferFeatherMask: true, signal, deadline: Date.now() + 10000 })
        } else {
          context.drawImage(base.canvas, 0, 0)
          context.setTransform(size.width / width, 0, 0, size.height / height, 0, 0)
          if (transient) await paintImageLayerLocalAsync(context, { layer: { content: { kind: 'paint' }, edits: { version: 1, operations: [transient] }, mask: layer.mask }, width, height, deferFeatherMask: true, signal, deadline: Date.now() + 10000 })
        }
        if (!signal.aborted && layer.mask?.feather?.radius) applyImageLayerFeatherMask(context, { mask: layer.mask, width, height })
      },
      publish(frame) { publishPreviewCanvas(target, frame); setUpdating(false); setError(''); return false },
      dispose: disposePreviewCanvas,
      fail(cause) { clearPreviewCanvas(target); setUpdating(false); setError(cause instanceof Error ? cause.message : '笔迹预览暂不可用') },
    })
    return () => task.cancel()
  }, [layer, source, transient, width, height, lutTables, size.width, size.height, font.ready, revision])
  return <foreignObject width={width} height={height}><div className="layer-raster-preview"><canvas ref={canvas} width={size.width} height={size.height} aria-busy={updating} aria-label={layer.content?.kind === 'text' && layer.content.typography ? '文字排版与变形预览' : '绘画与蒙版预览'} />{(font.error || !font.ready || error || (!layer.content && !source) || updating) && <span role="status">{font.error || (!font.ready ? '正在准备本机字体' : error || (!layer.content && !source ? '正在加载图层素材' : '正在更新图层预览'))}</span>}</div></foreignObject>
}

const MemoRasterLayerContent = memo(RasterLayerContent)

function WorldRasterLayerContent({ layer, source, outputWidth, outputHeight, documentFrame, rasterCount, transient, fontRevision = 0, onStatus, lutTables }: { layer: ImageLayer; source?: HTMLImageElement; outputWidth: number; outputHeight: number; documentFrame?: ImageLayerRecipe['documentFrame']; rasterCount: number; transient?: ImageLayerBrushStroke | ImageLayerGradient; fontRevision?: number; onStatus?(status: LayerPreviewRasterStatus): void; lutTables?: PreparedColorLutTables }) {
  const canvas = useRef<HTMLCanvasElement>(null), [error, setError] = useState(''), [updating, setUpdating] = useState(false)
  const font = useLayerPreviewFont(layer, fontRevision)
  const size = layerRasterPreviewSize(outputWidth, outputHeight, rasterCount * 4)
  const scope = useMemo(() => ({ layer, source, outputWidth, outputHeight, documentFrame, transient, lutTables, pixelWidth: size.width, pixelHeight: size.height, ready: font.ready }), [layer, source, outputWidth, outputHeight, documentFrame, transient, lutTables, size.width, size.height, font.ready])
  const latest = useRef(scope); latest.current = scope
  useEffect(() => {
    const target = canvas.current
    if (!target) return
    if (!font.ready || (!layer.content && !source)) { clearPreviewCanvas(target); setUpdating(false); onStatus?.({ busy: !font.error, error: font.error }); return }
    setUpdating(true); setError(''); onStatus?.({ busy: true, error: '' })
    const task = layerPreviewScheduler.schedule({
      current: () => latest.current === scope,
      create: () => createPreviewCanvas(size.width, size.height),
      async paint(frame, signal) {
        if (documentFrame) {
          const drawing = { ...layer, sourceIndex: 0, visible: true, opacity: 1, blend: 'source-over' as const, ...(transient ? { edits: { version: 1 as const, operations: [...(layer.edits?.operations ?? []), transient] } } : {}) }
          await paintBrowserImageLayerDocumentPreview(previewContext(frame), { recipe: { kind: 'layer', outputWidth, outputHeight, documentFrame, explicitLayers: true, background: 'transparent', layers: [drawing] }, sources: source ? [{ image: source, width: source.naturalWidth, height: source.naturalHeight }] : [], signal, ...(lutTables ? { lutTables } : {}) })
        } else await paintImageLayerWorldPreviewAsync(previewContext(frame), { layer, source, lutTable: getPreparedColorLutTable(layer.colorGrade?.lut, lutTables), output: { width: outputWidth, height: outputHeight }, transient, signal, deadline: Date.now() + (layer.edits?.operations.some((operation) => (operation.mode === 'liquify' || operation.mode === 'whole-filter')) || layer.colorGrade && !isNeutralImageLayerColorGrade(layer.colorGrade) ? 30000 : 10000) })
      },
      publish(frame) { publishPreviewCanvas(target, frame); setUpdating(false); setError(''); onStatus?.({ busy: false, error: '' }); return false },
      dispose: disposePreviewCanvas,
      fail(cause) { const message = cause instanceof Error ? cause.message : '描边预览暂不可用'; clearPreviewCanvas(target); setUpdating(false); setError(message); onStatus?.({ busy: false, error: message }) },
    })
    return () => task.cancel()
  }, [layer, source, outputWidth, outputHeight, documentFrame, transient, lutTables, size.width, size.height, font.ready, font.error, onStatus])
  return <foreignObject x={0} y={0} width={outputWidth} height={outputHeight} pointerEvents="none"><div className="layer-raster-preview"><canvas ref={canvas} width={size.width} height={size.height} aria-busy={updating} aria-label="输出坐标描边与绘画预览" />{(font.error || !font.ready || error || (!layer.content && !source) || updating) && <span role="status">{font.error || (!font.ready ? '正在准备本机字体' : error || (!layer.content && !source ? '正在加载图层素材' : '正在更新图层预览'))}</span>}</div></foreignObject>
}

const MemoWorldRasterLayerContent = memo(WorldRasterLayerContent)

function RasterSelectionOverlay({ selection, output }: { selection: Extract<LayerCanvasSelection, { kind: 'raster' }>; output: { width: number; height: number } }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const size = layerRasterPreviewSize(output.width, output.height, 2)
  useEffect(() => {
    const target = canvas.current
    if (!target) return
    target.width = size.width; target.height = size.height
    const context = target.getContext('2d')
    if (!context) return
    context.setTransform(size.width / selection.raster.width, 0, 0, size.height / selection.raster.height, 0, 0)
    context.fillStyle = 'rgba(104,223,182,.32)'
    if (selection.inverted) { context.fillRect(0, 0, selection.raster.width, selection.raster.height); context.globalCompositeOperation = 'destination-out'; context.fillStyle = '#000000' }
    for (let index = 0; index < selection.raster.runs.length; index += 2) {
      const offset = selection.raster.runs[index]
      context.fillRect(offset % selection.raster.width, Math.floor(offset / selection.raster.width), selection.raster.runs[index + 1], 1)
    }
    return () => { target.width = 0; target.height = 0 }
  }, [selection, size.width, size.height])
  return <foreignObject width={output.width} height={output.height} pointerEvents="none"><div className="layer-raster-selection"><canvas ref={canvas} width={size.width} height={size.height} aria-label="像素选区蒙版预览，绿色区域被选中" /></div></foreignObject>
}

export function LayerCanvasSelectionOverlay({ selection, output }: { selection: LayerCanvasSelection; output: { width: number; height: number } }) {
  if (selection.kind === 'raster') return <RasterSelectionOverlay selection={selection} output={output} />
  return <g className="layer-editor-marquee" pointerEvents="none">{selection.kind === 'ellipse'
    ? <ellipse cx={(selection.x + selection.width / 2) * output.width} cy={(selection.y + selection.height / 2) * output.height} rx={selection.width * output.width / 2} ry={selection.height * output.height / 2} />
    : <rect x={selection.x * output.width} y={selection.y * output.height} width={selection.width * output.width} height={selection.height * output.height} />}{selection.inverted && <rect width={output.width} height={output.height} />}</g>
}

/** SVG geometry uses output pixels, including type size, blur and stroke width. */
export function LayerRecipePreview({ recipe, images, children, svgRef, transient, samplerRef, fontRevision = 0, onRasterStatus, onMergeReviewContextChange, lutTables, lutState }: { recipe: ImageLayerRecipe; images: readonly LayerToolImage[]; children?: ReactNode; svgRef?: Ref<SVGSVGElement>; transient?: { index: number; stroke: ImageLayerBrushStroke | ImageLayerGradient }; samplerRef?: Ref<LayerPreviewSampler>; fontRevision?: number; onRasterStatus?(status: LayerPreviewRasterStatus): void; onMergeReviewContextChange?(context: object): void; lutTables?: PreparedColorLutTables; lutState?: LayerColorLutPreviewState }) {
  const prefix = useId().replace(/:/g, '')
  const automaticLut = useLayerColorLutPreview(recipe, lutState?.tables ?? lutTables, lutState !== undefined), lut = lutState ?? automaticLut
  const statusListener = useRef(onRasterStatus), lastStatus = useRef<LayerPreviewRasterStatus | null>(null); statusListener.current = onRasterStatus
  const reportRasterStatus = useMemo(() => function report(status: LayerPreviewRasterStatus) { if (lastStatus.current?.busy === status.busy && lastStatus.current.error === status.error) return; lastStatus.current = status; statusListener.current?.(status) }, [])
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const sources = useRef(new Map<string, HTMLImageElement>())
  const [sourceRevision, sourceLoaded] = useState(0)
  const imageIdentity = JSON.stringify(images.map(sourceKey))
  const mergeReviewContext = useMemo(() => ({}), [recipe, imageIdentity, sourceRevision, failed, fontRevision, lut.tables, lut.busy, lut.error])
  const mergeContextRef = useRef<object | null>(mergeReviewContext), mergeContextListener = useRef(onMergeReviewContextChange)
  mergeContextRef.current = mergeReviewContext; mergeContextListener.current = onMergeReviewContextChange
  useEffect(() => { mergeContextListener.current?.(mergeReviewContext) }, [mergeReviewContext])
  useEffect(() => { mergeContextRef.current = mergeReviewContext; return () => { mergeContextRef.current = null } }, [])
  // A group is pass-through: only inherited visibility/lock reaches rendering.
  // Keep the editable recipe and its leaf-owned flags untouched.
  const renderedRecipe = materializeImageLayerGroups(recipe)
  const layers = renderedRecipe.layers.length || renderedRecipe.explicitLayers ? renderedRecipe.layers : images.map((_, index) => defaultEditorImageLayer(index))
  const visibleSources = [...new Set(layers.filter((layer) => layer.visible && !layer.content).map((layer) => layer.sourceIndex))].map((index) => images[index]).filter((image): image is LayerToolImage => !!image)
  const activeKeys = new Set(visibleSources.map(sourceKey))
  const activeKeysRef = useRef(activeKeys)
  activeKeysRef.current = activeKeys
  const sourceUnavailable = layers.some((layer) => { const image = images[layer.sourceIndex]; return layer.visible && !layer.content && (!image || failed.has(sourceKey(image)) || !resolveCanvasAssetDisplayUrl(image.asset.localUrl)) })
  useEffect(() => { if (sourceUnavailable) reportRasterStatus({ busy: false, error: '图层素材不可用，请重新选择素材后编辑' }) }, [sourceUnavailable, reportRasterStatus])
  for (const key of sources.current.keys()) if (!activeKeys.has(key)) sources.current.delete(key)
  useImperativeHandle(samplerRef, () => ({
    mergeReviewContext,
    async reviewLayerMerge(plan, sourceIndex, replacementId, signal) {
      if (plan.recipe !== recipe) throw new Error('图层已变化，请重新选择后合并')
      if (lut.busy) throw new Error('LUT 仍在加载，请稍后合并')
      if (lut.error) throw new Error(lut.error)
      const allSources = new Map<number, EditorLayerMergeSource>(), capturedContext = mergeReviewContext
      for (const layer of materializeImageLayerGroups(recipe).layers) {
        if (!layer.visible || layer.content || allSources.has(layer.sourceIndex)) continue
        const image = images[layer.sourceIndex], source = image && sources.current.get(sourceKey(image))
        if (!image || failed.has(sourceKey(image)) || !resolveCanvasAssetDisplayUrl(image.asset.localUrl)) throw new Error('完整文档素材不可用，请重新选择素材')
        if (!source?.naturalWidth || !source.naturalHeight) throw new Error('完整文档素材仍在加载，请稍后重试')
        allSources.set(layer.sourceIndex, { image: source, width: source.naturalWidth, height: source.naturalHeight })
      }
      const originalSourceSizes = images.map((image, index) => {
        const decoded = allSources.get(index)
        if (decoded) return { width: decoded.width, height: decoded.height }
        if (!image.dimensionsReady) throw new Error('原素材尺寸尚未确定，请等待素材加载后重试')
        return { ...image.dimensions }
      })
      const result = await reviewBrowserEditorLayerMerge(plan, { sourceIndex, replacementId, originalSourceSizes, sources: allSources, signal, ...(lut.tables ? { lutTables: lut.tables } : {}) })
      if (signal.aborted || mergeContextRef.current !== capturedContext) throw new Error('素材、字体或调色表已变化，请重新生成合并对比')
      return result
    },
    async mergeLayers(plan, signal) {
      if (plan.recipe !== recipe) throw new Error('图层已变化，请重新选择后合并')
      if (lut.busy) throw new Error('LUT 仍在加载，请稍后合并')
      if (lut.error) throw new Error(lut.error)
      const selectedSources = new Map<number, EditorLayerMergeSource>()
      for (const layer of plan.rasterRecipe.layers) {
        if (layer.content || selectedSources.has(layer.sourceIndex)) continue
        const image = images[layer.sourceIndex], source = image && sources.current.get(sourceKey(image))
        if (!image || failed.has(sourceKey(image)) || !resolveCanvasAssetDisplayUrl(image.asset.localUrl)) throw new Error('合并图层素材不可用，请重新选择素材')
        if (!source?.naturalWidth || !source.naturalHeight) throw new Error('合并图层素材仍在加载，请稍后重试')
        selectedSources.set(layer.sourceIndex, { image: source, width: source.naturalWidth, height: source.naturalHeight })
      }
      return renderBrowserEditorLayerMerge(plan, { sources: selectedSources, signal, ...(lut.tables ? { lutTables: lut.tables } : {}) })
    },
    async sampleColor(point, signal) {
      if (lut.busy) throw new Error('LUT 仍在加载，请稍后取色')
      if (lut.error) throw new Error(lut.error)
      const sourceIndices: number[] = [], sampleSources: Array<{ image: CanvasImageSource; width: number; height: number }> = []
      const sampleLayers = layers.filter((layer) => layer.visible && layer.opacity > 0).map((layer) => {
        if (layer.content) return layer
        let sourceIndex = sourceIndices.indexOf(layer.sourceIndex)
        if (sourceIndex < 0) {
          const image = images[layer.sourceIndex], source = image && sources.current.get(sourceKey(image))
          if (!image || failed.has(sourceKey(image)) || !resolveCanvasAssetDisplayUrl(image.asset.localUrl)) throw new Error('图层素材不可用，请重新选择素材后取色')
          if (!source || !source.naturalWidth || !source.naturalHeight) throw new Error('图层素材仍在加载，请稍后取色')
          sourceIndex = sourceIndices.length; sourceIndices.push(layer.sourceIndex)
          sampleSources.push({ image: source, width: source.naturalWidth, height: source.naturalHeight })
        }
        return { ...layer, sourceIndex }
      })
      return sampleBrowserImageLayerColor({ recipe: { ...renderedRecipe, explicitLayers: true, layers: sampleLayers }, sources: sampleSources, point, signal, ...(lut.tables ? { lutTables: lut.tables } : {}) })
    },
    async samplePixels(input, signal) {
      if (lut.busy) throw new Error('LUT 仍在加载，请稍后读取像素')
      if (lut.error) throw new Error(lut.error)
      const chosen = input.source === 'current' ? layers[input.layerIndex ?? -1] : undefined
      if (input.source === 'current' && !chosen) throw new Error('请先选择取样图层')
      if (chosen && !chosen.visible) throw new Error('当前图层已隐藏，请显示图层后取样')
      const sourceIndices: number[] = [], sampleSources: Array<{ image: CanvasImageSource; width: number; height: number }> = []
      const sampleLayers = (chosen ? [chosen] : layers.filter((layer) => layer.visible && layer.opacity > 0)).map((layer) => {
        if (layer.content) return layer
        if (!layer.opacity) return { ...layer, sourceIndex: 0, content: { kind: 'paint' as const } }
        let sourceIndex = sourceIndices.indexOf(layer.sourceIndex)
        if (sourceIndex < 0) {
          const image = images[layer.sourceIndex], source = image && sources.current.get(sourceKey(image))
          if (!image || failed.has(sourceKey(image)) || !resolveCanvasAssetDisplayUrl(image.asset.localUrl)) throw new Error('取样图层素材不可用，请重新选择素材')
          if (!source?.naturalWidth || !source.naturalHeight) throw new Error('取样图层素材仍在加载，请稍后重试')
          sourceIndex = sourceIndices.length; sourceIndices.push(layer.sourceIndex)
          sampleSources.push({ image: source, width: source.naturalWidth, height: source.naturalHeight })
        }
        return { ...layer, sourceIndex }
      })
      return sampleBrowserImageLayerPixels({ recipe: { ...renderedRecipe, explicitLayers: true, layers: sampleLayers }, sources: sampleSources, source: input.source, ...(chosen ? { layerIndex: 0 } : {}), signal, ...(lut.tables ? { lutTables: lut.tables } : {}) })
    },
  }))
  const rasterCount = layers.filter((layer, index) => layer.visible && (recipe.documentFrame || layer.colorGrade && !isNeutralImageLayerColorGrade(layer.colorGrade) || layer.edits || layer.mask || layer.content?.kind === 'paint' || layer.content?.kind === 'path' || layer.content?.kind === 'text' && layer.content.typography || transient?.index === index)).length
  useEffect(() => { if (sourceUnavailable) reportRasterStatus({ busy: false, error: '图层素材不可用，请重新选择素材后编辑' }); else if (lut.busy || lut.error) reportRasterStatus({ busy: lut.busy, error: lut.error }); else if (!rasterCount) reportRasterStatus({ busy: false, error: '' }) }, [lut.busy, lut.error, rasterCount, sourceUnavailable, reportRasterStatus])
  return <div className="layer-recipe-preview image-tool-checker" style={{ aspectRatio: recipe.outputWidth / recipe.outputHeight }}>
    <div className="layer-preview-decoders" aria-hidden="true">{visibleSources.map((image) => <SafeImage key={sourceKey(image)} src={image.asset.localUrl || ''} alt="" onLoad={(event) => {
      const key = sourceKey(image)
      if (!activeKeysRef.current.has(key)) return
      image.onLoad(event.currentTarget)
      if (sources.current.get(key) !== event.currentTarget) { sources.current.set(key, event.currentTarget); sourceLoaded((value) => value + 1) }
      setFailed((previous) => { if (!previous.has(key)) return previous; const next = new Set(previous); next.delete(key); return next })
    }} onError={() => { const key = sourceKey(image); if (activeKeysRef.current.has(key)) { sources.current.delete(key); setFailed((previous) => previous.has(key) ? previous : new Set([...previous, key])) } }} />)}</div>
    <svg ref={svgRef} viewBox={`0 0 ${recipe.outputWidth} ${recipe.outputHeight}`} role="img" aria-label="图层合成预览" preserveAspectRatio="xMidYMid meet">
      <rect width={recipe.outputWidth} height={recipe.outputHeight} fill={recipe.background} />
      <defs>{layers.map((layer, index) => {
        const width = layer.width * recipe.outputWidth, height = layer.height * recipe.outputHeight, adjustments = layer.adjustments
        const padding = (adjustments?.blur ?? 0) * 4 + 2
        return <g key={index}>
          <clipPath id={`${prefix}-clip-${index}`}><rect width={width} height={height} /></clipPath>
          {adjustments && <filter id={`${prefix}-filter-${index}`} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x={-padding} y={-padding} width={width + padding * 2} height={height + padding * 2} colorInterpolationFilters="sRGB">
            <feComponentTransfer><feFuncR type="linear" slope={adjustments.brightness} /><feFuncG type="linear" slope={adjustments.brightness} /><feFuncB type="linear" slope={adjustments.brightness} /></feComponentTransfer>
            <feComponentTransfer><feFuncR type="linear" slope={adjustments.contrast} intercept={0.5 - adjustments.contrast * 0.5} /><feFuncG type="linear" slope={adjustments.contrast} intercept={0.5 - adjustments.contrast * 0.5} /><feFuncB type="linear" slope={adjustments.contrast} intercept={0.5 - adjustments.contrast * 0.5} /></feComponentTransfer>
            <feColorMatrix type="saturate" values={String(adjustments.saturation)} /><feGaussianBlur stdDeviation={adjustments.blur} /><feColorMatrix type="saturate" values={String(1 - adjustments.grayscale)} />
          </filter>}
        </g>
      })}</defs>
      {layers.map((layer, index) => {
        if (lut.busy || lut.error) return null
        if (!layer.visible) return null
        const width = layer.width * recipe.outputWidth, height = layer.height * recipe.outputHeight, content = layer.content, image = images[layer.sourceIndex]
        const href = image && !failed.has(sourceKey(image)) ? resolveCanvasAssetDisplayUrl(image.asset.localUrl) : undefined
        const strokeWidth = content?.kind === 'shape' && content.stroke !== 'transparent' ? Math.min(content.strokeWidth, width, height) : 0
        // Outline kernels are defined in output axes. Applying SVG rotation to a
        // local raster would rotate the kernel and disagree with the saved PNG.
        if ((recipe.documentFrame || layer.colorGrade && !isNeutralImageLayerColorGrade(layer.colorGrade) || layer.edits?.operations.some((operation) => operation.mode === 'liquify' || operation.mode === 'whole-filter' || operation.mode === 'outline' || operation.mode === 'blur' || operation.mode === 'sharpen') || transient?.index === index && (transient.stroke.mode === 'blur' || transient.stroke.mode === 'sharpen')) && (content || href)) return <g key={index} data-layer-index={index} opacity={layer.opacity} style={{ mixBlendMode: layer.blend === 'source-over' ? 'normal' : layer.blend }}><MemoWorldRasterLayerContent lutTables={lut.tables} onStatus={reportRasterStatus} fontRevision={fontRevision} layer={layer} source={image ? sources.current.get(sourceKey(image)) : undefined} outputWidth={recipe.outputWidth} outputHeight={recipe.outputHeight} documentFrame={recipe.documentFrame} rasterCount={rasterCount} transient={transient?.index === index ? transient.stroke : undefined} /><rect data-layer-hit-area="true" transform={layerPreviewTransform(layer, recipe)} width={width} height={height} fill="transparent" pointerEvents="all" /></g>
        return <g key={index} data-layer-index={index} transform={layerPreviewTransform(layer, recipe)} opacity={layer.opacity} style={{ mixBlendMode: layer.blend === 'source-over' ? 'normal' : layer.blend }}>
          <g filter={layer.adjustments ? `url(#${prefix}-filter-${index})` : undefined}>
            {(layer.edits || layer.mask || content?.kind === 'paint' || content?.kind === 'path' || content?.kind === 'text' && content.typography || transient?.index === index) && (content || href) ? <MemoRasterLayerContent lutTables={lut.tables} fontRevision={fontRevision} layer={layer} source={image ? sources.current.get(sourceKey(image)) : undefined} width={width} height={height} rasterCount={rasterCount} transient={transient?.index === index ? transient.stroke : undefined} />
              : content?.kind === 'text' ? <g clipPath={`url(#${prefix}-clip-${index})`}><text fill={content.color} fontFamily={content.fontFamily} fontSize={content.fontSize} fontWeight={content.fontWeight} textAnchor={content.align === 'center' ? 'middle' : content.align === 'right' ? 'end' : 'start'} dominantBaseline="alphabetic" xmlSpace="preserve">{content.text.split(/\r\n?|\n/).map((line, lineIndex) => <tspan key={lineIndex} x={content.align === 'center' ? width / 2 : content.align === 'right' ? width : 0} y={content.fontSize + lineIndex * content.fontSize * 1.2}>{line || '\u00a0'}</tspan>)}</text></g>
              : content?.kind === 'shape' ? content.shape === 'ellipse'
                ? <g><ellipse cx={width / 2} cy={height / 2} rx={width / 2} ry={height / 2} fill={content.fill} />{strokeWidth > 0 && <ellipse cx={width / 2} cy={height / 2} rx={Math.max(0, (width - strokeWidth) / 2)} ry={Math.max(0, (height - strokeWidth) / 2)} fill="none" stroke={content.stroke} strokeWidth={strokeWidth} />}</g>
                : <g><rect width={width} height={height} fill={content.fill} />{strokeWidth > 0 && <rect x={strokeWidth / 2} y={strokeWidth / 2} width={Math.max(0, width - strokeWidth)} height={Math.max(0, height - strokeWidth)} fill="none" stroke={content.stroke} strokeWidth={strokeWidth} />}</g>
              : href ? <image href={href} width={width} height={height} preserveAspectRatio="none" />
                : <g><rect width={width} height={height} fill="#2c3441" /><text x={width / 2} y={height / 2} textAnchor="middle" fill="#b9c2cf" fontSize={Math.max(10, Math.min(width / 10, height / 6, 48))}>素材不可用</text></g>}
          </g>
        </g>
      })}
      {children}
    </svg>
    {(lut.busy || lut.error) && <div role="status" aria-busy={lut.busy} style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', gap: 8, padding: 16, background: '#172126dd', color: '#dce9e6', textAlign: 'center' }}><span>{lut.error || '正在加载 LUT 预览，当前效果尚未就绪'}</span>{lut.error && <button type="button" onClick={lut.retry}>重新加载 LUT</button>}</div>}
  </div>
}
