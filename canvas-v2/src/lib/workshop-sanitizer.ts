import { assertRouterStrategyWorkflowConfiguration } from './router-strategy-contract'
import { parseCanvasRouterStrategy } from '../runtime/router-strategy'
import { sanitizeWorkshopLayerGroups } from './workshop-layer-groups'
import { graphHasLayerGroups } from './layer-groups-contract'
import { graphHasColorGradeCalibration } from './color-calibration-contract'
import { graphHasColorGradePresence } from './color-presence-contract'
import { assertNodeMediaSourceGroup, graphHasNodeMediaSource } from './node-model-source-contract'
import { assertStoryboardTaskConfiguration, parseNodeStoryboardTask } from '../storyboard/storyboard-task'
import { assertExteriorTaskConfiguration, parseNodeExteriorTask } from '../exterior/exterior-task'
import { parseNodeInteriorTask } from '../interior/interior-task'
import { parseNodeCommerceTask } from '../commerce/commerce-task'
import { parseNodeImageReferenceOrder, remapImageReferenceOrderSettings } from '../commerce/image-reference-order'
import { parseVideoGenerateAudio } from '../runtime/video-audio'
import { parseNodeVideoReferenceOrder, remapVideoReferenceOrderSettings } from '../video-tools/video-reference-order'
import { parseImageCollageInputOrder, remapCollageInputOrderSettings } from '../image-tools/collage-input-order'
import { parseNodeTileInput, remapTileInputSettings } from '../image-tools/tile-input'
import { imageTransformRecipeForNode, isImageTransformNodeKind } from '../image-tools/recipe'
import { parseImageCropEditorPreferences } from '../image-tools/crop-editor-preferences'
import { parseImageCompareSettings, portableImageCompareSettings } from '../image-tools/viewer-settings'
import { parsePanoramaView } from '../image-tools/panorama-view-state'
import type { NodeKind, WorkflowFile } from '../model'
import { sanitizeWorkflowV2 } from '../persistence/workflow-sanitizer'
import { assertWorkflowColorGradeDetailPlacement, isRecord } from '../persistence/workflow-schema'
import type { CanvasWorkshopKind } from './workshop-contract'
import { parsePromptReferences } from '../library/prompt-references'

export const maximumWorkshopNodes = 200
export const maximumWorkshopEdges = 800
export const maximumWorkshopBytes = 512 * 1024

export class WorkshopError extends Error {
  constructor(message: string, public status = 400) { super(message) }
}

export function workshopText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!allowEmpty && !value.trim())) throw new WorkshopError(`${label}格式不正确或超过 ${maximum} 个字符`)
  return boundedRedactedText(value.trim(), maximum)
}

/** Reusable prompt whitespace is content; only the established secret redaction may alter it. */
export function workshopPromptText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || (!allowEmpty && !value.trim())) throw new WorkshopError(`${label}格式不正确或超过 ${maximum} 个字符`)
  return boundedRedactedText(value, maximum)
}

function redactWorkshopSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk)[-_][a-z0-9_-]{16,}\b/gi, '[已隐藏密钥]')
    .replace(/\bBearer\s+[^\s,;"'<>]{8,}/gi, '[已隐藏授权信息]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[已隐藏密钥]')
}

function boundedRedactedText(value: string, maximum: number): string {
  // Replacement labels can be longer than a short secret. Keep the reusable
  // recipe inside its validated limit without cutting a UTF-16 surrogate pair.
  return redactWorkshopSecrets(value).slice(0, maximum).replace(/[\uD800-\uDBFF]$/, '')
}

function safeChoice(value: unknown, values: readonly string[]): string | undefined {
  return typeof value === 'string' && values.includes(value) ? value : undefined
}

function configText(value: unknown, maximum = 512): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maximum || /\0/.test(value)) throw new WorkshopError('节点参数格式不正确或超出容量')
  if (/(?:https?:\/\/|data:|blob:|file:|xingmang-asset:|[a-z]:\\)/i.test(value)) return undefined
  return boundedRedactedText(value, maximum)
}

