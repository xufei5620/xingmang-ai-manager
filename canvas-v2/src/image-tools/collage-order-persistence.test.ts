import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, serializeWorkflow, parseWorkflowFile, type WorkflowFile } from '../model'
import { buildCanvasClipboardPayload, pasteCanvasClipboard } from '../editor/clipboard'
import { duplicateCanvasNodesForAltDrag } from '../editor/alt-drag'
import { buildWorkshopSelection, instantiateWorkshopGraph } from '../editor/workshop-graph'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'
import { defaultImageTransformRecipe } from './recipe'
import { imageCollageTemplates } from './collage-templates'

function fixture(): WorkflowFile {
  return { ...createEmptyWorkflow('Collage order'), nodes: [
    ...['a', 'b', 'c'].map((id) => ({ id, kind: 'image-input' as const, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle' as const } })),
    { id: 'collage', kind: 'image-collage', definitionVersion: 1, position: { x: 400, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { imageTransform: defaultImageTransformRecipe('collage'), imageCollageInputOrder: { version: 1, slots: ['c', 'a', 'b'].map((id) => ({ edgeId: `edge-${id}`, outputIndex: 0 })) } } } },
  ], edges: ['a', 'b', 'c'].map((id) => ({ id: `edge-${id}`, source: id, sourceHandle: 'out:image', target: 'collage', targetHandle: 'in:images' })) }
}
function order(workflow: WorkflowFile) { return workflow.nodes.find((node) => node.kind === 'image-collage')?.data.settings?.imageCollageInputOrder }
function expected(ids: string[]) { return { version: 1, slots: ids.map((edgeId) => ({ edgeId, outputIndex: 0 })) } }

describe('collage ordering in real persistence and reusable graphs', () => {
  it.each(imageCollageTemplates)('retains $title with its reordered inputs through saves and portable workshop reuse', (template) => {
    const source = fixture()
    source.nodes[3].data.settings!.imageTransform = { ...defaultImageTransformRecipe('collage'), layout: template.layout, autoSize: false, gap: 7, padding: 11 }
    if (template.inputCount === 2) {
      source.nodes = source.nodes.filter((node) => node.id !== 'b')
      source.edges = source.edges.filter((edge) => edge.source !== 'b')
    }
    const restored = parseWorkflowFile(serializeWorkflow(source))!
    const portable = sanitizeWorkshopWorkflow(restored, 'group', template.title)
    const file = buildWorkshopTransferFile({ kind: 'group', name: template.title, description: '', category: 'general', tags: [], nodeCount: portable.nodes.length, edgeCount: portable.edges.length, nodeKinds: ['image-input', 'image-collage'], workflow: portable }, { kind: 'personal' })
    const decoded = parseWorkshopTransferFile(serializeWorkshopTransferFile(file))
    if (decoded.snapshot.kind === 'prompt' || !decoded.snapshot.workflow) throw new Error('Bad fixture')
    let sequence = 0
    const inserted = instantiateWorkshopGraph(decoded.snapshot.workflow, () => `template-${++sequence}`)
    const node = inserted.nodes.find((entry) => entry.kind === 'image-collage')!
    expect(node.data.settings!.imageTransform).toMatchObject({ layout: template.layout, autoSize: false, gap: 7, padding: 11 })
    expect(order(inserted)).toEqual(expected(template.inputCount === 2 ? [inserted.edges[1].id, inserted.edges[0].id] : [inserted.edges[2].id, inserted.edges[0].id, inserted.edges[1].id]))
    expect(order(parseWorkflowFile(serializeWorkflow(inserted))!)).toEqual(order(inserted))
    expect(inserted.nodes.every((entry) => !entry.data.result)).toBe(true)
  })
  it('round-trips saved order and removes disconnected identities without modifying undo data', () => {
    const workflow = fixture()
    expect(order(parseWorkflowFile(serializeWorkflow(workflow))!)).toEqual(order(workflow))
    workflow.edges = workflow.edges.filter((edge) => edge.id !== 'edge-a')
    expect(order(parseWorkflowFile(serializeWorkflow(workflow))!)).toEqual(expected(['edge-c', 'edge-b']))
    expect(order(workflow)).toEqual(expected(['edge-c', 'edge-a', 'edge-b']))
  })
  it('remaps full and partial clipboard copies without borrowing omitted input identities', () => {
    const workflow = fixture(), nodes = workflow.nodes.map(({ kind, ...node }) => ({ ...node, data: { ...node.data }, type: kind, definitionVersion: 1 }))
    for (const ids of [['a', 'b', 'c', 'collage'], ['b', 'c', 'collage']]) {
      const pasted = pasteCanvasClipboard(buildCanvasClipboardPayload(nodes, workflow.edges, new Set(ids)), { offset: { x: 10, y: 10 }, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
      expect(pasted.nodes.find((node) => node.type === 'image-collage')?.data.settings).toMatchObject({ imageCollageInputOrder: expected(ids.includes('a') ? ['new-edge-c', 'new-edge-a', 'new-edge-b'] : ['new-edge-c', 'new-edge-b']) })
    }
  })
  it.each([true, false])('remaps Alt copies with preserve inputs %s', (preserveInputConnections) => {
    const workflow = fixture(), nodes = workflow.nodes.map(({ kind, ...node }) => ({ ...node, data: { ...node.data }, type: kind, definitionVersion: 1 }))
    const copy = duplicateCanvasNodesForAltDrag(nodes, workflow.edges, { nodeIds: ['collage'], preserveInputConnections, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
    expect((copy.nodes[0].data.settings as Record<string, unknown>).imageCollageInputOrder).toEqual(preserveInputConnections ? expected(['new-edge-c', 'new-edge-a', 'new-edge-b']) : undefined)
  })
  it('preserves portable group order through sanitization, file import, and fresh graph insertion', () => {
    const workflow = fixture(), sanitized = sanitizeWorkshopWorkflow(buildWorkshopSelection(workflow, workflow.nodes.map((node) => node.id)), 'group', 'Collage')
    expect(order(sanitized)).toEqual(expected(['edge-3', 'edge-1', 'edge-2']))
    const file = buildWorkshopTransferFile({ kind: 'group', name: 'Collage', description: '', category: 'general', tags: [], nodeCount: 4, edgeCount: 3, nodeKinds: ['image-input', 'image-collage'], workflow: sanitized }, { kind: 'personal' })
    const decoded = parseWorkshopTransferFile(serializeWorkshopTransferFile(file))
    if (decoded.snapshot.kind === 'prompt' || !decoded.snapshot.workflow) throw new Error('Bad fixture')
    let sequence = 0
    const inserted = instantiateWorkshopGraph(decoded.snapshot.workflow, () => `fresh-${++sequence}`)
    expect(order(inserted)).toEqual(expected([inserted.edges[2].id, inserted.edges[0].id, inserted.edges[1].id]))
    expect(JSON.stringify(decoded)).not.toContain('edge-a')
  })
  it('keeps internal positions for partial templates and clears all source identities for node presets', () => {
    const partial = sanitizeWorkshopWorkflow(buildWorkshopSelection(fixture(), ['b', 'c', 'collage']), 'group', 'Partial')
    expect(order(partial)).toEqual(expected(['edge-2', 'edge-1']))
    const single = sanitizeWorkshopWorkflow(buildWorkshopSelection(fixture(), ['collage']), 'node', 'Preset')
    expect(order(single)).toBeUndefined()
  })
  it('rejects malformed persisted or portable ordering rather than silently truncating it', () => {
    const workflow = fixture()
    workflow.nodes[3].data.settings!.imageCollageInputOrder = expected(['edge-a', 'edge-a'])
    expect(() => serializeWorkflow(workflow)).toThrow('重复')
    expect(() => sanitizeWorkshopWorkflow(workflow, 'group', 'Invalid')).toThrow('重复')
  })
})
