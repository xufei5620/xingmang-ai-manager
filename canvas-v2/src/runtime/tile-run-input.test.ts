import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph, CanvasRunScope } from '../host'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { assertCanvasTileInput } from './tile-run-input'
import { buildCanvasRunPreflight, selectCanvasRunNodeIds } from './run-preflight'
import { matchingCanvasRunNodeIds } from './run-input-matching'

function graph(): CanvasRunGraph {
  return { nodes: [
    { id: 'paid', kind: 'image-generate', definitionVersion: 1, data: { prompt: 'image', model: 'image-model', group: 'provider-a' } },
    { id: 'local', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } },
    { id: 'tile', kind: 'image-tile', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: defaultImageTransformRecipe('tile'), tileInput: { edgeId: 'chosen' } } },
    { id: 'output', kind: 'output', definitionVersion: 1, data: { prompt: '', model: '' } },
  ], edges: [
    { id: 'paid-edge', source: 'paid', sourceHandle: 'out:image', target: 'tile', targetHandle: 'in:image' },
    { id: 'chosen', source: 'local', sourceHandle: 'out:image', target: 'tile', targetHandle: 'in:image' },
    { id: 'output-edge', source: 'tile', sourceHandle: 'out:image', target: 'output', targetHandle: 'in:image' },
  ] }
}
function check(input = graph(), scope: CanvasRunScope = { kind: 'to-node', nodeId: 'tile' }) {
  return buildCanvasRunPreflight({ graph: input, scope, imageModels: ['image-model'], videoModels: [] })
}

describe('tile effective dependency selection', () => {
  it.each([{ kind: 'selection', nodeIds: ['tile'] }, { kind: 'to-node', nodeId: 'tile' }] satisfies CanvasRunScope[])('excludes unselected paid ancestors for $kind and shows them for explicit all', (scope) => {
    const result = check(graph(), scope)
    expect(result.selectedNodeIds.sort()).toEqual(['local', 'tile'])
    expect(result).toMatchObject({ canStart: true, paidRequestCount: 0 })
    expect(check(graph(), { kind: 'all' })).toMatchObject({ canStart: true, paidRequestCount: 1 })
  })
  it('does not pull a tile into an unselected upstream from-node run', () => {
    expect([...selectCanvasRunNodeIds(graph(), { kind: 'from-node', nodeId: 'paid' })]).toEqual(['paid'])
    expect([...selectCanvasRunNodeIds(graph(), { kind: 'from-node', nodeId: 'local' })].sort()).toEqual(['local', 'output', 'tile'])
  })
  it('defaults to the first stable edge and never falls back from a missing explicit choice', () => {
    const input = graph(); delete input.nodes[2].data.tileInput
    expect(check(input)).toMatchObject({ canStart: true, paidRequestCount: 1 })
    for (const selection of [{ missing: true as const }, { edgeId: 'removed' }]) {
      input.nodes[2].data.tileInput = selection
      expect(check(input)).toMatchObject({ canStart: false, paidRequestCount: 0 })
      expect(check(input).items.find((item) => item.nodeId === 'tile')).toMatchObject({ reasonCode: 'invalid-parameters' })
    }
  })
  it('skips only a selected disabled ancestor', () => {
    const input = graph(); input.nodes[0].disabled = true
    expect(check(input).items.find((item) => item.nodeId === 'tile')?.action).toBe('execute')
    input.nodes[1].disabled = true
    expect(check(input).items.find((item) => item.nodeId === 'tile')).toMatchObject({ action: 'skip', reasonCode: 'upstream-skip' })
  })
  it('limits source connections without treating the selectable pool as processed batch inputs', () => {
    const input = graph()
    input.nodes[0] = { ...input.nodes[1], id: 'paid', kind: 'image-grid-split', data: { prompt: '', model: '', imageTransform: { kind: 'grid-split', rows: 4, columns: 4, gap: 0, padding: 0 } } }
    input.edges[0].sourceHandle = 'out:images'
    input.edges.push({ ...input.edges[0], id: 'another-batch' })
    expect(check(input)).toMatchObject({ canStart: true, paidRequestCount: 0 })
    input.edges.push(...Array.from({ length: 18 }, (_, index) => ({ ...input.edges[0], id: `extra-${index}` })))
    expect(check(input).items.find((item) => item.nodeId === 'tile')?.reason).toContain('20')
  })
  it('checks the exact selected batch slot and never trusts a candidate array as batch evidence', () => {
    const input = graph(), tile = input.nodes[2], source = input.nodes[1]
    const assert = () => assertCanvasTileInput(tile, input.edges, new Map(input.nodes.map((node) => [node.id, node])))
    tile.data.tileInput = { edgeId: 'chosen', outputIndex: 1 }
    expect(assert).toThrow('单图来源')
    input.edges[1].sourceHandle = 'out:images'; source.kind = 'image-grid-split'
    source.data.imageTransform = { kind: 'grid-split', rows: 1, columns: 2, gap: 0, padding: 0 }
    expect(assert().outputIndex).toBe(1)
    tile.data.tileInput = { edgeId: 'chosen', outputIndex: 2 }
    expect(assert).toThrow('当前批次')
    source.kind = 'frame-extract'
    expect(assert).toThrow('有效图片连接')
  })
  it('selects the second typed all-router image and rejects first, legacy or unknown batch claims', () => {
    const input = graph(), source = input.nodes[1], tile = input.nodes[2]
    input.nodes[0].kind = 'image-input'; input.nodes[0].data = { prompt: '', model: '', adoptedAssetId: 'b'.repeat(43) }
    source.kind = 'router'; source.data = { prompt: '', model: '', routerStrategy: { version: 1, strategy: 'all' } }
    input.nodes.push({ id: 'other', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } })
    input.edges.push({ id: 'first-input', source: 'paid', sourceHandle: 'out:image', target: 'local', targetHandle: 'in:images' }, { id: 'second-input', source: 'other', sourceHandle: 'out:image', target: 'local', targetHandle: 'in:images' })
    tile.data.tileInput = { edgeId: 'chosen', outputIndex: 1 }
    const inspect = () => assertCanvasTileInput(tile, input.edges, new Map(input.nodes.map((node) => [node.id, node])))
    expect(inspect().outputIndex).toBe(1)
    source.data.routerStrategy!.strategy = 'first-available'
    expect(inspect).toThrow('当前输出')
    delete source.data.routerStrategy
    expect(inspect).toThrow('单图来源')
    source.data.routerStrategy = { version: 1, strategy: 'all' }
    input.edges.find((edge) => edge.id === 'first-input')!.sourceHandle = 'out:images'
    expect(inspect).toThrow('尚无法确认')
  })
})

