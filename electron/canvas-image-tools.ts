import type {
  CanvasImageCollageInputOrder,
  CanvasImageTransformKind,
  CanvasImageTransformRecipe,
  CanvasRunNodeKind,
  CanvasTileInputSelection,
} from './canvas-run-contract'

// 画布完善第 7 条第三步（#1397）：图片工具。跟网页版同一套分工（xingmang-canvas lib/canvas-runs.ts）：
// 运行到裁剪、拼图、平铺、图层合成时，主进程不处理像素，把「这几张图、这组参数」推给画布，内核在页面里
// 处理好交回 PNG，主进程核对张数、尺寸、总量再存。参数是画布自己写的，主进程不解读，只量大小、原样交回
// 同一个页面；内核的参数解析不搬进主进程，那是画布的代码，不在主进程里跑。

/** The kernel's processor (image-tools/recipe.ts imageTransformProcessorRevision); a change invalidates cached results. */
export const canvasImageTransformProcessorRevision = 'browser-image-v1' as const
/** The web host's limits (canvas-kernel lib/image-transform-contract.ts), so either host takes the same work. */
export const maximumCanvasImageTransformInputs = 20
export const maximumCanvasImageTransformOutputs = 16
export const maximumCanvasImageTransformBytes = 20 * 1024 * 1024
export const maximumCanvasImageTransformBatchBytes = 64 * 1024 * 1024
export const maximumCanvasImageTransformEdge = 4096
export const maximumCanvasImageTransformPixels = 16_777_216
export const maximumCanvasImageTransformBatchPixels = 33_554_432
export const maximumCanvasImageTransformRecipeBytes = 256 * 1024
/** The kernel walks a recipe this deep looking for layer groups (lib/layer-groups-contract.ts). */
const maximumRecipeDepth = 40
const maximumCollageOrderedInputs = 20
const maximumTileInputOutputs = 20

const imageTransformKinds: Readonly<Record<string, CanvasImageTransformKind>> = {
  'image-crop': 'crop',
  'image-collage': 'collage',
  'image-tile': 'tile',
  'image-layer': 'layer',
}

/** Image-tool node kinds whose pixels the page makes (all but compare and panorama, which pass images on). */
export function canvasImageTransformKindForNode(kind: CanvasRunNodeKind): CanvasImageTransformKind | null {
  return Object.prototype.hasOwnProperty.call(imageTransformKinds, kind) ? imageTransformKinds[kind] : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const forbiddenRecipeKey = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|secret|password)/i

/**
 * Plain JSON within the kernel's own depth, nothing that names a credential,
 * and no string the page could not have typed. Reports whether a layerGroups
 * key appears anywhere: the kernel then needs layerGroupsVersion 1.
 */
function assertPlainRecipeValue(value: unknown, budget: { remaining: number }, depth: number, found: { layerGroups: boolean }): void {
  budget.remaining -= 1
  if (budget.remaining < 0) throw new Error('工作流规模超过安全上限')
  if (depth > maximumRecipeDepth) throw new Error('画布图片处理配置格式错误')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('画布图片处理配置格式错误')
    return
  }
  if (typeof value === 'string') {
    if (value.length > 10_000 || value.includes('\0')) throw new Error('画布图片处理配置格式错误')
    budget.remaining -= value.length
    if (budget.remaining < 0) throw new Error('工作流规模超过安全上限')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 8_192) throw new Error('画布图片处理配置格式错误')
    for (const entry of value) assertPlainRecipeValue(entry, budget, depth + 1, found)
    return
  }
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('画布图片处理配置格式错误')
  const entries = Object.entries(value)
  if (entries.length > 256) throw new Error('画布图片处理配置格式错误')
  for (const [key, entry] of entries) {
    if (!key || key.length > 128 || forbiddenRecipeKey.test(key) || key === '__proto__') throw new Error('画布图片处理配置格式错误')
    if (key === 'layerGroups') found.layerGroups = true
    assertPlainRecipeValue(entry, budget, depth + 1, found)
  }
}

function outputEdge(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximumCanvasImageTransformEdge) {
    throw new Error(`画布图片处理${label}格式错误`)
  }
  return value as number
}

/**
 * What the desktop checks the page's pictures against. The recipe itself
 * stays opaque; only these numbers are read out of it.
 */
export interface CanvasImageTransformExpectation {
  count: number
  /** Absent where the page decides the size (automatic strips, and later grid splits). */
  size?: { width: number; height: number }
}

export interface ParsedCanvasImageTransformRecipe {
  recipe: CanvasImageTransformRecipe
  expectation: CanvasImageTransformExpectation
  layerGroups: boolean
}

/**
 * The recipe of a crop, collage, tile or layer node as the kernel wrote it,
 * kept as it came and bounded: at most 256 KB of JSON, the kernel's depth, the
 * graph's shared budget. Throws on anything else; the run is then refused as a
 * whole before any request, as with every other malformed field.
 */
