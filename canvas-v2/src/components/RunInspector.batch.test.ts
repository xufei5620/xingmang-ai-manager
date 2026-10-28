import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from '../host'
import { RunInspector } from './RunInspector'

function markup(uncertain: boolean): string {
  const at = '2026-10-14T00:00:00.000Z'
  const record: CanvasRunRecord = { version: 1, userId: 1, ownerId: 1, runId: 'run', graphRevision: 'graph', scope: { kind: 'all' }, status: 'partial', createdAt: at, startedAt: at, mayStillComplete: uncertain, nodes: [{ nodeId: 'image', kind: 'image-generate', state: 'failed', errorMessage: '本组已完成 1/2 次请求', attempts: [{ attemptId: 'attempt-one', fingerprint: 'hash', imageBatch: { batchId: 'batch', index: 1, count: 2 }, state: 'succeeded', startedAt: at, completedAt: at, durationMs: 10, cached: false, candidates: [] }] }], events: [] }
  const noop = () => undefined
  return renderToStaticMarkup(createElement(RunInspector, { open: true, records: [record], selectedRunId: 'run', resultAssets: {}, selectedScope: 'all', dirtyCount: 0, selectionCount: 1, loading: false, onScopeChange: noop, onRefresh: noop, onSelectRun: noop, onUseCandidate: noop, onPreviewAsset: noop, onAssetMenu: noop, onLocateNode: noop, onRetryNode: noop, onClose: noop }))
}

describe('image batch retry explanation', () => {
  it('labels a new batch as a fully paid regeneration rather than retrying missing results', () => {
    const html = markup(false)
    expect(html).toContain('重新生成整组（2 次）')
    expect(html).toContain('不会只补缺失图片')
    expect(html).not.toContain('从此向后重试')
  })

  it('keeps the uncertain upstream warning and withholds retry while the request may complete', () => {
    const html = markup(true)
    expect(html).toContain('先核对上游是否已完成或扣费')
    expect(html).toContain('已有图片保留')
    expect(html).not.toContain('重新生成整组（2 次）')
  })
})

describe('video batch task accounting', () => {
  function videoMarkup(uncertain: boolean, batched = true, update?: (record: CanvasRunRecord) => void): string {
    const at = '2026-10-15T00:00:00.000Z'
    const attempts: CanvasRunRecord['nodes'][number]['attempts'] = [
      { attemptId: 'one', fingerprint: 'hash', state: 'succeeded', startedAt: at, completedAt: at, durationMs: 3000, cached: false, videoTaskId: 'task-one', ...(batched ? { videoBatch: { batchId: 'batch', index: 1 as const, count: 3 as const } } : {}), candidates: [] },
      ...(batched ? [{ attemptId: 'two', fingerprint: 'hash', state: 'failed' as const, startedAt: at, completedAt: at, durationMs: 3000, cached: false, videoTaskId: 'task-two', videoBatch: { batchId: 'batch', index: 2 as const, count: 3 as const }, candidates: [] }] : []),
    ]
    const record: CanvasRunRecord = { version: 1, userId: 1, ownerId: 1, runId: 'video-run', graphRevision: 'graph', scope: { kind: 'all' }, status: 'partial', createdAt: at, startedAt: at, mayStillComplete: uncertain, nodes: [{ nodeId: 'video', kind: 'video-generate', state: 'failed', errorMessage: '任务未完成', attempts }], events: [] }
    update?.(record)
    const noop = () => undefined
    return renderToStaticMarkup(createElement(RunInspector, { open: true, records: [record], selectedRunId: 'video-run', resultAssets: {}, selectedScope: 'all', dirtyCount: 0, selectionCount: 1, loading: false, onScopeChange: noop, onRefresh: noop, onSelectRun: noop, onUseCandidate: noop, onPreviewAsset: noop, onAssetMenu: noop, onLocateNode: noop, onRetryNode: noop, onClose: noop }))
  }
  it('reports actual completed and submitted tasks separately from seconds and preserves batch retry meaning', () => {
    const html = videoMarkup(false)
    expect(html).toContain('本组视频任务：已完成 1/3 · 已提交 2')
    expect(html).toContain('重新生成整组（3 个视频任务）')
    expect(html).toContain('已保存视频保留')
    expect(html).toContain('核对或保存原任务不会重新提交')
    expect(html).toContain('6.0 秒')
    expect(html).not.toContain('已有图片保留'); expect(html).not.toContain('从此向后重试')
  })
  it('keeps original task recovery guidance and withholds fresh submission for uncertain video tasks', () => {
    const html = videoMarkup(true)
    expect(html).toContain('先核对原任务是否已完成或扣费')
    expect(html).not.toContain('重新生成整组（3 个视频任务）')
  })
  it('does not derive a three-task batch from a legacy single video taking three seconds', () => {
    const html = videoMarkup(false, false)
    expect(html).not.toContain('本组视频任务'); expect(html).not.toContain('重新生成整组')
    expect(html).toContain('3.0 秒')
  })

  it('shows total time for all original tasks in the latest successful video batch', () => {
    const html = videoMarkup(false, true, (record) => {
      const node = record.nodes[0]
      const first = node.attempts[0]
      node.state = 'succeeded'; node.errorMessage = undefined; record.status = 'succeeded'
      node.attempts = [25_000, 30_200, 12_200].map((durationMs, index) => ({ ...first, attemptId: `original-${index}`, videoTaskId: `task-${index}`, durationMs, videoBatch: { batchId: 'batch', index: (index + 1) as 1 | 2 | 3, count: 3 }, state: 'succeeded' }))
    })
    expect(html).toContain('本组视频任务：已完成 3/3 · 已提交 3')
    expect(html).toContain('67.4 秒')
    expect(html).not.toContain('12.2 秒')
  })

  it('labels cached video batches without presenting cache replay as zero paid seconds', () => {
    const html = videoMarkup(false, true, (record) => {
      const node = record.nodes[0]
      node.state = 'cached'; node.errorMessage = undefined; record.status = 'succeeded'
      node.attempts = node.attempts.map((attempt) => ({ ...attempt, state: 'cached', cached: true, durationMs: 0 }))
    })
    expect(html).toContain('缓存命中')
    expect(html).not.toContain('0.0 秒')
  })
})
