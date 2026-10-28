import { parseTileInput, resolveTileInputSlots, type TileInputSelection } from './tile-input'
import { tileEditorInputScope } from './tile-preview-state'
import { TileViewport } from './TileViewport'
import { CollageInputSorter, type CollageSortableImage } from './CollageInputSorter'
import { parseImageCollageInputOrder, orderCollageInputs, resolveCollageInputSlots, type ImageCollageInputOrder } from './collage-input-order'
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Expand, RotateCcw, RotateCw, SlidersHorizontal, X } from 'lucide-react'
import { SafeImage } from '../components/MediaPreview'
import { resolveCanvasAssetDisplayUrl } from '../asset-display-url'
import type { UpstreamMediaReference } from '../components/upstream-references'
import type { AssetRef, WorkflowNodeData } from '../model'
import { PanoramaPreview } from './PanoramaPreview'
import { initialPanoramaView, parsePanoramaView, type PanoramaView } from './panorama-view-state'
import { ImageComparePreview } from './ComparePreview'
import type { CompareViewState, CompareImageSlot } from './compare-view-state'
import { parseImageCompareSettings, resolveCompareInputReferences, resolveImageCompareView, persistImageCompareView } from './viewer-settings'
import { ImageGridPreview } from './ImageGridPreview'
import { CollageLayoutControls, CollageStyleControls } from './CollageStyleControls'
import { resolveCollageOutputSize } from './collage-layout'
import { validateImageToolDraft } from './editor-validation'
import { LayerEditor, LayerRecipePreview } from './LayerEditor'
import type { LayerPsdApplyInput } from './layer-psd-apply'
import { cropOutputRatio, cropPixelRatio, fitCropRatio, moveCrop, resizeCrop, resizeCropOutput, rotateCrop, syncCropOutput } from './crop-editor-state'
import { defaultImageTransformRecipe, imageTransformKindForNode, imageTransformRecipeForNode, type ImageCollageRecipe, type ImageCropRecipe, type ImageTransformRecipe } from './recipe'
import { imagePreviewOriginalOutputSize, imagePreviewSourceKey, recordImagePreviewSize, resolveImagePreviewSize } from './preview-image-dimensions'
import type { ImageTransformSize } from './geometry'
import { CropPresetPanel } from './CropPresetPanel'
import { cropRatioModes, defaultImageCropEditorPreferences, parseImageCropEditorPreferences, reconcileUnlockedCropOutputRatio, type ImageCropEditorPreferences } from './crop-editor-preferences'
import { adaptCropPresetToSource, type CropPresetConfiguration } from './crop-presets'
import './image-tools.css'

interface ToolImage { key: string; label: string; asset: AssetRef; dimensions: ImageTransformSize; dimensionsReady: boolean; onLoad(image: HTMLImageElement): void }
interface CollageToolImage extends ToolImage, CollageSortableImage {}
const toolNames: Record<string, string> = { 'image-crop': '裁剪图片', 'image-collage': '拼图', 'image-grid-split': '宫格裁剪', 'image-tile': '平铺图片', 'image-layer': '图层合成', 'image-compare': '图片对比', 'image-panorama': '全景预览' }

function useToolImages(references: readonly UpstreamMediaReference[]): ToolImage[] {
  const [measured, setMeasured] = useState<ReadonlyMap<string, ImageTransformSize>>(() => new Map())
  const readyReferences = references.filter((reference) => reference.kind === 'image' && reference.asset?.localUrl)
  const activeSources = useRef(new Set<string>())
  activeSources.current = new Set(readyReferences.map((reference) => imagePreviewSourceKey(reference.asset!)))
  return readyReferences.map((reference, index) => {
    const asset = reference.asset!, source = imagePreviewSourceKey(asset)
    return { key: `${reference.edgeId}-${index}`, label: reference.label, asset, dimensions: resolveImagePreviewSize(asset, measured), dimensionsReady: measured.has(source), onLoad(image) {
      const { naturalWidth, naturalHeight } = image
      setMeasured((current) => recordImagePreviewSize(current, activeSources.current, source, naturalWidth, naturalHeight))
    } }
  })
}

