import { describe, expect, it } from 'vitest'
import { maximumProjectEdges, maximumProjectNodes } from '../lib/canvas-limits'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { buildCanvasClipboardPayload, pasteCanvasClipboard } from '../editor/clipboard'
import { instantiateWorkshopGraph } from '../editor/workshop-graph'
import { orderCollageInputs, parseImageCollageInputOrder } from '../image-tools/collage-input-order'
import { imageCollageInputCountError, parseImageTransformRecipe } from '../image-tools/recipe'
import { parseWorkflowFile, serializeWorkflow } from '../persistence/workflow-serializer'
import { maximumCoordinateMagnitude } from '../persistence/workflow-schema'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { assertFrameSequenceSource, buildFrameSequenceGraph, captureFrameSequenceSource, evenlySpacedFrameSequence, parseFrameSequenceTimestamps, validateFrameSequenceTimestamps, type FrameSequenceNode } from './frame-sequence'

const videoId = 'v'.repeat(43)
const metadata = { width: 320, height: 180, duration: 2 }
function source(type = 'video-input'): EditorNodeRecord {
  return { ...builtinNodeRegistry.create(type, 'video', { x: 100, y: 200 }), data: { prompt: '', model: '', status: 'succeeded', dirty: false, result: { kind: 'video', assetId: videoId } } }
}
function ids(): () => string { let serial = 0; return () => `new-${++serial}` }
function build(nodes: FrameSequenceNode[] = [source()], edges: EditorEdgeRecord[] = [], times = [0, 1, 1.9], dimensions = metadata) {
  return buildFrameSequenceGraph(nodes, edges, captureFrameSequenceSource(nodes, 'video'), times, dimensions, ids())
}
function settings(node: EditorNodeRecord): Record<string, unknown> {
  if (!node.data.settings || typeof node.data.settings !== 'object' || Array.isArray(node.data.settings)) throw new Error('Expected settings')
  return node.data.settings as Record<string, unknown>
}

describe('frame sequence time planning', () => {
  it('accepts decimal seconds with common separators without silently changing the order', () => {
    expect(parseFrameSequenceTimestamps('0, .25，0.5;1；1.25\n1.9', 2)).toEqual([0, .25, .5, 1, 1.25, 1.9])
    const original = [0, .25, 1.999]
    expect(validateFrameSequenceTimestamps(original, 2)).toEqual(original)
    expect(validateFrameSequenceTimestamps(original, 2)).not.toBe(original)
    expect(Object.is(validateFrameSequenceTimestamps([-0, 1], 2)[0], -0)).toBe(false)
  })
  it.each(['0, 0', '1, .5', '0, 2', '-1, 0', '0, NaN', '0, Infinity', '0, 1e-2', '0, 1:20', '0', ''])('rejects invalid or ambiguous lists %s', (input) => {
    expect(() => parseFrameSequenceTimestamps(input, 2)).toThrow()
  })
  it('checks count and duration before returning a usable sequence', () => {
    expect(() => validateFrameSequenceTimestamps(Array.from({ length: 17 }, (_, index) => index), 20)).toThrow('2–16')
    expect(() => validateFrameSequenceTimestamps([0, 1], Infinity)).toThrow('时长')
    expect(() => validateFrameSequenceTimestamps([0, 1], 86_401)).toThrow('24 小时')
    expect(() => parseFrameSequenceTimestamps('0 '.repeat(2049), 2)).toThrow('过长')
  })
  it('samples inclusive endpoints at millisecond resolution and refuses duplicate rounded times', () => {
    expect(evenlySpacedFrameSequence(4, 0, 1.999, 2)).toEqual([0, .666, 1.333, 1.999])
    expect(evenlySpacedFrameSequence(2, .25, 1.25, 2)).toEqual([.25, 1.25])
    expect(() => evenlySpacedFrameSequence(3, 0, .001, 2)).toThrow('毫秒')
    expect(() => evenlySpacedFrameSequence(2, 0, 1.9999, 2)).toThrow('末尾')
    expect(() => evenlySpacedFrameSequence(2, 1, .5, 2)).toThrow('晚于')
    expect(() => evenlySpacedFrameSequence(1, 0, 1, 2)).toThrow('2–16')
  })
})

