import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { buildCanvasRunPreflight } from './run-preflight'
import { selectionToolbarActions } from '../components/selection-toolbar-model'

// 运行前检查写大白话（桌面 #1368 第 12 条）：不写「执行项」「服务端缓存」「链路」，阻塞的节点写种类不写内部编号。

const jargon = /执行项|服务端缓存|未命中|链路|上游依赖|上游提交|停止等待不代表/

function graph(): CanvasRunGraph {
  return {
    nodes: [
      { id: 'image-generate-1730000000000', kind: 'image-generate', definitionVersion: 1, data: { prompt: '', model: 'gpt-image-2', group: 'provider' } },
      { id: 'cup', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'A ceramic cup', model: 'gpt-image-2', group: 'provider' } },
    ],
    edges: [],
  }
}

function inspect(scope: Parameters<typeof buildCanvasRunPreflight>[0]['scope']) {
  return buildCanvasRunPreflight({ graph: graph(), scope, imageModels: ['gpt-image-2'], videoModels: [] })
}

describe('run preflight wording', () => {
  it('names a blocked node by its kind rather than its internal id', () => {
    const result = inspect({ kind: 'all' })
    const blocked = result.warnings.filter((warning) => warning.includes('：'))
    expect(blocked).toEqual(['图像节点：生成节点没有提示词，请填写提示词或连接上游文字节点'])
  })

  it('describes each scope, reason and warning without the old jargon', () => {
    const scopes = [
      { kind: 'all' as const },
      { kind: 'dirty' as const, nodeIds: ['cup'] },
      { kind: 'selection' as const, nodeIds: ['cup'] },
      { kind: 'to-node' as const, nodeId: 'cup' },
      { kind: 'from-node' as const, nodeId: 'cup' },
    ]
    for (const scope of scopes) {
      const result = inspect(scope)
      for (const text of [...result.warnings, ...result.items.map((item) => item.reason ?? '')]) expect(text).not.toMatch(jargon)
    }
    expect(inspect({ kind: 'selection', nodeIds: ['cup'] }).warnings[0]).toBe('选中的 1 个节点，连同要用到的上游节点')
    expect(inspect({ kind: 'dirty', nodeIds: ['cup'] }).warnings[0]).toBe('改过的 1 个节点，连同要用到的上游节点')
    expect(inspect({ kind: 'to-node', nodeId: 'cup' }).items.find((item) => item.nodeId === 'cup')?.reason).toBe('这个节点重新生成，会扣费')
    expect(inspect({ kind: 'selection', nodeIds: ['cup'] }).warnings).toContain('这次最多扣费生成 1 次；发出去没收到结果的不会自动重发')
  })

  it('explains the selection toolbar run entries in plain words', () => {
    const actions = selectionToolbarActions({ count: 1, canGroup: false, canUngroup: false, allLocked: false, canToggleDisabled: true, allDisabled: false, canSaveWorkshop: false, hasRunActions: true }, 'run')
    expect(actions.map((action) => action.section)).toEqual(['运行这个节点，连同要用到的上游节点', '运行这个节点和后面连着的节点，缺的上游一起运行'])
  })
})
