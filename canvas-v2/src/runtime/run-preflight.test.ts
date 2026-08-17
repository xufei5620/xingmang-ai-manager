import { describe, expect, it } from 'vitest'
import { buildCanvasRunPreflight, selectCanvasRunNodeIdsForPreflight } from './run-preflight'
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
    expect(result.canStart).toBe(true)
    expect(result.risk).toBe('warning')
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
})
