import { describe, expect, it } from 'vitest'
import type { CanvasImageAssetSummary } from '../host'
import { createEmptyWorkflow, type WorkflowFile } from '../model'
import { assertCommerceNodeEditable, buildCommerceCandidateComparison, buildCommerceNodeEdit } from './commerce-edit-application'
import { defaultCommerceTask } from './commerce-task'
import { buildCommerceWorkflow } from './commerce-workflow'
import type { UpstreamMediaReference } from '../components/upstream-references'

function asset(character: string): CanvasImageAssetSummary {
  const assetId = character.repeat(43)
  return { assetId, localUrl: `xingmang-asset://image/${assetId}`, thumbnailUrl: `xingmang-asset://image/${assetId}`, mediaType: 'image', mimeType: 'image/png', width: 512, height: 512, fileName: 'fixture.png', displayName: '自绘商品', createdAt: '2026-10-16T00:00:00Z' }
}
function fixture(): WorkflowFile {
  return { ...createEmptyWorkflow('商品任务'), nodes: [
    { id: 'source', kind: 'image-input', position: { x: 0, y: 0 }, data: { prompt: '', model: '', status: 'succeeded', result: { kind: 'image', assetId: asset('a').assetId, localUrl: asset('a').localUrl } } },
    { id: 'task', kind: 'image-edit', position: { x: 400, y: 0 }, data: { prompt: '用户自己填写的补充', model: 'gpt-image-1', status: 'succeeded', settings: { commerceTask: defaultCommerceTask('material-a'), imageReferenceOrder: { version: 1, slots: [{ role: 'source', edgeId: 'base', outputIndex: 0 }] } } } },
    { id: 'other', kind: 'image-generate', position: { x: 400, y: 600 }, data: { prompt: '其他任务', model: 'gpt-image-1', status: 'idle' } },
  ], edges: [
    { id: 'base', source: 'source', sourceHandle: 'out:image', target: 'task', targetHandle: 'in:images' },
    { id: 'shared', source: 'source', sourceHandle: 'out:image', target: 'other', targetHandle: 'in:images' },
  ] }
}
function upstream(): UpstreamMediaReference[] {
  return [{ edgeId: 'base', outputIndex: 0, sourceNodeId: 'source', kind: 'image', status: 'ready', label: '原图', mention: '@原图', relationLabel: '图像输入', asset: { kind: 'image', assetId: asset('a').assetId, localUrl: asset('a').localUrl } }]
}
function ids() { let count = 0; return () => `new-${++count}` }

