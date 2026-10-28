interface CanvasWaitingRun {
  status: string
  cancelRequested?: boolean
  waitingForVideo?: boolean
  waitingForFrame?: boolean
  waitingForImage?: boolean
  framePreparations?: readonly unknown[]
  imagePreparations?: readonly unknown[]
  nodes?: readonly { state: string }[]
}

export type CanvasRunWaitingKind = 'video' | 'frame' | 'video-and-frame' | 'image' | 'media'

export function canvasRunWaitingKind(run: CanvasWaitingRun): CanvasRunWaitingKind | null {
  if (run.status !== 'running') return null
  const video = run.waitingForVideo === true
  const frame = run.waitingForFrame === true || Boolean(run.framePreparations?.length)
  const image = run.waitingForImage === true || Boolean(run.imagePreparations?.length)
  if (image) return video || frame ? 'media' : 'image'
  return video && frame ? 'video-and-frame' : video ? 'video' : frame ? 'frame' : null
}

export function canvasRunWaitingLabel(run: CanvasWaitingRun): string | null {
  const kind = canvasRunWaitingKind(run)
  return kind === 'image' ? '等待浏览器处理图片' : kind === 'media' ? '等待媒体处理' : kind === 'video-and-frame' ? '等待视频与浏览器抽帧' : kind === 'video' ? '等待视频结果' : kind === 'frame' ? '等待浏览器抽帧' : null
}

export function canvasRunWaitingEventLabel(event: { waitingForVideo: boolean; framePreparations: readonly unknown[]; imagePreparations?: readonly unknown[] }): string {
  return canvasRunWaitingLabel({ status: 'running', ...event }) ?? '原任务继续执行'
}

export function canContinueCanvasRun(run: CanvasWaitingRun): boolean {
  return canvasRunWaitingKind(run) !== null && !run.cancelRequested && !run.nodes?.some((node) => node.state === 'cancelling')
}

export function canvasRunContinueMessage(started: boolean): string {
  return started ? '已请求继续原任务，结果以刷新后的运行状态为准；没有新建运行。'
    : '原任务未开始新的执行，可能仍在处理中或已经结束；请刷新状态核对。'
}
