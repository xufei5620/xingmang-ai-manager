import { describe, expect, it } from 'vitest'
import { createEmptyWorkflow, type WorkflowFile, type WorkflowNode } from '../model'
import { buildWorkshopSelection, instantiateWorkshopGraph } from '../editor/workshop-graph'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'
import { buildCompareInputSlots, parseImageCompareSettings, portableImageCompareSettings, resolveImageCompareView } from './viewer-settings'

function node(id: string, kind: WorkflowNode['kind'], settings: Record<string, unknown> = {}): WorkflowNode { return { id, kind, definitionVersion: 1, position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'idle', settings } } }
export function agentCompareWorkshopFixture(): WorkflowFile {
  return { ...createEmptyWorkflow('Agent planned comparison'), nodes: [
    node('grid', 'image-grid-split', { imageTransform: { kind: 'grid-split', rows: 2, columns: 3, gap: 0, padding: 0 } }),
    node('photo', 'image-input'),
    node('compare', 'image-compare', { imageCompare: { mode: 'slider', a: '0', b: '1', inputSlots: ['["private-batch",5]', '["private-photo",0]'] } }),
  ], edges: [
    { id: 'private-batch', source: 'grid', sourceHandle: 'out:images', target: 'compare', targetHandle: 'in:images' },
    { id: 'private-photo', source: 'photo', sourceHandle: 'out:image', target: 'compare', targetHandle: 'in:images' },
  ] }
}
function settings(workflow: WorkflowFile) { return parseImageCompareSettings(workflow.nodes.find((node) => node.kind === 'image-compare')!.data.settings!.imageCompare) }
function transfer(workflow: WorkflowFile): WorkflowFile {
  const file = buildWorkshopTransferFile({ kind: 'group', name: 'Agent comparison', description: '', category: 'general', tags: [], nodeCount: workflow.nodes.length, edgeCount: workflow.edges.length, nodeKinds: [...new Set(workflow.nodes.map((node) => node.kind))], workflow }, { kind: 'personal' })
  const decoded = parseWorkshopTransferFile(serializeWorkshopTransferFile(file))
  const hasBindings = workflow.nodes.some((node) => node.kind === 'image-compare' && Object.prototype.hasOwnProperty.call(node.data.settings?.imageCompare ?? {}, 'inputSlots'))
  expect(file.version).toBe(hasBindings ? 2 : 1)
  expect(decoded.version).toBe(file.version)
  if (!decoded.snapshot.workflow) throw new Error('Expected graph fixture')
  return decoded.snapshot.workflow
}

