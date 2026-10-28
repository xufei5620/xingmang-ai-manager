import { resolveStoryboardImageRequest } from '../storyboard/storyboard-task'
import { resolveExteriorImageRequest } from '../exterior/exterior-task'
import { resolveInteriorImageRequest } from '../interior/interior-task'
import { resolveCommerceImageRequest } from '../commerce/commerce-task'
import { assertImageReferenceRunConfiguration, commerceSourceAssetId } from '../commerce/image-task-configuration'
import { assertCanvasVideoInputCardinality, inspectCanvasVideoInputs } from '../video-tools/video-inputs'
import { validateTextWebSearchConfiguration } from './text-web-search'
import { validateTextImageInputConfiguration } from './text-image-input'
import { imageMaskConfigurationError } from '../image-tools/image-mask-workflow'
import { parseImageCandidateCount } from './image-candidate-count'
import { parseVideoCandidateCount } from './video-candidate-count'
import { isImageTransformNodeKind, parseImageTransformRecipe, imageTransformKindForNode } from '../image-tools/recipe'
import type { CanvasRunGraph, CanvasRunScope } from '../host'
import { assertHostImageRequest } from './host-image-request'
import { videoRequestParameters, type VideoProtocol } from '../lib/video-request-protocol'
import { canvasGenerationImageInputCardinality, canvasGenerationImageInputError, canvasImageInputCardinality, canvasImageTransformInputErrors } from './image-input-cardinality'
import { assertCanvasTileInput, canvasRunDependencyEdges } from './tile-run-input'
import { knownNonImageModel } from '../models'
import { canvasNodeMediaKind, resolveCanvasNodeModelAvailability, type CanvasNodeModelAvailability, type CanvasNodeSourceCatalog } from '../library/node-model-availability'
import type { CanvasCapabilityProfile } from '../host-capabilities'
import { canvasRunNodeUnsupportedReason, canvasRunUpstreamUnsupportedReason } from './host-run-compatibility'
export { canvasCollageCapacityError } from './image-input-cardinality'

const imageRunNodeKinds = new Set(['image', 'image-generate', 'image-edit'])
const videoRunNodeKinds = new Set(['video', 'video-generate'])
const textRunNodeKinds = new Set(['text-generate', 'drama-parse'])
const paidRunNodeKinds = new Set([...imageRunNodeKinds, ...videoRunNodeKinds, ...textRunNodeKinds])
const assetInputKinds = new Set(['image-input', 'video-input', 'audio-input'])

export type CanvasPreflightSeverity = 'info' | 'warning' | 'blocking'
export type CanvasPreflightAction = 'execute' | 'cached' | 'skip' | 'blocked'
export type CanvasPreflightReasonCode = 'disabled' | 'upstream-skip' | 'missing-group' | 'unavailable-source' | 'unavailable-model' | 'missing-asset' | 'drama-gate' | 'invalid-parameters' | 'unsupported-host'

export interface CanvasRunPreflightInput {
  graph: CanvasRunGraph
  scope: CanvasRunScope
  cachedNodeIds?: readonly string[]
  imageGroup?: string
  videoGroup?: string
  videoProtocol?: VideoProtocol
  textGroup?: string
  imageModels: readonly string[]
  videoModels: readonly string[]
  textModels?: readonly string[]
  sourceCatalog?: CanvasNodeSourceCatalog
  nodeBlockReasons?: Readonly<Record<string, string>>
  imageAssetDimensions?: Readonly<Record<string, { width: number; height: number }>>
  /** The host's profile. Omitted, nothing is blocked for the host's sake (pure callers and tests). */
  capabilities?: CanvasCapabilityProfile
}

export interface CanvasRunPreflightItem {
  nodeId: string
  kind: string
  action: CanvasPreflightAction
  paid: boolean
  webSearch?: true
  /** Maximum independent requests if the server cache misses. */
  requestCount: number
  group?: string
  model?: string
  reason?: string
  reasonCode?: CanvasPreflightReasonCode
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
  textRequestCount: number
  webSearchRequestCount: number
  risk: CanvasPreflightSeverity
  warnings: string[]
  canStart: boolean
}

