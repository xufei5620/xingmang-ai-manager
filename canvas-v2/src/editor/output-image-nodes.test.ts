import { describe, expect, it } from 'vitest'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { CanvasImageAssetSummary } from '../host'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { buildOutputImageNodes, nodeOutputImageIds } from './output-image-nodes'

const ids = ['a'.repeat(43), 'b'.repeat(43), 'c'.repeat(43)]
function asset(index: number): CanvasImageAssetSummary { return { assetId: ids[index], mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${ids[index]}`, thumbnailUrl: '', fileName: 'test.png', width: 960, height: 720, createdAt: '' } }
function nodes() { return [{ ...builtinNodeRegistry.create('group', 'outer', { x: 1000, y: 700 }), width: 900, height: 900, locked: true }, { ...builtinNodeRegistry.create('group', 'inner', { x: 100, y: 100 }), width: 600, height: 600, parentId: 'outer', locked: true }, { ...builtinNodeRegistry.create('image-collage', 'tool', { x: 30, y: 80 }), parentId: 'inner', locked: true }] }

describe('output image snapshot planning', () => {
  it('preserves current versus all slice order and rejects invalid or inapplicable snapshots', () => {
    const data = { result: { kind: 'image' as const, assetId: ids[1] }, candidateAssetIds: ids }
    expect(nodeOutputImageIds('image-grid-split', data, 'current')).toEqual([ids[1]])
    expect(nodeOutputImageIds('image-grid-split', data, 'all')).toEqual(ids)
    expect(() => nodeOutputImageIds('image-collage', data, 'all')).toThrow('只有宫格')
    expect(() => nodeOutputImageIds('image-input', data, 'current')).toThrow('本地图像')
    expect(() => nodeOutputImageIds('image-grid-split', { candidateAssetIds: [...ids, 'bad'] }, 'all')).toThrow('完整')
  })
  it('places snapshots outside locked ancestor groups without connecting or moving the source', () => {
    const before = nodes(), original = structuredClone(before)
    const command = buildOutputImageNodes(before, 'tool', [asset(0), asset(1), asset(2)], ['new-a', 'new-b', 'new-c'])
    expect(before).toEqual(original); expect(command.edges).toBeUndefined()
    for (const [index, node] of command.nodes.entries()) {
      expect(node.parentId).toBeUndefined(); expect(node.type).toBe('image-input')
      expect(node.data.result).toMatchObject({ assetId: ids[index], width: 960, height: 720 })
      expect(node.position.x + node.width! + 28 <= 1000 || node.position.x >= 1928 || node.position.y + node.height! + 28 <= 700 || node.position.y >= 1628).toBe(true)
    }
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: before })
    history = applyCanvasCommand(history, command); expect(history.present.nodes).toHaveLength(6)
    history = undoCanvasHistory(history); expect(history.present.nodes).toEqual(before)
    history = redoCanvasHistory(history); expect(history.present.nodes.slice(3)).toEqual(command.nodes)
  })
  it('refuses a malformed hierarchy, recycled output or duplicate node id atomically', () => {
    expect(() => buildOutputImageNodes(nodes(), 'tool', [{ ...asset(0), deletedAt: 'now' }], ['new'])).toThrow('不可读取')
    expect(() => buildOutputImageNodes(nodes(), 'tool', [asset(0)], ['tool'])).toThrow('标识')
    const invalid = nodes(); invalid[0].parentId = 'inner'
    expect(() => buildOutputImageNodes(invalid, 'tool', [asset(0)], ['new'])).toThrow('层级')
  })
  it('reserves future dimensions of another image whose metadata has not loaded', () => {
    const tool = builtinNodeRegistry.create('image-collage', 'tool', { x: 500, y: 0 })
    const pending = { ...builtinNodeRegistry.create('image-input', 'pending', { x: 880, y: -400 }), width: 280, height: 280, data: { result: { kind: 'image', assetId: ids[1] } } }
    const command = buildOutputImageNodes([tool, pending], 'tool', [asset(0)], ['new'])
    const placed = command.nodes[0]
    expect(placed.position.x + placed.width! + 28 <= 880 || placed.position.x >= 1388 || placed.position.y + placed.height! + 28 <= -400 || placed.position.y >= 108).toBe(true)
  })
  it('snapshots the saved frame as one independent image with one undo while preserving a previous result', () => {
    const source = { ...builtinNodeRegistry.create('frame-extract', 'frame', { x: 20, y: 40 }), data: { dirty: true, settings: { timestampSeconds: 8.5 }, result: { kind: 'image' as const, assetId: ids[1], width: 960, height: 720 } } }
    expect(nodeOutputImageIds('frame-extract', source.data, 'current')).toEqual([ids[1]])
    const before = structuredClone(source), command = buildOutputImageNodes([source], 'frame', [asset(1)], ['frame-image'])
    expect(command.edges).toBeUndefined(); expect(source).toEqual(before)
    expect(command.nodes[0]).toMatchObject({ type: 'image-input', data: { dirty: false, result: { kind: 'image', assetId: ids[1], width: 960, height: 720 } } })
    let history = createCanvasHistory({ ...createCanvasDocument(), nodes: [source] })
    history = applyCanvasCommand(history, command); expect(history.present.nodes).toHaveLength(2)
    history = undoCanvasHistory(history); expect(history.present.nodes).toEqual([before])
    history = redoCanvasHistory(history); expect(history.present.nodes[1]).toEqual(command.nodes[0])
  })
  it('refuses frame batches, stale asset resolution and recycled frames without mutating the source', () => {
    const source = { ...builtinNodeRegistry.create('frame-extract', 'frame', { x: 0, y: 0 }), data: { result: { kind: 'image' as const, assetId: ids[1] } } }
    const before = structuredClone(source)
    expect(() => nodeOutputImageIds('frame-extract', { ...source.data, candidateAssetIds: ids }, 'all')).toThrow('只有宫格')
    expect(() => buildOutputImageNodes([source], 'frame', [asset(0)], ['new'])).toThrow('成品已变化')
    expect(() => buildOutputImageNodes([source], 'frame', [asset(1), asset(2)], ['new-a', 'new-b'])).toThrow('成品已变化')
    expect(() => buildOutputImageNodes([source], 'frame', [{ ...asset(1), deletedAt: 'now' }], ['new'])).toThrow('不可读取')
    expect(() => buildOutputImageNodes([{ ...source, data: {} }], 'frame', [asset(1)], ['new'])).toThrow('成品已变化')
    expect(source).toEqual(before)
  })
})
