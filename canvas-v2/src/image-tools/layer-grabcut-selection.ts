import { assertLayerRasterSelection, LayerRasterSelectionError, maximumLayerRasterSelectionEdge, maximumLayerRasterSelectionRuns, type LayerRasterSelection, type LayerRasterSelectionOptions } from './layer-raster-selection'

export const maximumLayerGrabCutPixels = 1_000_000
export const maximumLayerGrabCutStrokes = 128
export const maximumLayerGrabCutPoints = 4096
export const layerGrabCutIterations = 3
export interface LayerGrabCutRegion { x: number; y: number; width: number; height: number }
export interface LayerGrabCutPoint { x: number; y: number }
export interface LayerGrabCutStroke { mode: 'foreground' | 'background'; diameter: number; points: readonly LayerGrabCutPoint[] }
export interface LayerGrabCutInput {
  data: Uint8Array | Uint8ClampedArray
  width: number
  height: number
  region: LayerGrabCutRegion
  strokes: readonly LayerGrabCutStroke[]
}
export interface LayerGrabCutPreparedInput {
  width: number
  height: number
  region: LayerGrabCutRegion
  /** Only the explicit native-resolution region crosses into the worker. */
  rgba: Uint8Array
  /** OpenCV GrabCut classes: background 0, foreground 1, probable background 2, probable foreground 3. */
  labels: Uint8Array
}
export interface LayerGrabCutProgress { phase: 'preparing' | 'loading' | 'segmenting' | 'encoding'; iteration?: number; total?: number }

function invalid(message: string): never { throw new LayerRasterSelectionError(message, 'invalid-input') }
function dimensions(width: number, height: number): void {
  if (![width, height].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= maximumLayerRasterSelectionEdge)) invalid('前景分割画布尺寸无效，最长边不能超过 4096 像素')
}
function clock(): number { return typeof performance === 'undefined' ? Date.now() : performance.now() }
function createBudget(options: LayerRasterSelectionOptions) {
  const maximum = options.maxMilliseconds ?? 10_000
  if (!Number.isFinite(maximum) || maximum < 1 || maximum > 10_000) invalid('前景分割准备时间上限必须在 1–10000 毫秒之间')
  const deadline = clock() + maximum
  let remaining = 8192, lastYield = clock()
  function check() {
    if (options.signal?.aborted) throw new LayerRasterSelectionError('已取消前景分割，原选区已保留', 'cancelled')
    if (clock() > deadline) throw new LayerRasterSelectionError('前景分割准备超过时间限制，请缩小处理框或减少笔触', 'time-budget')
  }
  check()
  return {
    check,
    tick(amount = 1) { remaining -= amount; return remaining <= 0 },
    async pause() {
      remaining = 8192; check()
      if (clock() - lastYield >= 8) {
        await (options.yieldControl?.() ?? new Promise<void>((resolve) => setTimeout(resolve, 0)))
        lastYield = clock(); check()
      }
    },
  }
}

/** Expand a user-drawn in-bounds frame to whole pixels; never resize its content. */
export function normalizeLayerGrabCutRegion(region: LayerGrabCutRegion, output: { width: number; height: number }): LayerGrabCutRegion {
  dimensions(output.width, output.height)
  if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite) || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > output.width || region.y + region.height > output.height) invalid('请在画布内框选前景范围，并在物体周围留出背景边缘')
  const x = Math.floor(region.x), y = Math.floor(region.y), width = Math.ceil(region.x + region.width) - x, height = Math.ceil(region.y + region.height) - y
  if (width < 3 || height < 3) invalid('前景处理框至少需要 3 × 3 像素，请扩大范围并留出背景边缘')
  if (width * height > maximumLayerGrabCutPixels) throw new LayerRasterSelectionError('前景处理框超过 100 万原始像素，请缩小框选范围；系统不会降低图片分辨率', 'too-complex')
  return { x, y, width, height }
}

function validateStrokes(strokes: readonly LayerGrabCutStroke[], width: number, height: number): void {
  if (!Array.isArray(strokes) || strokes.length > maximumLayerGrabCutStrokes) invalid('前景修正笔触不能超过 128 笔')
  let points = 0
  for (const stroke of strokes) {
    if (!stroke || !['foreground', 'background'].includes(stroke.mode) || !Number.isFinite(stroke.diameter) || stroke.diameter < 1 || stroke.diameter > 512 || !Array.isArray(stroke.points) || stroke.points.length < 1) invalid('前景修正笔触格式不正确，笔径应为 1–512 原始像素')
    points += stroke.points.length
    if (points > maximumLayerGrabCutPoints) throw new LayerRasterSelectionError('前景修正轨迹超过 4096 个点，请减少笔触后重试', 'too-complex')
    for (const point of stroke.points) if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.y < 0 || point.x > width || point.y > height) invalid('前景修正笔触必须位于原始画布范围内')
  }
}

