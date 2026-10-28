import { parseImageLayerLiquifyOperation, type ImageLayerLiquifyOperation, type ImageLayerLiquifyStroke } from './layer-liquify'

export const layerLiquifyRasterLimits = { edge: 4356, pixels: 18_974_736, tileRows: 16, stamps: 2048, work: 128_000_000 } as const
export interface LayerLiquifyMatrix { a: number; b: number; c: number; d: number; e: number; f: number }
export interface LayerLiquifyRasterInput {
  data: Uint8ClampedArray
  width: number
  height: number
  operation: ImageLayerLiquifyOperation
  /** Continuous raster coordinates -> layer-local pixels, before normalization. */
  pixelToLayer?: LayerLiquifyMatrix
  layerWidth?: number
  layerHeight?: number
  signal?: AbortSignal
  deadline?: number
}
interface Stamp { x: number; y: number; dx: number; dy: number }
function check(input: LayerLiquifyRasterInput): void {
  if (input.signal?.aborted) throw new DOMException('已取消液化，原图层保留', 'AbortError')
  if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error('液化处理超时，请减少笔迹或缩小图层')
}
export function assertLayerLiquifySize(width: number, height: number): void {
  if (![width, height].every((v) => Number.isInteger(v) && v > 0 && v <= layerLiquifyRasterLimits.edge) || width * height > layerLiquifyRasterLimits.pixels) throw new Error('液化画布超过安全容量，请缩小输出尺寸')
}
function invert(m: LayerLiquifyMatrix): LayerLiquifyMatrix {
  const determinant = m.a * m.d - m.b * m.c
  if (!Object.values(m).every(Number.isFinite) || !Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) throw new Error('液化图层空间无效，请检查图层尺寸与缩放')
  return { a: m.d / determinant, b: -m.b / determinant, c: -m.c / determinant, d: m.a / determinant, e: (m.c * m.f - m.d * m.e) / determinant, f: (m.b * m.e - m.a * m.f) / determinant }
}
/** Uniform arc-length sampling makes event frequency irrelevant. Push integrates
 * the actual drag distance; radial tools apply one bounded stamp per spacing. */
function stamps(stroke: ImageLayerLiquifyStroke, space: { width: number; height: number }): Stamp[] {
  const points = stroke.points.map(([x, y]) => ({ x: x * space.width / 10000, y: y * space.height / 10000 })), step = Math.max(1, stroke.radius / 4)
  const result: Stamp[] = [], first = points[0]
  let previous = first, remaining = step
  if (stroke.tool !== 'push') result.push({ ...first, dx: 0, dy: 0 })
  for (let index = 1; index < points.length; index++) {
    let start = points[index - 1], distance = Math.hypot(points[index].x - start.x, points[index].y - start.y)
    const end = points[index]
    while (distance >= remaining && distance > 0) {
      const ratio = remaining / distance, point = { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio }
      result.push({ ...point, dx: point.x - previous.x, dy: point.y - previous.y })
      if (result.length > layerLiquifyRasterLimits.stamps) throw new Error('液化路径过长，请增大笔径或分次应用')
      previous = point; start = point; distance -= remaining; remaining = step
    }
    remaining -= distance
  }
  const last = points[points.length - 1]
  if (Math.hypot(last.x - previous.x, last.y - previous.y) > 1e-8) result.push({ ...last, dx: last.x - previous.x, dy: last.y - previous.y })
  if (result.length > layerLiquifyRasterLimits.stamps) throw new Error('液化路径过长，请增大笔径或分次应用')
  return result
}
function sample(data: Uint8ClampedArray, width: number, height: number, x: number, y: number, target: Uint8ClampedArray, at: number): void {
  const left = Math.floor(x), top = Math.floor(y), fx = x - left, fy = y - top
  let alpha = 0, red = 0, green = 0, blue = 0
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const sx = left + dx, sy = top + dy
    if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue
    const index = (sy * width + sx) * 4, weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy), a = data[index + 3] * weight
    alpha += a; red += data[index] * a; green += data[index + 1] * a; blue += data[index + 2] * a
  }
  target[at] = alpha > 0 ? red / alpha : 0; target[at + 1] = alpha > 0 ? green / alpha : 0; target[at + 2] = alpha > 0 ? blue / alpha : 0; target[at + 3] = alpha
}

/** Every stroke inverse-maps frozen previous pixels, with premultiplied alpha.
 * Only a complete returned image may be published. Input bytes stay untouched
 * on success, cancellation, timeout and budget failure. Memory is bounded by
 * the input and two RGBA buffers, never a full floating-point displacement map. */
