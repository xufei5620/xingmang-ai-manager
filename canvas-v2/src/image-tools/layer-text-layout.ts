import type { ImageLayerTextContent } from './recipe'
import { isSafeLocalTextFontFamily, quoteLocalTextFontFamily } from './local-font-family'

export const imageLayerTextWarpStyles = [
  { id: 'arc', label: '弧形' }, { id: 'arch', label: '拱形' }, { id: 'bulge', label: '凸起' },
  { id: 'wave', label: '波浪' }, { id: 'arc-lower', label: '下弧' }, { id: 'arc-upper', label: '上弧' },
  { id: 'shell', label: '贝壳' }, { id: 'flag', label: '旗帜' }, { id: 'rise', label: '上升' },
  { id: 'fisheye', label: '鱼眼' }, { id: 'inflate', label: '膨胀' }, { id: 'squeeze', label: '挤压' }, { id: 'twist', label: '扭曲' },
] as const
export type ImageLayerTextWarpStyle = typeof imageLayerTextWarpStyles[number]['id']
export type ImageLayerTextWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900
export interface ImageLayerTypography {
  version: 1
  fontFamily?: string
  fontSource?: 'local'
  fontWeight?: ImageLayerTextWeight
  lineHeight: number
  letterSpacing: number
  warp?: { style: ImageLayerTextWarpStyle; bend: number }
}
export const imageLayerTextRasterLimits = { edge: 4096, pixels: 4_194_304, tileRows: 32 } as const

