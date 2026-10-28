export interface ImageLayerColorDetail {
  version: 1
  enabled: boolean
  sharpening: { amount: number; radius: number; detail: number; masking: number }
  luminance: { amount: number; detail: number; contrast: number }
  color: { amount: number; detail: number; smoothness: number }
}

export function defaultImageLayerColorDetail(): ImageLayerColorDetail {
  return { version: 1, enabled: true, sharpening: { amount: 0, radius: 1, detail: 25, masking: 0 }, luminance: { amount: 0, detail: 50, contrast: 0 }, color: { amount: 0, detail: 50, smoothness: 50 } }
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('细节与降噪配置含未知字段或缺少必要参数')
  return value as Record<string, unknown>
}

function number(value: unknown, low: number, high: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new Error('细节与降噪参数超出支持范围')
  return Object.is(value, -0) ? 0 : value
}

export function parseImageLayerColorDetail(value: unknown): ImageLayerColorDetail {
  const raw = object(value, ['version', 'enabled', 'sharpening', 'luminance', 'color'])
  if (raw.version !== 1) throw new Error('细节与降噪版本不支持，请更新页面后重试')
  if (typeof raw.enabled !== 'boolean') throw new Error('细节与降噪开关格式不正确')
  const sharpening = object(raw.sharpening, ['amount', 'radius', 'detail', 'masking']), luminance = object(raw.luminance, ['amount', 'detail', 'contrast']), color = object(raw.color, ['amount', 'detail', 'smoothness'])
  return { version: 1, enabled: raw.enabled,
    sharpening: { amount: number(sharpening.amount, 0, 150), radius: number(sharpening.radius, .5, 3), detail: number(sharpening.detail, 0, 100), masking: number(sharpening.masking, 0, 100) },
    luminance: { amount: number(luminance.amount, 0, 100), detail: number(luminance.detail, 0, 100), contrast: number(luminance.contrast, 0, 100) },
    color: { amount: number(color.amount, 0, 100), detail: number(color.detail, 0, 100), smoothness: number(color.smoothness, 0, 100) } }
}

/** Dormant controls remain editable; neutrality only describes rendered pixels. */
export function isNeutralImageLayerColorDetail(value: ImageLayerColorDetail): boolean {
  return !value.enabled || value.sharpening.amount === 0 && value.luminance.amount === 0 && value.color.amount === 0
}
