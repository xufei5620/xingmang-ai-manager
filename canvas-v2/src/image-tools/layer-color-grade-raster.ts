import { isNeutralImageLayerColorGrade, parseImageLayerColorGrade, imageLayerHslChannels, type ImageLayerColorGrade, type ImageLayerColorCurvePoint } from './layer-color-grade'
import { createColorLutSampler, type ColorLutTable, type ColorLutWorkOptions } from './layer-color-lut'
import { colorLutSelectionIsActive } from './layer-color-lut-selection'
import { createLayerColorLutPreset } from './layer-color-lut-presets'
import { defaultImageLayerColorDetail, isNeutralImageLayerColorDetail } from './layer-color-detail'
import { rasterizeLayerColorDetailSteps } from './layer-color-detail-raster'
import { isNeutralImageLayerColorPresence } from './layer-color-presence'
import { isNeutralImageLayerColorCalibration } from './layer-color-calibration'
import { createLayerColorCalibrationTransform } from './layer-color-calibration-raster'

export const layerColorGradeLimits = { edge: 4356, pixels: 18_974_736, tileRows: 16 } as const
export interface LayerColorGradeRasterInput {
  data: Uint8ClampedArray
  width: number
  height: number
  grade: ImageLayerColorGrade
  lutTable?: ColorLutTable
  signal?: AbortSignal
  deadline?: number
  originX?: number
  originY?: number
  spaceWidth?: number
  spaceHeight?: number
  stepX?: number
  stepY?: number
  /** Maps native output pixel centres back to the selected layer's local pixels. */
  pixelToLayer?: { a: number; b: number; c: number; d: number; e: number; f: number }
}
export interface LayerColorGradeRasterResources extends ColorLutWorkOptions { lutTable?: ColorLutTable }

function clamp(value: number): number { return Math.max(0, Math.min(1, value)) }
function smooth(low: number, high: number, value: number): number { const t = clamp((value - low) / (high - low)); return t * t * (3 - 2 * t) }
function linear(value: number): number { return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4 }
function srgb(value: number): number { return value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055 }
function luma(rgb: readonly number[]): number { return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722 }

/** Piecewise linear curves have no spline overshoot and preserve exact endpoints. */
export function layerColorCurveValue(points: readonly ImageLayerColorCurvePoint[], value: number): number {
  const x = clamp(value)
  for (let index = 1; index < points.length; index++) if (x <= points[index].x) {
    const a = points[index - 1], b = points[index]
    return a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)
  }
  return points.at(-1)!.y
}

function toHsl(rgb: readonly number[]): [number, number, number] {
  const [r, g, b] = rgb, hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo, light = (hi + lo) / 2
  if (d < 1e-12) return [0, 0, light]
  const hue = hi === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : hi === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60
  return [hue, d / (1 - Math.abs(2 * light - 1)), light]
}

function fromHsl(hue: number, saturation: number, light: number): [number, number, number] {
  const h = ((hue % 360) + 360) % 360 / 60, c = (1 - Math.abs(2 * light - 1)) * saturation, x = c * (1 - Math.abs(h % 2 - 1)), m = light - c / 2
  const rgb = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m]
}

/** Stateless grain: changing traversal, tiles or cancellation cannot change the seed. */
function noise(x: number, y: number): number {
  let state = Math.imul(Math.floor(x + 1e-7), 374761393) ^ Math.imul(Math.floor(y + 1e-7), 668265263) ^ 0x51f15e5d
  state = Math.imul(state ^ state >>> 13, 1274126177)
  return ((state ^ state >>> 16) >>> 0) / 4294967295 * 2 - 1
}

function check(input: Pick<LayerColorGradeRasterInput, 'signal' | 'deadline'>): void {
  if (input.signal?.aborted) throw new DOMException('已取消图像调整，原图层保留', 'AbortError')
  if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error('图像调整超时，请缩小输出尺寸后重试')
}

