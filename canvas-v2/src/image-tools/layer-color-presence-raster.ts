import { isNeutralImageLayerColorPresence, parseImageLayerColorPresence, type ImageLayerColorPresence } from './layer-color-presence'

export const layerColorPresenceLimits = { edge: 4356, pixels: 18_974_736, tileRows: 4, fineRadius: 1, textureRadius: 3, clarityRadius: 12 } as const
export interface LayerColorPresenceRasterInput {
  data: Uint8ClampedArray
  width: number
  height: number
  presence: ImageLayerColorPresence
  signal?: AbortSignal
  deadline?: number
  /** Point color and LUT use native coordinates before spatial adjustment. */
  transform?: (r: number, g: number, b: number, x: number, y: number) => readonly number[]
}

function clamp(value: number): number { return Math.max(0, Math.min(1, value)) }
function luma(r: number, g: number, b: number): number { return .2126 * r + .7152 * g + .0722 * b }
function check(input: Pick<LayerColorPresenceRasterInput, 'signal' | 'deadline'>): void {
  if (input.signal?.aborted) throw new DOMException('已取消质感与去雾处理，原图层保留', 'AbortError')
  if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error('质感与去雾处理超时，请缩小图层后重试')
}
function discard(cache: Map<number, Float32Array | Float64Array>, before: number): void {
  for (const key of cache.keys()) if (key < before) cache.delete(key)
}

/** Original multiscale/scattering implementation. Texture acts on the 1–3 px
 * band, clarity on the 3–12 px midtone band, while dehaze inverts (or adds)
 * atmospheric veiling using local alpha-weighted RGB and luminance variance.
 * Hidden colors never enter statistics. Native rows use sliding box sums, not
 * a resized image or a succession of already modified output strips. Three
 * bounded horizontal halos and one point halo replace full-frame float images.
 */
