import type { ImageLayerRecipe } from './recipe'

export type WholeLayerFilterType = 'gaussian' | 'usm' | 'median' | 'mosaic' | 'noise' | 'sharpen' | 'box-blur' | 'emboss' | 'edges' | 'smart-sharpen' | 'twirl' | 'pinch' | 'spherize' | 'wave' | 'iris-blur' | 'tilt-shift' | 'lens-correction'
export interface WholeLayerFilterParameter { key: string; label: string; min: number; max: number; step: number; default: number; unit?: string }
export interface WholeLayerFilterDefinition { type: WholeLayerFilterType; label: string; description: string; parameters: readonly WholeLayerFilterParameter[] }
export interface ImageLayerWholeFilter { type: WholeLayerFilterType; parameters: Record<string, number> }
export interface ImageLayerWholeFilterOperation { mode: 'whole-filter'; version: 1; filter: ImageLayerWholeFilter; space: { width: number; height: number } }
export const wholeLayerFilterLimits = { edge: 4096, pixels: 16_777_216, tileRows: 8 } as const

function parameter(key: string, label: string, min: number, max: number, step: number, initial: number, unit?: string): WholeLayerFilterParameter { return { key, label, min, max, step, default: initial, ...(unit ? { unit } : {}) } }

/** Explicit product safety ranges. Reference observations establish labels,
 * defaults and visible track endpoints, not undocumented internal bounds. */
export const wholeLayerFilterDefinitions: readonly WholeLayerFilterDefinition[] = [
  { type: 'gaussian', label: '高斯模糊', description: '分离高斯卷积，颜色与透明度一起模糊。', parameters: [parameter('radius', '半径', 0, 80, .1, 4, 'px')] },
  { type: 'usm', label: '锐化（USM）', description: '原图加上高频细节，阈值保护平坦区域。', parameters: [parameter('amount', '数量', 0, 500, 1, 100, '%'), parameter('radius', '半径', .1, 20, .1, 1, 'px'), parameter('threshold', '阈值', 0, 255, 1, 0)] },
  { type: 'median', label: '中值', description: '取邻域中值，保留边界并减少孤立噪点。', parameters: [parameter('radius', '半径', 1, 10, 1, 2, 'px')] },
  { type: 'mosaic', label: '马赛克', description: '以图层左上角为网格原点，块内取平均颜色。', parameters: [parameter('size', '块大小', 2, 64, 1, 8, 'px')] },
  { type: 'noise', label: '添加杂色', description: '确定性均匀噪点；相同配方总是得到相同结果。', parameters: [parameter('amount', '数量', 0, 100, 1, 12)] },
  { type: 'sharpen', label: '基础锐化', description: '3×3 锐化卷积；没有半径或阈值参数。', parameters: [] },
  { type: 'box-blur', label: '方框模糊', description: '重复执行 3×3 均值卷积。', parameters: [parameter('iterations', '迭代次数', 1, 8, 1, 1)] },
  { type: 'emboss', label: '浮雕', description: '方向卷积加中性灰偏移，形成浮凸效果。', parameters: [parameter('bias', '中性灰偏移', 0, 255, 1, 128)] },
  { type: 'edges', label: '查找边缘', description: '3×3 拉普拉斯卷积，亮处表示边缘。', parameters: [] },
  { type: 'smart-sharpen', label: '智能锐化', description: 'USM 加阴影、高光淡化，减少过度锐化。', parameters: [parameter('amount', '数量', 0, 500, 1, 150, '%'), parameter('radius', '半径', .1, 20, .1, 1, 'px'), parameter('shadowFade', '阴影淡化', 0, 1, .01, 0), parameter('highlightFade', '高光淡化', 0, 1, .01, 0)] },
  { type: 'twirl', label: '旋转扭曲', description: '围绕图层中心扭曲，半径外保持原样。', parameters: [parameter('angle', '角度', -360, 360, 1, 90, '°'), parameter('radius', '半径', 5, 100, 1, 80, '%')] },
  { type: 'pinch', label: '收缩/挤压', description: '正值向中心收缩，负值向外凸出。', parameters: [parameter('strength', '强度', -1, 1, .01, .5), parameter('radius', '半径', 5, 100, 1, 80, '%')] },
  { type: 'spherize', label: '球面化', description: '正值凸起，负值凹陷的球面投影。', parameters: [parameter('amount', '量', -1, 1, .01, .5), parameter('radius', '半径', 5, 100, 1, 80, '%')] },
  { type: 'wave', label: '波浪', description: '按纵向周期对图层像素作横向正弦位移。', parameters: [parameter('amplitude', '振幅', 0, 128, 1, 10, 'px'), parameter('wavelength', '波长', 2, 1024, 1, 64, 'px')] },
  { type: 'iris-blur', label: '光圈模糊', description: '中心椭圆清晰，外圈渐变模糊。', parameters: [parameter('centerX', '中心 X', 0, 100, 1, 50, '%'), parameter('centerY', '中心 Y', 0, 100, 1, 50, '%'), parameter('radiusX', '椭圆半径 X', 1, 100, 1, 30, '%'), parameter('radiusY', '椭圆半径 Y', 1, 100, 1, 30, '%'), parameter('feather', '羽化', 0, 100, 1, 20, '%'), parameter('radius', '模糊半径', 0, 80, .1, 12, 'px')] },
  { type: 'tilt-shift', label: '移轴模糊', description: '水平条带清晰，上下渐变模糊。', parameters: [parameter('centerY', '中心 Y', 0, 100, 1, 50, '%'), parameter('band', '清晰半带', 0, 100, 1, 15, '%'), parameter('feather', '羽化', 0, 100, 1, 20, '%'), parameter('radius', '模糊半径', 0, 80, .1, 16, 'px')] },
  { type: 'lens-correction', label: '镜头校正', description: '径向桶形、枕形畸变及暗角增益。', parameters: [parameter('k1', '畸变 k1', -.5, .5, .01, 0), parameter('vignette', '暗角强度', 0, 1, .01, 0), parameter('falloff', '暗角衰减', .2, 4, .1, 1)] },
]

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('整层滤镜参数格式无效或包含不支持的字段')
  return value as Record<string, unknown>
}