function ToolDialog({ title, children, busy = false, fullScreen = false, onClose }: { title: string; children: ReactNode; busy?: boolean; fullScreen?: boolean; onClose(): void }) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panel.current?.querySelector<HTMLElement>('button')?.focus()
    return () => { if (previous?.isConnected) previous.focus() }
  }, [])
  return createPortal(<div className={`image-tool-backdrop nodrag nopan nowheel${fullScreen ? ' image-compare-backdrop' : ''}`} onPointerDown={(event) => { event.stopPropagation(); if (!busy && event.target === event.currentTarget) onClose() }} onWheel={(event) => event.stopPropagation()}>
    <section ref={panel} className={`image-tool-dialog${fullScreen ? ' image-compare-dialog' : ''}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={(event) => {
      event.stopPropagation()
      if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose() }
      if (event.key === 'Tab') {
        const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length)
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0]?.focus() }
      }
    }}>
      <header><div><span>图像工具</span><h2>{title}</h2></div><button type="button" aria-label="关闭图像工具" disabled={busy} onClick={onClose}><X size={20} /></button></header>
      {children}
    </section>
  </div>, document.body)
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange(value: number): void }) {
  return <label>{label}<input type="number" aria-label={label} value={Number(value.toFixed(4))} min={min} max={max} step={step} onChange={(event) => { const next = event.currentTarget.valueAsNumber; if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, next))) }} /></label>
}

function backgroundStyle(value: string): CSSProperties {
  return value === 'transparent' ? {} : { background: value }
}

function ImageCell({ image, fit = 'contain', style }: { image?: ToolImage; fit?: 'contain' | 'cover' | 'fill'; style?: CSSProperties }) {
  return image?.asset.localUrl ? <SafeImage key={imagePreviewSourceKey(image.asset)} src={image.asset.localUrl} onLoad={(event) => image.onLoad(event.currentTarget)} alt={image.label} draggable={false} style={{ objectFit: fit, ...style }} /> : <span className="image-tool-cell-empty">连接图片</span>
}

function CropResultPreview({ recipe, image }: { recipe: ImageCropRecipe; image?: ToolImage }) {
  const clipId = useId().replace(/:/g, '')
  if (!image?.asset.localUrl || !image.dimensionsReady) return null
  const { width, height } = image.dimensions
  const cropX = Math.floor(recipe.x * width), cropY = Math.floor(recipe.y * height)
  const cropWidth = Math.min(width, Math.ceil((recipe.x + recipe.width) * width)) - cropX
  const cropHeight = Math.min(height, Math.ceil((recipe.y + recipe.height) * height)) - cropY
  const rotated = recipe.rotation === 90 || recipe.rotation === 270
  const rotate = recipe.rotation === 90 ? `translate(${cropHeight} 0) rotate(90)` : recipe.rotation === 180 ? `translate(${cropWidth} ${cropHeight}) rotate(180)` : recipe.rotation === 270 ? `translate(0 ${cropWidth}) rotate(270)` : ''
  return <figure className="image-tool-crop-output"><figcaption>输出预览 · {recipe.outputWidth} × {recipe.outputHeight}</figcaption><svg role="img" aria-label="裁剪旋转翻转后的输出预览" viewBox={`0 0 ${recipe.outputWidth} ${recipe.outputHeight}`}>
    <defs><clipPath id={clipId}><rect width={cropWidth} height={cropHeight} /></clipPath></defs>
    <g transform={`translate(${recipe.flipX ? recipe.outputWidth : 0} ${recipe.flipY ? recipe.outputHeight : 0}) scale(${recipe.flipX ? -1 : 1} ${recipe.flipY ? -1 : 1})`}>
      <g transform={`scale(${recipe.outputWidth / (rotated ? cropHeight : cropWidth)} ${recipe.outputHeight / (rotated ? cropWidth : cropHeight)})`}><g transform={rotate}><g clipPath={`url(#${clipId})`}>
        <image href={resolveCanvasAssetDisplayUrl(image.asset.localUrl)} x={-cropX} y={-cropY} width={width} height={height} preserveAspectRatio="none" />
      </g></g></g>
    </g>
  </svg></figure>
}

function RecipePreview({ recipe, images, editable = false, cropRatio = null, snapCrop = false, onChange }: { recipe: ImageTransformRecipe; images: readonly ToolImage[]; editable?: boolean; cropRatio?: number | null; snapCrop?: boolean; onChange?(recipe: ImageTransformRecipe): void }) {
  const drag = useRef<{ x: number; y: number; recipe: ImageCropRecipe; mode: 'move' | 'resize'; width: number; height: number } | null>(null)
  const source = images[0]
  const sourceSize = source?.dimensions ?? { width: 1024, height: 1024 }
  const sourceRatio = sourceSize.width / sourceSize.height
  const cropEditable = editable && (!source || source.dimensionsReady)
  const ratio = 'outputWidth' in recipe ? recipe.outputWidth / recipe.outputHeight : sourceRatio
  const frameStyle = (aspect: number): CSSProperties => ({ aspectRatio: aspect, width: `min(100%, calc(var(--image-tool-preview-height, 240px) * ${aspect}))` })
  if (recipe.kind === 'crop') return <div className="image-tool-crop-stage" style={frameStyle(sourceRatio)}>
    <ImageCell image={source} />
    <div className={`image-tool-crop-box${cropEditable ? ' is-editable' : ''}`} style={{ left: `${recipe.x * 100}%`, top: `${recipe.y * 100}%`, width: `${recipe.width * 100}%`, height: `${recipe.height * 100}%` }} aria-label="裁剪范围" tabIndex={cropEditable ? 0 : undefined} onKeyDown={(event) => {
      if (!cropEditable || !onChange || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
      event.preventDefault(); event.stopPropagation()
      const step = event.shiftKey ? 10 : 1
      onChange(moveCrop(recipe, (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0) / sourceSize.width, (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) / sourceSize.height))
    }} onPointerDown={(event) => {
      if (!cropEditable) return
      event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
      const bounds = event.currentTarget.parentElement!.getBoundingClientRect()
      drag.current = { x: event.clientX, y: event.clientY, recipe, mode: (event.target as HTMLElement).dataset.resize ? 'resize' : 'move', width: bounds.width, height: bounds.height }
    }} onPointerMove={(event) => {
      if (!drag.current || !onChange) return
      const start = drag.current, dx = (event.clientX - start.x) / start.width, dy = (event.clientY - start.y) / start.height
      onChange(start.mode === 'move' ? moveCrop(start.recipe, dx, dy, snapCrop ? { x: 8 / start.width, y: 8 / start.height } : undefined) : resizeCrop(start.recipe, start.recipe.width + dx, start.recipe.height + dy, sourceSize, cropRatio, Math.abs(dx * start.width) >= Math.abs(dy * start.height) ? 'width' : 'height'))
    }} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <span className="image-tool-thirds" />{cropEditable && <span data-resize="true" className="image-tool-crop-grip" />}
    </div>
  </div>
  if (recipe.kind === 'layer') return <LayerRecipePreview recipe={recipe} images={images} />
  return <ImageGridPreview recipe={recipe} images={images} />
}

function RecipeEditor({ initial, initialPreferences, images: baseImages, initialOrder, collageInputs, collageScope, onApply, onClose, onPresetBusyChange }: { initial: ImageTransformRecipe; initialPreferences?: unknown; images: readonly ToolImage[]; initialOrder?: ImageCollageInputOrder; collageInputs?: readonly CollageToolImage[]; collageScope?: string; onApply(recipe: ImageTransformRecipe, preferences?: ImageCropEditorPreferences, order?: ImageCollageInputOrder): void; onClose(): void; onPresetBusyChange?(busy: boolean): void }) {
  const [opening] = useState(() => {
    if (initial.kind !== 'crop') return { preferences: null, error: '' }
    try { return { preferences: initialPreferences === undefined ? defaultImageCropEditorPreferences(initial) : reconcileUnlockedCropOutputRatio(initial, parseImageCropEditorPreferences(initialPreferences)), error: '' } }
    catch { return { preferences: defaultImageCropEditorPreferences(initial), error: '旧裁剪编辑偏好无法读取，已使用默认编辑选项；裁剪参数仍保留。' } }
  })
  const [recipe, setRecipe] = useState(initial)
  const [collageOrder, setCollageOrder] = useState(initialOrder)
  const images = initial.kind === 'collage' && collageInputs ? orderCollageInputs(collageInputs, collageOrder) : baseImages
  const [ratio, setRatio] = useState<ImageCropEditorPreferences['ratioMode']>(opening.preferences?.ratioMode ?? '自由')
  const [customRatio, setCustomRatio] = useState({ width: opening.preferences?.customWidth ?? 7, height: opening.preferences?.customHeight ?? 5 })
  const [cropLocked, setCropLocked] = useState(opening.preferences?.cropLocked ?? false)
  const [outputLocked, setOutputLocked] = useState(opening.preferences?.outputLocked ?? true)
  const [outputLockedRatio, setOutputLockedRatio] = useState(opening.preferences?.outputRatio ?? 1)
  const [snapping, setSnapping] = useState(opening.preferences?.snapping ?? true)
  const [presetBusy, setPresetBusy] = useState(false)
  const sourceSize = images[0]?.dimensions ?? { width: 1024, height: 1024 }
  const lockedRatio = recipe.kind === 'crop' && cropLocked ? cropPixelRatio(recipe, sourceSize) : null
  const [error, setError] = useState(opening.error)
  const automaticCollage = recipe.kind === 'collage' && recipe.autoSize === true
  let displayedOutput = 'outputWidth' in recipe ? { width: recipe.outputWidth, height: recipe.outputHeight } : sourceSize
  let automaticSizeMessage = ''
  if (automaticCollage) {
    if (!images.length || images.some((image) => !image.dimensionsReady)) automaticSizeMessage = '图片尺寸加载后显示自动输出尺寸'
    else {
      try { displayedOutput = resolveCollageOutputSize(images.map((image) => image.dimensions), recipe) }
      catch (cause) { automaticSizeMessage = cause instanceof Error ? cause.message : '自动拼图尺寸暂不可用' }
    }
  }
  function currentPreferences(): ImageCropEditorPreferences { return { version: 1, ratioMode: ratio, customWidth: customRatio.width, customHeight: customRatio.height, cropLocked, outputLocked, outputRatio: outputLockedRatio, snapping } }
  function loadPreset(value: CropPresetConfiguration) {
    const next = adaptCropPresetToSource(value, images[0]?.dimensionsReady ? images[0].dimensions : undefined)
    next.preferences = reconcileUnlockedCropOutputRatio(next.recipe, next.preferences)
    setRecipe(next.recipe); setRatio(next.preferences.ratioMode); setCustomRatio({ width: next.preferences.customWidth, height: next.preferences.customHeight })
    setCropLocked(next.preferences.cropLocked); setOutputLocked(next.preferences.outputLocked); setOutputLockedRatio(next.preferences.outputRatio); setSnapping(next.preferences.snapping); setError('')
  }
  function patch(value: Record<string, unknown>) { setRecipe((current) => ({ ...current, ...value } as ImageTransformRecipe)); setError('') }
  function patchCollageLayout(value: Partial<ImageCollageRecipe>) {
    patch({ ...(automaticCollage && value.autoSize === false && !automaticSizeMessage ? { outputWidth: displayedOutput.width, outputHeight: displayedOutput.height } : {}), ...value })
  }
  function syncOutput(next: ImageCropRecipe, exactRatio?: number) { setRecipe(next); setOutputLockedRatio(exactRatio ?? next.outputWidth / next.outputHeight); setError('') }
  function resizeOutput(edge: 'width' | 'height', value: number) {
    if (recipe.kind !== 'crop') { patch(edge === 'width' ? { outputWidth: value } : { outputHeight: value }); return }
    const next = resizeCropOutput(recipe, edge, value, outputLocked ? outputLockedRatio : null)
    setRecipe(next)
    if (!outputLocked) setOutputLockedRatio(next.outputWidth / next.outputHeight)
    setError('')
  }
  function setOutputResolution(edge: number) {
    if (!('outputWidth' in recipe)) return
    const aspect = recipe.kind === 'crop' ? outputLockedRatio : displayedOutput.width / displayedOutput.height
    patch({ outputWidth: Math.max(1, Math.round(Math.min(edge, edge * aspect))), outputHeight: Math.max(1, Math.round(Math.min(edge, edge / aspect))), ...(recipe.kind === 'collage' ? { autoSize: false } : {}) })
  }
  function syncCropSize() {
    if (recipe.kind !== 'crop') return
    try {
      const exactSourceRatio = ratio !== '自由' && cropLocked ? cropPixelRatio(recipe, sourceSize) : undefined
      syncOutput(syncCropOutput(recipe, sourceSize, undefined, exactSourceRatio), exactSourceRatio === undefined ? undefined : cropOutputRatio(recipe, exactSourceRatio))
    } catch (cause) { setError(cause instanceof Error ? cause.message : '裁剪尺寸无效') }
  }
  function rotateOutput(clockwise: boolean) {
    if (recipe.kind !== 'crop') return
    const next = rotateCrop(recipe, clockwise)
    setRecipe(next)
    setOutputLockedRatio(1 / outputLockedRatio)
    setError('')
  }
  function setCropRatio(next: ImageCropEditorPreferences['ratioMode'], custom = customRatio) {
    if (recipe.kind !== 'crop' || (images[0] && !images[0].dimensionsReady)) return
    if (next === '自由') { setRatio(next); setCropLocked(false); return }
    const parts = next.split(':').map(Number)
    const target = next === '原图' ? sourceSize.width / sourceSize.height : next === '自定义' ? custom.width / custom.height : parts[0] / parts[1]
    try {
      const fitted = fitCropRatio(recipe, sourceSize, target)
      const output = syncCropOutput(fitted, sourceSize, Math.max(recipe.outputWidth, recipe.outputHeight), target)
      setRatio(next); setCropLocked(true)
      syncOutput(output, cropOutputRatio(fitted, target))
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '裁剪比例无效') }
  }
  return <div className="image-tool-editor-body">
    <div className="image-tool-editor-preview">{recipe.kind === 'collage' ? <CollageInputSorter items={orderCollageInputs(collageInputs ?? [], collageOrder)} scopeKey={collageScope ?? ''} onReorder={setCollageOrder} renderPreview={(cellControls) => <ImageGridPreview recipe={recipe} images={images} cellControls={cellControls} />} /> : <RecipePreview recipe={recipe} images={images} editable cropRatio={lockedRatio} snapCrop={snapping} onChange={setRecipe} />}<p>{recipe.kind === 'crop' ? '拖动范围或右下角调整大小；方向键移动 1 像素，Shift + 方向键移动 10 像素。应用后运行，原图保留。' : recipe.kind === 'grid-split' ? `将按从左到右、从上到下输出 ${recipe.rows * recipe.columns} 张独立切片。` : '预览展示布局。应用参数后运行此节点，处理结果会保存到素材库。'}</p>{recipe.kind === 'crop' && <CropResultPreview recipe={recipe} image={images[0]} />}{recipe.kind !== 'collage' && <div className="image-tool-input-strip" aria-label="有序输入图片">{images.map((image, index) => <figure key={image.key}><ImageCell image={image} /><figcaption>{index + 1} · {image.label}</figcaption></figure>)}</div>}</div>
    <aside>
      {recipe.kind === 'crop' && <CropPresetPanel recipe={recipe} preferences={currentPreferences()} sourceReady={images[0]?.dimensionsReady === true} onApply={loadPreset} onBusyChange={(busy) => { setPresetBusy(busy); onPresetBusyChange?.(busy) }} />}
      {recipe.kind === 'crop' && <><label>画面比例<select aria-label="裁剪比例" disabled={!!images[0] && !images[0].dimensionsReady} value={ratio} onChange={(event) => setCropRatio(event.target.value as ImageCropEditorPreferences['ratioMode'])}>{cropRatioModes.map((value) => <option key={value}>{value}</option>)}</select></label>{ratio === '自定义' && <div className="image-tool-fields"><NumberField label="自定义比例宽" value={customRatio.width} min={1} max={100} onChange={(width) => { const next = { ...customRatio, width }; setCustomRatio(next); setCropRatio('自定义', next) }} /><NumberField label="自定义比例高" value={customRatio.height} min={1} max={100} onChange={(height) => { const next = { ...customRatio, height }; setCustomRatio(next); setCropRatio('自定义', next) }} /></div>}<div className="image-tool-checks"><label><input type="checkbox" checked={cropLocked} onChange={(event) => setCropLocked(event.target.checked)} />锁定裁剪比例</label><label><input type="checkbox" checked={snapping} onChange={(event) => setSnapping(event.target.checked)} />边缘与居中吸附</label></div><div className="image-tool-fields">
        <NumberField label="裁剪起点 X %" value={recipe.x * 100} min={0} max={(1 - recipe.width) * 100} step={0.1} onChange={(value) => patch({ x: value / 100 })} />
        <NumberField label="裁剪起点 Y %" value={recipe.y * 100} min={0} max={(1 - recipe.height) * 100} step={0.1} onChange={(value) => patch({ y: value / 100 })} />
        <NumberField label="裁剪宽度 %" value={recipe.width * 100} min={1} max={(1 - recipe.x) * 100} step={0.1} onChange={(value) => setRecipe(resizeCrop(recipe, value / 100, recipe.height, sourceSize, lockedRatio))} />
        <NumberField label="裁剪高度 %" value={recipe.height * 100} min={1} max={(1 - recipe.y) * 100} step={0.1} onChange={(value) => setRecipe(resizeCrop(recipe, recipe.width, value / 100, sourceSize, lockedRatio, 'height'))} />
      </div><div className="image-tool-inline-actions"><button type="button" onClick={() => rotateOutput(false)}><RotateCcw size={14} />左转</button><button type="button" onClick={() => rotateOutput(true)}><RotateCw size={14} />右转</button><span>{recipe.rotation}°</span></div><div className="image-tool-checks"><label><input type="checkbox" checked={recipe.flipX} onChange={(event) => patch({ flipX: event.target.checked })} />水平翻转</label><label><input type="checkbox" checked={recipe.flipY} onChange={(event) => patch({ flipY: event.target.checked })} />垂直翻转</label></div></>}
      {recipe.kind === 'collage' && <CollageLayoutControls recipe={recipe} inputCount={images.length} onChange={patchCollageLayout} />}
      {(recipe.kind === 'collage' || recipe.kind === 'tile') && <><h3>画面比例</h3><div className="image-tool-layout-presets">{['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3'].map((value) => <button type="button" key={value} onClick={() => { const [width, height] = value.split(':').map(Number); const edge = Math.max(recipe.outputWidth, recipe.outputHeight); patch({ outputWidth: Math.max(1, Math.round(edge * width / Math.max(width, height))), outputHeight: Math.max(1, Math.round(edge * height / Math.max(width, height))), ...(recipe.kind === 'collage' ? { autoSize: false } : {}) }) }}>{value}</button>)}</div></>}
      {'rows' in recipe && <div className="image-tool-fields">{(recipe.kind !== 'collage' || !recipe.layout || recipe.layout === 'grid') && <><NumberField label="行数" value={recipe.rows} min={1} max={recipe.kind === 'tile' ? 8 : 4} onChange={(rows) => patch({ rows })} /><NumberField label="列数" value={recipe.columns} min={1} max={recipe.kind === 'tile' ? 8 : 4} onChange={(columns) => patch({ columns })} /></>}<NumberField label="间距（像素）" value={recipe.gap} min={0} max={512} onChange={(gap) => patch({ gap })} />{'padding' in recipe && <NumberField label="边距（像素）" value={recipe.padding} min={0} max={512} onChange={(padding) => patch({ padding })} />}</div>}
      {recipe.kind === 'collage' && <CollageStyleControls recipe={recipe} onChange={patch} />}
      {'outputWidth' in recipe && <><h3>输出尺寸</h3>{recipe.kind === 'crop' && <label className="image-tool-checks"><input type="checkbox" checked={outputLocked} onChange={(event) => setOutputLocked(event.target.checked)} />锁定输出宽高比</label>}{automaticCollage ? <output className="image-tool-auto-output" aria-label="自动拼图输出尺寸">{automaticSizeMessage || `${displayedOutput.width} × ${displayedOutput.height} 像素`}</output> : <div className="image-tool-fields"><NumberField label="输出宽度" value={recipe.outputWidth} min={1} max={4096} onChange={(outputWidth) => resizeOutput('width', outputWidth)} /><NumberField label="输出高度" value={recipe.outputHeight} min={1} max={4096} onChange={(outputHeight) => resizeOutput('height', outputHeight)} /></div>}<div className="image-tool-inline-actions">{[1024, 2048, 4096].map((edge) => <button key={edge} type="button" onClick={() => setOutputResolution(edge)}>{edge / 1024}K</button>)}{images[0] && <button type="button" disabled={!images[0].dimensionsReady} onClick={() => { if (recipe.kind === 'crop') { syncCropSize(); return } const size = imagePreviewOriginalOutputSize(images[0].dimensions); patch({ outputWidth: size.width, outputHeight: size.height, ...(recipe.kind === 'collage' ? { autoSize: false } : {}) }) }}>{recipe.kind === 'crop' ? '同步裁剪尺寸' : '使用原图尺寸'}</button>}</div></>}
      {'fit' in recipe && <label>图片填充<select value={recipe.fit} aria-label="图片填充方式" onChange={(event) => patch({ fit: event.target.value })}><option value="cover">填满格子（居中裁切）</option><option value="contain">保留完整图片</option></select></label>}
      {'background' in recipe && <label>背景<select aria-label="背景颜色" value={recipe.background} onChange={(event) => patch({ background: event.target.value })}><option value="transparent">透明</option><option value="#ffffff">白色</option><option value="#111318">深色</option><option value="#eeeae2">暖灰</option>{!['transparent', '#ffffff', '#111318', '#eeeae2'].includes(recipe.background) && <option value={recipe.background}>自定义 {recipe.background}</option>}</select>{recipe.background !== 'transparent' && <input type="color" aria-label="自定义背景颜色" value={recipe.background.slice(0, 7)} onChange={(event) => patch({ background: event.target.value })} />}</label>}
      {recipe.kind === 'tile' && <label className="image-tool-checks"><input type="checkbox" checked={recipe.mirrorAlternate} onChange={(event) => patch({ mirrorAlternate: event.target.checked })} />交替镜像排列</label>}
      {error && <p className="image-tool-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={presetBusy} onClick={() => { const reset = defaultImageTransformRecipe(recipe.kind); setRecipe(reset); setOutputLockedRatio(reset.kind === 'crop' ? reset.outputWidth / reset.outputHeight : 1); setRatio('自由'); setCustomRatio({ width: 7, height: 5 }); setCropLocked(false); setOutputLocked(true); setSnapping(true); setError('') }}>重置</button><button type="button" className="is-primary" disabled={presetBusy} onClick={() => { try { const validated = validateImageToolDraft(recipe, images); if (recipe.kind === 'collage' && collageOrder !== undefined) onApply(validated, undefined, collageOrder); else onApply(validated, recipe.kind === 'crop' ? parseImageCropEditorPreferences(currentPreferences()) : undefined); onClose() } catch (cause) { setError(cause instanceof Error ? cause.message : '参数无效') } }}>应用参数</button></footer>
    </aside>
  </div>
}

export function ImageToolControls({ kind, data, references, disabled, onChange, onApplyWithImports, onTileChange, onDownloadTileSource, allowPageDownload = true }: { kind: string; data: WorkflowNodeData; references: readonly UpstreamMediaReference[]; disabled: boolean; onChange(settings: Record<string, unknown>): void; onApplyWithImports?(input: LayerPsdApplyInput): void; onTileChange?(patch: Record<string, unknown>, expectedScope: string): void; onDownloadTileSource?(selection: TileInputSelection, expectedScope: string): Promise<void>; /** False when the host blocks page downloads: panorama views and color presets are not offered as files. */ allowPageDownload?: boolean }) {
  const [open, setOpen] = useState(false), [tilePreviewOpen, setTilePreviewOpen] = useState(false), [tileActionError, setTileActionError] = useState('')
  const [presetBusy, setPresetBusy] = useState(false)
  const rawImages = useToolImages(references)
  const readyReferences = references.filter((reference) => reference.kind === 'image' && reference.asset?.localUrl)
  const readyImageByReference = new Map(readyReferences.map((reference, index) => [reference, rawImages[index]]))
  let tileSelection: TileInputSelection | undefined, tileInputError = ''
  try { if (kind === 'image-tile' && data.settings?.tileInput !== undefined) tileSelection = parseTileInput(data.settings.tileInput) }
  catch (cause) { tileInputError = cause instanceof Error ? cause.message : '平铺贴图选择无效' }
  const tileInputs = resolveTileInputSlots(kind === 'image-tile' ? references : [], tileSelection)
  const tileSource = !tileInputError && tileInputs.selected && !tileInputs.selected.pending && !tileInputs.selected.missing && tileInputs.selected.reference ? readyImageByReference.get(tileInputs.selected.reference) : undefined
  const tileScope = tileEditorInputScope(references, data.settings?.tileInput)
  const openedTileScope = useRef(tileScope)
  useEffect(() => {
    if (kind === 'image-tile' && openedTileScope.current !== tileScope) { setOpen(false); setTileActionError('') }
    openedTileScope.current = tileScope
  }, [kind, tileScope])
  const waitingForImages = kind === 'image-tile' ? Boolean(tileInputs.selected?.pending) : references.some((reference) => reference.kind === 'image' && !reference.asset?.localUrl)
  const editingBlocked = disabled || (waitingForImages && kind !== 'image-compare') || Boolean(tileInputError)
  useEffect(() => { if (editingBlocked) { setOpen(false); setPresetBusy(false); setCompareDraft(null); setPanoramaDraft(null) } }, [editingBlocked])
  const tileMessage = tileInputError || (tileInputs.selected?.missing ? '已选贴图的连接已移除，请重新选择；不会自动换用其他图片。' : tileInputs.selected?.pending ? '当前贴图尚未就绪，保留原选择；其他贴图仍可切换。' : !tileSource ? '还没有可用贴图，请连接图片或等待上游完成。' : '')
  function applyTileSettings(patch: Record<string, unknown>) {
    if (disabled) throw new Error('当前节点不可编辑，请等待任务完成或核对编辑权限')
    if (onTileChange) onTileChange(patch, tileScope)
    else onChange(patch)
  }
  function chooseTile(index: number) {
    if (disabled || index === tileInputs.selectedIndex && !tileInputError) return
    const slot = tileInputs.slots[index]
    if (!slot?.edgeId || slot.missing) return
    try { applyTileSettings({ tileInput: { edgeId: slot.edgeId, outputIndex: slot.outputIndex } }); setTileActionError('') }
    catch (cause) { setTileActionError(cause instanceof Error ? cause.message : '当前贴图无法切换') }
  }
  function tileSelector() {
    return <div className="tile-input-selector" aria-label="平铺贴图切换">
      <button type="button" aria-label="上一张贴图" disabled={disabled || tileInputs.selectedIndex <= 0} onClick={() => chooseTile(tileInputs.selectedIndex - 1)}><ChevronLeft size={14} /></button>
      <label>当前处理贴图<select aria-label="当前平铺贴图" disabled={disabled || !tileInputs.slots.length} value={tileInputs.selectedIndex} onChange={(event) => chooseTile(Number(event.currentTarget.value))}>
        {!tileInputs.slots.length && <option value={-1}>等待图片连接</option>}
        {tileInputs.slots.map((slot, index) => <option key={`${slot.edgeId ?? 'missing'}:${slot.outputIndex}`} value={index} disabled={slot.missing}>{index + 1} · {slot.missing ? '原贴图已断开' : slot.reference?.label ?? '图片'}{slot.pending ? ' · 待就绪' : ''}</option>)}
      </select></label><span>{tileInputs.selectedIndex < 0 ? 0 : tileInputs.selectedIndex + 1}/{tileInputs.slots.length}</span>
      <button type="button" aria-label="下一张贴图" disabled={disabled || tileInputs.selectedIndex < 0 || tileInputs.selectedIndex >= tileInputs.slots.length - 1} onClick={() => chooseTile(tileInputs.selectedIndex + 1)}><ChevronRight size={14} /></button>
    </div>
  }
  let collageOrder: ImageCollageInputOrder | undefined, collageOrderError = ''
  if (kind === 'image-collage' && data.settings?.imageCollageInputOrder !== undefined) {
    try { collageOrder = parseImageCollageInputOrder(data.settings.imageCollageInputOrder) } catch (cause) { collageOrderError = cause instanceof Error ? cause.message : '拼图输入顺序无效' }
  }
  const collageInputs: CollageToolImage[] = kind === 'image-collage' ? resolveCollageInputSlots(references, collageOrder).map((slot) => {
    const ready = !slot.pending ? readyImageByReference.get(slot.reference) : undefined
    return { edgeId: slot.edgeId, outputIndex: slot.outputIndex, pending: slot.pending, key: JSON.stringify([slot.edgeId, slot.outputIndex]), label: `${slot.reference.label}${slot.pending && slot.outputIndex ? ` · 第 ${slot.outputIndex + 1} 张` : ''}`, asset: ready?.asset ?? { kind: 'image' }, url: ready?.asset.localUrl, dimensions: ready?.dimensions ?? { width: 1024, height: 1024 }, dimensionsReady: ready?.dimensionsReady ?? false, onLoad: ready?.onLoad ?? (() => {}) }
  }) : []
  const images: ToolImage[] = kind === 'image-tile' ? tileSource ? [tileSource] : [] : kind === 'image-collage' ? collageInputs : rawImages
  const collageScope = JSON.stringify([references.filter((reference) => reference.kind === 'image').map((reference) => [reference.edgeId, reference.asset?.assetId ?? reference.asset?.localUrl ?? null, reference.status]), collageOrder])
  const openedCollageScope = useRef(collageScope)
  useEffect(() => {
    if (kind === 'image-collage' && openedCollageScope.current !== collageScope) setOpen(false)
    openedCollageScope.current = collageScope
  }, [kind, collageScope])
  const title = toolNames[kind]
  const operation = imageTransformKindForNode(kind)
  let recipe: ImageTransformRecipe | null = null, error = ''
  try { recipe = imageTransformRecipeForNode(kind, data.settings) } catch (cause) { error = cause instanceof Error ? cause.message : '图像参数无效' }
  let outputLabel = recipe?.kind === 'grid-split' ? `${recipe.rows * recipe.columns} 张切片` : recipe && 'outputWidth' in recipe ? `${recipe.outputWidth} × ${recipe.outputHeight}` : '预览工具'
  if (recipe?.kind === 'collage' && recipe.autoSize) {
    outputLabel = '按图片比例自动尺寸'
    if (!data.dirty && data.result?.width && data.result?.height) outputLabel = `${data.result.width} × ${data.result.height}`
    else if (images.length && images.every((image) => image.dimensionsReady)) {
      try { const size = resolveCollageOutputSize(images.map((image) => image.dimensions), recipe); outputLabel = `${size.width} × ${size.height}` } catch { /* Preview reports the layout error. */ }
    }
  }
  const imageReferences = references.filter((reference) => reference.kind === 'image')
  let compareSettings
  try { compareSettings = parseImageCompareSettings(data.settings?.imageCompare ?? { mode: 'slider' }) }
  catch { compareSettings = parseImageCompareSettings({ mode: 'slider' }) }
  let inputSlots: string[] = [], compareInputError = ''
  let compareInputs: ReturnType<typeof resolveCompareInputReferences<UpstreamMediaReference>> = []
  if (kind === 'image-compare') {
    try { compareInputs = resolveCompareInputReferences(imageReferences, compareSettings); inputSlots = compareInputs.map((slot) => slot.identity) }
    catch (cause) { compareInputError = cause instanceof Error ? cause.message : '图片对比输入位置无效' }
  }
  const compareDisabled = disabled || Boolean(compareInputError)
  const readyByReference = readyImageByReference
  const compareSlots: CompareImageSlot[] = compareInputs.map(({ reference, placeholder, outputIndex }, index) => ({ key: String(index), label: placeholder ? `${reference.label.replace(/ · 图片 \d+$/, '')} · 第 ${outputIndex + 1} 张` : reference.label, asset: placeholder ? undefined : reference.asset, dimensions: readyByReference.get(reference)?.dimensions ?? { width: 1024, height: 1024 }, onLoad: placeholder ? undefined : readyByReference.get(reference)?.onLoad }))
  const savedCompare = resolveImageCompareView(compareSettings, inputSlots)
  const compareScope = JSON.stringify([savedCompare, inputSlots, imageReferences.map((reference) => reference.asset?.assetId ?? reference.asset?.localUrl ?? null)])
  const [compareDraft, setCompareDraft] = useState<{ scope: string; view: CompareViewState } | null>(null)
  const compareView = compareDraft?.scope === compareScope ? compareDraft.view : savedCompare
  function commitCompare(view: CompareViewState) {
    if (compareDisabled) return
    setCompareDraft(null)
    onChange({ imageCompare: persistImageCompareView(view, inputSlots) })
  }
  const panoramaSourceImage = imageReferences[0] ? readyByReference.get(imageReferences[0]) : undefined
  const sourceKey = panoramaSourceImage?.asset.assetId ?? panoramaSourceImage?.asset.localUrl ?? ''
  let savedPanorama: PanoramaView
  try { savedPanorama = parsePanoramaView(data.settings?.imagePanorama) } catch { savedPanorama = { ...initialPanoramaView } }
  const panoramaScope = JSON.stringify([sourceKey, savedPanorama])
  const [panoramaDraft, setPanoramaDraft] = useState<{ scope: string; view: PanoramaView } | null>(null)
  const panoramaSource = useRef(sourceKey)
  useEffect(() => {
    if (kind !== 'image-panorama' || panoramaSource.current === sourceKey) return
    panoramaSource.current = sourceKey
    // A refreshed upstream result invalidates an unfinished gesture, not the
    // user's saved viewing configuration. Only explicit controls persist angles.
    setPanoramaDraft(null)
  }, [kind, sourceKey])
  const panoramaView = panoramaDraft?.scope === panoramaScope ? panoramaDraft.view : savedPanorama
  function commitPanorama(view: PanoramaView) { setPanoramaDraft(null); onChange({ imagePanorama: view }) }
  function compareModes() { return <div className="image-tool-mode-tabs image-compare-mode-tabs">{[['slider', '滑动'], ['opacity', '透明'], ['toggle', '点按'], ['side-by-side', '并排'], ['grid', '四图']].map(([value, label]) => <button key={value} type="button" aria-pressed={compareView.mode === value} disabled={compareDisabled} onClick={() => commitCompare({ ...compareView, mode: value as CompareViewState['mode'] })}>{label}</button>)}</div> }
  function preview(expanded = false) {
    if (kind === 'image-tile' && tileMessage) return <div className="image-tool-empty" role="status">{tileMessage}</div>
    if (recipe?.kind === 'collage' && !data.dirty && data.result?.localUrl && (!images.length || waitingForImages)) return <div className="image-tool-output-preview" style={{ aspectRatio: (data.result.width || 1) / (data.result.height || 1) }}><SafeImage src={data.result.localUrl} alt="图像处理结果" /></div>
    if (recipe?.kind === 'collage') {
      const collage = recipe
      return collageOrderError ? <div role="alert" className="image-tool-empty">{collageOrderError}</div> : <CollageInputSorter compact items={collageInputs} scopeKey={collageScope} disabled={disabled} onReorder={(imageCollageInputOrder) => onChange({ imageCollageInputOrder })} renderPreview={(cellControls) => <ImageGridPreview recipe={collage} images={images} cellControls={cellControls} />} />
    }
    if (recipe && !data.dirty && data.result?.localUrl) return <div className="image-tool-output-preview" style={{ aspectRatio: (data.result.width || 1) / (data.result.height || 1) }}><SafeImage src={data.result.localUrl} alt="图像处理结果" /></div>
    if (recipe) return <RecipePreview recipe={recipe} images={images} />
    if (kind === 'image-compare') return compareInputError ? <div className="image-tool-empty" role="alert">{compareInputError}。当前有 {imageReferences.length} 张输入，请减少连接或批量切片后继续；不会自动截断输入。</div> : <ImageComparePreview slots={compareSlots} view={compareView} scopeKey={compareScope} expanded={expanded} disabled={compareDisabled} onChange={(view) => setCompareDraft({ scope: compareScope, view })} onCommit={commitCompare} />
    if (kind === 'image-panorama' && panoramaSourceImage?.asset.localUrl) return <PanoramaPreview src={panoramaSourceImage.asset.localUrl} sourceKey={sourceKey} compact={!expanded} allowDownload={allowPageDownload} disabled={disabled} view={panoramaView} onChange={(view) => setPanoramaDraft({ scope: panoramaScope, view })} onCommit={commitPanorama} />
    return <div className="image-tool-empty">{kind === 'image-panorama' ? '连接等距柱状全景图，拖动探索 360° 视角' : error || '连接图片后设置处理参数'}</div>
  }
  return <section className="image-tool-node nodrag nopan nowheel" aria-label={`${title}工具`}>
    {kind === 'image-tile' && tileSelector()}
    {kind === 'image-compare' && compareModes()}
    <div className={`image-tool-node-preview${kind === 'image-collage' ? ' has-collage-order' : ''}`} onDoubleClick={(event) => { event.stopPropagation(); if (kind === 'image-tile') { setTilePreviewOpen(true); return }; if (!editingBlocked && !compareInputError && !collageOrderError) setOpen(true) }}>{preview()}</div>
    <div className="image-tool-node-meta"><span>{kind === 'image-tile' ? `${tileInputs.slots.length} 张贴图 · 每次处理当前一张` : images.length ? `${images.length} 张输入图片` : kind === 'image-layer' ? '支持文字、形状与绘画创作' : '等待图片连接'}</span><span>{outputLabel}</span></div>
    <button type="button" className="image-tool-open" disabled={editingBlocked || Boolean(compareInputError) || Boolean(collageOrderError)} onClick={() => setOpen(true)}>{operation ? <SlidersHorizontal size={14} /> : <Expand size={14} />}{kind === 'image-layer' ? '打开图层编辑器' : operation ? '编辑处理参数' : kind === 'image-compare' ? '全屏预览' : '展开预览'}</button>
    {kind === 'image-tile' && <button type="button" className="image-tool-open" onClick={() => setTilePreviewOpen(true)}><Expand size={14} />全屏平铺预览</button>}
    {tileActionError && kind === 'image-tile' && <p className="image-tool-error" role="alert">{tileActionError}</p>}
    {waitingForImages && kind !== 'image-tile' && <p className="image-tool-waiting" role="status">上游图片还未就绪，输入顺序保持不变。</p>}
    {operation && <small className="image-tool-no-model">本地图像处理 · 无需选择 AI 模型</small>}
    {tilePreviewOpen && kind === 'image-tile' && <ToolDialog title="无限平铺预览" fullScreen onClose={() => setTilePreviewOpen(false)}><div className="tile-preview-selector">{tileSelector()}{tileActionError && <p className="image-tool-error" role="alert">{tileActionError}</p>}</div><TileViewport image={tileSource} message={tileMessage} onDownload={tileSource && tileInputs.selected?.edgeId && onDownloadTileSource ? () => onDownloadTileSource({ edgeId: tileInputs.selected!.edgeId!, outputIndex: tileInputs.selected!.outputIndex }, tileScope) : undefined} /></ToolDialog>}
    {open && <ToolDialog title={title} busy={presetBusy} fullScreen={kind === 'image-compare'} onClose={() => { setOpen(false); setCompareDraft(null); setPanoramaDraft(null) }}>{recipe?.kind === 'layer' ? <LayerEditor initial={recipe} images={images} allowDownload={allowPageDownload} onApply={(imageTransform) => onChange({ imageTransform })} onApplyWithImports={onApplyWithImports} onClose={() => setOpen(false)} /> : operation ? <RecipeEditor initial={recipe || defaultImageTransformRecipe(operation)} initialPreferences={data.settings?.imageCropEditor} images={images} initialOrder={collageOrder} collageInputs={collageInputs} collageScope={collageScope} onPresetBusyChange={setPresetBusy} onApply={(imageTransform, imageCropEditor, imageCollageInputOrder) => { const patch = { imageTransform, ...(imageCropEditor ? { imageCropEditor } : {}), ...(imageCollageInputOrder ? { imageCollageInputOrder } : {}) }; if (kind === 'image-tile') applyTileSettings(patch); else onChange(patch) }} onClose={() => setOpen(false)} /> : <div className="image-tool-large-preview">{kind === 'image-compare' && compareModes()}{preview(true)}</div>}</ToolDialog>}
  </section>
}
