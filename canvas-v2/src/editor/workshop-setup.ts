import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { CanvasRunGraph } from '../host'
import { buildCanvasRunPreflight, type CanvasRunPreflight, type CanvasRunPreflightInput } from '../runtime/run-preflight'

export type WorkshopSetupScopeKind = 'all' | 'selection' | 'inserted'
export type WorkshopSetupScope = { kind: 'all' } | { kind: 'selection' | 'inserted'; nodeIds: readonly string[] }
export type WorkshopSetupAction = 'pick-asset' | 'check-asset' | 'edit-prompt' | 'configure-model' | 'inspect-node'
export type WorkshopSetupCategory = 'media' | 'prompt' | 'configuration'

export interface WorkshopSetupNode {
  id: string
  kind: string
  parentId?: string
  locked?: boolean
  draggable?: boolean
  data: { prompt: string; settings?: Record<string, unknown> }
}

export interface WorkshopSetupAssetState {
  state: 'checking' | 'available' | 'missing' | 'failed'
  message?: string
}

export interface WorkshopSetupItem {
  id: string
  nodeId: string
  nodeTitle: string
  category: WorkshopSetupCategory
  action: WorkshopSetupAction
  message: string
  /** An unchecked asset remains a runtime check, not an invented success. */
  blocking: boolean
  mediaType?: 'image' | 'video' | 'audio'
  assetId?: string
  locked?: boolean
}

export interface WorkshopSetupInput {
  nodes: readonly WorkshopSetupNode[]
  graph: CanvasRunGraph
  scope: WorkshopSetupScope
  configuration: Omit<CanvasRunPreflightInput, 'graph' | 'scope'>
  assetStates?: Readonly<Record<string, WorkshopSetupAssetState | undefined>>
}

export interface WorkshopSetup {
  scope: WorkshopSetupScope
  scopeLabel: string
  /** Live selected nodes, including structural descendants. */
  scopeNodeIds: string[]
  /** Executable scope including required upstream dependencies. */
  nodeIds: string[]
  missingNodeIds: string[]
  items: WorkshopSetupItem[]
  blockingCount: number
  noticeCount: number
  readyNodeCount: number
  skippedNodeCount: number
  canReviewRun: boolean
  preflight?: CanvasRunPreflight
  error?: string
}

const assetKinds = new Map<string, 'image' | 'video' | 'audio'>([['image-input', 'image'], ['video-input', 'video'], ['audio-input', 'audio']])
const categoryOrder: Record<WorkshopSetupCategory, number> = { media: 0, prompt: 1, configuration: 2 }

function nodeTitle(node: WorkshopSetupNode | undefined, id: string, kind: string): string {
  const title = node?.data.settings?.title
  return typeof title === 'string' && title.trim() ? title.trim().slice(0, 128) : builtinNodeRegistry.resolve(kind)?.title ?? id
}

function expandScope(nodes: readonly WorkshopSetupNode[], scope: WorkshopSetupScope): { ids: string[]; missing: string[] } {
  if (scope.kind === 'all') return { ids: nodes.map((node) => node.id), missing: [] }
  const all = new Set(nodes.map((node) => node.id))
  const requested = [...new Set(scope.nodeIds)]
  const selected = new Set(requested.filter((id) => all.has(id)))
  // A group is a user's selection, while execution operates on its leaves.
  // Retain requested IDs outside this calculation so undo/redo can restore them.
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (!node.parentId || !selected.has(node.parentId) || selected.has(node.id)) continue
      selected.add(node.id)
      changed = true
    }
  }
  return { ids: nodes.filter((node) => selected.has(node.id)).map((node) => node.id), missing: requested.filter((id) => !all.has(id)) }
}

function hasTextSource(id: string, graph: CanvasRunGraph, skipped: ReadonlySet<string>, visiting = new Set<string>()): boolean {
  if (visiting.has(id)) return false
  const next = new Set(visiting).add(id)
  const target = graph.nodes.find((node) => node.id === id)
  return graph.edges.some((edge) => {
    if (edge.target !== id) return false
    const source = graph.nodes.find((node) => node.id === edge.source)
    if (!source || source.disabled || skipped.has(source.id)) return false
    const output = builtinNodeRegistry.resolve(source.kind)?.ports.find((port) => port.id === edge.sourceHandle && port.direction === 'output')
    const input = target && builtinNodeRegistry.resolve(target.kind)?.ports.find((port) => port.id === edge.targetHandle && port.direction === 'input')
    if (output?.kind !== 'text' || input?.kind !== 'text') return false
    return source.data.prompt.trim().length > 0 || ['text-generate', 'drama-parse'].includes(source.kind) || hasTextSource(source.id, graph, skipped, next)
  })
}

