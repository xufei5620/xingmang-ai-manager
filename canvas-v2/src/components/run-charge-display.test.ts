import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasRunRecord } from '../host'
import type { CanvasRunChargeTotal } from '../runtime/run-charge'
import { CanvasInspector, type CanvasInspectorNode } from './CanvasInspector'
import { RunInspector } from './RunInspector'

// 跑完以后的「实扣」（桌面仓画布完善第 2b 条第 3 步）：运行面板和检查器「消耗」怎么写。

const at = '2026-11-10T05:00:00.000Z'
const hint = '到你账号的用量记录里按请求号对出来的实扣；待核对是没对上的，以用量页为准'

function attempt(attemptId: string, charge?: CanvasRunRecord['nodes'][number]['attempts'][number]['charge']): CanvasRunRecord['nodes'][number]['attempts'][number] {
  return { attemptId, fingerprint: 'f'.repeat(64), state: 'succeeded', startedAt: at, completedAt: at, durationMs: 3_200, cached: false, candidates: [], ...(charge ? { charge } : {}) }
}

function run(charge?: CanvasRunRecord['charge']): CanvasRunRecord {
  return {
    version: 1, userId: 1, ownerId: 1, runId: 'run', graphRevision: 'graph', scope: { kind: 'all' }, status: 'succeeded', createdAt: at, startedAt: at, durationMs: 6_500,
    nodes: [{ nodeId: 'image', kind: 'image-generate', state: 'succeeded', attempts: charge ? [attempt('a1', { state: 'settled', usd: 0.06 }), attempt('a2', { state: 'unmatched', usd: 0 })] : [attempt('a1')] }],
    events: [],
    ...(charge ? { charge } : {}),
  }
}

function runMarkup(record: CanvasRunRecord): string {
  const noop = () => undefined
  return renderToStaticMarkup(createElement(RunInspector, { open: true, records: [record], selectedRunId: 'run', resultAssets: {}, selectedScope: 'all', dirtyCount: 0, selectionCount: 0, loading: false, onScopeChange: noop, onRefresh: noop, onSelectRun: noop, onUseCandidate: noop, onPreviewAsset: noop, onAssetMenu: noop, onLocateNode: noop, onClose: noop }))
}

const inspected: CanvasInspectorNode = {
  id: 'image', kind: 'image-generate', title: '图像节点', description: '', status: 'succeeded', prompt: '一只猫', model: 'gpt-image-2', settings: {},
  candidateCount: 1, attemptCount: 1, dirty: false, disabled: false, locked: false, executable: true, ports: [],
}

function inspectorMarkup(node: CanvasInspectorNode, charge?: CanvasRunChargeTotal): string {
  return renderToStaticMarkup(createElement(CanvasInspector, {
    tab: 'node', nodes: [node], imageModels: [], videoModels: [], ...(charge ? { nodeCharges: new Map([['image', charge]]) } : {}),
    onTabChange: vi.fn(), onClose: vi.fn(), onLocate: vi.fn(), onRun: vi.fn(), onToggleLocked: vi.fn(), onToggleDisabled: vi.fn(), onPreview: vi.fn(),
  }))
}

describe('run charge display', () => {
  it('puts 实扣 under the run time and next to each node, once the host has checked it', () => {
    const html = runMarkup(run({ state: 'unmatched', usd: 0.06, unmatchedAttempts: 1, checkedAt: at }))
    expect(html).toContain(`<div class="run-summary-figures"><span>6.5 秒</span><span class="run-charge" title="${hint}">实扣 $0.06，另有 1 次待核对</span></div>`)
    expect(html).toContain(`<span>2 次尝试</span><span>3.2 秒</span><span class="run-charge" title="${hint}">实扣 $0.06，另有 1 次待核对</span>`)
    // Before the check, on the web and for historical accounts: just the time, as before.
    const unchecked = runMarkup(run())
    expect(unchecked).toContain('<span>6.5 秒</span></section>')
    expect(unchecked).not.toContain('run-charge')
    expect(unchecked).not.toContain('实扣')
  })

  it('shows the charge as 消耗 in the node inspector, and the old quota or dash where there is none', () => {
    expect(inspectorMarkup(inspected, { usd: 0.18, settledAttempts: 3, unmatchedAttempts: 0, approximate: false })).toContain(`<div><dt>消耗</dt><dd class="canvas-inspector-charge" title="${hint}">$0.18</dd></div>`)
    // The half-width cell would cut 待核对 off behind an ellipsis.
    expect(inspectorMarkup(inspected, { usd: 0.06, settledAttempts: 1, unmatchedAttempts: 2, approximate: false })).toContain('<div class="is-wide"><dt>消耗</dt><dd class="canvas-inspector-charge"')
    expect(inspectorMarkup(inspected, { usd: 0, settledAttempts: 0, unmatchedAttempts: 1, approximate: false })).toContain(`<div><dt>消耗</dt><dd class="canvas-inspector-charge" title="${hint}">待核对</dd></div>`)
    expect(inspectorMarkup(inspected)).toContain('<div><dt>消耗</dt><dd>—</dd></div>')
    expect(inspectorMarkup({ ...inspected, costQuota: 12 })).toContain('<div><dt>消耗</dt><dd>12 quota</dd></div>')
  })

  it('takes the charge event before the active-run check and hands the inspector the latest charges', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const handler = app.slice(app.indexOf('hostBridge().onRunEvent((event) => {'))
    expect(handler.indexOf("if (event.type === 'run-charge') {")).toBeGreaterThan(0)
    expect(handler.indexOf("if (event.type === 'run-charge') {")).toBeLessThan(handler.indexOf('const active = activeRunsRef.current.get(event.runId)'))
    expect(app).toContain('const inspectorNodeCharges = useMemo(() => latestCanvasNodeCharges(runRecords), [runRecords])')
    expect(app).toContain('nodeCharges={inspectorNodeCharges}')
  })
})
