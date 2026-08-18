import type { CanvasRunGraph, CanvasRunScope } from '../host'

const imageRunNodeKinds = new Set(['image', 'image-generate', 'image-edit'])
const videoRunNodeKinds = new Set(['video', 'video-generate'])
const paidRunNodeKinds = new Set([...imageRunNodeKinds, ...videoRunNodeKinds])
const assetInputKinds = new Set(['image-input', 'video-input', 'audio-input'])

export type CanvasPreflightSeverity = 'info' | 'warning' | 'blocking'
export type CanvasPreflightAction = 'execute' | 'cached' | 'skip' | 'blocked'

export interface CanvasRunPreflightInput {
  graph: CanvasRunGraph
  scope: CanvasRunScope
  cachedNodeIds?: readonly string[]
  imageGroup?: string
  videoGroup?: string
  imageModels: readonly string[]
  videoModels: readonly string[]
}

export interface CanvasRunPreflightItem {
  nodeId: string
  kind: string
  action: CanvasPreflightAction
  paid: boolean
  group?: string
  model?: string
  reason?: string
}

export interface CanvasRunPreflight {
  scope: CanvasRunScope
  selectedNodeIds: string[]
  items: CanvasRunPreflightItem[]
  groups: string[]
  models: string[]
  requestCount: number
  cacheHitCount: number
  skippedCount: number
  blockedCount: number
  paidRequestCount: number
  imageRequestCount: number
  videoRequestCount: number
  risk: CanvasPreflightSeverity
  warnings: string[]
  canStart: boolean
}

function selectCanvasRunNodeIds(graph: CanvasRunGraph, scope: CanvasRunScope): Set<string> {
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  if (scope.kind === 'all') return nodeIds
  const roots = scope.kind === 'to-node' ? [scope.nodeId] : scope.nodeIds
  if (roots.length === 0) throw new Error('运行范围不能为空')
  const incoming = new Map<string, string[]>()
  for (const edge of graph.edges) incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
  const selected = new Set<string>()
  const queue = [...new Set(roots)]
  while (queue.length > 0) {
    const current = queue.pop() as string
    if (!nodeIds.has(current)) throw new Error(`运行范围包含不存在的节点：${current}`)
    if (selected.has(current)) continue
    selected.add(current)
    for (const source of incoming.get(current) ?? []) queue.push(source)
  }
  return selected
}

export function selectCanvasRunNodeIdsForPreflight(graph: CanvasRunGraph, scope: CanvasRunScope): Set<string> {
  return selectCanvasRunNodeIds(graph, scope)
}

function scopeLabel(scope: CanvasRunScope): string {
  if (scope.kind === 'all') return '全部节点'
  if (scope.kind === 'dirty') return `变更链路（${scope.nodeIds.length} 个入口）`
  if (scope.kind === 'selection') return `选中链路（${scope.nodeIds.length} 个入口）`
  return '运行到选中节点'
}

function nodeGroup(node: CanvasRunGraph['nodes'][number], input: CanvasRunPreflightInput): string | undefined {
  if (imageRunNodeKinds.has(node.kind)) return node.data.group || input.imageGroup
  if (videoRunNodeKinds.has(node.kind)) return node.data.group || input.videoGroup
  return node.data.group
}

function modelAvailable(node: CanvasRunGraph['nodes'][number], input: CanvasRunPreflightInput): boolean {
  if (imageRunNodeKinds.has(node.kind)) return input.imageModels.includes(node.data.model)
  if (videoRunNodeKinds.has(node.kind)) return input.videoModels.includes(node.data.model)
  return true
}

export function buildCanvasRunPreflight(input: CanvasRunPreflightInput): CanvasRunPreflight {
  const selected = selectCanvasRunNodeIds(input.graph, input.scope)
  const cached = new Set(input.cachedNodeIds ?? [])
  const items: CanvasRunPreflightItem[] = []
  const warnings: string[] = []
  for (const node of input.graph.nodes) {
    if (!selected.has(node.id)) continue
    const paid = paidRunNodeKinds.has(node.kind)
    const group = nodeGroup(node, input)
    let action: CanvasPreflightAction = cached.has(node.id) ? 'cached' : 'execute'
    let reason: string | undefined
    if (node.disabled) {
      action = 'skip'
      reason = '节点已禁用'
    } else if (paid && !group) {
      action = 'blocked'
      reason = node.kind.startsWith('video') ? '缺少视频分组' : '缺少生图分组'
    } else if (paid && !modelAvailable(node, input)) {
      action = 'blocked'
      reason = `模型「${node.data.model || '未设置'}」不属于当前分组`
    } else if (assetInputKinds.has(node.kind) && !node.data.adoptedAssetId) {
      action = 'blocked'
      reason = '缺少已保存的本地素材'
    }
    items.push({ nodeId: node.id, kind: node.kind, action, paid, ...(group ? { group } : {}), ...(node.data.model ? { model: node.data.model } : {}), ...(reason ? { reason } : {}) })
    if (action === 'blocked') warnings.push(`${node.id}：${reason}`)
  }
  const requestCount = items.filter((item) => item.action === 'execute').length
  const cacheHitCount = items.filter((item) => item.action === 'cached').length
  const skippedCount = items.filter((item) => item.action === 'skip').length
  const blockedCount = items.filter((item) => item.action === 'blocked').length
  const paidRequestCount = items.filter((item) => item.action === 'execute' && item.paid).length
  const imageRequestCount = items.filter((item) => item.action === 'execute' && imageRunNodeKinds.has(item.kind)).length
  const videoRequestCount = items.filter((item) => item.action === 'execute' && videoRunNodeKinds.has(item.kind)).length
  if (paidRequestCount > 0) warnings.push(`本次最多提交 ${paidRequestCount} 个付费生成请求；不确定的上游提交不会自动重试`)
  if (cacheHitCount > 0) warnings.push(`已有 ${cacheHitCount} 个节点可复用缓存结果`)
  return {
    scope: structuredClone(input.scope),
    selectedNodeIds: input.graph.nodes.filter((node) => selected.has(node.id)).map((node) => node.id),
    items,
    groups: [...new Set(items.map((item) => item.group).filter((group): group is string => Boolean(group)))],
    models: [...new Set(items.map((item) => item.model).filter((model): model is string => Boolean(model)))],
    requestCount,
    cacheHitCount,
    skippedCount,
    blockedCount,
    paidRequestCount,
    imageRequestCount,
    videoRequestCount,
    risk: blockedCount > 0 ? 'blocking' : paidRequestCount > 0 ? 'warning' : 'info',
    warnings: [scopeLabel(input.scope), ...warnings],
    canStart: selected.size > 0 && blockedCount === 0,
  }
}