function nodeSettings(kind: string, input: unknown, portable = false): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined
  const settings: Record<string, unknown> = {}
  if (Object.hasOwn(input, 'routerStrategy')) settings.routerStrategy = parseCanvasRouterStrategy(input.routerStrategy)
  if (Object.hasOwn(input, 'interiorTask')) settings.interiorTask = parseNodeInteriorTask(kind, input.interiorTask)
  if (Object.hasOwn(input, 'exteriorTask')) settings.exteriorTask = parseNodeExteriorTask(kind, input.exteriorTask)
  if (Object.hasOwn(input, 'storyboardTask')) settings.storyboardTask = parseNodeStoryboardTask(kind, input.storyboardTask)
  if (input.commerceTask !== undefined) settings.commerceTask = parseNodeCommerceTask(kind, input.commerceTask)
  if (input.imageReferenceOrder !== undefined) settings.imageReferenceOrder = parseNodeImageReferenceOrder(kind, input.imageReferenceOrder)
  assertExteriorTaskConfiguration(settings.exteriorTask as import('../exterior/exterior-task').ExteriorTask | undefined, settings.imageReferenceOrder as import('../commerce/image-reference-order').ImageReferenceOrder | undefined, settings.commerceTask, settings.interiorTask)
  assertStoryboardTaskConfiguration(settings.storyboardTask as import('../storyboard/storyboard-task').StoryboardTask | undefined, settings.imageReferenceOrder as import('../commerce/image-reference-order').ImageReferenceOrder | undefined, settings.commerceTask, settings.interiorTask, settings.exteriorTask)
  if (input.imageEditMask !== undefined) {
    const mask = parseNodeImageEditMask(kind, input.imageEditMask)
    if (mask) settings.imageEditMask = portableImageEditMask(mask)
  }
  const title = configText(input.title, 160)
  if (title !== undefined) settings.title = title
  const textKeys: Record<string, string[]> = {
    note: ['text', 'color'], output: ['label'],
    'drama-bible': ['stylePrompt', 'aspectRatio'],
    'drama-character': ['name', 'appearance', 'assetKind'],
    'drama-scene': ['name', 'appearance', 'assetKind'],
    'drama-prop': ['name', 'appearance', 'assetKind'],
    'drama-shot': ['shotId', 'action', 'framing'],
  }
  for (const key of textKeys[kind] ?? []) {
    const value = input[key]
    if (value === undefined) continue
    const prose = key === 'text' || key === 'stylePrompt' || key === 'appearance' || key === 'action'
    // Generic persisted settings accept 10k strings; only note text has a
    // dedicated larger parser. Refuse oversized prose instead of losing it.
    const parsed = prose ? workshopText(value, '节点文本', kind === 'note' ? 24_000 : 10_000, true) : configText(value)
    if (parsed !== undefined) settings[key] = parsed
  }
  if (isImageTransformNodeKind(kind)) {
    const recipe = imageTransformRecipeForNode(kind, input)
    settings.imageTransform = recipe?.kind === 'layer' ? { ...sanitizeWorkshopLayerGroups(recipe, (name) => boundedRedactedText(name, 80), portable), layers: recipe.layers.map((layer) => ({
      ...layer,
      ...(layer.name !== undefined ? { name: boundedRedactedText(layer.name, 80) } : {}),
      ...(layer.content?.kind === 'text' ? { content: { ...layer.content, text: boundedRedactedText(layer.content.text, 2000) } } : {}),
    })) } : recipe?.kind === 'collage' && recipe.watermark ? { ...recipe, watermark: { ...recipe.watermark, text: boundedRedactedText(recipe.watermark.text, 160) } } : recipe
  }
  if (input.videoReferenceOrder !== undefined) settings.videoReferenceOrder = parseNodeVideoReferenceOrder(kind, input.videoReferenceOrder)
  if (kind === 'image-collage' && input.imageCollageInputOrder !== undefined) settings.imageCollageInputOrder = parseImageCollageInputOrder(input.imageCollageInputOrder)
  if (input.tileInput !== undefined) settings.tileInput = parseNodeTileInput(kind, input.tileInput)
  if (kind === 'image-crop' && input.imageCropEditor !== undefined) {
    try { settings.imageCropEditor = parseImageCropEditorPreferences(input.imageCropEditor) }
    catch { throw new WorkshopError('裁剪编辑偏好格式不正确，请先检查比例、锁定和吸附设置') }
  }
  if (kind === 'image-compare' && input.imageCompare !== undefined) {
    try { settings.imageCompare = parseImageCompareSettings(input.imageCompare) }
    catch { throw new WorkshopError('图片对比设置无效，请检查模式、滑杆与输入位置') }
  }
  if (kind === 'image-panorama' && input.imagePanorama !== undefined) {
    try { settings.imagePanorama = parsePanoramaView(input.imagePanorama) }
    catch { throw new WorkshopError('全景视角设置无效，请检查水平角度、俯仰与视野') }
  }
  if (kind === 'frame-extract' && typeof input.timestampSeconds === 'number' && Number.isFinite(input.timestampSeconds) && input.timestampSeconds >= 0 && input.timestampSeconds <= 86_400) settings.timestampSeconds = input.timestampSeconds
  if (kind === 'router') settings.strategy = safeChoice(input.strategy, ['all', 'first-available']) ?? 'first-available'
  if (kind === 'video-generate' || kind === 'video') {
    const mode = safeChoice(input.videoMode, ['auto', 't2va', 'i2va', 'fl2va', 'l2va', 'ref2va'])
    const resolution = safeChoice(input.videoResolution, ['480p', '720p', '1080p'])
    const ratio = safeChoice(input.videoAspectRatio, ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21', '4:5', '5:4', '3:2', '2:3', '5:2'])
    if (mode) settings.videoMode = mode
    if (resolution) settings.videoResolution = resolution
    if (ratio) settings.videoAspectRatio = ratio
    if (typeof input.promptOptimization === 'boolean') settings.promptOptimization = input.promptOptimization
    if (input.generateAudio !== undefined) settings.generateAudio = parseVideoGenerateAudio(input.generateAudio, kind)
  }
  return Object.keys(settings).length ? settings : undefined
}

