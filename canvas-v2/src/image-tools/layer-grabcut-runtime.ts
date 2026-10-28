import { assertLayerGrabCutPreparedInput, layerGrabCutIterations, type LayerGrabCutPreparedInput } from './layer-grabcut-selection'

export interface LayerGrabCutMat { data: Uint8Array; delete(): void }
/** Keep the dependency boundary restricted to the actual local GrabCut primitives. */
export interface LayerGrabCutCv {
  Mat: new (rows?: number, columns?: number, type?: number) => LayerGrabCutMat
  Rect: new (x: number, y: number, width: number, height: number) => object
  CV_8UC3: number
  CV_8UC1: number
  GC_INIT_WITH_MASK: number
  GC_EVAL: number
  setRNGSeed(seed: number): void
  grabCut(image: LayerGrabCutMat, mask: LayerGrabCutMat, rect: object, background: LayerGrabCutMat, foreground: LayerGrabCutMat, iterations: number, mode: number): void
}

export function isLayerGrabCutCv(value: unknown): value is LayerGrabCutCv {
  if (!value || typeof value !== 'object') return false
  const cv = value as Record<string, unknown>
  return ['Mat', 'Rect', 'grabCut', 'setRNGSeed'].every((key) => typeof cv[key] === 'function') && ['CV_8UC3', 'CV_8UC1', 'GC_INIT_WITH_MASK', 'GC_EVAL'].every((key) => typeof cv[key] === 'number')
}

/** Emscripten's legacy module may be a self-resolving thenable; never await or resolve that object itself. */
export function resolveLayerGrabCutRuntime(value: unknown): Promise<{ cv: LayerGrabCutCv }> {
  return new Promise((resolve, reject) => {
    function ready(candidate: unknown) {
      if (!isLayerGrabCutCv(candidate)) { reject(new Error('本地前景分割组件不完整，请刷新后重试')); return }
      resolve({ cv: candidate })
    }
    if (value && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function') {
      try { value.then(ready, () => reject(new Error('本地前景分割组件初始化失败，请刷新后重试'))) } catch { reject(new Error('本地前景分割组件初始化失败，请刷新后重试')) }
    } else ready(value)
  })
}

/** Runs in a disposable worker: synchronous WASM must be cancelled by terminating that worker. */
export async function runLayerGrabCutRuntime(cv: LayerGrabCutCv, input: LayerGrabCutPreparedInput, onIteration?: (iteration: number) => void, yieldControl: () => Promise<void> = yieldToWorker): Promise<Uint8Array> {
  if (!isLayerGrabCutCv(cv)) throw new Error('本地前景分割组件未正确加载，请刷新后重试')
  assertLayerGrabCutPreparedInput(input)
  const { width, height } = input.region, mats: LayerGrabCutMat[] = []
  function allocate(rows?: number, columns?: number, type?: number): LayerGrabCutMat { const mat = rows === undefined ? new cv.Mat() : new cv.Mat(rows, columns, type); mats.push(mat); return mat }
  try {
    const image = allocate(height, width, cv.CV_8UC3), mask = allocate(height, width, cv.CV_8UC1), background = allocate(), foreground = allocate()
    // Read the heap views after all allocations, as growing WASM memory detaches earlier views.
    const rgb = image.data
    for (let pixel = 0; pixel < width * height; pixel++) {
      rgb[pixel * 3] = input.rgba[pixel * 4]
      rgb[pixel * 3 + 1] = input.rgba[pixel * 4 + 1]
      rgb[pixel * 3 + 2] = input.rgba[pixel * 4 + 2]
    }
    mask.data.set(input.labels)
    cv.setRNGSeed(0)
    for (let iteration = 1; iteration <= layerGrabCutIterations; iteration++) {
      cv.grabCut(image, mask, new cv.Rect(0, 0, width, height), background, foreground, 1, iteration === 1 ? cv.GC_INIT_WITH_MASK : cv.GC_EVAL)
      onIteration?.(iteration)
      await yieldControl()
    }
    const result = new Uint8Array(width * height), labels = mask.data
    if (labels.length !== result.length) throw new Error('本地前景分割返回了无效尺寸，原选区已保留')
    for (let index = 0; index < result.length; index++) {
      const label = labels[index], original = input.labels[index]
      if (label > 3 || (original < 2 && original !== label)) throw new Error('本地前景分割未保留明确的前景或背景标记，原选区已保留')
      result[index] = label === 1 || label === 3 ? 1 : 0
    }
    return result
  } finally {
    for (let index = mats.length - 1; index >= 0; index--) mats[index].delete()
  }
}

function yieldToWorker(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)) }
