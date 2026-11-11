import type { CanvasFramePreparation, CanvasImagePreparation, CanvasRunPreparationCompletion } from '../host'
import type { AssetColorLutSource } from '../image-tools/layer-color-lut-selection'
import type { ColorLutTable } from '../image-tools/layer-color-lut'
import { prepareLayerColorLuts } from '../image-tools/layer-color-lut-runtime'
import { extractBrowserVideoFrame, type BrowserFrameOptions, type BrowserFrameResult } from '../library/browser-frame'
import { processBrowserImageTransform, type BrowserImageTransformInput, type BrowserImageTransformOutput } from '../library/browser-image-transform'
import { maximumImageTransformBatchBytes, maximumImageTransformBytes, parseImagePreparation, parseImageTransformManifestForPreparation } from '../lib/image-transform-contract'

// 宿主运行准备（桌面画布完善第 7 条第二、三步）：运行到抽帧、图片工具节点时，宿主不解视频、不处理像素，
// 在 run-waiting 里列出「这一帧要你抽」「这几张图要你按这组参数处理」。网页宿主自己在外壳里做、交给服务端
// （lib/canvas-host.ts）；桌面宿主没有外壳，由内核替它做：读出来源、用 browser-frame.ts 解出那一帧或用
// browser-image-transform.ts 处理图片，交回 completeRunPreparation。宿主桥上没有这个方法（网页）就什么都不做。

/** The host methods a preparation needs; the desktop's sandboxed preload provides them. */
export interface HostRunPreparationBridge {
  readVideoForFramePreview?(assetId: string, signal?: AbortSignal): Promise<Blob>
  readImageForRunPreparation?(assetId: string, signal?: AbortSignal): Promise<Blob>
  readColorLut?(source: AssetColorLutSource, signal?: AbortSignal): Promise<{ table: ColorLutTable }>
  completeRunPreparation(input: CanvasRunPreparationCompletion): Promise<void>
}

export interface HostRunPreparations {
  /** What a run waits on now, from a run-waiting event; whatever it no longer lists stops. */
  update(runId: string, frames: readonly CanvasFramePreparation[], images?: readonly CanvasImagePreparation[]): void
  /**
   * Preparations listed in a run record read back from the host (an event that
   * came before the run was known, a reloaded page). A record may be older than
   * the latest event, so this only starts work and never stops any.
   */
  resume(runId: string, frames: readonly CanvasFramePreparation[], images?: readonly CanvasImagePreparation[]): void
  /** The run ended: stop whatever it still waited on. */
  finish(runId: string): void
  /** The project closed or the canvas is going away: stop everything. */
  stopAll(): void
}

interface HostRunPreparationOptions {
  extract?: (blob: Blob, options: BrowserFrameOptions) => Promise<BrowserFrameResult>
  process?: (input: BrowserImageTransformInput) => Promise<BrowserImageTransformOutput[]>
}

/** How many answered preparations are remembered so a repeated event never does one twice. */
const rememberedOperations = 512

function hostRunPreparationBridge(host: unknown): HostRunPreparationBridge | null {
  if (!host || typeof host !== 'object') return null
  const candidate = host as Partial<HostRunPreparationBridge>
  if (typeof candidate.completeRunPreparation !== 'function') return null
  if (typeof candidate.readVideoForFramePreview !== 'function' && typeof candidate.readImageForRunPreparation !== 'function') return null
  return candidate as HostRunPreparationBridge
}

type PreparationKind = 'frame' | 'image'

function operationKey(runId: string, kind: PreparationKind, operationId: string): string {
  return `${runId}\n${kind}\n${operationId}`
}

/**
 * Does each preparation a run waits on once, and hands back either the PNGs
 * or a bare failure. A failure carries no words: the host names the reason,
 * so the node shows the host's text and not the page's. A stopped preparation
 * hands back nothing; the host's own deadline fails the node.
 */
