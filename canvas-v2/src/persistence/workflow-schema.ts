import { assertLayerGroupsPlacement } from '../lib/layer-groups-contract'
import { assertColorGradeCalibrationPlacement } from '../lib/color-calibration-contract'
import { assertColorGradePresencePlacement } from '../lib/color-presence-contract'
import { assertNodeMediaSourceGroup } from '../lib/node-model-source-contract'
import { assertRouterStrategyWorkflowConfiguration } from '../lib/router-strategy-contract'
import { graphHasColorGradeDetail } from '../lib/color-detail-contract'
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
import { parseNodeImageEditMask } from '../image-tools/image-mask-workflow'
import { parseImageCollageInputOrder, remapCollageInputOrderSettings } from '../image-tools/collage-input-order'
import { parseNodeTileInput } from '../image-tools/tile-input'
import { parseImageTransformRecipe, imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { parseImageCropEditorPreferences } from '../image-tools/crop-editor-preferences'
import { parseImageCompareSettings } from '../image-tools/viewer-settings'
import { parsePanoramaView } from '../image-tools/panorama-view-state'
import type { AssetRef, WorkflowEdge, WorkflowFile, WorkflowNode } from '../model'
import { parsePromptReferences, type PromptReference } from '../library/prompt-references'

export const workflowSchemaVersion = 2 as const
export const maximumWorkflowBytes = 20 * 1024 * 1024
export const maximumWorkflowNodes = 5_000
export const maximumWorkflowEdges = 20_000
export const maximumWorkflowNameLength = 256
export const maximumNodeIdLength = 256
export const maximumNodeKindLength = 128
export const maximumPromptLength = 100_000
export const maximumOutputTextLength = 32_000
export const maximumModelLength = 512
export const maximumGroupNameLength = 128
export const maximumOptionLength = 128
export const maximumTaskIdLength = 512
export const maximumCoordinateMagnitude = 10_000_000
export const maximumGenerationDurationMs = 86_400_000

export interface PersistedAssetRefV2 {
  kind: 'image' | 'video' | 'audio'
  assetId?: string
  localUrl?: string
  mimeType?: string
  width?: number
  height?: number
  durationSeconds?: number
  taskId?: string
}

export interface PersistedWorkflowNodeV2 {
  id: string
  kind: string
  definitionVersion: number
  disabled?: boolean
  parentId?: string
  width?: number
  height?: number
  locked?: boolean
  position: { x: number; y: number }
  data: {
    prompt: string
    promptReferences?: PromptReference[]
    outputText?: string
    textWebSearch?: boolean
    /** Existing output needs a new run after its inputs changed. */
    dirty?: boolean
    model: string
    group?: string
    quality?: string
    size?: string
    imageResolution?: '1K' | '2K' | '4K'
    imageCandidateCount?: ImageCandidateCount
    videoCandidateCount?: VideoCandidateCount
    seconds?: string
    result?: PersistedAssetRefV2
    settings?: Record<string, unknown>
    candidateAssetIds?: string[]
    /** 旧文件可能还带着；新保存不再写入，加载时也不恢复到节点上。 */
    latestAttemptDurationMs?: number
  }
}

export interface PersistedWorkflowV2 {
  schemaVersion: typeof workflowSchemaVersion
  name: string
  viewport?: { x: number; y: number; zoom: number }
  mediaGroups?: {
    image?: string
    video?: string
    text?: string
    imageModel?: string
    videoModel?: string
    textModel?: string
  }
  nodes: PersistedWorkflowNodeV2[]
  edges: WorkflowEdge[]
}

export interface WorkflowParseResult {
  workflow: WorkflowFile
  warnings: string[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function safeString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximumLength || value.includes('\0')) return null
  return value
}

export function optionalSafeString(value: unknown, maximumLength: number): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximumLength || value.includes('\0')) return null
  return value || undefined
}

export function safeNoteText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= maximumPromptLength && !value.includes('\0') ? value : undefined
}

export function hasInvalidNoteText(settings: unknown): boolean {
  return isRecord(settings) && Object.prototype.hasOwnProperty.call(settings, 'text') && safeNoteText(settings.text) === undefined
}

export function finiteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximumCoordinateMagnitude
}

