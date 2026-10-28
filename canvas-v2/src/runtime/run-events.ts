import {
  canvasRunTimelineLimit,
  type CanvasRunEvent,
  type CanvasRunRecord,
  type CanvasRunStatus,
} from '../host'

export function canvasRunStatusLabel(status?: CanvasRunStatus): string {
  if (!status) return '已结束'
  const labels: Record<CanvasRunStatus, string> = { running: '运行中', succeeded: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
  return labels[status]
}

function appendEvent(events: readonly CanvasRunEvent[], event: CanvasRunEvent): CanvasRunEvent[] {
  const latestSequence = events.at(-1)?.sequence ?? 0
  if (event.sequence <= latestSequence) return [...events]
  return [...events, structuredClone(event)].slice(-canvasRunTimelineLimit)
}

export function mergeCanvasRunEvent(
  records: readonly CanvasRunRecord[],
  event: CanvasRunEvent,
): CanvasRunRecord[] {
  return records.map((record) => {
    if (record.runId !== event.runId || record.graphRevision !== event.graphRevision) return record
    const events = appendEvent(record.events, event)
    if (events.length === record.events.length && events.at(-1)?.sequence === record.events.at(-1)?.sequence) return record
    if (event.type === 'run-waiting') {
      return { ...record, events, waitingForVideo: event.waitingForVideo, framePreparations: structuredClone(event.framePreparations), imagePreparations: structuredClone(event.imagePreparations ?? []), resumeAfter: event.resumeAfter }
    }
    if (event.type === 'node-stage') {
      return {
        ...record,
        events,
        nodes: record.nodes.map((node) => node.nodeId === event.nodeId
          ? {
            ...node,
            latestStage: event.stage,
            latestStageAt: event.at,
            latestStageSequence: event.sequence,
            latestProgress: event.progress,
            latestProgressMode: event.progressMode,
            latestHealth: event.health,
          }
          : node),
      }
    }
    if (event.type === 'node-state') {
      return {
        ...record,
        events,
        nodes: record.nodes.map((node) => node.nodeId === event.nodeId
          ? {
            ...node,
            state: event.state,
            ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
          }
          : node),
      }
    }
    return {
      ...record,
      events,
      waitingForVideo: false,
      framePreparations: [],
      imagePreparations: [],
      resumeAfter: undefined,
      status: event.status,
      outcome: structuredClone(event.outcome),
      completedAt: event.at,
    }
  })
}