describe('commerce edit application', () => {
  it('isolates a replaced source and preserves supplement, shared input and analysis links', () => {
    const before = fixture(), original = structuredClone(before)
    before.edges.push({ id: 'analysis', source: 'other', sourceHandle: 'out:text', target: 'task', targetHandle: 'in:text' })
    const result = buildCommerceNodeEdit({ workflow: before, nodeId: 'task', task: { version: 1, kind: 'material-a', preserve: ['shape'], strength: .7 }, references: [{ role: 'source', binding: { kind: 'asset', assetId: asset('b').assetId } }], currentReferences: upstream(), assets: [asset('b')], createId: ids() })
    expect(result.nodes).toHaveLength(4)
    expect(result.nodes.find((node) => node.id === 'source')).toEqual(original.nodes[0])
    expect(result.nodes.find((node) => node.id === 'task')?.data.prompt).toBe('用户自己填写的补充')
    expect(result.edges.map((edge) => edge.id)).toEqual(['shared', 'analysis', 'new-2'])
    expect(before.nodes).toHaveLength(3)
    expect(before.edges.some((edge) => edge.id === 'base')).toBe(true)
  })
  it('rejects missing, changed and duplicate actual reference inputs atomically', () => {
    const before = fixture()
    const input = { workflow: before, nodeId: 'task', task: defaultCommerceTask('style-reference'), currentReferences: upstream(), assets: [], createId: ids() }
    expect(() => buildCommerceNodeEdit({ ...input, references: [{ role: 'source', binding: { kind: 'missing' } }, { role: 'reference', binding: { kind: 'missing' } }] })).toThrow(/重新绑定/)
    expect(() => buildCommerceNodeEdit({ ...input, references: [{ role: 'source', binding: { kind: 'existing', edgeId: 'base', outputIndex: 1 } }, { role: 'reference', binding: { kind: 'missing' } }] })).toThrow(/已变化/)
    expect(() => buildCommerceNodeEdit({ ...input, references: [{ role: 'source', binding: { kind: 'existing', edgeId: 'base', outputIndex: 0 } }, { role: 'reference', binding: { kind: 'existing', edgeId: 'base', outputIndex: 0 } }] })).toThrow(/同一张/)
    expect(before).toEqual(fixture())
  })
  it('fixes comparison to actual asset identities across future generator changes', () => {
    const result = buildCommerceCandidateComparison([asset('a'), asset('b'), asset('c')], { x: 100, y: 200 }, ids())
    expect(result.nodes.slice(0, 3).map((node) => node.data.result?.assetId)).toEqual(['a', 'b', 'c'].map((value) => value.repeat(43)))
    expect(result.edges.every((edge) => result.nodes.some((node) => node.id === edge.source && node.kind === 'image-input'))).toBe(true)
    expect(result.nodes[3].data.settings?.imageCompare).toMatchObject({ mode: 'side-by-side', inputSlots: result.edges.map((edge) => JSON.stringify([edge.id, 0])) })
    expect(() => buildCommerceCandidateComparison([asset('a'), asset('a')], { x: 0, y: 0 }, ids())).toThrow(/不同/)
  })
  it('checks locked or disabled ancestors again before applying a task edit', () => {
    const workflow = fixture()
    workflow.nodes[1].parentId = 'parent'
    workflow.nodes.push({ id: 'parent', kind: 'group', locked: true, position: { x: 1000, y: 1000 }, data: { prompt: '', model: '', status: 'idle' } })
    expect(() => assertCommerceNodeEditable(workflow.nodes, 'task')).toThrow(/上级分组/)
    workflow.nodes[3].locked = false; workflow.nodes[3].disabled = true
    expect(() => assertCommerceNodeEditable(workflow.nodes, 'task')).toThrow(/上级分组/)
    workflow.nodes[3].disabled = false
    const edited = buildCommerceNodeEdit({ workflow, nodeId: 'task', task: defaultCommerceTask('material-a'), references: [{ role: 'source', binding: { kind: 'asset', assetId: asset('b').assetId } }], assets: [asset('b')], currentReferences: upstream(), createId: ids() })
    expect(edited.nodes.find((node) => node.id === 'new-1')?.position).toEqual({ x: 1020, y: 1000 })
  })
  it('forks a shared analysis when one view replaces its subject without changing sibling views', () => {
    const workflow = buildCommerceWorkflow({ tasks: [defaultCommerceTask('product-view'), { version: 1, kind: 'product-view', view: 'left', preserve: ['shape'] }], source: asset('a'), prompt: '', model: 'gpt-image-1', candidateCount: 2, analysis: { model: 'gpt-4.1-mini', prompt: '分析原始商品' }, createId: ids() })
    const task = workflow.nodes.find((node) => node.data.settings?.commerceTask)!, shared = workflow.nodes.find((node) => node.kind === 'text-generate')!
    const source = workflow.nodes.find((node) => node.kind === 'image-input')!, base = workflow.edges.find((edge) => edge.source === source.id && edge.target === task.id)!
    const before = structuredClone(workflow)
    const references = [{ ...upstream()[0], edgeId: base.id, sourceNodeId: source.id }]
    let sequence = 100
    const result = buildCommerceNodeEdit({ workflow, nodeId: task.id, task: defaultCommerceTask('product-view'), references: [{ role: 'source', binding: { kind: 'asset', assetId: asset('b').assetId } }], assets: [asset('b')], currentReferences: references, createId: () => `edit-${++sequence}` })
    const analysis = result.nodes.find((node) => node.kind === 'text-generate' && node.id !== shared.id)!
    expect(analysis.data.prompt).toBe('分析原始商品')
    expect(analysis.data.status).toBe('idle'); expect(analysis.data).not.toHaveProperty('result')
    expect(result.nodes.find((node) => node.id === shared.id)).toEqual(shared)
    expect(result.edges.find((edge) => edge.source === analysis.id && edge.target === task.id)).toBeDefined()
    const sibling = result.nodes.find((node) => node.data.settings?.commerceTask && node.id !== task.id)!
    expect(result.edges.find((edge) => edge.source === shared.id && edge.target === sibling.id)).toBeDefined()
    const analysisInput = result.edges.find((edge) => edge.target === analysis.id && edge.sourceHandle === 'out:image')!
    expect(result.nodes.find((node) => node.id === analysisInput.source)?.data.result?.assetId).toBe(asset('b').assetId)
    expect(workflow).toEqual(before)
  })
})
