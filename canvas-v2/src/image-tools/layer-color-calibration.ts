export interface ImageLayerColorCalibration {
  version: 1
  enabled: boolean
  shadowTint: number
  redHue: number
  redSaturation: number
  greenHue: number
  greenSaturation: number
  blueHue: number
  blueSaturation: number
}

export const imageLayerColorCalibrationAmounts = ['shadowTint', 'redHue', 'redSaturation', 'greenHue', 'greenSaturation', 'blueHue', 'blueSaturation'] as const

export function defaultImageLayerColorCalibration(): ImageLayerColorCalibration {
  return { version: 1, enabled: true, shadowTint: 0, redHue: 0, redSaturation: 0, greenHue: 0, greenSaturation: 0, blueHue: 0, blueSaturation: 0 }
}

export function parseImageLayerColorCalibration(value: unknown): ImageLayerColorCalibration {
  const keys = ['version', 'enabled', ...imageLayerColorCalibrationAmounts]
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('原色校准配置含未知字段或缺少必要参数')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) throw new Error('原色校准版本不支持，请更新页面后重试')
  if (typeof raw.enabled !== 'boolean') throw new Error('原色校准开关格式不正确')
  const result = defaultImageLayerColorCalibration()
  result.enabled = raw.enabled
  for (const key of imageLayerColorCalibrationAmounts) {
    const amount = raw[key]
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < -100 || amount > 100) throw new Error('原色校准参数超出支持范围')
    result[key] = Object.is(amount, -0) ? 0 : amount
  }
  return result
}

/** Pixel neutrality never discards an explicitly saved, editable configuration. */
export function isNeutralImageLayerColorCalibration(value: ImageLayerColorCalibration): boolean {
  return !value.enabled || imageLayerColorCalibrationAmounts.every((key) => value[key] === 0)
}