function prepareLut(grade: ImageLayerColorGrade, resources: LayerColorGradeRasterResources): ReturnType<typeof createColorLutSampler> | undefined {
  if (!colorLutSelectionIsActive(grade.lut)) return undefined
  const selection = grade.lut!, source = selection.source
  let table: ColorLutTable
  if (source.kind === 'builtin') table = createLayerColorLutPreset(source.presetId, resources)
  else {
    const candidate = resources.lutTable
    if (!candidate) throw new Error('当前图层的 LUT 资源尚未准备完成，请重新载入；不会忽略调色后导出')
    if (candidate.name !== source.name || !Array.isArray(candidate.domainMin) || !Array.isArray(candidate.domainMax) || candidate.domainMin.length !== 3 || candidate.domainMax.length !== 3 || source.domainMin.some((value, channel) => value !== candidate.domainMin[channel]) || source.domainMax.some((value, channel) => value !== candidate.domainMax[channel])) throw new Error('当前图层的 LUT 资源名称或输入范围不匹配，请重新载入')
    // This is a pixel-replay identity check, not resource authorization. The
    // account host verifies ownership and the selected immutable digest.
    table = candidate
  }
  return createColorLutSampler(table, { enabled: selection.enabled, strength: selection.strength }, resources)
}

function effects(grade: ImageLayerColorGrade, rgb: readonly number[], x: number, y: number, width: number, height: number): number[] {
  const distance = Math.hypot((x + .5 - width / 2) / (width / 2), (y + .5 - height / 2) / (height / 2)) / Math.SQRT2
  const vignette = grade.vignette / 100 * smooth(.25, 1, distance), grain = grade.grain / 100 * .08 * noise(x, y)
  return rgb.map((value) => clamp(value + (vignette > 0 ? (1 - value) * vignette : value * vignette) + grain))
}

