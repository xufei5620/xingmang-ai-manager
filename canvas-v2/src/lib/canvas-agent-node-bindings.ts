import { parseNodeRouterStrategy } from '../runtime/router-strategy'
import { parseNodeStoryboardTask } from '../storyboard/storyboard-task'
import { parseNodeExteriorTask } from '../exterior/exterior-task'
import { parseNodeInteriorTask } from '../interior/interior-task'
import { parseNodeImageReferenceOrder } from '../commerce/image-reference-order'
import type { WorkflowEdge, WorkflowFile, WorkflowNode } from '../model'
import { imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { canvasImageInputCardinality, canvasImageTransformInputErrors } from '../runtime/image-input-cardinality'
import type { CanvasRunGraph } from '../host'
import { parseCanvasAgentNodeSettings, type CanvasAgentNodeSettings } from './canvas-agent-node-settings'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 图片来源格式无效')
  return value as Record<string, unknown>
}

function cardinalityNodes(nodes: Iterable<WorkflowNode>): Map<string, CanvasRunGraph['nodes'][number]> {
  return new Map([...nodes].map(node => [node.id, { id: node.id, kind: node.kind, definitionVersion: node.definitionVersion ?? 1, data: { prompt: '', model: '', ...(Object.hasOwn(node.data.settings ?? {}, 'routerStrategy') ? { routerStrategy: parseNodeRouterStrategy(node.kind, node.data.settings?.routerStrategy) } : {}), ...(node.kind === 'image-input' && node.data.result ? { adoptedAssetId: node.data.result.assetId } : {}), ...(isImageTransformNodeKind(node.kind) ? { imageTransform: imageTransformRecipeForNode(node.kind, node.data.settings)! } : {}) } }]))
}
function outputCount(node: WorkflowNode, handle: string, nodes: Iterable<WorkflowNode>, edges: readonly WorkflowEdge[]): number {
  if (node.kind === 'router' && Object.hasOwn(node.data.settings ?? {}, 'routerStrategy')) {
    const count = canvasImageInputCardinality([{ source: node.id, sourceHandle: handle }], cardinalityNodes(nodes), edges)
    if (!count.exact) throw new Error('Agent 不能猜测尚未确认的路由图片位置，请先核对完整来源')
    return count.minimum
  }
  if (handle !== 'out:images') return 1
  const recipe = imageTransformRecipeForNode(node.kind, node.data.settings)
  if (recipe?.kind !== 'grid-split') throw new Error('Agent 不能猜测未知图片批次的位置，请改用单图输出')
  return recipe.rows * recipe.columns
}

/** Resolve capabilities only after all proposed edges exist. Raw IDs never enter the model protocol. */
export function resolveCanvasAgentModelSettings(value: unknown, target: WorkflowNode, refs: ReadonlyMap<string, WorkflowNode>, edges: readonly WorkflowEdge[]): CanvasAgentNodeSettings {
  const settings = structuredClone(object(value))
  function identity(value: unknown): { edgeId: string; outputIndex: number } {
    const raw = object(value)
    if (Object.keys(raw).some((key) => !['source', 'sourceHandle', 'outputIndex'].includes(key)) || typeof raw.source !== 'string' || !/^[sn]\d{1,3}$/.test(raw.source)) throw new Error('Agent 图片来源只能引用本次 s/n 节点')
    const source = refs.get(raw.source)
    if (!source || !['out:image', 'out:images'].includes(String(raw.sourceHandle))) throw new Error('Agent 图片来源节点或端口不可用')
    const matches = edges.filter((edge) => edge.source === source.id && edge.target === target.id && edge.sourceHandle === raw.sourceHandle && edge.targetHandle === 'in:images')
    if (matches.length !== 1) throw new Error('Agent 图片来源必须对应一条已连接到当前节点的图像连线')
    if (!Number.isInteger(raw.outputIndex) || Number(raw.outputIndex) < 0 || Number(raw.outputIndex) >= outputCount(source, String(raw.sourceHandle), refs.values(), edges)) throw new Error('Agent 图片来源批次位置超出实际输出范围')
    return { edgeId: matches[0].id, outputIndex: Number(raw.outputIndex) }
  }
  if (settings.imageCollageInputOrder !== undefined) {
    const order = object(settings.imageCollageInputOrder)
    if (Object.keys(order).some((key) => !['version', 'slots'].includes(key)) || order.version !== 1 || !Array.isArray(order.slots)) throw new Error('Agent 拼图来源顺序格式无效')
    settings.imageCollageInputOrder = { version: 1, slots: order.slots.map(identity) }
  }
  if (settings.imageCompare !== undefined) {
    const compare = object(settings.imageCompare)
    if (compare.inputSlots !== undefined) {
      if (!Array.isArray(compare.inputSlots)) throw new Error('Agent 图片对比来源位置必须是数组')
      compare.inputSlots = compare.inputSlots.map((slot) => { const parsed = identity(slot); return JSON.stringify([parsed.edgeId, parsed.outputIndex]) })
    }
  }
  return parseCanvasAgentNodeSettings(settings, target.kind)
}

