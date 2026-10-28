import { describe, expect, it } from 'vitest'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'
import { buildCanvasUpstreamReferences } from '../components/upstream-references'
import { duplicateCanvasNodesForAltDrag } from '../editor/alt-drag'
import { buildCanvasClipboardPayload, pasteCanvasClipboard } from '../editor/clipboard'
import { buildWorkshopSelection, instantiateWorkshopGraph } from '../editor/workshop-graph'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile, type WorkflowNodeData } from '../model'
import { isRecord, toPersistedWorkflowV2 } from '../persistence/workflow-schema'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { createCanvasDocument } from '../store/canvas-state'
import { applyCanvasCommand, createCanvasHistory, redoCanvasHistory, undoCanvasHistory } from '../store/history'
import { defaultImageTransformRecipe } from './recipe'
import { parseTileInput, resolveTileInputSlots, type TileInputSelection } from './tile-input'

function fixture(selection: TileInputSelection | undefined = { edgeId: 'private-edge-b' }): WorkflowFile {
  return { ...createEmptyWorkflow('Tile selection'), nodes: [
    ...['a', 'b'].map((id) => ({ id, kind: 'image-input' as const, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded' as const, result: { kind: 'image' as const, assetId: id.repeat(43), localUrl: `xingmang-asset://image/${id.repeat(43)}` } } })),
    { id: 'tile', kind: 'image-tile', definitionVersion: 1, position: { x: 400, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { title: 'Selected texture', imageTransform: defaultImageTransformRecipe('tile'), ...(selection === undefined ? {} : { tileInput: selection }) } } },
  ], edges: ['a', 'b'].map((id) => ({ id: `private-edge-${id}`, source: id, sourceHandle: 'out:image', target: 'tile', targetHandle: 'in:image' })) }
}

function editorNodes(workflow: WorkflowFile) {
  return workflow.nodes.map(({ kind, ...node }) => ({ ...node, data: { ...node.data }, type: kind, definitionVersion: 1 }))
}

function selection(workflow: WorkflowFile) { return workflow.nodes.find((node) => node.id === 'tile' || node.kind === 'image-tile')?.data.settings?.tileInput }
function editorSelection(node: { data: Record<string, unknown> } | undefined) { return isRecord(node?.data.settings) ? node.data.settings.tileInput : undefined }

function restore(workflow: WorkflowFile): WorkflowFile {
  const restored = parseWorkflowFile(serializeWorkflow(workflow))
  if (!restored) throw new Error('Expected a valid tile workflow')
  return restored
}

describe('tile input project and reusable graph persistence', () => {
  it('round-trips a stable selected connection and preserves removed identity without modifying the source', () => {
    const original = fixture()
    expect(selection(restore(restore(original)))).toEqual({ edgeId: 'private-edge-b', outputIndex: 0 })
    original.edges = original.edges.filter((edge) => edge.source !== 'b')
    const reopened = restore(original)
    expect(selection(reopened)).toEqual({ edgeId: 'private-edge-b', outputIndex: 0 })
    const references = buildCanvasUpstreamReferences(editorNodes(reopened), reopened.edges, []).get('tile') ?? []
    expect(resolveTileInputSlots(references, parseTileInput(selection(reopened))).selected).toMatchObject({ edgeId: 'private-edge-b', missing: true })
    expect(selection(original)).toEqual({ edgeId: 'private-edge-b' })
  })
  it('loads a legacy single-image node with its original default and no newly invented selector', () => {
    const original = fixture()
    delete original.nodes[2].data.settings!.tileInput
    original.edges = original.edges.slice(0, 1)
    const reopened = restore(restore(original))
    expect(selection(reopened)).toBeUndefined()
    const references = buildCanvasUpstreamReferences(editorNodes(reopened), reopened.edges, []).get('tile') ?? []
    expect(resolveTileInputSlots(references).selected).toMatchObject({ edgeId: 'private-edge-a', outputIndex: 0, pending: false, missing: false })
  })
  it('round-trips a selected batch position while its source has no current output', () => {
    const original = fixture({ edgeId: 'private-edge-b', outputIndex: 2 })
    original.nodes[1] = { ...original.nodes[1], kind: 'image-grid-split', data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: defaultImageTransformRecipe('grid-split') } } }
    original.edges[1].sourceHandle = 'out:images'
    const reopened = restore(original)
    expect(selection(reopened)).toEqual({ edgeId: 'private-edge-b', outputIndex: 2 })
    const references = buildCanvasUpstreamReferences(editorNodes(reopened), reopened.edges, []).get('tile') ?? []
    expect(resolveTileInputSlots(references, parseTileInput(selection(reopened))).selected).toMatchObject({ outputIndex: 2, pending: true, missing: false })
  })
  it('restores selected input identity through edge deletion, undo and redo', () => {
    const original = fixture(), document = { ...createCanvasDocument(), nodes: editorNodes(original), edges: original.edges }
    const initial = createCanvasHistory(document)
    const deleted = applyCanvasCommand(initial, { type: 'delete-elements', nodeIds: [], edgeIds: ['private-edge-b'] })
    function current(state: typeof initial) {
      const refs = buildCanvasUpstreamReferences(state.present.nodes.map((node) => ({ ...node, data: node.data as WorkflowNodeData & Record<string, unknown> })), state.present.edges, []).get('tile') ?? []
      return resolveTileInputSlots(refs, parseTileInput(editorSelection(state.present.nodes[2]))).selected
    }
    expect(current(deleted)).toMatchObject({ edgeId: 'private-edge-b', missing: true })
    expect(current(undoCanvasHistory(deleted))).toMatchObject({ edgeId: 'private-edge-b', missing: false })
    expect(current(redoCanvasHistory(undoCanvasHistory(deleted)))).toMatchObject({ edgeId: 'private-edge-b', missing: true })
  })
  it('remaps clipboard and Alt copies without binding omitted inputs to another image', () => {
    const original = fixture(), nodes = editorNodes(original)
    for (const ids of [['a', 'b', 'tile'], ['a', 'tile']]) {
      const copy = pasteCanvasClipboard(buildCanvasClipboardPayload(nodes, original.edges, new Set(ids)), { offset: { x: 10, y: 10 }, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` })
      expect(editorSelection(copy.nodes.find((node) => node.type === 'image-tile'))).toEqual(ids.includes('b') ? { edgeId: 'copy-private-edge-b', outputIndex: 0 } : { missing: true })
    }
    for (const preserveInputConnections of [true, false]) {
      const copy = duplicateCanvasNodesForAltDrag(nodes, original.edges, { nodeIds: ['tile'], preserveInputConnections, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` })
      expect(editorSelection(copy.nodes[0])).toEqual(preserveInputConnections ? { edgeId: 'copy-private-edge-b', outputIndex: 0 } : { missing: true })
    }
    expect(selection(original)).toEqual({ edgeId: 'private-edge-b' })
  })
  it('captures the original default before partial clipboard or workshop extraction', () => {
    const original = fixture()
    delete original.nodes[2].data.settings!.tileInput
    const copied = pasteCanvasClipboard(buildCanvasClipboardPayload(editorNodes(original), original.edges, new Set(['b', 'tile'])), { offset: { x: 0, y: 0 }, createNodeId: (id) => `copy-${id}`, createEdgeId: (id) => `copy-${id}` })
    expect(editorSelection(copied.nodes.find((node) => node.type === 'image-tile'))).toEqual({ missing: true })
    expect(selection(buildWorkshopSelection(original, ['b', 'tile']))).toEqual({ missing: true })
    expect(selection(original)).toBeUndefined()
  })
  it('preserves internal selection through workshop sanitization, file transfer and fresh graph insertion', () => {
    const original = fixture()
    original.nodes[2].data.settings!.apiKey = 'private-credential'
    const portable = sanitizeWorkshopWorkflow(buildWorkshopSelection(original, ['a', 'b', 'tile']), 'group', 'Tile')
    expect(selection(portable)).toEqual({ edgeId: 'edge-2', outputIndex: 0 })
    const transfer = buildWorkshopTransferFile({ kind: 'group', name: 'Tile', description: '', category: 'general', tags: [], nodeCount: 3, edgeCount: 2, nodeKinds: ['image-input', 'image-tile'], workflow: portable }, { kind: 'personal' })
    expect(transfer.version).toBe(3)
    expect(transfer.snapshot.workflow?.schemaVersion).toBe(2)
    const decoded = parseWorkshopTransferFile(serializeWorkshopTransferFile(transfer))
    if (decoded.snapshot.kind === 'prompt' || !decoded.snapshot.workflow) throw new Error('Expected a graph transfer')
    let nextId = 0
    const inserted = instantiateWorkshopGraph(decoded.snapshot.workflow, () => `inserted-${++nextId}`)
    expect(selection(inserted)).toEqual({ edgeId: inserted.edges[1].id, outputIndex: 0 })
    expect(selection(restore(inserted))).toEqual(selection(inserted))
    expect(JSON.stringify(decoded)).not.toMatch(/private-edge|private-credential|xingmang-asset:|assetId/)
  })
  it('keeps a missing tombstone through node presets and partial groups', () => {
    const original = fixture()
    const partial = sanitizeWorkshopWorkflow(buildWorkshopSelection(original, ['a', 'tile']), 'group', 'Partial')
    const preset = sanitizeWorkshopWorkflow(buildWorkshopSelection(original, ['tile']), 'node', 'Preset')
    expect(selection(partial)).toEqual({ missing: true })
    expect(selection(preset)).toEqual({ missing: true })
    let nextId = 0
    expect(selection(instantiateWorkshopGraph(preset, () => `preset-${++nextId}`))).toEqual({ missing: true })
    expect(JSON.stringify(preset)).not.toContain('private-edge')
  })
  it.each(['explicit', 'tombstone', 'multiple', 'batch', 'legacy'] as const)('gates %s file semantics without changing the inner workflow schema', (mode) => {
    const original = fixture()
    if (mode !== 'explicit') delete original.nodes[2].data.settings!.tileInput
    if (mode === 'tombstone') original.nodes[2].data.settings!.tileInput = { missing: true }
    if (mode === 'legacy' || mode === 'tombstone') original.edges = original.edges.slice(0, 1)
    if (mode === 'batch') {
      original.nodes[1] = { ...original.nodes[1], kind: 'image-grid-split', data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: defaultImageTransformRecipe('grid-split') } } }
      original.edges = [{ ...original.edges[1], sourceHandle: 'out:images' }]
    }
    const portable = sanitizeWorkshopWorkflow(buildWorkshopSelection(original, original.nodes.map((node) => node.id)), 'group', 'Tile')
    const file = buildWorkshopTransferFile({ kind: 'group', name: 'Tile', description: '', category: 'general', tags: [], nodeCount: portable.nodes.length, edgeCount: portable.edges.length, nodeKinds: [...new Set(portable.nodes.map((node) => node.kind))], workflow: portable }, { kind: 'personal' })
    expect(file.version).toBe(mode === 'legacy' ? 1 : 3)
    expect(file.snapshot.workflow?.schemaVersion).toBe(2)
    const reopened = parseWorkshopTransferFile(serializeWorkshopTransferFile(file))
    expect(reopened.version).toBe(file.version)
    expect(selection(reopened.snapshot.workflow!)).toEqual(selection(portable))
  })
  it('strictly rejects malformed and wrong-node settings rather than dropping the choice', () => {
    const original = fixture(), persisted = toPersistedWorkflowV2(original)
    persisted.nodes[2].data.settings!.tileInput = { edgeId: 'private-edge-b', outputIndex: -1 }
    expect(sanitizeWorkflowV2(persisted)).toBeNull()
    original.nodes[2].data.settings!.tileInput = { edgeId: 'private-edge-b', assetId: 'private' }
    expect(() => serializeWorkflow(original)).toThrow('平铺')
    expect(() => sanitizeWorkshopWorkflow(original, 'group', 'Invalid')).toThrow('平铺')
    original.nodes[2].data.settings!.tileInput = { missing: true }
    original.nodes[2].kind = 'image-crop'
    delete original.nodes[2].data.settings!.imageTransform
    expect(() => serializeWorkflow(original)).toThrow('只有平铺')
    expect(() => sanitizeWorkshopWorkflow(original, 'group', 'Wrong type')).toThrow('只有平铺')
  })
})
