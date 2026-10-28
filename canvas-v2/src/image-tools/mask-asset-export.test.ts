import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasAssetSummary, CanvasImageAssetSummary } from '../host'
import type { EditorNodeRecord } from '../domain/node-definition'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile, type WorkflowNodeData } from '../model'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import type { ImageEditMask } from './image-edit-mask'
import { resolveImageMaskSource } from './image-mask-workflow'
import { assertMaskAssetPng, assertMaskAssetSource, buildLinkedMaskAssetNode, buildMaskAssetNode, maximumMaskAssetPngBytes, parseMaskAssetUpload, replaceMaskAssetNode, type ImageMaskAssetPng, type MaskAssetSourceNode, type MaskAssetSourceSession } from './mask-asset-export'

const originalId = 'a'.repeat(43), savedId = 'b'.repeat(43)

function mask(width = 19, height = 13): ImageEditMask {
  return { version: 1, sourceAssetId: originalId, width, height, strokes: [{ tool: 'brush', size: .7, points: [{ x: 0, y: .5 }, { x: 1, y: .5 }] }] }
}

function image(assetId = savedId): CanvasImageAssetSummary {
  return { mediaType: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}`, mimeType: 'image/png', fileName: 'mask.png', thumbnailUrl: '', createdAt: '', width: 19, height: 13 }
}

function node(id = 'source', type = 'image-input'): MaskAssetSourceNode {
  return { id, type, position: { x: 40, y: 50 }, width: 280, height: 220, data: { prompt: 'original prompt', model: 'original-model', status: 'succeeded', settings: { title: '原图', retained: 12 }, result: { kind: 'image', assetId: originalId, localUrl: `xingmang-asset://image/${originalId}`, mimeType: 'image/png', width: 19, height: 13 }, candidateAssetIds: [originalId], candidates: [{ candidateId: 'real-original-candidate', attemptId: 'real-original-attempt', createdAt: '', asset: { kind: 'image', assetId: originalId } }] } }
}

function outputSession(source = node()): MaskAssetSourceSession {
  return { nodeId: source.id, from: 'output', source: resolveImageMaskSource([source], [], source.id, 'output') }
}

function inputGraph() {
  const source = node(), target = node('edit', 'image-edit'), nodes = [source, target]
  const edges = [{ id: 'source-edit', source: 'source', target: 'edit', sourceHandle: 'out:image', targetHandle: 'in:images' }]
  const session: MaskAssetSourceSession = { nodeId: 'edit', from: 'input', source: resolveImageMaskSource(nodes, edges, 'edit', 'input') }
  return { nodes, edges, session }
}

function generation(): WorkflowNodeData {
  return { prompt: 'Do not automatically generate this original prompt', model: 'gpt-image-1', status: 'running', group: 'my-owned-source', quality: 'low', size: '1024x1024', imageResolution: '1K', imageCandidateCount: 2, settings: { imageEditMask: mask(), commerceTask: { kind: 'material-b' }, title: 'Do not copy' }, result: node().data.result, dirty: true, fromCache: true, attemptCount: 5, costQuota: 99, runStartedAt: 'old', selectedCandidateId: 'paid', adoptedCandidateId: 'paid', candidates: node().data.candidates, candidateAssetIds: [originalId] }
}

function records(nodes: readonly MaskAssetSourceNode[]): EditorNodeRecord[] {
  return nodes.map((entry) => ({ ...entry, type: entry.type ?? 'image-input', definitionVersion: 1, data: { ...entry.data } }))
}

