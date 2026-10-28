import { canonicalColorLutSampleCount, decodeColorLutTable, encodeColorLutTable, type ColorLutTable, type ColorLutWorkOptions } from './layer-color-lut'
import { colorLutSelectionIsActive, colorLutSourceKey, parseColorLutSelection, type AssetColorLutSource, type ColorLutSelection } from './layer-color-lut-selection'
import { parseImageTransformRecipe, type ImageLayerRecipe } from './recipe'

export type PreparedColorLutTables = ReadonlyMap<string, ColorLutTable>
export type ColorLutResourceLoader = (source: AssetColorLutSource, signal: AbortSignal) => Promise<ColorLutTable>

function abortError(): Error { return new DOMException('已取消 LUT 资源准备，当前作品保留', 'AbortError') }
function check(options: ColorLutWorkOptions): void {
  if (options.signal?.aborted) throw abortError()
  if (options.deadline !== undefined && (!Number.isFinite(options.deadline) || Date.now() >= options.deadline)) throw new Error('LUT 资源准备超时，请重新载入')
}
function sameMetadata(table: ColorLutTable, source: AssetColorLutSource): boolean {
  return table.name === source.name && Array.isArray(table.domainMin) && Array.isArray(table.domainMax) && table.domainMin.length === 3 && table.domainMax.length === 3 && source.domainMin.every((entry, at) => entry === table.domainMin[at]) && source.domainMax.every((entry, at) => entry === table.domainMax[at])
}
function activeSources(recipe: ImageLayerRecipe): Map<string, AssetColorLutSource> {
  const parsed = parseImageTransformRecipe(recipe)
  if (parsed.kind !== 'layer') throw new Error('LUT 资源准备需要完整的图层配方')
  const sources = new Map<string, AssetColorLutSource>()
  for (const layer of parsed.layers) {
    if (!colorLutSelectionIsActive(layer.colorGrade?.lut)) continue
    const source = layer.colorGrade!.lut!.source
    if (source.kind !== 'asset') continue
    const key = colorLutSourceKey(source), previous = sources.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) throw new Error('同一 LUT 资源的名称或输入范围不一致，请重新载入')
    sources.set(key, source)
  }
  return sources
}
function cloneTable(table: ColorLutTable, source: AssetColorLutSource, options: ColorLutWorkOptions): ColorLutTable {
  if (!table || !sameMetadata(table, source)) throw new Error('LUT 资源名称或输入范围与当前选择不匹配，请重新载入')
  return decodeColorLutTable(encodeColorLutTable(table, options), { name: source.name, domainMin: source.domainMin, domainMax: source.domainMax }, options)
}

/** This map is pixel preparation, never a substitute for owner/digest checks
 * in the host loader. Active resources cannot silently fall back to no LUT. */
export function getPreparedColorLutTable(value: ColorLutSelection | undefined, tables?: PreparedColorLutTables): ColorLutTable | undefined {
  if (value === undefined) return undefined
  const selection = parseColorLutSelection(value)
  if (!colorLutSelectionIsActive(selection) || selection.source.kind === 'builtin') return undefined
  if (!tables || typeof tables.get !== 'function') throw new Error('当前图层的 LUT 资源尚未准备完成，不会忽略调色后继续')
  const table = tables.get(colorLutSourceKey(selection.source))
  if (!table) throw new Error('当前图层的 LUT 资源尚未准备完成，不会忽略调色后继续')
  if (!sameMetadata(table, selection.source)) throw new Error('当前图层的 LUT 资源名称或输入范围不匹配，请重新载入')
  if (table.version !== 1 || table.size !== 33 || !(table.data instanceof Float32Array) || table.data.length !== canonicalColorLutSampleCount || !table.data.every((entry) => Number.isFinite(entry) && entry >= -16 && entry <= 16)) throw new Error('当前图层的 LUT 表格数据无效，请重新载入')
  return table
}

/** Capture a job's explicitly supplied resources before the first image decode
 * or yield. A caller changing its map/typed arrays cannot alter a queued job. */
export function snapshotLayerColorLutTables(recipe: ImageLayerRecipe, tables?: PreparedColorLutTables, options: ColorLutWorkOptions = {}): PreparedColorLutTables {
  check(options)
  const result = new Map<string, ColorLutTable>()
  for (const [key, source] of activeSources(recipe)) {
    check(options)
    const selection: ColorLutSelection = { version: 1, enabled: true, strength: 100, source }
    result.set(key, cloneTable(getPreparedColorLutTable(selection, tables)!, source, options))
  }
  check(options)
  return result
}

function bounded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false
    function abort(): void { if (settled) return; settled = true; signal.removeEventListener('abort', abort); reject(signal.reason instanceof Error ? signal.reason : abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    void pending.then((value) => {
      if (settled) return
      settled = true; signal.removeEventListener('abort', abort); resolve(value)
    }, (error: unknown) => { if (!settled) { settled = true; signal.removeEventListener('abort', abort); reject(error) } })
  })
}

/** Sequential, at most twenty unique tables per validated layer document.
 * There is no cross-job/global resource cache. Even an ignoring loader cannot
 * publish a late result after cancellation or the bounded overall deadline. */
export async function prepareLayerColorLuts(recipe: ImageLayerRecipe, loader: ColorLutResourceLoader, options: ColorLutWorkOptions = {}): Promise<PreparedColorLutTables> {
  check(options)
  if (typeof loader !== 'function') throw new Error('LUT 资源读取入口不可用，请重新打开作品')
  const sources = activeSources(recipe), result = new Map<string, ColorLutTable>(), controller = new AbortController(), deadline = options.deadline ?? Date.now() + 30_000
  function abort(): void { controller.abort(abortError()) }
  options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('LUT 资源准备超时，请重新载入')), Math.min(2_147_483_647, Math.max(0, deadline - Date.now())))
  try {
    if (options.signal?.aborted) abort()
    for (const [key, source] of sources) {
      check({ signal: controller.signal, deadline })
      const requested = { ...source, domainMin: [...source.domainMin] as AssetColorLutSource['domainMin'], domainMax: [...source.domainMax] as AssetColorLutSource['domainMax'] }
      const table = await bounded(loader(requested, controller.signal), controller.signal)
      check({ signal: controller.signal, deadline })
      result.set(key, cloneTable(table, source, { signal: controller.signal, deadline }))
    }
    check({ signal: controller.signal, deadline })
    return result
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
}