export function selectCanvasRunNodeIds(graph: CanvasRunGraph, scope: CanvasRunScope): Set<string> {
  const nodeIds = new Set(graph.nodes.map((node) => node.id))
  if (scope.kind === 'all') return nodeIds
  const roots = scope.kind === 'to-node' || scope.kind === 'from-node' ? [scope.nodeId] : scope.nodeIds
  if (roots.length === 0) throw new Error('运行范围不能为空')
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const edge of canvasRunDependencyEdges(graph, new Set())) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target])
  }
  for (const root of new Set(roots)) {
    if (!nodeIds.has(root)) throw new Error(`运行范围包含不存在的节点：${root}`)
  }
  const selected = new Set<string>()
  const queue = [...new Set(roots)]
  if (scope.kind === 'from-node') {
    while (queue.length > 0) {
      const current = queue.pop() as string
      if (selected.has(current)) continue
      selected.add(current)
      for (const target of outgoing.get(current) ?? []) queue.push(target)
    }
    const dependencies = [...selected]
    while (dependencies.length > 0) {
      const current = dependencies.pop() as string
      for (const source of incoming.get(current) ?? []) {
        if (selected.has(source)) continue
        selected.add(source)
        dependencies.push(source)
      }
    }
    return selected
  }
  while (queue.length > 0) {
    const current = queue.pop() as string
    if (selected.has(current)) continue
    selected.add(current)
    for (const source of incoming.get(current) ?? []) queue.push(source)
  }
  return selected
}

export function selectCanvasRunNodeIdsForPreflight(graph: CanvasRunGraph, scope: CanvasRunScope): Set<string> {
  return selectCanvasRunNodeIds(graph, scope)
}

export function sameCanvasRunGraphSnapshot(left: CanvasRunGraph, right: CanvasRunGraph): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function scopeLabel(scope: CanvasRunScope): string {
  if (scope.kind === 'all') return '全部节点'
  if (scope.kind === 'dirty') return `变更链路（${scope.nodeIds.length} 个入口）`
  if (scope.kind === 'selection') return `选中链路（${scope.nodeIds.length} 个入口）`
  if (scope.kind === 'from-node') return '从选中节点向后运行'
  return '运行到选中节点'
}

function nodeGroup(node: CanvasRunGraph['nodes'][number], input: CanvasRunPreflightInput): string | undefined {
  if (imageRunNodeKinds.has(node.kind)) return node.data.group ?? input.imageGroup
  if (videoRunNodeKinds.has(node.kind)) return node.data.group ?? input.videoGroup
  if (textRunNodeKinds.has(node.kind)) return node.data.group ?? input.textGroup
  return node.data.group
}

function nodeModels(node: CanvasRunGraph['nodes'][number], input: CanvasRunPreflightInput): CanvasNodeModelAvailability {
  const defaults = { connected: true, imageModels: input.imageModels, videoModels: input.videoModels, textModels: input.textModels ?? [], videoProtocol: input.videoProtocol, sourceCatalog: input.sourceCatalog }
  const kind = canvasNodeMediaKind(node.kind), group = nodeGroup(node, input)
  const defaultGroup = kind === 'image' ? input.imageGroup : kind === 'video' ? input.videoGroup : input.textGroup
  // Old callers have no per-source catalogs. App always supplies one; its run
  // graph has already resolved inherited groups, so compare their actual IDs.
  return input.sourceCatalog !== undefined && group !== undefined && (Object.hasOwn(input.sourceCatalog, group) || group !== defaultGroup)
    ? resolveCanvasNodeModelAvailability(node.kind, { group }, defaults) : defaults
}

function modelAvailable(node: CanvasRunGraph['nodes'][number], input: CanvasNodeModelAvailability): boolean {
  if (imageRunNodeKinds.has(node.kind)) return !knownNonImageModel(node.data.model.trim()) && input.imageModels.includes(node.data.model)
  if (videoRunNodeKinds.has(node.kind)) return input.videoModels.includes(node.data.model)
  if (textRunNodeKinds.has(node.kind)) return input.textModels.includes(node.data.model)
  return true
}

