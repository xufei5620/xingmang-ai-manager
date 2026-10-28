import type { BrowserLayerPsdDocument } from '../library/browser-layer-psd-import'
import { maximumLayerPsdBytes } from '../library/layer-psd-writer'

export interface LayerPsdImportLimits { maximumAdditionalLayers: number; maximumAdditionalSources: number; maximumAdditionalGroups?: number }
export interface LayerPsdImportState {
  phase: 'idle' | 'parsing' | 'ready' | 'importing'
  fileName: string
  document: BrowserLayerPsdDocument | null
  urls: string[]
  error: string
  status: string
}
export const initialLayerPsdImportState: LayerPsdImportState = { phase: 'idle', fileName: '', document: null, urls: [], error: '', status: '' }

export function layerPsdImportCapacityError(document: BrowserLayerPsdDocument, limits: LayerPsdImportLimits): string {
  if (document.layers.length > limits.maximumAdditionalLayers) return `此 PSD 有 ${document.layers.length} 层，当前只能追加 ${Math.max(0, limits.maximumAdditionalLayers)} 层。请先减少现有图层；不会丢弃 PSD 图层。`
  if (document.layers.length > limits.maximumAdditionalSources) return `此 PSD 需要 ${document.layers.length} 个图片来源，当前只能追加 ${Math.max(0, limits.maximumAdditionalSources)} 个。请先减少现有输入来源；不会合并或丢弃图层。`
  if (limits.maximumAdditionalGroups !== undefined && (document.layerGroups?.groups.length ?? 0) > limits.maximumAdditionalGroups) return `此 PSD 有 ${document.layerGroups?.groups.length} 个组，当前只能追加 ${Math.max(0, limits.maximumAdditionalGroups)} 个。请先解组不需要的编组；不会丢弃 PSD 组结构。`
  return ''
}

interface LayerPsdImportControllerOptions {
  parse(file: Blob, options: { signal: AbortSignal }): Promise<BrowserLayerPsdDocument>
  createUrl(blob: Blob): string
  revokeUrl(url: string): void
  active(): boolean
  limits(): LayerPsdImportLimits
  onState(state: LayerPsdImportState): void
  onImport(document: BrowserLayerPsdDocument, options: { signal: AbortSignal }): Promise<void>
  onImported(): void
}

/** A parsed document keeps its identity across retries so the host can recover
 * the original import operation instead of uploading a second copy. */
export function createLayerPsdImportController(options: LayerPsdImportControllerOptions) {
  let state: LayerPsdImportState = { ...initialLayerPsdImportState }
  let pending: AbortController | null = null
  let disposed = false
  function active() { return !disposed && options.active() }
  function current(controller: AbortController) { return active() && pending === controller && !controller.signal.aborted }
  function update(next: LayerPsdImportState) { state = next; if (!disposed) options.onState(next) }
  function release() { for (const url of state.urls) options.revokeUrl(url) }
  function stop() { pending?.abort(); pending = null }

  async function selectFile(file: File) {
    if (!active() || state.phase === 'importing') return
    stop(); release()
    update({ ...initialLayerPsdImportState, fileName: file.name })
    if (!file.size || file.size > maximumLayerPsdBytes) { update({ ...state, error: !file.size ? 'PSD 文件为空，请重新选择。' : 'PSD 文件超过 128 MB 加格式头的上限，请缩小文件后重试。' }); return }
    const controller = new AbortController()
    pending = controller
    update({ ...state, phase: 'parsing', status: '正在本地解析 PSD，文件尚未上传…' })
    const urls: string[] = []
    try {
      const document = await options.parse(file, { signal: controller.signal })
      if (!current(controller)) return
      for (const layer of document.layers) urls.push(options.createUrl(layer.blob))
      update({ ...state, phase: 'ready', document, urls, error: '', status: '解析完成。核对图层后再确认导入，尚未修改画布。' })
    } catch (cause) {
      for (const url of urls) options.revokeUrl(url)
      if (current(controller)) update({ ...state, phase: 'idle', error: cause instanceof Error ? cause.message : 'PSD 解析失败，请检查文件后重试。', status: '' })
    } finally { if (pending === controller) pending = null }
  }

  async function importSelected() {
    if (!active() || pending || state.phase !== 'ready' || !state.document) return
    const capacityError = layerPsdImportCapacityError(state.document, options.limits())
    if (capacityError) { update({ ...state, error: capacityError }); return }
    const document = state.document, controller = new AbortController()
    pending = controller
    update({ ...state, phase: 'importing', error: '', status: '正在准备图层素材，请等待原操作结果…' })
    try {
      await options.onImport(document, { signal: controller.signal })
      if (current(controller)) { update({ ...state, phase: 'ready', status: 'PSD 图层已交给当前编辑器。' }); options.onImported() }
    } catch (cause) {
      if (current(controller)) update({ ...state, phase: 'ready', error: cause instanceof Error ? cause.message : '导入未确认，已保留解析结果，请核对后重试。', status: '' })
    } finally { if (pending === controller) pending = null }
  }

  function cancel() {
    if (disposed || (!pending && state.phase !== 'parsing' && state.phase !== 'importing')) return
    const importing = state.phase === 'importing'
    stop()
    update({ ...state, phase: state.document ? 'ready' : 'idle', error: '', status: importing ? '已取消等待，请核对当前编辑器；已提交的素材上传不会自动撤销。' : '已取消本地解析，画布保持原样。' })
  }
  function dispose() { disposed = true; stop(); release(); state = { ...initialLayerPsdImportState } }
  return { selectFile, importSelected, cancel, dispose }
}
