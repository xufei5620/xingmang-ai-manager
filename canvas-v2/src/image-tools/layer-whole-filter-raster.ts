import { assertWholeLayerFilterSize, isNeutralWholeLayerFilter, parseWholeLayerFilter, wholeLayerFilterLimits, type ImageLayerWholeFilter, type ImageLayerWholeFilterOperation } from './layer-whole-filter'
import { assertLayerFilterSize } from './layer-filter-raster'

export interface WholeLayerFilterRasterInput {
  data: Uint8ClampedArray
  width: number
  height: number
  filter: ImageLayerWholeFilter
  referenceSpace?: { width: number; height: number }
  signal?: AbortSignal
  deadline?: number
}

function check(input: WholeLayerFilterRasterInput): void {
  if (input.signal?.aborted) throw new DOMException('整层滤镜已取消，原图层保持不变', 'AbortError')
  if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error('整层滤镜处理超时，请缩小图层或减小参数后重试')
}
function clamp(value: number, min = 0, max = 1): number { return Math.max(min, Math.min(max, value)) }
function smooth(value: number): number { const t = clamp(value); return t * t * (3 - 2 * t) }

/** Shared alpha-aware bilinear sampling. Outside the layer is transparent,
 * rather than an unrelated world-canvas neighbour or a repeated edge pixel. */
export function sampleWholeFilterPixel(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, output: Uint8ClampedArray, offset: number): void {
  const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top
  const sums = [0, 0, 0, 0]
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const sx = left + dx, sy = top + dy
    if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), index = (sy * width + sx) * 4, alpha = data[index + 3]
    sums[3] += alpha * weight
    for (let c = 0; c < 3; c++) sums[c] += data[index + c] * alpha * weight
  }
  output[offset + 3] = sums[3]
  for (let c = 0; c < 3; c++) output[offset + c] = sums[3] > 0 ? sums[c] / sums[3] : 0
}

function gaussianKernel(sigma: number): Float64Array {
  if (sigma <= 0) return new Float64Array([1])
  const radius = Math.ceil(sigma * 3), kernel = new Float64Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) { const value = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel[i + radius] = value; sum += value }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum
  return kernel
}

/** Streaming separable convolution: retain only the active vertical window,
 * never an additional full-size floating-point RGBA image. */
function* gaussian(input: WholeLayerFilterRasterInput, sigmaX: number, sigmaY: number): Generator<void, Uint8ClampedArray> {
  if (Math.max(sigmaX, sigmaY) > 256 || Math.min(input.height, Math.ceil(sigmaY * 3) * 2 + 1) * input.width * 4 * 8 > 64 * 1024 * 1024) throw new Error('整层滤镜缩放后的卷积窗口超过处理容量，请减小半径或图层尺寸')
  const { width, height, data } = input, horizontal = gaussianKernel(sigmaX), vertical = gaussianKernel(sigmaY)
  const rx = (horizontal.length - 1) / 2, ry = (vertical.length - 1) / 2, rows = new Map<number, Float64Array>()
  const result = new Uint8ClampedArray(data.length)
  function* row(y: number): Generator<void, Float64Array> {
    const key = Math.max(0, Math.min(height - 1, y)), existing = rows.get(key)
    if (existing) return existing
    check(input)
    const value = new Float64Array(width * 4)
    const batch = Math.max(16, Math.floor(32768 / horizontal.length))
    for (let x = 0; x < width; x++) {
      // The first vertical window may need hundreds of horizontal rows. Yield
      // inside that preparation too, before a single output row is complete.
      if (x % batch === 0) { check(input); yield; check(input) }
      for (let k = -rx; k <= rx; k++) {
        const index = (key * width + Math.max(0, Math.min(width - 1, x + k))) * 4, weight = horizontal[k + rx], alpha = data[index + 3]
        value[x * 4 + 3] += alpha * weight
        for (let c = 0; c < 3; c++) value[x * 4 + c] += data[index + c] * alpha * weight
      }
    }
    rows.set(key, value)
    return value
  }
  for (let y = 0; y < height; y++) {
    check(input)
    const sums = new Float64Array(width * 4)
    for (let k = -ry; k <= ry; k++) {
      const value = yield* row(y + k), weight = vertical[k + ry]
      for (let i = 0; i < value.length; i++) sums[i] += value[i] * weight
    }
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4, alpha = sums[x * 4 + 3]
      result[index + 3] = alpha
      for (let c = 0; c < 3; c++) result[index + c] = alpha > 0 ? sums[x * 4 + c] / alpha : 0
    }
    for (const key of rows.keys()) if (key < Math.max(0, y + 1 - ry)) rows.delete(key)
    if (y % wholeLayerFilterLimits.tileRows === 0) yield
  }
  check(input)
  return result
}

