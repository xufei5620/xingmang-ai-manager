import { isImageTransformNodeKind } from '../image-tools/recipe'
import { availableImageModelPresets, availableVideoModelPresets, defaultVideoModel, imageModelPresets, presetVideoModels } from '../models'
import { resolveCanvasNodeModelAvailability, type CanvasNodeModelAvailability } from '../library/node-model-availability'
import type { CanvasCapabilityProfile } from '../host-capabilities'
import { canvasNodeKindUnsupportedReason } from '../runtime/host-run-compatibility'

export interface SelectedRunNode { id: string; type?: string; disabled?: boolean; data: { status: string; model: string; group?: string } }
export interface NodeRunModelAvailability extends CanvasNodeModelAvailability {}

export function nodeSupportsRunActions(kind: string): boolean {
  return isImageTransformNodeKind(kind) || ['image-compare', 'image-panorama', 'text-generate', 'image', 'video', 'image-generate', 'image-edit', 'video-generate', 'frame-extract', 'drama-parse'].includes(kind)
}

/** With a host profile, a node the host cannot run gets the reason instead of a run action. */
export function inspectSelectedNodeRun(node: SelectedRunNode | undefined, defaults: NodeRunModelAvailability, capabilities?: CanvasCapabilityProfile): { disabledReason?: string } | null {
  if (!node || !nodeSupportsRunActions(node.type ?? '')) return null
  const unsupported = capabilities && canvasNodeKindUnsupportedReason(node.type ?? '', capabilities)
  if (unsupported) return { disabledReason: unsupported }
  if (node.disabled) return { disabledReason: '此节点已跳过运行，请先在“更多”中启用节点。' }
  if (node.data.status === 'running' || node.data.status === 'queued') return { disabledReason: '此节点正在运行，请等待完成或先取消。' }
  const models = resolveCanvasNodeModelAvailability(node.type ?? '', node.data, defaults)
  if (models.sourceError) return { disabledReason: models.sourceError }
  if (!models.connected) return {}
  const kind = node.type, image = kind === 'image' || kind === 'image-generate' || kind === 'image-edit', video = kind === 'video' || kind === 'video-generate', text = kind === 'text-generate'
  const imagePresets = models.connected ? availableImageModelPresets(models.imageModels, true) : imageModelPresets
  const videoPresets = availableVideoModelPresets(models.connected ? models.videoModels : presetVideoModels, models.connected, capabilities)
  const selected = node.data.model || (node.data.group !== undefined ? '' : text ? models.textModel ?? '' : video ? models.videoModel ?? videoPresets[0]?.id ?? defaultVideoModel : models.imageModel ?? imagePresets[0]?.id ?? '')
  const available = text ? models.textModels.includes(selected) : image ? imagePresets.some((preset) => preset.id === selected) : !video || videoPresets.some((preset) => preset.id === selected)
  if (!available) return { disabledReason: `请先在生成配置选择可用的${text ? '文字' : video ? '视频' : '图像'}来源与模型。` }
  return {}
}