export function defaultImageLayerTypography(): ImageLayerTypography { return { version: 1, lineHeight: 1.2, letterSpacing: 0 } }

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error('文字排版参数包含不支持的字段')
  return value as Record<string, unknown>
}
function finite(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}必须在 ${min}–${max} 范围内`)
  return Object.is(value, -0) ? 0 : value
}
export function parseImageLayerTypography(value: unknown): ImageLayerTypography {
  const raw = record(value, ['version', 'fontFamily', 'fontSource', 'fontWeight', 'lineHeight', 'letterSpacing', 'warp'])
  if (raw.version !== 1) throw new Error('文字排版版本不受支持')
  const result: ImageLayerTypography = { version: 1, lineHeight: finite(raw.lineHeight, '文字行高', .5, 3), letterSpacing: finite(raw.letterSpacing, '文字字距', -20, 100) }
  if (raw.fontFamily !== undefined || raw.fontSource !== undefined) {
    if (raw.fontSource !== 'local' || !isSafeLocalTextFontFamily(raw.fontFamily)) throw new Error('本机字体名称无效，请重新选择已授权字体')
    result.fontFamily = raw.fontFamily; result.fontSource = 'local'
  }
  if (raw.fontWeight !== undefined) {
    const weight = finite(raw.fontWeight, '文字字重', 100, 900)
    if (weight % 100 !== 0) throw new Error('文字字重必须是 100 的整数倍')
    result.fontWeight = weight as ImageLayerTextWeight
  }
  if (raw.warp !== undefined) {
    const warp = record(raw.warp, ['style', 'bend'])
    if (!imageLayerTextWarpStyles.some(({ id }) => id === warp.style)) throw new Error('文字变形方式不受支持')
    result.warp = { style: warp.style as ImageLayerTextWarpStyle, bend: finite(warp.bend, '文字弯曲度', -100, 100) }
  }
  return result
}

export function imageLayerTextFont(content: ImageLayerTextContent): string {
  const typography = content.typography && parseImageLayerTypography(content.typography)
  return `${typography?.fontWeight ?? content.fontWeight} ${content.fontSize}px ${typography?.fontFamily ? quoteLocalTextFontFamily(typography.fontFamily) : content.fontFamily}`
}

/** Keep complete shaping runs, including combining marks, emoji and ligatures.
 * Letter spacing is applied by the browser's text shaper, never UTF-16 slicing.
 */
export function imageLayerTextLines(content: ImageLayerTextContent, height: number): Array<{ text: string; baseline: number }> {
  const step = content.fontSize * (content.typography?.lineHeight ?? 1.2)
  return content.text.split(/\r\n?|\n/).flatMap((text, index) => index * step < height ? [{ text, baseline: content.fontSize + index * step }] : [])
}

/** Inverse, normalized output-to-source maps. Outside samples are transparent;
 * all modes keep the declared layer rectangle and leave zero bend unchanged.
 * These are explicit local deformation formulas, not a PSD warp interpreter.
 */
export function imageLayerTextWarpPoint(style: ImageLayerTextWarpStyle, bend: number, x: number, y: number): { x: number; y: number } {
  if (!bend) return { x, y }
  const amount = bend / 100, horizontal = 1 - x * x, vertical = 1 - y * y
  switch (style) {
    case 'arc': return { x: x / (1 + .15 * amount * y), y: y + .5 * amount * horizontal }
    case 'arch': return { x, y: y + .6 * amount * horizontal }
    case 'bulge': return { x: x / (1 + .4 * amount * vertical), y: y / (1 + .4 * amount * horizontal) }
    case 'wave': return { x, y: y + .28 * amount * Math.sin(Math.PI * x) }
    case 'arc-lower': return { x, y: y + .5 * amount * horizontal * (1 + y) / 2 }
    case 'arc-upper': return { x, y: y + .5 * amount * horizontal * (1 - y) / 2 }
    case 'shell': return { x: x / (1 + .3 * amount * (y + 1) / 2), y: y + .45 * amount * horizontal * (y + 1) / 2 }
    case 'flag': return { x, y: y + .3 * amount * Math.sin(Math.PI * (x + .5)) * (.75 + .25 * x) }
    case 'rise': return { x, y: y - .45 * amount * x }
    case 'fisheye': { const scale = 1 - .45 * amount * (1 - Math.min(1, x * x + y * y)); return { x: x * scale, y: y * scale } }
    case 'inflate': return { x: x * (1 - .3 * amount * vertical), y: y * (1 - .55 * amount * horizontal) }
    case 'squeeze': return { x: x * (1 + .6 * amount * vertical), y: y * (1 - .2 * amount * horizontal) }
    case 'twist': { const angle = -.85 * amount * (1 - Math.min(1, x * x + y * y)), cosine = Math.cos(angle), sine = Math.sin(angle); return { x: cosine * x - sine * y, y: sine * x + cosine * y } }
  }
}

export function assertImageLayerTextRasterSize(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > imageLayerTextRasterLimits.edge || height > imageLayerTextRasterLimits.edge || width * height > imageLayerTextRasterLimits.pixels) throw new Error('变形文字图层最多支持 4096 像素边长、约 419 万像素，请缩小文字图层尺寸')
}

export interface ImageLayerTextWarpTile { top: number; height: number; data: Uint8ClampedArray }
export function* rasterizeImageLayerTextWarpSteps(source: Uint8ClampedArray, width: number, height: number, warp: NonNullable<ImageLayerTypography['warp']>, options: { signal?: AbortSignal; deadline?: number } = {}): Generator<ImageLayerTextWarpTile> {
  assertImageLayerTextRasterSize(width, height)
  parseImageLayerTypography({ ...defaultImageLayerTypography(), warp })
  if (!(source instanceof Uint8ClampedArray) || source.length !== width * height * 4) throw new Error('文字变形像素格式不正确')
  function check() {
    if (options.signal?.aborted) { const error = new Error('已取消文字变形，当前画布没有改变'); error.name = 'AbortError'; throw error }
    if (options.deadline !== undefined && Date.now() >= options.deadline) throw new Error('文字变形处理超时，请缩小文字图层')
  }
  check()
  for (let top = 0; top < height; top += imageLayerTextRasterLimits.tileRows) {
    const rows = Math.min(imageLayerTextRasterLimits.tileRows, height - top), data = new Uint8ClampedArray(width * rows * 4)
    if (!warp.bend) data.set(source.subarray(top * width * 4, (top + rows) * width * 4))
    else for (let row = 0; row < rows; row++) {
      check()
      const y = (top + row + .5) / height * 2 - 1
      for (let column = 0; column < width; column++) {
        const mapped = imageLayerTextWarpPoint(warp.style, warp.bend, (column + .5) / width * 2 - 1, y)
        const sx = (mapped.x + 1) / 2 * width - .5, sy = (mapped.y + 1) / 2 * height - .5
        const x0 = Math.floor(sx), y0 = Math.floor(sy), dx = sx - x0, dy = sy - y0
        let alpha = 0, red = 0, green = 0, blue = 0
        for (let yy = 0; yy < 2; yy++) for (let xx = 0; xx < 2; xx++) {
          const x = x0 + xx, y = y0 + yy
          if (x < 0 || y < 0 || x >= width || y >= height) continue
          const input = (y * width + x) * 4, weight = (xx ? dx : 1 - dx) * (yy ? dy : 1 - dy), coverage = source[input + 3] * weight
          alpha += coverage; red += source[input] * coverage; green += source[input + 1] * coverage; blue += source[input + 2] * coverage
        }
        const output = (row * width + column) * 4
        if (alpha > 0) { data[output] = red / alpha; data[output + 1] = green / alpha; data[output + 2] = blue / alpha; data[output + 3] = alpha }
      }
    }
    check()
    yield { top, height: rows, data }
  }
}
