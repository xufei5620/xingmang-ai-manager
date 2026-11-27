import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { inspectImageUpscalePlan, isImageUpscaleScale, type ImageUpscaleRefusal, type ImageUpscaleScale } from './image-upscale'
import type { ImageUpscaleJob, ImageUpscaleWorkerData, ImageUpscaleWorkerMessage } from './image-upscale-worker'

// 「本机变清晰」在主线程这一侧：核尺寸、解图、排队、起后台线程、等结果。存进作品库由调用方（IPC 处理器）做，
// 这里只交回 PNG 字节。

/** 随包带的模型（bundled-catalog/image-upscale/manifest.json 记着它是怎么从官方文件转出来的）。 */
export const imageUpscaleModelRelativePath = ['bundled-catalog', 'image-upscale', 'realesr-general-x4v3.onnx'] as const
export const imageUpscaleModelSha256 = '7c51a397f0826742f70d57eee2db67cd13509d5b0f9c14797b9913d035fa9e80'
const imageUpscaleModelMaximumBytes = 16 * 1024 * 1024

/** 界面上的话（2026-11-27 在线程里逐字给出，等 yoyo 确认）。 */
export const imageUpscaleMessages = {
  outputTooLargeFor4x: '该图片放大 4 倍后超出尺寸上限，请改用放大 2 倍。',
  tooLarge: '该图片尺寸已较大，无法继续放大。',
  unreadable: '无法读取该图片，请更换图片后重试。',
  failed: '提升清晰度失败，请稍后重试；如持续失败，请联系客服。',
  saveFailed: '清晰版保存失败，请检查磁盘空间后重试。',
} as const

export function imageUpscaleRefusalMessage(refusal: ImageUpscaleRefusal, width: number, height: number, scale: ImageUpscaleScale): string {
  if (refusal === 'empty') return imageUpscaleMessages.unreadable
  if (refusal === 'output-too-large' && scale === 4 && 'plan' in inspectImageUpscalePlan(width, height, 2)) return imageUpscaleMessages.outputTooLargeFor4x
  return imageUpscaleMessages.tooLarge
}

/**
 * 后台线程开几条：留一个核给系统和别的软件，最多 4 条（再多 WASM 也快不了多少）。两核的电脑只开 1 条。
 * 客户点了才跑、跑完就收，不常驻。
 */
export function resolveImageUpscaleThreads(logicalCores: number): number {
  if (!Number.isFinite(logicalCores) || logicalCores <= 2) return 1
  return Math.min(4, Math.floor(logicalCores) - 1)
}

export function resolveImageUpscaleOrtDirectory(appPath: string, packaged: boolean): string {
  // Packaged builds carry a trimmed copy staged by scripts/stage-image-upscale-runtime.cjs;
  // development runs straight from the project's devDependency.
  return packaged
    ? path.join(path.resolve(appPath), 'dist-image-upscale', 'node_modules', 'onnxruntime-web')
    : path.join(path.resolve(appPath), 'node_modules', 'onnxruntime-web')
}

export function resolveImageUpscaleModelPath(appPath: string): string {
  return path.join(path.resolve(appPath), ...imageUpscaleModelRelativePath)
}

export interface ImageUpscaleDecoded {
  width: number
  height: number
  /** nativeImage.toBitmap()：B G R A、预乘透明度。 */
  bgra: Uint8Array
}

export interface ImageUpscaleWorkerLike {
  on(event: 'message', listener: (value: unknown) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'exit', listener: (code: number) => void): unknown
  postMessage(value: unknown, transfer?: ArrayBuffer[]): void
  terminate(): Promise<number>
}

export interface ImageUpscaleLog {
  (level: 'info' | 'warn' | 'error', event: string, message: string, detail?: Record<string, unknown>): void
}

export interface ImageUpscaleServiceOptions {
  modelPath: string
  ortModuleDirectory: string
  /** 把图片字节解成像素：主进程里是 nativeImage；解不开交 null。 */
  decode(bytes: Buffer): ImageUpscaleDecoded | null
  readFile?: (filePath: string) => Promise<Buffer>
  createWorker?: (data: ImageUpscaleWorkerData & { kind: 'xingmang-image-upscale' }) => ImageUpscaleWorkerLike
  threads?: number
  /** 后台线程多久没动静就当它卡住了（每跑完一块都会报一声）。 */
  stallTimeoutMs?: number
  log?: ImageUpscaleLog
  now?: () => number
}

export interface ImageUpscaleRequest {
  bytes: Buffer
  /** 文件头里读到的宽高；有就先核一遍，免得把一张太大的图整张解开。 */
  width?: number
  height?: number
  scale: ImageUpscaleScale
}

export interface ImageUpscaleResult {
  png: Buffer
  width: number
  height: number
}

export interface ImageUpscaleService {
  upscale(request: ImageUpscaleRequest): Promise<ImageUpscaleResult>
}

export function imageUpscaleWorkerPath(): string {
  return path.join(__dirname, 'image-upscale-worker.js')
}

function startImageUpscaleWorker(data: ImageUpscaleWorkerData & { kind: 'xingmang-image-upscale' }): ImageUpscaleWorkerLike {
  return new Worker(imageUpscaleWorkerPath(), { workerData: data })
}

function failure(message: string, cause?: unknown): Error {
  return cause === undefined ? new Error(message) : new Error(message, { cause })
}

