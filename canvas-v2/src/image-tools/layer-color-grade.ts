import { colorLutSelectionIsActive, parseColorLutSelection, type ColorLutSelection } from './layer-color-lut-selection'
import { isNeutralImageLayerColorDetail, parseImageLayerColorDetail, type ImageLayerColorDetail } from './layer-color-detail'
import { isNeutralImageLayerColorPresence, parseImageLayerColorPresence, type ImageLayerColorPresence } from './layer-color-presence'
import { isNeutralImageLayerColorCalibration, parseImageLayerColorCalibration, type ImageLayerColorCalibration } from './layer-color-calibration'

export interface ImageLayerColorCurvePoint { x: number; y: number }
export interface ImageLayerHslChannel { hue: number; saturation: number; luminance: number }
export interface ImageLayerColorGradingTone { hue: number; saturation: number; luminance: number }
export const imageLayerHslChannels = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
export interface ImageLayerColorGrade {
  version: 1
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  vibrance: number
  saturation: number
  blackWhite: boolean
  lut?: ColorLutSelection
  detail?: ImageLayerColorDetail
  presence?: ImageLayerColorPresence
  calibration?: ImageLayerColorCalibration
  curves: Record<'rgb' | 'red' | 'green' | 'blue', ImageLayerColorCurvePoint[]>
  hsl: Record<typeof imageLayerHslChannels[number], ImageLayerHslChannel>
  vignette: number
  grain: number
  colorGrading: {
    shadows: ImageLayerColorGradingTone
    midtones: ImageLayerColorGradingTone
    highlights: ImageLayerColorGradingTone
    blending: number
    balance: number
  }
}

export function defaultImageLayerColorGrade(): ImageLayerColorGrade {
  const identity = () => [{ x: 0, y: 0 }, { x: 1, y: 1 }]
  const tone = () => ({ hue: 0, saturation: 0, luminance: 0 })
  return { version: 1, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 5500, tint: 0, vibrance: 0, saturation: 0, blackWhite: false,
    curves: { rgb: identity(), red: identity(), green: identity(), blue: identity() },
    hsl: { red: tone(), orange: tone(), yellow: tone(), green: tone(), aqua: tone(), blue: tone(), purple: tone(), magenta: tone() },
    vignette: 0, grain: 0, colorGrading: { shadows: tone(), midtones: tone(), highlights: tone(), blending: 50, balance: 0 } }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('图像调整包含不支持的字段或格式')
  return value as Record<string, unknown>
}

function number(value: unknown, fallback: number, low: number, high: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < low || value > high) throw new Error('图像调整参数超出支持范围')
  return value
}

function curve(value: unknown, fallback: ImageLayerColorCurvePoint[]): ImageLayerColorCurvePoint[] {
  if (value === undefined) return fallback
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) throw new Error('每条颜色曲线需要 2–16 个控制点')
  const points = value.map((entry) => {
    const point = record(entry, ['x', 'y'])
    if (point.x === undefined || point.y === undefined) throw new Error('颜色曲线控制点缺少坐标')
    return { x: number(point.x, 0, 0, 1), y: number(point.y, 0, 0, 1) }
  })
  if (points[0].x !== 0 || points.at(-1)!.x !== 1 || points.some((point, index) => index > 0 && point.x <= points[index - 1].x)) throw new Error('颜色曲线横坐标必须严格递增，起止位置必须为 0 和 1')
  return points
}

export function parseImageLayerColorGrade(value: unknown): ImageLayerColorGrade {
  const result = defaultImageLayerColorGrade()
  const raw = record(value, [...Object.keys(result), 'lut', 'detail', 'presence', 'calibration'])
  if (raw.version !== 1) throw new Error('图像调整版本不支持，请更新页面后重试')
  for (const key of ['contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation', 'vignette'] as const) result[key] = number(raw[key], 0, -100, 100)
  result.exposure = number(raw.exposure, 0, -4, 4)
  result.temperature = number(raw.temperature, 5500, 2000, 10000)
  result.tint = number(raw.tint, 0, -150, 150)
  result.grain = number(raw.grain, 0, 0, 100)
  if (raw.blackWhite !== undefined && typeof raw.blackWhite !== 'boolean') throw new Error('黑白调整开关格式不正确')
  result.blackWhite = raw.blackWhite === true
  if (raw.lut !== undefined) result.lut = parseColorLutSelection(raw.lut)
  if (Object.hasOwn(raw, 'detail')) result.detail = parseImageLayerColorDetail(raw.detail)
  if (Object.hasOwn(raw, 'presence')) result.presence = parseImageLayerColorPresence(raw.presence)
  if (Object.hasOwn(raw, 'calibration')) result.calibration = parseImageLayerColorCalibration(raw.calibration)
  if (raw.curves !== undefined) {
    const curves = record(raw.curves, ['rgb', 'red', 'green', 'blue'])
    for (const key of ['rgb', 'red', 'green', 'blue'] as const) result.curves[key] = curve(curves[key], result.curves[key])
  }
  if (raw.hsl !== undefined) {
    const hsl = record(raw.hsl, imageLayerHslChannels)
    for (const key of imageLayerHslChannels) if (hsl[key] !== undefined) {
      const channel = record(hsl[key], ['hue', 'saturation', 'luminance'])
      result.hsl[key] = { hue: number(channel.hue, 0, -100, 100), saturation: number(channel.saturation, 0, -100, 100), luminance: number(channel.luminance, 0, -100, 100) }
    }
  }
  if (raw.colorGrading !== undefined) {
    const grading = record(raw.colorGrading, ['shadows', 'midtones', 'highlights', 'blending', 'balance'])
    result.colorGrading.blending = number(grading.blending, 50, 0, 100)
    result.colorGrading.balance = number(grading.balance, 0, -100, 100)
    for (const key of ['shadows', 'midtones', 'highlights'] as const) if (grading[key] !== undefined) {
      const tone = record(grading[key], ['hue', 'saturation', 'luminance'])
      result.colorGrading[key] = { hue: number(tone.hue, 0, 0, 360), saturation: number(tone.saturation, 0, 0, 100), luminance: number(tone.luminance, 0, -100, 100) }
    }
  }
  return result
}

export function isNeutralImageLayerColorGrade(value: ImageLayerColorGrade): boolean {
  const neutral = defaultImageLayerColorGrade()
  return (['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'temperature', 'tint', 'vibrance', 'saturation', 'blackWhite', 'vignette', 'grain'] as const).every((key) => value[key] === neutral[key])
    && !colorLutSelectionIsActive(value.lut)
    && (!value.detail || isNeutralImageLayerColorDetail(value.detail))
    && (!value.presence || isNeutralImageLayerColorPresence(value.presence))
    && (!value.calibration || isNeutralImageLayerColorCalibration(value.calibration))
    && Object.values(value.curves).every((points) => points.every((point) => point.x === point.y))
    && Object.values(value.hsl).every((channel) => !channel.hue && !channel.saturation && !channel.luminance)
    && [value.colorGrading.shadows, value.colorGrading.midtones, value.colorGrading.highlights].every((tone) => !tone.saturation && !tone.luminance)
}
