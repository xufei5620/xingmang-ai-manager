import type { CanvasImageAssetSummary } from '../host'
import type { WorkflowFile, WorkflowNode } from '../model'
import type { CommerceTaskReferenceSubmission } from '../components/commerce-task-ui'
import type { UpstreamMediaReference } from '../components/upstream-references'
import { parseCommerceTask, type CommerceTask } from './commerce-task'
import { parseImageReferenceOrder, type ImageReferenceSlot } from './image-reference-order'
import { batchImageRelatedConfig } from '../editor/batch-image-related'

export function assertCommerceNodeEditable(nodes: readonly WorkflowNode[], nodeId: string): WorkflowNode {
  const node = nodes.find((entry) => entry.id === nodeId)
  if (!node || !['image', 'image-generate', 'image-edit'].includes(node.kind) || node.data.settings?.commerceTask === undefined) throw new Error('原创作节点已变化，请重新打开配置')
  const seen = new Set<string>()
  let current: WorkflowNode | undefined = node
  while (current) {
    if (seen.has(current.id) || current.disabled || current.locked) throw new Error('创作节点或上级分组已锁定、禁用或层级无效，请先解除后再编辑')
    seen.add(current.id)
    if (!current.parentId) break
    current = nodes.find((entry) => entry.id === current!.parentId)
    if (!current) throw new Error('上级分组已变化，请重新打开工程')
  }
  return node
}

function imageInput(asset: CanvasImageAssetSummary, id: string, position: { x: number; y: number }): WorkflowNode {
  if (asset.deletedAt || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || asset.localUrl !== `xingmang-asset://image/${asset.assetId}`) throw new Error('图片已失效，请重新选择素材')
  return { id, kind: 'image-input', definitionVersion: 1, position, data: { prompt: '', model: '', status: 'succeeded', dirty: false,
    settings: { title: (asset.displayName || asset.fileName).slice(0, 160) },
    result: { kind: 'image', assetId: asset.assetId, localUrl: asset.localUrl, mimeType: asset.mimeType, width: asset.width, height: asset.height } } }
}

