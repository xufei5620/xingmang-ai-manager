import { inspectAiImage, type AiStoredAsset } from './ai-asset-store'
import type { ByteRange } from './byte-range'
import {
  maximumCanvasImageTransformBatchBytes,
  maximumCanvasImageTransformBatchPixels,
  maximumCanvasImageTransformBytes,
  maximumCanvasImageTransformEdge,
  maximumCanvasImageTransformInputs,
  maximumCanvasImageTransformOutputs,
  maximumCanvasImageTransformPixels,
  type CanvasImageTransformExpectation,
} from './canvas-image-tools'
import type { CanvasFramePreparation, CanvasImagePreparation, CanvasRunAsset } from './canvas-run-contract'

// 画布完善第 7 条第二步（#1397）：视频抽帧。主进程不解视频：运行到抽帧节点时，主进程把「这一帧要你抽」
// 推给画布（run-waiting 的 framePreparations），内核在页面里用自己的解码器抽出 PNG，走
// canvas-host:complete-run-preparation 交回。跟网页版「页面处理、服务端核对」是同一套分工，这里的
// 主进程就是那个服务端：只收自己发出去、还在等的编号，一个编号只收一次，图再按文件头核对一遍才存。
// 第三步的图片工具走同一条路（kind 'image'），一次交回 1 到 16 张 PNG。

/** The web host's frame limits (xingmang-canvas lib/canvas-frame-client.ts), so a frame either side takes is the same. */
export const maximumCanvasFramePngBytes = 20 * 1024 * 1024
export const maximumCanvasFrameEdge = 4096
export const maximumCanvasFramePixels = 16_777_216
/** The kernel's browser decoder reads at most this much video (canvas-kernel library/browser-frame.ts). */
export const maximumCanvasFrameVideoBytes = 32 * 1024 * 1024
/**
 * The kernel's decoder gives up after 20 s; the rest covers reading the video
 * and saving. A page that never answers (closed, reloaded, an older kernel)
 * fails the node instead of holding a run slot forever.
 */
export const canvasFramePreparationTimeoutMs = 120_000

const identifierPattern = /^[A-Za-z0-9_-]{1,128}$/
const runIdPattern = /^[A-Za-z0-9_-]{1,256}$/