/** Local, current-graph preparation only. It never reads assets or submits a run. */
export function buildWorkshopSetup(input: WorkshopSetupInput): WorkshopSetup {
  const selected = expandScope(input.nodes, input.scope)
  const scopeLabel = input.scope.kind === 'all' ? '整张画布' : input.scope.kind === 'inserted' ? '本次插入' : '当前选区'
  const result: WorkshopSetup = {
    scope: input.scope.kind === 'all' ? { kind: 'all' } : { kind: input.scope.kind, nodeIds: [...input.scope.nodeIds] },
    scopeLabel, scopeNodeIds: selected.ids, nodeIds: [], missingNodeIds: selected.missing,
    items: [], blockingCount: 0, noticeCount: 0, readyNodeCount: 0, skippedNodeCount: 0, canReviewRun: false,
  }
  const selectedIds = new Set(selected.ids)
  const runIds = input.graph.nodes.filter((node) => selectedIds.has(node.id)).map((node) => node.id)
  if (!runIds.length) return result
  let preflight: CanvasRunPreflight
  try {
    preflight = buildCanvasRunPreflight({ ...input.configuration, graph: input.graph, scope: input.scope.kind === 'all' ? { kind: 'all' } : { kind: 'selection', nodeIds: runIds } })
  } catch (cause) {
    result.error = cause instanceof Error ? cause.message : '当前画布暂时无法检查，请核对节点与连线后重试'
    return result
  }
  result.preflight = preflight
  result.nodeIds = [...preflight.selectedNodeIds]
  result.skippedNodeCount = preflight.skippedCount
  const metadata = new Map(input.nodes.map((node) => [node.id, node]))
  const graphNodes = new Map(input.graph.nodes.map((node) => [node.id, node]))
  const skipped = new Set(preflight.items.filter((item) => item.action === 'skip').map((item) => item.nodeId))
  function locked(nodeId: string): boolean {
    const visited = new Set<string>()
    let current = metadata.get(nodeId)
    while (current && !visited.has(current.id)) {
      if (current.locked || current.draggable === false) return true
      visited.add(current.id)
      current = current.parentId ? metadata.get(current.parentId) : undefined
    }
    return false
  }
  function add(nodeId: string, kind: string, value: Omit<WorkshopSetupItem, 'id' | 'nodeId' | 'nodeTitle' | 'locked'>) {
    const node = metadata.get(nodeId)
    result.items.push({ ...value, id: `${nodeId}:${value.action}`, nodeId, nodeTitle: nodeTitle(node, nodeId, kind), ...(locked(nodeId) ? { locked: true } : {}) })
  }
  for (const item of preflight.items) {
    if (item.action === 'skip') continue
    const node = graphNodes.get(item.nodeId)!
    const mediaType = assetKinds.get(node.kind)
    if (mediaType) {
      const assetId = node.data.adoptedAssetId
      const state = assetId ? input.assetStates?.[assetId] : undefined
      if (!assetId) add(node.id, node.kind, { category: 'media', action: 'pick-asset', mediaType, blocking: true, message: `请选择或上传${mediaType === 'video' ? '视频' : mediaType === 'audio' ? '音频' : '图片'}素材` })
      else if (state?.state === 'missing') add(node.id, node.kind, { category: 'media', action: 'pick-asset', mediaType, assetId, blocking: true, message: state.message || '已绑定素材不可用，请重新选择素材' })
      else if (state?.state === 'failed') add(node.id, node.kind, { category: 'media', action: 'check-asset', mediaType, assetId, blocking: true, message: state.message || '素材读取失败，请重试核对或重新选择' })
      else if (state?.state !== 'available') add(node.id, node.kind, { category: 'media', action: 'check-asset', mediaType, assetId, blocking: false, message: state?.state === 'checking' ? '已绑定素材，正在核对；运行时仍会检查可读性' : '已绑定素材，可读性将在运行时核对' })
    }
    if (item.action === 'blocked' && item.reasonCode !== 'missing-asset') {
      const model = item.reasonCode === 'missing-group'
      add(node.id, node.kind, { category: 'configuration', action: model ? 'configure-model' : 'inspect-node', blocking: true, message: item.reasonCode === 'unavailable-model' ? `${item.reason || '当前模型不可用'}；请在此节点的模型选择中更换` : item.reason || '请检查当前节点配置' })
    }
    if ((['prompt', 'text', 'drama-script'].includes(node.kind) || item.paid) && !node.data.commerceTask && !node.data.interiorTask && !node.data.exteriorTask && !node.data.storyboardTask && !node.data.prompt.trim() && !hasTextSource(node.id, input.graph, skipped)) {
      add(node.id, node.kind, { category: 'prompt', action: 'edit-prompt', blocking: true, message: '填写文字内容或连接可提供文字的上游节点' })
    }
  }
  result.items.sort((left, right) => categoryOrder[left.category] - categoryOrder[right.category])
  result.blockingCount = result.items.filter((item) => item.blocking).length
  result.noticeCount = result.items.length - result.blockingCount
  const blockedNodes = new Set(result.items.filter((item) => item.blocking).map((item) => item.nodeId))
  result.readyNodeCount = preflight.items.filter((item) => item.action !== 'skip' && item.action !== 'blocked' && !blockedNodes.has(item.nodeId)).length
  result.canReviewRun = preflight.canStart && preflight.items.some((item) => item.action !== 'skip') && result.blockingCount === 0 && result.missingNodeIds.length === 0
  return result
}
