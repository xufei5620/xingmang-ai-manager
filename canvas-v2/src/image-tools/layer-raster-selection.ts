/** Native-resolution pixel selections. This module has no DOM or renderer dependencies. */
export const maximumLayerRasterSelectionEdge = 4096
export const maximumLayerRasterSelectionPixels = 16_777_216
export const maximumLayerRasterSelectionRuns = 8192
export const maximumLayerRasterSelectionBytes = 60 * 1024
export const maximumLayerRasterOutlineEdge = 5384
export const maximumLayerRasterOutlinePixels = 4356 ** 2

export interface LayerRasterSelection { width: number; height: number; runs: number[] }
export interface LayerRasterSelectionOptions {
  signal?: AbortSignal
  /** Includes time spent yielding; callers may tighten, never expand, this limit. */
  maxMilliseconds?: number
  yieldControl?: () => Promise<void>
}
export interface LayerRasterColorInput {
  width: number
  height: number
  rgba: Uint8Array | Uint8ClampedArray
  seed: { x: number; y: number }
  /** An explicit RGBA sample for color-range previews, independent of the seed pixel. */
  color?: readonly [number, number, number, number]
  tolerance: number
  contiguous: boolean
  domain?: LayerRasterSelection
}
export interface LayerGeometricSelectionInput {
  width: number
  height: number
  kind: 'rectangle' | 'ellipse'
  rect: { x: number; y: number; width: number; height: number }
  inverted?: boolean
}
export interface LayerRasterOutlineInput {
  width: number
  height: number
  alpha: Uint8Array | Uint8ClampedArray
  widthPixels: number
  position: 'inside' | 'center' | 'outside'
}
export type LayerRasterCombineMode = 'replace' | 'add' | 'subtract' | 'intersect'

export class LayerRasterSelectionError extends Error {
  constructor(message: string, readonly code: 'invalid-input' | 'too-complex' | 'time-budget' | 'cancelled') {
    super(message)
    this.name = code === 'cancelled' ? 'AbortError' : 'LayerRasterSelectionError'
  }
}

function invalid(message: string): never { throw new LayerRasterSelectionError(message, 'invalid-input') }
function dimensions(width: number, height: number, halo = false): number {
  const maximum = halo ? maximumLayerRasterOutlineEdge : maximumLayerRasterSelectionEdge
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > maximum || height > maximum || width * height > (halo ? maximumLayerRasterOutlinePixels : maximumLayerRasterSelectionPixels)) invalid('像素选区尺寸无效或超过原图处理上限，请缩小画布后重试')
  return width * height
}
function bytes(value: unknown, count: number): asserts value is Uint8Array | Uint8ClampedArray {
  if (!(value instanceof Uint8Array || value instanceof Uint8ClampedArray) || value.length !== count) invalid('像素数据长度与图片尺寸不一致')
}
function clock(): number { return typeof performance === 'undefined' ? Date.now() : performance.now() }
function defaultYield(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)) }
function budget(options: LayerRasterSelectionOptions) {
  const maximum = options.maxMilliseconds ?? 10_000
  if (!Number.isFinite(maximum) || maximum < 1 || maximum > 10_000) invalid('像素操作时间预算必须在 1–10000 毫秒之间')
  const started = clock(), deadline = started + maximum
  let lastYield = started, remaining = 16_384
  function check() {
    if (options.signal?.aborted) throw new LayerRasterSelectionError('已取消像素选区操作，原选区已保留', 'cancelled')
    if (clock() > deadline) throw new LayerRasterSelectionError('像素选区计算超过时间限制，原选区已保留；请缩小范围后重试', 'time-budget')
  }
  check()
  return {
    check,
    tick(amount = 1): boolean { remaining -= amount; return remaining <= 0 },
    checkpoint() { remaining = 16_384; check() },
    async pause(force = false) {
      remaining = 16_384
      check()
      if (force || clock() - lastYield >= 8) {
        await (options.yieldControl ?? defaultYield)()
        lastYield = clock()
        check()
      }
    },
  }
}
type RasterBudget = ReturnType<typeof budget>