function* box(input: WholeLayerFilterRasterInput, rx: number, ry: number): Generator<void, Uint8ClampedArray> {
  const { width, height, data } = input, result = new Uint8ClampedArray(data.length), columns = new Float64Array(width * 4)
  function addRow(y: number, sign: number): void {
    const sy = Math.max(0, Math.min(height - 1, y))
    for (let x = 0; x < width; x++) {
      const i = (sy * width + x) * 4, a = data[i + 3]
      columns[x * 4 + 3] += a * sign
      for (let c = 0; c < 3; c++) columns[x * 4 + c] += data[i + c] * a * sign
    }
  }
  for (let y = -ry; y <= ry; y++) { check(input); addRow(y, 1) }
  const divisor = (rx * 2 + 1) * (ry * 2 + 1)
  for (let y = 0; y < height; y++) {
    check(input)
    const sums = [0, 0, 0, 0]
    function add(x: number, sign: number): void { const sx = Math.max(0, Math.min(width - 1, x)); for (let c = 0; c < 4; c++) sums[c] += columns[sx * 4 + c] * sign }
    for (let x = -rx; x <= rx; x++) add(x, 1)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      result[i + 3] = sums[3] / divisor
      for (let c = 0; c < 3; c++) result[i + c] = sums[3] > 0 ? sums[c] / sums[3] : 0
      add(x - rx, -1); add(x + rx + 1, 1)
    }
    if (y + 1 < height) { addRow(y - ry, -1); addRow(y + ry + 1, 1) }
    if (y % wholeLayerFilterLimits.tileRows === 0) yield
  }
  check(input)
  return result
}

function* median(input: WholeLayerFilterRasterInput, rx: number, ry: number): Generator<void, Uint8ClampedArray> {
  if (Math.max(rx, ry) > 32) throw new Error('整层中值滤镜缩放后的邻域超过处理容量，请减小半径或图层尺寸')
  const { width, height, data } = input, result = new Uint8ClampedArray(data.length), target = Math.floor((rx * 2 + 1) * (ry * 2 + 1) / 2) + 1
  for (let y = 0; y < height; y++) {
    check(input)
    const counts = Array.from({ length: 4 }, () => new Int32Array(256))
    function add(x: number, sign: number): void {
      const sx = Math.max(0, Math.min(width - 1, x))
      for (let dy = -ry; dy <= ry; dy++) {
        const i = (Math.max(0, Math.min(height - 1, y + dy)) * width + sx) * 4, alpha = data[i + 3]
        counts[3][alpha] += sign
        for (let c = 0; c < 3; c++) counts[c][Math.round(data[i + c] * alpha / 255)] += sign
      }
    }
    for (let x = -rx; x <= rx; x++) add(x, 1)
    for (let x = 0; x < width; x++) {
      const values = [0, 0, 0, 0], i = (y * width + x) * 4
      for (let c = 0; c < 4; c++) { let count = 0; for (let v = 0; v < 256; v++) { count += counts[c][v]; if (count >= target) { values[c] = v; break } } }
      result[i + 3] = values[3]
      for (let c = 0; c < 3; c++) result[i + c] = values[3] ? values[c] * 255 / values[3] : 0
      add(x - rx, -1); add(x + rx + 1, 1)
    }
    if (y % wholeLayerFilterLimits.tileRows === 0) yield
  }
  check(input)
  return result
}

function mixPixel(source: Uint8ClampedArray, filtered: Uint8ClampedArray, output: Uint8ClampedArray, i: number, weight: number): void {
  if (weight <= 0) { output.set(source.subarray(i, i + 4), i); return }
  const alpha = source[i + 3] * (1 - weight) + filtered[i + 3] * weight
  output[i + 3] = alpha
  for (let c = 0; c < 3; c++) output[i + c] = alpha > 0 ? (source[i + c] * source[i + 3] * (1 - weight) + filtered[i + c] * filtered[i + 3] * weight) / alpha : 0
}

