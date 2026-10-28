import { assertStoryboardTaskConfiguration, assertStoryboardAnalysisConfiguration, type StoryboardTask } from '../storyboard/storyboard-task'
import { assertExteriorTaskConfiguration, assertExteriorAnalysisConfiguration, type ExteriorTask } from '../exterior/exterior-task'
import { assertInteriorTaskConfiguration, type InteriorTask } from '../interior/interior-task'
import type { CanvasRunGraph } from '../host'
import { parseNodeCommerceTask, type CommerceTask } from './commerce-task'
import { parseNodeImageReferenceOrder, type ImageReferenceOrder } from './image-reference-order'

export function assertCommerceTaskConfiguration(task: CommerceTask | undefined, order: ImageReferenceOrder | undefined, data: { size?: string; imageResolution?: string }, interiorTask?: InteriorTask, exteriorTask?: ExteriorTask, storyboardTask?: StoryboardTask): void {
  assertInteriorTaskConfiguration(interiorTask, order, task)
  assertExteriorTaskConfiguration(exteriorTask, order, task, interiorTask)
  assertStoryboardTaskConfiguration(storyboardTask, order, task, interiorTask, exteriorTask)
  if (!task) return
  if (!order) throw new Error('创作任务需要明确原图和参考图角色，请打开创作配置重新绑定')
  const expected = task.kind === 'style-reference' ? 2 : 1
  if (order.slots.length !== expected) throw new Error(task.kind === 'style-reference' ? '参考风格迁移需要唯一原图和一张参考图' : '此创作任务只接受唯一原图')
  if (task.kind === 'material-b' && (data.size !== 'auto' || data.imageResolution !== undefined && data.imageResolution !== '1K')) throw new Error('材质优化 B 的尺寸由原图和倍率唯一决定，请保留自动尺寸与 1K 清晰度')
}

export function assertImageReferenceRunConfiguration(node: CanvasRunGraph['nodes'][number], edges: readonly CanvasRunGraph['edges'][number][], nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>): void {
  const order = node.data.imageReferenceOrder === undefined ? undefined : parseNodeImageReferenceOrder(node.kind, node.data.imageReferenceOrder)
  const task = node.data.commerceTask === undefined ? undefined : parseNodeCommerceTask(node.kind, node.data.commerceTask)
  assertCommerceTaskConfiguration(task, order, node.data, node.data.interiorTask, node.data.exteriorTask, node.data.storyboardTask)
  assertExteriorAnalysisConfiguration(node, edges, nodes)
  assertStoryboardAnalysisConfiguration(node, edges, nodes)
  if (!order) return
  const incoming = edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:images')
  const configuredEdges = new Set(order.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
  if (incoming.some((edge) => !configuredEdges.has(edge.id))) throw new Error('新连接的图片尚未分配角色，请打开创作配置核对')
  const knownAssets = new Set<string>()
  for (const slot of order.slots) {
    const edge = 'edgeId' in slot ? incoming.find((candidate) => candidate.id === slot.edgeId) : undefined
    if (!edge || !('outputIndex' in slot)) throw new Error('原图或参考图位置已失联，请重新绑定；不会使用其他图片')
    const source = nodes.get(edge.source)
    if (!source || !['out:image', 'out:images'].includes(edge.sourceHandle)) throw new Error('参考图片来源或端口不正确')
    if (edge.sourceHandle === 'out:image' && slot.outputIndex !== 0) throw new Error('单图参考只能选择第一个输出位置')
    if (edge.sourceHandle === 'out:image' && source.data.adoptedAssetId) {
      if (knownAssets.has(source.data.adoptedAssetId)) throw new Error('原图和参考图必须是不同的实际图片，请检查重复素材')
      knownAssets.add(source.data.adoptedAssetId)
    }
    if (edge.sourceHandle === 'out:images') {
      if (source.kind !== 'image-grid-split' || source.data.imageTransform?.kind !== 'grid-split') throw new Error('此批次参考无法预先核对稳定输出位置，请使用单图端口')
      if (slot.outputIndex >= source.data.imageTransform.rows * source.data.imageTransform.columns) throw new Error('参考图片位置超出当前批次范围')
    }
  }
}

export function commerceSourceAssetId(node: CanvasRunGraph['nodes'][number], edges: readonly CanvasRunGraph['edges'][number][], nodes: ReadonlyMap<string, CanvasRunGraph['nodes'][number]>): string | undefined {
  const slot = node.data.imageReferenceOrder?.slots[0]
  const edge = slot && 'edgeId' in slot ? edges.find((candidate) => candidate.id === slot.edgeId && candidate.target === node.id) : undefined
  return edge?.sourceHandle === 'out:image' ? nodes.get(edge.source)?.data.adoptedAssetId : undefined
}