describe('frame sequence source sessions', () => {
  it.each(['video-input', 'video-generate', 'video', 'gallery', 'router'])('accepts an available %s video output', (type) => {
    expect(captureFrameSequenceSource([source(type)], 'video')).toEqual({ sourceNodeId: 'video', sourceKind: type, sourceAssetId: videoId, sourceHandle: 'out:video' })
  })
  it('rejects forged video results on nodes without a video port and missing assets', () => {
    expect(() => captureFrameSequenceSource([source('image-input')], 'video')).toThrow('视频输出')
    const node = source(); node.data.result = { kind: 'video', assetId: 'bad' }
    expect(() => captureFrameSequenceSource([node], 'video')).toThrow('上传视频')
    node.data.result = { kind: 'image', assetId: videoId }
    expect(() => captureFrameSequenceSource([node], 'video')).toThrow('上传视频')
  })
  it('rejects changing or failed producers while allowing a refreshed saved result', () => {
    for (const status of ['queued', 'running', 'failed']) {
      const node = source('video-generate'); node.data.status = status
      expect(() => captureFrameSequenceSource([node], 'video')).toThrow('尚未完成')
    }
    const node = source('video-generate'); node.data.status = 'idle'; node.data.dirty = true
    expect(() => captureFrameSequenceSource([node], 'video')).toThrow('等待更新')
    node.data.dirty = false
    expect(captureFrameSequenceSource([node], 'video').sourceAssetId).toBe(videoId)
  })
  it('guards source and ancestor locks, disabled state and malformed grouping', () => {
    const parent = builtinNodeRegistry.create('group', 'group', { x: 0, y: 0 }), node = { ...source(), parentId: 'group' }
    for (const flag of [{ locked: true }, { draggable: false }, { disabled: true }, { data: { __canvasLocked: true } }, { data: { __canvasDisabled: true } }]) {
      expect(() => captureFrameSequenceSource([{ ...parent, ...flag }, node], 'video')).toThrow('锁定或禁用')
    }
    expect(() => captureFrameSequenceSource([node], 'video')).toThrow('层级')
    expect(() => captureFrameSequenceSource([{ ...parent, parentId: 'video' }, node], 'video')).toThrow('层级')
    expect(() => captureFrameSequenceSource([node, node], 'video')).toThrow('重复')
  })
  it('rejects stale source identity, node kind and newly locked snapshots', () => {
    const node = source(), snapshot = captureFrameSequenceSource([node], 'video')
    assertFrameSequenceSource([node], snapshot)
    expect(() => assertFrameSequenceSource([{ ...node, data: { ...node.data, result: { kind: 'video', assetId: 'b'.repeat(43) } } }], snapshot)).toThrow('来源已变化')
    expect(() => assertFrameSequenceSource([source('gallery')], snapshot)).toThrow('来源已变化')
    expect(() => assertFrameSequenceSource([{ ...node, locked: true }], snapshot)).toThrow('锁定')
    expect(() => assertFrameSequenceSource([], snapshot)).toThrow('视频输出')
  })
})

