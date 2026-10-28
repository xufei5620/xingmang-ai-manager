import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CanvasImageAssetSummary } from '../host'
import type { WorkflowFile, WorkflowNode } from '../model'
import type { UpstreamMediaReference } from '../components/upstream-references'
import type { EditorNodeRecord } from '../domain/node-definition'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { parseImageReferenceOrder } from '../commerce/image-reference-order'
import { mediaAssetNodeDimensions } from '../library/media-assets'
import { officialPromptSnapshot, parsePromptReferences } from '../library/prompt-references'
import { createCanvasDocument } from '../store/canvas-state'
import { useCanvasDocument, type CanvasDocumentController } from '../store/use-canvas-document'
import { buildStoryboardWorkflow } from './storyboard-workflow'
import { assertStoryboardNodeEditable, buildStoryboardNodeEdit, buildStoryboardPromptEdit, type StoryboardNodeEditInput, type StoryboardTaskEditDraft } from './storyboard-edit-application'
import { buildStoryboardAnalysisPrompt, defaultStoryboardTask } from './storyboard-task'

function asset(id: string): CanvasImageAssetSummary { return { mediaType: 'image', assetId: id.repeat(43), mimeType: 'image/png', fileName: 'own.png', localUrl: `xingmang-asset://image/${id.repeat(43)}`, thumbnailUrl: `xingmang-asset://image/${id.repeat(43)}`, width: 512, height: 2048, createdAt: '2026-10-18T00:00:00Z' } }
function currentReferences(workflow: WorkflowFile, node: WorkflowNode): UpstreamMediaReference[] {
  return parseImageReferenceOrder(node.data.settings?.imageReferenceOrder).slots.map((slot) => {
    if (!('edgeId' in slot)) throw new Error('Missing fixture slot')
    const edge = workflow.edges.find((entry) => entry.id === slot.edgeId)!, source = workflow.nodes.find((entry) => entry.id === edge.source)!
    return { edgeId: edge.id, sourceNodeId: source.id, outputIndex: slot.outputIndex, targetHandle: 'in:images', kind: 'image', status: 'ready', label: slot.role, mention: '@图片', relationLabel: '图像输入', asset: source.data.result! }
  })
}
function fixture(count = 2): StoryboardNodeEditInput {
  let serial = 0
  const task = defaultStoryboardTask(), workflow = buildStoryboardWorkflow({ task, sources: Array.from({ length: count }, (_, index) => ({ assetId: String.fromCharCode(97 + index).repeat(43), width: 512, height: 512 })), prompt: '原剧情', model: 'gpt-image-1', size: '1536x1024', quality: 'low', imageResolution: '1K', candidateCount: 2, analysis: { model: 'gpt-4.1' }, createId: () => `create-${++serial}` })
  const node = workflow.nodes.find((entry) => entry.data.settings?.storyboardTask)!
  node.data.status = 'succeeded'; node.data.result = { kind: 'image', assetId: 'z'.repeat(43) }; node.data.candidateAssetIds = ['z'.repeat(43)]; node.data.adoptedCandidateId = 'old-candidate'
  const references = currentReferences(workflow, node), order = parseImageReferenceOrder(node.data.settings?.imageReferenceOrder)
  const draft: StoryboardTaskEditDraft = { mode: 'edit', task, references: order.slots.map((slot) => { if (!('edgeId' in slot)) throw new Error('Missing fixture'); return { role: slot.role, binding: { kind: 'existing', edgeId: slot.edgeId, outputIndex: slot.outputIndex } } }), prompt: '新剧情补充', model: 'gpt-image-1', size: '1536x1024', quality: 'low', imageResolution: '1K', imageCandidateCount: 3, analysis: { model: 'gpt-4.1-mini' } }
  return { workflow, nodeId: node.id, draft, currentReferences: references, assets: [asset('e')], analysisGroup: 'vision-provider', createId: () => `edit-${++serial}` }
}
function sourceIdentities(workflow: WorkflowFile, node: WorkflowNode) {
  return parseImageReferenceOrder(node.data.settings?.imageReferenceOrder).slots.map((slot) => {
    if (!('edgeId' in slot)) throw new Error('Missing fixture')
    const edge = workflow.edges.find((entry) => entry.id === slot.edgeId)!
    return [slot.role, edge.source, edge.sourceHandle, slot.outputIndex]
  })
}
function controller(workflow: WorkflowFile): CanvasDocumentController {
  let captured: CanvasDocumentController | undefined
  function project(record: EditorNodeRecord): CanvasNode { return { ...record, type: record.type as CanvasNode['type'], data: { prompt: '', model: '', status: 'idle', ...record.data } } }
  function Capture() { captured = useCanvasDocument(project); return null }
  renderToStaticMarkup(createElement(Capture))
  if (!captured) throw new Error('Missing document controller')
  captured.execute({ type: 'replace-document', resetHistory: true, document: { ...createCanvasDocument(workflow.name), nodes: records(workflow), edges: workflow.edges } })
  return captured
}
function records(workflow: WorkflowFile): EditorNodeRecord[] { return workflow.nodes.map(({ kind, ...node }) => ({ ...node, data: { ...node.data }, type: kind, definitionVersion: node.definitionVersion ?? 1 })) }