describe('tile late result matching', () => {
  it('ignores unselected upstream edits but invalidates selected sources and downstream outputs', () => {
    const submitted = graph(), current = structuredClone(submitted)
    current.nodes[0].data.prompt = 'different paid request'
    expect(matchingCanvasRunNodeIds(submitted, current).has('tile')).toBe(true)
    current.nodes[1].data.adoptedAssetId = 'b'.repeat(43)
    expect([...matchingCanvasRunNodeIds(submitted, current)]).toEqual([])
  })
  it.each(['edge', 'slot', 'missing', 'delete'] as const)('rejects old results after a tile %s change', (kind) => {
    const submitted = graph(), current = structuredClone(submitted)
    if (kind === 'edge') current.nodes[2].data.tileInput = { edgeId: 'paid-edge' }
    if (kind === 'slot') current.nodes[2].data.tileInput = { edgeId: 'chosen', outputIndex: 1 }
    if (kind === 'missing') current.nodes[2].data.tileInput = { missing: true }
    if (kind === 'delete') current.edges.splice(1, 1)
    expect(matchingCanvasRunNodeIds(submitted, current).has('tile')).toBe(false)
    expect(matchingCanvasRunNodeIds(submitted, current).has('output')).toBe(false)
  })
  it('accepts reordered explicit pools but invalidates a different implicit first choice', () => {
    const submitted = graph(), current = structuredClone(submitted)
    current.edges.reverse()
    expect(matchingCanvasRunNodeIds(submitted, current).has('tile')).toBe(true)
    delete submitted.nodes[2].data.tileInput; delete current.nodes[2].data.tileInput
    expect(matchingCanvasRunNodeIds(submitted, current).has('tile')).toBe(false)
  })
})
