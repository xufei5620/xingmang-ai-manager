export interface ImageLayerColorPresence {
  version: 1
  enabled: boolean
  texture: number
  clarity: number
  dehaze: number
}

export function defaultImageLayerColorPresence(): ImageLayerColorPresence {
  return { version: 1, enabled: true, texture: 0, clarity: 0, dehaze: 0 }
}

export function parseImageLayerColorPresence(value: unknown): ImageLayerColorPresence {
  const keys = ['version', 'enabled', 'texture', 'clarity', 'dehaze']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('质感与去雾配置含未知字段或缺少必要参数')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) throw new Error('质感与去雾版本不支持，请更新页面后重试')
  if (typeof raw.enabled !== 'boolean') throw new Error('质感与去雾开关格式不正确')
  function amount(key: string): number {
    const number = raw[key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < -100 || number > 100) throw new Error('质感与去雾参数超出支持范围')
    return Object.is(number, -0) ? 0 : number
  }
  return { version: 1, enabled: raw.enabled, texture: amount('texture'), clarity: amount('clarity'), dehaze: amount('dehaze') }
}

/** Dormant amounts remain persisted and editable. */
export function isNeutralImageLayerColorPresence(value: ImageLayerColorPresence): boolean {
  return !value.enabled || value.texture === 0 && value.clarity === 0 && value.dehaze === 0
}
