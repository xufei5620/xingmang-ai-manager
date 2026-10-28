import { describe, expect, it } from 'vitest'
import { appendEditorImportedLayers, buildLayerPsdGraph, type LayerPsdApplyInput } from './layer-psd-apply'
import { createLayerEditorState, redoLayerEditor, undoLayerEditor } from './layer-editor-state'
import type { ImageLayerRecipe } from './recipe'
import type { BrowserImportedLayerPsd } from '../library/browser-layer-psd-import'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import type { CanvasImageAssetSummary } from '../host'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { createCanvasDocument } from '../store/canvas-state'
import { canvasNodeDocumentRecord } from '../store/use-canvas-document'

function recipe(): ImageLayerRecipe { return { kind: 'layer', outputWidth: 1024, outputHeight: 1024, background: 'transparent', explicitLayers: true, layers: [] } }
function document(): BrowserImportedLayerPsd { return { width: 1024, height: 1024, warnings: [], layers: [{ name: '底', left: 0, top: 0, width: 1024, height: 1024, visible: true, opacity: 1, blend: 'source-over', blob: new Blob() }, { name: '上', left: 284, top: 264, width: 421, height: 436, visible: false, opacity: 0.5, blend: 'multiply', blob: new Blob() }] } }
function asset(letter: string): CanvasImageAssetSummary { const assetId = letter.repeat(43); return { assetId, mediaType: 'image', mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, fileName: `${letter}.png`, createdAt: '2026-10-14T00:00:00Z', width: 1024, height: 1024 } }
function target(): CanvasNode { return { id: 'target', type: 'image-layer', definitionVersion: 1, position: { x: 1000, y: 200 }, data: { model: '', prompt: '', status: 'idle', settings: { imageTransform: recipe() } } } }
function input(): LayerPsdApplyInput { return { initialRecipe: recipe(), recipe: appendEditorImportedLayers(createLayerEditorState(recipe(), 0), document(), 0).present.recipe, baseSourceAssetIds: [], importedAssets: [asset('a'), asset('b')] } }
function ids() { let id = 0; return () => `new-${++id}` }

describe('PSD editable layer transaction', () => {
  it('appends bottom to top with exact offsets and retains one undo boundary', () => {
    const initial = createLayerEditorState(recipe(), 0), next = appendEditorImportedLayers(initial, document(), 0)
    expect(next.present.recipe.layers.map((layer) => layer.name)).toEqual(['底', '上'])
    expect(next.present.recipe.layers[1]).toMatchObject({ x: 284 / 1024, y: 264 / 1024, width: 421 / 1024, height: 436 / 1024, opacity: 0.5, visible: false, blend: 'multiply' })
    expect(next.past).toHaveLength(1)
    expect(undoLayerEditor(next).present).toEqual(initial.present)
    expect(redoLayerEditor(undoLayerEditor(next)).present).toEqual(next.present)
  })
  it('rejects capacity or geometry without mutating the editor state', () => {
    const initial = createLayerEditorState(recipe(), 0), before = structuredClone(initial)
    expect(() => appendEditorImportedLayers(initial, document(), 19)).toThrow('20')
    const bad = document(); bad.layers[0].left = 99999
    expect(() => appendEditorImportedLayers(initial, bad, 0)).toThrow('范围')
    expect(initial).toEqual(before)
  })
  it('commits recipe, group, source nodes and ordered edges atomically and undoes everything once', () => {
    const node = target(), graph = buildLayerPsdGraph([node], [], node.id, input(), ids())
    expect(graph.nodes).toHaveLength(4); expect(graph.edges.map((edge) => edge.source)).toEqual(['new-2', 'new-4'])
    expect(graph.nodes[0].data.dirty).toBe(true)
    const initial = { ...createCanvasDocument('PSD'), nodes: [canvasNodeDocumentRecord(node)] }
    const history = applyCanvasCommand(createCanvasHistory(initial), { type: 'replace-graph', nodes: graph.nodes.map(canvasNodeDocumentRecord), edges: graph.edges.map((edge) => ({ ...edge, sourceHandle: edge.sourceHandle!, targetHandle: edge.targetHandle! })) })
    expect(history.past).toHaveLength(1)
    expect(undoCanvasHistory(history).present).toEqual(initial)
    expect(redoCanvasHistory(undoCanvasHistory(history)).present).toEqual(history.present)
    expect(history.present.name).toBe('PSD')
  })
  it('omits undone imports and remaps remaining source indices without dropping existing inputs', () => {
    const value = input(); value.recipe.layers.shift()
    const graph = buildLayerPsdGraph([target()], [], 'target', value, ids())
    expect(graph.importedCount).toBe(1)
    expect(graph.nodes.find((node) => node.type === 'image-input')?.data.result?.assetId).toBe('b'.repeat(43))
    expect((graph.nodes[0].data.settings?.imageTransform as ImageLayerRecipe).layers[0].sourceIndex).toBe(0)
  })
  it('preserves existing input order and appends imported images after all connected sources', () => {
    const node = target(), base = asset('z'), initial = { ...recipe(), layers: [{ sourceIndex: 0, x: 0, y: 0, width: 1, height: 1, rotation: 0, opacity: 1, blend: 'source-over' as const, visible: true }] }
    node.data.settings = { imageTransform: initial }
    const source: CanvasNode = { ...target(), id: 'source', type: 'image-input', data: { model: '', prompt: '', status: 'succeeded', result: { kind: 'image', assetId: base.assetId, localUrl: base.localUrl } } }
    const edge = { id: 'existing', source: source.id, target: node.id, sourceHandle: 'out:image', targetHandle: 'in:images' }
    const value = { ...input(), initialRecipe: initial, recipe: appendEditorImportedLayers(createLayerEditorState(initial, 1), document(), 1).present.recipe, baseSourceAssetIds: [base.assetId] }
    const graph = buildLayerPsdGraph([source, node], [edge], node.id, value, ids())
    expect(graph.edges[0]).toEqual(edge)
    expect((graph.nodes.find((entry) => entry.id === node.id)!.data.settings!.imageTransform as ImageLayerRecipe).layers.map((layer) => layer.sourceIndex)).toEqual([0, 1, 2])
    expect(graph.nodes[0]).toEqual(source)
  })
  it('places imported source groups clear of existing nodes instead of covering the creation', () => {
    const node = target(), obstruction = { ...target(), id: 'other', position: { x: 400, y: 200 }, width: 300, height: 400 }
    const graph = buildLayerPsdGraph([node, obstruction], [], node.id, input(), ids())
    const group = graph.nodes.find((entry) => entry.type === 'group')!
    const overlaps = group.position.x < obstruction.position.x + obstruction.width && group.position.x + group.width! > obstruction.position.x && group.position.y < obstruction.position.y + obstruction.height && group.position.y + group.height! > obstruction.position.y
    expect(overlaps).toBe(false)
    expect(graph.nodes.find((entry) => entry.id === 'other')).toEqual(obstruction)
  })
  it.each(['recipe', 'source', 'lock', 'ancestor', 'running', 'missing'] as const)('rejects changed %s before reconnecting assets', (kind) => {
    const node = target(), nodes = [node], value = input()
    if (kind === 'recipe') node.data.settings = { imageTransform: { ...recipe(), background: '#ffffff' } }
    if (kind === 'source') value.baseSourceAssetIds = ['a'.repeat(43)]
    if (kind === 'lock') node.draggable = false
    if (kind === 'ancestor') { node.parentId = 'group'; nodes.push({ ...target(), id: 'group', type: 'group', draggable: false }) }
    if (kind === 'running') node.data.status = 'running'
    expect(() => buildLayerPsdGraph(kind === 'missing' ? [] : nodes, [], node.id, value, ids())).toThrow()
    expect(nodes).toHaveLength(kind === 'ancestor' ? 2 : 1)
  })
})


