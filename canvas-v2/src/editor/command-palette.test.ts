import { describe, expect, it } from 'vitest'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { maximumExistingNodeResults, searchExistingCanvasNodes } from './command-palette'

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

  it('does not index unbounded prompt tails', () => {
    expect(searchExistingCanvasNodes([node('long', `${'a'.repeat(300)}tail-secret`)], 'tail-secret')).toEqual([])
  })

  it('bounds results for very large canvases and returns nothing for an empty query', () => {
    const nodes = Array.from({ length: 5_000 }, (_, index) => node(`node-${index}`, 'shared prompt'))
    expect(searchExistingCanvasNodes(nodes, '')).toEqual([])
    expect(searchExistingCanvasNodes(nodes, 'shared')).toHaveLength(maximumExistingNodeResults)
  })
})