export function createLayerColorPresenceRows(input: LayerColorPresenceRasterInput) {
  const { data, width, height } = input
  if (!(data instanceof Uint8ClampedArray) || ![width, height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= layerColorPresenceLimits.edge) || width * height > layerColorPresenceLimits.pixels || data.length !== width * height * 4) throw new Error('质感与去雾像素尺寸超过安全容量或格式不正确')
  check(input)
  const presence = parseImageLayerColorPresence(input.presence), neutral = isNeutralImageLayerColorPresence(presence)
  const pointRows = new Map<number, Float32Array>(), outputRows = new Map<number, Float32Array>()
  const boundedY = (row: number) => Math.max(0, Math.min(height - 1, row))
  function pointRow(row: number): Float32Array {
    const y = boundedY(row), existing = pointRows.get(y)
    if (existing) return existing
    check(input)
    const result = new Float32Array(width * 3)
    for (let x = 0; x < width; x++) {
      if (x % 256 === 0) check(input)
      const at = (y * width + x) * 4, offset = x * 3
      const rgb = data[at + 3] && input.transform ? input.transform(data[at] / 255, data[at + 1] / 255, data[at + 2] / 255, x, y) : [data[at] / 255, data[at + 1] / 255, data[at + 2] / 255]
      result[offset] = rgb[0]; result[offset + 1] = rgb[1]; result[offset + 2] = rgb[2]
    }
    pointRows.set(y, result)
    return result
  }
  function statistics(radius: number) {
    const horizontalRows = new Map<number, Float64Array>(), vertical = new Float64Array(width * 5)
    let currentY = -Infinity
    function horizontal(row: number): Float64Array {
      const y = boundedY(row), existing = horizontalRows.get(y)
      if (existing) return existing
      const source = pointRow(y), result = new Float64Array(width * 5), sum = [0, 0, 0, 0, 0]
      function add(x: number, direction: number): void {
        const sx = Math.max(0, Math.min(width - 1, x)), at = sx * 3, alpha = data[(y * width + sx) * 4 + 3] / 255 * direction
        sum[0] += source[at] * alpha; sum[1] += source[at + 1] * alpha; sum[2] += source[at + 2] * alpha; sum[3] += alpha
        sum[4] += luma(source[at], source[at + 1], source[at + 2]) ** 2 * alpha
      }
      for (let dx = -radius; dx <= radius; dx++) add(dx, 1)
      for (let x = 0; x < width; x++) {
        if (x % 256 === 0) check(input)
        if (x) { add(x - radius - 1, -1); add(x + radius, 1) }
        result.set(sum, x * 5)
      }
      horizontalRows.set(y, result)
      return result
    }
    function addVertical(row: number, direction: number): void {
      const values = horizontal(row)
      for (let at = 0; at < vertical.length; at++) vertical[at] += values[at] * direction
    }
    return {
      row(y: number): Float64Array {
        check(input)
        if (currentY !== y) {
          if (y === currentY + 1) { addVertical(y - radius - 1, -1); addVertical(y + radius, 1) }
          else { vertical.fill(0); for (let dy = -radius; dy <= radius; dy++) addVertical(y + dy, 1) }
          currentY = y
        }
        discard(horizontalRows, y - radius)
        return vertical
      },
      cachedRows() { return horizontalRows.size },
    }
  }
  const small = !neutral && presence.texture ? statistics(layerColorPresenceLimits.fineRadius) : undefined
  const medium = !neutral && (presence.texture || presence.clarity) ? statistics(layerColorPresenceLimits.textureRadius) : undefined
  const broad = !neutral && (presence.clarity || presence.dehaze) ? statistics(layerColorPresenceLimits.clarityRadius) : undefined
  function row(row: number): Float32Array {
    if (!Number.isSafeInteger(row)) throw new Error('质感与去雾原生行坐标无效')
    const y = boundedY(row), cached = outputRows.get(y)
    if (cached) return cached
    check(input)
    const center = pointRow(y), fine = small?.row(y), middle = medium?.row(y), wide = broad?.row(y), result = new Float32Array(width * 3)
    for (let x = 0; x < width; x++) {
      if (x % 128 === 0) check(input)
      const offset = x * 3, at = x * 5
      let r = center[offset], g = center[offset + 1], b = center[offset + 2]
      if (data[(y * width + x) * 4 + 3] && !neutral) {
        const centerY = luma(r, g, b)
        const middleY = middle && middle[at + 3] > 1e-9 ? luma(middle[at], middle[at + 1], middle[at + 2]) / middle[at + 3] : centerY
        const wideY = wide && wide[at + 3] > 1e-9 ? luma(wide[at], wide[at + 1], wide[at + 2]) / wide[at + 3] : centerY
        let delta = 0
        if (fine && fine[at + 3] > 1e-9) {
          const residual = luma(fine[at], fine[at + 1], fine[at + 2]) / fine[at + 3] - middleY
          // A bounded band excludes single-pixel noise and broad edge halos.
          // Softening has a smaller maximum gain so the band cannot reverse
          // phase at -100 while positive texture can still reveal fine detail.
          delta += .11 * Math.tanh(residual / .11) * presence.texture / 100 * (presence.texture < 0 ? .75 : 1.8)
        }
        if (presence.clarity) {
          const midtone = clamp(middleY), gate = 4 * midtone * (1 - midtone)
          delta += .18 * Math.tanh((middleY - wideY) / .18) * presence.clarity / 100 * gate
        }
        r += delta; g += delta; b += delta
        if (presence.dehaze && wide && wide[at + 3] > 1e-9) {
          const weight = wide[at + 3], dark = clamp(Math.min(wide[at], wide[at + 1], wide[at + 2]) / weight)
          const variance = Math.max(0, wide[at + 4] / weight - wideY * wideY)
          // Bright smooth regions carry stronger atmospheric evidence. Local
          // variance reduces strong-edge halos; transmission is bounded away
          // from zero. Negative values add physical white veiling instead of
          // reversing a global contrast curve.
          const depth = (.08 + .72 * dark) / (1 + variance * 12), strength = Math.abs(presence.dehaze) / 100
          const transmission = Math.max(.25, 1 - strength * depth)
          if (presence.dehaze > 0) { r = 1 + (r - 1) / transmission; g = 1 + (g - 1) / transmission; b = 1 + (b - 1) / transmission }
          else { r = 1 + (r - 1) * transmission; g = 1 + (g - 1) * transmission; b = 1 + (b - 1) * transmission }
        }
      }
      result[offset] = clamp(r); result[offset + 1] = clamp(g); result[offset + 2] = clamp(b)
    }
    outputRows.set(y, result)
    // A downstream detail kernel may hold an older output row, but never needs
    // its original point halo again. These caches own different immutable rows.
    discard(pointRows, y - layerColorPresenceLimits.clarityRadius)
    return result
  }
  return {
    row,
    discardBefore(before: number) { discard(outputRows, before) },
    /** Diagnostics describe bounded live rows, never pixel or account data. */
    cacheRows() { return { point: pointRows.size, output: outputRows.size, small: small?.cachedRows() ?? 0, medium: medium?.cachedRows() ?? 0, broad: broad?.cachedRows() ?? 0 } },
  }
}

export function* rasterizeLayerColorPresenceSteps(input: LayerColorPresenceRasterInput): Generator<{ top: number; height: number; data: Uint8ClampedArray }> {
  const source = createLayerColorPresenceRows(input), neutral = isNeutralImageLayerColorPresence(input.presence)
  for (let top = 0; top < input.height; top += layerColorPresenceLimits.tileRows) {
    check(input)
    const height = Math.min(layerColorPresenceLimits.tileRows, input.height - top), data = input.data.slice(top * input.width * 4, (top + height) * input.width * 4)
    for (let y = top; y < top + height; y++) {
      if (neutral && !input.transform) continue
      const values = source.row(y)
      for (let x = 0; x < input.width; x++) {
        const at = ((y - top) * input.width + x) * 4
        if (data[at + 3]) for (let channel = 0; channel < 3; channel++) data[at + channel] = Math.round(clamp(values[x * 3 + channel]) * 255)
      }
      source.discardBefore(y)
    }
    check(input)
    yield { top, height, data }
  }
}

export function rasterizeLayerColorPresence(input: LayerColorPresenceRasterInput): Uint8ClampedArray {
  const steps = rasterizeLayerColorPresenceSteps(input), first = steps.next()
  const result = new Uint8ClampedArray(input.width * input.height * 4)
  if (!first.done) result.set(first.value.data, first.value.top * input.width * 4)
  for (const tile of steps) result.set(tile.data, tile.top * input.width * 4)
  return result
}