describe('PSD folder transaction', () => {
  function groupedDocument(): BrowserImportedLayerPsd {
    return { ...document(), layerGroups: { version: 1, layerIds: ['bottom', 'top'], groups: [{ id: 'folder', name: '产品素材', children: ['bottom', 'top'], visible: false, locked: true }] } }
  }
  it('maps imported identities and folder flags in one undo while preserving independent child settings', () => {
    const initial = createLayerEditorState(recipe(), 0), imported = groupedDocument(), before = structuredClone(imported)
    const next = appendEditorImportedLayers(initial, imported, 0)
    expect(next.present.recipe.layerGroups).toMatchObject({ layerIds: next.present.ids, groups: [{ name: '产品素材', children: next.present.ids, visible: false, locked: true }] })
    expect(next.present.recipe.layerGroups?.groups[0].id).not.toBe('folder')
    expect(next.present.recipe.layers.map((layer) => layer.visible)).toEqual([true, false])
    expect(next.past).toHaveLength(1)
    expect(undoLayerEditor(next).present).toEqual(initial.present)
    expect(redoLayerEditor(undoLayerEditor(next)).present).toEqual(next.present)
    expect(imported).toEqual(before)
  })
  it('appends new folders outside the existing folder and prevents identifier collisions', () => {
    const first = appendEditorImportedLayers(createLayerEditorState(recipe(), 0), groupedDocument(), 0)
    const next = appendEditorImportedLayers(first, groupedDocument(), 2)
    const grouping = next.present.recipe.layerGroups!
    expect(grouping.groups).toHaveLength(2)
    expect(new Set([...grouping.layerIds, ...grouping.groups.map((group) => group.id)]).size).toBe(6)
    expect(grouping.groups[0]).toEqual(first.present.recipe.layerGroups!.groups[0])
    expect(grouping.groups[1].children).toEqual(next.present.ids.slice(2))
    expect(undoLayerEditor(next).present).toEqual(first.present)
  })
  it('rejects invalid imported folder topology atomically', () => {
    const initial = createLayerEditorState(recipe(), 0), before = structuredClone(initial), imported = groupedDocument()
    imported.layerGroups!.groups[0].children = ['missing']
    expect(() => appendEditorImportedLayers(initial, imported, 0)).toThrow()
    expect(initial).toEqual(before)
  })
  it('keeps folder identities through graph application and canvas undo redo', () => {
    const node = target(), value = input()
    value.recipe = appendEditorImportedLayers(createLayerEditorState(recipe(), 0), groupedDocument(), 0).present.recipe
    const graph = buildLayerPsdGraph([node], [], node.id, value, ids())
    expect(graph.nodes[0].data.settings!.imageTransform).toEqual(value.recipe)
    const initial = { ...createCanvasDocument('Folders'), nodes: [canvasNodeDocumentRecord(node)] }
    const history = applyCanvasCommand(createCanvasHistory(initial), { type: 'replace-graph', nodes: graph.nodes.map(canvasNodeDocumentRecord), edges: graph.edges.map((edge) => ({ ...edge, sourceHandle: edge.sourceHandle!, targetHandle: edge.targetHandle! })) })
    expect(undoCanvasHistory(history).present).toEqual(initial)
    expect(redoCanvasHistory(undoCanvasHistory(history)).present).toEqual(history.present)
  })
})