/** Canonical row-local RLE; reject over-budget masks instead of approximating them. */
export function assertLayerRasterSelection(value: LayerRasterSelection): void {
  if (!value || typeof value !== 'object') invalid('像素选区格式不正确')
  const count = dimensions(value.width, value.height)
  if (!Array.isArray(value.runs) || value.runs.length % 2 || value.runs.length > maximumLayerRasterSelectionRuns * 2) invalid('像素选区片段数量无效或超过上限')
  let end = -1, previousRow = -1
  for (let index = 0; index < value.runs.length; index += 2) {
    const offset = value.runs[index], length = value.runs[index + 1], row = Math.floor(offset / value.width)
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1 || offset + length > count || offset % value.width + length > value.width || offset < end || offset === end && row === previousRow) invalid('像素选区片段必须有序、不重叠、不跨行，并合并同行相邻片段')
    end = offset + length; previousRow = row
  }
  if (JSON.stringify(value).length > maximumLayerRasterSelectionBytes) throw new LayerRasterSelectionError('像素选区过于复杂，超过保存容量；请缩小选区或调整容差，系统不会降低图片分辨率', 'too-complex')
}
function builder(width: number, height: number) {
  const result: LayerRasterSelection = { width, height, runs: [] }
  let encoded = JSON.stringify(result).length
  return {
    append(offset: number, length: number) {
      if (!length) return
      const added = String(offset).length + String(length).length + (result.runs.length ? 2 : 1)
      if (result.runs.length >= maximumLayerRasterSelectionRuns * 2 || encoded + added > maximumLayerRasterSelectionBytes) throw new LayerRasterSelectionError('像素选区过于复杂，超过保存容量；请缩小选区或调整容差，系统不会降低图片分辨率', 'too-complex')
      encoded += added; result.runs.push(offset, length)
    },
    finish() { return result },
  }
}
async function decode(selection: LayerRasterSelection, work: RasterBudget): Promise<Uint8ClampedArray> {
  const mask = new Uint8ClampedArray(selection.width * selection.height)
  for (let index = 0; index < selection.runs.length; index += 2) {
    const offset = selection.runs[index], length = selection.runs[index + 1]
    mask.fill(255, offset, offset + length)
    if (work.tick(length)) await work.pause()
  }
  work.check()
  return mask
}
async function encode(mask: Uint8Array | Uint8ClampedArray, width: number, height: number, work: RasterBudget): Promise<LayerRasterSelection> {
  const result = builder(width, height)
  for (let y = 0; y < height; y++) {
    let start = -1
    for (let x = 0; x < width; x++) {
      const index = y * width + x
      if (mask[index] && start < 0) start = index
      if (!mask[index] && start >= 0) { result.append(start, index - start); start = -1 }
      if (work.tick()) await work.pause()
    }
    if (start >= 0) result.append(start, (y + 1) * width - start)
  }
  work.check()
  return result.finish()
}