export function buildCanvasRunPreflight(input: CanvasRunPreflightInput): CanvasRunPreflight {
  const selected = selectCanvasRunNodeIds(input.graph, input.scope)
  const cached = new Set(input.cachedNodeIds ?? [])
  const items: CanvasRunPreflightItem[] = []
  const warnings: string[] = []
  const nodesById = new Map(input.graph.nodes.map((node) => [node.id, node]))
  const incoming = new Map<string, string[]>()
  for (const edge of input.graph.edges) {
    if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) throw new Error(`连线引用了不存在的节点：${edge.id}`)
  }
  for (const edge of canvasRunDependencyEdges(input.graph, new Set())) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source])
  }
  const planned = new Map<string, CanvasRunPreflightItem>()
  const visiting = new Set<string>()
  function hostUnsupportedReason(node: CanvasRunGraph['nodes'][number], profile: CanvasCapabilityProfile): string | undefined {
    return canvasRunNodeUnsupportedReason(node, profile)
      ?? canvasRunUpstreamUnsupportedReason((incoming.get(node.id) ?? []).map((sourceId) => nodesById.get(sourceId)!), profile)
  }

  function planNode(nodeId: string): CanvasRunPreflightItem {
    const existing = planned.get(nodeId)
    if (existing) return existing
    if (visiting.has(nodeId)) throw new Error('工作流中存在循环连接，请先断开成环的连线')
    const node = nodesById.get(nodeId)
    if (!node) throw new Error(`运行范围包含不存在的节点：${nodeId}`)
    visiting.add(nodeId)
    const paid = paidRunNodeKinds.has(node.kind)
    const group = nodeGroup(node, input)
    const availability = nodeModels(node, input)
    // An existing canvas result does not prove the server fingerprint matches
    // the current input chain. Always disclose the paid-request upper bound.
    let action: CanvasPreflightAction = !paid && !isImageTransformNodeKind(node.kind) && cached.has(node.id) ? 'cached' : 'execute'
    let reason: string | undefined = paid ? input.scope.kind === 'to-node' && input.scope.nodeId === node.id
      ? '将重新生成，不复用此节点结果；提交付费生成请求'
      : '将核对服务端缓存；未命中时提交付费生成请求' : undefined
    let reasonCode: CanvasRunPreflightItem['reasonCode']
    if (node.disabled) {
      action = 'skip'
      reason = '节点已禁用'
      reasonCode = 'disabled'
    } else if ((incoming.get(node.id) ?? [])
      .filter((sourceId) => selected.has(sourceId))
      .some((sourceId) => planNode(sourceId).action === 'skip')) {
      action = 'skip'
      reason = '上游节点已跳过'
      reasonCode = 'upstream-skip'
    } else if (input.capabilities && hostUnsupportedReason(node, input.capabilities)) {
      action = 'blocked'
      reason = hostUnsupportedReason(node, input.capabilities)
      reasonCode = 'unsupported-host'
    } else if (paid && !group) {
      action = 'blocked'
      reason = textRunNodeKinds.has(node.kind) ? '缺少文字分组' : node.kind.startsWith('video') ? '缺少视频分组' : '缺少生图分组'
      reasonCode = 'missing-group'
    } else if (paid && availability.sourceError) {
      action = 'blocked'
      reason = availability.sourceError
      reasonCode = 'unavailable-source'
    } else if (paid && !modelAvailable(node, availability)) {
      action = 'blocked'
      reason = imageRunNodeKinds.has(node.kind) && knownNonImageModel(node.data.model.trim())
        ? `模型「${node.data.model}」是已知文字或视频模型，不能用于图像生成；请选择图像模型`
        : `模型「${node.data.model || '未设置'}」不属于当前分组`
      reasonCode = 'unavailable-model'
    } else if (assetInputKinds.has(node.kind) && !node.data.adoptedAssetId) {
      action = 'blocked'
      reason = '缺少已保存的本地素材'
      reasonCode = 'missing-asset'
    } else if (input.nodeBlockReasons?.[node.id]) {
      action = 'blocked'
      reason = input.nodeBlockReasons[node.id]
      reasonCode = 'drama-gate'
    }
    let imageCandidateCount = 1
    let videoCandidateCount = 1
    try { videoCandidateCount = parseVideoCandidateCount(node.data.videoCandidateCount, node.kind) ?? 1 }
    catch (error) {
      action = 'blocked'
      reason = error instanceof Error ? error.message : '视频生成数量不正确'
      reasonCode = 'invalid-parameters'
    }
    try { imageCandidateCount = parseImageCandidateCount(node.data.imageCandidateCount, node.kind) ?? 1 }
    catch (error) {
      action = 'blocked'
      reason = error instanceof Error ? error.message : '图像生成数量不正确'
      reasonCode = 'invalid-parameters'
    }
    if (action !== 'blocked' && action !== 'skip' && paid && !node.data.commerceTask && !node.data.interiorTask && !node.data.exteriorTask && !node.data.storyboardTask
      && !node.data.prompt.trim() && !input.graph.edges.some((edge) => edge.target === node.id && edge.targetHandle === 'in:text')) {
      action = 'blocked'
      reason = '生成节点没有提示词，请填写提示词或连接上游文字节点'
      reasonCode = 'invalid-parameters'
    }
    if (action !== 'blocked' && action !== 'skip' && imageRunNodeKinds.has(node.kind)) {
      try {
        assertImageReferenceRunConfiguration(node, input.graph.edges, nodesById)
        const sourceId = commerceSourceAssetId(node, input.graph.edges, nodesById)
        const parameters = node.data.storyboardTask ? resolveStoryboardImageRequest(node.data.storyboardTask, { ...node.data, prompt: node.data.prompt }) : node.data.exteriorTask ? resolveExteriorImageRequest(node.data.exteriorTask, { ...node.data, prompt: node.data.prompt }) : node.data.interiorTask ? resolveInteriorImageRequest(node.data.interiorTask, { ...node.data, prompt: node.data.prompt }) : node.data.commerceTask ? resolveCommerceImageRequest(node.data.commerceTask, { ...node.data, prompt: node.data.prompt }, sourceId ? input.imageAssetDimensions?.[sourceId] : undefined) : { ...node.data, prompt: node.data.prompt.trim() || '预检提示词' }
        assertHostImageRequest(parameters, input.capabilities)
        const sources = input.graph.edges.filter((edge) => edge.target === node.id && ['in:images', 'in:image'].includes(edge.targetHandle))
        const inputError = canvasGenerationImageInputError(node.kind, node.data.imageReferenceOrder ? { connections: sources.length, minimum: node.data.imageReferenceOrder.slots.length, exact: true, hasBatch: false } : canvasGenerationImageInputCardinality(sources, nodesById, input.graph.edges))
        if (inputError) throw new Error(inputError)
      }
      catch (error) {
        action = 'blocked'
        reason = error instanceof Error ? error.message : '图像生成参数不正确'
        reasonCode = 'invalid-parameters'
      }
    }
    if (action !== 'blocked' && action !== 'skip' && node.data.imageReferenceOrder) {
      try { assertImageReferenceRunConfiguration(node, input.graph.edges, nodesById) }
      catch (error) { action = 'blocked'; reason = error instanceof Error ? error.message : '参考图片角色无法核对'; reasonCode = 'invalid-parameters' }
    }
    if (action !== 'blocked' && action !== 'skip' && node.data.imageEditMask !== undefined) {
      const sources = input.graph.edges.filter((edge) => edge.target === node.id && ['in:images', 'in:image'].includes(edge.targetHandle))
      const error = imageMaskConfigurationError(node.data.imageEditMask, node.kind, node.data.model, sources.map((edge) => ({ assetId: nodesById.get(edge.source)?.data.adoptedAssetId, batch: edge.sourceHandle !== 'out:image' })), true)
      if (error) { action = 'blocked'; reason = error; reasonCode = 'invalid-parameters' }
    }
    if (action !== 'blocked' && action !== 'skip' && videoRunNodeKinds.has(node.kind)) {
      const sources = input.graph.edges.filter((edge) => edge.target === node.id)
      try {
        const count = inspectCanvasVideoInputs(node, sources, nodesById)
        assertCanvasVideoInputCardinality(count)
        if (availability.videoProtocol && node.data.videoProtocol && node.data.videoProtocol !== availability.videoProtocol) throw new Error('节点视频协议与当前来源不一致，请重新预检')
        videoRequestParameters({ ...node.data, videoProtocol: availability.videoProtocol ?? node.data.videoProtocol, ...count, prompt: node.data.prompt.trim() || '预检提示词' })
      }
      catch (error) {
        action = 'blocked'
        reason = error instanceof Error ? error.message : '视频生成参数不正确'
        reasonCode = 'invalid-parameters'
      }
    }
    if (action !== 'blocked' && action !== 'skip' && (textRunNodeKinds.has(node.kind) || node.data.textWebSearch !== undefined)) {
      try { validateTextWebSearchConfiguration(node.kind, node.data.model, node.data.textWebSearch) }
      catch (error) { action = 'blocked'; reason = error instanceof Error ? error.message : '联网搜索参数不正确'; reasonCode = 'invalid-parameters' }
    }
    if (action !== 'blocked' && action !== 'skip' && node.kind === 'text-generate') {
      try {
        const sources = input.graph.edges.filter((edge) => edge.target === node.id && edge.targetHandle === 'in:images')
        validateTextImageInputConfiguration(node.data.model, node.data.imageReferenceOrder?.slots.length ?? canvasImageInputCardinality(sources, nodesById, input.graph.edges).minimum)
      } catch (error) { action = 'blocked'; reason = error instanceof Error ? error.message : '视觉图片输入不正确'; reasonCode = 'invalid-parameters' }
    }
    if (action !== 'blocked' && action !== 'skip' && node.kind === 'frame-extract') {
      const time = node.data.frameTimestampSeconds ?? 0
      if (!Number.isFinite(time) || time < 0 || time > 86_400 || !input.graph.edges.some((edge) => edge.target === node.id && edge.targetHandle === 'in:video')) {
        action = 'blocked'
        reason = '请连接一个视频来源，并填写 0 到 86400 秒之间的抽帧时间点'
        reasonCode = 'invalid-parameters'
      }
    }
    if (action !== 'blocked' && action !== 'skip' && isImageTransformNodeKind(node.kind)) {
      try {
        const recipe = parseImageTransformRecipe(node.data.imageTransform)
        if (recipe.kind !== imageTransformKindForNode(node.kind)) throw new Error('图片处理参数与节点类型不匹配')
        if (node.kind === 'image-tile') assertCanvasTileInput(node, input.graph.edges, nodesById)
        const sources = input.graph.edges.filter((edge) => edge.target === node.id && ['out:image', 'out:images'].includes(edge.sourceHandle))
        const [inputError] = canvasImageTransformInputErrors(recipe, canvasImageInputCardinality(sources, nodesById, input.graph.edges))
        if (inputError) throw new Error(inputError)
      } catch (error) {
        action = 'blocked'
        reason = error instanceof Error ? error.message : '图片处理参数不正确'
        reasonCode = 'invalid-parameters'
      }
    }
    const item: CanvasRunPreflightItem = {
      nodeId: node.id,
      kind: node.kind,
      action,
      paid,
      ...(node.data.textWebSearch === true ? { webSearch: true as const } : {}),
      requestCount: action === 'execute' ? imageRunNodeKinds.has(node.kind) ? imageCandidateCount : videoRunNodeKinds.has(node.kind) ? videoCandidateCount : 1 : 0,
      ...(group ? { group } : {}),
      ...(node.data.model ? { model: node.data.model } : {}),
      ...(reason ? { reason } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    }
    visiting.delete(nodeId)
    planned.set(nodeId, item)
    return item
  }

  for (const node of input.graph.nodes) {
    if (!selected.has(node.id)) continue
    const item = planNode(node.id)
    items.push(item)
    if (item.action === 'blocked') warnings.push(`${node.id}：${item.reason}`)
  }
  const requestCount = items.reduce((total, item) => total + item.requestCount, 0)
  const cacheHitCount = items.filter((item) => item.action === 'cached').length
  const skippedCount = items.filter((item) => item.action === 'skip').length
  const blockedCount = items.filter((item) => item.action === 'blocked').length
  const paidRequestCount = items.filter((item) => item.paid).reduce((total, item) => total + item.requestCount, 0)
  const imageRequestCount = items.filter((item) => imageRunNodeKinds.has(item.kind)).reduce((total, item) => total + item.requestCount, 0)
  const videoRequestCount = items.filter((item) => videoRunNodeKinds.has(item.kind)).reduce((total, item) => total + item.requestCount, 0)
  const textRequestCount = items.filter((item) => item.action === 'execute' && textRunNodeKinds.has(item.kind)).length
  const webSearchRequestCount = items.filter((item) => item.action === 'execute' && item.webSearch).length
  if (webSearchRequestCount > 0) {
    const scope = input.scope
    const repeatsTargetSearch = scope.kind === 'to-node' && items.some((item) => item.nodeId === scope.nodeId && item.action === 'execute' && item.webSearch)
    warnings.push(`其中 ${webSearchRequestCount} 个联网文字请求，每个最多调用 1 次搜索工具；可能另计搜索费用，实际价格由来源决定。${repeatsTargetSearch ? '选中目标将重新搜索，不复用此节点的旧结果；上游节点仍核对缓存，命中时' : '将核对服务端缓存，命中时'}复用原搜索结果与时间，不会重新联网`)
  }
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
    textRequestCount,
    webSearchRequestCount,
    risk: blockedCount > 0 ? 'blocking' : paidRequestCount > 0 ? 'warning' : 'info',
    warnings: [scopeLabel(input.scope), ...warnings],
    canStart: selected.size > 0 && blockedCount === 0,
  }
}