export function stableAssetId(value: unknown): string | null {
  // AiAssetStore owns 32 random bytes encoded as base64url: exactly 43 chars.
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}

export function localAssetUrl(kind: AssetRef['kind'], assetId: string): string {
  return `xingmang-asset://${kind}/${assetId}`
}

export function persistedDurationMs(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maximumGenerationDurationMs) return undefined
  return Math.round(value)
}


/** Do not project misplaced editable detail settings out of a saved graph. */
export function assertWorkflowColorGradeDetailPlacement(kind: unknown, data: unknown): void {
  assertLayerGroupsPlacement(kind, data, 'workflow'); assertColorGradeCalibrationPlacement(kind, data, 'workflow'); assertColorGradePresencePlacement(kind, data, 'workflow')
  if (!isRecord(data)) return
  if (graphHasColorGradeDetail({ nodes: [{ data: { imageTransform: data.imageTransform } }] })
    || kind !== 'image-layer' && graphHasColorGradeDetail({ nodes: [{ data: { settings: data.settings } }] })) throw new Error('细节与降噪配置必须完整保存在图层合成节点的设置中，当前没有丢弃字段后保存')
}

export function toPersistedWorkflowV2(workflow: WorkflowFile): PersistedWorkflowV2 {
  assertRouterStrategyWorkflowConfiguration(workflow)
  const nodes: PersistedWorkflowNodeV2[] = workflow.nodes.map((node: WorkflowNode) => {
    assertNodeMediaSourceGroup(node.kind, node.data)
    assertWorkflowColorGradeDetailPlacement(node.kind, node.data)
    if (Object.hasOwn(node.data, 'storyboardTask') || Object.hasOwn(node.data, 'exteriorTask') || Object.hasOwn(node.data, 'interiorTask') || Object.hasOwn(node.data, 'commerceTask') || Object.hasOwn(node.data, 'imageReferenceOrder')) throw new Error('创作任务和参考图角色必须保存在节点配置中，当前不会丢弃字段后保存')
    const knownNote = node.kind === 'note' && !node.unknownKind
    // A failed text validation must not turn an autosave into an empty note.
    if (knownNote && hasInvalidNoteText(node.data.settings)) throw new Error('便签正文格式不正确、含空字符或超过长度上限（10 万字符），保存未完成')
    const result = persistedAsset(node.data.result)
    let settings = persistedSettings(node.data.settings, node.unknownKind ? undefined : node.kind)
    if (node.kind === 'image-collage') settings = remapCollageInputOrderSettings(settings, new Map(workflow.edges.filter((edge) => edge.target === node.id).map((edge) => [edge.id, edge.id])))
    assertCommerceTaskConfiguration(settings?.commerceTask as import('../commerce/commerce-task').CommerceTask | undefined, settings?.imageReferenceOrder as import('../commerce/image-reference-order').ImageReferenceOrder | undefined, node.data, settings?.interiorTask as import('../interior/interior-task').InteriorTask | undefined, settings?.exteriorTask as import('../exterior/exterior-task').ExteriorTask | undefined, settings?.storyboardTask as import('../storyboard/storyboard-task').StoryboardTask | undefined)
    const group = optionalSafeString(node.data.group, maximumGroupNameLength)
    const textWebSearch = parseTextWebSearch(node.data.textWebSearch, node.unknownKind ?? node.kind)
    const imageCandidateCount = parseImageCandidateCount(node.data.imageCandidateCount, node.unknownKind ?? node.kind)
    const videoCandidateCount = parseVideoCandidateCount(node.data.videoCandidateCount, node.unknownKind ?? node.kind)
    const promptReferences = parsePromptReferences(node.data.prompt, node.data.promptReferences)
    const candidateAssetIds = node.data.candidateAssetIds?.filter((assetId) => stableAssetId(assetId)).slice(0, 16)
    return {
      id: node.id,
      kind: node.unknownKind ?? node.kind,
      definitionVersion: node.definitionVersion ?? 1,
      ...(node.disabled ? { disabled: true } : {}),
      ...(node.parentId ? { parentId: node.parentId } : {}),
      ...(Number.isFinite(node.width) && (node.width as number) > 0 ? { width: node.width } : {}),
      ...(Number.isFinite(node.height) && (node.height as number) > 0 ? { height: node.height } : {}),
      ...(node.locked ? { locked: true } : {}),
      position: { x: node.position.x, y: node.position.y },
      data: {
        prompt: node.data.prompt,
        ...(promptReferences.length ? { promptReferences } : {}),
        ...((node.kind === 'text-generate' || node.kind === 'output') && typeof node.data.outputText === 'string' ? { outputText: node.data.outputText.slice(0, maximumOutputTextLength).replace(/\0/g, '') } : {}),
        ...(textWebSearch !== undefined ? { textWebSearch } : {}),
        ...(node.data.dirty === true ? { dirty: true } : {}),
        model: node.data.model,
        ...(group ? { group } : {}),
        ...(node.data.quality ? { quality: node.data.quality } : {}),
        ...(node.data.size ? { size: node.data.size } : {}),
        ...(node.data.imageResolution ? { imageResolution: node.data.imageResolution } : {}),
        ...(imageCandidateCount !== undefined ? { imageCandidateCount } : {}),
        ...(videoCandidateCount !== undefined ? { videoCandidateCount } : {}),
        ...(node.data.seconds ? { seconds: node.data.seconds } : {}),
        ...(result ? { result } : {}),
        ...(settings ? { settings } : {}),
        ...(candidateAssetIds?.length ? { candidateAssetIds } : {}),
      },
    }
  })
  const mediaGroups = persistedMediaGroups(workflow.mediaGroups)
  return {
    schemaVersion: workflowSchemaVersion,
    name: workflow.name,
    ...(workflow.viewport ? { viewport: { ...workflow.viewport } } : {}),
    ...(mediaGroups ? { mediaGroups } : {}),
    nodes,
    edges: workflow.edges.map((edge) => ({ ...edge })),
  }
}

