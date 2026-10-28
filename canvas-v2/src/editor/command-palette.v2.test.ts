// 桌面 v2 编辑器的用例（桌面 000f9131 的 canvas-v2/src/editor/command-palette.test.ts），#4 搬进内核。
// 内核有意和 v2 不一样的地方，期望改成内核的行为或退役，改动处写了为什么，汇总见 docs/canvas-kernel-v2-tests.md。
import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { searchExistingCanvasNodes } from './command-palette'

function node(id: string, prompt = '', model = ''): CanvasNode {
  return {
    id, type: 'image-generate', definitionVersion: 1, position: { x: 0, y: 0 },
    data: { prompt, model, status: 'idle' },
  }
}

describe('searchExistingCanvasNodes', () => {
  it('prefers exact identifiers and searches model and prompt summaries', () => {
    const nodes = [node('hero', '产品主视觉', 'gpt-image-2'), node('other', 'hero in prompt')]
    expect(searchExistingCanvasNodes(nodes, 'hero').map((result) => result.id)).toEqual(['hero', 'other'])
    expect(searchExistingCanvasNodes(nodes, '主视觉')[0]?.id).toBe('hero')
    expect(searchExistingCanvasNodes(nodes, 'gpt-image-2')[0]?.id).toBe('hero')
  })

  // 'does not index unbounded prompt tails' 退役：内核搜整段提示词，结果里给命中处的摘录。
  // 'bounds results for very large canvases…' 改成只核对空查询：内核不在这里截条数，由快速插入面板分页显示。
  it('returns nothing for an empty query on a very large canvas', () => {
    const nodes = Array.from({ length: 5_000 }, (_, index) => node(`node-${index}`, 'shared prompt'))
    expect(searchExistingCanvasNodes(nodes, '')).toEqual([])
  })
})
