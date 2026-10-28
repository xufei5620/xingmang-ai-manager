import { describe, expect, it } from 'vitest'
import type { CanvasRunGraph } from '../host'
import { buildCanvasRunPreflight } from '../runtime/run-preflight'
import { matchingCanvasRunNodeIds } from '../runtime/run-input-matching'
import { assertVideoReferenceSlots, orderVideoReferences, parseNodeVideoReferenceOrder, parseVideoReferenceOrder, remapVideoReferenceOrderSettings } from './video-reference-order'
import { assertCanvasVideoInputCardinality, inspectCanvasVideoInputs } from './video-inputs'

function graph(): CanvasRunGraph {
  return { nodes: [
    { id: 'a', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } },
    { id: 'b', kind: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', adoptedAssetId: 'a'.repeat(43) } },
    { id: 'v', kind: 'video-generate', definitionVersion: 1, data: { prompt: 'A loop', model: 'minimax-h3-fast', group: 'provider', videoMode: 'fl2va', videoReferenceOrder: { version: 1, slots: [{ edgeId: 'last', outputIndex: 0 }, { edgeId: 'first', outputIndex: 0 }] } } },
  ], edges: ['a', 'b'].map((source, index) => ({ id: index ? 'last' : 'first', source, sourceHandle: 'out:image', target: 'v', targetHandle: 'in:images' })) }
}