/** All 17 filters operate on immutable layer-local native RGBA. Spatial
 * parameters scale from the operation's creation space, not thumbnail size. */
export function* rasterizeWholeLayerFilterSteps(input: WholeLayerFilterRasterInput): Generator<void, Uint8ClampedArray> {
  const { data, width, height } = input
  assertWholeLayerFilterSize(width, height)
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new Error('整层滤镜像素数据无效')
  if (input.referenceSpace) assertWholeLayerFilterSize(input.referenceSpace.width, input.referenceSpace.height)
  const filter = parseWholeLayerFilter(input.filter), { type, parameters: p } = filter
  const sx = width / (input.referenceSpace?.width ?? width), sy = height / (input.referenceSpace?.height ?? height)
  check(input)
  if (isNeutralWholeLayerFilter(filter)) return data.slice()
  if (type === 'gaussian') return yield* gaussian(input, p.radius * sx, p.radius * sy)
  if (type === 'median') return yield* median(input, Math.max(1, Math.round(p.radius * sx)), Math.max(1, Math.round(p.radius * sy)))
  if (type === 'box-blur') { let result = data; for (let i = 0; i < p.iterations; i++) { result = yield* box({ ...input, data: result }, Math.max(1, Math.round(sx)), Math.max(1, Math.round(sy))); check(input); yield }; return result }
  const output = data.slice()
  if (type === 'mosaic') {
    const bx = Math.max(1, Math.round(p.size * sx)), by = Math.max(1, Math.round(p.size * sy))
    let processed = 0
    for (let top = 0; top < height; top += by) {
      check(input)
      for (let left = 0; left < width; left += bx) {
        const right = Math.min(width, left + bx), bottom = Math.min(height, top + by), sums = [0, 0, 0, 0], count = (right - left) * (bottom - top)
        for (let y = top; y < bottom; y++) {
          check(input)
          for (let x = left; x < right; x++) { const i = (y * width + x) * 4, a = data[i + 3]; sums[3] += a; for (let c = 0; c < 3; c++) sums[c] += data[i + c] * a }
          processed += right - left
          if (processed >= 32768) { processed = 0; yield }
        }
        for (let y = top; y < bottom; y++) {
          check(input)
          for (let x = left; x < right; x++) { const i = (y * width + x) * 4; output[i + 3] = sums[3] / count; for (let c = 0; c < 3; c++) output[i + c] = sums[3] ? sums[c] / sums[3] : 0 }
          processed += right - left
          if (processed >= 32768) { processed = 0; yield }
        }
      }
      yield
    }
    check(input)
    return output
  }
  let blurred: Uint8ClampedArray | undefined
  if (['usm', 'smart-sharpen', 'iris-blur', 'tilt-shift'].includes(type)) blurred = yield* gaussian(input, p.radius * sx, p.radius * sy)
  const kernels: Record<string, number[]> = { sharpen: [0, -1, 0, -1, 5, -1, 0, -1, 0], emboss: [-2, -1, 0, -1, 1, 1, 0, 1, 2], edges: [-1, -1, -1, -1, 8, -1, -1, -1, -1] }
  function random(index: number): number { let value = (1 + Math.imul(index + 1, 0x6d2b79f5)) >>> 0; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296 }
  const cx = (width - 1) / 2, cy = (height - 1) / 2, radius = Math.min(width, height) * (p.radius ?? 80) / 200
  for (let y = 0; y < height; y++) {
    check(input)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, alpha = data[i + 3]
      if (type === 'noise') {
        const sourceX = Math.min((input.referenceSpace?.width ?? width) - 1, Math.floor((x + .5) / sx)), sourceY = Math.min((input.referenceSpace?.height ?? height) - 1, Math.floor((y + .5) / sy)), sourceIndex = (sourceY * (input.referenceSpace?.width ?? width) + sourceX) * 3
        for (let c = 0; c < 3; c++) { const noise = (random(sourceIndex + c) * 2 - 1) * p.amount; output[i + c] = alpha ? data[i + c] + noise : 0 }
      } else if (kernels[type]) {
        const kernel = kernels[type]
        for (let c = 0; c < 3; c++) {
          let sum = (type === 'emboss' ? p.bias : 0) * alpha
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = (Math.max(0, Math.min(height - 1, y + Math.round(dy * sy))) * width + Math.max(0, Math.min(width - 1, x + Math.round(dx * sx)))) * 4; sum += data[j + c] * data[j + 3] * kernel[(dy + 1) * 3 + dx + 1] }
          output[i + c] = alpha ? sum / alpha : 0
        }
      } else if ((type === 'usm' || type === 'smart-sharpen') && blurred) {
        const difference = Math.max(...[0, 1, 2].map((c) => Math.abs(data[i + c] - blurred![i + c])))
        const luminance = (.2126 * data[i] + .7152 * data[i + 1] + .0722 * data[i + 2]) / 255
        const fade = type === 'smart-sharpen' ? (1 - p.shadowFade * (1 - luminance) ** 2) * (1 - p.highlightFade * luminance ** 2) : 1
        for (let c = 0; c < 3; c++) output[i + c] = alpha ? data[i + c] + (difference >= (p.threshold ?? 0) ? (data[i + c] - blurred[i + c]) * p.amount / 100 * fade : 0) : 0
      } else if ((type === 'iris-blur' || type === 'tilt-shift') && blurred) {
        const distance = type === 'iris-blur'
          ? (Math.hypot((x - p.centerX / 100 * width) / (p.radiusX / 100 * width), (y - p.centerY / 100 * height) / (p.radiusY / 100 * height)) - 1) * Math.min(p.radiusX / 100 * width, p.radiusY / 100 * height)
          : Math.abs(y - p.centerY / 100 * height) - p.band / 100 * height
        const feather = p.feather / 100 * (type === 'iris-blur' ? Math.min(width, height) : height)
        mixPixel(data, blurred, output, i, feather ? smooth(distance / feather) : distance > 0 ? 1 : 0)
      } else {
        const dx = x - cx, dy = y - cy, distance = Math.hypot(dx, dy)
        let sourceX = x, sourceY = y
        if (type === 'wave') sourceX -= p.amplitude * sx * Math.sin(2 * Math.PI * y / sy / p.wavelength)
        else if (type === 'lens-correction') {
          const nx = dx / Math.max(.5, width / 2), ny = dy / Math.max(.5, height / 2), factor = 1 + p.k1 * (nx * nx + ny * ny)
          sourceX = cx + dx * factor; sourceY = cy + dy * factor
        } else if (distance > 0 && distance < radius) {
          const t = distance / radius
          if (type === 'twirl') { const angle = Math.atan2(dy, dx) - p.angle * Math.PI / 180 * (1 - t) ** 2; sourceX = cx + Math.cos(angle) * distance; sourceY = cy + Math.sin(angle) * distance }
          else {
            const radial = type === 'pinch' ? distance * (1 + p.strength * (1 - t) ** 2)
              : distance * (1 - Math.abs(p.amount)) + radius * (p.amount >= 0 ? Math.asin(t) * 2 / Math.PI : Math.sin(t * Math.PI / 2)) * Math.abs(p.amount)
            sourceX = cx + dx / distance * radial; sourceY = cy + dy / distance * radial
          }
        }
        if (sourceX !== x || sourceY !== y) sampleWholeFilterPixel(data, width, height, sourceX, sourceY, output, i)
        if (type === 'lens-correction' && p.vignette) {
          const radial = clamp(Math.hypot(dx / Math.max(.5, width / 2), dy / Math.max(.5, height / 2)) / Math.SQRT2), gain = Math.max(0, 1 - p.vignette * radial ** p.falloff)
          for (let c = 0; c < 3; c++) output[i + c] *= gain
        }
      }
    }
    if (y % wholeLayerFilterLimits.tileRows === 0) yield
  }
  check(input)
  return output
}