function candidateGraph() {
  const first = 'c'.repeat(43), third = 'd'.repeat(43), source = node('mask-result', 'image-generate')
  source.data = { ...source.data, group: 'original-private-route', quality: 'high', size: '1024x1536', dirty: true, selectedCandidateId: 'paid-candidate-1', adoptedCandidateId: 'paid-candidate-1', fromCache: true, candidateAssetIds: [first, originalId, third], candidates: [first, originalId, third].map((assetId, outputIndex) => ({ candidateId: `paid-candidate-${outputIndex}`, attemptId: `paid-attempt-${outputIndex}`, createdAt: '2026-10-18T00:00:00.000Z', outputIndex, group: 'real-original-source', model: 'real-original-model', costQuota: 9, asset: { kind: 'image', assetId, localUrl: `xingmang-asset://image/${assetId}` } })) }
  const upstream = node('upstream'), child = node('child', 'image-crop'), grandchild = node('grandchild', 'image-layer'), unrelated = node('unrelated')
  const nodes = [upstream, source, child, grandchild, unrelated]
  const edges = [
    { id: 'input', source: upstream.id, sourceHandle: 'out:image', target: source.id, targetHandle: 'in:images' },
    { id: 'downstream', source: source.id, sourceHandle: 'out:image', target: child.id, targetHandle: 'in:image' },
    { id: 'grandchild', source: child.id, sourceHandle: 'out:image', target: grandchild.id, targetHandle: 'in:images' },
  ]
  return { nodes, edges, session: outputSession(source) }
}

// A separate bitwise CRC and zlib fixture exercise the public transport parser;
// these samples deliberately do not claim that IDAT pixels match a mask recipe.
function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) {
    value ^= byte
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1
  }
  return (value ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array = new Uint8Array()): Uint8Array {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer)
  view.setUint32(0, data.length)
  bytes.set(new TextEncoder().encode(type), 4)
  bytes.set(data, 8)
  view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)))
  return bytes
}

function header(width = 19, height = 13, depth = 1, color = 0): Uint8Array {
  const bytes = new Uint8Array(13), view = new DataView(bytes.buffer)
  view.setUint32(0, width); view.setUint32(4, height)
  bytes[8] = depth; bytes[9] = color
  return chunk('IHDR', bytes)
}

function dataChunk(width = 19, height = 13): Uint8Array {
  return chunk('IDAT', deflateSync(new Uint8Array((Math.ceil(width / 8) + 1) * height)))
}

function pngParts(parts: Uint8Array[], width = 19, height = 13): ImageMaskAssetPng {
  const body = Buffer.concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), ...parts])
  return { blob: new Blob([new Uint8Array(body).buffer], { type: 'image/png' }), width, height }
}

function png(width = 19, height = 13): ImageMaskAssetPng {
  return pngParts([header(width, height), dataChunk(width, height), chunk('IEND')], width, height)
}

afterEach(() => vi.useRealTimers())

