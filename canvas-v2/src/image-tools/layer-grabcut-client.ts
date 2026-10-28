import { LayerRasterSelectionError, type LayerRasterSelection } from './layer-raster-selection'
import { encodeLayerGrabCutSelection, layerGrabCutIterations, prepareLayerGrabCutInput, type LayerGrabCutInput, type LayerGrabCutPreparedInput, type LayerGrabCutProgress } from './layer-grabcut-selection'
import GrabCutWorker from './layer-grabcut-worker?worker'

export interface LayerGrabCutOptions { signal?: AbortSignal; onProgress?: (progress: LayerGrabCutProgress) => void }
export interface LayerGrabCutWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: { type: 'segment'; input: LayerGrabCutPreparedInput }, transfer: Transferable[]): void
  terminate(): void
}
export const layerGrabCutLoadingTimeoutMs = 20_000
export const layerGrabCutProcessingTimeoutMs = 12_000

function cancellation(): LayerRasterSelectionError { return new LayerRasterSelectionError('已取消前景分割，原选区已保留', 'cancelled') }
function workerFailure(): Error { return new Error('本地前景分割组件运行失败，原选区已保留；请缩小处理框或刷新后重试') }
function progress(options: LayerGrabCutOptions, value: LayerGrabCutProgress): void { options.onProgress?.(value) }

function runWorker(worker: LayerGrabCutWorker, input: LayerGrabCutPreparedInput, options: LayerGrabCutOptions, limits: { loading: number; processing: number }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let finished = false, submitted = false, iteration = 0
    let timeout: ReturnType<typeof setTimeout> | undefined
    function finish(error: Error | null, mask?: Uint8Array) {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
      worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null
      worker.terminate()
      if (error) reject(error)
      else resolve(mask!)
    }
    function abort() { finish(cancellation()) }
    function deadline(milliseconds: number, loading: boolean) {
      clearTimeout(timeout)
      timeout = setTimeout(() => finish(new LayerRasterSelectionError(loading ? '本地前景分割组件加载超时，原选区已保留；请检查本站资源后重试' : '前景分割超过时间限制，已停止计算并保留原选区；请缩小处理框后重试', 'time-budget')), milliseconds)
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) { abort(); return }
    worker.onerror = () => finish(workerFailure())
    worker.onmessageerror = () => finish(workerFailure())
    worker.onmessage = (event) => {
      if (finished) return
      if (options.signal?.aborted) { abort(); return }
      const data = event.data
      if (!data || typeof data !== 'object') { finish(workerFailure()); return }
      const message = data as Record<string, unknown>
      try {
        if (message.type === 'ready' && !submitted) {
          submitted = true
          deadline(limits.processing, false)
          progress(options, { phase: 'segmenting', iteration: 0, total: layerGrabCutIterations })
          if (finished) return
          worker.postMessage({ type: 'segment', input }, [input.rgba.buffer, input.labels.buffer])
        } else if (message.type === 'progress' && submitted && Number.isSafeInteger(message.iteration) && Number(message.iteration) === iteration + 1 && message.total === layerGrabCutIterations) {
          iteration = Number(message.iteration)
          if (iteration > layerGrabCutIterations) { finish(workerFailure()); return }
          progress(options, { phase: 'segmenting', iteration, total: layerGrabCutIterations })
        } else if (message.type === 'complete' && submitted && iteration === layerGrabCutIterations && message.mask instanceof Uint8Array && message.mask.length === input.region.width * input.region.height) finish(null, message.mask)
        else if (message.type === 'error' && typeof message.message === 'string' && message.message.length <= 300) finish(new Error(message.message))
        else finish(workerFailure())
      } catch { finish(workerFailure()) }
    }
    deadline(limits.loading, true)
  })
}

/** One active job per runner. Replacements abort the previous job instead of queuing expensive graphs. */
export function createLayerGrabCutRunner(createWorker: () => LayerGrabCutWorker, timeouts: { loading?: number; processing?: number } = {}) {
  const limits = { loading: timeouts.loading ?? layerGrabCutLoadingTimeoutMs, processing: timeouts.processing ?? layerGrabCutProcessingTimeoutMs }
  if (!Number.isFinite(limits.loading) || limits.loading < 1 || limits.loading > layerGrabCutLoadingTimeoutMs || !Number.isFinite(limits.processing) || limits.processing < 1 || limits.processing > layerGrabCutProcessingTimeoutMs) throw new Error('前景分割时间预算无效')
  let active: AbortController | null = null
  return async function run(input: LayerGrabCutInput, options: LayerGrabCutOptions = {}): Promise<LayerRasterSelection> {
    active?.abort()
    const controller = new AbortController()
    active = controller
    function abort() { controller.abort() }
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) abort()
    const currentOptions = { ...options, signal: controller.signal }
    try {
      progress(currentOptions, { phase: 'preparing' })
      const prepared = await prepareLayerGrabCutInput(input, { signal: controller.signal })
      if (controller.signal.aborted) throw cancellation()
      progress(currentOptions, { phase: 'loading' })
      if (controller.signal.aborted) throw cancellation()
      const worker = createWorker()
      const mask = await runWorker(worker, prepared, currentOptions, limits)
      if (controller.signal.aborted) throw cancellation()
      progress(currentOptions, { phase: 'encoding' })
      return await encodeLayerGrabCutSelection(prepared, mask, { signal: controller.signal })
    } finally {
      options.signal?.removeEventListener('abort', abort)
      if (active === controller) active = null
    }
  }
}

function createBrowserWorker(): LayerGrabCutWorker {
  if (typeof Worker === 'undefined') throw new Error('当前浏览器不支持本地前景分割，请使用支持 Web Worker 的浏览器')
  try { return new GrabCutWorker() } catch { throw new Error('无法启动本地前景分割线程，原选区已保留；请刷新页面并检查本站资源是否可加载') }
}

const browserRunner = createLayerGrabCutRunner(createBrowserWorker)
export function runLayerGrabCutSelection(input: LayerGrabCutInput, options: LayerGrabCutOptions = {}): Promise<LayerRasterSelection> { return browserRunner(input, options) }
