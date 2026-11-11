import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasRunRecord } from '../host'
import { eventLabel, RunInspector, runClockTime, runDateTime, runNodeLabel } from './RunInspector'

// 运行时间线原来写的是节点内部编号（如「n-1730000000000-ab12：已完成」），时间跟着系统语言走（#1368 第 11 条）。
const at = '2026-11-09T05:07:08.000Z'
const base = { version: 1 as const, runId: 'run', graphRevision: 'graph', at }

function record(): CanvasRunRecord {
  return {
    version: 1, userId: 1, ownerId: 1, runId: 'run', graphRevision: 'graph', scope: { kind: 'all' }, status: 'succeeded', createdAt: at, startedAt: at,
    nodes: [
      { nodeId: 'node-renamed', kind: 'image-generate', state: 'succeeded', attempts: [] },
      { nodeId: 'node-plain', kind: 'image-generate', state: 'succeeded', attempts: [] },
      { nodeId: 'node-unknown', kind: 'retired-kind', state: 'succeeded', attempts: [] },
    ],
    events: [
      { ...base, sequence: 1, type: 'node-stage', nodeId: 'node-renamed', stage: 'submitting' },
      { ...base, sequence: 2, type: 'node-state', nodeId: 'node-plain', state: 'succeeded' },
    ],
  }
}

function markup(nodeTitles?: Record<string, string>): string {
  const noop = () => undefined
  return renderToStaticMarkup(createElement(RunInspector, { open: true, records: [record()], selectedRunId: 'run', resultAssets: {}, selectedScope: 'all', dirtyCount: 0, selectionCount: 0, loading: false, nodeTitles, onScopeChange: noop, onRefresh: noop, onSelectRun: noop, onUseCandidate: noop, onPreviewAsset: noop, onAssetMenu: noop, onLocateNode: noop, onRetryNode: noop, onClose: noop }))
}

describe('run inspector node labels', () => {
  it('prefers the name the node has on the canvas, then its kind, then its id', () => {
    const titles = { 'node-renamed': '咖啡杯主图', 'node-plain': '  ' }
    expect(runNodeLabel('node-renamed', record(), titles)).toBe('咖啡杯主图')
    expect(runNodeLabel('node-plain', record(), titles)).toBe('图像节点')
    expect(runNodeLabel('node-unknown', record(), titles)).toBe('node-unknown')
    expect(runNodeLabel('node-deleted', record(), titles)).toBe('node-deleted')
  })

  it('writes node names into the timeline instead of internal ids', () => {
    const [stage, state] = record().events
    const label = (nodeId: string) => runNodeLabel(nodeId, record(), { 'node-renamed': '咖啡杯主图' })
    expect(eventLabel(stage, label)).toBe('咖啡杯主图：提交生成请求')
    expect(eventLabel(state, label)).toBe('图像节点：已完成')

    const html = markup({ 'node-renamed': '咖啡杯主图' })
    expect(html).toContain('咖啡杯主图：提交生成请求')
    expect(html).toContain('图像节点：已完成')
    expect(html).not.toContain('node-renamed：')
    expect(html).not.toContain('node-plain：')
  })

  it('shows the renamed node in the per-node records too', () => {
    const html = markup({ 'node-renamed': '咖啡杯主图' })
    expect(html).toContain('定位到画布节点：咖啡杯主图')
    expect(html).toMatch(/<button[^>]*>咖啡杯主图<\/button>/)
  })

  it('formats times the same whatever the system language', () => {
    expect(runClockTime(at)).toMatch(/^\d{1,2}:\d{2}:\d{2}$/)
    expect(runDateTime(at)).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}$/)
    expect(runClockTime(at)).not.toMatch(/AM|PM|上午|下午/)
  })
})