describe('mask asset source fences', () => {
  it('accepts the exact output and unique input without mutating their source candidates', () => {
    const source = node(), before = structuredClone(source), session = outputSession(source)
    expect(assertMaskAssetSource([source], [], session, mask())).toEqual({ target: source, source: session.source })
    const input = inputGraph()
    expect(assertMaskAssetSource(input.nodes, input.edges, input.session, mask()).target.id).toBe('edit')
    expect(source).toEqual(before)
  })

  it('allows absent dimensions but rejects known conflicting source and recipe dimensions', () => {
    const source = node(), session = outputSession(source)
    delete source.data.result!.width; delete source.data.result!.height
    expect(() => assertMaskAssetSource([source], [], session, mask())).not.toThrow()
    source.data.result!.width = 20
    expect(() => assertMaskAssetSource([source], [], session, mask())).toThrow('尺寸不一致')
    source.data.result!.width = 19
    expect(() => assertMaskAssetSource([source], [], session, mask(20, 13))).toThrow('尺寸不一致')
  })

  it.each(['locked', 'disabled', 'running', 'queued', 'settings-locked', 'settings-disabled', 'not-draggable'])(
    'rejects a %s source or ancestor after an editor opened', (change) => {
      for (const ancestor of [false, true]) {
        const source = node(), session = outputSession(source), group = node('group', 'group')
        source.parentId = 'group'
        const target = ancestor ? group : source
        if (change === 'locked') target.locked = true
        if (change === 'disabled') target.disabled = true
        if (change === 'running' || change === 'queued') target.data.status = change
        if (change === 'settings-locked') target.data.settings = { locked: true }
        if (change === 'settings-disabled') target.data.settings = { disabled: true }
        if (change === 'not-draggable') target.draggable = false
        expect(() => assertMaskAssetSource([source, group], [], session, mask())).toThrow()
      }
    },
  )

  it('rejects an independently locked edit target even when its input remains editable', () => {
    const input = inputGraph(); input.nodes[1].locked = true
    expect(() => assertMaskAssetSource(input.nodes, input.edges, input.session, mask())).toThrow('锁定')
  })

  it('rejects duplicate ids, deleted sources, missing parents, non-group parents and parent cycles', () => {
    const source = node(), session = outputSession(source)
    expect(() => assertMaskAssetSource([source, structuredClone(source)], [], session)).toThrow('重复')
    expect(() => assertMaskAssetSource([], [], session)).toThrow('删除')
    source.parentId = 'gone'
    expect(() => assertMaskAssetSource([source], [], session)).toThrow('分组')
    const parent = node('gone')
    expect(() => assertMaskAssetSource([source, parent], [], session)).toThrow('类型')
    parent.type = 'group'; parent.parentId = 'loop'
    const loop = node('loop', 'group'); loop.parentId = parent.id
    expect(() => assertMaskAssetSource([source, parent, loop], [], session)).toThrow('循环')
  })

  it('rejects changed current candidates, forged asset URLs and a mask bound to another asset', () => {
    const source = node(), session = outputSession(source)
    source.data.result!.assetId = savedId; source.data.result!.localUrl = image().localUrl
    expect(() => assertMaskAssetSource([source], [], session)).toThrow('变化')
    source.data.result = { ...session.source.asset, localUrl: 'https://example.invalid/image.png' }
    expect(() => assertMaskAssetSource([source], [], session)).toThrow('身份')
    source.data.result = { ...session.source.asset }
    expect(() => assertMaskAssetSource([source], [], session, { ...mask(), sourceAssetId: savedId })).toThrow('绑定')
    expect(() => assertMaskAssetSource([source], [], session, { ...mask(), sourceAssetId: undefined })).toThrow('绑定')
  })

  it('rejects extra inputs, changed handles, changed source nodes and an input self-loop', () => {
    const input = inputGraph()
    expect(() => assertMaskAssetSource(input.nodes, [...input.edges, { ...input.edges[0], id: 'duplicate' }], input.session)).toThrow('唯一图片')
    expect(() => assertMaskAssetSource(input.nodes, [{ ...input.edges[0], sourceHandle: 'out:images' }], input.session)).toThrow('唯一图片')
    const other = node('other')
    expect(() => assertMaskAssetSource([...input.nodes, other], [{ ...input.edges[0], source: 'other' }], input.session)).toThrow('变化')
    const self = { ...input.edges[0], source: 'edit' }
    expect(() => assertMaskAssetSource(input.nodes, [self], { ...input.session, source: { ...input.session.source, sourceNodeId: 'edit' } })).toThrow('自身')
  })

  it('refuses an ambiguous gallery instead of silently exporting its first candidate', () => {
    const source = node('gallery', 'gallery'), session = outputSession(source)
    source.data.candidateAssetIds = [originalId, savedId]
    expect(() => assertMaskAssetSource([source], [], session)).toThrow('多张图片')
  })
})

