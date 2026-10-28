import { describe, expect, it } from 'vitest'
import { canvasContextNodeIds } from './context-menu-scope'
import { buildCanvasClipboardPayload } from './clipboard'

describe('context menu targets', () => {
  const nodes = [
    { id: 'a', selected: true, type: 'prompt', definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: 'A' } },
    { id: 'b', selected: false, type: 'prompt', definitionVersion: 1, position: { x: 300, y: 0 }, data: { prompt: 'B' } },
    { id: 'c', selected: true, type: 'prompt', definitionVersion: 1, position: { x: 600, y: 0 }, data: { prompt: 'C' } },
  ]

  it('copies the unselected target rather than the existing selection', () => {
    const targets = canvasContextNodeIds(nodes, 'b')
    const copied = buildCanvasClipboardPayload(nodes, [], new Set(targets))
    expect(copied.nodes.map((node) => node.id)).toEqual(['b'])
    expect(copied.nodes[0].data.prompt).toBe('B')
    expect(nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(['a', 'c'])
  })

  it('retains a selected multi-node scope after subsequent selection changes', () => {
    const targets = canvasContextNodeIds(nodes, 'a')
    const changed = nodes.map((node) => ({ ...node, selected: node.id === 'b' }))
    expect(buildCanvasClipboardPayload(changed, [], new Set(targets)).nodes.map((node) => node.id)).toEqual(['a', 'c'])
  })

  it('does not select anything for a pane or removed node', () => {
    expect(canvasContextNodeIds(nodes, null)).toEqual([])
    expect(canvasContextNodeIds(nodes, 'removed')).toEqual([])
  })
})