function kernel(grade: ImageLayerColorGrade, lut: ReturnType<typeof createColorLutSampler> | undefined, includeEffects = true): (r: number, g: number, b: number, x: number, y: number, width: number, height: number) => number[] {
  const calibration = grade.calibration && !isNeutralImageLayerColorCalibration(grade.calibration) ? createLayerColorCalibrationTransform(grade.calibration) : undefined
  const exposure = 2 ** grade.exposure, warmth = Math.log(grade.temperature / 5500) * .4, tint = grade.tint / 150 * .2
  const gains = [Math.exp(warmth + tint / 2), Math.exp(-tint), Math.exp(-warmth + tint / 2)]
  const centers = [0, 30, 60, 120, 180, 240, 270, 300, 360]
  const hslActive = Object.values(grade.hsl).some((channel) => channel.hue || channel.saturation || channel.luminance)
  const tones = [grade.colorGrading.shadows, grade.colorGrading.midtones, grade.colorGrading.highlights]
  const gradeActive = tones.some((tone) => tone.saturation || tone.luminance)
  const gradeColors = tones.map((tone) => fromHsl(tone.hue, 1, .5))
  const exponent = 4 - grade.colorGrading.blending / 100 * 3.5
  const lightActive = grade.exposure || grade.temperature !== 5500 || grade.tint || grade.contrast || grade.highlights || grade.shadows || grade.whites || grade.blacks
  return function transform(r, g, b, x, y, width, height) {
    let rgb = [r, g, b]
    if (lightActive || calibration) {
      if (calibration) {
        rgb = calibration(linear(r), linear(g), linear(b)).map((value, index) => value * exposure * gains[index])
      } else rgb = rgb.map((value, index) => linear(value) * exposure * gains[index])
      const luminance = clamp(luma(rgb))
      const lift = grade.highlights / 100 * .35 * smooth(.35, 1, luminance)
        + grade.shadows / 100 * .25 * (1 - smooth(0, .65, luminance))
        + grade.whites / 100 * .25 * smooth(.65, 1, luminance)
        + grade.blacks / 100 * .15 * (1 - smooth(0, .35, luminance))
      // Neutral stages must not introduce floating cancellation at half-byte
      // rounding boundaries (notably exposure -1 on dark integer samples).
      if (grade.contrast) rgb = rgb.map((value) => (value - .18) * (1 + grade.contrast / 100) + .18)
      if (lift) rgb = rgb.map((value) => value + lift)
      rgb = rgb.map((value) => clamp(srgb(clamp(value))))
    }
    if (grade.saturation || grade.vibrance || hslActive) {
      let [hue, saturation, light] = toHsl(rgb)
      if (hslActive && saturation > 1e-9) {
        let band = 0
        while (band < 7 && hue >= centers[band + 1]) band++
        const weight = (hue - centers[band]) / (centers[band + 1] - centers[band])
        const a = grade.hsl[imageLayerHslChannels[band]], b = grade.hsl[imageLayerHslChannels[(band + 1) % 8]]
        hue += (a.hue * (1 - weight) + b.hue * weight) * .3
        const sat = (a.saturation * (1 - weight) + b.saturation * weight) / 100
        const lum = (a.luminance * (1 - weight) + b.luminance * weight) / 100
        saturation = clamp(saturation * (1 + sat))
        light = clamp(light + (lum > 0 ? 1 - light : light) * lum * .5)
      }
      saturation = clamp(saturation * (1 + grade.saturation / 100) + grade.vibrance / 100 * saturation * (1 - saturation))
      rgb = fromHsl(hue, saturation, light)
    }
    rgb = rgb.map((value, index) => layerColorCurveValue(grade.curves[['red', 'green', 'blue'][index] as 'red' | 'green' | 'blue'], layerColorCurveValue(grade.curves.rgb, value)))
    if (gradeActive) {
      const luminance = clamp(luma(rgb) + grade.colorGrading.balance / 100 * .25)
      const weights = [(1 - luminance) ** exponent, (1 - Math.abs(luminance * 2 - 1)) ** exponent, luminance ** exponent]
      const total = weights.reduce((sum, weight) => sum + weight, 0) || 1
      for (let index = 0; index < 3; index++) {
        const weight = weights[index] / total, tone = tones[index], color = gradeColors[index], neutral = luma(color)
        rgb = rgb.map((value, channel) => value + (color[channel] - neutral) * tone.saturation / 100 * weight * .4 + tone.luminance / 100 * weight * .2)
      }
    }
    if (grade.blackWhite) rgb.fill(luma(rgb))
    if (lut) rgb = lut.sample(rgb[0], rgb[1], rgb[2])
    return includeEffects ? effects(grade, rgb, x, y, width, height) : rgb
  }
}

/** Straight RGB only; alpha and fully transparent hidden RGB are untouched.
 * Each yielded tile owns its bytes. Auxiliary memory is O(width * 16), and
 * spatial coordinates remain native even when called for a sampled histogram. */