export type CanvasRunPreparationCompletion =
  | { runId: string; operationId: string; kind: 'frame'; outcome: 'completed'; png: Buffer; decodedTimestampSeconds?: number }
  | { runId: string; operationId: string; kind: 'image'; outcome: 'completed'; pngs: Buffer[] }
  | { runId: string; operationId: string; kind: 'frame' | 'image'; outcome: 'failed' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The page names the run and the operation and hands over the PNG bytes; no
 * path, name, type or message. A failed outcome carries nothing else either:
 * the node shows the desktop's own words, not the page's.
 */
export function parseCanvasRunPreparationCompletion(value: unknown): CanvasRunPreparationCompletion {
  if (!isRecord(value)) throw new Error('画布运行准备回执格式错误')
  const allowed = new Set(['runId', 'operationId', 'kind', 'outcome', 'png', 'pngs', 'decodedTimestampSeconds'])
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('画布运行准备回执格式错误')
  const { runId, operationId, kind, outcome } = value
  if (typeof runId !== 'string' || !runIdPattern.test(runId)) throw new Error('画布运行标识格式错误')
  if (typeof operationId !== 'string' || !identifierPattern.test(operationId)) throw new Error('画布运行准备标识格式错误')
  if (kind !== 'frame' && kind !== 'image') throw new Error('画布运行准备类型格式错误')
  if (outcome === 'failed') {
    if (value.png !== undefined || value.pngs !== undefined || value.decodedTimestampSeconds !== undefined) throw new Error('画布运行准备回执格式错误')
    return { runId, operationId, kind, outcome }
  }
  if (outcome !== 'completed') throw new Error('画布运行准备回执格式错误')
  if (kind === 'image') {
    if (value.png !== undefined || value.decodedTimestampSeconds !== undefined) throw new Error('画布运行准备回执格式错误')
    return { runId, operationId, kind, outcome, pngs: parseImageToolPngs(value.pngs) }
  }
  if (value.pngs !== undefined) throw new Error('画布运行准备回执格式错误')
  const { png, decodedTimestampSeconds } = value
  if (!(png instanceof Uint8Array)) throw new Error('视频帧图片内容格式错误')
  if (png.byteLength === 0) throw new Error('视频帧图片内容为空，没有保存')
  if (png.byteLength > maximumCanvasFramePngBytes) throw new Error('视频帧图片超过 20 MB，没有保存')
  if (decodedTimestampSeconds !== undefined && (typeof decodedTimestampSeconds !== 'number' || !Number.isFinite(decodedTimestampSeconds) || decodedTimestampSeconds < 0 || decodedTimestampSeconds > 86_400)) {
    throw new Error('视频帧时间格式错误')
  }
  return {
    runId,
    operationId,
    kind,
    outcome,
    png: Buffer.from(png),
    ...(decodedTimestampSeconds !== undefined ? { decodedTimestampSeconds } : {}),
  }
}

/** The bytes only: 1-16 non-empty pictures, each at most 20 MB, 64 MB together. Their content is checked when they are saved. */
function parseImageToolPngs(value: unknown): Buffer[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximumCanvasImageTransformOutputs) throw new Error('图片处理结果必须是 1 到 16 张图片')
  let total = 0
  return value.map((png) => {
    if (!(png instanceof Uint8Array)) throw new Error('图片处理结果内容格式错误')
    if (png.byteLength === 0) throw new Error('图片处理结果内容为空，没有保存')
    if (png.byteLength > maximumCanvasImageTransformBytes) throw new Error('图片处理结果超过 20 MB，没有保存')
    total += png.byteLength
    if (total > maximumCanvasImageTransformBatchBytes) throw new Error('图片处理结果合计超过 64 MB，没有保存')
    return Buffer.from(png)
  })
}

/**
 * The pictures an image-tool node asked for: as many as it makes, PNG by the
 * file header, within the web host's per-picture and per-batch limits, and the
 * size the node set unless the page decides it. This bounds what is saved; it
 * does not prove the pixels are what the recipe meant (the web host cannot
 * either).
 */
export function assertCanvasImageToolPngs(pngs: readonly Buffer[], expectation: CanvasImageTransformExpectation): void {
  if (pngs.length !== expectation.count) throw new Error('图片处理结果的张数跟节点设置不一致，没有保存')
  let totalPixels = 0
  for (const png of pngs) {
    const inspection = inspectAiImage(png)
    if (inspection.mimeType !== 'image/png') throw new Error('图片处理结果必须是 PNG 图片，没有保存')
    const { width, height } = inspection
    if (!width || !height) throw new Error('图片处理结果尺寸读不出来，没有保存')
    if (width > maximumCanvasImageTransformEdge || height > maximumCanvasImageTransformEdge || width * height > maximumCanvasImageTransformPixels) {
      throw new Error('图片处理结果尺寸超过 4096，没有保存')
    }
    if (expectation.size && (width !== expectation.size.width || height !== expectation.size.height)) {
      throw new Error('图片处理结果的尺寸跟节点设置不一致，没有保存')
    }
    totalPixels += width * height
  }
  if (totalPixels > maximumCanvasImageTransformBatchPixels) throw new Error('图片处理结果合计像素超过上限，请减小输出尺寸')
}

/** PNG only, read from the header like every other picture the asset store takes, within the web host's limits. */
export function assertCanvasFramePng(bytes: Buffer): { width: number; height: number } {
  const inspection = inspectAiImage(bytes)
  if (inspection.mimeType !== 'image/png') throw new Error('视频帧必须是 PNG 图片，没有保存')
  const { width, height } = inspection
  if (!width || !height) throw new Error('视频帧尺寸读不出来，没有保存')
  if (width > maximumCanvasFrameEdge || height > maximumCanvasFrameEdge || width * height > maximumCanvasFramePixels) {
    throw new Error('视频帧尺寸超过 4096，没有保存')
  }
  return { width, height }
}