/** Replacement inputs are private to this task; a shared source is never mutated. */
export function buildCommerceNodeEdit(input: {
  workflow: WorkflowFile; nodeId: string; task: CommerceTask; references: readonly CommerceTaskReferenceSubmission[]
  currentReferences: readonly UpstreamMediaReference[]; assets: readonly CanvasImageAssetSummary[]; createId: () => string
}): WorkflowFile {
  const task = parseCommerceTask(input.task), workflow = structuredClone(input.workflow)
  const node = assertCommerceNodeEditable(workflow.nodes, input.nodeId)
  const originalOrder = parseImageReferenceOrder(node.data.settings?.imageReferenceOrder)
  function sourceRoles(order: { slots: ImageReferenceSlot[] }): unknown[] {
    return order.slots.map((slot) => {
      const edge = 'edgeId' in slot ? input.workflow.edges.find((entry) => entry.id === slot.edgeId) : undefined
      return edge && 'outputIndex' in slot ? [slot.role, edge.source, edge.sourceHandle, slot.outputIndex] : [slot.role, 'missing']
    })
  }
  const originalRoles = sourceRoles(originalOrder)
  const origin = { ...node.position }
  let parentId = node.parentId
  while (parentId) { const parent = workflow.nodes.find((entry) => entry.id === parentId)!; origin.x += parent.position.x; origin.y += parent.position.y; parentId = parent.parentId }
  const roles = task.kind === 'style-reference' ? ['source', 'reference'] : ['source']
  if (input.references.length !== roles.length || input.references.some((entry, index) => entry.role !== roles[index])) throw new Error('原图与参考图的角色不正确')
  const ids = new Set([...workflow.nodes, ...workflow.edges].map((entry) => entry.id))
  function nextId(): string { const id = input.createId(); if (!id || ids.has(id)) throw new Error('节点与连线编号冲突'); ids.add(id); return id }
  const slots: ImageReferenceSlot[] = [], keepEdges = new Set<string>(), assetsSeen = new Set<string>(), selectedAssets: string[] = []
  for (const [index, reference] of input.references.entries()) {
    let assetId: string
    if (reference.binding.kind === 'existing') {
      const { edgeId, outputIndex } = reference.binding
      const edge = workflow.edges.find((entry) => entry.id === edgeId && entry.target === node.id && ['out:image', 'out:images'].includes(entry.sourceHandle ?? ''))
      const resolved = input.currentReferences.find((entry) => entry.edgeId === edgeId && (entry.outputIndex ?? 0) === outputIndex && entry.kind === 'image')
      if (!edge || !resolved?.asset?.assetId || resolved.status !== 'ready') throw new Error('原图片连接已变化或尚未就绪，请重新选择')
      assetId = resolved.asset.assetId
      slots.push({ role: reference.role, edgeId, outputIndex }); keepEdges.add(edgeId)
    } else if (reference.binding.kind === 'asset') {
      const asset = input.assets.find((entry) => entry.assetId === (reference.binding.kind === 'asset' ? reference.binding.assetId : ''))
      if (!asset) throw new Error('新图片尚未核对，请重新选择')
      assetId = asset.assetId
      const source = imageInput(asset, nextId(), { x: origin.x - 380, y: origin.y + index * 340 })
      workflow.nodes.push(source)
      const edge = { id: nextId(), source: source.id, target: node.id, sourceHandle: 'out:image', targetHandle: 'in:images' }
      workflow.edges.push(edge); keepEdges.add(edge.id)
      slots.push({ role: reference.role, edgeId: edge.id, outputIndex: 0 })
    } else throw new Error('请重新绑定缺失的原图或参考图')
    if (assetsSeen.has(assetId)) throw new Error('原图和参考图不能使用同一张实际图片')
    assetsSeen.add(assetId); selectedAssets.push(assetId)
  }
  const order = parseImageReferenceOrder({ version: 1, slots })
  const previousAssets = originalOrder.slots.map((slot) => 'edgeId' in slot ? input.currentReferences.find((entry) => entry.edgeId === slot.edgeId && (entry.outputIndex ?? 0) === slot.outputIndex)?.asset?.assetId : undefined)
  if (JSON.stringify(previousAssets) !== JSON.stringify(selectedAssets)) {
    const analyses = input.workflow.edges.filter((edge) => edge.target === node.id && edge.sourceHandle === 'out:text').flatMap((edge) => {
      const source = input.workflow.nodes.find((entry) => entry.id === edge.source)
      return source?.kind === 'text-generate' && source.data.settings?.imageReferenceOrder !== undefined ? [{ edge, source }] : []
    })
    for (const { edge, source } of analyses) {
      const analysisOrder = parseImageReferenceOrder(source.data.settings?.imageReferenceOrder)
      if (JSON.stringify(sourceRoles(analysisOrder)) !== JSON.stringify(originalRoles)) throw new Error('此任务还连接了另一组图片的分析，请先断开或核对该文字连接，再更换原图')
      if (source.disabled) throw new Error('图片分析节点已禁用，请先核对或断开这条文字连接，再更换原图')
      const analysis: WorkflowNode = { id: nextId(), kind: 'text-generate', definitionVersion: source.definitionVersion ?? 1,
        position: { x: origin.x - 380, y: origin.y + 720 }, data: { prompt: source.data.prompt, model: source.data.model, group: source.data.group,
          ...(source.data.promptReferences ? { promptReferences: structuredClone(source.data.promptReferences) } : {}), ...(source.data.textWebSearch !== undefined ? { textWebSearch: source.data.textWebSearch } : {}),
          status: 'idle', dirty: true, settings: { ...source.data.settings, title: '当前任务图片分析' } } }
      const analysisSlots = order.slots.map((slot): ImageReferenceSlot => {
        if (!('edgeId' in slot)) return slot
        const currentEdge = workflow.edges.find((entry) => entry.id === slot.edgeId)!
        const copy = { ...currentEdge, id: nextId(), target: analysis.id }
        workflow.edges.push(copy)
        return { role: slot.role, edgeId: copy.id, outputIndex: slot.outputIndex }
      })
      analysis.data.settings = { ...analysis.data.settings, imageReferenceOrder: { version: 1, slots: analysisSlots } }
      for (const incoming of input.workflow.edges.filter((entry) => entry.target === source.id && !['out:image', 'out:images'].includes(entry.sourceHandle))) workflow.edges.push({ ...incoming, id: nextId(), target: analysis.id })
      workflow.nodes.push(analysis)
      workflow.edges = workflow.edges.filter((entry) => entry.id !== edge.id)
      workflow.edges.push({ ...edge, id: nextId(), source: analysis.id })
    }
  }
  const mask = node.data.settings?.imageEditMask
  const base = input.references[0]
  const existing = base.binding.kind === 'existing' ? base.binding : undefined
  const baseId = base.binding.kind === 'asset' ? base.binding.assetId : existing ? input.currentReferences.find((entry) => entry.edgeId === existing.edgeId && (entry.outputIndex ?? 0) === existing.outputIndex)?.asset?.assetId : undefined
  if (mask && typeof mask === 'object' && !Array.isArray(mask) && Reflect.get(mask, 'sourceAssetId') !== baseId) throw new Error('原图已更换，请先清除旧蒙版再重新绘制，避免把旧蒙版应用到另一张图片')
  workflow.edges = workflow.edges.filter((edge) => edge.target !== node.id || !['out:image', 'out:images'].includes(edge.sourceHandle ?? '') || keepEdges.has(edge.id))
  node.data.settings = { ...node.data.settings, commerceTask: task, imageReferenceOrder: order }
  if (task.kind === 'material-b') { node.data.size = 'auto'; node.data.imageResolution = '1K' }
  return workflow
}

/** Compare immutable owned assets, rather than a generator's changing output. */
export function buildCommerceCandidateComparison(assets: readonly CanvasImageAssetSummary[], origin: { x: number; y: number }, createId: () => string): Pick<WorkflowFile, 'nodes' | 'edges'> {
  if (assets.length < 2 || assets.length > 4 || new Set(assets.map((asset) => asset.assetId)).size !== assets.length) throw new Error('候选对比需要 2–4 张不同的图片')
  const ids = new Set<string>()
  function nextId(): string { const id = createId(); if (!id || ids.has(id)) throw new Error('候选对比编号冲突'); ids.add(id); return id }
  const nodes = assets.map((asset, index) => imageInput(asset, nextId(), { x: origin.x, y: origin.y + index * 330 }))
  const compareId = nextId()
  const edges = nodes.map((node) => ({ id: nextId(), source: node.id, target: compareId, sourceHandle: 'out:image', targetHandle: 'in:images' }))
  const settings = batchImageRelatedConfig('image-compare', assets.length)
  const compare = settings.imageCompare as Record<string, unknown>
  nodes.push({ id: compareId, kind: 'image-compare', definitionVersion: 1, position: { x: origin.x + 420, y: origin.y }, data: { prompt: '', model: '', status: 'idle', settings: { title: '商品候选对比', imageCompare: { ...compare, inputSlots: edges.map((edge) => JSON.stringify([edge.id, 0])) } } } })
  return { nodes, edges }
}
