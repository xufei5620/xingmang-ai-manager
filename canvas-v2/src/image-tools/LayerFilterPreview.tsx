import { useEffect, useMemo, useRef, useState } from 'react'
import { SafeImage } from '../components/MediaPreview'
import { resolveCanvasAssetDisplayUrl } from '../asset-display-url'
import { paintBrowserImageLayerFullPreview } from '../library/browser-image-transform'
import type { ImageLayerRecipe } from './recipe'
import type { LayerFilterPresentationFrame } from './layer-filter-presentation'
import type { LayerPreviewRasterStatus, LayerToolImage } from './layerpreview'
import { layerRasterPreviewSize } from './layer-paint-state'
import { layerPreviewScheduler } from './layer-preview-task'

interface FilterPreviewSource { image: HTMLImageElement; width: number; height: number }
interface FilterPreviewSourceState { key: string; source?: FilterPreviewSource; error: string }

function previewContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (!context) throw new Error('当前浏览器无法显示完整图层预览')
  return context
}
function createPreviewCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas
}
function disposePreviewCanvas(canvas: HTMLCanvasElement) { canvas.width = 0; canvas.height = 0 }
function publishPreviewCanvas(target: HTMLCanvasElement, frame: HTMLCanvasElement) {
  const context = previewContext(target)
  context.clearRect(0, 0, target.width, target.height); context.drawImage(frame, 0, 0)
}

/** Each side owns one completed thumbnail. Visibility and viewport changes are
 * deliberately absent from the raster scope, so comparison never replays edits. */
function FilterPreviewFrame({ recipe, layerIndex, frame, source, sourceError, visible, revision, onStatus }: { recipe: ImageLayerRecipe; layerIndex: number; frame: LayerFilterPresentationFrame; source?: FilterPreviewSource; sourceError: string; visible: boolean; revision: number; onStatus(status: LayerPreviewRasterStatus): void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const size = layerRasterPreviewSize(frame.width, frame.height, 2)
  const scope = useMemo(() => ({ recipe, layerIndex, source, sourceError, revision, width: size.width, height: size.height }), [recipe, layerIndex, source, sourceError, revision, size.width, size.height])
  const latest = useRef(scope); latest.current = scope
  const [result, setResult] = useState<{ scope: typeof scope; status: LayerPreviewRasterStatus } | null>(null)
  const waitingSource = !recipe.layers[layerIndex]?.content && !source
  const status = result?.scope === scope ? result.status : { busy: !sourceError, error: sourceError }
  useEffect(() => {
    let alive = true
    if (sourceError) { setResult({ scope, status: { busy: false, error: sourceError } }); return }
    if (waitingSource) return
    setResult({ scope, status: { busy: true, error: '' } })
    const task = layerPreviewScheduler.schedule({
      current: () => alive && latest.current === scope,
      create: () => createPreviewCanvas(size.width, size.height),
      paint: (value, signal) => paintBrowserImageLayerFullPreview(previewContext(value), { recipe, layerIndex, source, signal }),
      publish(value) {
        if (!canvas.current) return false
        publishPreviewCanvas(canvas.current, value)
        setResult({ scope, status: { busy: false, error: '' } })
        return false
      },
      dispose: disposePreviewCanvas,
      fail(cause) { setResult({ scope, status: { busy: false, error: cause instanceof Error ? cause.message : '完整图层预览失败，请重试' } }) },
    })
    return () => { alive = false; task.cancel() }
  }, [scope, waitingSource])
  useEffect(() => { if (visible) onStatus(status) }, [visible, onStatus, status.busy, status.error, scope])
  return <div className="layer-filter-preview-frame" hidden={!visible} aria-busy={status.busy}>
    <canvas ref={canvas} width={size.width} height={size.height} aria-label="完整图层采样预览" style={{ visibility: status.busy || status.error ? 'hidden' : 'visible' }} />
    {(status.busy || status.error) && <span className="layer-filter-raster-message" role={status.error ? 'alert' : 'status'}>{status.error || (waitingSource ? '正在读取图层素材…' : '正在计算完整图层预览…')}</span>}
  </div>
}

export function LayerFilterPreview({ recipe, afterRecipe, layerIndex, images, frame, before, documentOutline, revision, onRasterStatus }: { recipe: ImageLayerRecipe; afterRecipe: ImageLayerRecipe; layerIndex: number; images: readonly LayerToolImage[]; frame: LayerFilterPresentationFrame; before: boolean; documentOutline: boolean; revision: number; onRasterStatus(status: LayerPreviewRasterStatus): void }) {
  const layer = recipe.layers[layerIndex], image = !layer.content ? images[layer.sourceIndex] : undefined
  const sourceKey = JSON.stringify([image?.key, image?.asset.assetId, image?.asset.localUrl, revision])
  const currentKey = useRef(sourceKey); currentKey.current = sourceKey
  const alive = useRef(true), [decoded, setDecoded] = useState<FilterPreviewSourceState | null>(null)
  const source = decoded?.key === sourceKey ? decoded.source : undefined
  const sourceError = !layer.content && (!image || !resolveCanvasAssetDisplayUrl(image.asset.localUrl)) ? '图层素材不可用，请重新选择素材后编辑' : decoded?.key === sourceKey ? decoded.error : ''
  function loaded(element: HTMLImageElement) {
    if (!alive.current || currentKey.current !== sourceKey) return
    if (!element.naturalWidth || !element.naturalHeight) { failed(); return }
    image?.onLoad(element)
    if (alive.current && currentKey.current === sourceKey) setDecoded({ key: sourceKey, source: { image: element, width: element.naturalWidth, height: element.naturalHeight }, error: '' })
  }
  function failed() { if (alive.current && currentKey.current === sourceKey) setDecoded({ key: sourceKey, error: '图层素材读取失败，请重新预览或重新选择素材' }) }
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  return <div className="layer-filter-full-preview" aria-label="图层原始视图">
    {image && <div className="layer-preview-decoders" aria-hidden="true"><SafeImage key={sourceKey} src={image.asset.localUrl || ''} alt="" onLoad={(event) => loaded(event.currentTarget)} onError={failed} /></div>}
    <FilterPreviewFrame recipe={afterRecipe} layerIndex={layerIndex} frame={frame} source={source} sourceError={sourceError} visible={!before} revision={revision} onStatus={onRasterStatus} />
    <FilterPreviewFrame recipe={recipe} layerIndex={layerIndex} frame={frame} source={source} sourceError={sourceError} visible={before} revision={revision} onStatus={onRasterStatus} />
    {documentOutline && <svg className="layer-filter-document-outline" viewBox={`0 0 ${frame.width} ${frame.height}`} aria-label="文档范围线"><polygon points={frame.documentPolygon.map((point) => point.join(',')).join(' ')} /></svg>}
  </div>
}
