import { describe, expect, it } from 'vitest'
import { exteriorTaskWorkflowFixture } from '../lib/exterior-task.test-fixture'
import { assertExteriorNodeEditable, buildExteriorNodeEdit, type ExteriorTaskEditDraft } from './exterior-edit-application'
import { buildExteriorAnalysisPrompt, defaultExteriorTask } from './exterior-task'
import { parseImageReferenceOrder } from '../commerce/image-reference-order'
import type { CanvasImageAssetSummary } from '../host'
import type { UpstreamMediaReference } from '../components/upstream-references'
import { mediaAssetNodeDimensions } from '../library/media-assets'

function asset(id: string): CanvasImageAssetSummary { return { mediaType: 'image', assetId: id.repeat(43), mimeType: 'image/png', fileName: 'own.png', localUrl: `xingmang-asset://image/${id.repeat(43)}`, thumbnailUrl: `xingmang-asset://image/${id.repeat(43)}`, width: 512, height: 2048, createdAt: '2026-10-17T00:00:00Z' } }
function fixture() {
  const workflow = exteriorTaskWorkflowFixture('landscape-redesign'), node = workflow.nodes.find((node) => node.data.settings?.exteriorTask)!
  node.data.status = 'succeeded'; node.data.result = { kind: 'image', assetId: 'z'.repeat(43) }; node.data.candidateAssetIds = ['z'.repeat(43)]; node.data.adoptedCandidateId = 'old-candidate'
  const order = parseImageReferenceOrder(node.data.settings?.imageReferenceOrder)
  const currentReferences: UpstreamMediaReference[] = order.slots.map((slot) => {
    if (!('edgeId' in slot)) throw new Error('fixture')
    const edge = workflow.edges.find((edge) => edge.id === slot.edgeId)!, source = workflow.nodes.find((node) => node.id === edge.source)!
    return { edgeId: edge.id, sourceNodeId: source.id, outputIndex: slot.outputIndex, targetHandle: 'in:images', kind: 'image', status: 'ready', label: slot.role, mention: '@原图', relationLabel: '图像输入', asset: source.data.result! }
  })
  const draft: ExteriorTaskEditDraft = { mode: 'edit', task: defaultExteriorTask('landscape-redesign'), references: order.slots.map((slot) => { if (!('edgeId' in slot)) throw new Error('fixture'); return { role: slot.role, binding: { kind: 'existing', edgeId: slot.edgeId, outputIndex: slot.outputIndex } } }), prompt: '保持原有场地结构', model: 'gpt-image-1', size: '1536x1024', imageResolution: '1K', quality: 'low', imageCandidateCount: 2, analysis: { model: 'gpt-4.1-mini' } }
  let id = 0
  return { workflow, nodeId: node.id, draft, currentReferences, assets: [asset('c')], analysisGroup: 'text-source', createId: () => `edit-${++id}` }
}
describe('exterior edits preserve shared history and stable roles', () => {
  it('forks the visible analysis for option, supplement or model edits and preserves old results and shared consumers', () => {
    const input = fixture(), oldAnalysis = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    oldAnalysis.data.outputText = '旧图分析'; oldAnalysis.data.status = 'succeeded'
    const originalTarget = input.workflow.nodes.find((node) => node.id === input.nodeId)!
    input.workflow.nodes.push({ ...structuredClone(originalTarget), id: 'sibling' })
    input.workflow.edges.push({ id: 'shared-analysis', source: oldAnalysis.id, target: 'sibling', sourceHandle: 'out:text', targetHandle: 'in:text' })
    input.draft.task = defaultExteriorTask('facade-renovation')
    const before = structuredClone(input.workflow), updated = buildExteriorNodeEdit(input)
    expect(input.workflow).toEqual(before)
    expect(updated.nodes.find((node) => node.id === oldAnalysis.id)).toEqual(oldAnalysis)
    expect(updated.edges.find((edge) => edge.id === 'shared-analysis')).toEqual(before.edges.at(-1))
    const newAnalysis = updated.nodes.find((node) => node.kind === 'text-generate' && node.id !== oldAnalysis.id)!
    expect(newAnalysis.data).toMatchObject({ model: 'gpt-4.1-mini', group: 'text-source', prompt: buildExteriorAnalysisPrompt(input.draft.task), status: 'idle', dirty: true })
    const target = updated.nodes.find((node) => node.id === input.nodeId)!
    expect(target.data).toMatchObject({ result: originalTarget.data.result, candidateAssetIds: originalTarget.data.candidateAssetIds, adoptedCandidateId: 'old-candidate', prompt: input.draft.prompt })
    expect(updated.edges.filter((edge) => edge.target === input.nodeId && edge.targetHandle === 'in:text')).toEqual([{ id: expect.any(String), source: newAnalysis.id, target: input.nodeId, sourceHandle: 'out:text', targetHandle: 'in:text' }])
  })
  it('updates an exclusive analysis in place while retaining its previous output and dirtying the new configuration', () => {
    const input = fixture(), previous = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    previous.data.outputText = '上一版可见分析'; previous.data.status = 'succeeded'
    const before = structuredClone(input.workflow), updated = buildExteriorNodeEdit(input)
    expect(updated.nodes.filter((node) => node.kind === 'text-generate')).toHaveLength(1)
    expect(updated.nodes.find((node) => node.id === previous.id)?.data).toMatchObject({ outputText: '上一版可见分析', status: 'succeeded', dirty: true, model: 'gpt-4.1-mini', group: 'text-source' })
    expect(input.workflow).toEqual(before)
  })
  it('places a tall private replacement without moving or covering the original source', () => {
    const input = fixture(); input.draft.references[0].binding = { kind: 'asset', assetId: asset('c').assetId }
    const before = structuredClone(input.workflow), result = buildExteriorNodeEdit(input), replacement = result.nodes.find((node) => node.kind === 'image-input' && node.data.result?.assetId === asset('c').assetId)!
    expect(replacement).toMatchObject(mediaAssetNodeDimensions(asset('c')))
    for (const old of before.nodes) {
      expect(result.nodes.find((node) => node.id === old.id)?.position).toEqual(old.position)
      if (old.kind === 'image-input') { const size = mediaAssetNodeDimensions(old.data.result!); expect(replacement.position.x < old.position.x + size.width + 28 && replacement.position.x + replacement.width! + 28 > old.position.x && replacement.position.y < old.position.y + size.height + 28 && replacement.position.y + replacement.height! + 28 > old.position.y).toBe(false) }
    }
    const target = result.nodes.find((node) => node.id === input.nodeId)!, analysis = result.nodes.filter((node) => node.kind === 'text-generate').at(-1)!
    const targetOrder = parseImageReferenceOrder(target.data.settings?.imageReferenceOrder), analysisOrder = parseImageReferenceOrder(analysis.data.settings?.imageReferenceOrder)
    for (let i = 0; i < 2; i++) { const targetSlot = targetOrder.slots[i], analysisSlot = analysisOrder.slots[i]; if (!('edgeId' in targetSlot) || !('edgeId' in analysisSlot)) throw new Error('missing slot'); expect(result.edges.find((edge) => edge.id === targetSlot.edgeId)?.source).toBe(result.edges.find((edge) => edge.id === analysisSlot.edgeId)?.source) }
    expect(input.workflow).toEqual(before)
  })
  it.each(['extra-image', 'foreign-analysis', 'analysis-extra-text', 'wrong-text-port', 'candidate-missing', 'mask', 'locked', 'cyclic-parent'])('rejects %s without changing old graph or analysis', (mode) => {
    const input = fixture(), target = input.workflow.nodes.find((node) => node.id === input.nodeId)!, analysis = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    if (mode === 'extra-image') input.workflow.edges.push({ ...input.workflow.edges.find((edge) => edge.target === target.id && edge.targetHandle === 'in:images')!, id: 'unassigned' })
    if (mode === 'foreign-analysis') analysis.data.prompt = '另一项任务的旧分析'
    if (mode === 'analysis-extra-text') input.workflow.edges.push({ id: 'extra-text', source: target.id, target: analysis.id, sourceHandle: 'out:text', targetHandle: 'in:text' })
    if (mode === 'wrong-text-port') input.workflow.edges.find((edge) => edge.target === target.id && edge.targetHandle === 'in:text')!.sourceHandle = 'out:image'
    if (mode === 'candidate-missing') delete (input.draft as Partial<ExteriorTaskEditDraft>).imageCandidateCount
    if (mode === 'mask') { target.data.settings!.imageEditMask = { version: 1, sourceAssetId: 'a'.repeat(43), width: 512, height: 512, strokes: [{ tool: 'brush', size: .1, points: [{ x: .5, y: .5 }] }] }; input.draft.references[0].binding = { kind: 'asset', assetId: asset('c').assetId } }
    if (mode === 'locked') target.locked = true
    if (mode === 'cyclic-parent') target.parentId = target.id
    const before = structuredClone(input.workflow)
    expect(() => buildExteriorNodeEdit(input)).toThrow(); expect(input.workflow).toEqual(before)
  })
  it('turns automatic prompting off by disconnecting only this task and keeping the old analysis visible', () => {
    const input = fixture(), old = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    input.draft.task = { version: 1, kind: 'landscape-redesign', automaticPrompt: false }; delete input.draft.analysis
    const updated = buildExteriorNodeEdit(input)
    expect(updated.nodes.find((node) => node.id === old.id)).toEqual({ ...old, disabled: true })
    expect(updated.edges.some((edge) => edge.target === input.nodeId && edge.targetHandle === 'in:text')).toBe(false)
    expect(updated.nodes.filter((node) => node.kind === 'text-generate')).toHaveLength(1)
  })
  it('rejects malformed original semantics rather than changing them to defaults', () => {
    const input = fixture(); input.workflow.nodes.find((node) => node.id === input.nodeId)!.data.settings!.exteriorTask = null
    expect(() => assertExteriorNodeEditable(input.workflow.nodes, input.nodeId)).toThrow()
  })
})