describe('saved mask asset receipt and document command', () => {
  it('fills omitted native metadata from the exact validated PNG dimensions', () => {
    const uploaded = image(); delete uploaded.width; delete uploaded.height
    expect(parseMaskAssetUpload(uploaded, png())).toMatchObject({ width: 19, height: 13 })
    expect(uploaded.width).toBeUndefined()
  })

  it.each(['wrong-media', 'wrong-mime', 'bad-id', 'remote-url', 'foreign-id-url', 'deleted', 'wrong-width', 'wrong-height'])(
    'rejects an unconfirmed upload receipt with %s', (change) => {
      let uploaded: CanvasAssetSummary = image()
      if (change === 'wrong-media') uploaded = { ...image(), mediaType: 'video', mimeType: 'video/mp4', taskId: 'task' }
      if (change === 'wrong-mime') uploaded = { ...image(), mimeType: 'image/jpeg' }
      if (change === 'bad-id') uploaded.assetId = 'bad'
      if (change === 'remote-url') uploaded.localUrl = 'https://example.invalid/mask.png'
      if (change === 'foreign-id-url') uploaded.localUrl = `xingmang-asset://image/${originalId}`
      if (change === 'deleted') uploaded.deletedAt = ''
      if (change === 'wrong-width') uploaded.width = 20
      if (change === 'wrong-height') uploaded.height = 14
      expect(() => parseMaskAssetUpload(uploaded, png())).toThrow()
    },
  )

  it('adds only an honest independent image snapshot with one real undo and redo', () => {
    const input = inputGraph(), before = structuredClone(input), command = buildMaskAssetNode(input.nodes, input.session, image(), 'mask-copy')
    expect(command.type).toBe('add-nodes'); expect(command.edges).toBeUndefined(); expect(command.nodes).toHaveLength(1)
    expect(command.nodes[0]).toMatchObject({ type: 'image-input', definitionVersion: 1, data: { prompt: '', model: '', status: 'succeeded', settings: { title: '原图 · 蒙版' }, result: { kind: 'image', assetId: savedId, width: 19, height: 13 } } })
    expect(Object.keys(command.nodes[0].data).sort()).toEqual(['model', 'prompt', 'result', 'settings', 'status'])
    const records: EditorNodeRecord[] = input.nodes.map((entry) => ({ ...entry, type: entry.type ?? 'image-input', definitionVersion: 1, data: { ...entry.data } }))
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: records, edges: input.edges })
    const added = applyCanvasCommand(history, command)
    expect(added.past).toHaveLength(1); expect(added.present.nodes).toHaveLength(3)
    expect(added.present.edges).toEqual(input.edges)
    const undone = undoCanvasHistory(added)
    expect(undone.present).toEqual(history.present)
    expect(redoCanvasHistory(undone).present).toEqual(added.present)
    expect(input).toEqual(before)
  })

  it('uses group world coordinates and avoids an occupied adjacent position', () => {
    const source = node(), session = outputSession(source), group = node('group', 'group')
    group.position = { x: 1000, y: 700 }; group.width = 300; group.height = 300
    source.parentId = group.id
    const free = buildMaskAssetNode([source, group], session, image(), 'mask-copy').nodes[0]
    expect(free.position.x).toBeGreaterThanOrEqual(1000 + 40 + 280)
    expect(free.position.y).toBe(750)
    const obstacle = node('obstacle'); obstacle.position = { ...free.position }; obstacle.width = free.width; obstacle.height = free.height
    const avoided = buildMaskAssetNode([source, group, obstacle], session, image(), 'mask-copy').nodes[0]
    expect(avoided.position).not.toEqual(free.position)
    expect(avoided.position.x + avoided.width! + 28 <= obstacle.position.x || avoided.position.x >= obstacle.position.x + obstacle.width! + 28 || avoided.position.y + avoided.height! + 28 <= obstacle.position.y || avoided.position.y >= obstacle.position.y + obstacle.height! + 28).toBe(true)
  })

  it('rejects reused node ids, changed sources, unavailable saved files and conflicting native dimensions before a command exists', () => {
    const source = node(), session = outputSession(source)
    expect(() => buildMaskAssetNode([source], session, image(), source.id)).toThrow('标识')
    expect(() => buildMaskAssetNode([source], session, { ...image(), width: undefined }, 'copy')).toThrow('完整保存')
    expect(() => buildMaskAssetNode([source], session, { ...image(), width: 20 }, 'copy')).toThrow('尺寸不一致')
    source.data.result!.assetId = savedId
    expect(() => buildMaskAssetNode([source], session, image(), 'copy')).toThrow('变化')
  })
})