export function parseCanvasImageTransformRecipe(kind: CanvasRunNodeKind, value: unknown, budget: { remaining: number }): ParsedCanvasImageTransformRecipe {
  const expectedKind = canvasImageTransformKindForNode(kind)
  if (!expectedKind) throw new Error('图片处理参数只能保存在图片工具节点中')
  if (!isRecord(value)) throw new Error('画布图片处理配置格式错误')
  const found = { layerGroups: false }
  assertPlainRecipeValue(value, budget, 0, found)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maximumCanvasImageTransformRecipeBytes) {
    throw new Error('图片处理参数超过 256 KB，请拆分图层节点后再运行')
  }
  if (value.kind !== expectedKind) throw new Error('图片处理参数与节点类型不匹配')
  const width = outputEdge(value.outputWidth, '输出宽度')
  const height = outputEdge(value.outputHeight, '输出高度')
  // xingmang-canvas image-tools/recipe.ts imageCollageUsesAutoSize: a strip
  // sized to its pictures, whose browser-decoded sizes the desktop cannot know.
  const automatic = expectedKind === 'collage' && value.autoSize === true && (value.layout === 'horizontal' || value.layout === 'vertical')
  return {
    recipe: structuredClone(value) as CanvasImageTransformRecipe,
    expectation: { count: 1, ...(automatic ? {} : { size: { width, height } }) },
    layerGroups: found.layerGroups,
  }
}

function edgeIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label}的连线或批次位置无效`)
  return value
}

function outputIndex(value: unknown, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) >= maximum) throw new Error(`${label}的连线或批次位置无效`)
  return value as number
}

/** xingmang-canvas image-tools/collage-input-order.ts parseImageCollageInputOrder. */
export function parseCanvasImageCollageInputOrder(value: unknown): CanvasImageCollageInputOrder {
  if (!isRecord(value)) throw new Error('拼图输入顺序格式不正确')
  if (Object.keys(value).some((key) => key !== 'version' && key !== 'slots')) throw new Error('拼图输入顺序格式不正确')
  if (value.version !== 1 || !Array.isArray(value.slots) || value.slots.length > maximumCollageOrderedInputs) throw new Error('拼图输入顺序最多保存 20 张图片')
  const seen = new Set<string>()
  const slots = value.slots.map((slot) => {
    if (!isRecord(slot) || Object.keys(slot).some((key) => key !== 'edgeId' && key !== 'outputIndex')) throw new Error('拼图输入位置格式不正确')
    const parsed = { edgeId: edgeIdentifier(slot.edgeId, '拼图输入'), outputIndex: outputIndex(slot.outputIndex, maximumCollageOrderedInputs, '拼图输入') }
    const key = JSON.stringify([parsed.edgeId, parsed.outputIndex])
    if (seen.has(key)) throw new Error('拼图输入顺序不能包含重复位置')
    seen.add(key)
    return parsed
  })
  return { version: 1, slots }
}

/** xingmang-canvas image-tools/tile-input.ts parseTileInput. */
export function parseCanvasTileInput(value: unknown): CanvasTileInputSelection {
  if (!isRecord(value)) throw new Error('平铺贴图选择格式不正确')
  if (value.missing === true && Object.keys(value).length === 1) return { missing: true }
  if (Object.keys(value).some((key) => key !== 'edgeId' && key !== 'outputIndex')) throw new Error('平铺贴图的连线或批次位置无效')
  return {
    edgeId: edgeIdentifier(value.edgeId, '平铺贴图'),
    outputIndex: value.outputIndex === undefined ? 0 : outputIndex(value.outputIndex, maximumTileInputOutputs, '平铺贴图'),
  }
}

/** One picture reaching a node, named the way the kernel names it: by connection and position. */
export interface CanvasImageToolSource<T> {
  edgeId: string
  outputIndex: number
  asset: T
}

/**
 * xingmang-canvas collage-input-order.ts orderCollageInputs: the slots the
 * user arranged come first, anything not arranged keeps its place after them.
 */
export function orderCanvasCollageSources<T>(sources: readonly CanvasImageToolSource<T>[], order: CanvasImageCollageInputOrder | undefined): CanvasImageToolSource<T>[] {
  if (!order) return [...sources]
  const rank = new Map(order.slots.map((slot, index) => [JSON.stringify([slot.edgeId, slot.outputIndex]), index]))
  return sources
    .map((source, index) => ({ source, index, rank: rank.get(JSON.stringify([source.edgeId, source.outputIndex])) ?? order.slots.length + index }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ source }) => source)
}

/**
 * xingmang-canvas tile-input.ts selectTileInputEdge: without a choice the
 * first connection, otherwise exactly the chosen one; a choice whose
 * connection is gone is an error, never a quiet fall back to another picture.
 */
export function selectCanvasTileSource<T>(sources: readonly CanvasImageToolSource<T>[], selection: CanvasTileInputSelection | undefined): CanvasImageToolSource<T> | null {
  if (selection === undefined) return sources[0] ?? null
  if ('missing' in selection) throw new Error('已选平铺贴图已移除，请重新选择贴图')
  if (!sources.some((source) => source.edgeId === selection.edgeId)) throw new Error('已选平铺贴图的连线已移除，请重新选择贴图')
  return sources.find((source) => source.edgeId === selection.edgeId && source.outputIndex === selection.outputIndex) ?? null
}