export function canvasMediaConfigurationErrors(
  graph: CanvasRunGraph,
  scope: CanvasRunScope,
  configuration: Omit<CanvasRunPreflightInput, 'graph' | 'scope' | 'cachedNodeIds'>,
): string[] {
  const preflight = buildCanvasRunPreflight({ graph, scope, ...configuration })
  const errors: string[] = []
  const missingImageGroup = preflight.items.some((item) => imageRunNodeKinds.has(item.kind) && item.reasonCode === 'missing-group')
  const missingVideoGroup = preflight.items.some((item) => videoRunNodeKinds.has(item.kind) && item.reasonCode === 'missing-group')
  const missingTextGroup = preflight.items.some((item) => textRunNodeKinds.has(item.kind) && item.reasonCode === 'missing-group')
  if (missingImageGroup) errors.push('请选择生图分组')
  if (missingVideoGroup) errors.push('请选择视频分组')
  if (missingTextGroup) errors.push('请选择文字分组')
  const unavailableTextModels = [...new Set(preflight.items.filter((item) => textRunNodeKinds.has(item.kind) && item.reasonCode === 'unavailable-model').map((item) => item.model).filter((model): model is string => Boolean(model)))]
  if (configuration.textGroup && unavailableTextModels.length > 0) errors.push(`文字分组「${configuration.textGroup}」不提供模型：${unavailableTextModels.join('、')}`)
  const unavailableImageModels = [...new Set(preflight.items
    .filter((item) => imageRunNodeKinds.has(item.kind) && item.reasonCode === 'unavailable-model')
    .map((item) => item.model)
    .filter((model): model is string => Boolean(model)))]
  const unavailableVideoModels = [...new Set(preflight.items
    .filter((item) => videoRunNodeKinds.has(item.kind) && item.reasonCode === 'unavailable-model')
    .map((item) => item.model)
    .filter((model): model is string => Boolean(model)))]
  if (configuration.imageGroup && unavailableImageModels.length > 0) {
    errors.push(`生图分组「${configuration.imageGroup}」不提供模型：${unavailableImageModels.join('、')}`)
  }
  if (configuration.videoGroup && unavailableVideoModels.length > 0) {
    errors.push(`视频分组「${configuration.videoGroup}」不提供模型：${unavailableVideoModels.join('、')}`)
  }
  return errors
}