/** Alpha and premultiplied channels use an inclusive maximum-channel tolerance. */
export async function selectLayerRasterColors(input: LayerRasterColorInput, options: LayerRasterSelectionOptions = {}): Promise<LayerRasterSelection> {
  const work = budget(options), count = dimensions(input.width, input.height)
  bytes(input.rgba, count * 4)
  if (!input.seed || !Number.isSafeInteger(input.seed.x) || !Number.isSafeInteger(input.seed.y) || input.seed.x < 0 || input.seed.y < 0 || input.seed.x >= input.width || input.seed.y >= input.height) invalid('取样点必须位于图片的有效像素内')
  if (!Number.isFinite(input.tolerance) || input.tolerance < 0 || input.tolerance > 255 || typeof input.contiguous !== 'boolean') invalid('颜色容差必须在 0–255 之间，并明确是否连续选择')
  if (input.color !== undefined && (!Array.isArray(input.color) || input.color.length !== 4 || !input.color.every((channel) => Number.isSafeInteger(channel) && channel >= 0 && channel <= 255))) invalid('取样颜色必须包含四个 0–255 的整数 RGBA 通道')
  if (input.domain) { assertLayerRasterSelection(input.domain); if (input.domain.width !== input.width || input.domain.height !== input.height) invalid('限制选区与图片尺寸不一致') }
  const domain = input.domain ? await decode(input.domain, work) : undefined
  const seed = input.seed.y * input.width + input.seed.x, offset = seed * 4
  if (input.contiguous && domain && !domain[seed]) return { width: input.width, height: input.height, runs: [] }
  const alpha = input.color?.[3] ?? input.rgba[offset + 3], red = (input.color?.[0] ?? input.rgba[offset]) * alpha, green = (input.color?.[1] ?? input.rgba[offset + 1]) * alpha, blue = (input.color?.[2] ?? input.rgba[offset + 2]) * alpha, threshold = input.tolerance * 255
  function matches(index: number): boolean {
    if (domain && !domain[index]) return false
    const at = index * 4, a = input.rgba[at + 3]
    return Math.abs(a - alpha) <= input.tolerance && Math.abs(input.rgba[at] * a - red) <= threshold && Math.abs(input.rgba[at + 1] * a - green) <= threshold && Math.abs(input.rgba[at + 2] * a - blue) <= threshold
  }
  if (input.contiguous && !matches(seed)) return { width: input.width, height: input.height, runs: [] }
  if (!input.contiguous) {
    const result = builder(input.width, input.height)
    for (let y = 0; y < input.height; y++) {
      let start = -1
      for (let x = 0; x < input.width; x++) {
        const index = y * input.width + x, selected = matches(index)
        if (selected && start < 0) start = index
        if (!selected && start >= 0) { result.append(start, index - start); start = -1 }
        if (work.tick()) await work.pause()
      }
      if (start >= 0) result.append(start, (y + 1) * input.width - start)
    }
    work.check(); return result.finish()
  }
  // Scanline flood fill avoids a four-byte queue entry for every image pixel.
  // Flags distinguish selected, queued, known matching and rejected pixels.
  const flags = new Uint8Array(count), stack: number[] = [seed]
  const selected = 1, queued = 2, matching = 4, rejected = 8
  flags[seed] = queued | matching
  function knownMatch(index: number): boolean {
    if (flags[index] & rejected) return false
    if (flags[index] & (matching | selected)) return true
    const yes = matches(index); flags[index] |= yes ? matching : rejected; return yes
  }
  let completedSpans = 0
  while (stack.length) {
    const point = stack.pop()!
    if (flags[point] & selected || !knownMatch(point)) continue
    const row = Math.floor(point / input.width), rowStart = row * input.width, rowEnd = rowStart + input.width
    let left = point, right = point + 1
    while (left > rowStart && !(flags[left - 1] & selected) && knownMatch(left - 1)) { left--; if (work.tick()) await work.pause() }
    while (right < rowEnd && !(flags[right] & selected) && knownMatch(right)) { right++; if (work.tick()) await work.pause() }
    flags.fill(selected, left, right)
    // A row interval can be split by previously filled intervals, so this is a
    // working-memory bound, not the persisted RLE count checked by encode().
    if (++completedSpans > maximumLayerRasterSelectionRuns * 4) throw new LayerRasterSelectionError('连续选区过于复杂，已停止计算并保留原选区；请调整容差或缩小范围', 'too-complex')
    for (const adjacent of [row - 1, row + 1]) {
      if (adjacent < 0 || adjacent >= input.height) continue
      let span = false
      for (let x = left - rowStart; x < right - rowStart; x++) {
        const index = adjacent * input.width + x
        if (flags[index] & (selected | queued) || !knownMatch(index)) span = false
        else { if (!span) stack.push(index); flags[index] |= queued; span = true }
        if (work.tick()) await work.pause()
      }
    }
    if (stack.length > maximumLayerRasterSelectionRuns * 4) throw new LayerRasterSelectionError('连续选区过于复杂，已停止计算并保留原选区；请调整容差或缩小范围', 'too-complex')
  }
  // Non-selected flags encode matching candidates, not selected coverage.
  for (let index = 0; index < flags.length; index++) { flags[index] &= selected; if (work.tick()) await work.pause() }
  return encode(flags, input.width, input.height, work)
}

