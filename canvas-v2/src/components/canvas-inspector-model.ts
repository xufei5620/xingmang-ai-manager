import { arkSeedanceVideoDefaults, arkSeedanceVideoModelSupported } from '../lib/video-request-protocol'
import { commerceTaskLabels, parseCommerceTask, type CommerceTask } from '../commerce/commerce-task'
import type { ImageCandidateCount } from '../runtime/image-candidate-count'
import type { Edge } from '@xyflow/react'
import { builtinNodeRegistry } from '../domain/builtin-node-definitions'
import type { NodePortDefinition } from '../domain/node-definition'
import type { AssetRef, WorkflowNodeData } from '../model'
import {
  defaultImageQuality,
  defaultImageResolution,
  imageModelPreset,
  imageQualityOptions,
  videoModelPreset,
  videoModeOptions,
  videoSizeOptions,
} from '../models'
import type { CanvasNode } from '../nodes/WorkflowNodes'
import { canvasRouterStrategyPresentation, routerExecutionScopeNotice } from '../nodes/router-strategy-presentation'
import { inspectImageResolutionSelection } from '../runtime/image-resolution-selection'
import type { CanvasCapabilityProfile } from '../host-capabilities'
import { hostFeatureControlShown } from './host-feature-controls'
import { mediaAssetSizeLabel, requestedSizeLabel } from '../library/media-assets'
import { imageCollageUsesAutoSize, imageTransformRecipeForNode, isImageTransformNodeKind, type ImageCollageRecipe, type ImageTransformRecipe } from '../image-tools/recipe'
import { resolveImageCollageTemplate } from '../image-tools/collage-templates'
import { stableAssetId } from '../persistence/workflow-schema'

export interface CanvasInspectorPort extends NodePortDefinition {
  connectionCount: number
}

export interface CanvasInspectorNode {
  id: string
  kind: string
  title: string
  description: string
  status: WorkflowNodeData['status']
  prompt: string
  outputText?: string
  model: string
  quality?: string
  size?: string
  imageResolution?: '1K' | '2K' | '4K'
  imageCandidateCount?: ImageCandidateCount
  seconds?: string
  group?: string
  settings: Record<string, unknown>
  previewAsset?: AssetRef
  candidateCount: number
  attemptCount?: number
  latestAttemptDurationMs?: number
  costQuota?: number
  errorMessage?: string
  dirty: boolean
  disabled: boolean
  locked: boolean
  executable: boolean
  ports: CanvasInspectorPort[]
}

export interface CanvasInspectorParameterRow {
  label: string
  value: string
}

const imageParameterKinds = new Set(['image', 'image-generate', 'image-edit'])
const videoParameterKinds = new Set(['video', 'video-generate'])
const promptParameterKinds = new Set(['text', 'prompt', 'text-generate', 'image', 'image-generate', 'image-edit', 'video', 'video-generate'])

function inspectorCommerceTask(settings: Record<string, unknown>): CommerceTask | undefined {
  if (settings.commerceTask === undefined) return undefined
  try { return parseCommerceTask(settings.commerceTask) } catch { return undefined }
}

