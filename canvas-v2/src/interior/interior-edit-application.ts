import type { CanvasImageAssetSummary } from '../host'
import type { WorkflowFile, WorkflowNode } from '../model'
import type { InteriorTaskDialogDraft } from '../components/interior-task-ui'
import type { UpstreamMediaReference } from '../components/upstream-references'
import { assertInteriorTaskConfiguration, parseInteriorTask, parseNodeInteriorTask } from './interior-task'
import { parseImageReferenceOrder, type ImageReferenceSlot } from '../commerce/image-reference-order'
import { parseNodeImageEditMask } from '../image-tools/image-mask-workflow'
import { parseImageCandidateCount } from '../runtime/image-candidate-count'
import { imageTransformRecipeForNode } from '../image-tools/recipe'
import { isTemplateImageAsset } from '../components/template-asset-picker-model'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import { canvasNodeDisplayGeometry } from '../domain/node-display-geometry'
import { findAvailableCanvasPosition } from '../editor/node-placement'
import { mediaAssetNodeDimensions } from '../library/media-assets'

export function assertInteriorNodeEditable(nodes: readonly WorkflowNode[], nodeId: string): WorkflowNode {
  const node = nodes.find((entry) => entry.id === nodeId)
  if (!node || !['image', 'image-generate', 'image-edit'].includes(node.kind) || node.data.settings?.interiorTask === undefined || node.data.settings?.commerceTask !== undefined) throw new Error('原室内创作节点已变化，请重新打开配置')
  // A new editor must never turn unreadable future metadata into a current task.
  const task = parseNodeInteriorTask(node.kind, node.data.settings.interiorTask)
  assertInteriorTaskConfiguration(task, parseImageReferenceOrder(node.data.settings.imageReferenceOrder), node.data.settings.commerceTask)
  const seen = new Set<string>()
  let current: WorkflowNode | undefined = node
  while (current) {
    if (seen.has(current.id) || current.disabled || current.locked) throw new Error('室内节点或上级分组已锁定、禁用或层级无效，请先解除后再编辑')
    seen.add(current.id)
    if (!current.parentId) break
    current = nodes.find((entry) => entry.id === current!.parentId)
    if (!current || current.kind !== 'group') throw new Error('上级分组已变化，请重新打开工程')
  }
  return node
}