export interface WholeFilterMatrix { a: number; b: number; c: number; d: number; e: number; f: number }
export interface WholeLayerFilterWorldInput {
  data: Uint8ClampedArray; width: number; height: number
  layerWidth: number; layerHeight: number; layerToPixel: WholeFilterMatrix
  operation: ImageLayerWholeFilterOperation; signal?: AbortSignal; deadline?: number
}

function outsideFilterEffect(filter: ImageLayerWholeFilter, width: number, height: number, x: number, y: number): boolean {
  const { type, parameters: p } = filter
  if (type === 'twirl' || type === 'pinch' || type === 'spherize') {
    const distance = Math.hypot(x - (width - 1) / 2, y - (height - 1) / 2)
    return distance === 0 || distance >= Math.min(width, height) * p.radius / 200
  }
  if (type === 'iris-blur') return Math.hypot((x - p.centerX / 100 * width) / (p.radiusX / 100 * width), (y - p.centerY / 100 * height) / (p.radiusY / 100 * height)) <= 1
  if (type === 'tilt-shift') return Math.abs(y - p.centerY / 100 * height) <= p.band / 100 * height
  return false
}

function unchangedNeighborhood(before: Uint8ClampedArray, after: Uint8ClampedArray, width: number, height: number, x: number, y: number): boolean {
  const left = Math.floor(x), top = Math.floor(y)
  for (let yy = top; yy <= top + 1; yy++) for (let xx = left; xx <= left + 1; xx++) {
    if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
    const i = (yy * width + xx) * 4
    for (let c = 0; c < 4; c++) if (before[i + c] !== after[i + c]) return false
  }
  return true
}

