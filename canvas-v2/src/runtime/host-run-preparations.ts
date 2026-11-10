import type { CanvasFramePreparation, CanvasRunPreparationCompletion } from '../host'
import { extractBrowserVideoFrame, type BrowserFrameOptions, type BrowserFrameResult } from '../library/browser-frame'

// 宿主运行准备（桌面画布完善第 7 条第二步）：运行到抽帧节点时，宿主不解视频，在 run-waiting 里列出
// 「这一帧要你抽」。网页宿主自己在外壳里抽、交给服务端（lib/canvas-host.ts）；桌面宿主没有外壳，
// 由内核替它抽：读出那段视频、用 browser-frame.ts 解出那一帧，交回 completeRunPreparation。
// 宿主桥上没有这个方法（网页）就什么都不做。

/** The host methods a frame needs; the desktop's sandboxed preload provides both. */
export interface HostRunPreparationBridge {
  readVideoForFramePreview(assetId: string, signal?: AbortSignal): Promise<Blob>
  completeRunPreparation(input: CanvasRunPreparationCompletion): Promise<void>
}

export interface HostRunPreparations {
  /** The frames a run waits on now, from a run-waiting event; frames it no longer lists stop. */
  update(runId: string, preparations: readonly CanvasFramePreparation[]): void
  /**
   * Frames listed in a run record read back from the host (an event that came
   * before the run was known, a reloaded page). A record may be older than the
   * latest event, so this only starts frames and never stops one.
   */
  resume(runId: string, preparations: readonly CanvasFramePreparation[]): void
  /** The run ended: stop whatever it still waited on. */
  finish(runId: string): void
  /** The project closed or the canvas is going away: stop everything. */
  stopAll(): void
}

interface HostRunPreparationOptions {
  extract?: (blob: Blob, options: BrowserFrameOptions) => Promise<BrowserFrameResult>
}

/** How many answered frames are remembered so a repeated event never decodes one twice. */
const rememberedOperations = 512

function hostRunPreparationBridge(host: unknown): HostRunPreparationBridge | null {
  if (!host || typeof host !== 'object') return null
  const candidate = host as Partial<HostRunPreparationBridge>
  if (typeof candidate.completeRunPreparation !== 'function' || typeof candidate.readVideoForFramePreview !== 'function') return null
  return candidate as HostRunPreparationBridge
}

function operationKey(runId: string, operationId: string): string {
  return `${runId}\n${operationId}`
}

/**
 * Decodes each frame a run waits on once, and hands back either the PNG or a
 * bare failure. A failure carries no words: the host names the reason, so the
 * node shows the host's text and not the page's. A stopped frame hands back
 * nothing; the host's own deadline fails the node.
 */
export function createHostRunPreparations(host: unknown, options: HostRunPreparationOptions = {}): HostRunPreparations | null {
  const found = hostRunPreparationBridge(host)
  if (!found) return null
  const bridge: HostRunPreparationBridge = found
  const extract = options.extract ?? extractBrowserVideoFrame
  const handled = new Set<string>()
  const running = new Map<string, { runId: string; controller: AbortController }>()

  function remember(key: string): void {
    handled.add(key)
    if (handled.size <= rememberedOperations) return
    const oldest = handled.values().next().value
    if (oldest !== undefined) handled.delete(oldest)
  }

  async function answer(runId: string, preparation: CanvasFramePreparation, signal: AbortSignal): Promise<void> {
    const ids = { runId, operationId: preparation.operationId, kind: 'frame' as const }
    try {
      // The web host refuses a frame whose operation is not its attempt; so does the desktop.
      if (preparation.operationId !== preparation.attemptId) throw new Error('抽帧操作标识与尝试不一致')
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

  function stop(key: string): void {
    running.get(key)?.controller.abort()
    running.delete(key)
  }

  function start(runId: string, preparation: CanvasFramePreparation): void {
    const key = operationKey(runId, preparation.operationId)
    if (handled.has(key)) return
    remember(key)
    const controller = new AbortController()
    running.set(key, { runId, controller })
    void answer(runId, preparation, controller.signal).finally(() => {
      if (running.get(key)?.controller === controller) running.delete(key)
    })
  }

  return {
    update(runId, preparations) {
      const listed = new Set(preparations.map((preparation) => operationKey(runId, preparation.operationId)))
      for (const preparation of preparations) start(runId, preparation)
      // The host no longer waits on these (answered, stopped or timed out).
      for (const [key, entry] of running) if (entry.runId === runId && !listed.has(key)) stop(key)
    },
    resume(runId, preparations) {
      for (const preparation of preparations) start(runId, preparation)
    },
    finish(runId) {
      for (const [key, entry] of running) if (entry.runId === runId) stop(key)
    },
    stopAll() {
      for (const key of [...running.keys()]) stop(key)
    },
  }
}