export function createHostRunPreparations(host: unknown, options: HostRunPreparationOptions = {}): HostRunPreparations | null {
  const found = hostRunPreparationBridge(host)
  if (!found) return null
  const bridge: HostRunPreparationBridge = found
  const extract = options.extract ?? extractBrowserVideoFrame
  const process = options.process ?? processBrowserImageTransform
  const handled = new Set<string>()
  const running = new Map<string, { runId: string; controller: AbortController }>()

  function remember(key: string): void {
    handled.add(key)
    if (handled.size <= rememberedOperations) return
    const oldest = handled.values().next().value
    if (oldest !== undefined) handled.delete(oldest)
  }

  async function answerFrame(runId: string, preparation: CanvasFramePreparation, signal: AbortSignal): Promise<void> {
    const ids = { runId, operationId: preparation.operationId, kind: 'frame' as const }
    try {
      // The web host refuses a frame whose operation is not its attempt; so does the desktop.
      if (preparation.operationId !== preparation.attemptId) throw new Error('抽帧操作标识与尝试不一致')
      if (!bridge.readVideoForFramePreview) throw new Error('当前宿主暂不支持视频抽帧')
      const video = await bridge.readVideoForFramePreview(preparation.sourceAssetId, signal)
      signal.throwIfAborted()
      const frame = await extract(video, { timestampSeconds: preparation.timestampSeconds, signal })
      signal.throwIfAborted()
      const decoded = frame.decodedTimestampSeconds
      await bridge.completeRunPreparation({
        ...ids,
        outcome: 'completed',
        png: frame.blob,
        ...(decoded !== undefined && Number.isFinite(decoded) && decoded >= 0 && decoded <= 86_400 ? { decodedTimestampSeconds: decoded } : {}),
      })
    } catch {
      if (signal.aborted) return
      // Said at once, so the node fails now instead of after the host's two-minute wait.
      await bridge.completeRunPreparation({ ...ids, outcome: 'failed' }).catch(() => undefined)
    }
  }

  // Asset LUTs come from the host's own LUT store; a host without one (the
  // desktop) cannot have such a layer processed, and the processor then refuses
  // it instead of drawing it without the colour grade.
  async function lutTables(recipe: CanvasImagePreparation['recipe'], signal: AbortSignal) {
    if (recipe.kind !== 'layer') return undefined
    return prepareLayerColorLuts(recipe, async (source, active) => {
      if (!bridge.readColorLut) throw new Error('当前宿主暂不支持 LUT 调色表')
      return (await bridge.readColorLut(source, active)).table
    }, { signal })
  }

  async function answerImage(runId: string, preparation: CanvasImagePreparation, signal: AbortSignal): Promise<void> {
    const ids = { runId, operationId: preparation.operationId, kind: 'image' as const }
    try {
      // The kernel's own reading of the recipe, the same one the web server
      // applies before it stores anything: ids, revision, sources per tool.
      const input = parseImagePreparation(preparation)
      if (input.runId !== runId) throw new Error('图片处理不属于这个运行')
      if (!bridge.readImageForRunPreparation) throw new Error('当前宿主暂不支持图片处理')
      const sources: Blob[] = []
      let total = 0
      for (const assetId of input.sourceAssetIds) {
        const source = await bridge.readImageForRunPreparation(assetId, signal)
        signal.throwIfAborted()
        if (!(source instanceof Blob) || !source.size || source.size > maximumImageTransformBytes) throw new Error('来源图片无效')
        total += source.size
        if (total > maximumImageTransformBatchBytes) throw new Error('来源图片合计超过上限')
        sources.push(source)
      }
      const tables = await lutTables(input.recipe, signal)
      signal.throwIfAborted()
      const outputs = await process({ sources, recipe: input.recipe, signal, ...(tables ? { lutTables: tables } : {}) })
      signal.throwIfAborted()
      // The count and sizes the host checks too, so a picture it would refuse fails here at once.
      parseImageTransformManifestForPreparation(outputs.map((output, index) => {
        if (!(output.blob instanceof Blob) || output.blob.type !== 'image/png') throw new Error('处理结果不是 PNG')
        return { index, pngDigest: '0'.repeat(64), byteSize: output.blob.size, width: output.width, height: output.height }
      }), input)
      await bridge.completeRunPreparation({ ...ids, outcome: 'completed', pngs: outputs.map((output) => output.blob) })
    } catch {
      if (signal.aborted) return
      await bridge.completeRunPreparation({ ...ids, outcome: 'failed' }).catch(() => undefined)
    }
  }

  function stop(key: string): void {
    running.get(key)?.controller.abort()
    running.delete(key)
  }

  function start(runId: string, kind: PreparationKind, operationId: string, work: (signal: AbortSignal) => Promise<void>): void {
    const key = operationKey(runId, kind, operationId)
    if (handled.has(key)) return
    remember(key)
    const controller = new AbortController()
    running.set(key, { runId, controller })
    void work(controller.signal).finally(() => {
      if (running.get(key)?.controller === controller) running.delete(key)
    })
  }

  function startAll(runId: string, frames: readonly CanvasFramePreparation[], images: readonly CanvasImagePreparation[]): void {
    for (const preparation of frames) start(runId, 'frame', preparation.operationId, (signal) => answerFrame(runId, preparation, signal))
    for (const preparation of images) start(runId, 'image', preparation.operationId, (signal) => answerImage(runId, preparation, signal))
  }

  return {
    update(runId, frames, images = []) {
      const listed = new Set([
        ...frames.map((preparation) => operationKey(runId, 'frame', preparation.operationId)),
        ...images.map((preparation) => operationKey(runId, 'image', preparation.operationId)),
      ])
      startAll(runId, frames, images)
      // The host no longer waits on these (answered, stopped or timed out).
      for (const [key, entry] of running) if (entry.runId === runId && !listed.has(key)) stop(key)
    },
    resume(runId, frames, images = []) {
      startAll(runId, frames, images)
    },
    finish(runId) {
      for (const [key, entry] of running) if (entry.runId === runId) stop(key)
    },
    stopAll() {
      for (const key of [...running.keys()]) stop(key)
    },
  }
}
