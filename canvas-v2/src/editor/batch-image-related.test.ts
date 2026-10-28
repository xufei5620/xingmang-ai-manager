import { describe, expect, it } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorNodeRecord } from '../domain/node-definition'
import { parseImageTransformRecipe } from '../image-tools/recipe'
import { resolveImageCompareView } from '../image-tools/viewer-settings'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { analyzeBatchImageRelatedSources, batchImageRelatedConfig, batchImageRelatedOptions, buildBatchImageRelatedCommand } from './batch-image-related'
import { canvasContextNodeIds } from './context-menu-scope'

function node(id: string, x = 0, y = 0, type = 'image-input'): EditorNodeRecord { return builtinNodeRegistry.create(type, id, { x, y }) }
function target(type = 'image-collage', count = 2): EditorNodeRecord { return { ...node('new', 1000, 0, type), data: { prompt: '', settings: batchImageRelatedConfig(type as 'image-collage', count) } } }

describe('batch image related creation', () => {
  it('sorts visible world positions across parents with stable id ties, not array or selection order', () => {
    const group = { ...node('group', 100, 200, 'group'), locked: true }
    const a = { ...node('a', 20, 30), parentId: group.id, locked: true, data: { settings: { title: 'A 图片' } } }
    const b = node('b', 120, 230), c = node('c', 500, 10)
    const before = structuredClone([group, b, a, c])
    const analysis = analyzeBatchImageRelatedSources(before, ['b', 'a', 'c'])
    expect(analysis.disabledReason).toBeUndefined()
    expect(analysis.sources.map((source) => source.id)).toEqual(['c', 'a', 'b'])
    expect(analysis.sources[1]).toMatchObject({ title: 'A 图片', position: { x: 120, y: 230 } })
    expect(before).toEqual([group, b, a, c])
  })

  it.each(['group', 'prompt', 'video-input', 'unknown'])('rejects a mixed %s selection without dropping it', (type) => {
    const analysis = analyzeBatchImageRelatedSources([node('a'), node('b', 0, 0, type)], ['a', 'b'])
    expect(analysis.disabledReason).toBeTruthy()
    expect(analysis.sources).toEqual([])
  })

  it('rejects missing nodes, duplicate ids, cycles and invalid geometry before making a command', () => {
    const a = node('a'), b = node('b')
    for (const [nodes, ids] of [[[a, b], ['a', 'missing']], [[a, b], ['a', 'a']], [[a, a, b], ['a', 'b']], [[a, { ...b, position: { x: Infinity, y: 0 } }], ['a', 'b']], [[a, { ...b, parentId: 'g' }, { ...node('g', 0, 0, 'group'), parentId: 'g' }], ['a', 'b']]] as const) expect(analyzeBatchImageRelatedSources(nodes, ids).disabledReason).toBeTruthy()
  })

  it('uses the existing right-click selection convention without expanding groups', () => {
    const nodes = [{ ...node('a'), selected: true }, { ...node('b'), selected: true }, node('other')]
    expect(canvasContextNodeIds(nodes, 'a')).toEqual(['a', 'b'])
    expect(canvasContextNodeIds(nodes, 'other')).toEqual(['other'])
    expect(analyzeBatchImageRelatedSources(nodes, canvasContextNodeIds(nodes, 'other')).disabledReason).toContain('2–20')
  })

  it('keeps single-image ports explicit for gallery and grid, including disabled sources', () => {
    const nodes = [{ ...node('grid', 0, 0, 'image-grid-split'), disabled: true }, node('gallery', 0, 100, 'gallery')]
    const sources = analyzeBatchImageRelatedSources(nodes, ['gallery', 'grid']).sources
    expect(sources[0]).toMatchObject({ id: 'grid', disabled: true, outputLabel: '当前切片（不含全部切片）' })
    expect(sources[1].outputLabel).toContain('不含全部候选')
    const command = buildBatchImageRelatedCommand({ nodes, edges: [], sources, target: target(), edgeIds: ['e1', 'e2'] })
    expect(command.edges?.map((edge) => [edge.source, edge.sourceHandle])).toEqual([['grid', 'out:image'], ['gallery', 'out:image']])
    expect(nodes[0].disabled).toBe(true)
  })

  it('sizes every supported collage grid and explicitly limits each target', () => {
    for (let count = 2; count <= 16; count++) {
      const recipe = parseImageTransformRecipe(batchImageRelatedConfig('image-collage', count).imageTransform)
      if (recipe.kind !== 'collage') throw new Error('Expected collage')
      expect(recipe.rows * recipe.columns).toBeGreaterThanOrEqual(count)
      expect(recipe.rows).toBeLessThanOrEqual(4)
      expect(recipe.columns).toBeLessThanOrEqual(4)
    }
    expect(batchImageRelatedOptions(20).map((option) => Boolean(option.disabledReason))).toEqual([true, true, false, false])
    expect(() => batchImageRelatedConfig('image-compare', 5)).toThrow('2–4')
    expect(() => batchImageRelatedConfig('image-collage', 17)).toThrow('16')
    expect(() => batchImageRelatedConfig('image-layer', 21)).toThrow('2–20')
  })

  it('connects the complete tile pool through the retained input handle without starting a run', () => {
    const nodes = [node('a'), node('b', 0, 400)]
    const command = buildBatchImageRelatedCommand({ nodes, edges: [], sources: analyzeBatchImageRelatedSources(nodes, ['a', 'b']).sources, target: target('image-tile'), edgeIds: ['tile-a', 'tile-b'] })
    expect(command.edges).toEqual([
      { id: 'tile-a', source: 'a', sourceHandle: 'out:image', target: 'new', targetHandle: 'in:image' },
      { id: 'tile-b', source: 'b', sourceHandle: 'out:image', target: 'new', targetHandle: 'in:image' },
    ])
    expect(command.nodes[0].data.settings).toMatchObject({ imageTransform: { kind: 'tile' } })
    expect(builtinNodeRegistry.require('image-tile').ports.find((port) => port.id === 'in:image')?.cardinality).toBe('many')
  })

  it.each([2, 3, 4])('binds %s compare slots to the new ordered edges', (count) => {
    const nodes = Array.from({ length: count }, (_, index) => node(`n${index}`, index * 300))
    const sources = analyzeBatchImageRelatedSources(nodes, nodes.map((node) => node.id)).sources
    const command = buildBatchImageRelatedCommand({ nodes, edges: [], sources, target: target('image-compare', count), edgeIds: sources.map((source) => `e-${source.id}`) })
    const settings = command.nodes[0].data.settings as Record<string, unknown>
    const slots = command.edges!.map((edge) => JSON.stringify([edge.id, 0]))
    expect(resolveImageCompareView(settings.imageCompare, slots)).toMatchObject({ mode: count === 2 ? 'slider' : count === 3 ? 'side-by-side' : 'grid', a: '0', b: '1' })
    const reversed = resolveImageCompareView(settings.imageCompare, [...slots].reverse())
    expect(count === 4 ? reversed.grid[0] : reversed.a).toBe(String(count - 1))
  })

  it('commits the target and all ordered edges once and restores the exact graph with one undo', () => {
    const nodes = [node('a'), node('b', 0, 400), node('unselected')]
    const edges = [{ id: 'old', source: 'a', sourceHandle: 'out:image', target: 'b', targetHandle: 'in:image' }]
    const initial = createCanvasHistory({ ...createCanvasDocument(), nodes, edges })
    const sources = analyzeBatchImageRelatedSources(nodes, ['b', 'a']).sources
    const command = buildBatchImageRelatedCommand({ nodes, edges, sources, target: target(), edgeIds: ['e1', 'e2'] })
    const next = applyCanvasCommand(initial, command)
    expect(next.present.nodes).toHaveLength(4)
    expect(next.present.edges).toHaveLength(3)
    expect(next.present.nodes.slice(0, 3)).toEqual(nodes)
    const undone = undoCanvasHistory(next)
    expect(undone.present).toEqual(initial.present)
    expect(redoCanvasHistory(undone).present).toEqual(next.present)
  })

  it('preserves the displayed source order after movement but rejects a deleted or retyped source atomically', () => {
    const nodes = [node('a'), node('b', 0, 400)]
    const sources = analyzeBatchImageRelatedSources(nodes, ['b', 'a']).sources
    const moved = [node('a', 0, 800), nodes[1]]
    expect(buildBatchImageRelatedCommand({ nodes: moved, edges: [], sources, target: target(), edgeIds: ['e1', 'e2'] }).edges?.map((edge) => edge.source)).toEqual(['a', 'b'])
    expect(() => buildBatchImageRelatedCommand({ nodes: [nodes[0]], edges: [], sources, target: target(), edgeIds: ['e1', 'e2'] })).toThrow('已发生变化')
    expect(() => buildBatchImageRelatedCommand({ nodes: [nodes[0], node('b', 0, 400, 'image-crop')], edges: [], sources, target: target(), edgeIds: ['e1', 'e2'] })).toThrow('类型已发生变化')
    expect(() => buildBatchImageRelatedCommand({ nodes, edges: [], sources, target: target(), edgeIds: ['same', 'same'] })).toThrow('标识无效')
  })
})