function persistedMediaGroups(mediaGroups: WorkflowFile['mediaGroups']): WorkflowFile['mediaGroups'] | undefined {
  if (!mediaGroups) return undefined
  const image = optionalSafeString(mediaGroups.image, maximumGroupNameLength)
  const video = optionalSafeString(mediaGroups.video, maximumGroupNameLength)
  const text = optionalSafeString(mediaGroups.text, maximumGroupNameLength)
  const imageModel = optionalSafeString(mediaGroups.imageModel, maximumModelLength)
  const videoModel = optionalSafeString(mediaGroups.videoModel, maximumModelLength)
  const textModel = optionalSafeString(mediaGroups.textModel, maximumModelLength)
  if (image === null || video === null || text === null || imageModel === null || videoModel === null || textModel === null) return undefined
  if (!image && !video && !text) return undefined
  return {
    ...(image ? { image } : {}),
    ...(video ? { video } : {}),
    ...(text ? { text } : {}),
    ...(imageModel ? { imageModel } : {}),
    ...(videoModel ? { videoModel } : {}),
    ...(textModel ? { textModel } : {}),
  }
}

const forbiddenSettingKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i
const unsafeSettingString = /^(?:[a-zA-Z]:[\\/]|\\\\|\/|[a-z][a-z0-9+.-]*:|data:)/i

function persistedSettingValue(value: unknown, depth: number, allowNoteText = false): unknown {
  if (depth > 8) return undefined
  if (typeof value === 'string') return value.length <= 10_000 && !unsafeSettingString.test(value) ? value : undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) return value.slice(0, 256).map((entry) => persistedSettingValue(entry, depth + 1)).filter((entry) => entry !== undefined)
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value).slice(0, 256).flatMap(([key, child]) => {
    if (!key || key.length > 128 || forbiddenSettingKey.test(key)) return []
    // Only root-level note prose is display-only; nested settings remain capability-filtered.
    if (allowNoteText && depth === 0 && key === 'text') {
      const text = safeNoteText(child)
      return text === undefined ? [] : [[key, text] as const]
    }
    const safe = persistedSettingValue(child, depth + 1)
    return safe === undefined ? [] : [[key, safe] as const]
  })
  return Object.fromEntries(entries)
}

