/** Local filters replay at the original output resolution, including blur halo. No image,
 * credential or network access is accepted by this bounded pixel kernel. */
export const layerFilterLimits = { edge: 4356, pixels: 18_974_736, radius: 32, tileRows: 16 } as const

export function assertLayerFilterSize(width: number, height: number): void {
  if (![width, height].every((value) => Number.isInteger(value) && value > 0 && value <= layerFilterLimits.edge) || width * height > layerFilterLimits.pixels) throw new Error('局部滤镜画布超过安全容量，请缩小输出尺寸后重试')
}

interface LayerFilterRasterInput {
  data: Uint8ClampedArray
  coverage: Uint8ClampedArray
  width: number
  height: number
  radiusX: number
  radiusY: number
  strength: number
  mode: 'blur' | 'sharpen'
  signal?: AbortSignal
  deadline?: number
}

function check(input: LayerFilterRasterInput): void {
  if (input.signal?.aborted) throw new DOMException('已取消局部滤镜，原图层保留', 'AbortError')
  if (input.deadline !== undefined && Date.now() >= input.deadline) throw new Error('局部滤镜处理超时，请缩小图层或减少笔迹')
}

/** A separable box kernel uses premultiplied alpha. A stroke's union coverage
 * applies its strength once, independent of pointer sample density. Sharpen is
 * a bounded unsharp mask and preserves the existing alpha silhouette. Reads
 * always use the frozen pre-stroke pixels, never partially written output.
 * Rows are streamed: memory is O(width * radius), not a full Float64 image. */
export function* rasterizeLayerFilterSteps(input: LayerFilterRasterInput): Generator<{ top: number; height: number; data: Uint8ClampedArray }> {
  const { width, height, data, coverage, radiusX: rx, radiusY: ry, strength, mode } = input
  assertLayerFilterSize(width, height)
  if (data.length !== width * height * 4 || coverage.length !== data.length || ![rx, ry].every((value) => Number.isInteger(value) && value >= 1 && value <= layerFilterLimits.radius) || !Number.isFinite(strength) || strength < 0 || strength > 1 || !['blur', 'sharpen'].includes(mode)) throw new Error('局部滤镜像素或参数无效')
  check(input)
  const columns = width * 4, rows = new Map<number, Float64Array>(), sums = new Float64Array(columns)
  function horizontal(y: number): Float64Array {
    const existing = rows.get(y)
    if (existing) return existing
    const row = new Float64Array(columns), total = [0, 0, 0, 0], span = rx * 2 + 1
    function add(x: number, sign: number) {
      const index = (y * width + Math.max(0, Math.min(width - 1, x))) * 4, alpha = data[index + 3]
      for (let c = 0; c < 3; c++) total[c] += sign * data[index + c] * alpha / 255
      total[3] += sign * alpha
    }
    for (let x = -rx; x <= rx; x++) add(x, 1)
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 4; c++) row[x * 4 + c] = total[c] / span
      add(x - rx, -1); add(x + rx + 1, 1)
    }
    rows.set(y, row)
    return row
  }
  function addRow(y: number, sign: number) {
    const row = horizontal(Math.max(0, Math.min(height - 1, y)))
    for (let index = 0; index < columns; index++) sums[index] += row[index] * sign
  }
  for (let y = -ry; y <= ry; y++) { check(input); addRow(y, 1) }
  const span = ry * 2 + 1
  for (let top = 0; top < height; top += layerFilterLimits.tileRows) {
    const count = Math.min(layerFilterLimits.tileRows, height - top), tile = data.slice(top * columns, (top + count) * columns)
    for (let localY = 0; localY < count; localY++) {
      check(input)
      const y = top + localY
      for (let x = 0; x < width; x++) {
        const sourceIndex = (y * width + x) * 4, targetIndex = (localY * width + x) * 4, weight = coverage[sourceIndex + 3] / 255 * strength
        if (!weight) continue
        const originalAlpha = data[sourceIndex + 3], blurredAlpha = Math.max(0, sums[x * 4 + 3] / span)
        const alpha = mode === 'blur' ? originalAlpha * (1 - weight) + blurredAlpha * weight : originalAlpha
        tile[targetIndex + 3] = alpha
        for (let c = 0; c < 3; c++) {
          const original = data[sourceIndex + c], premultiplied = Math.max(0, sums[x * 4 + c] / span)
          tile[targetIndex + c] = mode === 'blur'
            ? alpha > 0 ? (original * originalAlpha * (1 - weight) + premultiplied * 255 * weight) / alpha : 0
            : originalAlpha > 0 ? original + (original - (blurredAlpha > 0 ? premultiplied * 255 / blurredAlpha : original)) * weight : 0
        }
      }
      if (y + 1 < height) {
        addRow(y - ry, -1); addRow(y + ry + 1, 1)
        for (const key of rows.keys()) if (key < Math.max(0, y + 1 - ry)) rows.delete(key)
      }
    }
    check(input)
    yield { top, height: count, data: tile }
  }
}
