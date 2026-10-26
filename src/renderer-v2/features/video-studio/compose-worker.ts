import { composeVideoStudio } from './compose'
import { parseVideoStudioWorkerMessage, type VideoStudioWorkerReply } from './compose-protocol'
import { describeVideoStudioFailure, VideoStudioError, videoStudioFailureDetail } from './errors'

// 一个后台线程只拼一次：页面每次导出新开一个，拼完或取消就整个关掉，内存马上还回去。
let started = false

function reply(message: VideoStudioWorkerReply, transfer: Transferable[] = []): void {
  self.postMessage(message, { transfer })
}

async function run(value: unknown): Promise<void> {
  try {
    if (started) throw new VideoStudioError('这个拼片线程已经在忙了')
    started = true
    const { request } = parseVideoStudioWorkerMessage(value)
    const result = await composeVideoStudio(request, {
      onProgress(progress) {
        reply({ kind: 'progress', progress })
      },
    })
    reply({ kind: 'done', result }, [result.data])
  } catch (error) {
    reply({ kind: 'failed', message: describeVideoStudioFailure(error), detail: videoStudioFailureDetail(error) })
  }
}

self.addEventListener('message', (event: MessageEvent) => {
  void run(event.data)
})