describe('linked and current flattened mask documents', () => {
  it('creates one valid generation node and one real image input edge without copying a paid or AI mask identity', () => {
    const source = node(), session = outputSession(source), defaults = generation(), before = structuredClone({ source, session, defaults })
    const command = buildLinkedMaskAssetNode([source], session, image(), 'linked', 'source-linked', defaults)
    expect(command.nodes).toHaveLength(1)
    expect(command.edges).toEqual([{ id: 'source-linked', source: 'source', sourceHandle: 'out:image', target: 'linked', targetHandle: 'in:images' }])
    expect(builtinNodeRegistry.port(source.type!, command.edges![0].sourceHandle, 'output')?.kind).toBe('image')
    expect(builtinNodeRegistry.port(command.nodes[0].type, command.edges![0].targetHandle, 'input')?.kind).toBe('image')
    expect(command.nodes[0].data).toEqual({ prompt: '', model: 'gpt-image-1', group: 'my-owned-source', quality: 'low', size: '1024x1024', imageResolution: '1K', imageCandidateCount: 2, status: 'succeeded', settings: { title: '原图 · 蒙版' }, result: { kind: 'image', assetId: savedId, localUrl: image().localUrl, mimeType: 'image/png', width: 19, height: 13 } })
    expect(command.nodes[0]).toMatchObject({ type: 'image-generate', definitionVersion: 1 })
    expect({ source, session, defaults }).toEqual(before)
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: records([source]) }), added = applyCanvasCommand(history, command)
    expect(added.past).toHaveLength(1); expect(added.present.edges).toHaveLength(1)
    const undone = undoCanvasHistory(added)
    expect(undone.present).toEqual(history.present)
    expect(redoCanvasHistory(undone).present).toEqual(added.present)
  })

  it('permits an unconfigured model for later explicit selection and omits unset generation defaults', () => {
    const source = node()
    const added = buildLinkedMaskAssetNode([source], outputSession(source), image(), 'linked', 'edge', { prompt: 'ignored', model: '', status: 'idle' }).nodes[0]
    expect(added.data.model).toBe(''); expect(added.data.prompt).toBe('')
    expect(Object.keys(added.data).sort()).toEqual(['model', 'prompt', 'result', 'settings', 'status'])
  })

  it.each(['bad-model', 'bad-group', 'bad-size', 'bad-quality', 'bad-resolution', 'bad-count'])(
    'rejects an invalid generation default: %s', (kind) => {
      const source = node(), defaults = generation()
      if (kind === 'bad-model') defaults.model = 'a'.repeat(513)
      if (kind === 'bad-group') defaults.group = ''
      if (kind === 'bad-size') defaults.size = 'bad\0size'
      if (kind === 'bad-quality') defaults.quality = 'a'.repeat(129)
      if (kind === 'bad-resolution') Object.defineProperty(defaults, 'imageResolution', { value: '8K' })
      if (kind === 'bad-count') Object.defineProperty(defaults, 'imageCandidateCount', { value: 0 })
      expect(() => buildLinkedMaskAssetNode([source], outputSession(source), image(), 'linked', 'edge', defaults)).toThrow()
    },
  )

  it('rejects source locks, missing image output ports, node collisions and invalid edge identities', () => {
    const source = node(), session = outputSession(source), parent = node('parent', 'group')
    source.parentId = parent.id; parent.locked = true
    expect(() => buildLinkedMaskAssetNode([source, parent], session, image(), 'linked', 'edge', generation())).toThrow('锁定')
    parent.locked = false; parent.parentId = parent.id
    expect(() => buildLinkedMaskAssetNode([source, parent], session, image(), 'linked', 'edge', generation())).toThrow('循环')
    delete source.parentId; source.type = 'prompt'
    expect(() => buildLinkedMaskAssetNode([source], session, image(), 'linked', 'edge', generation())).toThrow('输出端口')
    source.type = 'image-input'
    expect(() => buildLinkedMaskAssetNode([source], session, image(), 'source', 'edge', generation())).toThrow('已存在')
    expect(() => buildLinkedMaskAssetNode([source], session, image(), 'linked', '', generation())).toThrow('连线标识')
  })

  it('replaces only candidate two, keeps its input relation and pending parameters, and dirties only descendants', () => {
    const graph = candidateGraph(), before = structuredClone(graph), updated = replaceMaskAssetNode(graph.nodes, graph.edges, graph.session, image())
    const target = updated[1], original = graph.nodes[1]
    expect(target.data.result).toEqual({ kind: 'image', assetId: savedId, localUrl: image().localUrl, mimeType: 'image/png', width: 19, height: 13 })
    expect(target.data.candidateAssetIds).toEqual(['c'.repeat(43), savedId, 'd'.repeat(43)])
    expect(target.data.candidates?.[0]).toBe(original.data.candidates?.[0]); expect(target.data.candidates?.[2]).toBe(original.data.candidates?.[2])
    expect(target.data.candidates?.[1]).toEqual({ candidateId: `document:mask-result:mask:${savedId}`, attemptId: 'document:mask-result', createdAt: '', outputIndex: 1, asset: target.data.result })
    expect(target.data.selectedCandidateId).toBeUndefined(); expect(target.data.adoptedCandidateId).toBeUndefined(); expect(target.data.fromCache).toBeUndefined()
    for (const key of ['prompt', 'model', 'group', 'size', 'quality', 'dirty', 'settings'] as const) expect(target.data[key]).toEqual(original.data[key])
    expect(updated[0]).toBe(graph.nodes[0]); expect(updated[4]).toBe(graph.nodes[4])
    expect(updated[2].data.dirty).toBe(true); expect(updated[3].data.dirty).toBe(true)
    expect(graph).toEqual(before)
    const history = createCanvasHistory({ ...createCanvasDocument(), nodes: records(graph.nodes), edges: graph.edges })
    const applied = applyCanvasCommand(history, { type: 'replace-nodes', nodes: records(updated) })
    expect(applied.past).toHaveLength(1); expect(applied.present.edges).toEqual(graph.edges)
    const undone = undoCanvasHistory(applied)
    expect(undone.present).toEqual(history.present); expect(redoCanvasHistory(undone).present).toEqual(applied.present)
  })

  it('restores a persisted candidate order even when runtime candidate objects have not loaded', () => {
    const graph = candidateGraph(); delete graph.nodes[1].data.candidates
    const result = replaceMaskAssetNode(graph.nodes, graph.edges, graph.session, image())[1]
    expect(result.data.candidateAssetIds).toEqual(['c'.repeat(43), savedId, 'd'.repeat(43)])
    expect(result.data.candidates).toEqual([{ candidateId: `document:mask-result:mask:${savedId}`, attemptId: 'document:mask-result', createdAt: '', asset: result.data.result }])
  })

  it('preserves an unbatched image input as an unbatched snapshot when replacing it', () => {
    const source = node(); delete source.data.candidates; delete source.data.candidateAssetIds
    const result = replaceMaskAssetNode([source], [], outputSession(source), image())[0]
    expect(result.type).toBe('image-input'); expect(result.data.result?.assetId).toBe(savedId)
    expect(result.data.candidates).toBeUndefined(); expect(result.data.candidateAssetIds).toBeUndefined()
  })

  it.each(['input-session', 'locked-parent', 'disabled-parent', 'changed-image', 'self-edge', 'cycle', 'duplicate-slot', 'inconsistent-slot', 'bad-upload', 'wrong-size'])(
    'refuses current-node replacement after %s without mutating its graph', (kind) => {
      const graph = candidateGraph()
      if (kind === 'input-session') graph.session.from = 'input'
      if (kind === 'locked-parent' || kind === 'disabled-parent') {
        const parent = node('parent', 'group'); graph.nodes[1].parentId = parent.id
        parent.locked = kind === 'locked-parent'; parent.disabled = kind === 'disabled-parent'; graph.nodes.push(parent)
      }
      if (kind === 'changed-image') graph.nodes[1].data.result = { ...graph.nodes[1].data.result!, assetId: 'e'.repeat(43), localUrl: `xingmang-asset://image/${'e'.repeat(43)}` }
      if (kind === 'self-edge') graph.edges.push({ id: 'self', source: 'mask-result', sourceHandle: 'out:image', target: 'mask-result', targetHandle: 'in:images' })
      if (kind === 'cycle') graph.edges.push({ id: 'back', source: 'grandchild', sourceHandle: 'out:image', target: 'mask-result', targetHandle: 'in:images' })
      if (kind === 'duplicate-slot') graph.nodes[1].data.candidateAssetIds!.push(originalId)
      if (kind === 'inconsistent-slot') graph.nodes[1].data.candidateAssetIds = ['c'.repeat(43)]
      const saved = image()
      if (kind === 'bad-upload') saved.localUrl = 'https://example.invalid/mask.png'
      if (kind === 'wrong-size') saved.width = 20
      const before = structuredClone(graph)
      expect(() => replaceMaskAssetNode(graph.nodes, graph.edges, graph.session, saved)).toThrow()
      expect(graph).toEqual(before)
    },
  )

  it('roundtrips the linked seeded output through the current workflow reader while workshop export strips private PNGs', () => {
    const source = node(), defaults = generation(); delete defaults.group
    const command = buildLinkedMaskAssetNode([source], outputSession(source), image(), 'linked', 'link', defaults)
    const linked = command.nodes[0]
    const workflow: WorkflowFile = { ...createEmptyWorkflow('Mask source'), nodes: [
      { id: source.id, kind: 'image-input', definitionVersion: 1, position: source.position, data: source.data },
      { id: linked.id, kind: 'image-generate', definitionVersion: 1, position: linked.position, data: { prompt: '', model: String(linked.data.model), status: 'succeeded', quality: 'low', size: '1024x1024', imageResolution: '1K', imageCandidateCount: 2, settings: { title: '原图 · 蒙版' }, result: { kind: 'image', assetId: savedId, localUrl: image().localUrl, mimeType: 'image/png', width: 19, height: 13 } } },
    ], edges: command.edges! }
    const reopened = parseWorkflowFile(serializeWorkflow(workflow))
    expect(reopened?.nodes[1]).toMatchObject({ kind: 'image-generate', data: { prompt: '', model: 'gpt-image-1', result: { assetId: savedId } } })
    expect(reopened?.edges).toEqual(workflow.edges)
    const portable = sanitizeWorkshopWorkflow(workflow, 'group', 'Mask source')
    expect(portable.nodes[1].kind).toBe('image-generate'); expect(portable.nodes[1].data.model).toBe('gpt-image-1')
    expect(portable.edges).toEqual([{ id: 'edge-1', source: 'node-1', target: 'node-2', sourceHandle: 'out:image', targetHandle: 'in:images' }])
    for (const item of portable.nodes) { expect(item.data.result).toBeUndefined(); expect(item.data.candidates).toBeUndefined(); expect(item.data.candidateAssetIds).toBeUndefined() }
    expect(JSON.stringify(portable)).not.toContain(originalId); expect(JSON.stringify(portable)).not.toContain(savedId)
  })
})

