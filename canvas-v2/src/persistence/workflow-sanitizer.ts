import {
  type AssetRef,
  type NodeKind,
  type PortKind,
  type WorkflowEdge,
  type WorkflowNode,
} from '../model'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import {
  finiteCoordinate,
  isRecord,
  localAssetUrl,
  maximumGroupNameLength,
  maximumModelLength,
  maximumNodeIdLength,
  maximumNodeKindLength,
  maximumOptionLength,
  maximumPromptLength,
  maximumTaskIdLength,
  maximumWorkflowEdges,
  maximumWorkflowNameLength,
  maximumWorkflowNodes,
  optionalSafeString,
  safeString,
  stableAssetId,
  type WorkflowParseResult,
} from './workflow-schema'

const knownNodeKinds = new Set<NodeKind>(builtinNodeRegistry.list()
  .filter((definition) => definition.type !== 'unknown')
  .map((definition) => definition.type as NodeKind))
const forbiddenSettingsKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i
const unsafeSettingsString = /(?:data:|https?:\/\/|file:|[A-Za-z]:\\|(?:^|\/)Users\/|(?:^|\/)home\/)/i

function safeSettings(value: unknown, depth = 0): Record<string, unknown> | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || depth > 6 || Object.keys(value).length > 100) return null
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 128 || forbiddenSettingsKey.test(key)) continue
    if (typeof entry === 'string') {
      if (entry.length > 10_000 || entry.includes('\0') || unsafeSettingsString.test(entry)) continue
      result[key] = entry
    } else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return null
      result[key] = entry
    } else if (typeof entry === 'boolean' || entry === null) {
      result[key] = entry
    } else if (isRecord(entry)) {
      const child = safeSettings(entry, depth + 1)
      if (child) result[key] = child
    } else {
      continue
    }
  }
  return result
}

function knownNodeKind(value: string): NodeKind | null {
  return knownNodeKinds.has(value as NodeKind) ? value as NodeKind : null
}

function readAsset(value: unknown): AssetRef | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio')) return null
  let assetId = stableAssetId(value.assetId)
  if (!assetId && typeof value.localUrl === 'string') {
    const match = value.localUrl.match(/^xingmang-asset:\/\/(image|video|audio)\/([A-Za-z0-9_-]{43})$/)
    if (match && match[1] === value.kind) assetId = match[2]
  }
  const taskId = optionalSafeString(value.taskId, maximumTaskIdLength)
  if (taskId === null) return null
  if (!assetId && !taskId) return undefined
  const width = Number.isInteger(value.width) && (value.width as number) > 0 ? value.width as number : undefined
  const height = Number.isInteger(value.height) && (value.height as number) > 0 ? value.height as number : undefined
  const mimeType = assetId && typeof value.mimeType === 'string' && value.mimeType.length <= 128
    ? value.mimeType
    : undefined
  return {
    kind: value.kind,
    ...(assetId ? { assetId, localUrl: localAssetUrl(value.kind, assetId) } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(taskId ? { taskId } : {}),
  }
}