describe('storyboard editing transactions', () => {
  it('updates an exclusive analysis, keeping prior text and adopted image results visible', () => {
    const input = fixture(), oldAnalysis = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    oldAnalysis.data.outputText = '旧的剧情结果'; oldAnalysis.data.status = 'succeeded'
    const before = structuredClone(input.workflow), result = buildStoryboardNodeEdit(input), analysis = result.nodes.find((node) => node.id === oldAnalysis.id)!, target = result.nodes.find((node) => node.id === input.nodeId)!
    expect(input.workflow).toEqual(before)
    expect(result.nodes.filter((node) => node.kind === 'text-generate')).toHaveLength(1)
    expect(analysis.data).toMatchObject({ outputText: '旧的剧情结果', status: 'succeeded', dirty: true, prompt: buildStoryboardAnalysisPrompt(input.draft.task, input.draft.prompt), model: 'gpt-4.1-mini', group: 'vision-provider' })
    expect(target.data).toMatchObject({ dirty: true, status: 'succeeded', result: { assetId: 'z'.repeat(43) }, adoptedCandidateId: 'old-candidate', candidateAssetIds: ['z'.repeat(43)], imageCandidateCount: 3 })
    expect(result.nodes.find((node) => node.kind === 'gallery')?.data.dirty).toBe(true)
    expect(sourceIdentities(result, target)).toEqual(sourceIdentities(result, analysis))
  })
  it.each(['shared', 'locked', 'locked-parent'])('clones %s analysis without changing its history or other consumers', (mode) => {
    const input = fixture(), old = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    old.data.outputText = '原分析'; old.data.status = 'succeeded'
    if (mode === 'shared') input.workflow.edges.push({ id: 'other-consumer', source: old.id, target: 'another-task', sourceHandle: 'out:text', targetHandle: 'in:text' })
    if (mode === 'locked') old.locked = true
    if (mode === 'locked-parent') { old.parentId = 'locked-group'; input.workflow.nodes.push({ id: 'locked-group', kind: 'group', locked: true, position: { x: 300, y: 200 }, data: { prompt: '', model: '', status: 'idle' } }) }
    const before = structuredClone(input.workflow), result = buildStoryboardNodeEdit(input)
    expect(result.nodes.find((node) => node.id === old.id)).toEqual(old)
    const replacement = result.nodes.find((node) => node.kind === 'text-generate' && node.id !== old.id)!
    expect(replacement.data).toMatchObject({ dirty: true, status: 'idle', prompt: buildStoryboardAnalysisPrompt(input.draft.task, input.draft.prompt) })
    expect(replacement.data.outputText).toBeUndefined()
    if (mode === 'shared') expect(result.edges.find((edge) => edge.id === 'other-consumer')).toEqual(before.edges.at(-1))
    expect(input.workflow).toEqual(before)
  })
  it('reorders four identities and renumbers roles without replacing existing source nodes', () => {
    const input = fixture(4), previous = [...input.draft.references], oldSources = input.workflow.nodes.filter((node) => node.kind === 'image-input')
    input.draft.references = [previous[3], previous[1], previous[0], previous[2]]
    const result = buildStoryboardNodeEdit(input), target = result.nodes.find((node) => node.id === input.nodeId)!, analysis = result.nodes.find((node) => node.kind === 'text-generate')!
    expect(sourceIdentities(result, target).map((entry) => [entry[0], entry[1]])).toEqual([['source', oldSources[3].id], ['reference', oldSources[1].id], ['reference', oldSources[0].id], ['reference', oldSources[2].id]])
    expect(sourceIdentities(result, target)).toEqual(sourceIdentities(result, analysis))
    for (const source of oldSources) expect(result.nodes.find((node) => node.id === source.id)).toEqual(source)
  })
  it('adds a tall private image while leaving originals and their positions untouched', () => {
    const input = fixture(); input.draft.references = [...input.draft.references, { role: 'reference', binding: { kind: 'asset', assetId: asset('e').assetId } }]
    const before = structuredClone(input.workflow), result = buildStoryboardNodeEdit(input), replacement = result.nodes.find((node) => node.data.result?.assetId === asset('e').assetId)!
    expect(replacement).toMatchObject(mediaAssetNodeDimensions(asset('e')))
    for (const old of before.nodes) {
      expect(result.nodes.find((node) => node.id === old.id)?.position).toEqual(old.position)
      if (old.kind !== 'image-input') continue
      const size = mediaAssetNodeDimensions(old.data.result!)
      expect(replacement.position.x < old.position.x + size.width + 28 && replacement.position.x + replacement.width! + 28 > old.position.x && replacement.position.y < old.position.y + size.height + 28 && replacement.position.y + replacement.height! + 28 > old.position.y).toBe(false)
    }
    expect(parseImageReferenceOrder(result.nodes.find((node) => node.id === input.nodeId)!.data.settings?.imageReferenceOrder).slots).toHaveLength(3)
    expect(input.workflow).toEqual(before)
  })
  it('keeps ordered outputIndex identities from a stable grid edge', () => {
    const input = fixture(1), source = input.workflow.nodes.find((node) => node.kind === 'image-input')!, target = input.workflow.nodes.find((node) => node.id === input.nodeId)!, analysis = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    source.kind = 'image-grid-split'; source.data.settings = { imageTransform: { kind: 'grid-split', rows: 2, columns: 2, gap: 0, padding: 0 } }
    const targetEdge = input.workflow.edges.find((edge) => edge.source === source.id && edge.target === target.id)!, analysisEdge = input.workflow.edges.find((edge) => edge.source === source.id && edge.target === analysis.id)!
    targetEdge.sourceHandle = analysisEdge.sourceHandle = 'out:images'
    target.data.settings!.imageReferenceOrder = { version: 1, slots: [{ role: 'source', edgeId: targetEdge.id, outputIndex: 0 }, { role: 'reference', edgeId: targetEdge.id, outputIndex: 1 }] }
    analysis.data.settings!.imageReferenceOrder = { version: 1, slots: [{ role: 'source', edgeId: analysisEdge.id, outputIndex: 0 }, { role: 'reference', edgeId: analysisEdge.id, outputIndex: 1 }] }
    input.currentReferences = [{ ...input.currentReferences[0], outputIndex: 0 }, { ...input.currentReferences[0], outputIndex: 1, asset: { kind: 'image', assetId: 'b'.repeat(43) } }]
    input.draft.references = [{ role: 'source', binding: { kind: 'existing', edgeId: targetEdge.id, outputIndex: 1 } }, { role: 'reference', binding: { kind: 'existing', edgeId: targetEdge.id, outputIndex: 0 } }]
    const result = buildStoryboardNodeEdit(input), updatedTarget = result.nodes.find((node) => node.id === target.id)!, updatedAnalysis = result.nodes.find((node) => node.id === analysis.id)!
    expect(sourceIdentities(result, updatedTarget)).toEqual([['source', source.id, 'out:images', 1], ['reference', source.id, 'out:images', 0]])
    expect(sourceIdentities(result, updatedAnalysis)).toEqual(sourceIdentities(result, updatedTarget))
    expect(result.edges.filter((edge) => edge.target === target.id && edge.targetHandle === 'in:images')).toHaveLength(1)
  })
  it('shrinks four references to one without deleting historical source nodes', () => {
    const input = fixture(4), oldSources = input.workflow.nodes.filter((node) => node.kind === 'image-input')
    input.draft.references = [input.draft.references[2]]
    const result = buildStoryboardNodeEdit(input), target = result.nodes.find((node) => node.id === input.nodeId)!, analysis = result.nodes.find((node) => node.kind === 'text-generate')!
    expect(sourceIdentities(result, target)).toEqual([['source', oldSources[2].id, 'out:image', 0]])
    expect(sourceIdentities(result, analysis)).toEqual(sourceIdentities(result, target))
    for (const old of oldSources) expect(result.nodes.find((node) => node.id === old.id)).toEqual(old)
  })
  it('turns automatic plotting back on with a new visible analysis and keeps the disabled historical result', () => {
    const input = fixture(), old = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    old.data.outputText = '历史剧情'; input.draft.task = { ...input.draft.task, automaticPlot: false }; delete input.draft.analysis
    const manual = buildStoryboardNodeEdit(input), target = manual.nodes.find((node) => node.id === input.nodeId)!
    const result = buildStoryboardNodeEdit({ ...input, workflow: manual, draft: { ...input.draft, task: { ...input.draft.task, automaticPlot: true }, analysis: { model: 'gpt-4.1' } }, currentReferences: currentReferences(manual, target) })
    expect(result.nodes.find((node) => node.id === old.id)).toEqual({ ...old, disabled: true })
    const created = result.nodes.find((node) => node.kind === 'text-generate' && node.id !== old.id)!
    expect(created.data).toMatchObject({ status: 'idle', dirty: true, prompt: buildStoryboardAnalysisPrompt(defaultStoryboardTask(), input.draft.prompt) })
    expect(result.edges.some((edge) => edge.source === created.id && edge.target === target.id && edge.targetHandle === 'in:text')).toBe(true)
  })
  it.each([false, true])('disables only exclusive analysis when automatic is off, shared=%s', (shared) => {
    const input = fixture(), old = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    old.data.outputText = '历史剧情'
    if (shared) input.workflow.edges.push({ id: 'shared', source: old.id, target: 'other', sourceHandle: 'out:text', targetHandle: 'in:text' })
    input.draft.task = { ...input.draft.task, automaticPlot: false }; delete input.draft.analysis
    const result = buildStoryboardNodeEdit(input)
    expect(result.nodes.find((node) => node.id === old.id)).toEqual(shared ? old : { ...old, disabled: true })
    expect(result.edges.some((edge) => edge.target === input.nodeId && edge.targetHandle === 'in:text')).toBe(false)
    expect(result.nodes.filter((node) => node.kind === 'text-generate')).toHaveLength(1)
  })
  it('is one undoable replace-graph command and cancellation makes no document change', () => {
    const input = fixture(), document = controller(input.workflow), before = structuredClone(document.getGraphSnapshot())
    expect(document.getGraphSnapshot()).toEqual(before)
    const result = buildStoryboardNodeEdit(input)
    expect(document.getGraphSnapshot()).toEqual(before)
    document.execute({ type: 'replace-graph', nodes: records(result), edges: result.edges })
    const after = structuredClone(document.getGraphSnapshot())
    expect(after).not.toEqual(before)
    document.undo(); expect(document.getGraphSnapshot()).toEqual(before)
    document.redo(); expect(document.getGraphSnapshot()).toEqual(after)
  })
  it.each(['extra-image', 'foreign-analysis', 'old-supplement', 'analysis-extra-text', 'wrong-port', 'different-order', 'candidate-missing', 'unknown-vision', 'duplicate-asset', 'missing-source', 'foreign-edge', 'waiting', 'invalid-index', 'changing-batch', 'mask', 'locked', 'cyclic-parent', 'invalid-task', 'conflicting-task', 'bad-id'])('rejects %s without modifying the graph', (mode) => {
    const input = fixture(), target = input.workflow.nodes.find((node) => node.id === input.nodeId)!, analysis = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    if (mode === 'extra-image') input.workflow.edges.push({ ...input.workflow.edges.find((edge) => edge.target === target.id && edge.targetHandle === 'in:images')!, id: 'unassigned' })
    if (mode === 'foreign-analysis') analysis.data.prompt = '其他分析'
    if (mode === 'old-supplement') target.data.prompt = '未同步的补充'
    if (mode === 'analysis-extra-text') input.workflow.edges.push({ id: 'extra-text', source: target.id, target: analysis.id, sourceHandle: 'out:text', targetHandle: 'in:text' })
    if (mode === 'wrong-port') input.workflow.edges.find((edge) => edge.target === target.id && edge.targetHandle === 'in:text')!.sourceHandle = 'out:image'
    if (mode === 'different-order') { const order = parseImageReferenceOrder(analysis.data.settings?.imageReferenceOrder); analysis.data.settings!.imageReferenceOrder = { version: 1, slots: order.slots.reverse().map((slot, index) => ({ ...slot, role: index === 0 ? 'source' : 'reference' })) } }
    if (mode === 'candidate-missing') delete (input.draft as Partial<StoryboardTaskEditDraft>).imageCandidateCount
    if (mode === 'unknown-vision') input.draft.analysis = { model: 'unknown-vision' }
    if (mode === 'duplicate-asset') input.currentReferences[1].asset = input.currentReferences[0].asset
    if (mode === 'missing-source') input.draft.references = [{ role: 'source', binding: { kind: 'missing' } }]
    if (mode === 'foreign-edge') input.currentReferences[0].sourceNodeId = 'another-source'
    if (mode === 'waiting') input.currentReferences[0].status = 'waiting'
    if (mode === 'invalid-index') input.draft.references[0].binding = { kind: 'existing', edgeId: input.currentReferences[0].edgeId, outputIndex: -1 }
    if (mode === 'changing-batch') { input.workflow.edges.filter((edge) => edge.source === input.currentReferences[0].sourceNodeId).forEach((edge) => { edge.sourceHandle = 'out:images' }) }
    if (mode === 'mask') { target.data.settings!.imageEditMask = { sourceAssetId: 'a'.repeat(43) }; input.draft.references = [...input.draft.references].reverse() }
    if (mode === 'locked') target.locked = true
    if (mode === 'cyclic-parent') target.parentId = target.id
    if (mode === 'invalid-task') target.data.settings!.storyboardTask = null
    if (mode === 'conflicting-task') target.data.settings!.exteriorTask = {}
    if (mode === 'bad-id') input.createId = () => 'bad\nidentifier'
    const before = structuredClone(input.workflow)
    expect(() => buildStoryboardNodeEdit(input)).toThrow()
    expect(input.workflow).toEqual(before)
  })
})

