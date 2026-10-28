import { describe, expect, it } from 'vitest'
import { parseWorkflowFile, serializeWorkflow } from '../model'
import { instantiateWorkshopGraph, buildWorkshopSelection } from '../editor/workshop-graph'
import { sanitizeWorkshopWorkflow } from '../lib/workshop-sanitizer'
import { buildWorkshopTransferFile, parseWorkshopTransferFile, serializeWorkshopTransferFile } from '../lib/workshop-transfer-format'
import { imageTaskWorkflowFixture } from '../lib/image-task.test-fixture'
import { buildCommerceWorkflow } from './commerce-workflow'
import { defaultCommerceTask, type CommerceTaskKind } from './commerce-task'
import { parseImageReferenceOrder } from './image-reference-order'

describe('ordinary commerce graph creation and portable reuse', () => {
  it.each<CommerceTaskKind>(['material-a', 'material-b', 'style-preset', 'style-reference', 'product-view'])('keeps %s configuration through project, workshop and portable eight', (kind) => {
    const original = imageTaskWorkflowFixture(kind, true)
    const parsed = parseWorkflowFile(serializeWorkflow(original))!
    const target = parsed.nodes.find((node) => node.data.settings?.commerceTask)!
    expect(target.data.settings?.commerceTask).toEqual(defaultCommerceTask(kind))
    const snapshot = sanitizeWorkshopWorkflow(parsed, 'group', '参考图任务')
    expect(JSON.stringify(snapshot)).not.toContain('a'.repeat(43))
    expect(JSON.stringify(snapshot)).not.toContain('xingmang-asset:')
    const item = { kind: 'group' as const, name: '参考图任务', description: '', category: 'commerce', tags: [], nodeCount: snapshot.nodes.length, edgeCount: snapshot.edges.length, nodeKinds: [...new Set(snapshot.nodes.map((node) => node.kind))], workflow: snapshot }
    const file = buildWorkshopTransferFile(item, { kind: 'personal' })
    expect(file.version).toBe(8)
    const imported = parseWorkshopTransferFile(serializeWorkshopTransferFile(file)).snapshot.workflow!
    let next = 0
    const copy = instantiateWorkshopGraph(imported, () => `new-${++next}`)
    for (const node of copy.nodes.filter((entry) => entry.data.settings?.imageReferenceOrder)) {
      const order = parseImageReferenceOrder(node.data.settings?.imageReferenceOrder)
      for (const slot of order.slots) {
        expect('edgeId' in slot).toBe(true)
        if ('edgeId' in slot) expect(copy.edges.find((edge) => edge.id === slot.edgeId)?.target).toBe(node.id)
      }
    }
  })
  it('retains a removed external base as a missing slot instead of turning into text-to-image', () => {
    const workflow = imageTaskWorkflowFixture('style-reference')
    const image = workflow.nodes.find((node) => node.data.settings?.commerceTask)!
    const selection = buildWorkshopSelection(workflow, [image.id])
    const stored = sanitizeWorkshopWorkflow(selection, 'node', '单节点')
    expect(parseImageReferenceOrder(stored.nodes[0].data.settings?.imageReferenceOrder).slots).toEqual([{ role: 'source', missing: true }, { role: 'reference', missing: true }])
    expect(stored.nodes[0].data.settings?.commerceTask).toEqual(defaultCommerceTask('style-reference'))
  })
  it('creates six named four-candidate branches with one visible shared analysis and no second group configuration', () => {
    let sequence = 0
    const tasks = (['front', 'back', 'left', 'right', 'three-quarter', 'top'] as const).map((view) => ({ version: 1 as const, kind: 'product-view' as const, preserve: [], view }))
    const graph = buildCommerceWorkflow({ tasks, source: { assetId: 'a'.repeat(43) }, prompt: '', model: 'gpt-image-1', candidateCount: 4, analysis: { model: 'gpt-4.1-mini', prompt: '分析商品' }, createId: () => `id-${++sequence}` })
    const images = graph.nodes.filter((node) => node.data.settings?.commerceTask)
    expect(images).toHaveLength(6)
    expect(images.reduce((sum, node) => sum + (node.data.imageCandidateCount ?? 1), 0)).toBe(24)
    expect(new Set(images.map((node) => node.data.settings?.title)).size).toBe(6)
    expect(graph.nodes.filter((node) => node.kind === 'text-generate')).toHaveLength(1)
    expect(graph.nodes.filter((node) => node.kind === 'group')).toHaveLength(0)
    expect(graph.edges.filter((edge) => edge.sourceHandle === 'out:text')).toHaveLength(6)
    const overviews = graph.nodes.filter((node) => String(node.data.settings?.title).startsWith('商品视角总览'))
    expect(overviews).toHaveLength(2)
    expect(overviews.map((node) => graph.edges.filter((edge) => edge.target === node.id).length * 4)).toEqual([16, 8])
    const groupedViewGalleries = overviews.flatMap((node) => graph.edges.filter((edge) => edge.target === node.id).map((edge) => edge.source))
    expect(new Set(groupedViewGalleries).size).toBe(6)
    expect(graph.edges.every((edge) => edge.sourceHandle === 'out:image' && edge.targetHandle === 'in:images' || edge.sourceHandle === 'out:text' && edge.targetHandle === 'in:text')).toBe(true)
    expect(graph.nodes.some((node) => node.data.status !== 'idle')).toBe(false)
  })
  it('uses the existing mask-capable image-edit kind only for material A', () => {
    expect(imageTaskWorkflowFixture('material-a').nodes.find((node) => node.data.settings?.commerceTask)?.kind).toBe('image-edit')
    const b = imageTaskWorkflowFixture('material-b').nodes.find((node) => node.data.settings?.commerceTask)!
    expect(b.data).toMatchObject({ size: 'auto', imageResolution: '1K' })
    expect(imageTaskWorkflowFixture().nodes.find((node) => node.kind === 'image-input')?.data.result?.localUrl).toBe(`xingmang-asset://image/${'a'.repeat(43)}`)
  })
  it('rejects invalid task settings before project parse or workshop sanitization can erase them', () => {
    for (const invalid of [null, { version: 2 }, { ...defaultCommerceTask('material-a'), nativeDenoise: .5 }]) {
      const graph = imageTaskWorkflowFixture('material-a')
      graph.nodes.find((node) => node.data.settings?.commerceTask)!.data.settings!.commerceTask = invalid
      expect(parseWorkflowFile(JSON.stringify(graph))).toBeNull()
      expect(() => sanitizeWorkshopWorkflow(graph, 'group', '坏格式')).toThrow()
    }
  })
  it('rejects executable run fields misplaced in a project instead of silently removing them', () => {
    for (const key of ['commerceTask', 'imageReferenceOrder']) {
      const graph = imageTaskWorkflowFixture('material-a')
      const node = graph.nodes.find((entry) => entry.data.settings?.commerceTask)!
      Object.assign(node.data, { [key]: node.data.settings?.[key] })
      expect(parseWorkflowFile(JSON.stringify(graph))).toBeNull()
      expect(() => serializeWorkflow(graph)).toThrow('不会丢弃')
      expect(() => sanitizeWorkshopWorkflow(graph, 'group', '字段错位')).toThrow('不会丢弃')
    }
  })
})