function* rasterizePreparedSteps(input: Omit<LayerColorGradeRasterInput, 'grade'>, prepared: { grade: ImageLayerColorGrade; neutral: boolean; transform: ReturnType<typeof kernel>; pointTransform: ReturnType<typeof kernel> }): Generator<{ top: number; height: number; data: Uint8ClampedArray }> {
  const { data, width, height } = input
  if (!(data instanceof Uint8ClampedArray) || ![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= layerColorGradeLimits.edge) || width * height > layerColorGradeLimits.pixels || data.length !== width * height * 4) throw new Error('图像调整像素尺寸超过安全容量或格式不正确')
  const spaceWidth = input.spaceWidth ?? width, spaceHeight = input.spaceHeight ?? height, stepX = input.stepX ?? 1, stepY = input.stepY ?? 1, originX = input.originX ?? 0, originY = input.originY ?? 0
  if (![spaceWidth, spaceHeight, stepX, stepY].every((value) => Number.isFinite(value) && value > 0 && value <= 32768) || ![originX, originY].every((value) => Number.isFinite(value) && Math.abs(value) <= 32768)) throw new Error('图像调整空间参数无效')
  const matrix = input.pixelToLayer
  if (matrix && (![matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].every((value) => Number.isFinite(value) && Math.abs(value) <= 1_000_000) || Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-12)) throw new Error('图像调整空间变换无效')
  const { neutral, transform } = prepared
  check(input)
  if (prepared.grade.detail && !isNeutralImageLayerColorDetail(prepared.grade.detail) || prepared.grade.presence && !isNeutralImageLayerColorPresence(prepared.grade.presence)) {
    if (stepX !== 1 || stepY !== 1) throw new Error('质感、去雾与细节调整需要完整原生图层像素，请先处理原图后再缩小预览或直方图')
    function coordinates(x: number, y: number): [number, number] {
      const px = originX + x, py = originY + y
      return matrix ? [matrix.a * (px + .5) + matrix.c * (py + .5) + matrix.e - .5, matrix.b * (px + .5) + matrix.d * (py + .5) + matrix.f - .5] : [px, py]
    }
    yield* rasterizeLayerColorDetailSteps({ data, width, height, detail: prepared.grade.detail ?? defaultImageLayerColorDetail(), presence: prepared.grade.presence, signal: input.signal, deadline: input.deadline,
      transform(r, g, b, x, y) { const [localX, localY] = coordinates(x, y); return prepared.pointTransform(r, g, b, localX, localY, spaceWidth, spaceHeight) },
      finish(r, g, b, x, y) { const [localX, localY] = coordinates(x, y); return effects(prepared.grade, [r, g, b], localX, localY, spaceWidth, spaceHeight) } })
    return
  }
  for (let top = 0; top < height; top += layerColorGradeLimits.tileRows) {
    const rows = Math.min(layerColorGradeLimits.tileRows, height - top), tile = data.slice(top * width * 4, (top + rows) * width * 4)
    if (!neutral) for (let row = 0; row < rows; row++) {
      check(input)
      for (let x = 0; x < width; x++) {
        const index = (row * width + x) * 4
        if (!tile[index + 3]) continue
        const px = originX + x * stepX, py = originY + (top + row) * stepY
        const localX = matrix ? matrix.a * (px + .5) + matrix.c * (py + .5) + matrix.e - .5 : px
        const localY = matrix ? matrix.b * (px + .5) + matrix.d * (py + .5) + matrix.f - .5 : py
        const rgb = transform(tile[index] / 255, tile[index + 1] / 255, tile[index + 2] / 255, localX, localY, spaceWidth, spaceHeight)
        for (let channel = 0; channel < 3; channel++) tile[index + channel] = Math.round(rgb[channel] * 255)
      }
    }
    check(input)
    yield { top, height: rows, data: tile }
  }
}

/** A layer replay reuses its frozen parser/kernel across separately read strips. */
export function createLayerColorGradeRasterizer(value: ImageLayerColorGrade, resources: LayerColorGradeRasterResources = {}) {
  const grade = parseImageLayerColorGrade(value), lut = prepareLut(grade, resources), prepared = { grade, neutral: isNeutralImageLayerColorGrade(grade), transform: kernel(grade, lut), pointTransform: kernel(grade, lut, false) }
  return { steps(input: Omit<LayerColorGradeRasterInput, 'grade'>) { return rasterizePreparedSteps(input, prepared) } }
}

export function* rasterizeLayerColorGradeSteps(input: LayerColorGradeRasterInput): Generator<{ top: number; height: number; data: Uint8ClampedArray }> {
  yield* createLayerColorGradeRasterizer(input.grade, { lutTable: input.lutTable, signal: input.signal, deadline: input.deadline }).steps(input)
}

export function rasterizeLayerColorGrade(input: LayerColorGradeRasterInput): Uint8ClampedArray {
  const steps = rasterizeLayerColorGradeSteps(input), first = steps.next()
  // Validate dimensions/cancellation before allocating a complete output copy.
  const result = new Uint8ClampedArray(input.width * input.height * 4)
  if (!first.done) result.set(first.value.data, first.value.top * input.width * 4)
  for (const tile of steps) result.set(tile.data, tile.top * input.width * 4)
  return result
}
