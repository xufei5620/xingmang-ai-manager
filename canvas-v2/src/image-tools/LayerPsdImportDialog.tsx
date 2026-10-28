import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { FileImage, Layers3, LoaderCircle, Upload, X } from 'lucide-react'
import { importBrowserLayerPsd, type BrowserLayerPsdDocument } from '../library/browser-layer-psd-import'
import { createLayerPsdImportController, initialLayerPsdImportState, layerPsdImportCapacityError, type LayerPsdImportState } from './layer-psd-import-state'
import './layer-psd-import.css'
import { materializeImageLayerGroups } from './layer-group-model'
import type { ImageLayerRecipe } from './recipe'

export interface LayerPsdImportDialogProps {
  onImport(document: BrowserLayerPsdDocument, options: { signal: AbortSignal }): Promise<void>
  onClose(): void
  disabled?: boolean
  maximumAdditionalLayers?: number
  maximumAdditionalSources?: number
  maximumAdditionalGroups?: number
}

const blendLabels = { 'source-over': '正常', multiply: '正片叠底', screen: '滤色', overlay: '叠加' }

export function LayerPsdImportPreview({ document, urls }: { document: BrowserLayerPsdDocument; urls: readonly string[] }) {
  const recipe: ImageLayerRecipe = { kind: 'layer', outputWidth: document.width, outputHeight: document.height, background: 'transparent', explicitLayers: true,
    layers: document.layers.map((layer, index) => ({ sourceIndex: index, x: 0, y: 0, width: 1, height: 1, rotation: 0, visible: layer.visible, opacity: layer.opacity, blend: layer.blend, ...(layer.locked !== undefined ? { locked: layer.locked } : {}) })), ...(document.layerGroups ? { layerGroups: document.layerGroups } : {}) }
  const effective = materializeImageLayerGroups(recipe).layers
  const grouping = document.layerGroups, groups = new Map(grouping?.groups.map((group) => [group.id, group]) ?? [])
  const layerIds = grouping?.layerIds ?? document.layers.map((_, index) => `preview-${index}`), indices = new Map(layerIds.map((id, index) => [id, index]))
  const children = new Set(grouping?.groups.flatMap((group) => group.children) ?? [])
  function firstIndex(id: string): number { const group = groups.get(id); return group ? firstIndex(group.children[0]) : indices.get(id)! }
  const roots = [...layerIds, ...groups.keys()].filter((id) => !children.has(id)).sort((left, right) => firstIndex(left) - firstIndex(right))
  function renderItems(ids: readonly string[]): import('react').ReactNode {
    return [...ids].reverse().map((id) => {
      const group = groups.get(id)
      if (group) return <li key={id} className="layer-psd-import-group"><div><strong><Layers3 size={14} />{group.name}</strong><small>穿透编组 · {group.visible ? '显示' : '隐藏'}{group.locked ? ' · 锁定' : ''}</small></div><ol aria-label={`${group.name}的图层`}>{renderItems(group.children)}</ol></li>
      const index = indices.get(id)!, layer = document.layers[index]
      return <li key={id}><span className="layer-psd-import-thumb">{urls[index] && <img src={urls[index]} alt="" draggable={false} />}</span><div><strong>{layer.name || `图层 ${index + 1}`}</strong><small>{layer.width} × {layer.height} · {effective[index].visible ? '可见' : layer.visible ? '随组隐藏' : '隐藏'}{effective[index].locked ? layer.locked ? ' · 锁定' : ' · 随组锁定' : ''} · {Math.round(layer.opacity * 100)}% · {blendLabels[layer.blend]}</small></div></li>
    })
  }
  return <div className="layer-psd-import-preview-layout"><div className="layer-psd-import-preview" style={{ aspectRatio: document.width / document.height, '--layer-psd-ratio': document.width / document.height } as CSSProperties} role="img" aria-label="已解析 PSD 的图层合成预览"><div className="layer-psd-import-composite">
    {document.layers.map((layer, index) => effective[index].visible && urls[index] ? <img key={index} src={urls[index]} alt="" draggable={false} style={{ left: `${layer.left / document.width * 100}%`, top: `${layer.top / document.height * 100}%`, width: `${layer.width / document.width * 100}%`, height: `${layer.height / document.height * 100}%`, opacity: layer.opacity, mixBlendMode: layer.blend === 'source-over' ? 'normal' : layer.blend } as CSSProperties} /> : null)}
  </div></div><ol className="layer-psd-import-layers" aria-label="PSD 图层，从顶层到底层">{renderItems(roots)}</ol></div>
}

