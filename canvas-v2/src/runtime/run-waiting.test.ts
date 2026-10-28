import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from '../host'
import { RunInspector } from '../components/RunInspector'
import { defaultImageTransformRecipe, imageTransformProcessorRevision } from '../image-tools/recipe'
import { canContinueCanvasRun, canvasRunContinueMessage, canvasRunWaitingEventLabel, canvasRunWaitingKind, canvasRunWaitingLabel } from './run-waiting'

function run(): CanvasRunRecord {
  return { version: 1, runId: 'existing-run', userId: 1, ownerId: 1, graphRevision: 'revision', scope: { kind: 'all' }, status: 'running', createdAt: '2026-10-10T12:00:00.000Z', startedAt: '2026-10-10T12:00:00.000Z', nodes: [], events: [] }
}

function inspector(record: CanvasRunRecord, continueAvailable = true): string {
  return renderToStaticMarkup(createElement(RunInspector, {
    open: true, records: [record], selectedRunId: record.runId, resultAssets: {}, selectedScope: 'all', dirtyCount: 0, selectionCount: 0, loading: false,
    onScopeChange: () => undefined, onRefresh: () => undefined, onSelectRun: () => undefined, onUseCandidate: () => undefined, onPreviewAsset: () => undefined, onAssetMenu: () => undefined, onLocateNode: () => undefined, onClose: () => undefined,
    ...(continueAvailable ? { onResumeRun: async () => true } : {}),
  }))
}

describe('continuing an existing waiting run', () => {
  it('distinguishes upstream video waiting from browser frame preparation', () => {
    const video = { ...run(), waitingForVideo: true }
    const frame = { ...run(), framePreparations: [{ operationId: 'op', nodeId: 'frame', attemptId: 'attempt', sourceAssetId: 'a'.repeat(43), timestampSeconds: 1 }] }
    expect(canvasRunWaitingKind(video)).toBe('video')
    expect(canvasRunWaitingLabel(video)).toBe('等待视频结果')
    expect(canvasRunWaitingKind(frame)).toBe('frame')
    expect(canvasRunWaitingLabel(frame)).toBe('等待浏览器抽帧')
    expect(canvasRunWaitingKind({ ...video, ...frame, waitingForVideo: true })).toBe('video-and-frame')
    expect(canvasRunWaitingKind({ ...run(), waitingForFrame: true })).toBe('frame')
  })

  it('never turns an ordinary active run into a resumable waiting run', () => {
    expect(canvasRunWaitingKind(run())).toBeNull()
    expect(canContinueCanvasRun(run())).toBe(false)
    expect(canContinueCanvasRun({ ...run(), waitingForVideo: true })).toBe(true)
    expect(canContinueCanvasRun({ ...run(), framePreparations: [] })).toBe(false)
  })

  it.each(['succeeded', 'partial', 'failed', 'cancelled', 'interrupted'] as const)('does not continue a %s run even when it retains old waiting metadata', (status) => {
    const record = { ...run(), status, waitingForVideo: true, waitingForFrame: true }
    expect(canvasRunWaitingKind(record)).toBeNull()
    expect(canContinueCanvasRun(record)).toBe(false)
    expect(inspector(record)).not.toContain('继续原任务</button>')
  })

  it('disables continuing after a cancellation request or an in-progress cancellation', () => {
    const stopped = { ...run(), waitingForVideo: true, cancelRequested: true }
    const cancelling = { ...run(), waitingForVideo: true, nodes: [{ nodeId: 'video', kind: 'video-generate', state: 'cancelling' as const, attempts: [] }] }
    expect(canContinueCanvasRun(stopped)).toBe(false)
    expect(canContinueCanvasRun(cancelling)).toBe(false)
    expect(inspector(stopped)).toContain('任务已请求停止，不能继续')
    expect(inspector(cancelling)).toContain('任务已请求停止，不能继续')
  })

  it('renders a real continuation entry when the host supports it and an explicit disabled reason otherwise', () => {
    const record = { ...run(), waitingForVideo: true }
    const ready = inspector(record)
    expect(ready).toContain('继续原任务</button>')
    expect(ready).not.toContain('当前宿主尚未提供继续原任务能力')
    expect(inspector(record, false)).toContain('当前宿主尚未提供继续原任务能力')
  })

  it('tells users browser frame preparation requires the original canvas without claiming background completion', () => {
    const record = { ...run(), framePreparations: [{ operationId: 'op', nodeId: 'frame', attemptId: 'attempt', sourceAssetId: 'a'.repeat(43), timestampSeconds: 0 }] }
    expect(inspector(record)).toContain('请保持画布打开')
    expect(inspector(record)).not.toContain('后台必然完成')
    expect(canvasRunContinueMessage(true)).toContain('结果以刷新后的运行状态为准')
    expect(canvasRunContinueMessage(false)).toContain('可能仍在处理中或已经结束')
  })

  it('renders waiting and continuation events without assuming every event belongs to a node', () => {
    const base = { version: 1 as const, runId: 'existing-run', graphRevision: 'revision', sequence: 1, at: '2026-10-10T12:00:00.000Z', type: 'run-waiting' as const }
    expect(inspector({ ...run(), events: [{ ...base, waitingForVideo: true, framePreparations: [] }] })).toContain('等待视频结果')
    expect(inspector({ ...run(), events: [{ ...base, waitingForVideo: false, framePreparations: [] }] })).toContain('原任务继续执行')
    expect(canvasRunWaitingEventLabel({ waitingForVideo: false, framePreparations: [{}] })).toBe('等待浏览器抽帧')
  })
})


it('labels resumable image preparation and clears continuation after cancellation', () => {
  const image = { status: 'running', imagePreparations: [{}] }
  expect(canvasRunWaitingEventLabel({ waitingForVideo: false, framePreparations: [], imagePreparations: [{}] })).toBe('等待浏览器处理图片')
  expect(canContinueCanvasRun(image)).toBe(true)
  expect(canContinueCanvasRun({ ...image, cancelRequested: true })).toBe(false)
  const html = inspector({ ...run(), imagePreparations: [{ operationId: 'attempt', runId: 'existing-run', projectId: 'project', nodeId: 'crop', attemptId: 'attempt', sourceAssetIds: ['a'.repeat(43)], recipe: defaultImageTransformRecipe('crop'), processorRevision: imageTransformProcessorRevision }] })
  expect(html).toContain('等待浏览器处理图片')
  expect(html).toContain('媒体素材需要在所属画布的浏览器中处理与保存')
  expect(html).not.toContain('视频帧需要')
})