export async function rasterizeLayerGeometricSelection(input: LayerGeometricSelectionInput, options: LayerRasterSelectionOptions = {}): Promise<LayerRasterSelection> {
  const work = budget(options); dimensions(input.width, input.height)
  const rect = input.rect
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || !['rectangle', 'ellipse'].includes(input.kind) || input.inverted !== undefined && typeof input.inverted !== 'boolean') invalid('几何选区范围不正确')
  const result = builder(input.width, input.height)
  for (let y = 0; y < input.height; y++) {
    let start = -1
    for (let x = 0; x < input.width; x++) {
      const px = (x + 0.5 - rect.x) / rect.width, py = (y + 0.5 - rect.y) / rect.height
      const inside = input.kind === 'rectangle' ? px >= 0 && px < 1 && py >= 0 && py < 1 : (px - 0.5) ** 2 + (py - 0.5) ** 2 <= 0.25
      const selected = input.inverted ? !inside : inside, index = y * input.width + x
      if (selected && start < 0) start = index
      if (!selected && start >= 0) { result.append(start, index - start); start = -1 }
      if (work.tick()) await work.pause()
    }
    if (start >= 0) result.append(start, (y + 1) * input.width - start)
  }
  work.check(); return result.finish()
}

export async function combineLayerRasterSelections(a: LayerRasterSelection, b: LayerRasterSelection, mode: LayerRasterCombineMode, options: LayerRasterSelectionOptions = {}): Promise<LayerRasterSelection> {
  const work = budget(options); assertLayerRasterSelection(a); assertLayerRasterSelection(b)
  if (a.width !== b.width || a.height !== b.height || !['replace', 'add', 'subtract', 'intersect'].includes(mode)) invalid('选区运算类型或图片尺寸不一致')
  if (mode === 'replace') { work.check(); return { ...b, runs: [...b.runs] } }
  const left = await decode(a, work), right = await decode(b, work)
  for (let index = 0; index < left.length; index++) {
    left[index] = mode === 'add' ? left[index] || right[index] : mode === 'subtract' ? left[index] && !right[index] ? 255 : 0 : left[index] && right[index] ? 255 : 0
    if (work.tick()) await work.pause()
  }
  return encode(left, a.width, a.height, work)
}

export async function invertLayerRasterSelection(selection: LayerRasterSelection, options: LayerRasterSelectionOptions = {}): Promise<LayerRasterSelection> {
  const work = budget(options); assertLayerRasterSelection(selection)
  const mask = await decode(selection, work)
  for (let index = 0; index < mask.length; index++) { mask[index] = 255 - mask[index]; if (work.tick()) await work.pause() }
  return encode(mask, selection.width, selection.height, work)
}

/** Separable square-neighborhood min/max filtering with transparent image borders. */
function* morphologySteps(alpha: Uint8Array | Uint8ClampedArray, width: number, height: number, radius: number, dilate: boolean, work: RasterBudget): Generator<void, Uint8ClampedArray> {
  if (radius === 0) return new Uint8ClampedArray(alpha)
  const intermediate = new Uint8ClampedArray(alpha.length), result = new Uint8ClampedArray(alpha.length)
  for (const horizontal of [true, false]) {
    const source = horizontal ? alpha : intermediate, target = horizontal ? intermediate : result
    const lines = horizontal ? height : width, length = horizontal ? width : height, deque = new Int32Array(length)
    for (let line = 0; line < lines; line++) {
      let head = 0, tail = 0, added = -1
      function at(index: number): number { return horizontal ? line * width + index : index * width + line }
      for (let position = 0; position < length; position++) {
        const end = Math.min(length - 1, position + radius)
        while (added < end) {
          added++
          const value = source[at(added)]
          while (tail > head && (dilate ? source[at(deque[tail - 1])] <= value : source[at(deque[tail - 1])] >= value)) tail--
          deque[tail++] = added
        }
        while (head < tail && deque[head] < position - radius) head++
        target[at(position)] = !dilate && (position - radius < 0 || position + radius >= length) ? 0 : source[at(deque[head])]
        if (work.tick()) { work.checkpoint(); yield }
      }
    }
  }
  work.check(); return result
}

