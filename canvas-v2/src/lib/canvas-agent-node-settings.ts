import { parseCanvasRouterStrategy, type CanvasRouterStrategy } from '../runtime/router-strategy'
import { imageTransformKindForNode, parseImageTransformRecipe, type ImageTransformRecipe } from '../image-tools/recipe'
import { parseImageCollageInputOrder, type ImageCollageInputOrder } from '../image-tools/collage-input-order'
import { parseImageCompareSettings, type ImageCompareSettings } from '../image-tools/viewer-settings'
import { parsePanoramaView, type PanoramaView } from '../image-tools/panorama-view-state'

/** Only executable, versioned local configuration enters reviewed proposals. */
export interface CanvasAgentNodeSettings {
  routerStrategy?: CanvasRouterStrategy
  imageTransform?: ImageTransformRecipe
  imageCollageInputOrder?: ImageCollageInputOrder
  imageCompare?: ImageCompareSettings
  imagePanorama?: PanoramaView
  timestampSeconds?: number
}

export const canvasAgentLocalNodeKinds = ['image-crop', 'image-collage', 'image-grid-split', 'image-tile', 'image-layer', 'image-compare', 'image-panorama', 'frame-extract', 'router', 'image-input', 'video-input', 'audio-input'] as const

export function parseCanvasAgentNodeSettings(value: unknown, kind?: string): CanvasAgentNodeSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Agent 本地节点参数必须是对象')
  const raw = value as Record<string, unknown>
  const allowed = ['imageTransform', 'imageCollageInputOrder', 'imageCompare', 'imagePanorama', 'timestampSeconds', 'routerStrategy']
  if (!Object.keys(raw).length || Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error('Agent 本地节点参数包含不支持的字段或为空')
  const result: CanvasAgentNodeSettings = {}
  if (Object.hasOwn(raw, 'routerStrategy')) { if (kind !== undefined && kind !== 'router') throw new Error('Agent 路由策略只能用于路由节点'); result.routerStrategy = parseCanvasRouterStrategy(raw.routerStrategy) }
  if (raw.imageTransform !== undefined) {
    const recipe = parseImageTransformRecipe(raw.imageTransform)
    if (kind !== undefined && imageTransformKindForNode(kind) !== recipe.kind) throw new Error('Agent 图片配方与节点类型不匹配')
    result.imageTransform = recipe
  }
  if (raw.imageCollageInputOrder !== undefined) {
    if (kind !== undefined && kind !== 'image-collage') throw new Error('Agent 拼图顺序只能用于拼图节点')
    const order = raw.imageCollageInputOrder
    if (!order || typeof order !== 'object' || Array.isArray(order) || Object.keys(order).some((key) => !['version', 'slots'].includes(key))) throw new Error('Agent 拼图顺序字段无效')
    const slots = (order as Record<string, unknown>).slots
    if (!Array.isArray(slots) || slots.some((slot) => !slot || typeof slot !== 'object' || Array.isArray(slot) || Object.keys(slot).some((key) => !['edgeId', 'outputIndex'].includes(key)))) throw new Error('Agent 拼图来源字段无效')
    result.imageCollageInputOrder = parseImageCollageInputOrder(order)
  }
  if (raw.imageCompare !== undefined) {
    if (kind !== undefined && kind !== 'image-compare') throw new Error('Agent 对比设置只能用于图片对比节点')
    result.imageCompare = parseImageCompareSettings(raw.imageCompare)
  }
  if (raw.imagePanorama !== undefined) {
    if (kind !== undefined && kind !== 'image-panorama') throw new Error('Agent 全景设置只能用于全景节点')
    result.imagePanorama = parsePanoramaView(raw.imagePanorama)
  }
  if (raw.timestampSeconds !== undefined) {
    if (kind !== undefined && kind !== 'frame-extract') throw new Error('Agent 抽帧时间只能用于视频抽帧节点')
    if (typeof raw.timestampSeconds !== 'number' || !Number.isFinite(raw.timestampSeconds) || raw.timestampSeconds < 0 || raw.timestampSeconds > 86_400) throw new Error('Agent 抽帧时间必须在 0–86400 秒之间')
    result.timestampSeconds = raw.timestampSeconds
  }
  if (!Object.keys(result).length) throw new Error('Agent 本地节点参数为空')
  return result
}

export function canvasAgentSettingsAffectOutput(settings: CanvasAgentNodeSettings): boolean {
  return settings.routerStrategy !== undefined || settings.imageTransform !== undefined || settings.imageCollageInputOrder !== undefined || settings.timestampSeconds !== undefined
}
