import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, parseWorkflowFile, serializeWorkflow, type WorkflowFile } from '../model'
import { buildCompareInputSlots, resolveImageCompareView } from './viewer-settings'
import { buildCanvasClipboardPayload, pasteCanvasClipboard } from '../editor/clipboard'
import { duplicateCanvasNodesForAltDrag } from '../editor/alt-drag'
import { buildWorkshopSelection, instantiateWorkshopGraph } from '../editor/workshop-graph'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'

function fixture(): WorkflowFile {
  const slots = buildCompareInputSlots([{ edgeId: 'edge-a' }, { edgeId: 'edge-b' }])
  return { ...createEmptyWorkflow('Viewer persistence'), nodes: [
    ...['a', 'b'].map((id) => ({ id, kind: 'image-input' as const, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle' as const } })),
    { id: 'compare', kind: 'image-compare', definitionVersion: 1, position: { x: 300, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { imageCompare: { mode: 'grid', position: 27, a: '1', b: '0', grid: ['1', '0', null, 'missing'], inputSlots: slots } } } },
    { id: 'panorama', kind: 'image-panorama', definitionVersion: 1, position: { x: 600, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings: { imagePanorama: { yaw: 270, pitch: -35, fov: 80 } } } },
  ], edges: [
    { id: 'edge-a', source: 'a', sourceHandle: 'out:image', target: 'compare', targetHandle: 'in:images' },
    { id: 'edge-b', source: 'b', sourceHandle: 'out:image', target: 'compare', targetHandle: 'in:images' },
  ] }
}

function editorFixture() {
  const graph = fixture()
  return { nodes: graph.nodes.map(({ kind, ...node }) => ({ ...node, definitionVersion: node.definitionVersion ?? 1, data: { ...node.data }, type: kind })), edges: graph.edges }
}

function tripleFixture(): WorkflowFile {
  const workflow = fixture()
  workflow.nodes.push({ id: 'c', kind: 'image-input', definitionVersion: 1, position: { x: 0, y: 300 }, data: { prompt: '', model: '', status: 'idle' } })
  workflow.edges.push({ id: 'edge-c', source: 'c', sourceHandle: 'out:image', target: 'compare', targetHandle: 'in:images' })
  workflow.nodes[2].data.settings = { imageCompare: { mode: 'side-by-side', sideBySideCount: 3, position: 27, a: '1', b: '0', c: '2', grid: ['1', '0', null, 'missing'], inputSlots: buildCompareInputSlots(workflow.edges.map((edge) => ({ edgeId: edge.id }))) } }
  return workflow
}

describe('image viewer persistence and graph copies', () => {
  it.each(['opacity', 'toggle'] as const)('round-trips %s settings and explicit zero/false through private projects and portable templates', (mode) => {
    const workflow = tripleFixture()
    const settings = { ...(workflow.nodes[2].data.settings!.imageCompare as Record<string, unknown>), mode, opacity: 0, overlayVisible: false }
    workflow.nodes[2].data.settings!.imageCompare = settings
    expect(parseWorkflowFile(serializeWorkflow(workflow))!.nodes[2].data.settings?.imageCompare).toEqual(settings)
    const saved = sanitizeWorkshopWorkflow(workflow, 'group', 'Overlay comparison')
    expect(saved.nodes[2].data.settings?.imageCompare).toMatchObject({ mode, position: 27, opacity: 0, overlayVisible: false, sideBySideCount: 3, c: '2' })
    expect(saved.nodes[2].data.settings?.imageCompare).toMatchObject({ inputSlots: buildCompareInputSlots(saved.edges.map((edge) => ({ edgeId: edge.id }))) })
    expect(JSON.stringify(saved)).not.toContain('edge-a')
    const file = buildWorkshopTransferFile({ kind: 'group', name: 'Overlay comparison', description: '', category: 'general', tags: [], nodeCount: saved.nodes.length, edgeCount: saved.edges.length, nodeKinds: [...new Set(saved.nodes.map((node) => node.kind))], workflow: saved }, { kind: 'personal' })
    const encoded = serializeWorkshopTransferFile(file)
    expect(parseWorkshopTransferFile(encoded)).toEqual(file)
    let sequence = 0
    const inserted = instantiateWorkshopGraph(workflow, () => `overlay-${++sequence}`)
    expect(resolveImageCompareView(inserted.nodes[2].data.settings?.imageCompare, buildCompareInputSlots(inserted.edges.map((edge) => ({ edgeId: edge.id }))))).toMatchObject({ mode, a: '1', b: '0', c: '2', opacity: 0, overlayVisible: false })
  })

  it('preserves triple comparison across project round-trips and portable workshop file round-trips', () => {
    const original = tripleFixture()
    const restored = parseWorkflowFile(serializeWorkflow(original))!
    expect(restored.nodes[2].data.settings).toEqual(original.nodes[2].data.settings)
    const saved = sanitizeWorkshopWorkflow(original, 'group', 'Triple comparison')
    const compare = saved.nodes.find((node) => node.kind === 'image-compare')!
    expect(compare.data.settings).toEqual({ imageCompare: { mode: 'side-by-side', sideBySideCount: 3, position: 27, a: '1', b: '0', c: '2', grid: ['1', '0', null, 'missing'], inputSlots: buildCompareInputSlots(saved.edges.map((edge) => ({ edgeId: edge.id }))) } })
    const file = buildWorkshopTransferFile({ kind: 'group', name: 'Triple comparison', description: '', category: 'general', tags: [], nodeCount: saved.nodes.length, edgeCount: saved.edges.length, nodeKinds: [...new Set(saved.nodes.map((node) => node.kind))], workflow: saved }, { kind: 'personal' })
    const encoded = serializeWorkshopTransferFile(file)
    expect(encoded).not.toContain('edge-a')
    expect(encoded).toContain('inputSlots')
    expect(parseWorkshopTransferFile(encoded)).toEqual(file)
    expect(serializeWorkshopTransferFile(parseWorkshopTransferFile(encoded))).toBe(encoded)
  })

  it('keeps the third selected source when a partial clipboard copy renumbers its input', () => {
    const original = tripleFixture()
    const nodes = original.nodes.map(({ kind, ...node }) => ({ ...node, definitionVersion: node.definitionVersion ?? 1, data: { ...node.data }, type: kind }))
    const pasted = pasteCanvasClipboard(buildCanvasClipboardPayload(nodes, original.edges, new Set(['c', 'compare'])), { offset: { x: 0, y: 0 }, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
    const compare = pasted.nodes.find((node) => node.type === 'image-compare')!
    expect(resolveImageCompareView((compare.data.settings as Record<string, unknown>).imageCompare, buildCompareInputSlots(pasted.edges.map((edge) => ({ edgeId: edge.id }))))).toMatchObject({ a: 'missing', b: 'missing', c: '0', sideBySideCount: 3 })
    expect(original.nodes[2].data.settings?.imageCompare).toMatchObject({ c: '2' })
  })

  it.each([false, true])('preserves triple view while Alt-drag retained inputs=%s', (preserveInputConnections) => {
    const original = tripleFixture()
    const nodes = original.nodes.map(({ kind, ...node }) => ({ ...node, definitionVersion: node.definitionVersion ?? 1, data: { ...node.data }, type: kind }))
    const copied = duplicateCanvasNodesForAltDrag(nodes, original.edges, { nodeIds: ['compare'], preserveInputConnections, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
    expect(resolveImageCompareView((copied.nodes[0].data.settings as Record<string, unknown>).imageCompare, buildCompareInputSlots(copied.edges.map((edge) => ({ edgeId: edge.id }))))).toMatchObject({ sideBySideCount: 3, c: preserveInputConnections ? '2' : 'missing' })
  })

  it('rebases the third choice in partial group templates and retains it in standalone templates', () => {
    const workflow = tripleFixture()
    const selected = sanitizeWorkshopWorkflow(buildWorkshopSelection(workflow, ['c', 'compare']), 'group', 'Partial triple comparison')
    expect(selected.nodes.find((node) => node.kind === 'image-compare')?.data.settings?.imageCompare).toMatchObject({ sideBySideCount: 3, a: 'missing', b: 'missing', c: '0' })
    expect(selected.nodes.find((node) => node.kind === 'image-compare')?.data.settings?.imageCompare).toMatchObject({ inputSlots: ['["edge-1",0]'] })
    expect(JSON.stringify(selected)).not.toContain('edge-c')
    const standalone = sanitizeWorkshopWorkflow(buildWorkshopSelection(workflow, ['compare']), 'node', 'Triple comparison positions')
    expect(standalone.nodes[0].data.settings?.imageCompare).toMatchObject({ sideBySideCount: 3, c: '2' })
    let sequence = 0
    const inserted = instantiateWorkshopGraph(workflow, () => `triple-${++sequence}`)
    expect(resolveImageCompareView(inserted.nodes.find((node) => node.kind === 'image-compare')?.data.settings?.imageCompare, buildCompareInputSlots(inserted.edges.map((edge) => ({ edgeId: edge.id }))))).toMatchObject({ sideBySideCount: 3, c: '2' })
  })

  it.each([null, 'missing'] as const)('keeps explicit third selection %s through persistence and workshop sanitization', (c) => {
    const workflow = tripleFixture()
    workflow.nodes[2].data.settings!.imageCompare = { ...(workflow.nodes[2].data.settings!.imageCompare as Record<string, unknown>), c }
    expect(parseWorkflowFile(serializeWorkflow(workflow))!.nodes[2].data.settings?.imageCompare).toMatchObject({ c })
    expect(sanitizeWorkshopWorkflow(workflow, 'group', 'No replacement').nodes[2].data.settings?.imageCompare).toMatchObject({ c })
  })

  it('round-trips compare arrays and panorama through the real project serializer and reader', () => {
    const original = fixture(), restored = parseWorkflowFile(serializeWorkflow(original))!
    expect(restored.nodes.map((node) => node.data.settings)).toEqual(original.nodes.map((node) => node.data.settings))
    expect(parseWorkflowFile(serializeWorkflow(restored))).toEqual(restored)
  })

  it('remaps identities for complete clipboard copies and keeps selections in the same source slots', () => {
    const graph = editorFixture()
    const pasted = pasteCanvasClipboard(buildCanvasClipboardPayload(graph.nodes, graph.edges, new Set(graph.nodes.map((node) => node.id))), { offset: { x: 20, y: 20 }, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
    const compare = pasted.nodes.find((node) => node.type === 'image-compare')!
    expect(compare.data.settings).toMatchObject({ imageCompare: { inputSlots: ['["new-edge-a",0]', '["new-edge-b",0]'] } })
    expect(resolveImageCompareView((compare.data.settings as Record<string, unknown>).imageCompare, buildCompareInputSlots(pasted.edges.map((edge) => ({ edgeId: edge.id }))))).toMatchObject({ a: '1', b: '0' })
    expect(graph.nodes[2].data.settings).toMatchObject({ imageCompare: { inputSlots: ['["edge-a",0]', '["edge-b",0]'] } })
  })

  it('keeps partial clipboard selection on the copied source while leaving the omitted source missing', () => {
    const graph = editorFixture()
    const pasted = pasteCanvasClipboard(buildCanvasClipboardPayload(graph.nodes, graph.edges, new Set(['b', 'compare'])), { offset: { x: 0, y: 0 }, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
    const compare = pasted.nodes.find((node) => node.type === 'image-compare')!
    expect(resolveImageCompareView((compare.data.settings as Record<string, unknown>).imageCompare, buildCompareInputSlots(pasted.edges.map((edge) => ({ edgeId: edge.id }))))).toMatchObject({ a: '0', b: 'missing' })
  })

  it.each([false, true])('maps Alt-drag input identities with retained connections=%s', (preserveInputConnections) => {
    const graph = editorFixture()
    const copied = duplicateCanvasNodesForAltDrag(graph.nodes, graph.edges, { nodeIds: ['compare'], preserveInputConnections, createNodeId: (id) => `new-${id}`, createEdgeId: (id) => `new-${id}` })
    expect(resolveImageCompareView((copied.nodes[0].data.settings as Record<string, unknown>).imageCompare, buildCompareInputSlots(copied.edges.map((edge) => ({ edgeId: edge.id }))))).toMatchObject(preserveInputConnections ? { a: '1', b: '0' } : { a: 'missing', b: 'missing' })
  })

  it('maps raw workflow insertion and preserves panorama without changing source project identities', () => {
    const original = fixture()
    let sequence = 0
    const inserted = instantiateWorkshopGraph(original, () => `new-${++sequence}`)
    const compare = inserted.nodes.find((node) => node.kind === 'image-compare')!
    expect(resolveImageCompareView(compare.data.settings?.imageCompare, buildCompareInputSlots(inserted.edges.map((edge) => ({ edgeId: edge.id }))))).toMatchObject({ a: '1', b: '0' })
    expect(inserted.nodes.find((node) => node.kind === 'image-panorama')?.data.settings).toEqual(original.nodes[3].data.settings)
  })

  it('remaps graph identities for group workshop and transfer while retaining source selections and view angles', () => {
    const saved = sanitizeWorkshopWorkflow(fixture(), 'group', 'Reusable viewers')
    expect(saved.nodes[2].data.settings).toEqual({ imageCompare: { mode: 'grid', position: 27, a: '1', b: '0', grid: ['1', '0', null, 'missing'], inputSlots: ['["edge-1",0]', '["edge-2",0]'] } })
    expect(saved.nodes[3].data.settings).toEqual({ imagePanorama: { yaw: 270, pitch: -35, fov: 80 } })
    const file = buildWorkshopTransferFile({ kind: 'group', name: 'Reusable viewers', description: '', category: 'general', tags: [], nodeCount: saved.nodes.length, edgeCount: saved.edges.length, nodeKinds: [...new Set(saved.nodes.map((node) => node.kind))], workflow: saved }, { kind: 'personal' })
    const encoded = serializeWorkshopTransferFile(file)
    expect(encoded).not.toContain('edge-a')
    expect(parseWorkshopTransferFile(encoded)).toEqual(file)
  })

  it('rebases a partial group selection onto local identities and never retargets an omitted source', () => {
    const selected = buildWorkshopSelection(fixture(), ['b', 'compare'])
    const saved = sanitizeWorkshopWorkflow(selected, 'group', 'Partial viewers')
    expect(saved.nodes.find((node) => node.kind === 'image-compare')?.data.settings).toMatchObject({ imageCompare: { a: '0', b: 'missing', grid: ['0', 'missing', null, 'missing'] } })
    expect(saved.nodes.find((node) => node.kind === 'image-compare')?.data.settings?.imageCompare).toMatchObject({ inputSlots: ['["edge-1",0]'] })
    expect(JSON.stringify(saved)).not.toContain('edge-b')
  })

  it('retains reusable indices for an intentionally standalone compare preset', () => {
    const selected = buildWorkshopSelection(fixture(), ['compare'])
    const saved = sanitizeWorkshopWorkflow(selected, 'node', 'Compare positions')
    expect(saved.nodes[0].data.settings).toEqual({ imageCompare: { mode: 'grid', position: 27, a: '1', b: '0', grid: ['1', '0', null, 'missing'] } })
  })

  it.each([
    ['image-compare', 'imageCompare', { mode: 'grid', grid: ['0', '1', '2', 'https://private.invalid'] }],
    ['image-compare', 'imageCompare', { mode: 'slider', inputSlots: ['not-json'] }],
    ['image-compare', 'imageCompare', { mode: 'side-by-side', sideBySideCount: 4 }],
    ['image-compare', 'imageCompare', { mode: 'side-by-side', sideBySideCount: 3, c: 'https://private.invalid' }],
    ['image-compare', 'imageCompare', { mode: 'opacity', opacity: 101 }],
    ['image-compare', 'imageCompare', { mode: 'toggle', overlayVisible: 'false' }],
    ['image-panorama', 'imagePanorama', { yaw: 0, pitch: 0, fov: 75, url: 'https://private.invalid' }],
    ['image-panorama', 'imagePanorama', { yaw: 0, pitch: 0, fov: 900 }],
  ] as const)('rejects malformed %s settings before saving or portable sanitization', (kind, key, value) => {
    const graph = fixture(); graph.nodes[2].kind = kind; graph.nodes[2].data.settings = { [key]: value }
    expect(() => serializeWorkflow(graph)).toThrow()
    expect(() => sanitizeWorkshopWorkflow(graph, 'group', 'Invalid')).toThrow()
  })
})
