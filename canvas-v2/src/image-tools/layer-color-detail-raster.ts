import { isNeutralImageLayerColorDetail, parseImageLayerColorDetail, type ImageLayerColorDetail } from './layer-color-detail'
import { isNeutralImageLayerColorPresence, parseImageLayerColorPresence, type ImageLayerColorPresence } from './layer-color-presence'
import { createLayerColorPresenceRows } from './layer-color-presence-raster'

export const layerColorDetailLimits = { edge: 4356, pixels: 18_974_736, tileRows: 4, denoiseRadius: 2 } as const
export interface LayerColorDetailRasterInput {
  data: Uint8ClampedArray
  width: number
  height: number
  detail: ImageLayerColorDetail
  presence?: ImageLayerColorPresence
  signal?: AbortSignal
  deadline?: number
  /** Point color/LUT stages precede all neighborhood operations. Normalized RGB. */
  transform?: (r: number, g: number, b: number, x: number, y: number) => readonly number[]
  /** Native-coordinate vignette/grain follows the spatial stages. */
  finish?: (r: number, g: number, b: number, x: number, y: number) => readonly number[]
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)) }
function luminance(r: number, g: number, b: number): number { return r * .2126 + g * .7152 + b * .0722 }
function check(input: Pick<LayerColorDetailRasterInput, 'signal' | 'deadline'>): void {
  if (input.signal?.aborted) throw new DOMException('已取消细节与降噪处理，原图层保留', 'AbortError')
  if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error('细节与降噪处理超时，请缩小图层后重试')
}

function assertInput(input: LayerColorDetailRasterInput): void {
  const { data, width, height } = input
  if (!(data instanceof Uint8ClampedArray) || ![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= layerColorDetailLimits.edge) || width * height > layerColorDetailLimits.pixels || data.length !== width * height * 4) throw new Error('细节与降噪像素尺寸超过安全容量或格式不正确')
  check(input)
}

function discardRows(cache: Map<number, Float32Array>, before: number): void {
  for (const row of cache.keys()) if (row < before) cache.delete(row)
}

function gaussianWeights(radius: number): Float64Array {
  const support = Math.ceil(radius * 2), weights = new Float64Array(support * 2 + 1)
  for (let at = -support; at <= support; at++) weights[at + support] = Math.exp(-at * at / (2 * radius * radius))
  return weights
}

/** An original bounded bilateral Y/chroma denoiser followed by separable USM.
 * The immutable native RGBA input is the only full-frame buffer. Point-graded,
 * denoised and premultiplied horizontal rows are cached only for the current
 * halo (at most 17/13/13 rows); no thumbnail or strip edge becomes an image edge.
 * Alpha weights exclude hidden colors and avoid dark halos at transparency.
 */
