import { describe, expect, it } from 'vitest'
import { buildCanvasRunPreflight, sameCanvasRunGraphSnapshot, selectCanvasRunNodeIdsForPreflight } from './run-preflight'
import type { CanvasRunGraph } from '../host'

function graph(): CanvasRunGraph {
  return {
    nodes: [
      { id: 'prompt', kind: 'prompt', definitionVersion: 1, data: { prompt: '海报', model: '' } },
      { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: '生成', model: 'gpt-image-2', group: '生图分组' } },
      { id: 'video', kind: 'video-generate', definitionVersion: 1, data: { prompt: '运动', model: 'grok-imagine-video', group: 'grok' } },
      { id: 'disabled', kind: 'image-generate', definitionVersion: 1, disabled: true, data: { prompt: '', model: 'gpt-image-2' } },
    ],
    edges: [
      { id: 'a', source: 'prompt', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' },
      { id: 'b', source: 'image', sourceHandle: 'out:image', target: 'video', targetHandle: 'in:images' },
    ],
  }
}

describe('canvas run preflight', () => {
  it('selects the full upstream closure and describes paid/cache/skip work', () => {
    const result = buildCanvasRunPreflight({
      graph: graph(), scope: { kind: 'to-node', nodeId: 'video' }, cachedNodeIds: ['image'],
      imageGroup: '生图分组', videoGroup: 'grok', imageModels: ['gpt-image-2'], videoModels: ['grok-imagine-video'],
    })
    expect(result.selectedNodeIds).toEqual(['prompt', 'image', 'video'])
    expect(result.requestCount).toBe(2)
    expect(result.cacheHitCount).toBe(1)
    expect(result.paidRequestCount).toBe(1)
    expect(result.imageRequestCount).toBe(0)
    expect(result.videoRequestCount).toBe(1)
    expect(result.canStart).toBe(true)
    expect(result.risk).toBe('warning')
  })

  it('counts image and video requests separately and discounts explicit cache hits', () => {
    const nodes: CanvasRunGraph['nodes'] = Array.from({ length: 12 }, (_, index) => ({
      id: `edit-${index}`, kind: 'image-edit', definitionVersion: 1,
      data: { prompt: '改图', model: 'gpt-image-2', group: '生图分组', adoptedAssetId: 'a'.repeat(43) },
    }))
    const maximum = buildCanvasRunPreflight({
      graph: { nodes, edges: [] }, scope: { kind: 'all' }, imageGroup: '生图分组', imageModels: ['gpt-image-2'], videoModels: [],
    })
    expect(maximum).toMatchObject({ imageRequestCount: 12, videoRequestCount: 0, paidRequestCount: 12 })
    const cached = buildCanvasRunPreflight({
      graph: { nodes, edges: [] }, scope: { kind: 'all' }, cachedNodeIds: nodes.slice(0, 4).map((node) => node.id),
      imageGroup: '生图分组', imageModels: ['gpt-image-2'], videoModels: [],
    })
    expect(cached).toMatchObject({ imageRequestCount: 8, videoRequestCount: 0, paidRequestCount: 8, cacheHitCount: 4 })
  })

  it('blocks missing group/model and missing local input without touching credentials', () => {
    const input = graph()
    input.nodes.push({ id: 'input', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '' } })
    expect(buildCanvasRunPreflight({
      graph: input, scope: { kind: 'all' }, imageModels: [], videoModels: [],
    })).toMatchObject({ canStart: false, risk: 'blocking', blockedCount: 3 })
  })

  it('rejects an empty or unknown scope deterministically', () => {
    expect(() => selectCanvasRunNodeIdsForPreflight(graph(), { kind: 'selection', nodeIds: [] })).toThrow('运行范围不能为空')
    expect(() => selectCanvasRunNodeIdsForPreflight(graph(), { kind: 'to-node', nodeId: 'missing' })).toThrow('不存在')
  })

  it('propagates a disabled upstream node as skip before validating paid downstream work', () => {
    const input = graph()
    const image = input.nodes.find((node) => node.id === 'image')!
    image.disabled = true
    const result = buildCanvasRunPreflight({
      graph: input,
      scope: { kind: 'to-node', nodeId: 'video' },
      imageGroup: '生图分组',
      videoGroup: 'grok',
      imageModels: ['gpt-image-2'],
      videoModels: [],
    })

    expect(result.items).toMatchObject([
      { nodeId: 'prompt', action: 'execute' },
      { nodeId: 'image', action: 'skip', reasonCode: 'disabled' },
      { nodeId: 'video', action: 'skip', reasonCode: 'upstream-skip' },
    ])
    expect(result).toMatchObject({ canStart: true, blockedCount: 0, paidRequestCount: 0, skippedCount: 2 })
  })

  it('detects a graph change while a paid confirmation is open', () => {
    const original = graph()
    expect(sameCanvasRunGraphSnapshot(original, structuredClone(original))).toBe(true)
    const changed = structuredClone(original)
    changed.nodes = changed.nodes.filter((node) => node.id !== 'image')
    changed.edges = []
    expect(sameCanvasRunGraphSnapshot(original, changed)).toBe(false)
  })
})