export function LayerPsdImportDialog(props: LayerPsdImportDialogProps) {
  const [state, setState] = useState<LayerPsdImportState>({ ...initialLayerPsdImportState })
  const latest = useRef(props), alive = useRef(false), panel = useRef<HTMLElement>(null), fileInput = useRef<HTMLInputElement>(null)
  const controller = useRef<ReturnType<typeof createLayerPsdImportController> | null>(null)
  latest.current = props
  const limits = { maximumAdditionalLayers: props.maximumAdditionalLayers ?? 20, maximumAdditionalSources: props.maximumAdditionalSources ?? 20, maximumAdditionalGroups: props.maximumAdditionalGroups ?? 20 }
  const capacityError = state.document ? layerPsdImportCapacityError(state.document, limits) : ''
  const busy = state.phase === 'parsing' || state.phase === 'importing'
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const instance = createLayerPsdImportController({ parse: importBrowserLayerPsd, createUrl: (blob) => URL.createObjectURL(blob), revokeUrl: (url) => URL.revokeObjectURL(url), active: () => alive.current && !latest.current.disabled, limits: () => ({ maximumAdditionalLayers: latest.current.maximumAdditionalLayers ?? 20, maximumAdditionalSources: latest.current.maximumAdditionalSources ?? 20, maximumAdditionalGroups: latest.current.maximumAdditionalGroups ?? 20 }), onState: setState, onImport: (document, options) => latest.current.onImport(document, options), onImported: () => latest.current.onClose() })
    controller.current = instance
    panel.current?.focus()
    return () => { alive.current = false; instance.dispose(); if (controller.current === instance) controller.current = null; if (previous?.isConnected) previous.focus() }
  }, [])
  useEffect(() => { if (props.disabled) controller.current?.cancel() }, [props.disabled])
  function close() { controller.current?.cancel(); latest.current.onClose() }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length)
    if (!controls.length) { event.preventDefault(); panel.current?.focus(); return }
    const index = controls.indexOf(document.activeElement as HTMLElement)
    if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus() }
    else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0].focus() }
  }
  if (typeof document === 'undefined') return null
  return createPortal(<div className="layer-psd-import-backdrop nodrag nopan nowheel" onPointerDown={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) close() }} onWheel={(event) => event.stopPropagation()}>
    <section ref={panel} className="layer-psd-import-dialog" role="dialog" aria-modal="true" aria-label="导入 PSD 图层" tabIndex={-1} onKeyDown={keyboard} onKeyUp={(event) => event.stopPropagation()}>
      <header><div><span>本地图层文件</span><h2><Layers3 size={18} />导入 PSD 图层</h2></div><button type="button" aria-label="关闭 PSD 导入" onClick={close}><X size={19} /></button></header>
      <div className="layer-psd-import-body" aria-busy={busy}>
        <p>先在本地解析并核对，再追加到当前图层编辑器。保留穿透编组、层名、位置、层序、显隐、完整锁定、透明度和支持的混合模式；按位图图层导入，不恢复可编辑文字或智能对象。</p>
        <div className="layer-psd-import-file"><button type="button" disabled={busy || props.disabled} onClick={() => fileInput.current?.click()}><FileImage size={17} />{state.fileName ? '重新选择 PSD' : '选择 PSD 文件'}</button><span>{state.fileName || '文件在确认前不会上传'}</span><input ref={fileInput} type="file" accept=".psd,image/vnd.adobe.photoshop" aria-label="选择 PSD 文件" hidden disabled={busy || props.disabled} onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file) void controller.current?.selectFile(file) }} /></div>
        <p className="layer-psd-import-limits">支持 RGB / 8 位的 Raw、RLE 位图 PSD，宽高不超过 4096 px，最多 20 层、20 个穿透组、4 层嵌套。图层与合成图累计像素最多 33,554,432，文件最多约 128 MB。隔离混合、组透明度及不支持的效果会明确报错，不会静默缩小或合并图层。</p>
        {state.status && <p className="layer-psd-import-status" role="status">{busy && <LoaderCircle size={15} className="layer-psd-import-spin" />}{state.status}</p>}
        {(state.error || capacityError) && <p className="layer-psd-import-error" role="alert">{state.error || capacityError}</p>}
        {state.document && <><div className="layer-psd-import-facts"><strong>{state.document.width} × {state.document.height}</strong><span>{state.document.layers.length} 个位图图层{state.document.layerGroups ? ` · ${state.document.layerGroups.groups.length} 个组` : ''}</span><span>当前可追加 {Math.max(0, limits.maximumAdditionalLayers)} 层 / {Math.max(0, limits.maximumAdditionalSources)} 个来源 / {Math.max(0, limits.maximumAdditionalGroups)} 个组</span></div><LayerPsdImportPreview document={state.document} urls={state.urls} />{state.document.warnings.length > 0 && <ul className="layer-psd-import-warnings" aria-label="PSD 导入说明">{state.document.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</>}
      </div>
      <footer><small>导入后仍可撤销；仅在应用图层时更新节点。</small>{busy ? <button type="button" onClick={() => controller.current?.cancel()}>{state.phase === 'parsing' ? '取消解析' : '取消等待'}</button> : <button type="button" onClick={close}>取消</button>}<button type="button" className="is-primary" disabled={busy || props.disabled || !state.document || Boolean(capacityError)} onClick={() => void controller.current?.importSelected()}>{state.phase === 'importing' ? <LoaderCircle size={15} className="layer-psd-import-spin" /> : <Upload size={15} />}确认追加图层</button></footer>
    </section>
  </div>, document.body)
}