/** A replacement source is private to this task; original shared inputs stay intact. */
export function buildInteriorNodeEdit(input: {
  workflow: WorkflowFile; nodeId: string; draft: InteriorTaskDialogDraft
  currentReferences: readonly UpstreamMediaReference[]; assets: readonly CanvasImageAssetSummary[]; createId: () => string
}): WorkflowFile {
  if (input.draft.mode !== 'edit') throw new Error('室内编辑会话不正确')
  if (typeof input.draft.prompt !== 'string' || input.draft.prompt.length > 24_000 || input.draft.prompt.includes('\0')) throw new Error('补充要求格式不正确或过长')
  if (parseImageCandidateCount(input.draft.imageCandidateCount, 'image-generate') === undefined) throw new Error('请选择明确的候选数量')
  const task = parseInteriorTask(input.draft.task), workflow = structuredClone(input.workflow)
  const node = assertInteriorNodeEditable(workflow.nodes, input.nodeId)
  const binding = input.draft.source.binding
  const previous = parseImageReferenceOrder(node.data.settings?.imageReferenceOrder)
  const previousSource = previous.slots[0]
  const previousAsset = previousSource && 'edgeId' in previousSource ? input.currentReferences.find((entry) => entry.edgeId === previousSource.edgeId && (entry.outputIndex ?? 0) === previousSource.outputIndex)?.asset?.assetId : undefined
  const ids = new Set([...workflow.nodes, ...workflow.edges].map((entry) => entry.id))
  function nextId(): string { const id = input.createId(); if (typeof id !== 'string' || !id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) || ids.has(id)) throw new Error('节点与连线编号冲突'); ids.add(id); return id }
  let slot: ImageReferenceSlot, sourceAssetId: string
  if (binding.kind === 'existing') {
    const edge = workflow.edges.find((entry) => entry.id === binding.edgeId && entry.target === node.id && entry.targetHandle === 'in:images' && ['out:image', 'out:images'].includes(entry.sourceHandle))
    const resolved = input.currentReferences.find((entry) => entry.edgeId === binding.edgeId && (entry.outputIndex ?? 0) === binding.outputIndex && entry.kind === 'image')
    if (!edge || !resolved?.asset?.assetId || resolved.asset.kind !== 'image' || !/^[A-Za-z0-9_-]{43}$/.test(resolved.asset.assetId) || resolved.status !== 'ready'
      || resolved.sourceNodeId !== edge.source || !workflow.nodes.some((entry) => entry.id === edge.source) || edge.sourceHandle === 'out:image' && binding.outputIndex !== 0) throw new Error('原图片连接已变化或尚未就绪，请重新选择')
    if (edge.sourceHandle === 'out:images') {
      const source = workflow.nodes.find((entry) => entry.id === edge.source)!
      const recipe = source.kind === 'image-grid-split' ? imageTransformRecipeForNode(source.kind, source.data.settings) : undefined
      if (!recipe || recipe.kind !== 'grid-split' || binding.outputIndex >= recipe.rows * recipe.columns) throw new Error('此批次无法核对稳定图片位置，请改用单图输出或重新绑定')
    }
    if (workflow.edges.some((entry) => entry.target === node.id && entry.targetHandle === 'in:images' && entry.id !== edge.id)) throw new Error('有新连接的图片尚未分配角色，请先断开未选图片或明确替换原图')
    sourceAssetId = resolved.asset.assetId
    slot = { role: 'source', edgeId: edge.id, outputIndex: binding.outputIndex }
  } else if (binding.kind === 'asset') {
    const asset = input.assets.find((entry) => entry.assetId === binding.assetId)
    if (!asset || !isTemplateImageAsset(asset) || asset.localUrl !== `xingmang-asset://image/${asset.assetId}`) throw new Error('新图片尚未核对，请重新选择素材')
    sourceAssetId = asset.assetId
    const position = { ...node.position }
    let parentId = node.parentId
    while (parentId) { const parent = workflow.nodes.find((entry) => entry.id === parentId)!; position.x += parent.position.x; position.y += parent.position.y; parentId = parent.parentId }
    const dimensions = mediaAssetNodeDimensions(asset)
    // A private input must not hide its still-shared predecessor. Reuse the
    // editor's displayed media geometry and world-space group-aware search.
    const obstacles = workflow.nodes.map((entry) => {
      const type = entry.disabled && entry.unknownKind ? 'unknown' : entry.kind
      const geometry = canvasNodeDisplayGeometry(entry), fallback = builtinNodeRegistry.resolve(type)?.dimensions
      return { ...entry, type, width: geometry.width ?? entry.width ?? fallback?.width, height: geometry.height ?? entry.height ?? fallback?.height }
    })
    const source: WorkflowNode = { id: nextId(), kind: 'image-input', definitionVersion: 1,
      position: findAvailableCanvasPosition(obstacles, { x: position.x - 100 - dimensions.width / 2, y: position.y + dimensions.height / 2 }, dimensions), ...dimensions, data: {
      prompt: '', model: '', status: 'succeeded', dirty: false, settings: { title: (asset.displayName || asset.fileName).slice(0, 160) },
      result: { kind: 'image', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, width: asset.width, height: asset.height },
    } }
    workflow.nodes.push(source)
    const edge = { id: nextId(), source: source.id, target: node.id, sourceHandle: 'out:image', targetHandle: 'in:images' }
    workflow.edges.push(edge)
    slot = { role: 'source', edgeId: edge.id, outputIndex: 0 }
  } else throw new Error('请重新绑定缺失的室内原图')
  const mask = parseNodeImageEditMask(node.kind, node.data.settings?.imageEditMask)
  if (mask && mask.sourceAssetId !== sourceAssetId) throw new Error('原图与蒙版绑定不一致，请先清除旧蒙版再重新绘制')
  if (sourceAssetId !== previousAsset) {
    const analysis = input.workflow.edges.some((edge) => edge.target === node.id && edge.sourceHandle === 'out:text' && input.workflow.nodes.some((source) => source.id === edge.source && source.kind === 'text-generate'
      && (source.data.settings?.imageReferenceOrder !== undefined || input.workflow.edges.some((image) => image.target === source.id && ['out:image', 'out:images'].includes(image.sourceHandle ?? '')))))
    if (analysis) throw new Error('此任务还连接了图片分析，请先核对或断开文字连接后再更换原图')
  }
  const order = parseImageReferenceOrder({ version: 1, slots: [slot] })
  workflow.edges = workflow.edges.filter((edge) => edge.target !== node.id || edge.targetHandle !== 'in:images' || edge.id === ('edgeId' in slot ? slot.edgeId : ''))
  node.data.settings = { ...node.data.settings, interiorTask: task, imageReferenceOrder: order }
  node.data.prompt = input.draft.prompt
  node.data.model = input.draft.model
  node.data.size = input.draft.size
  node.data.quality = input.draft.quality
  node.data.imageResolution = input.draft.imageResolution
  node.data.imageCandidateCount = input.draft.imageCandidateCount
  return workflow
}