export function persistedSettings(value: unknown, nodeKind?: WorkflowNode['kind']): Record<string, unknown> | undefined {
  const safe = persistedSettingValue(value, 0, nodeKind === 'note')
  if (isRecord(value) && Object.hasOwn(value, 'interiorTask')) { if (!isRecord(safe)) throw new Error('室内创作配置无法保存'); safe.interiorTask = parseNodeInteriorTask(nodeKind ?? '', value.interiorTask) }
  if (isRecord(value) && Object.hasOwn(value, 'exteriorTask')) { if (!isRecord(safe)) throw new Error('室外创作配置无法保存'); safe.exteriorTask = parseNodeExteriorTask(nodeKind ?? '', value.exteriorTask) }
  if (isRecord(value) && Object.hasOwn(value, 'storyboardTask')) { if (!isRecord(safe)) throw new Error('故事板配置无法保存'); safe.storyboardTask = parseNodeStoryboardTask(nodeKind ?? '', value.storyboardTask) }
  if (isRecord(value) && value.commerceTask !== undefined && isRecord(safe)) safe.commerceTask = parseNodeCommerceTask(nodeKind ?? '', value.commerceTask)
  if (isRecord(value) && value.imageReferenceOrder !== undefined && isRecord(safe)) safe.imageReferenceOrder = parseNodeImageReferenceOrder(nodeKind ?? '', value.imageReferenceOrder)
  if (isRecord(value) && value.generateAudio !== undefined && isRecord(safe)) safe.generateAudio = parseVideoGenerateAudio(value.generateAudio, nodeKind ?? '')
  if (isRecord(value) && value.videoReferenceOrder !== undefined && isRecord(safe)) safe.videoReferenceOrder = parseNodeVideoReferenceOrder(nodeKind ?? '', value.videoReferenceOrder)
  if (isRecord(value) && value.imageEditMask !== undefined && isRecord(safe)) safe.imageEditMask = parseNodeImageEditMask(nodeKind ?? '', value.imageEditMask)
  if (isRecord(value) && value.imageTransform !== undefined && isRecord(safe)) {
    safe.imageTransform = parseImageTransformRecipe(value.imageTransform)
    if (nodeKind && isImageTransformNodeKind(nodeKind)) imageTransformRecipeForNode(nodeKind, safe)
  }
  if (nodeKind === 'image-collage' && isRecord(value) && value.imageCollageInputOrder !== undefined && isRecord(safe)) safe.imageCollageInputOrder = parseImageCollageInputOrder(value.imageCollageInputOrder)
  if (isRecord(value) && value.tileInput !== undefined && isRecord(safe)) safe.tileInput = parseNodeTileInput(nodeKind ?? '', value.tileInput)
  if (nodeKind === 'image-crop' && isRecord(value) && value.imageCropEditor !== undefined && isRecord(safe)) safe.imageCropEditor = parseImageCropEditorPreferences(value.imageCropEditor)
  if (nodeKind === 'image-compare' && isRecord(value) && value.imageCompare !== undefined && isRecord(safe)) safe.imageCompare = parseImageCompareSettings(value.imageCompare)
  if (nodeKind === 'image-panorama' && isRecord(value) && value.imagePanorama !== undefined && isRecord(safe)) safe.imagePanorama = parsePanoramaView(value.imagePanorama)
  return isRecord(safe) && Object.keys(safe).length > 0 ? safe : undefined
}

function persistedAsset(asset: AssetRef | undefined): PersistedAssetRefV2 | undefined {
  if (!asset) return undefined
  const assetId = stableAssetId(asset.assetId)
  const taskId = optionalSafeString(asset.taskId, maximumTaskIdLength)
  if (taskId === null) return undefined
  if (!assetId && !taskId) return undefined
  return {
    kind: asset.kind,
    ...(assetId ? { assetId, localUrl: localAssetUrl(asset.kind, assetId) } : {}),
    ...(assetId && typeof asset.mimeType === 'string' && asset.mimeType.length <= 128 ? { mimeType: asset.mimeType } : {}),
    ...(assetId && Number.isInteger(asset.width) && (asset.width as number) > 0 ? { width: asset.width } : {}),
    ...(assetId && Number.isInteger(asset.height) && (asset.height as number) > 0 ? { height: asset.height } : {}),
    ...(assetId && typeof asset.durationSeconds === 'number' && Number.isFinite(asset.durationSeconds) && asset.durationSeconds > 0 && asset.durationSeconds <= 86_400
      ? { durationSeconds: asset.durationSeconds }
      : {}),
    ...(taskId ? { taskId } : {}),
  }
}