/** Whitelist before parsing: the general workflow parser also restores outputs. */
export function sanitizeWorkshopWorkflow(value: unknown, kind: CanvasWorkshopKind, name: string, portable = false): WorkflowFile {
  assertRouterStrategyWorkflowConfiguration(value)
  return sanitizeWorkshopConfiguration(value, kind, name, portable, false)
}

/** This parser grants no authority. The owner service validates every fresh
 * pinned write against live provider metadata; reads retain unavailable pins. */
export function sanitizeOwnerPrivateWorkshopWorkflow(value: unknown, kind: CanvasWorkshopKind, name: string): WorkflowFile {
  return sanitizeWorkshopConfiguration(value, kind, name, false, true)
}

/** Only call after reading an owner-scoped personal original. External files
 * continue through the rejecting parser, never through this projection. */
export function buildPortableWorkshopWorkflowFromPrivate(value: unknown, kind: CanvasWorkshopKind, name: string): WorkflowFile {
  const privateWorkflow = sanitizeOwnerPrivateWorkshopWorkflow(value, kind, name)
  const workflow = { ...privateWorkflow, nodes: privateWorkflow.nodes.map((node) => {
    const { group: _privateSource, ...data } = node.data
    return { ...node, data }
  }) }
  return sanitizeWorkshopWorkflow(workflow, kind, name, true)
}