describe('frame sequence graph composition', () => {
  it('creates existing frame nodes and a complete chronological collage with no model or result bindings', () => {
    const before = [source()], original = structuredClone(before), command = build(before)
    expect(before).toEqual(original)
    expect(command.nodes.map((node) => node.type)).toEqual(['frame-extract', 'frame-extract', 'frame-extract', 'image-collage'])
    expect(command.nodes.slice(0, 3).map((node) => settings(node).timestampSeconds)).toEqual([0, 1, 1.9])
    expect(command.edges).toHaveLength(6)
    const collage = command.nodes[3], order = parseImageCollageInputOrder(settings(collage).imageCollageInputOrder)
    expect(order.slots).toEqual(command.edges!.filter((edge) => edge.target === collage.id).map((edge) => ({ edgeId: edge.id, outputIndex: 0 })))
    const reversedInputs = [...command.edges!.filter((edge) => edge.target === collage.id)].reverse().map((edge) => ({ edgeId: edge.id, outputIndex: 0, source: edge.source }))
    expect(orderCollageInputs(reversedInputs, order).map((input) => input.source)).toEqual(command.nodes.slice(0, 3).map((node) => node.id))
    for (const node of command.nodes) {
      expect(node.parentId).toBeUndefined(); expect(node.data.model).toBe(''); expect(node.data.result).toBeUndefined()
      expect(node.data).toMatchObject({ dirty: true, status: 'idle' })
    }
    for (const edge of command.edges!) {
      const all = [...before, ...command.nodes], from = all.find((node) => node.id === edge.source)!, to = all.find((node) => node.id === edge.target)!
      expect(builtinNodeRegistry.port(from.type, edge.sourceHandle, 'output')?.kind).toBe(builtinNodeRegistry.port(to.type, edge.targetHandle, 'input')?.kind)
    }
    const recipe = parseImageTransformRecipe(settings(collage).imageTransform)
    if (recipe.kind !== 'collage') throw new Error('Expected collage')
    expect(imageCollageInputCountError(recipe, 3)).toBeNull(); expect(recipe.fit).toBe('contain')
    expect(recipe.outputWidth).toBe(684); expect(recipe.outputHeight).toBe(404)
  })
  it('commits the complete sequence with one undo boundary and restores identical IDs on redo', () => {
    const before = [source()], command = build(before)
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: before })
    history = applyCanvasCommand(history, command)
    expect(history.present.nodes).toHaveLength(5); expect(history.present.edges).toHaveLength(6)
    history = undoCanvasHistory(history)
    expect(history.present.nodes).toEqual(before); expect(history.present.edges).toEqual([])
    history = redoCanvasHistory(history)
    expect(history.present.nodes.slice(1)).toEqual(command.nodes); expect(history.present.edges).toEqual(command.edges)
  })
  it('places a single ordered block outside ancestor groups and existing obstacles in absolute coordinates', () => {
    const nodes = [{ ...builtinNodeRegistry.create('group', 'outer', { x: 1000, y: 2000 }), width: 1200, height: 1500 }, { ...builtinNodeRegistry.create('group', 'inner', { x: 100, y: 100 }), parentId: 'outer', width: 800, height: 900 }, { ...source(), parentId: 'inner' }]
    const command = build(nodes)
    for (const node of command.nodes) expect(node.position.x + node.width! + 28 <= 1000 || node.position.x >= 2228 || node.position.y + node.height! + 28 <= 2000 || node.position.y >= 3528).toBe(true)
    const first = command.nodes[0], second = command.nodes[1], third = command.nodes[2]
    expect(second.position.x).toBeGreaterThan(first.position.x); expect(second.position.y).toBe(first.position.y)
    expect(third.position.x).toBe(first.position.x); expect(third.position.y).toBeGreaterThan(first.position.y)
  })
  it.each([
    { width: 320, height: 180, expectedRenderedHeight: 546 },
    { width: 180, height: 320, expectedRenderedHeight: 840 },
    { width: 320, height: 320, expectedRenderedHeight: 654 },
    { width: 4096, height: 1, expectedRenderedHeight: 654 },
  ])('keeps completed and temporarily square frame previews clear across rows for $width x $height video', ({ width, height, expectedRenderedHeight }) => {
    const command = build([source()], [], Array.from({ length: 16 }, (_, index) => index / 10), { ...metadata, width, height })
    const frames = command.nodes.filter((node) => node.type === 'frame-extract')
    for (let index = 4; index < frames.length; index++) {
      expect(frames[index].position.y - frames[index - 4].position.y).toBeGreaterThanOrEqual(expectedRenderedHeight + 28)
      expect(frames[index].position.x).toBe(frames[index - 4].position.x)
    }
    // Reservations affect insertion positions, not global node dimensions or
    // a fixed rendered height that would crop a portrait frame.
    expect(frames.every((node) => node.height === 190 && node.width === 260)).toBe(true)
    expect(builtinNodeRegistry.require('frame-extract').dimensions).toEqual({ width: 260, height: 190 })
  })
  it('avoids an existing obstacle within the final frame row after the results grow', () => {
    const times = [0, .5, 1, 1.5], baseline = build([source()], [], times)
    const lastRow = baseline.nodes[2], obstacle = { ...builtinNodeRegistry.create('note', 'lower-obstacle', { x: lastRow.position.x + 20, y: lastRow.position.y + 400 }), width: 120, height: 80 }
    const command = build([source(), obstacle], [], times)
    expect(command.nodes[0].position).not.toEqual(baseline.nodes[0].position)
    for (const node of command.nodes.filter((entry) => entry.type === 'frame-extract')) {
      expect(node.position.x + 260 + 28 <= obstacle.position.x || node.position.x >= obstacle.position.x + obstacle.width + 28 || node.position.y + 654 + 28 <= obstacle.position.y || node.position.y >= obstacle.position.y + obstacle.height + 28).toBe(true)
    }
  })
  it('reserves the full collage controls below a single-row sequence when avoiding existing nodes', () => {
    const times = [0, 1], baseline = build([source()], [], times), collage = baseline.nodes.at(-1)!
    const obstacle = { ...builtinNodeRegistry.create('note', 'collage-obstacle', { x: collage.position.x + 30, y: collage.position.y + 900 }), width: 120, height: 80 }
    const command = build([source(), obstacle], [], times), placed = command.nodes.at(-1)!
    expect(placed.position).not.toEqual(collage.position)
    expect(placed.position.x + 320 + 28 <= obstacle.position.x || placed.position.x >= obstacle.position.x + obstacle.width + 28 || placed.position.y + 1000 + 28 <= obstacle.position.y || placed.position.y >= obstacle.position.y + obstacle.height + 28).toBe(true)
  })
  it('guards cloud graph capacity before asking for IDs and accepts the exact limit', () => {
    const nodes = [source(), ...Array.from({ length: maximumProjectNodes - 4 }, (_, index) => builtinNodeRegistry.create('note', `note-${index}`, { x: -10000, y: -10000 }))]
    expect(build(nodes, [], [0, 1]).nodes).toHaveLength(3)
    const nextId = () => { throw new Error('ID should not be requested') }
    expect(() => buildFrameSequenceGraph([...nodes, builtinNodeRegistry.create('note', 'extra', { x: 0, y: 0 })], [], captureFrameSequenceSource(nodes, 'video'), [0, 1], metadata, nextId)).toThrow('2000')
    const edges = Array.from({ length: maximumProjectEdges - 3 }, (_, index) => ({ id: `edge-${index}`, source: 'video', target: 'video', sourceHandle: 'out:video', targetHandle: 'in:video' }))
    expect(() => buildFrameSequenceGraph([source()], edges, captureFrameSequenceSource([source()], 'video'), [0, 1], metadata, nextId)).toThrow('4000')
  })
  it('rejects colliding IDs, dangling graph references and positions that cannot be persisted', () => {
    const nodes = [source()], snapshot = captureFrameSequenceSource(nodes, 'video')
    expect(() => buildFrameSequenceGraph(nodes, [], snapshot, [0, 1], metadata, () => 'video')).toThrow('编号')
    expect(() => buildFrameSequenceGraph(nodes, [], snapshot, [0, 1], metadata, () => 'constant')).toThrow('重复')
    expect(() => buildFrameSequenceGraph(nodes, [], snapshot, [0, 1], metadata, () => '\0')).toThrow('编号')
    expect(() => build(nodes, [{ id: 'edge', source: 'missing', target: 'video', sourceHandle: 'out:video', targetHandle: 'in:video' }])).toThrow('引用')
    const distant = { ...source(), position: { x: maximumCoordinateMagnitude, y: maximumCoordinateMagnitude } }
    expect(() => build([distant])).toThrow('范围')
  })
  it('uses verified video geometry and rejects predictable oversized collage input before creating a graph', () => {
    expect(build([source()], [], [0, 1], { ...metadata, width: 4096, height: 4096 }).nodes).toHaveLength(3)
    expect(() => build([source()], [], [0, 1, 1.9], { ...metadata, width: 4096, height: 4096 })).toThrow('最多支持 2 张')
    expect(() => build([source()], [], [0, 1], { ...metadata, width: 4097 })).toThrow('4096')
    const command = build([source()], [], Array.from({ length: 16 }, (_, index) => index / 10), { ...metadata, width: 1920, height: 1080 })
    const recipe = parseImageTransformRecipe(settings(command.nodes.at(-1)!).imageTransform)
    expect(recipe).toMatchObject({ rows: 4, columns: 4, outputWidth: 2628, outputHeight: 1508 })
  })
  it('round trips frame times and ordered collage through persistence, clipboard and workshop remapping', () => {
    const command = build(), originals = [source(), ...command.nodes], edges = command.edges!
    const workflow = parseWorkflowFile(JSON.stringify({ schemaVersion: 2, name: 'Video storyboard', nodes: originals.map(({ type, ...node }) => ({ ...node, kind: type })), edges }))
    if (!workflow) throw new Error('Expected parseable workflow')
    const reloaded = parseWorkflowFile(serializeWorkflow(workflow))!
    expect(reloaded.nodes.filter((node) => node.kind === 'frame-extract').map((node) => node.data.settings?.timestampSeconds)).toEqual([0, 1, 1.9])
    const copied = pasteCanvasClipboard(buildCanvasClipboardPayload(originals, edges, new Set(originals.map((node) => node.id))), { offset: { x: 100, y: 100 }, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` })
    const copiedOrder = parseImageCollageInputOrder(settings(copied.nodes.at(-1)!).imageCollageInputOrder)
    expect(copiedOrder.slots.map((slot) => slot.edgeId)).toEqual(edges.filter((edge) => edge.target === command.nodes.at(-1)!.id).map((edge) => `copy-${edge.id}`))
    const reusable = sanitizeWorkshopWorkflow(reloaded, 'group', '分镜序列'), restored = instantiateWorkshopGraph(reusable, ids())
    expect(restored.nodes.filter((node) => node.kind === 'frame-extract').map((node) => node.data.settings?.timestampSeconds)).toEqual([0, 1, 1.9])
    expect(restored.nodes.every((node) => node.data.result === undefined)).toBe(true)
    const target = restored.nodes.find((node) => node.kind === 'image-collage')!, order = parseImageCollageInputOrder(target.data.settings?.imageCollageInputOrder)
    expect(order.slots.map((slot) => restored.edges.find((edge) => edge.id === slot.edgeId)?.source)).toEqual(restored.nodes.filter((node) => node.kind === 'frame-extract').map((node) => node.id))
  })
})