describe('Agent comparison sources across workshop reuse', () => {
  it('requires version two for stable group sources and upgrades a version one wrapper without losing empty tombstones', () => {
    const graph = agentCompareWorkshopFixture()
    for (const slots of [['["private-batch",5]', '["private-photo",0]'], []]) {
      graph.nodes[2].data.settings!.imageCompare = { mode: 'slider', a: 'missing', b: 'missing', inputSlots: slots }
      const file = buildWorkshopTransferFile({ kind: 'group', name: 'Stable sources', description: '', category: 'general', tags: [], nodeCount: 3, edgeCount: 2, nodeKinds: ['image-grid-split', 'image-input', 'image-compare'], workflow: graph }, { kind: 'personal' })
      expect(file.version).toBe(2)
      const original = JSON.stringify(file)
      expect(serializeWorkshopTransferFile(parseWorkshopTransferFile(original))).toBe(original)
      expect(parseWorkshopTransferFile(JSON.stringify({ ...file, version: 1 }))).toEqual(file)
      expect(serializeWorkshopTransferFile({ ...file, version: 1 })).toBe(original)
    }
  })

  it('keeps an unexecuted sixth grid cell and a separate photo through save file import insertion and later expanded inputs', () => {
    const original = agentCompareWorkshopFixture(), before = structuredClone(original)
    original.nodes[1].data.result = { kind: 'image', assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}` }
    const selection = buildWorkshopSelection(original, original.nodes.map((node) => node.id))
    expect(settings(selection)).toMatchObject({ a: '0', b: '1', inputSlots: ['["private-batch",5]', '["private-photo",0]'] })
    const portable = sanitizeWorkshopWorkflow(selection, 'group', 'Agent comparison')
    expect(settings(portable)).toMatchObject({ a: '0', b: '1', inputSlots: ['["edge-1",5]', '["edge-2",0]'] })
    expect(JSON.stringify(portable)).not.toMatch(/private-batch|private-photo|assetId|xingmang-asset/)
    expect(sanitizeWorkshopWorkflow(portable, 'group', 'Agent comparison')).toEqual(portable)
    let id = 0
    const copied = instantiateWorkshopGraph(transfer(portable), () => `copy-${++id}`)
    const batchEdge = copied.edges.find((edge) => edge.sourceHandle === 'out:images')!, photoEdge = copied.edges.find((edge) => edge.sourceHandle === 'out:image')!
    expect(settings(copied).inputSlots).toEqual([JSON.stringify([batchEdge.id, 5]), JSON.stringify([photoEdge.id, 0])])
    for (const count of [6, 8]) {
      const actual = buildCompareInputSlots([...Array.from({ length: count }, () => ({ edgeId: batchEdge.id })), { edgeId: photoEdge.id }])
      expect(resolveImageCompareView(settings(copied), actual)).toMatchObject({ a: '5', b: String(count) })
    }
    expect(settings(original)).toEqual(settings(before))
  })

  it('preserves planned occurrence identity while missing pixels are waiting, then never changes an omitted photo to a batch cell', () => {
    const original = agentCompareWorkshopFixture()
    const portable = sanitizeWorkshopWorkflow(buildWorkshopSelection(original, ['grid', 'compare']), 'group', 'Only grid')
    const compare = settings(portable)
    expect(compare).toMatchObject({ a: '0', b: 'missing', inputSlots: ['["edge-1",5]'] })
    const actual = buildCompareInputSlots(Array.from({ length: 6 }, () => ({ edgeId: 'edge-1' })))
    expect(resolveImageCompareView(compare, actual)).toMatchObject({ a: '5', b: 'missing' })
    const waiting = buildCompareInputSlots([{ edgeId: 'edge-1' }])
    expect(resolveImageCompareView(compare, waiting).a).toBe('missing')
    expect(compare.a).toBe('0')
    expect(resolveImageCompareView(compare, actual).a).toBe('5')
  })

  it('retains standalone index semantics and keeps old position-only group files compatible', () => {
    const original = agentCompareWorkshopFixture()
    const standalone = sanitizeWorkshopWorkflow(buildWorkshopSelection(original, ['compare']), 'node', 'Compare preset')
    expect(settings(standalone)).toEqual({ mode: 'slider', a: '0', b: '1' })
    original.nodes[2].data.settings!.imageCompare = { mode: 'slider', a: '5', b: '6' }
    const old = sanitizeWorkshopWorkflow(original, 'group', 'Legacy indices')
    expect(settings(transfer(old))).toEqual({ mode: 'slider', a: '5', b: '6' })
  })

  it('marks an omitted default A slot missing rather than letting B move into it', () => {
    const saved = portableImageCompareSettings({ mode: 'slider', inputSlots: ['["a",0]', '["b",0]'] }, new Map([['b', 'fresh-b']]))
    expect(saved).toMatchObject({ a: 'missing', b: '0', inputSlots: ['["fresh-b",0]'] })
    expect(resolveImageCompareView(saved, ['["fresh-b",0]'])).toMatchObject({ a: 'missing', b: '0' })
  })

  it('does not retain private or foreign-target edge identities in portable group settings', () => {
    const original = agentCompareWorkshopFixture()
    original.nodes.push(node('other', 'image-compare'))
    original.edges.push({ id: 'foreign-target', source: 'photo', sourceHandle: 'out:image', target: 'other', targetHandle: 'in:images' })
    original.nodes[2].data.settings!.imageCompare = { mode: 'slider', a: '0', b: '1', inputSlots: ['["foreign-target",0]', '["private-photo",0]'] }
    const portable = sanitizeWorkshopWorkflow(original, 'group', 'Safe identities')
    expect(settings(portable)).toMatchObject({ a: 'missing', b: '0', inputSlots: ['["edge-2",0]'] })
    expect(JSON.stringify(portable)).not.toContain('foreign-target')
  })
})