function sanitizeWorkshopConfiguration(value: unknown, kind: CanvasWorkshopKind, name: string, portable: boolean, ownerPrivate: boolean): WorkflowFile {
  assertRouterStrategyWorkflowConfiguration(value)
  if (!isRecord(value) || value.schemaVersion !== 2 || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) throw new WorkshopError('工坊内容必须是有效的画布节点配置')
  if (!value.nodes.length || value.nodes.length > maximumWorkshopNodes || value.edges.length > maximumWorkshopEdges) throw new WorkshopError('每个工坊条目需要 1–200 个节点，且不超过 800 条连线')
  let inputBytes: number
  try { inputBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength } catch { throw new WorkshopError('节点配置无法保存') }
  if (inputBytes > maximumWorkshopBytes) throw new WorkshopError('节点配置超过 512 KB，请缩小选区后保存', 413)
  const ids = new Map<string, string>()
  for (const [index, node] of value.nodes.entries()) {
    if (!isRecord(node) || typeof node.id !== 'string' || !node.id || node.id.length > 256 || ids.has(node.id)) throw new WorkshopError('节点编号格式不正确或重复')
    ids.set(node.id, `node-${index + 1}`)
  }
  const nodes = value.nodes.map((node) => {
    if (!isRecord(node) || typeof node.id !== 'string' || typeof node.kind !== 'string' || !isRecord(node.data) || !isRecord(node.position)) throw new WorkshopError('节点配置格式不正确')
    if (node.unknownKind || node.kind === 'unknown') throw new WorkshopError('未知节点暂不能保存到工坊，请先移除未知节点')
    if (node.disabled !== undefined && typeof node.disabled !== 'boolean') throw new WorkshopError('节点禁用状态格式不正确')
    const data = node.data
    try { assertNodeMediaSourceGroup(node.kind, data); assertWorkflowColorGradeDetailPlacement(node.kind, data) } catch (error) { throw new WorkshopError(error instanceof Error ? error.message : '工坊细节与降噪配置位置不正确') }
    const fixedSource = graphHasNodeMediaSource({ nodes: [node] })
    if (fixedSource && !ownerPrivate) throw new WorkshopError('此节点固定了本人模型来源，请先在节点生成来源中显式选择“使用画布默认来源”，再保存或导入工坊；当前没有更换来源')
    if (Object.hasOwn(data, 'storyboardTask') || Object.hasOwn(data, 'exteriorTask') || Object.hasOwn(data, 'interiorTask') || Object.hasOwn(data, 'commerceTask') || Object.hasOwn(data, 'imageReferenceOrder')) throw new WorkshopError('创作任务和参考图角色必须保存在节点配置中，不会丢弃这些字段后保存')
    const prompt = workshopPromptText(data.prompt ?? '', '提示词', 24_000, true)
    // Redaction may move text. Keep only exact official snapshots in
    // the resulting prose; untrusted metadata never supplies executable text.
    const promptReferences = parsePromptReferences(typeof data.prompt === 'string' ? data.prompt : '', data.promptReferences)
    const retainedPromptReferences = parsePromptReferences(prompt, promptReferences)
    const model = configText(data.model ?? '') ?? ''
    if (fixedSource && (typeof data.model !== 'string' || model !== data.model || model.length > 200)) throw new WorkshopError('固定来源的模型格式无效；不会丢弃或改写模型后保存')
    let settings: ReturnType<typeof nodeSettings>
    try { settings = nodeSettings(node.kind, data.settings, portable) } catch (error) {
      if (graphHasLayerGroups({ nodes: [node] }) || graphHasColorGradeCalibration({ nodes: [node] }) || graphHasColorGradePresence({ nodes: [node] })) throw new WorkshopError(error instanceof Error ? error.message : '持久图层编组或图像效果配置无效')
      throw error
    }
    return {
      id: ids.get(node.id), kind: node.kind, definitionVersion: node.definitionVersion ?? 1,
      ...(node.disabled === true ? { disabled: true } : {}),
      position: { x: node.position.x, y: node.position.y },
      ...(typeof node.parentId === 'string' ? { parentId: ids.get(node.parentId) ?? '__missing-parent__' } : {}),
      ...(node.width !== undefined ? { width: node.width } : {}), ...(node.height !== undefined ? { height: node.height } : {}),
      data: { prompt, model,
        ...(fixedSource && ownerPrivate ? { group: data.group as string } : {}),
        ...(retainedPromptReferences.length ? { promptReferences: retainedPromptReferences } : {}),
        ...(data.quality !== undefined ? { quality: configText(data.quality, 128) } : {}),
        ...(data.size !== undefined ? { size: configText(data.size, 128) } : {}),
        ...(data.imageResolution !== undefined ? { imageResolution: data.imageResolution } : {}),
        ...(data.textWebSearch !== undefined ? { textWebSearch: data.textWebSearch } : {}),
        ...(data.imageCandidateCount !== undefined ? { imageCandidateCount: data.imageCandidateCount } : {}),
        ...(data.videoCandidateCount !== undefined ? { videoCandidateCount: data.videoCandidateCount } : {}),
        ...(data.seconds !== undefined ? { seconds: data.seconds } : {}),
        ...(settings ? { settings } : {}),
      },
    }
  })
  const edgeIds = new Map<string, string>()
  const edges = value.edges.map((edge, index) => {
    if (!isRecord(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string') throw new WorkshopError('工坊连线格式不正确')
    if (typeof edge.id !== 'string' || !edge.id || edgeIds.has(edge.id)) throw new WorkshopError('工坊连线编号格式不正确或重复')
    edgeIds.set(edge.id, `edge-${index + 1}`)
    return { id: `edge-${index + 1}`, source: ids.get(edge.source), target: ids.get(edge.target), sourceHandle: edge.sourceHandle, targetHandle: edge.targetHandle }
  })
  for (const node of nodes) {
    node.data.settings = remapImageReferenceOrderSettings(node.data.settings, kind === 'node' ? new Map() : new Map([...edgeIds].filter(([, mapped]) => edges.some((edge) => edge.id === mapped && edge.target === node.id && edge.targetHandle === 'in:images'))))
    if (node.kind === 'image-compare' && node.data.settings?.imageCompare !== undefined) {
      const incoming = new Map([...edgeIds].filter(([, mapped]) => edges.some((edge) => edge.id === mapped && edge.target === node.id && edge.targetHandle === 'in:images' && ['out:image', 'out:images'].includes(String(edge.sourceHandle)))))
      node.data.settings.imageCompare = portableImageCompareSettings(node.data.settings.imageCompare, kind === 'node' ? undefined : incoming)
    }
    if (node.kind === 'image-collage') node.data.settings = remapCollageInputOrderSettings(node.data.settings, kind === 'node' ? new Map() : edgeIds)
    if (node.kind === 'image-tile') {
      const incoming = new Map([...edgeIds].filter(([, mapped]) => edges.some((edge) => edge.id === mapped && edge.target === node.id && edge.targetHandle === 'in:image' && ['out:image', 'out:images'].includes(String(edge.sourceHandle)))))
      node.data.settings = remapTileInputSettings(node.data.settings, kind === 'node' ? new Map() : incoming)
    }
    if (node.kind === 'video' || node.kind === 'video-generate') node.data.settings = remapVideoReferenceOrderSettings(node.data.settings, kind === 'node' ? new Map() : edgeIds)
  }
  const parsed = sanitizeWorkflowV2({ schemaVersion: 2, name, nodes, edges })
  if (!parsed || parsed.warnings.length || parsed.workflow.nodes.some((node) => node.unknownKind || node.kind === 'unknown')) throw new WorkshopError('选区含无效的节点、编组或连线，请先修正后保存')
  if (kind === 'node' && (parsed.workflow.nodes.length !== 1 || parsed.workflow.nodes[0].kind === 'group')) throw new WorkshopError('节点配置只能包含一个非分组节点')
  if (kind === 'group' && !parsed.workflow.nodes.some((node) => node.kind !== 'group')) throw new WorkshopError('编组模板需要至少一个内容节点')
  // Redaction may expand short secrets; reject before committing an item that
  // its own bounded reader would be unable to reopen.
  if (new TextEncoder().encode(JSON.stringify(parsed.workflow)).byteLength > maximumWorkshopBytes) throw new WorkshopError('脱敏后的节点配置超过 512 KB，请缩小选区后保存', 413)
  return parsed.workflow
}

export function workshopNodeKinds(workflow: WorkflowFile): NodeKind[] {
  return [...new Set(workflow.nodes.map((node) => node.kind))]
}
import { portableImageEditMask } from '../image-tools/image-edit-mask'
import { parseNodeImageEditMask } from '../image-tools/image-mask-workflow'