export interface CanvasFramePreparationRequest {
  runId: string
  userId: number
  preparation: CanvasFramePreparation
  signal: AbortSignal
  /** Saves the checked PNG where this run's assets go and returns it as the node's output. */
  store(png: Buffer): Promise<CanvasRunAsset>
}

export interface CanvasImagePreparationRequest {
  runId: string
  userId: number
  preparation: CanvasImagePreparation
  expectation: CanvasImageTransformExpectation
  signal: AbortSignal
  /** Saves the checked PNGs, in order, where this run's assets go and returns them as the node's output. */
  store(pngs: readonly Buffer[]): Promise<CanvasRunAsset[]>
}

type CanvasRunPreparationKind = CanvasRunPreparationCompletion['kind']

// The words for each kind: the node shows these, never the page's.
const preparationWords: Record<CanvasRunPreparationKind, { duplicate: string; missing: string; claimed: string; failed: string; timeout: string; unsaved: string }> = {
  frame: {
    duplicate: '这一帧已经在等待中',
    missing: '这一帧不在等待中，可能已经超时或运行已停止',
    claimed: '这一帧已经交过了',
    failed: '视频帧没有抽出来：视频读不出来，或者时间点不在视频里',
    timeout: '视频帧没有交回来（画布关了或处理超时），请重新运行这个节点',
    unsaved: '视频帧没有保存',
  },
  image: {
    duplicate: '这次图片处理已经在等待中',
    missing: '这次图片处理不在等待中，可能已经超时或运行已停止',
    claimed: '这次图片处理的结果已经交过了',
    failed: '图片处理没有完成：来源图片读不出来，或者这组参数处理不了',
    timeout: '图片处理结果没有交回来（画布关了或处理超时），请重新运行这个节点',
    unsaved: '图片处理结果没有保存',
  },
}

interface PendingPreparation {
  kind: CanvasRunPreparationKind
  userId: number
  signal: AbortSignal
  claimed: boolean
  accept(completion: Extract<CanvasRunPreparationCompletion, { outcome: 'completed' }>): Promise<CanvasRunAsset[]>
  resolve(assets: CanvasRunAsset[]): void
  reject(error: Error): void
}

export interface CanvasRunPreparationBrokerOptions {
  timeoutMs?: number
  schedule?: (callback: () => void, milliseconds: number) => () => void
}

function defaultSchedule(callback: () => void, milliseconds: number): () => void {
  const timer = setTimeout(callback, milliseconds)
  return () => clearTimeout(timer)
}

function pendingKey(runId: string, operationId: string): string {
  return `${runId}\n${operationId}`
}

/**
 * Holds the frames runs are waiting on. Only an operation this process put
 * here can be completed, by the same signed-in user, once; a second answer, a
 * late answer after a stop or a timeout, or one for another run is refused.
 */
export class CanvasRunPreparationBroker {
  private readonly pending = new Map<string, PendingPreparation>()
  private readonly timeoutMs: number
  private readonly schedule: NonNullable<CanvasRunPreparationBrokerOptions['schedule']>

  constructor(options: CanvasRunPreparationBrokerOptions = {}) {
    const timeoutMs = options.timeoutMs ?? canvasFramePreparationTimeoutMs
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('画布运行准备等待时间配置无效')
    this.timeoutMs = timeoutMs
    this.schedule = options.schedule ?? defaultSchedule
  }

  /** Waits for the page's frame; rejects on stop, timeout or a page that reports it could not decode. */
  async expect(request: CanvasFramePreparationRequest): Promise<CanvasRunAsset> {
    const assets = await this.register('frame', request.runId, request.preparation.operationId, request.userId, request.signal, async (completion) => {
      if (completion.kind !== 'frame') throw new Error(preparationWords.frame.unsaved)
      assertCanvasFramePng(completion.png)
      request.signal.throwIfAborted()
      return [await request.store(completion.png)]
    })
    return assets[0]
  }

