import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { canvasGenerationImageInputCardinality, canvasGenerationImageInputError } from './image-input-cardinality'
import { buildCanvasRunPreflight } from './run-preflight'

function graph(): CanvasRunGraph {
  return { nodes: [
    { id: 'input', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } },
    { id: 'grid', kind: 'image-grid-split', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: { ...defaultImageTransformRecipe('grid-split'), kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } } },
    { id: 'image', kind: 'image-generate', definitionVersion: 1, data: { prompt: '测试', model: 'custom-image', group: 'source' } },
  ], edges: [
    { id: 'input-grid', source: 'input', target: 'grid', sourceHandle: 'out:image', targetHandle: 'in:image' },
    { id: 'grid-image', source: 'grid', target: 'image', sourceHandle: 'out:images', targetHandle: 'in:images' },
  ] }
}

describe('generation input expansion and deduplication', () => {
  it('blocks a never-run nine-cell grid before presenting a paid confirmation', () => {
    const result = buildCanvasRunPreflight({ graph: graph(), scope: { kind: 'all' }, imageModels: ['custom-image'], videoModels: [] })
    expect(result.canStart).toBe(false)
    expect(result.paidRequestCount).toBe(0)
    expect(result.items.find((item) => item.nodeId === 'image')).toMatchObject({ action: 'blocked', reason: expect.stringContaining('整组展开后有 9 张') })
  })
  it('deduplicates the selected grid slot when the same grid batch is connected', () => {
    const current = graph(); current.nodes[1].data.imageOutputIndex = 2
    const recipe = current.nodes[1].data.imageTransform!
    if (recipe.kind !== 'grid-split') throw new Error('fixture')
    recipe.rows = 2; recipe.columns = 2
    const sources = [current.edges[1], { ...current.edges[1], sourceHandle: 'out:image' }, current.edges[1]]
    const count = canvasGenerationImageInputCardinality(sources, new Map(current.nodes.map((node) => [node.id, node])))
    expect(count).toMatchObject({ connections: 3, minimum: 4, exact: true })
    expect(canvasGenerationImageInputError('image-generate', count)).toBeNull()
  })
  it('merges five input nodes pointing at one owned image while retaining distinct assets', () => {
    const current = graph()
    const inputs = Array.from({ length: 5 }, (_, index) => ({ ...current.nodes[0], id: `source-${index}` }))
    const sources = inputs.map((node) => ({ source: node.id, sourceHandle: 'out:image' }))
    expect(canvasGenerationImageInputCardinality(sources, new Map(inputs.map((node) => [node.id, node]))).minimum).toBe(1)
    const unique = inputs.map((node, index) => ({ ...node, data: { ...node.data, adoptedAssetId: String(index).repeat(43) } }))
    expect(canvasGenerationImageInputError('image-generate', canvasGenerationImageInputCardinality(sources, new Map(unique.map((node) => [node.id, node]))))).toContain('去重后有 5 张')
  })
  it('marks unknown batches as a lower bound and keeps runtime validation responsible', () => {
    const current = graph(); current.nodes[1].kind = 'gallery'
    const count = canvasGenerationImageInputCardinality([current.edges[1]], new Map(current.nodes.map((node) => [node.id, node])))
    expect(count).toMatchObject({ minimum: 1, exact: false, hasBatch: true })
    expect(canvasGenerationImageInputError('image-generate', count)).toBeNull()
    expect(canvasGenerationImageInputError('image-edit', { ...count, connections: 0 })).toContain('至少一条')
  })
})
