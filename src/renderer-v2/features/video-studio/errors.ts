// 这里的报错原样上屏，所以一律写中文；浏览器自己抛的英文错误（解码器、编码器、
// 内存不够）不直接给用户看，由 describeVideoStudioFailure 换成一句能照着做的话。
export class VideoStudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoStudioError'
  }
}

// 回包读不懂、后台线程停了、片段交不过去、请求本身不对，都是程序自己出的岔子，客户照着做不了什么，
// 统一说这一句，不提「线程」「编码器」。
export const videoStudioComposeGlitchMessage = '合成时出现问题，请重试'

export function videoStudioAbortError(): DOMException {
  return new DOMException('已取消', 'AbortError')
}

export function isVideoStudioAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function throwIfVideoStudioAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw videoStudioAbortError()
}

export function describeVideoStudioFailure(error: unknown): string {
  if (error instanceof VideoStudioError) return error.message
  if (isVideoStudioAbort(error)) return '已取消'
  if (error instanceof RangeError || (error instanceof DOMException && error.name === 'QuotaExceededError')) {
    return '内存不足，无法合成此长度的视频，请减少片段或降低清晰度后重试'
  }
  return '视频合成出错，请更换部分片段或降低清晰度后重试'
}

// 给诊断看的英文原文，截短后才放进回包，免得一大段堆栈跟着跨线程。
export function videoStudioFailureDetail(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}