/** Revalidate reviewed identities against the resulting graph, not the model's aliases. */
export function assertCanvasAgentNodeBindings(node: WorkflowNode, workflow: WorkflowFile, settings?: CanvasAgentNodeSettings): void {
  const byId = new Map(workflow.nodes.map((entry) => [entry.id, entry]))
  function check(edgeId: string, index: number) {
    const edge = workflow.edges.find((entry) => entry.id === edgeId && entry.target === node.id && entry.targetHandle === 'in:images')
    const source = edge && byId.get(edge.source)
    if (!edge || !source || !['out:image', 'out:images'].includes(edge.sourceHandle) || index >= outputCount(source, edge.sourceHandle, workflow.nodes, workflow.edges)) throw new Error('Agent 配置引用的图片输入或批次已变化')
  }
  for (const slot of settings?.imageCollageInputOrder?.slots ?? []) check(slot.edgeId, slot.outputIndex)
  for (const slot of settings?.imageCompare?.inputSlots ?? []) { const [edge, index] = JSON.parse(slot) as [string, number]; check(edge, index) }
  if (settings?.imageCompare?.inputSlots) {
    const compare = settings.imageCompare, count = compare.inputSlots!.length
    for (const selected of [compare.a, compare.b, compare.c, ...(compare.grid ?? [])]) if (selected !== undefined && selected !== null && selected !== 'missing' && Number(selected) >= count) throw new Error('Agent 图片对比选择超出已声明来源位置')
  }
  if (!isImageTransformNodeKind(node.kind)) return
  const recipe = imageTransformRecipeForNode(node.kind, node.data.settings)!
  const sources = workflow.edges.filter((edge) => edge.target === node.id && ['in:image', 'in:images'].includes(edge.targetHandle))
  // Unconnected tools are useful upload placeholders. Connected but impossible
  // recipes fail here instead of producing a proposal that can never execute.
  if (!sources.length) return
  const runNodes = cardinalityNodes(workflow.nodes)
  const count = canvasImageInputCardinality(sources, runNodes, workflow.edges)
  const errors = canvasImageTransformInputErrors(recipe, count)
  if (errors.length) throw new Error(`Agent 本地流程配置无效：${errors.join('；')}`)
}