  /** Waits for the page's pictures of an image-tool node; rejects on stop, timeout or a page that could not make them. */
  expectImages(request: CanvasImagePreparationRequest): Promise<CanvasRunAsset[]> {
    return this.register('image', request.runId, request.preparation.operationId, request.userId, request.signal, async (completion) => {
      if (completion.kind !== 'image') throw new Error(preparationWords.image.unsaved)
      assertCanvasImageToolPngs(completion.pngs, request.expectation)
      request.signal.throwIfAborted()
      return request.store(completion.pngs)
    })
  }

  private register(
    kind: CanvasRunPreparationKind,
    runId: string,
    operationId: string,
    userId: number,
    signal: AbortSignal,
    accept: PendingPreparation['accept'],
  ): Promise<CanvasRunAsset[]> {
    const key = pendingKey(runId, operationId)
    if (this.pending.has(key)) return Promise.reject(new Error(preparationWords[kind].duplicate))
    try {
      signal.throwIfAborted()
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise<CanvasRunAsset[]>((resolve, reject) => {
      let cancelTimer: () => void = () => {}
      const finish = () => {
        cancelTimer()
        signal.removeEventListener('abort', onAbort)
        if (this.pending.get(key) === entry) this.pending.delete(key)
      }
      const entry: PendingPreparation = {
        kind,
        userId,
        signal,
        claimed: false,
        accept,
        resolve: (assets) => { finish(); resolve(assets) },
        reject: (error) => { finish(); reject(error) },
      }
      const onAbort = () => entry.reject(signal.reason instanceof Error ? signal.reason : new Error('运行已取消'))
      this.pending.set(key, entry)
      signal.addEventListener('abort', onAbort, { once: true })
      cancelTimer = this.schedule(() => {
        // A save already under way finishes on its own; only an unanswered operation times out.
        if (!entry.claimed) entry.reject(new Error(preparationWords[kind].timeout))
      }, this.timeoutMs)
    })
  }

  async complete(userId: number, completion: CanvasRunPreparationCompletion): Promise<void> {
    const words = preparationWords[completion.kind]
    const entry = this.pending.get(pendingKey(completion.runId, completion.operationId))
    // A frame answered as pictures (or the other way round) is not what this process asked for.
    if (!entry || entry.userId !== userId || entry.kind !== completion.kind) throw new Error(words.missing)
    if (entry.claimed) throw new Error(words.claimed)
    entry.claimed = true
    if (completion.outcome === 'failed') {
      entry.reject(new Error(words.failed))
      return
    }
    try {
      entry.resolve(await entry.accept(completion))
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(words.unsaved)
      entry.reject(failure)
      throw failure
    }
  }

  /** How many frames are still waiting; for tests and diagnostics. */
  size(): number {
    return this.pending.size
  }
}

/** What the frame-extract executor needs from the main process. */
export interface CanvasFrameExtraction {
  /** Fails unless this account owns the video and the page can decode it; reads only the file header. */
  assertDecodableVideo(userId: number, assetId: string): Promise<void>
  /** Waits for the page's PNG of the frame and saves it with the run's project assets. */
  waitForFrame(input: { runId: string; userId: number; projectId?: string; preparation: CanvasFramePreparation; signal: AbortSignal }): Promise<CanvasRunAsset>
}

/** The parts of CanvasProjectAssetManager a frame touches. */
export interface CanvasFrameAssetStore {
  readOwnedVideoRange(userId: number, assetId: string, select: (totalBytes: number) => ByteRange | null): Promise<{ totalBytes: number }>
  forProject(userId: number, projectId: string): Promise<{
    images: { storeLocalBytes(userId: number, bytes: Buffer): Promise<AiStoredAsset> }
    media: { setSource(userId: number, assetId: string, source: 'imported'): Promise<unknown> }
  }>
}

export function createCanvasFrameExtraction(options: {
  broker: CanvasRunPreparationBroker
  assets: CanvasFrameAssetStore
  onSourceError?(error: unknown, assetId: string): void
}): CanvasFrameExtraction {
  return {
    async assertDecodableVideo(userId, assetId) {
      const { totalBytes } = await options.assets.readOwnedVideoRange(userId, assetId, () => null)
      // Said here, before the node waits two minutes on a page that cannot read it.
      if (totalBytes > maximumCanvasFrameVideoBytes) throw new Error('视频超过 32 MB，画布抽不了这一帧')
    },
    waitForFrame({ runId, userId, projectId, preparation, signal }) {
      if (!projectId) return Promise.reject(new Error('画布项目尚未选择，无法保存视频帧'))
      return options.broker.expect({
        runId,
        userId,
        preparation,
        signal,
        store: async (png) => {
          const context = await options.assets.forProject(userId, projectId)
          const stored = await context.images.storeLocalBytes(userId, png)
          // The web host records frames as imported too: the page made the picture, not a model.
          await context.media.setSource(userId, stored.assetId, 'imported').catch((error: unknown) => options.onSourceError?.(error, stored.assetId))
          return storedImageAsset(stored)
        },
      })
    },
  }
}

/** What the image-tool executor needs from the main process (画布完善第 7 条第三步). */
export interface CanvasImageToolProcessing {
  /**
   * Fails unless every source is a picture this account can read in the
   * project, each at most 20 MB and 64 MB together: what the page will be
   * asked to read, said before the node waits on it.
   */
  assertSources(userId: number, projectId: string, assetIds: readonly string[]): Promise<void>
  /** Waits for the page's PNGs and saves them, in order, with the run's project assets. */
  waitForImages(input: {
    runId: string
    userId: number
    projectId: string
    preparation: CanvasImagePreparation
    expectation: CanvasImageTransformExpectation
    signal: AbortSignal
  }): Promise<CanvasRunAsset[]>
}

/** The parts of CanvasProjectAssetManager an image tool touches. */
export interface CanvasImageToolAssetStore {
  readImageOwned(userId: number, assetId: string, projectId?: string): Promise<{ bytes: Buffer }>
  forProject(userId: number, projectId: string): Promise<{
    images: { storeLocalBytes(userId: number, bytes: Buffer): Promise<AiStoredAsset> }
    media: { setSource(userId: number, assetId: string, source: 'imported'): Promise<unknown> }
  }>
}

function storedImageAsset(stored: AiStoredAsset): CanvasRunAsset {
  return {
    kind: 'image',
    assetId: stored.assetId,
    localUrl: stored.localUrl,
    mimeType: stored.mimeType,
    ...(stored.width ? { width: stored.width } : {}),
    ...(stored.height ? { height: stored.height } : {}),
  }
}

export function createCanvasImageToolProcessing(options: {
  broker: CanvasRunPreparationBroker
  assets: CanvasImageToolAssetStore
  onSourceError?(error: unknown, assetId: string): void
}): CanvasImageToolProcessing {
  return {
    async assertSources(userId, projectId, assetIds) {
      if (assetIds.length > maximumCanvasImageTransformInputs) throw new Error('图片处理最多用 20 张图片')
      let total = 0
      for (const assetId of assetIds) {
        const { bytes } = await options.assets.readImageOwned(userId, assetId, projectId)
        if (bytes.byteLength > maximumCanvasImageTransformBytes) throw new Error('图片处理的来源图片超过 20 MB，请换一张小一点的图')
        total += bytes.byteLength
        if (total > maximumCanvasImageTransformBatchBytes) throw new Error('图片处理的来源图片合计超过 64 MB，请减少图片')
      }
    },
    waitForImages({ runId, userId, projectId, preparation, expectation, signal }) {
      return options.broker.expectImages({
        runId,
        userId,
        preparation,
        expectation,
        signal,
        store: async (pngs) => {
          const context = await options.assets.forProject(userId, projectId)
          const saved: CanvasRunAsset[] = []
          for (const png of pngs) {
            signal.throwIfAborted()
            const stored = await context.images.storeLocalBytes(userId, png)
            // The web host records these as imported too: the page made the picture, not a model.
            await context.media.setSource(userId, stored.assetId, 'imported').catch((error: unknown) => options.onSourceError?.(error, stored.assetId))
            saved.push(storedImageAsset(stored))
          }
          return saved
        },
      })
    },
  }
}