export function isImageUpscaleWorkerMessage(value: unknown): value is ImageUpscaleWorkerMessage {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const message: { type?: unknown; done?: unknown; total?: unknown; png?: unknown; width?: unknown; height?: unknown; message?: unknown } = value
  if (message.type === 'progress') return typeof message.done === 'number' && typeof message.total === 'number'
  if (message.type === 'done') return message.png instanceof ArrayBuffer && Number.isSafeInteger(message.width) && Number.isSafeInteger(message.height)
  return message.type === 'failed' && typeof message.message === 'string'
}

function ownArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

export function createImageUpscaleService(options: ImageUpscaleServiceOptions): ImageUpscaleService {
  const readFile = options.readFile ?? ((filePath: string) => fs.promises.readFile(filePath))
  const createWorker = options.createWorker ?? startImageUpscaleWorker
  const threads = options.threads ?? resolveImageUpscaleThreads(os.availableParallelism())
  const stallTimeoutMs = options.stallTimeoutMs ?? 120_000
  const now = options.now ?? Date.now
  const log: ImageUpscaleLog = options.log ?? (() => undefined)
  // One picture at a time: two at once would only split the same cores and
  // double the memory, and the second person-visible result would come no sooner.
  let queue: Promise<unknown> = Promise.resolve()

  async function readVerifiedModel(): Promise<Buffer> {
    let bytes: Buffer
    try {
      bytes = await readFile(options.modelPath)
    } catch (error) {
      throw failure(imageUpscaleMessages.failed, error)
    }
    // The model sits inside app.asar, whose integrity Electron already checks;
    // the hash still turns a damaged or swapped file into a clear failure
    // instead of a garbage picture saved into the customer's library.
    if (bytes.byteLength === 0 || bytes.byteLength > imageUpscaleModelMaximumBytes || createHash('sha256').update(bytes).digest('hex') !== imageUpscaleModelSha256) {
      throw failure(imageUpscaleMessages.failed, new Error('本机模型文件校验失败'))
    }
    return bytes
  }

  function runWorker(job: ImageUpscaleJob): Promise<ImageUpscaleResult> {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const worker = createWorker({ kind: 'xingmang-image-upscale', ortModuleDirectory: options.ortModuleDirectory, threads })
      const finish = (outcome: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        void worker.terminate().catch(() => undefined)
        outcome()
      }
      const arm = () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => finish(() => reject(failure(imageUpscaleMessages.failed, new Error('后台线程长时间没有进展')))), stallTimeoutMs)
      }
      worker.on('message', (value: unknown) => {
        if (!isImageUpscaleWorkerMessage(value)) return
        const message = value
        if (message.type === 'progress') {
          arm()
          return
        }
        if (message.type === 'done') {
          finish(() => resolve({ png: Buffer.from(message.png), width: message.width, height: message.height }))
          return
        }
        finish(() => reject(failure(imageUpscaleMessages.failed, new Error(message.message))))
      })
      worker.on('error', (error) => finish(() => reject(failure(imageUpscaleMessages.failed, error))))
      worker.on('exit', (code) => finish(() => reject(failure(imageUpscaleMessages.failed, new Error(`后台线程提前退出（${code}）`)))))
      arm()
      worker.postMessage(job, [job.model, job.bgra])
    })
  }

  async function run(request: ImageUpscaleRequest): Promise<ImageUpscaleResult> {
    const startedAt = now()
    const model = await readVerifiedModel()
    let decoded: ImageUpscaleDecoded | null
    try {
      decoded = options.decode(request.bytes)
    } catch (error) {
      throw failure(imageUpscaleMessages.unreadable, error)
    }
    if (!decoded || decoded.width < 1 || decoded.height < 1 || decoded.bgra.byteLength !== decoded.width * decoded.height * 4) {
      throw failure(imageUpscaleMessages.unreadable)
    }
    const inspected = inspectImageUpscalePlan(decoded.width, decoded.height, request.scale)
    if ('refusal' in inspected) throw failure(imageUpscaleRefusalMessage(inspected.refusal, decoded.width, decoded.height, request.scale))
    try {
      const result = await runWorker({
        type: 'run',
        model: ownArrayBuffer(model),
        width: decoded.width,
        height: decoded.height,
        bgra: ownArrayBuffer(decoded.bgra),
        scale: request.scale,
      })
      log('info', 'image-upscale.done', '图片已在本机变清晰', {
        width: decoded.width, height: decoded.height, scale: request.scale, threads, durationMs: now() - startedAt, bytes: result.png.byteLength,
      })
      return result
    } catch (error) {
      log('error', 'image-upscale.failed', '图片本机变清晰失败', {
        width: decoded.width, height: decoded.height, scale: request.scale, threads, durationMs: now() - startedAt,
        reason: error instanceof Error && error.cause instanceof Error ? error.cause.message : String(error),
      })
      throw error
    }
  }

  return {
    upscale(request) {
      if (!Buffer.isBuffer(request.bytes) || request.bytes.byteLength === 0) return Promise.reject(failure(imageUpscaleMessages.unreadable))
      if (!isImageUpscaleScale(request.scale)) return Promise.reject(new Error('放大倍数无效'))
      if (request.width && request.height) {
        const inspected = inspectImageUpscalePlan(request.width, request.height, request.scale)
        if ('refusal' in inspected) return Promise.reject(failure(imageUpscaleRefusalMessage(inspected.refusal, request.width, request.height, request.scale)))
      }
      const next = queue.then(() => run(request))
      queue = next.catch(() => undefined)
      return next
    },
  }
}
