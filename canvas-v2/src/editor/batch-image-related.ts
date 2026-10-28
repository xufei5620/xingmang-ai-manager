import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { EditorEdgeRecord, EditorNodeRecord } from '../domain/node-definition'
import { defaultImageTransformRecipe } from '../image-tools/recipe'
import { isValidWorkflowConnection } from '../ports'
import type { CanvasCommand } from '../store/canvas-command'
import { validateParentGraph } from './grouping'

export type BatchImageRelatedTarget = 'image-collage' | 'image-compare' | 'image-layer' | 'image-tile'
export interface BatchImageRelatedSource {
  id: string
  type: string
  title: string
  position: { x: number; y: number }
  width: number
  height: number
  outputLabel: string
  disabled: boolean
  previewAssetId?: string
}
export interface BatchImageRelatedAnalysis {
  sources: BatchImageRelatedSource[]
  disabledReason?: string
}
export interface BatchImageRelatedOption {
  type: BatchImageRelatedTarget
  title: string
  description: string
  disabledReason?: string
}

/** Selection order is spatial and visible, never dependent on React Flow's node array order. */
export function analyzeBatchImageRelatedSources(nodes: readonly EditorNodeRecord[], sourceIds: readonly string[]): BatchImageRelatedAnalysis {
  const invalid = (disabledReason: string): BatchImageRelatedAnalysis => ({ sources: [], disabledReason })
  if (sourceIds.length < 2 || sourceIds.length > 20) return invalid('请选择 2–20 个具有图片输出的节点。')
  const byId = new Map(nodes.map((node) => [node.id, node]))
  if (byId.size !== nodes.length || new Set(sourceIds).size !== sourceIds.length || !validateParentGraph(nodes)) return invalid('节点标识或分组层级无效，请重新打开工程后再试。')
  const sources: BatchImageRelatedSource[] = []
  for (const id of sourceIds) {
    const node = byId.get(id)
    if (!node) return invalid('选中的节点已发生变化，请重新选择。')
    if (node.type === 'group') return invalid('选区包含分组，请直接选择分组内的图片节点；不会自动展开或忽略分组。')
    const definition = builtinNodeRegistry.resolve(node.type)
    if (!definition?.ports.some((port) => port.id === 'out:image' && port.kind === 'image' && port.direction === 'output')) return invalid('选区包含没有图片输出的节点，请只选择图片来源；不会忽略其他节点。')
    let position = { ...node.position }, parent = node.parentId ? byId.get(node.parentId) : undefined
    while (parent) { position = { x: position.x + parent.position.x, y: position.y + parent.position.y }; parent = parent.parentId ? byId.get(parent.parentId) : undefined }
    const width = node.width ?? definition.dimensions.width, height = node.height ?? definition.dimensions.height
    if (![position.x, position.y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return invalid('图片节点尺寸或坐标无效，请重新打开工程后再试。')
    const settings = node.data.settings
    const title = settings && typeof settings === 'object' && typeof Reflect.get(settings, 'title') === 'string' ? String(Reflect.get(settings, 'title')).trim() : ''
    const hasBatch = definition.ports.some((port) => port.id === 'out:images')
    const result = node.data.result
    const previewAssetId = result && typeof result === 'object' && Reflect.get(result, 'kind') === 'image' ? Reflect.get(result, 'assetId') : undefined
    sources.push({ id, type: node.type, title: title || definition.title, position, width, height, outputLabel: hasBatch ? '当前切片（不含全部切片）' : node.type === 'gallery' || node.type === 'router' ? '图片端口单图（不含全部候选）' : '单张图片输出', disabled: node.disabled === true, ...(typeof previewAssetId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(previewAssetId) ? { previewAssetId } : {}) })
  }
  sources.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { sources }
}

export function batchImageRelatedOptions(count: number): BatchImageRelatedOption[] {
  const invalid = count < 2 || count > 20 ? '请选择 2–20 个图片来源。' : undefined
  return [
    { type: 'image-collage', title: '拼图', description: '按来源数量设置网格行列，依次放入每张图片。', disabledReason: invalid ?? (count > 16 ? '网格拼图最多 16 张；更多图片可另建横向或纵向拼图。' : undefined) },
    { type: 'image-compare', title: '图片对比', description: '两图滑动、三图并排、四图网格对比。', disabledReason: invalid ?? (count > 4 ? '此次关联对比支持 2–4 张图片，请缩小选区。' : undefined) },
    { type: 'image-layer', title: '图层合成', description: '按顺序建立图层输入，在编辑器中调整叠放。', disabledReason: invalid },
    { type: 'image-tile', title: '平铺贴图', description: '连接多张图片切换预览，每次只处理选中的贴图。', disabledReason: invalid },
  ]
}

export function batchImageRelatedConfig(type: BatchImageRelatedTarget, count: number): Record<string, unknown> {
  const option = batchImageRelatedOptions(count).find((entry) => entry.type === type)
  if (!option || option.disabledReason) throw new Error(option?.disabledReason ?? '不支持此关联图片工具')
  if (type === 'image-collage') {
    const columns = Math.ceil(Math.sqrt(count))
    return { imageTransform: { ...defaultImageTransformRecipe('collage'), rows: Math.ceil(count / columns), columns } }
  }
  if (type === 'image-compare') return { imageCompare: count === 2 ? { mode: 'slider', a: '0', b: '1' } : count === 3 ? { mode: 'side-by-side', a: '0', b: '1', c: '2', sideBySideCount: 3 } : { mode: 'grid', grid: ['0', '1', '2', '3'] } }
  return { imageTransform: defaultImageTransformRecipe(type === 'image-tile' ? 'tile' : 'layer') }
}

export function batchImageRelatedCenter(sources: readonly BatchImageRelatedSource[]): { x: number; y: number } {
  if (!sources.length) throw new Error('请先选择图片来源')
  const top = Math.min(...sources.map((source) => source.position.y))
  const bottom = Math.max(...sources.map((source) => source.position.y + source.height))
  return { x: Math.max(...sources.map((source) => source.position.x + source.width)) + 220, y: (top + bottom) / 2 }
}

/** Preserve the confirmed order even if a source moves while the dialog is open.
 * Revalidate all sources against the latest graph; no partial command escapes. */
export function buildBatchImageRelatedCommand(input: {
  nodes: readonly EditorNodeRecord[]
  edges: readonly EditorEdgeRecord[]
  sources: readonly Pick<BatchImageRelatedSource, 'id' | 'type'>[]
  target: EditorNodeRecord
  edgeIds: readonly string[]
}): Extract<CanvasCommand, { type: 'add-nodes' }> {
  const analysis = analyzeBatchImageRelatedSources(input.nodes, input.sources.map((source) => source.id))
  if (analysis.disabledReason) throw new Error(analysis.disabledReason)
  const option = batchImageRelatedOptions(input.sources.length).find((entry) => entry.type === input.target.type)
  if (!option || option.disabledReason) throw new Error(option?.disabledReason ?? '不支持此关联图片工具')
  if (input.target.parentId || input.nodes.some((node) => node.id === input.target.id)) throw new Error('新节点位置或标识已失效，请重新创建')
  const current = new Map(analysis.sources.map((source) => [source.id, source]))
  if (input.sources.some((source) => source.type !== current.get(source.id)?.type)) throw new Error('图片来源类型已发生变化，请重新选择')
  const usedIds = new Set(input.edges.map((edge) => edge.id))
  if (input.edgeIds.length !== input.sources.length || new Set(input.edgeIds).size !== input.edgeIds.length || input.edgeIds.some((id) => !id || usedIds.has(id))) throw new Error('连线标识无效，请重新创建')
  const kinds = new Map(input.nodes.map((node) => [node.id, node.type]))
  kinds.set(input.target.id, input.target.type)
  const edges: EditorEdgeRecord[] = []
  for (const [index, source] of input.sources.entries()) {
    const edge = { id: input.edgeIds[index], source: source.id, sourceHandle: 'out:image', target: input.target.id, targetHandle: input.target.type === 'image-tile' ? 'in:image' : 'in:images' }
    if (!isValidWorkflowConnection(edge, { nodeKindOf: (id) => kinds.get(id) ?? null, edges: [...input.edges, ...edges] })) throw new Error('图片端口已变化，本次没有创建节点或连线')
    edges.push(edge)
  }
  const target = structuredClone(input.target)
  if (target.type === 'image-compare') {
    const settings = target.data.settings && typeof target.data.settings === 'object' ? target.data.settings : {}
    const compare = Reflect.get(settings, 'imageCompare')
    target.data.settings = { ...settings, imageCompare: { ...(compare && typeof compare === 'object' ? compare : {}), inputSlots: edges.map((edge) => JSON.stringify([edge.id, 0])) } }
  }
  return { type: 'add-nodes', nodes: [target], edges }
}
