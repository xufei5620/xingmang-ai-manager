import { assertNodeMediaSourceGroup } from '../lib/node-model-source-contract'
import { assertRouterStrategyWorkflowConfiguration } from '../lib/router-strategy-contract'
import { finiteCanvasViewportTranslation, maximumCanvasViewportZoom, minimumCanvasViewportZoom } from './canvas-viewport-limits'
import { assertWorkflowColorGradeDetailPlacement } from './workflow-schema'
import { parseNodeStoryboardTask } from '../storyboard/storyboard-task'
import { parseNodeExteriorTask } from '../exterior/exterior-task'
import { parseNodeInteriorTask } from '../interior/interior-task'
import { parseNodeCommerceTask } from '../commerce/commerce-task'
import { parseNodeImageReferenceOrder } from '../commerce/image-reference-order'
import { assertCommerceTaskConfiguration } from '../commerce/image-task-configuration'
import { parseVideoGenerateAudio } from '../runtime/video-audio'
import { parseNodeVideoReferenceOrder } from '../video-tools/video-reference-order'
import { parseTextWebSearch } from '../runtime/text-web-search'
import { parseImageCandidateCount, type ImageCandidateCount } from '../runtime/image-candidate-count'
import { parseVideoCandidateCount, type VideoCandidateCount } from '../runtime/video-candidate-count'
import { parseImageCollageInputOrder, remapCollageInputOrderSettings } from '../image-tools/collage-input-order'
import { parseNodeTileInput } from '../image-tools/tile-input'
import { parseImageTransformRecipe, imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { parseImageCropEditorPreferences } from '../image-tools/crop-editor-preferences'
import { parseImageCompareSettings } from '../image-tools/viewer-settings'
import { parsePanoramaView } from '../image-tools/panorama-view-state'
import { parsePromptReferences } from '../library/prompt-references'
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
  hasInvalidNoteText,
  isRecord,
  localAssetUrl,
  maximumGroupNameLength,
  maximumModelLength,
  maximumNodeIdLength,
  maximumNodeKindLength,
  maximumOptionLength,
  maximumPromptLength,
  maximumOutputTextLength,
  maximumTaskIdLength,
  maximumWorkflowEdges,
  maximumWorkflowNameLength,
  maximumWorkflowNodes,
  optionalSafeString,
  safeNoteText,
  safeString,
  stableAssetId,
  type WorkflowParseResult,
} from './workflow-schema'

const knownNodeKinds = new Set<NodeKind>(builtinNodeRegistry.list()
  .filter((definition) => definition.type !== 'unknown')
  .map((definition) => definition.type as NodeKind))
const forbiddenSettingsKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i
const unsafeSettingsString = /(?:data:|https?:\/\/|file:|[A-Za-z]:\\|(?:^|\/)Users\/|(?:^|\/)home\/)/i

function safeSettings(value: unknown, depth = 0, allowNoteText = false): Record<string, unknown> | undefined | null {
  if (value === undefined) return undefined
  if (!isRecord(value) || depth > 6 || Object.keys(value).length > 100) return null
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 128 || forbiddenSettingsKey.test(key)) continue
    if (depth === 0 && key === 'imageTransform') {
      try { result[key] = parseImageTransformRecipe(entry) } catch { return null }
      continue
    }
    if (allowNoteText && depth === 0 && key === 'text') {
      const text = safeNoteText(entry)
      if (text !== undefined) result[key] = text
      continue
    }
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
  const durationSeconds = typeof value.durationSeconds === 'number'
    && Number.isFinite(value.durationSeconds)
    && value.durationSeconds > 0
    && value.durationSeconds <= 86_400
    ? value.durationSeconds
    : undefined
  const mimeType = assetId && typeof value.mimeType === 'string' && value.mimeType.length <= 128
    ? value.mimeType
    : undefined
  return {
    kind: value.kind,
    ...(assetId ? { assetId, localUrl: localAssetUrl(value.kind, assetId) } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
    ...(taskId ? { taskId } : {}),
  }
}

