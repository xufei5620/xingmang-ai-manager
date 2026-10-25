import { parseVideoStudioWorkerReply, type VideoStudioComposeProgress, type VideoStudioComposeRequest, type VideoStudioComposeResult, type VideoStudioWorkerMessage } from './compose-protocol'
import { VideoStudioError, videoStudioAbortError } from './errors'

export interface VideoStudioWorkerListener {
  message(data: unknown): void
  error(): void
}

/** 后台线程里页面用得到的那两样，测试里换成假的。 */
export interface VideoStudioWorkerPort {
  start(message: VideoStudioWorkerMessage, transfer: Transferable[], listener: VideoStudioWorkerListener): void
  terminate(): void
}

export interface VideoStudioWorkerComposeOptions {
  signal?: AbortSignal
  onProgress?(progress: VideoStudioComposeProgress): void
  createWorker?(): VideoStudioWorkerPort
}

export function createVideoStudioWorker(): VideoStudioWorkerPort {
  const worker = new Worker(new URL('./compose-worker.ts', import.meta.url), { type: 'module', name: 'xingmang-video-compose' })
  return {
    start(message, transfer, listener) {
      worker.onmessage = (event) => listener.message(event.data)
      worker.onerror = () => listener.error()
      worker.onmessageerror = () => listener.error()
      worker.postMessage(message, transfer)
    },
    terminate() {
      worker.terminate()
    },
  }
}

/**
 * 在后台线程里拼片，页面不卡。片段的字节会转移给后台线程，调完以后 request 里的
 * ArrayBuffer 就空了；要重拼就重新读一遍片段。取消时直接关掉后台线程，不等它收尾。
 */
export function composeInVideoStudioWorker(request: VideoStudioComposeRequest, options: VideoStudioWorkerComposeOptions = {}): Promise<VideoStudioComposeResult> {
  const { signal } = options
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(videoStudioAbortError())
      return
    }
    const worker = (options.createWorker ?? createVideoStudioWorker)()
    let settled = false
    function settle(finish: () => void) {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      finish()
    }
    function abort() {
      settle(() => reject(videoStudioAbortError()))
    }
    signal?.addEventListener('abort', abort, { once: true })
    const listener: VideoStudioWorkerListener = {
      message(data) {
        if (settled) return
        const reply = parseVideoStudioWorkerReply(data)
        if (!reply) {
          settle(() => reject(new VideoStudioError('拼片线程回了看不懂的消息，请再试一次')))
          return
        }
        if (reply.kind === 'progress') {
          options.onProgress?.(reply.progress)
          return
        }
        if (reply.kind === 'done') {
          settle(() => resolve(reply.result))
          return
        }
        settle(() => reject(new VideoStudioError(reply.message)))
      },
      error() {
        settle(() => reject(new VideoStudioError('拼片线程意外停了，请再试一次')))
      },
    }
    try {
      worker.start({ kind: 'compose', request }, request.clips.map((clip) => clip.data), listener)
    } catch {
      settle(() => reject(new VideoStudioError('片段交不给拼片线程，请重新读一遍片段再试')))
    }
  })
}
