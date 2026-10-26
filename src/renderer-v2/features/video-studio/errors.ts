// 这里的报错原样上屏，所以一律写中文；浏览器自己抛的英文错误（解码器、编码器、
// 内存不够）不直接给用户看，由 describeVideoStudioFailure 换成一句能照着做的话。
export class VideoStudioError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VideoStudioError'
  }
}

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
    return '电脑内存不够拼这么长的片子，少放几段或调低清晰度再试'
  }
  return '拼接视频时出错了，换几段片段或调低清晰度再试一次'
}

// 给诊断看的英文原文，截短后才放进回包，免得一大段堆栈跟着跨线程。
export function videoStudioFailureDetail(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}