/** Include complete safe settings, replacing private edge identities with selected aliases. */
export function canvasAgentNodeSettingsContext(node: WorkflowNode, workflow: WorkflowFile, selected: readonly WorkflowNode[]): Record<string, unknown> | undefined {
  if (node.data.settings && Object.hasOwn(node.data.settings, 'storyboardTask')) {
    const task = parseNodeStoryboardTask(node.kind, node.data.settings.storyboardTask)
    const order = parseNodeImageReferenceOrder(node.kind, node.data.settings.imageReferenceOrder)
    return { storyboardTask: task, configurationEditable: false, note: '故事板参数在专用配置中修改；剧情与参数请在故事板专用配置中修改，自动剧情的分析必须同步更新；不得删除或替换任务。', imageReferenceOrder: { version: 1, slots: order.slots.map((slot) => {
      const edge = 'edgeId' in slot ? workflow.edges.find((item) => item.id === slot.edgeId && item.target === node.id) : undefined
      const source = selected.findIndex((item) => item.id === edge?.source)
      return edge && source >= 0 && 'outputIndex' in slot ? { role: slot.role, source: `s${source}`, sourceHandle: edge.sourceHandle, outputIndex: slot.outputIndex } : { role: slot.role, unavailable: true }
    }) } }
  }
  if (node.data.settings && Object.hasOwn(node.data.settings, 'exteriorTask')) {
    const task = parseNodeExteriorTask(node.kind, node.data.settings.exteriorTask)
    const order = parseNodeImageReferenceOrder(node.kind, node.data.settings.imageReferenceOrder)
    return { exteriorTask: task, configurationEditable: false, note: '室外参数在专用配置中修改；本次可修改补充提示词，不得删除或替换室外任务。', imageReferenceOrder: { version: 1, slots: order.slots.map((slot) => {
      const edge = 'edgeId' in slot ? workflow.edges.find((item) => item.id === slot.edgeId && item.target === node.id) : undefined
      const source = selected.findIndex((item) => item.id === edge?.source)
      return edge && source >= 0 && 'outputIndex' in slot ? { role: slot.role, source: `s${source}`, sourceHandle: edge.sourceHandle, outputIndex: slot.outputIndex } : { role: slot.role, unavailable: true }
    }) } }
  }
  if (node.data.settings && Object.hasOwn(node.data.settings, 'interiorTask')) {
    const task = parseNodeInteriorTask(node.kind, node.data.settings.interiorTask)
    const order = parseNodeImageReferenceOrder(node.kind, node.data.settings.imageReferenceOrder)
    return { interiorTask: task, configurationEditable: false, note: '室内参数在专用配置中修改；本次可修改补充提示词，不得删除或替换室内任务。', imageReferenceOrder: { version: 1, slots: order.slots.map((slot) => {
      const edge = 'edgeId' in slot ? workflow.edges.find((item) => item.id === slot.edgeId && item.target === node.id) : undefined
      const source = selected.findIndex((item) => item.id === edge?.source)
      return edge && source >= 0 && 'outputIndex' in slot ? { role: slot.role, source: `s${source}`, sourceHandle: edge.sourceHandle, outputIndex: slot.outputIndex } : { role: slot.role, unavailable: true }
    }) } }
  }
  const keys = ['imageTransform', 'imageCollageInputOrder', 'imageCompare', 'imagePanorama', 'timestampSeconds', 'routerStrategy']
  const raw = Object.fromEntries(keys.filter((key) => node.data.settings?.[key] !== undefined).map((key) => [key, node.data.settings![key]]))
  if (!Object.keys(raw).length && !isImageTransformNodeKind(node.kind)) return undefined
  if (isImageTransformNodeKind(node.kind) && raw.imageTransform === undefined) raw.imageTransform = imageTransformRecipeForNode(node.kind, node.data.settings)
  if (!canvasAgentRecipeContextAvailable(node)) return { unavailable: true, editable: false, reason: '现有配方包含像素选区；该区域数据只保留在原工程中，未发送给模型。请在图层编辑器修改，或新建独立处理节点。' }
  const settings = structuredClone(parseCanvasAgentNodeSettings(raw, node.kind)) as Record<string, unknown>
  function alias(edgeId: string, outputIndex: number) {
    const edge = workflow.edges.find((entry) => entry.id === edgeId && entry.target === node.id)
    const index = selected.findIndex((entry) => entry.id === edge?.source)
    return edge && index >= 0 ? { source: `s${index}`, sourceHandle: edge.sourceHandle, outputIndex } : { unavailable: true }
  }
  if (settings.imageCollageInputOrder) {
    const order = parseCanvasAgentNodeSettings({ imageCollageInputOrder: settings.imageCollageInputOrder }).imageCollageInputOrder!
    settings.imageCollageInputOrder = { version: 1, slots: order.slots.map((slot) => alias(slot.edgeId, slot.outputIndex)) }
  }
  if (settings.imageCompare) {
    const compare = parseCanvasAgentNodeSettings({ imageCompare: settings.imageCompare }).imageCompare!
    settings.imageCompare = { ...compare, ...(compare.inputSlots ? { inputSlots: compare.inputSlots.map((slot) => { const [edge, index] = JSON.parse(slot) as [string, number]; return alias(edge, index) }) } : {}) }
  }
  return settings
}

export function canvasAgentRecipeContextAvailable(node: WorkflowNode): boolean {
  function hasRaster(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasRaster)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, child]) => key === 'raster' || hasRaster(child))
  }
  return !hasRaster(node.data.settings?.imageTransform)
}

/** The recipe's sourceIndex uses the existing ordered input stream. Describe
 * that stream without granting access to an unselected source's configuration. */
export function canvasAgentInputSourcesContext(node: WorkflowNode, workflow: WorkflowFile, selected: readonly WorkflowNode[]): Record<string, unknown>[] {
  let imageStartIndex: number | null = 0
  return workflow.edges.filter((edge) => edge.target === node.id).map((edge) => {
    const index = selected.findIndex((source) => source.id === edge.source)
    const image = ['out:image', 'out:images'].includes(edge.sourceHandle)
    let imageCount: number | null = image ? 1 : null
    if (edge.sourceHandle === 'out:images' || index >= 0 && selected[index].kind === 'router' && Object.hasOwn(selected[index].data.settings ?? {}, 'routerStrategy')) {
      imageCount = null
      if (index >= 0) {
        try { imageCount = outputCount(selected[index], edge.sourceHandle, selected, workflow.edges) } catch { /* The current input is an unknown batch, never infer from old candidates. */ }
      }
    }
    const result = { ...(index < 0 ? { unavailable: true } : { source: `s${index}` }), sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle,
      ...(image ? { imageStartIndex, imageCount } : {}) }
    if (image) imageStartIndex = imageStartIndex !== null && imageCount !== null ? imageStartIndex + imageCount : null
    return result
  })
}
