import { describe, expect, it } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { connectionForInsertedNode, isValidWorkflowConnection } from '../ports'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, undoCanvasHistory } from '../store/history'
import { relatedNodeOptions } from './related-nodes'

describe('explicit related-node image output choices', () => {
  it('offers separate current-slice and whole-batch connections with unique action ids', () => {
    const nodes = [builtinNodeRegistry.create('image-grid-split', 'grid', { x: 0, y: 0 })]
    const options = relatedNodeOptions('grid', nodes, [])
    for (const kind of ['image-collage', 'image-layer', 'image-compare', 'image-tile']) {
      const choices = options.filter((option) => option.type === kind)
      expect(choices.map((option) => option.pending.handleId)).toEqual(['out:image', 'out:images'])
      expect(choices[0].label).toContain('当前切片')
      expect(choices[1].label).toContain('全部切片')
      expect(new Set(choices.map((option) => option.id)).size).toBe(2)
    }
    expect(new Set(options.map((option) => option.id)).size).toBe(options.length)
  })

  it('does not offer a whole batch to single-image inputs', () => {
    const nodes = [builtinNodeRegistry.create('image-grid-split', 'grid', { x: 0, y: 0 })]
    for (const kind of ['image-crop', 'image-grid-split', 'image-panorama']) {
      const options = relatedNodeOptions('grid', nodes, []).filter((option) => option.type === kind)
      expect(options).toHaveLength(1)
      expect(options[0].pending.handleId).toBe('out:image')
    }
  })

  it('keeps normal single-output labels and right-click source identity', () => {
    const nodes = [builtinNodeRegistry.create('prompt', 'selected', { x: 0, y: 0 }), builtinNodeRegistry.create('image-input', 'target', { x: 0, y: 0 })]
    const option = relatedNodeOptions('target', nodes, []).find((entry) => entry.type === 'image-collage')!
    expect(option.label).toBe('拼图')
    expect(option.pending).toEqual({ nodeId: 'target', handleId: 'out:image', handleType: 'source' })
    const gallery = builtinNodeRegistry.create('gallery', 'gallery', { x: 0, y: 0 })
    const legacy = relatedNodeOptions(gallery.id, [gallery], [])
    expect(new Set(legacy.map((entry) => entry.type)).size).toBe(legacy.length)
  })

  it('creates the selected batch connection as one undoable transaction', () => {
    const source = builtinNodeRegistry.create('image-grid-split', 'grid', { x: 0, y: 0 })
    const options = relatedNodeOptions(source.id, [source], [])
    const actionId = options.find((entry) => entry.type === 'image-collage' && entry.pending.handleId === 'out:images')!.id
    const option = options.find((entry) => entry.id === actionId)!
    const target = builtinNodeRegistry.create(option.type, 'target', { x: 500, y: 0 })
    const connection = connectionForInsertedNode(option.pending, target.id, option.inputHandle)
    expect(isValidWorkflowConnection(connection, { nodeKindOf: (id) => id === 'grid' ? source.type : target.type, edges: [] })).toBe(true)
    const before = createCanvasHistory({ ...createCanvasDocument(), nodes: [source] })
    const after = applyCanvasCommand(before, { type: 'add-nodes', nodes: [target], edges: [{ id: 'edge', source: source.id, sourceHandle: connection.sourceHandle!, target: target.id, targetHandle: connection.targetHandle! }] })
    expect(after.present.edges[0].sourceHandle).toBe('out:images')
    expect(undoCanvasHistory(after).present).toEqual(before.present)
  })
})