/** Builds hard/soft GrabCut labels from a bounded frame and continuous brush capsules. */
export async function prepareLayerGrabCutInput(input: LayerGrabCutInput, options: LayerRasterSelectionOptions = {}): Promise<LayerGrabCutPreparedInput> {
  const work = createBudget(options)
  if (!input || typeof input !== 'object') invalid('前景分割输入不正确')
  dimensions(input.width, input.height)
  if (!(input.data instanceof Uint8Array || input.data instanceof Uint8ClampedArray) || input.data.length !== input.width * input.height * 4) invalid('前景分割像素长度与原图尺寸不一致')
  const region = normalizeLayerGrabCutRegion(input.region, input)
  validateStrokes(input.strokes, input.width, input.height)
  const count = region.width * region.height, rgba = new Uint8Array(count * 4), labels = new Uint8Array(count)
  function background(x: number, y: number, at: number): boolean { return x === 0 || y === 0 || x === region.width - 1 || y === region.height - 1 || rgba[at * 4 + 3] === 0 }
  for (let y = 0; y < region.height; y++) {
    const start = ((region.y + y) * input.width + region.x) * 4
    rgba.set(input.data.subarray(start, start + region.width * 4), y * region.width * 4)
    for (let x = 0; x < region.width; x++) {
      const at = y * region.width + x
      labels[at] = background(x, y, at) ? 0 : 3
      if (work.tick()) await work.pause()
    }
  }
  for (const stroke of input.strokes) {
    const radius = stroke.diameter / 2
    for (let index = 0; index < Math.max(1, stroke.points.length - 1); index++) {
      const a = stroke.points[index], b = stroke.points[Math.min(index + 1, stroke.points.length - 1)]
      const left = Math.max(1, Math.floor(Math.min(a.x, b.x) - radius - region.x)), top = Math.max(1, Math.floor(Math.min(a.y, b.y) - radius - region.y))
      const right = Math.min(region.width - 2, Math.ceil(Math.max(a.x, b.x) + radius - region.x)), bottom = Math.min(region.height - 2, Math.ceil(Math.max(a.y, b.y) + radius - region.y))
      const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy
      for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
        const px = region.x + x + 0.5 - a.x, py = region.y + y + 0.5 - a.y
        const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0
        const at = y * region.width + x
        if ((px - t * dx) ** 2 + (py - t * dy) ** 2 <= radius * radius && !background(x, y, at)) labels[at] = stroke.mode === 'foreground' ? 1 : 0
        if (work.tick()) await work.pause()
      }
    }
  }
  let foreground = false
  for (let index = 0; index < labels.length; index++) { if (labels[index] === 1 || labels[index] === 3) foreground = true; if (work.tick()) await work.pause() }
  if (!foreground) invalid('处理框内没有可分割的非透明前景，请调整框选或排除笔触')
  work.check()
  return { width: input.width, height: input.height, region, rgba, labels }
}

export function assertLayerGrabCutPreparedInput(input: LayerGrabCutPreparedInput): void {
  if (!input || typeof input !== 'object') invalid('前景分割工作数据不正确')
  const region = normalizeLayerGrabCutRegion(input.region, input), count = region.width * region.height
  if (Object.keys(region).some((key) => region[key as keyof LayerGrabCutRegion] !== input.region[key as keyof LayerGrabCutRegion]) || !(input.rgba instanceof Uint8Array) || input.rgba.length !== count * 4 || !(input.labels instanceof Uint8Array) || input.labels.length !== count) invalid('前景分割工作区尺寸与像素不一致')
  let foreground = false, background = false
  for (let index = 0; index < count; index++) {
    const label = input.labels[index], x = index % region.width, y = Math.floor(index / region.width)
    if (label > 3 || ((x === 0 || y === 0 || x === region.width - 1 || y === region.height - 1 || input.rgba[index * 4 + 3] === 0) && label !== 0)) invalid('前景分割边缘或透明像素标签不正确')
    foreground ||= label === 1 || label === 3; background ||= label === 0 || label === 2
  }
  if (!foreground || !background) invalid('前景分割需要同时包含前景和背景样本')
}

/** Encode the exact worker result into the existing full-document RLE contract. */
export async function encodeLayerGrabCutSelection(input: Pick<LayerGrabCutPreparedInput, 'width' | 'height' | 'region'>, mask: Uint8Array, options: LayerRasterSelectionOptions = {}): Promise<LayerRasterSelection> {
  const work = createBudget(options), region = normalizeLayerGrabCutRegion(input.region, input)
  if (!(mask instanceof Uint8Array) || mask.length !== region.width * region.height) invalid('前景分割结果尺寸不正确')
  const result: LayerRasterSelection = { width: input.width, height: input.height, runs: [] }
  function append(start: number, end: number, row: number) {
    if (result.runs.length >= maximumLayerRasterSelectionRuns * 2) throw new LayerRasterSelectionError('前景边界过于复杂，超过选区保存上限；请缩小范围或修正背景，原选区已保留', 'too-complex')
    result.runs.push((region.y + row) * input.width + region.x + start, end - start)
  }
  for (let y = 0; y < region.height; y++) {
    let start = -1
    for (let x = 0; x < region.width; x++) {
      const value = mask[y * region.width + x]
      if (value !== 0 && value !== 1) invalid('前景分割结果必须是完整二值选区')
      if (value && start < 0) start = x
      if (!value && start >= 0) { append(start, x, y); start = -1 }
      if (work.tick()) await work.pause()
    }
    if (start >= 0) append(start, region.width, y)
  }
  work.check()
  try { assertLayerRasterSelection(result) } catch (cause) {
    if (cause instanceof LayerRasterSelectionError && cause.code === 'too-complex') throw new LayerRasterSelectionError('前景边界过于复杂，超过选区保存容量；请缩小范围或修正背景，原选区已保留', 'too-complex')
    throw cause
  }
  return result
}
