import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CanvasRunGraph, CanvasRunScope } from '../host'
import { RunPreflight } from '../components/RunPreflight'
import { buildCanvasRunPreflight, canvasRunPaidNotice, dramaParseMaximumRequestCount, keptResultReason, type CanvasRunPreflight } from './run-preflight'
import { cachedNodeIdsForPreflight } from './pinned-reuse'

// 桌面 0.2.25 总单第 57 项（Mac 验收 R15）：场景入口跑完、什么都不动再「运行全部」，
// 确认框还写「最多扣费生成 7 次」，实际全用了上次的结果、一分没扣。上限照写（只有宿主能证明指纹对得上），
// 只把上次的结果还在、没改过的那部分标成通常不扣费。

const sha = 'a'.repeat(43)

function graph(): CanvasRunGraph {
  return {
    nodes: [
      { id: 'photo', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: sha } },
      { id: 'words', kind: 'text-generate', definitionVersion: 1, data: { prompt: '写一段画面描述', model: 'gpt-4.1', group: 'provider' } },
      { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: '', model: 'gpt-image-2', group: 'provider', imageCandidateCount: 2 } },
      { id: 'script', kind: 'drama-parse', definitionVersion: 1, data: { prompt: '两只猫在窗台上', model: 'gpt-4.1', group: 'provider' } },
    ],
    edges: [
      { id: 'photo-image', source: 'photo', sourceHandle: 'out:image', target: 'image', targetHandle: 'in:images' },
      { id: 'words-image', source: 'words', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' },
    ],
  }
}

function inspect(cachedNodeIds: readonly string[], scope: CanvasRunScope = { kind: 'all' }, current = graph()): CanvasRunPreflight {
  return buildCanvasRunPreflight({ graph: current, scope, cachedNodeIds, imageModels: ['gpt-image-2'], videoModels: [], textModels: ['gpt-4.1'] })
}

// 1 text request + 2 images + the drama parse retry the desktop may send.
const upperBound = 1 + 2 + dramaParseMaximumRequestCount

function markup(preflight: CanvasRunPreflight): string {
  return renderToStaticMarkup(createElement(RunPreflight, { preflight, quote: { state: 'ready', quote: { estimateUsd: 0.18, pricedRequests: upperBound, unknownRequests: 0, approximate: false } }, onCancel: vi.fn(), onConfigure: vi.fn(), onLocateNode: vi.fn(), onConfirm: vi.fn() }))
}