describe('bounded opaque mask PNG transport verification', () => {
  it('accepts independently encoded one-bit grayscale PNG structures and multiple contiguous IDAT chunks', async () => {
    await expect(assertMaskAssetPng(mask(), png())).resolves.toBeUndefined()
    const compressed = deflateSync(new Uint8Array(52))
    await expect(assertMaskAssetPng(mask(), pngParts([header(), chunk('IDAT', compressed.subarray(0, 2)), chunk('IDAT', compressed.subarray(2)), chunk('IEND')]))).resolves.toBeUndefined()
  })

  it.each([
    ['transparent color type', () => pngParts([header(19, 13, 8, 6), dataChunk(), chunk('IEND')])],
    ['unsupported bit depth', () => pngParts([header(19, 13, 8, 0), dataChunk(), chunk('IEND')])],
    ['palette transparency', () => pngParts([header(), chunk('tRNS', new Uint8Array([0, 0])), dataChunk(), chunk('IEND')])],
    ['animation', () => pngParts([header(), chunk('acTL', new Uint8Array(8)), dataChunk(), chunk('IEND')])],
    ['unknown critical data', () => pngParts([header(), chunk('ABCD'), dataChunk(), chunk('IEND')])],
    ['duplicate dimensions', () => pngParts([header(), header(), dataChunk(), chunk('IEND')])],
    ['missing first dimensions', () => pngParts([dataChunk(), header(), chunk('IEND')])],
    ['wrong native dimensions', () => pngParts([header(20, 13), dataChunk(), chunk('IEND')])],
    ['empty image data', () => pngParts([header(), chunk('IDAT'), chunk('IEND')])],
    ['missing image data', () => pngParts([header(), chunk('tEXt', new Uint8Array(10)), chunk('IEND')])],
    ['missing ending', () => pngParts([header(), dataChunk()])],
    ['noncontiguous image data', () => pngParts([header(), dataChunk(), chunk('tEXt'), dataChunk(), chunk('IEND')])],
    ['trailing chunks', () => pngParts([header(), dataChunk(), chunk('IEND'), chunk('tEXt')])],
    ['too many chunks', () => pngParts([header(), ...Array.from({ length: 126 }, () => chunk('tEXt')), dataChunk(), chunk('IEND')])],
  ] as const)('rejects %s without accepting a partial or transparent asset', async (_name, create) => {
    await expect(assertMaskAssetPng(mask(), create())).rejects.toThrow()
  })

  it('rejects corrupt CRCs, forged signatures and truncated declared chunk lengths', async () => {
    const bytes = new Uint8Array(await png().blob.arrayBuffer())
    for (const index of [0, 16, bytes.length - 1]) {
      const bad = bytes.slice(); bad[index] ^= 1
      await expect(assertMaskAssetPng(mask(), { ...png(), blob: new Blob([bad.buffer], { type: 'image/png' }) })).rejects.toThrow()
    }
    const oversizedChunk = bytes.slice(); new DataView(oversizedChunk.buffer).setUint32(8, 0xffffffff)
    await expect(assertMaskAssetPng(mask(), { ...png(), blob: new Blob([oversizedChunk.buffer], { type: 'image/png' }) })).rejects.toThrow('长度不完整')
  })

  it('rejects erased or empty recipes, mismatched dimensions, wrong MIME and oversized files before reading', async () => {
    await expect(assertMaskAssetPng({ ...mask(), strokes: [] }, png())).rejects.toThrow('涂抹区域')
    const one: ImageEditMask = { ...mask(1, 1), strokes: [{ tool: 'brush', size: 1, points: [{ x: .5, y: .5 }] }, { tool: 'erase', size: 1, points: [{ x: .5, y: .5 }] }] }
    await expect(assertMaskAssetPng(one, png(1, 1))).rejects.toThrow('涂抹区域')
    await expect(assertMaskAssetPng(mask(), { ...png(), width: 20 })).rejects.toThrow('配方不一致')
    await expect(assertMaskAssetPng(mask(), { ...png(), blob: new Blob(['not PNG'], { type: 'image/jpeg' }) })).rejects.toThrow('格式不正确')
    const blob = new Blob([new Uint8Array(maximumMaskAssetPngBytes + 1)], { type: 'image/png' }), read = vi.spyOn(blob, 'arrayBuffer')
    await expect(assertMaskAssetPng(mask(), { ...png(), blob })).rejects.toThrow('4 MB')
    expect(read).not.toHaveBeenCalled()
  })

  it('cancels before reading and ignores a late Blob result after cancellation', async () => {
    const pre = new AbortController(); pre.abort()
    const initial = png(), read = vi.spyOn(initial.blob, 'arrayBuffer')
    await expect(assertMaskAssetPng(mask(), initial, pre.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read).not.toHaveBeenCalled()
    let finish: ((value: ArrayBuffer) => void) | undefined
    class DelayedBlob extends Blob { override arrayBuffer(): Promise<ArrayBuffer> { return new Promise((resolve) => { finish = resolve }) } }
    const controller = new AbortController(), blob = new DelayedBlob(['pending'], { type: 'image/png' })
    const pending = assertMaskAssetPng(mask(), { ...initial, blob }, controller.signal)
    const observed = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve(); controller.abort(); await observed
    finish?.(await initial.blob.arrayBuffer()); await Promise.resolve()
  })

  it('bounds signal-ignoring Blob reads and cleans up synchronous read failures', async () => {
    vi.useFakeTimers()
    class HangingBlob extends Blob { override arrayBuffer(): Promise<ArrayBuffer> { return new Promise(() => {}) } }
    const pending = assertMaskAssetPng(mask(), { ...png(), blob: new HangingBlob(['pending'], { type: 'image/png' }) })
    const observed = expect(pending).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(10_000); await observed
    expect(vi.getTimerCount()).toBe(0)
    class ThrowingBlob extends Blob { override arrayBuffer(): Promise<ArrayBuffer> { throw new Error('read failed') } }
    await expect(assertMaskAssetPng(mask(), { ...png(), blob: new ThrowingBlob(['pending'], { type: 'image/png' }) })).rejects.toThrow('read failed')
    expect(vi.getTimerCount()).toBe(0)
  })
})
