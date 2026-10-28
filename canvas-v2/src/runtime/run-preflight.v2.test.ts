// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/runtime/run-preflight.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
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
  // 运行前计费次数口径的三个用例交给 #6 判定，先退役（见 docs/canvas-kernel-v2-tests.md）：
  // 'selects the full upstream closure and describes paid/cache/skip work'
  // 'selects downstream nodes plus their required upstream dependencies'
  // 'counts image and video requests separately and discounts explicit cache hits'
  // 原文在桌面 000f9131 的 canvas-v2/src/runtime/run-preflight.test.ts。

  it('blocks missing group/model and missing local input without touching credentials', () => {
    const input = graph()
    input.nodes.push({ id: 'input', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '' } })
    expect(buildCanvasRunPreflight({
      graph: input, scope: { kind: 'all' }, imageModels: [], videoModels: [],
    })).toMatchObject({ canStart: false, risk: 'blocking', blockedCount: 3 })
  })

  it('blocks image generation when a drama shot gate is closed', () => {
    const result = buildCanvasRunPreflight({
      graph: {
        nodes: [
          { id: 'shot', kind: 'drama-shot', definitionVersion: 1, data: { prompt: 'compiled', model: '' } },
          { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'out', model: 'gpt-image-2', group: '生图分组' } },
        ],
        edges: [{ id: 'e', source: 'shot', sourceHandle: 'out:text', target: 'image', targetHandle: 'in:text' }],
      },
      scope: { kind: 'all' },
      imageGroup: '生图分组',
      videoGroup: 'grok',
      imageModels: ['gpt-image-2'],
      videoModels: ['grok-imagine-video'],
      nodeBlockReasons: { image: '请先封板角色「虞晚」的定妆图' },
    })
    expect(result.canStart).toBe(false)
    expect(result.items.find((item) => item.nodeId === 'image')).toMatchObject({
      action: 'blocked',
      reasonCode: 'drama-gate',
      reason: '请先封板角色「虞晚」的定妆图',
    })
  })

  it('rejects an empty or unknown scope deterministically', () => {
    expect(() => selectCanvasRunNodeIdsForPreflight(graph(), { kind: 'selection', nodeIds: [] })).toThrow('运行范围不能为空')
    expect(() => selectCanvasRunNodeIdsForPreflight(graph(), { kind: 'to-node', nodeId: 'missing' })).toThrow('不存在')
    expect(() => selectCanvasRunNodeIdsForPreflight(graph(), { kind: 'from-node', nodeId: 'missing' })).toThrow('不存在')
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
