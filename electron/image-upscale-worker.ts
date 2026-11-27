import { parentPort, workerData } from 'node:worker_threads'
import { encodePng, isImageUpscaleScale, rgbaFromPremultipliedBgra, upscaleImagePixels, type ImageUpscaleScale } from './image-upscale'

/**
 * 「本机变清晰」的后台线程：拿主线程解好的像素和随包带的模型，用 onnxruntime 的 WASM 版分块放大，存成 PNG 交回。
 *
 * Why a worker and WASM rather than the native onnxruntime-node addon: the
 * addon ships one native library per platform (30–45 MB each), has no Intel
 * macOS build in current releases, and would be the first native module this
 * app loads. The WASM build is one portable 15 MB file that runs the same on
 * Windows, both Mac architectures and Linux, needs nothing signed or unpacked,
 * and loads from inside app.asar (checked on Electron 45: the worker, the
 * runtime's .mjs loader, its .wasm and its own pthread workers all load from
 * the archive). The work happens off the main thread, so a minute of
 * inference never freezes the window, and the host terminates this worker
 * after every job so the WASM heap goes back to the system.
 *
 * Nothing here touches the network or the file system: the model arrives as
 * bytes the host already verified, and the result goes back as bytes the host
 * stores through the asset store's atomic write (AGENTS.md I8).
 */

export interface ImageUpscaleWorkerData {
  /** onnxruntime-web 包所在的目录（打包后在 app.asar 的 dist-image-upscale 里）。 */
  ortModuleDirectory: string
  threads: number
}

export interface ImageUpscaleJob {
  type: 'run'
  model: ArrayBuffer
  width: number
  height: number
  /** nativeImage.toBitmap() 的原样字节：B G R A、预乘透明度。 */
  bgra: ArrayBuffer
  scale: ImageUpscaleScale
}

export type ImageUpscaleWorkerMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; png: ArrayBuffer; width: number; height: number }
  | { type: 'failed'; message: string }

interface OrtTensorLike {
  data: unknown
  dims: readonly number[]
  dispose?(): void
}

interface OrtSessionLike {
  readonly inputNames: readonly string[]
  readonly outputNames: readonly string[]
  run(feeds: Record<string, OrtTensorLike>): Promise<Record<string, OrtTensorLike>>
  release?(): Promise<void>
}

export interface OrtModuleLike {
  env: { wasm: { numThreads?: number } }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => OrtTensorLike
  InferenceSession: { create(model: Uint8Array, options?: Record<string, unknown>): Promise<OrtSessionLike> }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isOrtModuleLike(value: unknown): value is OrtModuleLike {
  if (!isRecord(value) || !isRecord(value.env) || !isRecord(value.env.wasm)) return false
  // InferenceSession is a class, so a function rather than a plain object.
  const session: unknown = value.InferenceSession
  return typeof value.Tensor === 'function' && typeof session === 'function' && 'create' in session && typeof session.create === 'function'
}

export function isImageUpscaleJob(value: unknown): value is ImageUpscaleJob {
  if (!isRecord(value) || value.type !== 'run') return false
  return value.model instanceof ArrayBuffer && value.bgra instanceof ArrayBuffer
    && Number.isSafeInteger(value.width) && Number.isSafeInteger(value.height)
    && isImageUpscaleScale(value.scale)
}

/** 跑一张图：出错不抛，交回一条 failed，主线程照它报「提升清晰度失败」并把原因记进日志。 */
export async function runImageUpscaleJob(
  job: ImageUpscaleJob,
  ort: OrtModuleLike,
  threads: number,
  post: (message: ImageUpscaleWorkerMessage, transfer?: ArrayBuffer[]) => void,
): Promise<void> {
  let session: OrtSessionLike | null = null
  try {
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, Math.floor(threads)))
    session = await ort.InferenceSession.create(new Uint8Array(job.model), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    const active = session
    const inputName = active.inputNames[0]
    const outputName = active.outputNames[0]
    if (!inputName || !outputName) throw new Error('模型缺少输入或输出')
    const rgba = rgbaFromPremultipliedBgra(new Uint8Array(job.bgra), job.width, job.height)
    const upscaled = await upscaleImagePixels({ width: job.width, height: job.height, rgba }, job.scale, async (input, width, height) => {
      const tensor = new ort.Tensor('float32', input, [1, 3, height, width])
      try {
        const result = await active.run({ [inputName]: tensor })
        const output = result[outputName]
        if (!output || !(output.data instanceof Float32Array)) throw new Error('模型输出格式不对')
        const data = output.data
        output.dispose?.()
        return data
      } finally {
        tensor.dispose?.()
      }
    }, (done, total) => post({ type: 'progress', done, total }))
    const png = encodePng(upscaled)
    const bytes = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)
    post({ type: 'done', png: bytes, width: upscaled.width, height: upscaled.height }, [bytes])
  } catch (error) {
    post({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  } finally {
    await session?.release?.().catch(() => undefined)
  }
}

function loadOrtModule(directory: string): OrtModuleLike {
  // The directory is fixed by the host (app.asar/dist-image-upscale or the
  // project's node_modules in development), never by a renderer.
  const loaded: unknown = require(directory)
  if (!isOrtModuleLike(loaded)) throw new Error('本机模型运行库加载失败')
  return loaded
}

if (parentPort && isRecord(workerData) && workerData.kind === 'xingmang-image-upscale') {
  const port = parentPort
  const data: unknown = workerData
  port.once('message', (value: unknown) => {
    if (!isRecord(data) || typeof data.ortModuleDirectory !== 'string' || typeof data.threads !== 'number' || !isImageUpscaleJob(value)) {
      port.postMessage({ type: 'failed', message: '后台任务参数无效' } satisfies ImageUpscaleWorkerMessage)
      return
    }
    let ort: OrtModuleLike
    try {
      ort = loadOrtModule(data.ortModuleDirectory)
    } catch (error) {
      port.postMessage({ type: 'failed', message: error instanceof Error ? error.message : String(error) } satisfies ImageUpscaleWorkerMessage)
      return
    }
    void runImageUpscaleJob(value, ort, data.threads, (message, transfer) => port.postMessage(message, transfer))
  })
}
