// 视频任务归属的核对和运行记录里的任务定位，画布内核的运行面板要用；发请求、解析回执的部分留在 canvas-video-task-client（#3）。
import type { CanvasVideoTaskSummary, CanvasVideoTaskTarget } from '../host'

export interface CanvasVideoTaskActions {
  inspect(target: CanvasVideoTaskTarget): Promise<CanvasVideoTaskSummary>
  check(target: CanvasVideoTaskTarget, expectedVersion: number): Promise<CanvasVideoTaskSummary>
  save(target: CanvasVideoTaskTarget, expectedVersion: number): Promise<CanvasVideoTaskSummary>
}

export class CanvasVideoTaskRequestError extends Error {
  constructor(message: string, public task?: CanvasVideoTaskSummary, public uncertain = false) { super(message); this.name = 'CanvasVideoTaskRequestError' }
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value) }

export function snapshotCanvasVideoTaskTarget(value: CanvasVideoTaskTarget): CanvasVideoTaskTarget {
  if (!object(value) || !id(value.taskId) || !id(value.runId) || !id(value.nodeId) || !id(value.attemptId)) throw new CanvasVideoTaskRequestError('原视频任务归属无法确认，请重新读取运行历史。')
  return { taskId: value.taskId, runId: value.runId, nodeId: value.nodeId, attemptId: value.attemptId }
}

export function canvasVideoTaskTargetForAttempt(runId: string, nodeId: string, attempt: { attemptId: string; cached: boolean; state: string; videoTaskId?: string }, nodeState?: string): CanvasVideoTaskTarget | undefined {
  if (!attempt.videoTaskId || attempt.cached || attempt.state === 'cached' || nodeState === 'cached') return undefined
  try { return snapshotCanvasVideoTaskTarget({ taskId: attempt.videoTaskId, runId, nodeId, attemptId: attempt.attemptId }) } catch { return undefined }
}
