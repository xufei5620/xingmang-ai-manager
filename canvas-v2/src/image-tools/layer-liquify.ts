/** Ordered layer-local deformations. No asset identity or executable content is
 * carried by a liquify operation; later drawing remains later in the edit log. */
export const layerLiquifyLimits = { strokes: 64, pointsPerStroke: 256, radiusMin: 1, radiusMax: 512, strengthMin: 0, strengthMax: 1, spaceEdge: 16384, pointScale: 10000 } as const
export type ImageLayerLiquifyTool = 'push' | 'bulge' | 'pinch' | 'twirl-cw' | 'twirl-ccw'
export interface ImageLayerLiquifyStroke {
  tool: ImageLayerLiquifyTool
  radius: number
  strength: number
  points: Array<[number, number]>
}
export interface ImageLayerLiquifyOperation {
  mode: 'liquify'
  version: 1
  space: { width: number; height: number }
  strokes: ImageLayerLiquifyStroke[]
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('液化参数包含无效或不支持的字段')
  return value as Record<string, unknown>
}
function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value)) throw new Error(`${label}必须在 ${min}–${max} 范围内${integer ? '且为整数' : ''}`)
  return value === 0 ? 0 : value
}
export function parseImageLayerLiquifyOperation(value: unknown): ImageLayerLiquifyOperation {
  const input = record(value, ['mode', 'version', 'space', 'strokes']), space = record(input.space, ['width', 'height'])
  if (input.mode !== 'liquify' || input.version !== 1) throw new Error('液化操作版本不支持，请更新页面；原操作没有更改')
  if (!Array.isArray(input.strokes) || !input.strokes.length || input.strokes.length > layerLiquifyLimits.strokes) throw new Error('每次液化需要 1–64 笔，请分次应用')
  const strokes = input.strokes.map((value): ImageLayerLiquifyStroke => {
    const stroke = record(value, ['tool', 'radius', 'strength', 'points'])
    if (typeof stroke.tool !== 'string' || !['push', 'bulge', 'pinch', 'twirl-cw', 'twirl-ccw'].includes(stroke.tool)) throw new Error('液化工具类型不支持')
    if (!Array.isArray(stroke.points) || stroke.points.length < (stroke.tool === 'push' ? 2 : 1) || stroke.points.length > layerLiquifyLimits.pointsPerStroke) throw new Error('液化路径需要有效坐标且每笔不超过 256 个点；推移至少需要两个点')
    return { tool: stroke.tool as ImageLayerLiquifyTool, radius: number(stroke.radius, '液化半径', 1, 512), strength: number(stroke.strength, '液化强度', 0, 1), points: stroke.points.map((value): [number, number] => {
      if (!Array.isArray(value) || value.length !== 2) throw new Error('液化坐标无效')
      return [number(value[0], '液化横坐标', 0, 10000, true), number(value[1], '液化纵坐标', 0, 10000, true)]
    }) }
  })
  return { mode: 'liquify', version: 1, space: { width: number(space.width, '液化参考宽度', 1, 16384), height: number(space.height, '液化参考高度', 1, 16384) }, strokes }
}