export function* rasterizeLayerLiquifySteps(input: LayerLiquifyRasterInput): Generator<void, Uint8ClampedArray> {
  const { width, height, data } = input
  assertLayerLiquifySize(width, height); check(input)
  if (!(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) throw new Error('液化像素长度无效')
  const operation = parseImageLayerLiquifyOperation(input.operation), layerWidth = input.layerWidth ?? width, layerHeight = input.layerHeight ?? height
  if (![layerWidth, layerHeight].every((v) => Number.isFinite(v) && v > 0 && v <= 65536)) throw new Error('液化图层尺寸无效')
  const local = input.pixelToLayer ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }, sx = operation.space.width / layerWidth, sy = operation.space.height / layerHeight
  const toSpace = { a: local.a * sx, b: local.b * sy, c: local.c * sx, d: local.d * sy, e: local.e * sx, f: local.f * sy }, toPixel = invert(toSpace)
  let current = data, spare: Uint8ClampedArray | undefined, work = 0
  for (const stroke of operation.strokes) {
    check(input)
    if (!stroke.strength) continue
    const path = stamps(stroke, operation.space)
    if (!path.length) continue
    const radius = stroke.radius, radiusSquared = radius * radius
    let left = width, top = height, right = 0, bottom = 0
    for (const point of path) for (const dx of [-radius, radius]) for (const dy of [-radius, radius]) {
      const x = toPixel.a * (point.x + dx) + toPixel.c * (point.y + dy) + toPixel.e, y = toPixel.b * (point.x + dx) + toPixel.d * (point.y + dy) + toPixel.f
      left = Math.min(left, Math.floor(x)); right = Math.max(right, Math.ceil(x)); top = Math.min(top, Math.floor(y)); bottom = Math.max(bottom, Math.ceil(y))
    }
    left = Math.max(0, left); right = Math.min(width, right); top = Math.max(0, top); bottom = Math.min(height, bottom)
    work += Math.max(0, right - left) * Math.max(0, bottom - top) * path.length
    if (work > layerLiquifyRasterLimits.work) throw new Error('液化笔迹覆盖面积超过安全预算，请减少笔迹或分次应用')
    const output: Uint8ClampedArray = spare ?? new Uint8ClampedArray(data.length)
    output.set(current)
    for (let row = top; row < bottom; row += layerLiquifyRasterLimits.tileRows) {
      check(input)
      for (let y = row; y < Math.min(bottom, row + layerLiquifyRasterLimits.tileRows); y++) {
        check(input)
        for (let x = left; x < right; x++) {
          const px = x + .5, py = y + .5, originalX = toSpace.a * px + toSpace.c * py + toSpace.e, originalY = toSpace.b * px + toSpace.d * py + toSpace.f
          if (originalX < 0 || originalY < 0 || originalX > operation.space.width || originalY > operation.space.height) continue
          let qx = originalX, qy = originalY
          for (let index = path.length - 1; index >= 0; index--) {
            const point = path[index], dx = qx - point.x, dy = qy - point.y, squared = dx * dx + dy * dy
            if (squared >= radiusSquared) continue
            const weight = (1 - squared / radiusSquared) ** 2 * stroke.strength
            if (stroke.tool === 'push') { qx -= point.dx * weight; qy -= point.dy * weight }
            else if (stroke.tool === 'bulge' || stroke.tool === 'pinch') { const factor = 1 + (stroke.tool === 'bulge' ? -.35 : .35) * weight; qx = point.x + dx * factor; qy = point.y + dy * factor }
            else { const angle = (stroke.tool === 'twirl-cw' ? -1 : 1) * Math.PI / 8 * weight, cosine = Math.cos(angle), sine = Math.sin(angle); qx = point.x + dx * cosine - dy * sine; qy = point.y + dx * sine + dy * cosine }
          }
          if (Math.abs(qx - originalX) < 1e-12 && Math.abs(qy - originalY) < 1e-12) continue
          const sourceX = toPixel.a * qx + toPixel.c * qy + toPixel.e - .5, sourceY = toPixel.b * qx + toPixel.d * qy + toPixel.f - .5
          sample(current, width, height, sourceX, sourceY, output, (y * width + x) * 4)
        }
      }
      yield
    }
    spare = current === data ? undefined : current; current = output
  }
  check(input)
  return current === data ? data.slice() : current
}
