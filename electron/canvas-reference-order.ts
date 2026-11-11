import type {
  CanvasImageReferenceOrder,
  CanvasImageReferenceSlot,
  CanvasReferenceIdentity,
  CanvasRunGraph,
  CanvasRunGraphNode,
  CanvasVideoReferenceOrder,
} from './canvas-run-contract'
import { isRecord } from './input-guards'

// 画布完善第 8 条（场景入口）第一步：参考图角色和视频素材顺序。规矩跟网页服务端同一套（xingmang-canvas
// lib/canvas-runs.ts 用的是内核 commerce/image-reference-order.ts、commerce/image-task-configuration.ts、
// video-tools/video-reference-order.ts），这里逐字照搬，canvas-reference-order.test.ts 跟内核那份对拍。
// 画布已经按这套拦过，主进程在发请求前再核一遍，因为画布说了不算。顺序只认「哪根连线的第几张」，
// 只能给节点本来就收到的图排位置，点不了别的素材。

export type CanvasImageReferenceRole = 'source' | 'reference'

const imageReferenceKinds = new Set(['image', 'image-generate', 'image-edit', 'text-generate'])
const videoReferenceKinds = new Set(['video', 'video-generate'])
const maximumImageReferenceSlots = 4
export const maximumCanvasVideoReferenceSlots = 12

function validEdgeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}

function validOutputIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 20
}

export function canvasReferenceIdentityKey(value: CanvasReferenceIdentity): string {
  return JSON.stringify([value.edgeId, value.outputIndex])
}

export function canvasImageReferenceNodeKind(kind: string): boolean {
  return imageReferenceKinds.has(kind)
}

export function canvasVideoReferenceNodeKind(kind: string): boolean {
  return videoReferenceKinds.has(kind)
}

/** The kernel's parseImageReferenceOrder, word for word. */
export function parseCanvasImageReferenceOrder(value: unknown): CanvasImageReferenceOrder {
  if (!isRecord(value)) throw new Error('参考图片角色配置格式不正确')
  if (value.version !== 1 || Object.keys(value).some((key) => key !== 'version' && key !== 'slots') || !Array.isArray(value.slots) || value.slots.length < 1 || value.slots.length > maximumImageReferenceSlots) {
    throw new Error('参考图片角色需要 1 到 4 个位置，且版本须为 1')
  }
  const seen = new Set<string>()
  const slots = value.slots.map((entry: unknown, index): CanvasImageReferenceSlot => {
    if (!isRecord(entry)) throw new Error('参考图片位置格式不正确')
    const expected: CanvasImageReferenceRole = index === 0 ? 'source' : 'reference'
    if (entry.role !== expected) throw new Error('第一个参考位置必须是原图，其余位置必须是参考图')
    const keys = Object.keys(entry)
    if (entry.missing === true) {
      if (keys.length !== 2 || keys.some((key) => key !== 'role' && key !== 'missing')) throw new Error('缺失的参考图片位置不能携带旧连线或资产身份')
      return { role: expected, missing: true }
    }
    if (keys.length !== 3 || keys.some((key) => key !== 'role' && key !== 'edgeId' && key !== 'outputIndex')
      || !validEdgeId(entry.edgeId) || !validOutputIndex(entry.outputIndex)) throw new Error('参考图片连线或批次位置无效')
    const parsed = { role: expected, edgeId: entry.edgeId, outputIndex: entry.outputIndex }
    const key = canvasReferenceIdentityKey(parsed)
    if (seen.has(key)) throw new Error('参考图片不能重复使用同一连线位置')
    seen.add(key)
    return parsed
  })
  return { version: 1, slots }
}

/** The kernel's parseNodeImageReferenceOrder. */
export function parseCanvasNodeImageReferenceOrder(kind: string, value: unknown): CanvasImageReferenceOrder {
  if (!canvasImageReferenceNodeKind(kind)) throw new Error('此节点不支持参考图片角色配置')
  return parseCanvasImageReferenceOrder(value)
}

/**
 * The kernel's orderImageReferenceInputs: an explicit slot is authoritative.
 * A missing or new connection never silently changes which picture is first.
 */
