import type { CanvasImageAssetSummary } from '../host'
import type { WorkflowFile, WorkflowNode } from '../model'
import type { UpstreamMediaReference } from '../components/upstream-references'
import { buildCommerceNodeEdit } from '../commerce/commerce-edit-application'
import { defaultCommerceTask } from '../commerce/commerce-task'
import { parseImageReferenceOrder, type ImageReferenceSlot } from '../commerce/image-reference-order'
import { assertExteriorTaskConfiguration, buildExteriorAnalysisPrompt, buildExteriorTaskPrompt, resolveExteriorImageRequest, exteriorTaskLabels, exteriorTaskRoles, exteriorTaskUsesAnalysis, parseExteriorTask, parseNodeExteriorTask, type ExteriorTask } from './exterior-task'
import { validateTextImageInputConfiguration } from '../runtime/text-image-input'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { findAvailableCanvasPosition } from '../editor/node-placement'
import { mediaAssetNodeDimensions } from '../library/media-assets'
import { imageTransformRecipeForNode } from '../image-tools/recipe'

export interface ExteriorReferenceSubmission { role: 'source' | 'reference'; binding: { kind: 'existing'; edgeId: string; outputIndex: number } | { kind: 'asset'; assetId: string } | { kind: 'missing' } }
export interface ExteriorTaskEditDraft {
  mode: 'create' | 'edit'; task: ExteriorTask; references: readonly ExteriorReferenceSubmission[]; prompt: string
  model: string; size: string; quality: string; imageResolution: '1K' | '2K' | '4K'; imageCandidateCount: 1 | 2 | 3 | 4; analysis?: { model: string }
}
export function assertExteriorNodeEditable(nodes: readonly WorkflowNode[], nodeId: string): WorkflowNode {
  const node = nodes.find((entry) => entry.id === nodeId)
  if (!node || node.data.settings?.exteriorTask === undefined) throw new Error('原室外创作节点已变化，请重新打开配置')
  const task = parseNodeExteriorTask(node.kind, node.data.settings.exteriorTask)
  assertExteriorTaskConfiguration(task, parseImageReferenceOrder(node.data.settings.imageReferenceOrder), node.data.settings.commerceTask, node.data.settings.interiorTask)
  const seen = new Set<string>(); let current: WorkflowNode | undefined = node
  while (current) { if (seen.has(current.id) || current.disabled || current.locked) throw new Error('室外节点或上级分组已锁定、禁用或层级无效，请先解除后再编辑'); seen.add(current.id); if (!current.parentId) break; current = nodes.find((entry) => entry.id === current!.parentId); if (!current || current.kind !== 'group') throw new Error('上级分组已变化，请重新打开工程') }
  return node
}
/** Fork input and analysis nodes instead of changing shared originals or results. */
export function buildExteriorNodeEdit(input: { workflow: WorkflowFile; nodeId: string; draft: ExteriorTaskEditDraft; currentReferences: readonly UpstreamMediaReference[]; assets: readonly CanvasImageAssetSummary[]; analysisGroup?: string; createId: () => string }): WorkflowFile {
  if (input.draft.mode !== 'edit') throw new Error('室外编辑会话不正确')
  const task = parseExteriorTask(input.draft.task), original = assertExteriorNodeEditable(input.workflow.nodes, input.nodeId)
  if (typeof input.draft.prompt !== 'string' || input.draft.prompt.length > 24_000 || input.draft.prompt.includes('\0')) throw new Error('补充要求格式不正确或过长')
  resolveExteriorImageRequest(task, { model: input.draft.model, prompt: input.draft.prompt })
  if (parseImageCandidateCount(input.draft.imageCandidateCount, original.kind) === undefined) throw new Error('请选择明确的候选数量')
  const automatic = exteriorTaskUsesAnalysis(task)
  if (automatic) { if (!input.draft.analysis) throw new Error('自动提示需要明确选择视觉文字模型'); validateTextImageInputConfiguration(input.draft.analysis.model, 2) }
  const oldTask = parseExteriorTask(original.data.settings!.exteriorTask)
  function sourceIdentities(order: ReturnType<typeof parseImageReferenceOrder>, nodeId: string): string {
    return JSON.stringify(order.slots.map((slot) => { const edge = 'edgeId' in slot ? input.workflow.edges.find((entry) => entry.id === slot.edgeId && entry.target === nodeId && entry.targetHandle === 'in:images') : undefined; return edge && 'outputIndex' in slot ? [slot.role, edge.source, edge.sourceHandle, slot.outputIndex] : [slot.role, 'missing'] }))
  }
  const originalOrder = parseImageReferenceOrder(original.data.settings?.imageReferenceOrder)
  const configured = new Set(originalOrder.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
  if (input.workflow.edges.some((edge) => edge.target === original.id && ['in:image', 'in:images'].includes(edge.targetHandle) && !configured.has(edge.id))) throw new Error('有新连接的图片尚未分配角色，请先核对或断开未选图片')
  const originalIdentity = sourceIdentities(originalOrder, original.id)
  const analysisEdges = new Set<string>(), privateAnalyses: string[] = []
  for (const edge of input.workflow.edges.filter((edge) => edge.target === original.id && edge.targetHandle === 'in:text')) {
    const source = input.workflow.nodes.find((entry) => entry.id === edge.source)
    const visual = source?.kind === 'text-generate' && (source.data.settings?.imageReferenceOrder !== undefined || input.workflow.edges.some((incoming) => incoming.target === source.id && ['out:image', 'out:images'].includes(incoming.sourceHandle)))
    if (!visual) { if (automatic) throw new Error('自动提示还存在其他文字输入，请先断开或核对；不会使用不明确的分析'); continue }
    if (!source || edge.sourceHandle !== 'out:text' || source.disabled || !exteriorTaskUsesAnalysis(oldTask) || source.data.prompt !== buildExteriorAnalysisPrompt(oldTask) || sourceIdentities(parseImageReferenceOrder(source.data.settings?.imageReferenceOrder), source.id) !== originalIdentity) throw new Error('此任务连接了另一组图片或不明确的分析，请先核对或断开文字连接')
    const order = parseImageReferenceOrder(source.data.settings?.imageReferenceOrder), allowed = new Set(order.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
    if (input.workflow.edges.some((incoming) => incoming.target === source.id && (incoming.targetHandle !== 'in:images' || !allowed.has(incoming.id)))) throw new Error('图片分析存在额外的图片或文字输入，请先核对；不会隐式修改分析')
    const shared = input.workflow.edges.some((outgoing) => outgoing.source === source.id && outgoing.id !== edge.id)
    let editable = !source.locked, ancestor = source.parentId, seen = new Set<string>([source.id])
    while (ancestor) { const parent = input.workflow.nodes.find((entry) => entry.id === ancestor); if (!parent || parent.kind !== 'group' || seen.has(parent.id)) throw new Error('图片分析分组层级已变化，请重新打开工程'); seen.add(parent.id); if (parent.locked || parent.disabled) editable = false; ancestor = parent.parentId }
    if (!shared && editable) privateAnalyses.push(source.id)
    analysisEdges.add(edge.id)
  }
  if (analysisEdges.size > 1) throw new Error('此任务存在多个图片分析，请先核对唯一分析关系')
  // Stable occurrence identities must be checked before a private source is built.
  for (const reference of input.draft.references) if (reference.binding.kind === 'existing') {
    const binding = reference.binding, edge = input.workflow.edges.find((entry) => entry.id === binding.edgeId && entry.target === original.id && entry.targetHandle === 'in:images')
    const resolved = input.currentReferences.find((entry) => entry.edgeId === binding.edgeId && (entry.outputIndex ?? 0) === binding.outputIndex)
    if (!edge || !resolved || resolved.kind !== 'image' || resolved.status !== 'ready' || resolved.sourceNodeId !== edge.source || resolved.asset?.kind !== 'image' || !/^[A-Za-z0-9_-]{43}$/.test(resolved.asset.assetId ?? '') || !Number.isInteger(binding.outputIndex) || binding.outputIndex < 0) throw new Error('原图片连接已变化或尚未就绪，请重新选择')
    const source = input.workflow.nodes.find((entry) => entry.id === edge.source)
    if (!source || edge.sourceHandle === 'out:image' && binding.outputIndex !== 0 || !['out:image', 'out:images'].includes(edge.sourceHandle)) throw new Error('图片输出位置已变化，请重新绑定')
    if (edge.sourceHandle === 'out:images') { const recipe = imageTransformRecipeForNode(source.kind, source.data.settings); if (source.kind !== 'image-grid-split' || recipe?.kind !== 'grid-split' || binding.outputIndex >= recipe.rows * recipe.columns) throw new Error('此批次无法核对稳定图片位置，请改用单图输出') }
  }
  const converted = structuredClone(input.workflow), convertedNode = converted.nodes.find((entry) => entry.id === input.nodeId)!
  const settings = { ...convertedNode.data.settings }; delete settings.exteriorTask
  convertedNode.data.settings = { ...settings, commerceTask: defaultCommerceTask(exteriorTaskRoles(task).length === 2 ? 'style-reference' : 'material-a') }
  converted.edges = converted.edges.filter((edge) => !analysisEdges.has(edge.id))
  const workflow = buildCommerceNodeEdit({ ...input, workflow: converted, task: defaultCommerceTask(exteriorTaskRoles(task).length === 2 ? 'style-reference' : 'material-a'), references: input.draft.references })
  const node = workflow.nodes.find((entry) => entry.id === input.nodeId)!, newSettings = { ...node.data.settings }; delete newSettings.commerceTask
  node.data = { ...node.data, prompt: input.draft.prompt, model: input.draft.model, size: input.draft.size, quality: input.draft.quality, imageResolution: input.draft.imageResolution, imageCandidateCount: input.draft.imageCandidateCount, settings: { ...newSettings, title: exteriorTaskLabels[task.kind], exteriorTask: task } }
  const ids = new Set([...workflow.nodes, ...workflow.edges].map((entry) => entry.id))
  function nextId(): string { const id = input.createId(); if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || ids.has(id)) throw new Error('节点与连线编号冲突'); ids.add(id); return id }
  const origin = { ...node.position }; let parentId = node.parentId
  while (parentId) { const parent = workflow.nodes.find((entry) => entry.id === parentId)!; origin.x += parent.position.x; origin.y += parent.position.y; parentId = parent.parentId }
  if (automatic) {
    const reusable = privateAnalyses.length === 1 ? workflow.nodes.find((entry) => entry.id === privateAnalyses[0]) : undefined
    const analysis: WorkflowNode = reusable ?? { id: nextId(), kind: 'text-generate', definitionVersion: 1, position: { x: origin.x - 420, y: origin.y + 560 }, data: { prompt: '', model: '', status: 'idle' } }
    analysis.data = { ...analysis.data, prompt: buildExteriorAnalysisPrompt(task), model: input.draft.analysis!.model, group: input.analysisGroup, dirty: true, settings: { ...analysis.data.settings, title: '当前室外任务图片分析' } }
    if (reusable) workflow.edges = workflow.edges.filter((edge) => edge.target !== reusable.id || edge.targetHandle !== 'in:images')
    const order = parseImageReferenceOrder(node.data.settings?.imageReferenceOrder)
    const slots = order.slots.map((slot): ImageReferenceSlot => { if (!('edgeId' in slot)) throw new Error('自动提示图片尚未绑定'); const edge = workflow.edges.find((entry) => entry.id === slot.edgeId)!; const copy = { ...edge, id: nextId(), target: analysis.id }; workflow.edges.push(copy); return { role: slot.role, edgeId: copy.id, outputIndex: slot.outputIndex } })
    analysis.data.settings = { ...analysis.data.settings, imageReferenceOrder: { version: 1, slots } }
    if (!reusable) workflow.nodes.push(analysis)
    workflow.edges.push({ id: nextId(), source: analysis.id, target: node.id, sourceHandle: 'out:text', targetHandle: 'in:text' })
  }
  if (!automatic) for (const id of privateAnalyses) { const analysis = workflow.nodes.find((node) => node.id === id)!; analysis.disabled = true }
  const originalIds = new Set(input.workflow.nodes.map((entry) => entry.id)), placed = workflow.nodes.filter((entry) => originalIds.has(entry.id))
  for (const added of workflow.nodes.filter((entry) => !originalIds.has(entry.id))) {
    const geometry = canvasNodeDisplayGeometry(added), fallback = builtinNodeRegistry.require(added.kind).dimensions
    const dimensions = added.kind === 'image-input' && added.data.result ? mediaAssetNodeDimensions(added.data.result) : { width: geometry.width ?? fallback.width, height: geometry.height ?? fallback.height }
    const obstacles = placed.map((entry) => { const geometry = canvasNodeDisplayGeometry(entry), fallback = builtinNodeRegistry.require(entry.kind).dimensions; return { ...entry, type: entry.kind, width: geometry.width ?? entry.width ?? fallback.width, height: geometry.height ?? entry.height ?? fallback.height } })
    added.position = findAvailableCanvasPosition(obstacles, { x: added.position.x + dimensions.width / 2, y: added.position.y + dimensions.height / 2 }, dimensions); added.width = dimensions.width
    if (added.kind === 'image-input') added.height = dimensions.height
    placed.push(added)
  }
  return workflow
}