export async function resizeLayerRasterSelection(selection: LayerRasterSelection, amount: number, options: LayerRasterSelectionOptions = {}): Promise<LayerRasterSelection> {
  const work = budget(options); assertLayerRasterSelection(selection)
  if (!Number.isSafeInteger(amount) || Math.abs(amount) > 64) invalid('像素选区扩展或收缩距离必须是 -64–64 之间的整数')
  if (!amount) return { ...selection, runs: [...selection.runs] }
  const mask = await decode(selection, work)
  return encode(await consumeSteps(morphologySteps(mask, selection.width, selection.height, Math.abs(amount), amount > 0, work), work), selection.width, selection.height, work)
}

async function consumeSteps(steps: Generator<void, Uint8ClampedArray>, work: RasterBudget): Promise<Uint8ClampedArray> {
  try {
    let next = steps.next()
    while (!next.done) { await work.pause(); next = steps.next() }
    work.check()
    return next.value
  } finally { steps.return(new Uint8ClampedArray(0)) }
}

function* integerOutlineSteps(input: LayerRasterOutlineInput, widthPixels: number, work: RasterBudget): Generator<void, Uint8ClampedArray> {
  if (widthPixels === 0) return new Uint8ClampedArray(input.alpha.length)
  const outside = input.position === 'inside' ? 0 : input.position === 'outside' ? widthPixels : Math.ceil(widthPixels / 2)
  const inside = input.position === 'outside' ? 0 : input.position === 'inside' ? widthPixels : Math.floor(widthPixels / 2)
  const result = yield* morphologySteps(input.alpha, input.width, input.height, outside, true, work)
  const contracted = inside ? yield* morphologySteps(input.alpha, input.width, input.height, inside, false, work) : input.alpha
  for (let index = 0; index < result.length; index++) {
    result[index] = Math.max(0, result[index] - contracted[index])
    if (work.tick()) { work.checkpoint(); yield }
  }
  work.check()
  return result
}

function* outlineSteps(input: LayerRasterOutlineInput, work: RasterBudget): Generator<void, Uint8ClampedArray> {
  const count = dimensions(input.width, input.height, true)
  bytes(input.alpha, count)
  if (!Number.isFinite(input.widthPixels) || input.widthPixels <= 0 || input.widthPixels > 512 || !['inside', 'center', 'outside'].includes(input.position)) invalid('描边计算宽度必须大于 0 且不超过 512 像素，并选择内部、居中或外部位置')
  // Preview scaling can make a recipe width fractional. Interpolating integer
  // masks keeps a subpixel preview stroke from becoming a full opaque pixel.
  const lower = Math.floor(input.widthPixels), fraction = input.widthPixels - lower
  const result = yield* integerOutlineSteps(input, lower, work)
  if (fraction > 0) {
    const upper = yield* integerOutlineSteps(input, lower + 1, work)
    for (let index = 0; index < count; index++) {
      result[index] += (upper[index] - result[index]) * fraction
      if (work.tick()) { work.checkpoint(); yield }
    }
  }
  work.check()
  return result
}

/** Odd centered widths put their extra pixel outside; existing alpha is preserved. */
export function* buildLayerRasterOutlineSteps(input: LayerRasterOutlineInput, options: LayerRasterSelectionOptions = {}): Generator<void, Uint8ClampedArray> {
  return yield* outlineSteps(input, budget(options))
}

/** For existing synchronous previews; still enforces abort and a bounded deadline. */
export function buildLayerRasterOutlineSync(input: LayerRasterOutlineInput, options: LayerRasterSelectionOptions = {}): Uint8ClampedArray {
  const steps = buildLayerRasterOutlineSteps(input, options)
  let next = steps.next()
  while (!next.done) next = steps.next()
  return next.value
}

export async function buildLayerRasterOutline(input: LayerRasterOutlineInput, options: LayerRasterSelectionOptions = {}): Promise<Uint8ClampedArray> {
  const work = budget(options)
  return consumeSteps(outlineSteps(input, work), work)
}
