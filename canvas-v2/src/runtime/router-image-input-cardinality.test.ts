import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { defaultImageTransformRecipe, type ImageLayerRecipe } from '../image-tools/recipe'
import { imageCollageTemplates } from '../image-tools/collage-templates'
import { canvasGenerationImageInputCardinality, canvasGenerationImageInputError, canvasImageInputCardinality, canvasImageTransformInputErrors } from './image-input-cardinality'
import { buildCanvasRunPreflight } from './run-preflight'

type Node = CanvasRunGraph['nodes'][number]
function asset(id: string, value = id): Node { return { id, kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: value.repeat(43).slice(0, 43) } } }
function router(id: string, strategy: 'all' | 'first-available' = 'all'): Node { return { id, kind: 'router', definitionVersion: 1, data: { prompt: '', model: '', routerStrategy: { version: 1, strategy } } } }
function edge(source: string, target: string, sourceHandle = 'out:image', id = `${source}-${target}`) { return { id, source, sourceHandle, target, targetHandle: 'in:images' } }
function graph(count = 2): CanvasRunGraph { return { nodes: [...Array.from({ length: count }, (_, i) => asset(`s${i}`, String(i))), router('route')], edges: Array.from({ length: count }, (_, i) => edge(`s${i}`, 'route')) } }
function inspect(g: CanvasRunGraph, generation = false, sources = [edge('route', 'target')]) { return (generation ? canvasGenerationImageInputCardinality : canvasImageInputCardinality)(sources, new Map(g.nodes.map(n => [n.id, n])), g.edges) }

describe('actual routed image multiplicity in structural preparation', () => {
  it('expands known all-router output and admits exact two-image collage and source-index one layer', () => {
    const g = graph(), count = inspect(g)
    expect(count).toMatchObject({ connections: 1, minimum: 2, exact: true, hasBatch: true })
    const collage = defaultImageTransformRecipe('collage'); if (collage.kind !== 'collage') throw new Error('fixture')
    const layout = imageCollageTemplates.find(item => item.inputCount === 2)!.layout
    expect(canvasImageTransformInputErrors({ ...collage, layout }, count)).toEqual([])
    const layer = defaultImageTransformRecipe('layer') as ImageLayerRecipe
    layer.layers = [{ sourceIndex: 1, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over', visible: true }]
    expect(canvasImageTransformInputErrors(layer, count)).toEqual([])
    const target: Node = { id: 'target', kind: 'image-collage', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: { ...collage, layout } } }
    const submitted = { nodes: [...g.nodes, target], edges: [...g.edges, edge('route', 'target')] }
    expect(buildCanvasRunPreflight({ graph: submitted, scope: { kind: 'all' }, imageModels: [], videoModels: [] }).canStart).toBe(true)
  })
  it('preserves transform input positions but deduplicates generation and the router own normalized pool by image identity', () => {
    const g = graph(), sources = [edge('route', 'target', 'out:image', 'one'), edge('route', 'target', 'out:image', 'two')]
    expect(inspect(g, false, sources).minimum).toBe(4)
    expect(inspect(g, true, sources).minimum).toBe(2)
    g.nodes[1].data.adoptedAssetId = g.nodes[0].data.adoptedAssetId
    expect(inspect(g).minimum).toBe(1)
    expect(inspect(g, true).minimum).toBe(1)
  })
  it('rejects six distinct routed references before describing a supported image request', () => {
    const count = inspect(graph(6), true)
    expect(count).toMatchObject({ minimum: 6, exact: true })
    expect(canvasGenerationImageInputError('image-generate', count)).toContain('6 张')
  })
  it('recursively follows nested all and first routers without using adopted output previews', () => {
    const g = graph(); g.nodes.push(router('outer')); g.edges.push(edge('route', 'outer')); g.nodes.find(n => n.id === 'route')!.data.adoptedAssetId = 'x'.repeat(43)
    expect(inspect(g, false, [edge('outer', 'target')]).minimum).toBe(2)
    g.nodes.find(n => n.id === 'route')!.data.routerStrategy!.strategy = 'first-available'
    expect(inspect(g, false, [edge('outer', 'target')])).toMatchObject({ minimum: 1, exact: true, hasBatch: false })
    delete g.nodes.find(n => n.id === 'route')!.data.routerStrategy
    expect(inspect(g, false, [edge('outer', 'target')]).minimum).toBe(1)
  })
  it('keeps an unresolved batch a lower bound while an explicit first selection remains at most one', () => {
    const g: CanvasRunGraph = { nodes: [{ id: 'batch', kind: 'gallery', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'z'.repeat(43) } }, router('route')], edges: [edge('batch', 'route', 'out:images')] }
    expect(inspect(g)).toMatchObject({ minimum: 1, exact: false, hasBatch: true })
    g.nodes[1].data.routerStrategy!.strategy = 'first-available'
    expect(inspect(g)).toMatchObject({ minimum: 1, exact: true, hasBatch: false })
  })
  it('retains the known lower bound through nested uncertain routers without double counting a possibly aliased batch', () => {
    const g = graph(6)
    g.nodes.push({ id: 'batch', kind: 'gallery', definitionVersion: 1, data: { prompt: '', model: '' } }, router('outer'))
    g.edges.push(edge('batch', 'route', 'out:images'), edge('route', 'outer'))
    const selected = [edge('outer', 'target')]
    expect(inspect(g, false, selected)).toMatchObject({ minimum: 6, exact: false })
    expect(inspect(g, true, selected)).toMatchObject({ minimum: 6, exact: false })
    expect(canvasGenerationImageInputError('image-generate', inspect(g, true, selected))).toContain('至少有 6 张')
  })
  it('does not claim exact one when a marked all-router boundary has no available input context', () => {
    const n = router('route')
    expect(canvasImageInputCardinality([edge('route', 'target')], new Map([[n.id, n]]))).toMatchObject({ minimum: 1, exact: false })
  })
  it.each([{ version: 2, strategy: 'all' }, { version: 1, strategy: 'future' }, null])('refuses unsupported saved routing %j instead of guessing cardinality', value => {
    const g = graph(); Object.assign(g.nodes[2].data, { routerStrategy: value })
    expect(() => inspect(g)).toThrow('路由')
  })
  it('refuses a reachable routing cycle and handles a long bounded chain without recursive stack growth', () => {
    const g = graph(1)
    let previous = 'route'
    for (let index = 0; index < 250; index++) { const id = `nested-${index}`; g.nodes.push(router(id)); g.edges.push(edge(previous, id)); previous = id }
    expect(inspect(g, false, [edge(previous, 'target')]).minimum).toBe(1)
    g.edges.push(edge(previous, 'route'))
    expect(() => inspect(g, false, [edge(previous, 'target')])).toThrow('循环')
  })
})