describe('synchronous storyboard prompt edits', () => {
  it('updates canonical analysis and shifts official prompt references over the prefix', () => {
    const input = fixture(), snapshot = officialPromptSnapshot('xingmang-product-studio')
    if (!snapshot) throw new Error('Missing official prompt fixture')
    const prompt = `前置剧情\n${snapshot.prompt}\n结尾`, references = [{ ...snapshot, start: 5, end: 5 + snapshot.prompt.length }]
    const before = structuredClone(input.workflow), result = buildStoryboardPromptEdit({ ...input, prompt, promptReferences: references })!
    const target = result.nodes.find((node) => node.id === input.nodeId)!, analysis = result.nodes.find((node) => node.kind === 'text-generate')!
    expect(target.data.promptReferences).toEqual(references)
    expect(analysis.data.prompt).toBe(buildStoryboardAnalysisPrompt(input.draft.task, prompt))
    const offset = analysis.data.prompt.length - prompt.length
    expect(analysis.data.promptReferences).toEqual(references.map((reference) => ({ ...reference, start: reference.start + offset, end: reference.end + offset })))
    expect(parsePromptReferences(analysis.data.prompt, analysis.data.promptReferences)).toEqual(analysis.data.promptReferences)
    expect(input.workflow).toEqual(before)
  })
  it('returns no command for an unchanged automatic draft or a manual task', () => {
    const input = fixture(), node = input.workflow.nodes.find((node) => node.id === input.nodeId)!
    expect(buildStoryboardPromptEdit({ ...input, prompt: node.data.prompt })).toBeUndefined()
    node.data.settings!.storyboardTask = { ...input.draft.task, automaticPlot: false }
    expect(buildStoryboardPromptEdit({ ...input, prompt: '手写新剧情' })).toBeUndefined()
    expect(buildStoryboardPromptEdit({ ...input, nodeId: 'missing', prompt: '新剧情' })).toBeUndefined()
  })
  it('supports empty automatic supplements and clones shared analysis synchronously', () => {
    const input = fixture(), old = input.workflow.nodes.find((node) => node.kind === 'text-generate')!
    input.workflow.edges.push({ id: 'shared-prompt', source: old.id, target: 'other', sourceHandle: 'out:text', targetHandle: 'in:text' })
    const result = buildStoryboardPromptEdit({ ...input, prompt: '' })!
    expect(result.nodes.find((node) => node.id === old.id)).toEqual(old)
    expect(result.nodes.find((node) => node.kind === 'text-generate' && node.id !== old.id)?.data.prompt).toBe(buildStoryboardAnalysisPrompt(input.draft.task, ''))
    expect(result.nodes.find((node) => node.id === input.nodeId)?.data.result).toEqual({ kind: 'image', assetId: 'z'.repeat(43) })
  })
  it('refuses missing parameters rather than guessing defaults during ordinary prompt edits', () => {
    const input = fixture(); delete input.workflow.nodes.find((node) => node.id === input.nodeId)!.data.imageCandidateCount
    expect(() => buildStoryboardPromptEdit({ ...input, prompt: '新剧情' })).toThrow('参数')
    expect(() => assertStoryboardNodeEditable(input.workflow.nodes, 'missing')).toThrow()
  })
})