/** Reprojection keeps existing edits in their original world axes. Only this
 * one operation enters a layer-local native grid, then returns to that same
 * world surface. The caller must supply the complete layer bounds, not a
 * document crop or thumbnail; otherwise off-document input would be lost. */
export function* rasterizeWholeLayerFilterWorldSteps(input: WholeLayerFilterWorldInput): Generator<void, Uint8ClampedArray> {
  const { data, width, height, layerWidth, layerHeight, layerToPixel: m, operation } = input
  assertLayerFilterSize(width, height)
  if (!(data instanceof Uint8ClampedArray)) throw new Error('整层滤镜像素数据无效')
  const nativeWidth = Math.max(1, Math.round(layerWidth)), nativeHeight = Math.max(1, Math.round(layerHeight))
  assertWholeLayerFilterSize(nativeWidth, nativeHeight)
  const determinant = m.a * m.d - m.b * m.c
  if (![m.a, m.b, m.c, m.d, m.e, m.f, layerWidth, layerHeight].every(Number.isFinite) || layerWidth <= 0 || layerHeight <= 0 || Math.abs(determinant) < 1e-12 || data.length !== width * height * 4) throw new Error('整层滤镜图层变换无法确认')
  const context: WholeLayerFilterRasterInput = { ...input, filter: operation.filter }
  check(context)
  if (isNeutralWholeLayerFilter(operation.filter)) return data.slice()
  const local = new Uint8ClampedArray(nativeWidth * nativeHeight * 4)
  for (let y = 0; y < nativeHeight; y++) {
    check(context)
    for (let x = 0; x < nativeWidth; x++) {
      const lx = (x + .5) * layerWidth / nativeWidth, ly = (y + .5) * layerHeight / nativeHeight
      sampleWholeFilterPixel(data, width, height, m.a * lx + m.c * ly + m.e - .5, m.b * lx + m.d * ly + m.f - .5, local, (y * nativeWidth + x) * 4)
    }
    if (y % wholeLayerFilterLimits.tileRows === 0) yield
  }
  const filtered = yield* rasterizeWholeLayerFilterSteps({ data: local, width: nativeWidth, height: nativeHeight, filter: operation.filter, referenceSpace: operation.space, signal: input.signal, deadline: input.deadline })
  const output = data.slice()
  for (let y = 0; y < height; y++) {
    check(context)
    for (let x = 0; x < width; x++) {
      const dx = x + .5 - m.e, dy = y + .5 - m.f, lx = (m.d * dx - m.c * dy) / determinant, ly = (-m.b * dx + m.a * dy) / determinant
      const localX = lx * nativeWidth / layerWidth - .5, localY = ly * nativeHeight / layerHeight - .5
      // A view-space raster can contain older one-pixel brush detail which a
      // rotated local grid cannot represent. Unaffected areas retain the exact
      // original bytes; applying a small radial filter must not blur that prefix.
      if (outsideFilterEffect(operation.filter, nativeWidth, nativeHeight, localX, localY) || unchangedNeighborhood(local, filtered, nativeWidth, nativeHeight, localX, localY)) continue
      sampleWholeFilterPixel(filtered, nativeWidth, nativeHeight, localX, localY, output, (y * width + x) * 4)
    }
    if (y % wholeLayerFilterLimits.tileRows === 0) yield
  }
  check(context)
  return output
}