function optionLabel(options: readonly { value: string; label: string }[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value
}

function collageStyleParameterRows(recipe: ImageCollageRecipe): CanvasInspectorParameterRow[] {
  const rows: CanvasInspectorParameterRow[] = []
  if (recipe.cornerRadius !== undefined) rows.push({ label: '圆角', value: `${recipe.cornerRadius} 像素` })
  if (recipe.borderWidth !== undefined || recipe.borderColor !== undefined) {
    const color = recipe.borderColor ?? '#ffffff'
    rows.push({ label: '边框', value: (recipe.borderWidth ?? 0) > 0 ? `${recipe.borderWidth} 像素 · ${color === 'transparent' ? '透明' : color.toUpperCase()}` : '关闭' })
  }
  if (recipe.shadow !== undefined) rows.push({ label: '图片阴影', value: recipe.shadow ? '开启' : '关闭' })
  if (recipe.watermark) {
    const watermark = recipe.watermark
    rows.push({ label: '文字水印', value: !watermark.text.trim() ? '未填写文字（不绘制）' : `“${watermark.text}” · ${watermark.color === 'transparent' ? '透明' : watermark.color.toUpperCase()} · 不透明度 ${Number((watermark.opacity * 100).toFixed(2))}% · ${watermark.fontSize} 像素 · 斜向平铺${watermark.opacity === 0 || watermark.color === 'transparent' ? '（不绘制）' : ''}` })
  }
  return rows
}

function imageTransformParameterRows(recipe: ImageTransformRecipe): CanvasInspectorParameterRow[] {
  const operation = { crop: '裁剪图片', collage: '拼图', 'grid-split': '宫格裁剪', tile: '平铺图片', layer: '图层合成' }[recipe.kind]
  const rows = [{ label: '图像工具', value: operation }]
  if ('outputWidth' in recipe) rows.push({ label: '输出尺寸', value: imageCollageUsesAutoSize(recipe) ? '自动 · 按输入图片比例计算（最长边不超过 4096 像素）' : `${recipe.outputWidth} × ${recipe.outputHeight}` })
  if (recipe.kind === 'crop') {
    const percent = (value: number) => `${Number((value * 100).toFixed(2))}%`
    rows.push({ label: '裁剪起点', value: `X ${percent(recipe.x)} · Y ${percent(recipe.y)}` })
    rows.push({ label: '裁剪范围', value: `宽 ${percent(recipe.width)} · 高 ${percent(recipe.height)}` })
    rows.push({ label: '旋转', value: `${recipe.rotation}°` })
    rows.push({ label: '翻转', value: [recipe.flipX ? '水平' : '', recipe.flipY ? '垂直' : ''].filter(Boolean).join('、') || '关闭' })
  }
  if ('rows' in recipe) {
    if (recipe.kind === 'collage' && recipe.layout !== undefined) {
      const labels: Partial<Record<NonNullable<ImageCollageRecipe['layout']>, string>> = { grid: '网格', horizontal: '横向拼接', vertical: '纵向拼接', 'hero-left': '主图在左', 'hero-top': '主图在上' }
      const template = resolveImageCollageTemplate(recipe.layout)
      rows.push({ label: '拼图布局', value: template ? `${template.title} · ${template.inputCount} 张` : labels[recipe.layout] ?? recipe.layout })
    }
    if (recipe.kind !== 'collage' || !recipe.layout || recipe.layout === 'grid') rows.push({ label: '排列', value: `${recipe.rows} 行 × ${recipe.columns} 列` })
    if (recipe.kind === 'grid-split') rows.push({ label: '切片数量', value: `${recipe.rows * recipe.columns} 张` })
    rows.push({ label: '间距', value: `${recipe.gap} 像素` })
    if ('padding' in recipe) rows.push({ label: '边距', value: `${recipe.padding} 像素` })
  }
  if ('fit' in recipe) rows.push({ label: '图片填充', value: recipe.fit === 'cover' ? '填满格子（居中裁切）' : '保留完整图片' })
  if ('background' in recipe) rows.push({ label: '背景', value: recipe.background === 'transparent' ? '透明' : recipe.background.toUpperCase() })
  if (recipe.kind === 'collage') rows.push(...collageStyleParameterRows(recipe))
  if (recipe.kind === 'tile') rows.push({ label: '交替镜像', value: recipe.mirrorAlternate ? '开启' : '关闭' })
  if (recipe.kind === 'layer') {
    if (!recipe.layers.length && !recipe.explicitLayers) rows.push({ label: '图层', value: '按上游每张图片自动建立' })
    else {
      rows.push({ label: '图层数量', value: `${recipe.layers.length} 层` })
      if (recipe.layers.length) {
        const paintLayers = recipe.layers.filter((layer) => layer.content?.kind === 'paint').length
        rows.push({ label: '图层内容', value: `图片 ${recipe.layers.filter((layer) => !layer.content).length} · 文字 ${recipe.layers.filter((layer) => layer.content?.kind === 'text').length} · 形状 ${recipe.layers.filter((layer) => layer.content?.kind === 'shape').length}${paintLayers ? ` · 绘画 ${paintLayers}` : ''}` })
        rows.push({ label: '可见图层', value: `${recipe.layers.filter((layer) => layer.visible && layer.opacity > 0).length} 层` })
        const strokes = recipe.layers.flatMap((layer) => layer.edits?.operations ?? [])
        if (strokes.length) rows.push({ label: '绘画编辑', value: `画笔 ${strokes.filter((stroke) => stroke.mode === 'paint').length} 笔 · 擦除 ${strokes.filter((stroke) => stroke.mode === 'erase').length} 笔${strokes.some((stroke) => stroke.mode === 'blur' || stroke.mode === 'sharpen') ? ` · 模糊 ${strokes.filter((stroke) => stroke.mode === 'blur').length} 笔 · 锐化 ${strokes.filter((stroke) => stroke.mode === 'sharpen').length} 笔` : ''}` })
        const masks = recipe.layers.filter((layer) => layer.mask)
        if (masks.length) rows.push({ label: '图层蒙版', value: `${masks.length} 个 · 可在图层编辑器中移除` })
      } else rows.push({ label: '画布内容', value: '空白画布' })
    }
  }
  return rows
}

/**
 * Read-only projection of a node's parameters for the inspector. The node body
 * stays the single place these values are edited; duplicating the controls here
 * gave every parameter two independent editors for one piece of state.
 */
export function canvasInspectorParameterRows(node: Pick<CanvasInspectorNode, 'kind' | 'prompt' | 'model' | 'quality' | 'size' | 'imageResolution' | 'imageCandidateCount' | 'seconds' | 'group' | 'settings' | 'previewAsset'>, capabilities?: CanvasCapabilityProfile): CanvasInspectorParameterRow[] {
  const rows: CanvasInspectorParameterRow[] = []
  if (node.group !== undefined && (imageParameterKinds.has(node.kind) || videoParameterKinds.has(node.kind) || node.kind === 'text-generate')) rows.push({ label: '固定来源', value: node.group || '空值（待配置）' })
  if (isImageTransformNodeKind(node.kind)) {
    try {
      const recipe = imageTransformRecipeForNode(node.kind, node.settings)
      if (recipe) rows.push(...imageTransformParameterRows(recipe))
    } catch (error) { rows.push({ label: '参数状态', value: error instanceof Error ? error.message : '参数无效，请在节点上重新设置' }) }
    const actualSize = mediaAssetSizeLabel(node.previewAsset)
    if (actualSize) rows.push({ label: node.kind === 'image-grid-split' ? '选中切片尺寸' : '产物尺寸', value: actualSize })
  }
  if (node.kind === 'image-compare') {
    const settings = node.settings.imageCompare
    const mode = settings && typeof settings === 'object' && 'mode' in settings ? settings.mode : undefined
    rows.push({ label: '图像工具', value: '图片对比' })
    rows.push({ label: '对比模式', value: mode === 'side-by-side' ? '并排对比' : mode === 'grid' ? '四图对比' : mode === 'opacity' ? '透明叠加' : mode === 'toggle' ? '点按切换' : '滑动对比' })
  }
  if (node.kind === 'image-panorama') {
    rows.push({ label: '图像工具', value: '360° 全景预览' })
    rows.push({ label: '图片格式', value: '等距柱状全景图' })
    rows.push({ label: '视角操作', value: '在节点上展开，拖动转向、放大或缩小' })
  }
  if (promptParameterKinds.has(node.kind)) {
    rows.push({ label: '提示词', value: node.prompt.trim() || '未填写' })
  }
  if (imageParameterKinds.has(node.kind)) {
    const commerce = inspectorCommerceTask(node.settings)
    const derived = commerce?.kind === 'material-b'
    const preset = imageModelPreset(node.model, capabilities)
    const resolution = inspectImageResolutionSelection({ model: node.model, size: node.size, imageResolution: node.imageResolution }, capabilities)
    rows.push({ label: '模型', value: node.model ? preset.label : '继承项目生成配置' })
    if (preset.supportsQuality) {
      rows.push({ label: '画质', value: optionLabel(imageQualityOptions, node.quality || defaultImageQuality) })
    }
    rows.push({ label: '生成数量', value: `×${node.imageCandidateCount ?? 1} · 按次计费` })
    if (commerce) rows.push({ label: '专用任务', value: commerceTaskLabels[commerce.kind] })
    if (derived) rows.push({ label: '请求尺寸', value: `原图宽高 × ${commerce.upscale}；在节点配置中核对派生尺寸` })
    rows.push({ label: '清晰度', value: derived ? '由原图与倍率决定' : !node.model ? '由实际模型能力确定' : resolution.providerSized && resolution.value === '1K' ? '由服务决定' : node.imageResolution ?? defaultImageResolution })
    const actualSize = mediaAssetSizeLabel(node.previewAsset)
    if (actualSize) rows.push({ label: '产物尺寸', value: actualSize })
    else if (!derived && preset.supportsSize && !resolution.hostSized) rows.push({ label: '请求尺寸', value: !node.model ? '由项目实际模型与尺寸配置确定' : requestedSizeLabel(resolution.effectiveSize) ?? '当前组合不可用' })
    if (!derived && node.model && resolution.message) rows.push({ label: '分辨率提示', value: resolution.message })
  }
  if (node.kind === 'text-generate') rows.push({ label: '文字模型', value: node.model || '未选择' })
  if (videoParameterKinds.has(node.kind)) {
    const preset = videoModelPreset(node.model)
    const ark = arkSeedanceVideoModelSupported(node.model)
    const mode = typeof node.settings.videoMode === 'string' ? node.settings.videoMode : 'auto'
    const ratio = typeof node.settings.videoAspectRatio === 'string' ? node.settings.videoAspectRatio : undefined
    const resolution = typeof node.settings.videoResolution === 'string' ? node.settings.videoResolution : undefined
    rows.push({ label: '模型', value: node.model ? preset.label : '继承项目生成配置' })
    rows.push({ label: '生成模式', value: optionLabel(videoModeOptions, mode) || '空值（待核对）' })
    rows.push({ label: '比例', value: ratio !== undefined ? ratio === 'adaptive' ? '自适应' : ratio || '空值（待核对）' : ark ? arkSeedanceVideoDefaults.aspectRatio === 'adaptive' ? '自适应' : arkSeedanceVideoDefaults.aspectRatio : !node.model ? '由实际模型与输入确定' : optionLabel(videoSizeOptions, node.size || preset.defaultSize) })
    rows.push({ label: '清晰度', value: resolution !== undefined ? resolution || '空值（待核对）' : ark ? arkSeedanceVideoDefaults.resolution : '由所选来源与模型确定' })
    rows.push({ label: '时长', value: node.seconds !== undefined ? `${node.seconds} 秒` : ark ? `${arkSeedanceVideoDefaults.seconds} 秒` : node.model ? `${preset.defaultSeconds} 秒` : '由实际模型确定' })
    rows.push({ label: '生成音频', value: node.settings.generateAudio === false ? '关闭（已保存）' : node.settings.generateAudio === true ? '开启（已保存）' : '使用服务默认设置' })
    if (node.settings.promptOptimization !== undefined) rows.push({ label: '提示词优化', value: node.settings.promptOptimization === true ? '开启（已保存，按来源能力核对）' : '关闭（已保存）' })
  }
  if (node.kind === 'frame-extract') {
    const timestamp = typeof node.settings.timestampSeconds === 'number' ? node.settings.timestampSeconds : 0
    rows.push({ label: '时间点', value: `${timestamp} 秒` })
  }
  if (node.kind === 'router') {
    const strategy = canvasRouterStrategyPresentation(node.settings)
    rows.push({ label: '路由策略', value: strategy.label })
    // Without router strategies the node offers no control (#4), so the rows that ask for a choice stay out too.
    if (hostFeatureControlShown(capabilities, 'routerStrategy', Object.hasOwn(node.settings, 'routerStrategy'))) rows.push({ label: '输入选择', value: strategy.description }, { label: '执行范围', value: routerExecutionScopeNotice })
  }
  if (node.kind === 'note') {
    rows.push({ label: '便签', value: typeof node.settings.text === 'string' && node.settings.text.trim() ? node.settings.text : '未填写' })
  }
  if (node.kind === 'group') {
    rows.push({ label: '分组名称', value: typeof node.settings.title === 'string' && node.settings.title ? node.settings.title : '新建分组' })
  }
  if (node.kind === 'drama-bible') {
    rows.push({ label: '风格', value: typeof node.settings.stylePrompt === 'string' && node.settings.stylePrompt ? node.settings.stylePrompt : (node.prompt.trim() || '未填写') })
  }
  if (node.kind === 'drama-character' || node.kind === 'drama-scene' || node.kind === 'drama-prop') {
    rows.push({ label: '名称', value: typeof node.settings.name === 'string' && node.settings.name ? node.settings.name : '未命名' })
    rows.push({ label: '封板', value: node.settings.locked === true ? '已封板' : '未封板' })
  }
  if (node.kind === 'drama-shot') {
    rows.push({ label: '镜号', value: typeof node.settings.shotId === 'string' && node.settings.shotId ? node.settings.shotId : '未编号' })
    rows.push({ label: '闸', value: node.settings.gate === 'ready' ? '可出图' : node.settings.gate === 'stale' ? '需重编译' : '未封板' })
  }
  return rows
}

function selectedPreviewAsset(node: CanvasNode): AssetRef | undefined {
  const candidate = node.data.candidates?.find((entry) => entry.candidateId === node.data.selectedCandidateId)
    ?? node.data.candidates?.find((entry) => entry.candidateId === node.data.adoptedCandidateId)
    ?? node.data.candidates?.[0]
  return candidate?.asset ?? node.data.result
}

export function projectCanvasInspectorNodes(
  nodes: readonly CanvasNode[],
  edges: readonly Edge[],
): CanvasInspectorNode[] {
  const selected = nodes.filter((node) => node.selected)
  if (selected.length === 0) return []
  const connectionCounts = new Map<string, number>()
  for (const edge of edges) {
    const sourceKey = `${edge.source}:output:${edge.sourceHandle ?? ''}`
    const targetKey = `${edge.target}:input:${edge.targetHandle ?? ''}`
    connectionCounts.set(sourceKey, (connectionCounts.get(sourceKey) ?? 0) + 1)
    connectionCounts.set(targetKey, (connectionCounts.get(targetKey) ?? 0) + 1)
  }
  return selected.map((node) => {
    const definition = builtinNodeRegistry.resolve(node.type ?? 'unknown') ?? builtinNodeRegistry.require('unknown')
    const commerce = inspectorCommerceTask(node.data.settings ?? {})
    return {
      id: node.id,
      kind: node.type ?? 'unknown',
      title: commerce ? (typeof node.data.settings?.title === 'string' && node.data.settings.title.trim() ? node.data.settings.title : commerceTaskLabels[commerce.kind]) : definition.title,
      description: commerce ? '按保存的任务参数和参考图角色生成候选；在节点中配置、比较并保存复用。' : definition.description,
      status: node.data.status,
      prompt: node.data.prompt,
      ...(['text-generate', 'output'].includes(node.type ?? '') && node.data.outputText ? { outputText: node.data.outputText.slice(0, 32_000) } : {}),
      model: node.data.model,
      ...(node.data.quality ? { quality: node.data.quality } : {}),
      ...(node.data.size ? { size: node.data.size } : {}),
      ...(node.data.imageResolution ? { imageResolution: node.data.imageResolution } : {}),
      ...(node.data.imageCandidateCount !== undefined ? { imageCandidateCount: node.data.imageCandidateCount } : {}),
      ...(node.data.seconds ? { seconds: node.data.seconds } : {}),
      ...(typeof node.data.group === 'string' && node.data.group ? { group: node.data.group } : {}),
      settings: { ...(node.data.settings ?? {}) },
      ...(selectedPreviewAsset(node) ? { previewAsset: selectedPreviewAsset(node) } : {}),
      candidateCount: node.data.candidateAssetIds !== undefined ? new Set(node.data.candidateAssetIds.slice(0, 16).filter(stableAssetId)).size : node.data.candidates?.length ?? 0,
      attemptCount: node.data.attemptCount,
      ...(node.data.latestAttemptDurationMs !== undefined ? { latestAttemptDurationMs: node.data.latestAttemptDurationMs } : {}),
      ...(node.data.costQuota !== undefined ? { costQuota: node.data.costQuota } : {}),
      ...(node.data.errorMessage ? { errorMessage: node.data.errorMessage } : {}),
      dirty: Boolean(node.data.dirty),
      disabled: Boolean(node.disabled),
      locked: node.draggable === false,
      executable: definition.executable,
      ports: definition.ports.map((port) => ({
        ...port,
        connectionCount: connectionCounts.get(`${node.id}:${port.direction}:${port.id}`) ?? 0,
      })),
    }
  })
}