export function* rasterizeLayerColorDetailSteps(input: LayerColorDetailRasterInput): Generator<{ top: number; height: number; data: Uint8ClampedArray }> {
  assertInput(input)
  const detail = parseImageLayerColorDetail(input.detail), { data, width, height } = input
  const neutral = isNeutralImageLayerColorDetail(detail)
  const presenceConfig = input.presence === undefined ? undefined : parseImageLayerColorPresence(input.presence)
  const presence = presenceConfig && !isNeutralImageLayerColorPresence(presenceConfig) ? createLayerColorPresenceRows({ data, width, height, presence: presenceConfig, signal: input.signal, deadline: input.deadline, transform: input.transform }) : undefined
  const pointRows = new Map<number, Float32Array>(), denoisedRows = new Map<number, Float32Array>(), horizontalRows = new Map<number, Float32Array>()
  const sharpening = detail.enabled ? detail.sharpening.amount / 100 : 0, lumaAmount = detail.enabled ? detail.luminance.amount / 100 : 0, colorAmount = detail.enabled ? detail.color.amount / 100 : 0
  const weights = gaussianWeights(detail.sharpening.radius), support = sharpening ? (weights.length - 1) / 2 : 0
  const lumaSigma = .012 + .10 * (1 - detail.luminance.detail / 100), chromaSigma = .02 + .20 * (1 - detail.color.detail / 100), edgeSigma = .04 + .08 * (1 - detail.color.detail / 100)
  const colorSpatialSigma = .65 + detail.color.smoothness * .0185
  const lumaSpatial = new Float64Array(25), colorSpatial = new Float64Array(25)
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const at = (dy + 2) * 5 + dx + 2, distance = dx * dx + dy * dy
    lumaSpatial[at] = Math.exp(-distance / (2 * 1.15 ** 2))
    colorSpatial[at] = Math.exp(-distance / (2 * colorSpatialSigma ** 2))
  }
  function pointRow(row: number): Float32Array {
    const y = Math.max(0, Math.min(height - 1, row)), existing = pointRows.get(y)
    if (existing) return existing
    check(input)
    const result = new Float32Array(width * 3), source = presence?.row(y)
    for (let x = 0; x < width; x++) {
      if (x % 256 === 0) check(input)
      const at = (y * width + x) * 4, offset = x * 3
      const rgb = source ? [source[offset], source[offset + 1], source[offset + 2]] : data[at + 3] && input.transform ? input.transform(data[at] / 255, data[at + 1] / 255, data[at + 2] / 255, x, y) : [data[at] / 255, data[at + 1] / 255, data[at + 2] / 255]
      const luma = luminance(rgb[0], rgb[1], rgb[2])
      result[offset] = luma; result[offset + 1] = rgb[2] - luma; result[offset + 2] = rgb[0] - luma
    }
    pointRows.set(y, result)
    return result
  }
  function denoisedRow(row: number): Float32Array {
    const y = Math.max(0, Math.min(height - 1, row)), existing = denoisedRows.get(y)
    if (existing) return existing
    const centerRow = pointRow(y), result = new Float32Array(width * 3)
    const neighbors = lumaAmount || colorAmount ? [-2, -1, 0, 1, 2].map((dy) => pointRow(y + dy)) : []
    for (let x = 0; x < width; x++) {
      if (x % 64 === 0) check(input)
      const offset = x * 3, centerY = centerRow[offset], centerB = centerRow[offset + 1], centerR = centerRow[offset + 2]
      let nextY = centerY, nextB = centerB, nextR = centerR
      if (data[(y * width + x) * 4 + 3] && (lumaAmount || colorAmount)) {
        let sumY = 0, weightY = 0, sumB = 0, sumR = 0, weightC = 0
        for (let dy = -2; dy <= 2; dy++) {
          const sy = Math.max(0, Math.min(height - 1, y + dy)), values = neighbors[dy + 2]
          for (let dx = -2; dx <= 2; dx++) {
            const sx = Math.max(0, Math.min(width - 1, x + dx)), alpha = data[(sy * width + sx) * 4 + 3] / 255
            if (!alpha) continue
            const at = sx * 3, spatialAt = (dy + 2) * 5 + dx + 2, deltaY = values[at] - centerY
            if (lumaAmount) {
              const weight = alpha * lumaSpatial[spatialAt] * Math.exp(-deltaY * deltaY / (2 * lumaSigma * lumaSigma))
              sumY += values[at] * weight; weightY += weight
            }
            if (colorAmount) {
              const db = values[at + 1] - centerB, dr = values[at + 2] - centerR
              const weight = alpha * colorSpatial[spatialAt] * Math.exp(-deltaY * deltaY / (2 * edgeSigma * edgeSigma) - (db * db + dr * dr) / (2 * chromaSigma * chromaSigma))
              sumB += values[at + 1] * weight; sumR += values[at + 2] * weight; weightC += weight
            }
          }
        }
        // Contrast restores local luminance residual rather than multiplying
        // the entire image; this preserves flat fields and the black point.
        if (weightY) nextY += (sumY / weightY - centerY) * lumaAmount * (1 - detail.luminance.contrast / 100 * .65)
        if (weightC) { nextB += (sumB / weightC - centerB) * colorAmount; nextR += (sumR / weightC - centerR) * colorAmount }
      }
      const r = nextY + nextR, b = nextY + nextB, g = (nextY - .2126 * r - .0722 * b) / .7152
      result[offset] = r; result[offset + 1] = g; result[offset + 2] = b
    }
    denoisedRows.set(y, result)
    return result
  }
  function horizontalRow(row: number): Float32Array {
    const y = Math.max(0, Math.min(height - 1, row)), existing = horizontalRows.get(y)
    if (existing) return existing
    const source = denoisedRow(y), result = new Float32Array(width * 4)
    for (let x = 0; x < width; x++) {
      if (x % 128 === 0) check(input)
      const at = x * 4
      for (let dx = -support; dx <= support; dx++) {
        const sx = Math.max(0, Math.min(width - 1, x + dx)), weight = weights[dx + support] * data[(y * width + sx) * 4 + 3] / 255
        result[at] += source[sx * 3] * weight; result[at + 1] += source[sx * 3 + 1] * weight; result[at + 2] += source[sx * 3 + 2] * weight; result[at + 3] += weight
      }
    }
    horizontalRows.set(y, result)
    return result
  }
  for (let top = 0; top < height; top += layerColorDetailLimits.tileRows) {
    check(input)
    const rows = Math.min(layerColorDetailLimits.tileRows, height - top), tile = data.slice(top * width * 4, (top + rows) * width * 4)
    for (let row = 0; row < rows; row++) {
      const y = top + row
      discardRows(pointRows, y - support - 2); discardRows(denoisedRows, y - support); discardRows(horizontalRows, y - support)
      presence?.discardBefore(y - support - 2)
      check(input)
      const center = neutral ? undefined : denoisedRow(y), blurred = sharpening ? Array.from({ length: support * 2 + 1 }, (_, at) => horizontalRow(y + at - support)) : []
      const presenceRow = neutral ? presence?.row(y) : undefined
      for (let x = 0; x < width; x++) {
        if (x % 128 === 0) check(input)
        const at = (row * width + x) * 4
        if (!tile[at + 3]) continue
        let rgb: readonly number[] = center ? [center[x * 3], center[x * 3 + 1], center[x * 3 + 2]] : presenceRow ? [presenceRow[x * 3], presenceRow[x * 3 + 1], presenceRow[x * 3 + 2]] : input.transform ? input.transform(tile[at] / 255, tile[at + 1] / 255, tile[at + 2] / 255, x, y) : [tile[at] / 255, tile[at + 1] / 255, tile[at + 2] / 255]
        if (sharpening) {
          let r = 0, g = 0, b = 0, alpha = 0
          for (let dy = -support; dy <= support; dy++) {
            const values = blurred[dy + support], offset = x * 4, weight = weights[dy + support]
            r += values[offset] * weight; g += values[offset + 1] * weight; b += values[offset + 2] * weight; alpha += values[offset + 3] * weight
          }
          if (alpha) {
            const currentY = luminance(rgb[0], rgb[1], rgb[2]), blurY = luminance(r, g, b) / alpha, residual = currentY - blurY
            const threshold = detail.sharpening.masking / 100 * .12, edge = Math.abs(residual), mask = threshold ? clamp((edge - threshold * .2) / (threshold * .8 + 1e-9)) : 1
            // The fine residual gain increases sub-radius texture separately
            // from broad edge enhancement. Masking attenuates low-contrast noise.
            const fine = Math.min(1, edge / .06), gain = 1 + detail.sharpening.detail / 100 * (1 - fine) * 1.5
            const delta = residual * sharpening * mask * gain
            rgb = [rgb[0] + delta, rgb[1] + delta, rgb[2] + delta]
          }
        }
        if (input.finish) rgb = input.finish(rgb[0], rgb[1], rgb[2], x, y)
        for (let channel = 0; channel < 3; channel++) tile[at + channel] = Math.round(clamp(rgb[channel]) * 255)
      }
    }
    check(input)
    yield { top, height: rows, data: tile }
  }
}

export function rasterizeLayerColorDetail(input: LayerColorDetailRasterInput): Uint8ClampedArray {
  const steps = rasterizeLayerColorDetailSteps(input), first = steps.next()
  const result = new Uint8ClampedArray(input.width * input.height * 4)
  if (!first.done) result.set(first.value.data, first.value.top * input.width * 4)
  for (const tile of steps) result.set(tile.data, tile.top * input.width * 4)
  return result
}
