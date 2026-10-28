import { defaultImageLayerColorGrade, parseImageLayerColorGrade, type ImageLayerColorCurvePoint, type ImageLayerColorGrade } from './layer-color-grade'

export type ColorGradeSection = 'light' | 'color' | 'curves' | 'hsl' | 'colorGrading' | 'effects' | 'lut' | 'detail' | 'calibration'
export const colorGradeSections: readonly { key: ColorGradeSection; label: string }[] = [{ key: 'light', label: '光影' }, { key: 'color', label: '颜色' }, { key: 'curves', label: '曲线' }, { key: 'hsl', label: '色彩混合' }, { key: 'colorGrading', label: '色彩分级' }, { key: 'effects', label: '效果' }, { key: 'lut', label: 'LUT 调色' }, { key: 'detail', label: '细节与降噪' }, { key: 'calibration', label: '校准' }]
const sectionKeys: Record<ColorGradeSection, readonly (keyof ImageLayerColorGrade)[]> = {
  light: ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'], color: ['temperature', 'tint', 'vibrance', 'saturation', 'blackWhite'], curves: ['curves'], hsl: ['hsl'], colorGrading: ['colorGrading'], effects: ['vignette', 'grain', 'presence'], lut: ['lut'], detail: ['detail'], calibration: ['calibration'],
}
export function resetColorGradeSection(grade: ImageLayerColorGrade, section: ColorGradeSection): ImageLayerColorGrade {
  const defaults = defaultImageLayerColorGrade()
  const next = { ...grade, ...Object.fromEntries(sectionKeys[section].map((key) => [key, defaults[key]])) }
  if (section === 'detail') delete next.detail
  if (section === 'lut') delete next.lut
  if (section === 'effects') delete next.presence
  if (section === 'calibration') delete next.calibration
  return parseImageLayerColorGrade(next)
}
export function previewColorGrade(grade: ImageLayerColorGrade, hidden: readonly ColorGradeSection[], before: boolean): ImageLayerColorGrade {
  return before ? defaultImageLayerColorGrade() : hidden.reduce(resetColorGradeSection, grade)
}
function boundedPoint(value: number): number { return Math.round(Math.max(0, Math.min(1, value)) * 10000) / 10000 }
export function moveColorCurvePoint(points: readonly ImageLayerColorCurvePoint[], index: number, point: ImageLayerColorCurvePoint): ImageLayerColorCurvePoint[] {
  if (!points[index] || ![point.x, point.y].every(Number.isFinite)) return [...points]
  const gap = index > 0 && index < points.length - 1 ? Math.min(.0001, (points[index + 1].x - points[index - 1].x) / 3) : 0
  const x = index === 0 ? 0 : index === points.length - 1 ? 1 : Math.max(points[index - 1].x + gap, Math.min(points[index + 1].x - gap, boundedPoint(point.x)))
  return points.map((value, at) => at === index ? { x, y: boundedPoint(point.y) } : value)
}
export function addColorCurvePoint(points: readonly ImageLayerColorCurvePoint[], point: ImageLayerColorCurvePoint): { points: ImageLayerColorCurvePoint[]; index: number } {
  if (![point.x, point.y].every(Number.isFinite)) throw new Error('曲线坐标无效')
  const value = { x: boundedPoint(point.x), y: boundedPoint(point.y) }
  const existing = points.findIndex((entry) => Math.abs(entry.x - value.x) < .0001)
  if (existing >= 0) return { points: [...points], index: existing }
  if (points.length >= 16) throw new Error('每条曲线最多 16 个点，请先删除一个中间点')
  const next = [...points, value].sort((a, b) => a.x - b.x)
  return { points: next, index: next.indexOf(value) }
}
export function removeColorCurvePoint(points: readonly ImageLayerColorCurvePoint[], index: number): ImageLayerColorCurvePoint[] {
  return index <= 0 || index >= points.length - 1 ? [...points] : points.filter((_, at) => at !== index)
}

export const maximumColorGradePresetBytes = 64 * 1024
export function serializeColorGradePreset(name: string, value: unknown): string {
  const title = name.trim()
  if (!title || title.length > 80 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('预设名称需要 1–80 个字符，不含控制字符')
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'calibration')) throw new Error('版本 1 预设不能携带校准，请使用版本 5 完整 JSON 预设导出')
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'lut')) throw new Error('版本 1 预设不能携带 LUT，请使用完整 JSON 预设导出')
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'detail')) throw new Error('版本 1 预设不能携带细节与降噪，请使用完整 JSON 预设导出')
  if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, 'presence')) throw new Error('版本 1 预设不能携带质感与去雾，请使用版本 4 完整 JSON 预设导出')
  return JSON.stringify({ format: 'xingmang-layer-color-grade', version: 1, name: title, settings: parseImageLayerColorGrade(value) }, null, 2)
}
export function parseColorGradePreset(text: string): { name: string; settings: ImageLayerColorGrade } {
  if (new TextEncoder().encode(text).length > maximumColorGradePresetBytes) throw new Error('调整预设不能超过 64 KiB')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('预设不是有效的 JSON 文件') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请选择星芒图像调整预设')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !['format', 'version', 'name', 'settings'].includes(key)) || record.format !== 'xingmang-layer-color-grade' || record.version !== 1 || typeof record.name !== 'string') throw new Error('此预设格式或版本不受支持，当前调整未改变')
  serializeColorGradePreset(record.name, record.settings)
  return { name: record.name.trim(), settings: parseImageLayerColorGrade(record.settings) }
}

export interface ColorGradeHistogram { red: number[]; green: number[]; blue: number[]; luminance: number[]; pixels: number }
export interface ColorGradeSample { data: Uint8ClampedArray; width: number; height: number; spaceWidth: number; spaceHeight: number; stepX: number; stepY: number }
export function sampleColorGradePixels(input: { data: Uint8ClampedArray; width: number; height: number }): ColorGradeSample {
  if (![input.width, input.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 4096) || input.data.length !== input.width * input.height * 4) throw new Error('直方图像素尺寸无效')
  const scale = Math.min(1, 256 / Math.max(input.width, input.height)), width = Math.max(1, Math.round(input.width * scale)), height = Math.max(1, Math.round(input.height * scale)), stepX = input.width / width, stepY = input.height / height, data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const from = (Math.floor(y * stepY) * input.width + Math.floor(x * stepX)) * 4; data.set(input.data.subarray(from, from + 4), (y * width + x) * 4) }
  return { data, width, height, spaceWidth: input.width, spaceHeight: input.height, stepX, stepY }
}
export function buildColorGradeHistogram(data: Uint8ClampedArray): ColorGradeHistogram {
  if (data.length % 4) throw new Error('直方图像素格式无效')
  const result: ColorGradeHistogram = { red: Array(64).fill(0), green: Array(64).fill(0), blue: Array(64).fill(0), luminance: Array(64).fill(0), pixels: 0 }
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] === 0) continue
    const weight = data[index + 3] / 255
    result.red[data[index] >> 2] += weight; result.green[data[index + 1] >> 2] += weight; result.blue[data[index + 2] >> 2] += weight
    result.luminance[Math.min(63, Math.floor((data[index] * .2126 + data[index + 1] * .7152 + data[index + 2] * .0722) / 4))] += weight
    result.pixels++
  }
  return result
}