function readNode(value: unknown): WorkflowNode | null {
  if (!isRecord(value)) return null
  const id = safeString(value.id, maximumNodeIdLength)
  const wireKind = safeString(value.kind, maximumNodeKindLength)
  if (!id || !wireKind || !isRecord(value.position) || !isRecord(value.data)) return null
  if (!finiteCoordinate(value.position.x) || !finiteCoordinate(value.position.y)) return null
  if (!Number.isInteger(value.definitionVersion) || (value.definitionVersion as number) < 1 || (value.definitionVersion as number) > 10_000) {
    return null
  }
  const prompt = optionalSafeString(value.data.prompt, maximumPromptLength)
  const model = optionalSafeString(value.data.model, maximumModelLength)
  const group = optionalSafeString(value.data.group, maximumGroupNameLength)
  const quality = optionalSafeString(value.data.quality, maximumOptionLength)
  const size = optionalSafeString(value.data.size, maximumOptionLength)
  const seconds = value.data.seconds === undefined
    ? undefined
    : typeof value.data.seconds === 'string' && /^(?:[1-9]|1[0-5])$/.test(value.data.seconds)
      ? value.data.seconds
      : null
  const result = readAsset(value.data.result)
  const settings = safeSettings(value.data.settings)
  const candidateAssetIds = value.data.candidateAssetIds === undefined
    ? undefined
    : Array.isArray(value.data.candidateAssetIds)
      && value.data.candidateAssetIds.length <= 16
      && value.data.candidateAssetIds.every((entry) => stableAssetId(entry))
        ? value.data.candidateAssetIds as string[]
        : null
  const parentId = value.parentId === undefined ? undefined : safeString(value.parentId, maximumNodeIdLength)
  const width = value.width === undefined ? undefined : finiteCoordinate(value.width) && value.width >= 80 ? value.width : null
  const height = value.height === undefined ? undefined : finiteCoordinate(value.height) && value.height >= 40 ? value.height : null
  if (prompt === null || model === null || group === null || quality === null || size === null || seconds === null || result === null
    || settings === null || candidateAssetIds === null || parentId === null || width === null || height === null) return null
  const kind = knownNodeKind(wireKind)
  if (!kind) {
    return {
      id,
      kind: 'unknown',
      definitionVersion: value.definitionVersion as number,
      disabled: true,
      unknownKind: wireKind,
      position: { x: value.position.x, y: value.position.y },
      ...(parentId ? { parentId } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
      ...(value.locked === true ? { locked: true } : {}),
      data: {
        prompt: prompt ?? '',
        model: model ?? '',
        ...(group ? { group } : {}),
        status: 'failed',
        errorMessage: `节点类型「${wireKind}」未安装，已禁用`,
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(seconds ? { seconds } : {}),
        ...(result ? { result } : {}),
        ...(settings ? { settings } : {}),
        ...(candidateAssetIds ? { candidateAssetIds } : {}),
      },
    }
  }
  return {
    id,
    kind,
    definitionVersion: value.definitionVersion as number,
    ...(value.disabled === true ? { disabled: true } : {}),
    position: { x: value.position.x, y: value.position.y },
    ...(parentId ? { parentId } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(value.locked === true ? { locked: true } : {}),
    data: {
      prompt: prompt ?? '',
      model: model ?? '',
      ...(group ? { group } : {}),
      status: result?.assetId ? 'succeeded' : 'idle',
      ...(quality ? { quality } : {}),
      ...(size ? { size } : {}),
      ...(seconds ? { seconds } : {}),
      ...(result ? { result } : {}),
      ...(settings ? { settings } : {}),
      ...(candidateAssetIds ? { candidateAssetIds } : {}),
    },
  }
}

function wouldCreateCycle(adjacency: Map<string, Set<string>>, source: string, target: string): boolean {
  const queue = [target]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const current = queue.pop() as string
    if (current === source) return true
    if (seen.has(current)) continue
    seen.add(current)
    for (const next of adjacency.get(current) ?? []) queue.push(next)
  }
  return false
}

function readEdgeStrings(value: unknown): WorkflowEdge | null {
  if (!isRecord(value)) return null
  const id = safeString(value.id, maximumNodeIdLength)
  const source = safeString(value.source, maximumNodeIdLength)
  const sourceHandle = safeString(value.sourceHandle, maximumNodeIdLength)
  const target = safeString(value.target, maximumNodeIdLength)
  const targetHandle = safeString(value.targetHandle, maximumNodeIdLength)
  return id && source && sourceHandle && target && targetHandle
    ? { id, source, sourceHandle, target, targetHandle }
    : null
}

export function sanitizeWorkflowV2(raw: unknown): WorkflowParseResult | null {
  if (!isRecord(raw) || raw.schemaVersion !== 2) return null
  const name = safeString(raw.name, maximumWorkflowNameLength)
  if (!name || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
  if (raw.nodes.length > maximumWorkflowNodes || raw.edges.length > maximumWorkflowEdges) return null

  const warnings: string[] = []
  const nodes: WorkflowNode[] = []
  const nodeIds = new Set<string>()
  for (const rawNode of raw.nodes) {
    const node = readNode(rawNode)
    if (!node || nodeIds.has(node.id)) return null
    nodeIds.add(node.id)
    nodes.push(node)
    if (node.disabled && node.unknownKind) warnings.push(`已禁用未知节点类型：${node.unknownKind}`)
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  for (const node of nodes) {
    if (!node.parentId) continue
    const parent = nodesById.get(node.parentId)
    if (!parent || parent.kind !== 'group' || parent.id === node.id) return null
    const seen = new Set([node.id])
    let current: WorkflowNode | undefined = parent
    let depth = 0
    while (current?.parentId) {
      if (seen.has(current.id) || ++depth > 8) return null
      seen.add(current.id)
      current = nodesById.get(current.parentId)
    }
  }
  const edgeIds = new Set<string>()
  const occupiedSingleInputs = new Set<string>()
  const adjacency = new Map<string, Set<string>>()
  const edges: WorkflowEdge[] = []
  for (const rawEdge of raw.edges) {
    const edge = readEdgeStrings(rawEdge)
    if (!edge || edgeIds.has(edge.id)) return null
    edgeIds.add(edge.id)
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) {
      warnings.push(`已移除指向不存在节点的连线：${edge.id}`)
      continue
    }
    if (source.unknownKind || target.unknownKind || source.id === target.id) {
      warnings.push(`已移除不可执行的连线：${edge.id}`)
      continue
    }
    const normalizedEdge = edge.targetHandle === 'in:image'
      && (target.kind === 'image-edit' || target.kind === 'video-generate' || target.kind === 'video')
      ? { ...edge, targetHandle: 'in:images' }
      : edge
    const sourcePort = builtinNodeRegistry.port(source.kind, normalizedEdge.sourceHandle, 'output')
    const targetPort = builtinNodeRegistry.port(target.kind, normalizedEdge.targetHandle, 'input')
    if (
      !sourcePort
      || !targetPort
      || sourcePort.kind !== targetPort.kind
    ) {
      warnings.push(`已移除端口类型不匹配的连线：${edge.id}`)
      continue
    }
    // Only ports declared as scalar are capacity-limited; media fan-in ports retain every edge.
    const inputKey = `${target.id}:${normalizedEdge.targetHandle}`
    if (targetPort.cardinality === 'one' && occupiedSingleInputs.has(inputKey)) {
      warnings.push(`已移除超出单值端口容量的连线：${edge.id}`)
      continue
    }
    if (wouldCreateCycle(adjacency, normalizedEdge.source, normalizedEdge.target)) {
      warnings.push(`已移除会形成循环的连线：${edge.id}`)
      continue
    }
    if (targetPort.cardinality === 'one') occupiedSingleInputs.add(inputKey)
    const targets = adjacency.get(normalizedEdge.source) ?? new Set<string>()
    targets.add(normalizedEdge.target)
    adjacency.set(normalizedEdge.source, targets)
    edges.push(normalizedEdge)
  }

  let viewport: WorkflowParseResult['workflow']['viewport']
  if (raw.viewport !== undefined) {
    if (
      isRecord(raw.viewport)
      && finiteCoordinate(raw.viewport.x)
      && finiteCoordinate(raw.viewport.y)
      && typeof raw.viewport.zoom === 'number'
      && Number.isFinite(raw.viewport.zoom)
      && raw.viewport.zoom >= 0.01
      && raw.viewport.zoom <= 8
    ) viewport = { x: raw.viewport.x, y: raw.viewport.y, zoom: raw.viewport.zoom }
    else warnings.push('已忽略无效的画布视口')
  }

  let mediaGroups: WorkflowParseResult['workflow']['mediaGroups']
  if (raw.mediaGroups !== undefined) {
    if (isRecord(raw.mediaGroups)) {
      const image = optionalSafeString(raw.mediaGroups.image, maximumGroupNameLength)
      const video = optionalSafeString(raw.mediaGroups.video, maximumGroupNameLength)
      if (image !== null && video !== null && (image || video)) {
        mediaGroups = {
          ...(image ? { image } : {}),
          ...(video ? { video } : {}),
        }
      } else {
        warnings.push('已忽略无效的生成分组配置')
      }
    } else {
      warnings.push('已忽略无效的生成分组配置')
    }
  }

  return {
    workflow: {
      schemaVersion: 2,
      name,
      ...(viewport ? { viewport } : {}),
      ...(mediaGroups ? { mediaGroups } : {}),
      nodes,
      edges,
    },
    warnings,
  }
}