function readNode(value: unknown): WorkflowNode | null {
  if (!isRecord(value)) return null
  const id = safeString(value.id, maximumNodeIdLength)
  const wireKind = safeString(value.kind, maximumNodeKindLength)
  if (!id || !wireKind || !isRecord(value.position) || !isRecord(value.data)) return null
  try { assertNodeMediaSourceGroup(wireKind, value.data); assertWorkflowColorGradeDetailPlacement(wireKind, value.data) } catch { return null }
  if (wireKind === 'note' && hasInvalidNoteText(value.data.settings)) return null
  if (!finiteCoordinate(value.position.x) || !finiteCoordinate(value.position.y)) return null
  if (!Number.isInteger(value.definitionVersion) || (value.definitionVersion as number) < 1 || (value.definitionVersion as number) > 10_000) {
    return null
  }
  const prompt = optionalSafeString(value.data.prompt, maximumPromptLength)
  const promptReferences = parsePromptReferences(prompt ?? '', value.data.promptReferences)
  if (value.data.dirty !== undefined && typeof value.data.dirty !== 'boolean') return null
  const outputText = (wireKind === 'text-generate' || wireKind === 'output') ? optionalSafeString(value.data.outputText, maximumOutputTextLength) : undefined
  let textWebSearch: boolean | undefined
  try { textWebSearch = parseTextWebSearch(value.data.textWebSearch, wireKind) } catch { return null }
  const model = optionalSafeString(value.data.model, maximumModelLength)
  const group = optionalSafeString(value.data.group, maximumGroupNameLength)
  const quality = optionalSafeString(value.data.quality, maximumOptionLength)
  const size = optionalSafeString(value.data.size, maximumOptionLength)
  let imageCandidateCount: ImageCandidateCount | undefined
  try { imageCandidateCount = parseImageCandidateCount(value.data.imageCandidateCount, wireKind) } catch { return null }
  let videoCandidateCount: VideoCandidateCount | undefined
  try { videoCandidateCount = parseVideoCandidateCount(value.data.videoCandidateCount, wireKind) } catch { return null }
  const imageResolution = optionalSafeString(value.data.imageResolution, 2)
  if (imageResolution && imageResolution !== '1K' && imageResolution !== '2K' && imageResolution !== '4K') return null
  const seconds = value.data.seconds === undefined
    ? undefined
    : typeof value.data.seconds === 'string' && /^(?:[1-9]|1[0-5])$/.test(value.data.seconds)
      ? value.data.seconds
      : null
  const result = readAsset(value.data.result)
  if (Object.hasOwn(value.data, 'storyboardTask') || Object.hasOwn(value.data, 'exteriorTask') || Object.hasOwn(value.data, 'interiorTask') || Object.hasOwn(value.data, 'commerceTask') || Object.hasOwn(value.data, 'imageReferenceOrder')) return null
  const settings = safeSettings(value.data.settings, 0, wireKind === 'note')
  if (isRecord(value.data.settings)) {
    try {
      if (Object.hasOwn(value.data.settings, 'interiorTask')) { if (!settings) return null; settings.interiorTask = parseNodeInteriorTask(wireKind, value.data.settings.interiorTask) }
      if (Object.hasOwn(value.data.settings, 'exteriorTask')) { if (!settings) return null; settings.exteriorTask = parseNodeExteriorTask(wireKind, value.data.settings.exteriorTask) }
      if (Object.hasOwn(value.data.settings, 'storyboardTask')) { if (!settings) return null; settings.storyboardTask = parseNodeStoryboardTask(wireKind, value.data.settings.storyboardTask) }
      if (value.data.settings.commerceTask !== undefined) { if (!settings) return null; settings.commerceTask = parseNodeCommerceTask(wireKind, value.data.settings.commerceTask) }
      if (value.data.settings.imageReferenceOrder !== undefined) { if (!settings) return null; settings.imageReferenceOrder = parseNodeImageReferenceOrder(wireKind, value.data.settings.imageReferenceOrder) }
      assertCommerceTaskConfiguration(settings?.commerceTask as import('../commerce/commerce-task').CommerceTask | undefined, settings?.imageReferenceOrder as import('../commerce/image-reference-order').ImageReferenceOrder | undefined, { size: typeof value.data.size === 'string' ? value.data.size : undefined, imageResolution: typeof value.data.imageResolution === 'string' ? value.data.imageResolution : undefined }, settings?.interiorTask as import('../interior/interior-task').InteriorTask | undefined, settings?.exteriorTask as import('../exterior/exterior-task').ExteriorTask | undefined, settings?.storyboardTask as import('../storyboard/storyboard-task').StoryboardTask | undefined)
    } catch { return null }
  }
  if (isRecord(value.data.settings) && value.data.settings.imageEditMask !== undefined) {
    try {
      if (!settings) return null
      settings.imageEditMask = parseNodeImageEditMask(wireKind, value.data.settings.imageEditMask)
    } catch { return null }
  }
  if (wireKind === 'image-crop' && isRecord(value.data.settings) && value.data.settings.imageCropEditor !== undefined) {
    try {
      const preferences = parseImageCropEditorPreferences(value.data.settings.imageCropEditor)
      if (!settings) return null
      settings.imageCropEditor = preferences
    } catch { return null }
  }
  if (isRecord(value.data.settings)) {
    try {
      if (value.data.settings.generateAudio !== undefined) {
        if (!settings) return null
        settings.generateAudio = parseVideoGenerateAudio(value.data.settings.generateAudio, wireKind)
      }
      if (value.data.settings.videoReferenceOrder !== undefined) {
        if (!settings) return null
        settings.videoReferenceOrder = parseNodeVideoReferenceOrder(wireKind, value.data.settings.videoReferenceOrder)
      }
      if (wireKind === 'image-collage' && value.data.settings.imageCollageInputOrder !== undefined) {
        if (!settings) return null
        settings.imageCollageInputOrder = parseImageCollageInputOrder(value.data.settings.imageCollageInputOrder)
      }
      if (value.data.settings.tileInput !== undefined) {
        if (!settings) return null
        settings.tileInput = parseNodeTileInput(wireKind, value.data.settings.tileInput)
      }
      if (wireKind === 'image-compare' && value.data.settings.imageCompare !== undefined) {
        if (!settings) return null
        settings.imageCompare = parseImageCompareSettings(value.data.settings.imageCompare)
      }
      if (wireKind === 'image-panorama' && value.data.settings.imagePanorama !== undefined) {
        if (!settings) return null
        settings.imagePanorama = parsePanoramaView(value.data.settings.imagePanorama)
      }
    } catch { return null }
  }
  if (settings && isImageTransformNodeKind(wireKind)) {
    try { imageTransformRecipeForNode(wireKind, settings) } catch { return null }
  }
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
  if (prompt === null || outputText === null || model === null || group === null || quality === null || size === null || imageResolution === null || seconds === null || result === null
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
        ...(promptReferences.length ? { promptReferences } : {}),
        ...(value.data.dirty === true ? { dirty: true } : {}),
        model: model ?? '',
        ...(group ? { group } : {}),
        status: 'failed',
        errorMessage: `节点类型「${wireKind}」未安装，已禁用`,
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(imageResolution ? { imageResolution: imageResolution as '1K' | '2K' | '4K' } : {}),
        ...(imageCandidateCount !== undefined ? { imageCandidateCount } : {}),
        ...(videoCandidateCount !== undefined ? { videoCandidateCount } : {}),
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
      ...(promptReferences.length ? { promptReferences } : {}),
      ...(value.data.dirty === true ? { dirty: true } : {}),
      model: model ?? '',
      ...(group ? { group } : {}),
      status: result?.assetId || ((kind === 'text-generate' || kind === 'output') && outputText) ? 'succeeded' : 'idle',
      ...((kind === 'text-generate' || kind === 'output') && outputText ? { outputText } : {}),
      ...(textWebSearch !== undefined ? { textWebSearch } : {}),
      ...(quality ? { quality } : {}),
      ...(size ? { size } : {}),
      ...(imageResolution ? { imageResolution: imageResolution as '1K' | '2K' | '4K' } : {}),
      ...(imageCandidateCount !== undefined ? { imageCandidateCount } : {}),
      ...(videoCandidateCount !== undefined ? { videoCandidateCount } : {}),
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
  try { assertRouterStrategyWorkflowConfiguration(raw) } catch { return null }
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
      && (target.kind === 'image-edit' || target.kind === 'image-generate' || target.kind === 'image'
        || target.kind === 'video-generate' || target.kind === 'video')
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
      && finiteCanvasViewportTranslation(raw.viewport.x)
      && finiteCanvasViewportTranslation(raw.viewport.y)
      && typeof raw.viewport.zoom === 'number'
      && Number.isFinite(raw.viewport.zoom)
      && raw.viewport.zoom >= minimumCanvasViewportZoom
      && raw.viewport.zoom <= maximumCanvasViewportZoom
    ) viewport = { x: raw.viewport.x, y: raw.viewport.y, zoom: raw.viewport.zoom }
    else warnings.push('已忽略无效的画布视口')
  }

  let mediaGroups: WorkflowParseResult['workflow']['mediaGroups']
  if (raw.mediaGroups !== undefined) {
    if (isRecord(raw.mediaGroups)) {
      const image = optionalSafeString(raw.mediaGroups.image, maximumGroupNameLength)
      const video = optionalSafeString(raw.mediaGroups.video, maximumGroupNameLength)
      const text = optionalSafeString(raw.mediaGroups.text, maximumGroupNameLength)
      const imageModel = optionalSafeString(raw.mediaGroups.imageModel, maximumModelLength)
      const videoModel = optionalSafeString(raw.mediaGroups.videoModel, maximumModelLength)
      const textModel = optionalSafeString(raw.mediaGroups.textModel, maximumModelLength)
      if (image !== null && video !== null && text !== null && imageModel !== null && videoModel !== null && textModel !== null && (image || video || text)) {
        mediaGroups = {
          ...(image ? { image } : {}),
          ...(video ? { video } : {}),
          ...(text ? { text } : {}),
          ...(imageModel ? { imageModel } : {}),
          ...(videoModel ? { videoModel } : {}),
          ...(textModel ? { textModel } : {}),
        }
      } else {
        warnings.push('已忽略无效的生成分组配置')
      }
    } else {
      warnings.push('已忽略无效的生成分组配置')
    }
  }

  for (const node of nodes) if (node.kind === 'image-collage') node.data.settings = remapCollageInputOrderSettings(node.data.settings, new Map(edges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])))

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
import { parseNodeImageEditMask } from '../image-tools/image-mask-workflow'