export function orderCanvasImageReferenceInputs<T extends CanvasReferenceIdentity & { assetId?: string }>(
  inputs: readonly T[],
  value: CanvasImageReferenceOrder,
  incomingEdgeIds?: readonly string[],
): T[] {
  const order = parseCanvasImageReferenceOrder(value)
  const byKey = new Map(inputs.map((input) => [canvasReferenceIdentityKey(input), input]))
  const configuredEdges = new Set(order.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
  if (incomingEdgeIds?.some((id) => !configuredEdges.has(id))) throw new Error('有新接入的参考图片尚未分配角色，请打开创作配置核对；不会自动加入模型请求')
  const usedAssets = new Set<string>()
  return order.slots.map((slot) => {
    const input = 'edgeId' in slot ? byKey.get(canvasReferenceIdentityKey(slot)) : undefined
    if (!input) throw new Error(`${slot.role === 'source' ? '原图' : '参考图'}位置已失联或尚未就绪，请重新绑定；不会改用其他图片`)
    if (input.assetId) {
      if (usedAssets.has(input.assetId)) throw new Error('原图和参考图必须是不同的实际图片，请检查重复素材')
      usedAssets.add(input.assetId)
    }
    return input
  })
}

/** The kernel's imageReferenceRolePrompt: names each picture's role ahead of the prompt. */
export function canvasImageReferenceRolePrompt(value: CanvasImageReferenceOrder, prompt: string): string {
  const order = parseCanvasImageReferenceOrder(value)
  return `${order.slots.map((slot, index) => `第 ${index + 1} 张图片：${slot.role === 'source' ? '原始主体图' : '辅助参考图'}。`).join('\n')}\n${prompt}`
}

/**
 * The order checks of the kernel's assertImageReferenceRunConfiguration, run
 * before a single paid request. The scene-task checks join it with them.
 */
export function assertCanvasImageReferenceRunConfiguration(
  node: CanvasRunGraphNode,
  edges: CanvasRunGraph['edges'],
  nodes: ReadonlyMap<string, CanvasRunGraphNode>,
): void {
  const order = node.data.imageReferenceOrder
  if (!order) return
  const incoming = edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:images')
  const configuredEdges = new Set(order.slots.flatMap((slot) => 'edgeId' in slot ? [slot.edgeId] : []))
  if (incoming.some((edge) => !configuredEdges.has(edge.id))) throw new Error('新连接的图片尚未分配角色，请打开创作配置核对')
  const knownAssets = new Set<string>()
  for (const slot of order.slots) {
    const edge = 'edgeId' in slot ? incoming.find((candidate) => candidate.id === slot.edgeId) : undefined
    if (!edge || !('outputIndex' in slot)) throw new Error('原图或参考图位置已失联，请重新绑定；不会使用其他图片')
    const source = nodes.get(edge.source)
    if (!source || (edge.sourceHandle !== 'out:image' && edge.sourceHandle !== 'out:images')) throw new Error('参考图片来源或端口不正确')
    if (edge.sourceHandle === 'out:image' && slot.outputIndex !== 0) throw new Error('单图参考只能选择第一个输出位置')
    if (edge.sourceHandle === 'out:image' && source.data.adoptedAssetId) {
      if (knownAssets.has(source.data.adoptedAssetId)) throw new Error('原图和参考图必须是不同的实际图片，请检查重复素材')
      knownAssets.add(source.data.adoptedAssetId)
    }
    if (edge.sourceHandle === 'out:images') {
      const recipe = source.data.imageTransform
      if (source.kind !== 'image-grid-split' || recipe?.kind !== 'grid-split') throw new Error('此批次参考无法预先核对稳定输出位置，请使用单图端口')
      if (slot.outputIndex >= gridCells(recipe)) throw new Error('参考图片位置超出当前批次范围')
    }
  }
}

// The parser has already checked rows and columns (1-4) on a grid split the
// desktop runs; anything else would have been refused before this.
function gridCells(recipe: { [field: string]: unknown }): number {
  const rows = recipe.rows
  const columns = recipe.columns
  return typeof rows === 'number' && typeof columns === 'number' ? rows * columns : 0
}

/** The kernel's parseVideoReferenceOrder, word for word. */
export function parseCanvasVideoReferenceOrder(value: unknown): CanvasVideoReferenceOrder {
  if (!isRecord(value)) throw new Error('视频参考顺序格式不正确')
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'slots') || value.version !== 1 || !Array.isArray(value.slots) || value.slots.length > maximumCanvasVideoReferenceSlots) {
    throw new Error('视频参考顺序最多保存 12 个素材位置')
  }
  const seen = new Set<string>()
  const slots = value.slots.map((entry: unknown): CanvasReferenceIdentity => {
    if (!isRecord(entry)) throw new Error('视频参考位置格式不正确')
    if (Object.keys(entry).some((key) => key !== 'edgeId' && key !== 'outputIndex') || !validEdgeId(entry.edgeId) || !validOutputIndex(entry.outputIndex)) {
      throw new Error('视频参考的连线或批次位置无效')
    }
    const parsed = { edgeId: entry.edgeId, outputIndex: entry.outputIndex }
    const key = canvasReferenceIdentityKey(parsed)
    if (seen.has(key)) throw new Error('视频参考顺序不能包含重复位置')
    seen.add(key)
    return parsed
  })
  return { version: 1, slots }
}

/** The kernel's orderVideoReferences: saved slots first, anything else keeps its place after them. */
export function orderCanvasVideoReferences<T extends CanvasReferenceIdentity>(inputs: readonly T[], order: CanvasVideoReferenceOrder | undefined): T[] {
  if (!order) return [...inputs]
  const rank = new Map(order.slots.map((slot, index) => [canvasReferenceIdentityKey(slot), index]))
  return inputs
    .map((input, index) => ({ input, index, rank: rank.get(canvasReferenceIdentityKey(input)) ?? order.slots.length + index }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ input }) => input)
}

/** The kernel's assertVideoReferenceSlots: a saved slot that is gone stops the request. */
export function assertCanvasVideoReferenceSlots(inputs: readonly CanvasReferenceIdentity[], order: CanvasVideoReferenceOrder | undefined): void {
  const keys = new Set(inputs.map(canvasReferenceIdentityKey))
  if (order?.slots.some((slot) => !keys.has(canvasReferenceIdentityKey(slot)))) throw new Error('已保存的视频参考位置缺失，请核对首尾帧并重新确认参考顺序；当前不会提交生成')
}