export function defaultWholeLayerFilter(type: WholeLayerFilterType): ImageLayerWholeFilter {
  const definition = wholeLayerFilterDefinitions.find((item) => item.type === type)
  if (!definition) throw new Error('此整层滤镜类型不受支持')
  return { type, parameters: Object.fromEntries(definition.parameters.map((entry) => [entry.key, entry.default])) }
}

export function parseWholeLayerFilter(value: unknown): ImageLayerWholeFilter {
  const input = object(value, ['type', 'parameters'])
  const definition = wholeLayerFilterDefinitions.find((item) => item.type === input.type)
  if (!definition) throw new Error('此整层滤镜类型不受支持')
  const raw = object(input.parameters, definition.parameters.map((entry) => entry.key)), parameters: Record<string, number> = {}
  for (const entry of definition.parameters) {
    const number = raw[entry.key]
    if (typeof number !== 'number' || !Number.isFinite(number) || number < entry.min || number > entry.max || entry.step === 1 && !Number.isInteger(number)) throw new Error(`${entry.label}必须在 ${entry.min}–${entry.max} 范围内${entry.step === 1 ? '且为整数' : ''}`)
    parameters[entry.key] = Object.is(number, -0) ? 0 : number
  }
  return { type: definition.type, parameters }
}

export function assertWholeLayerFilterSize(width: number, height: number): void {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= wholeLayerFilterLimits.edge) || width * height > wholeLayerFilterLimits.pixels) throw new Error('整层滤镜最多支持 4096 × 4096 原生图层像素，请先缩小当前图层')
}

export function parseImageLayerWholeFilterOperation(value: unknown): ImageLayerWholeFilterOperation {
  const input = object(value, ['mode', 'version', 'filter', 'space'])
  if (input.mode !== 'whole-filter' || input.version !== 1) throw new Error('整层滤镜版本不受支持，请更新页面后重试')
  const space = object(input.space, ['width', 'height'])
  const width = Number(space.width), height = Number(space.height)
  if (typeof space.width !== 'number' || typeof space.height !== 'number') throw new Error('整层滤镜参考空间无效')
  assertWholeLayerFilterSize(width, height)
  return { mode: 'whole-filter', version: 1, filter: parseWholeLayerFilter(input.filter), space: { width, height } }
}

export function layerWholeFilterSpace(recipe: ImageLayerRecipe, index: number): { width: number; height: number } {
  const layer = recipe.layers[index]
  if (!layer) throw new Error('请先选择需要处理的图层')
  const width = Math.max(1, Math.round(layer.width * recipe.outputWidth)), height = Math.max(1, Math.round(layer.height * recipe.outputHeight))
  assertWholeLayerFilterSize(width, height)
  return { width, height }
}

export function isNeutralWholeLayerFilter(filter: ImageLayerWholeFilter): boolean {
  const { type, parameters: p } = parseWholeLayerFilter(filter)
  if (type === 'gaussian' || type === 'iris-blur' || type === 'tilt-shift') return p.radius === 0
  if (type === 'usm' || type === 'smart-sharpen' || type === 'noise' || type === 'spherize') return p.amount === 0
  if (type === 'twirl') return p.angle === 0
  if (type === 'pinch') return p.strength === 0
  if (type === 'wave') return p.amplitude === 0
  if (type === 'lens-correction') return p.k1 === 0 && p.vignette === 0
  return false
}