describe('run preflight for paid nodes that still show an unchanged result', () => {
  it('keeps the full upper bound but says the run usually charges nothing when every paid node kept its result', () => {
    const result = inspect(['photo', 'words', 'image', 'script'])
    expect(result).toMatchObject({ canStart: true, paidRequestCount: upperBound, keptResultRequestCount: upperBound, cacheHitCount: 1, requestCount: upperBound })
    for (const id of ['words', 'image', 'script']) expect(result.items.find((item) => item.nodeId === id)).toMatchObject({ action: 'execute', keptResult: true, reason: keptResultReason })
    expect(result.items.find((item) => item.nodeId === 'photo')).toMatchObject({ action: 'cached', paid: false })
    expect(result.items.find((item) => item.nodeId === 'photo')).not.toHaveProperty('keptResult')
    expect(canvasRunPaidNotice(result)).toEqual({
      beforeQuote: `要扣费的节点上次都出过结果，之后也没改过，这次通常直接用上次的结果，不扣费。万一对不上要重新生成，最多扣费生成 ${upperBound} 次`,
      afterQuote: '。',
    })
    const html = markup(result)
    expect(html).toContain(`万一对不上要重新生成，最多扣费生成 ${upperBound} 次，<span class="run-preflight-quote"`)
    expect(html).toContain('预计约 $0.18</span>。中途点停止只是不再等')
    expect(html).toContain(keptResultReason)
    expect(html).not.toContain('这次最多扣费生成')
  })

  it('names only the reusable part when some paid nodes were edited or never ran', () => {
    const result = inspect(['photo', 'words'])
    expect(result).toMatchObject({ paidRequestCount: upperBound, keptResultRequestCount: 1 })
    expect(result.items.find((item) => item.nodeId === 'image')).toMatchObject({ action: 'execute', reason: '输入跟上次一样就用上次的结果，不一样才重新生成（会扣费）' })
    expect(result.items.find((item) => item.nodeId === 'image')).not.toHaveProperty('keptResult')
    expect(canvasRunPaidNotice(result)).toEqual({
      beforeQuote: `这次最多扣费生成 ${upperBound} 次`,
      afterQuote: '。其中 1 次是上次出过结果、之后没改过的节点，通常直接用上次的结果，不扣费。',
    })
  })

  it('keeps the old sentence when no paid node kept a result', () => {
    const result = inspect([])
    expect(result).not.toHaveProperty('keptResultRequestCount')
    expect(result.items.some((item) => item.keptResult)).toBe(false)
    expect(canvasRunPaidNotice(result)).toEqual({ beforeQuote: `这次最多扣费生成 ${upperBound} 次`, afterQuote: '。输入跟上次一样的直接用上次的结果，不扣费。' })
    expect(canvasRunPaidNotice(inspect([], { kind: 'to-node', nodeId: 'image' }))).toEqual({ beforeQuote: '这次最多扣费生成 3 次', afterQuote: '。选中的节点会重新生成，前面的节点输入没变就用上次的结果。' })
  })

  it('never calls the node picked for Run to here reusable, even when a caller lists it', () => {
    const result = inspect(['photo', 'words', 'image'], { kind: 'to-node', nodeId: 'image' })
    expect(result.items.find((item) => item.nodeId === 'image')).toMatchObject({ action: 'execute', reason: '这个节点重新生成，会扣费' })
    expect(result.items.find((item) => item.nodeId === 'image')).not.toHaveProperty('keptResult')
    expect(result).toMatchObject({ paidRequestCount: 3, keptResultRequestCount: 1 })
    expect(canvasRunPaidNotice(result).afterQuote).toBe('。其中 1 次是上次出过结果、之后没改过的节点，通常直接用上次的结果，不扣费；选中的节点会重新生成。')
  })

  it('matches what the canvas passes in: a succeeded, unedited result counts, an edited one does not', () => {
    const nodes = [
      { id: 'words', data: { status: 'succeeded', result: { assetId: 'words-text' } } },
      { id: 'image', data: { status: 'succeeded', dirty: true, result: { assetId: 'image-1' } } },
      { id: 'script', data: { status: 'succeeded', result: { assetId: 'script-table' } } },
    ]
    const result = inspect(cachedNodeIdsForPreflight(nodes, { kind: 'all' }))
    expect(result.items.filter((item) => item.keptResult).map((item) => item.nodeId)).toEqual(['words', 'script'])
    expect(result.keptResultRequestCount).toBe(1 + dramaParseMaximumRequestCount)
  })

  it('never marks a blocked or skipped node reusable', () => {
    const current = graph()
    current.nodes[1].disabled = true
    current.nodes[3].data.model = 'missing-model'
    const result = inspect(['photo', 'words', 'image', 'script'], { kind: 'all' }, current)
    expect(result.items.find((item) => item.nodeId === 'words')).toMatchObject({ action: 'skip', reasonCode: 'disabled' })
    expect(result.items.find((item) => item.nodeId === 'image')).toMatchObject({ action: 'skip', reasonCode: 'upstream-skip' })
    expect(result.items.find((item) => item.nodeId === 'script')).toMatchObject({ action: 'blocked', reasonCode: 'unavailable-model' })
    expect(result.items.some((item) => item.keptResult)).toBe(false)
    expect(result).not.toHaveProperty('keptResultRequestCount')
  })
})