describe('independent video reference slots', () => {
  it('retains repeated assets and sorts complete slots by stable edge identity', () => {
    const input = graph(), video = input.nodes[2], before = structuredClone(input)
    const count = inspectCanvasVideoInputs(video, input.edges, new Map(input.nodes.map((node) => [node.id, node])))
    expect(count).toMatchObject({ imageCount: 2, audioCount: 0, videoCount: 0, exact: true })
    expect(count.slots.map((slot) => slot.edgeId)).toEqual(['last', 'first'])
    expect(input).toEqual(before)
    const items = [{ edgeId: 'first', outputIndex: 0, assetId: 'same' }, { edgeId: 'last', outputIndex: 0, assetId: 'same' }]
    expect(orderVideoReferences(items, video.data.videoReferenceOrder)).toEqual([items[1], items[0]])
  })
  it('keeps legacy snapshots on their original deduplicated semantics', () => {
    const input = graph(); delete input.nodes[2].data.videoReferenceOrder
    expect(inspectCanvasVideoInputs(input.nodes[2], input.edges, new Map(input.nodes.map((node) => [node.id, node]))).imageCount).toBe(1)
  })
  it('counts a grid before its first execution and blocks unsupported expanded inputs in preflight', () => {
    const input = graph(); input.nodes[0] = { id: 'a', kind: 'image-grid-split', definitionVersion: 1, data: { prompt: '', model: '', imageTransform: { kind: 'grid-split', rows: 3, columns: 3, gap: 0, padding: 0 } } }
    input.edges = [{ ...input.edges[0], sourceHandle: 'out:images' }]
    input.nodes[2].data.videoReferenceOrder = { version: 1, slots: [] }
    input.nodes[2].data.model = 'grok-imagine-video'; input.nodes[2].data.videoMode = 'auto'
    const count = inspectCanvasVideoInputs(input.nodes[2], input.edges, new Map(input.nodes.map((node) => [node.id, node])))
    expect(count.imageCount).toBe(9)
    const preflight = buildCanvasRunPreflight({ graph: input, scope: { kind: 'all' }, imageModels: [], videoModels: ['grok-imagine-video'] })
    expect(preflight.items.find((item) => item.nodeId === 'v')).toMatchObject({ action: 'blocked', reasonCode: 'invalid-parameters' })
  })
  it('does not claim an unknown future batch has only one image', () => {
    const input = graph(); input.edges[0].sourceHandle = 'out:images'; input.nodes[2].data.videoReferenceOrder = { version: 1, slots: [] }
    const count = inspectCanvasVideoInputs(input.nodes[2], input.edges, new Map(input.nodes.map((node) => [node.id, node])))
    expect(count.exact).toBe(false)
    expect(() => assertCanvasVideoInputCardinality(count)).toThrow('尚未确认')
  })
  it('preserves both typed all-router images as independently reorderable video frame slots', () => {
    const input = graph(), video = input.nodes[2]
    input.nodes[1].data.adoptedAssetId = 'b'.repeat(43)
    input.nodes.push({ id: 'router', kind: 'router', definitionVersion: 1, data: { prompt: '', model: '', routerStrategy: { version: 1, strategy: 'all' }, adoptedAssetId: 'a'.repeat(43) } })
    input.edges = [
      { id: 'b-router', source: 'b', sourceHandle: 'out:image', target: 'router', targetHandle: 'in:images' },
      { id: 'a-router', source: 'a', sourceHandle: 'out:image', target: 'router', targetHandle: 'in:images' },
      { id: 'routed', source: 'router', sourceHandle: 'out:image', target: 'v', targetHandle: 'in:images' },
    ]
    video.data.videoReferenceOrder = { version: 1, slots: [{ edgeId: 'routed', outputIndex: 1 }, { edgeId: 'routed', outputIndex: 0 }] }
    const inspect = () => inspectCanvasVideoInputs(video, input.edges, new Map(input.nodes.map((node) => [node.id, node])))
    const result = inspect()
    expect(result).toMatchObject({ imageCount: 2, exact: true })
    expect(result.slots.map((slot) => slot.outputIndex)).toEqual([1, 0])
    expect(() => assertCanvasVideoInputCardinality(result)).not.toThrow()
    input.nodes[3].data.routerStrategy!.strategy = 'first-available'
    expect(inspect).toThrow('位置缺失')
    video.data.videoReferenceOrder = { version: 1, slots: [] }
    expect(inspect()).toMatchObject({ imageCount: 1, exact: true })
    input.nodes[3].data.routerStrategy!.strategy = 'all'; input.edges[0].sourceHandle = 'out:images'
    expect(inspect().exact).toBe(false)
  })
  it('blocks disappeared saved slots instead of promoting the last frame to first', () => {
    const input = graph(); input.edges.pop()
    expect(() => inspectCanvasVideoInputs(input.nodes[2], input.edges, new Map(input.nodes.map((node) => [node.id, node])))).toThrow('位置缺失')
    expect(() => assertVideoReferenceSlots([{ edgeId: 'last', outputIndex: 0 }], input.nodes[2].data.videoReferenceOrder)).toThrow('位置缺失')
  })
  it.each([{ version: 2, slots: [] }, { version: 1, slots: [], extra: true }, { version: 1, slots: [{ edgeId: 'a', outputIndex: 20 }] }, { version: 1, slots: [{ edgeId: 'a', outputIndex: 0, assetId: 'private' }] }, { version: 1, slots: [{ edgeId: 'a', outputIndex: 0 }, { edgeId: 'a', outputIndex: 0 }] }, { version: 1, slots: Array.from({ length: 13 }, (_, index) => ({ edgeId: String(index), outputIndex: 0 })) }])('rejects malformed or excessive order %#', (value) => {
    expect(() => parseVideoReferenceOrder(value)).toThrow()
  })
  it('requires a video node and remaps graph-local identities without preserving omitted edges', () => {
    expect(() => parseNodeVideoReferenceOrder('image-generate', { version: 1, slots: [] })).toThrow()
    const settings = { title: 'A', videoReferenceOrder: graph().nodes[2].data.videoReferenceOrder }
    expect(remapVideoReferenceOrderSettings(settings, new Map([['last', 'copy']]))).toEqual({ title: 'A', videoReferenceOrder: { version: 1, slots: [{ edgeId: 'copy', outputIndex: 0 }] } })
    expect(settings.videoReferenceOrder?.slots).toHaveLength(2)
  })
  it('rejects late projection after changing roles, deleting order or replacing a bound edge', () => {
    const before = graph(), after = structuredClone(before)
    after.nodes[2].data.videoReferenceOrder!.slots.reverse()
    expect(matchingCanvasRunNodeIds(before, after).has('v')).toBe(false)
    delete after.nodes[2].data.videoReferenceOrder
    expect(matchingCanvasRunNodeIds(before, after).has('v')).toBe(false)
    after.nodes[2].data.videoReferenceOrder = structuredClone(before.nodes[2].data.videoReferenceOrder)
    after.edges[0].id = 'reconnected'
    expect(matchingCanvasRunNodeIds(before, after).has('v')).toBe(false)
  })
})
