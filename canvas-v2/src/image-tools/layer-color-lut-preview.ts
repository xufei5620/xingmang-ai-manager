import { useEffect, useRef, useState } from 'react'
import { hostBridge, type CanvasHostBridge } from '../host'
import { colorLutSelectionIsActive, colorLutSourceKey, parseColorLutSelection, type AssetColorLutSource } from './layer-color-lut-selection'
import { getPreparedColorLutTable, prepareLayerColorLuts, type PreparedColorLutTables } from './layer-color-lut-runtime'
import type { ImageLayerRecipe } from './recipe'

export interface LayerColorLutPreviewState { tables?: PreparedColorLutTables; busy: boolean; error: string; retry(): void }
type LutPreviewBridge = Pick<CanvasHostBridge, 'readColorLut' | 'getProjectAccess' | 'onProjectAccessChange'>
type AccessState = ReturnType<NonNullable<CanvasHostBridge['getProjectAccess']>>
interface PreviewState { key: string; tables?: PreparedColorLutTables; busy: boolean; error: string }

function activeSources(recipe: ImageLayerRecipe): AssetColorLutSource[] {
  const values = new Map<string, AssetColorLutSource>()
  for (const layer of recipe.layers) {
    if (layer.colorGrade?.lut === undefined) continue
    const selection = parseColorLutSelection(layer.colorGrade.lut)
    if (!colorLutSelectionIsActive(selection) || selection.source.kind !== 'asset') continue
    const key = colorLutSourceKey(selection.source), previous = values.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(selection.source)) throw new Error('同一 LUT 资源的配置不一致，请重新载入')
    values.set(key, selection.source)
  }
  return [...values.values()].sort((a, b) => colorLutSourceKey(a).localeCompare(colorLutSourceKey(b)))
}
export function layerColorLutPreviewSignature(recipe: ImageLayerRecipe): string { return JSON.stringify(activeSources(recipe)) }
function accessKey(state: AccessState): string { return JSON.stringify([state?.projectId ?? null, state?.access?.accessVersion ?? null, state?.denied === true]) }
function message(cause: unknown): string { return cause instanceof Error ? cause.message : 'LUT 资源加载失败，请重试' }
function previewBridge(): LutPreviewBridge { return typeof window === 'undefined' ? {} : hostBridge() }

/** One mounted preview owns one source-keyed cache. Public controller methods
 * are also the real hook's event path, so cancellation/access races can be
 * exercised without a browser DOM or replacing the pixel implementation. */
export function createLayerColorLutPreviewSession(bridge: () => LutPreviewBridge, changed: () => void) {
  const empty = new Map<string, import('./layer-color-lut').ColorLutTable>()
  let current: PreviewState | null = null, generation = 0, controller: AbortController | undefined, stop: (() => void) | undefined, disposed = false
  let knownAccess = accessKey(bridge().getProjectAccess?.() ?? null)
  let last: { recipe: ImageLayerRecipe; supplied?: PreparedColorLutTables; skip: boolean } | undefined
  function key(recipe: ImageLayerRecipe): string {
    let signature: string
    try { signature = layerColorLutPreviewSignature(recipe) } catch (cause) { signature = `invalid:${message(cause)}` }
    return JSON.stringify([accessKey(bridge().getProjectAccess?.() ?? null), signature])
  }
  function cancel(): void { generation++; controller?.abort(); controller = undefined }
  function snapshot(recipe: ImageLayerRecipe, supplied?: PreparedColorLutTables, skip = false): Omit<LayerColorLutPreviewState, 'retry'> {
    try {
      const sources = activeSources(recipe)
      if (!sources.length) return { tables: supplied ?? empty, busy: false, error: '' }
      if (bridge().getProjectAccess?.()?.denied) return { busy: false, error: '当前项目访问权限已失效，LUT 预览不可用' }
      if (supplied !== undefined) {
        for (const source of sources) getPreparedColorLutTable({ version: 1, enabled: true, strength: 100, source }, supplied)
        return { tables: supplied, busy: false, error: '' }
      }
      if (skip) return { busy: true, error: '' }
      const expected = key(recipe)
      return current?.key === expected ? { tables: current.tables, busy: current.busy, error: current.error } : { busy: true, error: '' }
    } catch (cause) { return { busy: false, error: message(cause) } }
  }
  function update(recipe: ImageLayerRecipe, supplied?: PreparedColorLutTables, skip = false, force = false): void {
    if (disposed) return
    last = { recipe, supplied, skip }
    const expected = key(recipe)
    knownAccess = accessKey(bridge().getProjectAccess?.() ?? null)
    if (!force && current?.key === expected && supplied === undefined && !skip) return
    cancel()
    const initial = snapshot(recipe, supplied, true)
    if (!initial.busy || supplied !== undefined || skip) { current = { key: expected, ...initial }; changed(); return }
    current = { key: expected, busy: true, error: '' }; changed()
    const request = generation, capturedAccess = accessKey(bridge().getProjectAccess?.() ?? null), host = bridge(), active = new AbortController(); controller = active
    if (!host.readColorLut) { current = { key: expected, busy: false, error: '当前页面无法加载 LUT 资源，请刷新页面后重试' }; changed(); return }
    void prepareLayerColorLuts(recipe, async (source, signal) => {
      const result = await host.readColorLut!(source, signal)
      return result.table
    }, { signal: active.signal }).then((tables) => {
      if (disposed || active.signal.aborted || generation !== request || accessKey(bridge().getProjectAccess?.() ?? null) !== capturedAccess) return
      current = { key: expected, tables, busy: false, error: '' }; changed()
    }, (cause: unknown) => {
      if (disposed || active.signal.aborted || generation !== request || accessKey(bridge().getProjectAccess?.() ?? null) !== capturedAccess) return
      current = { key: expected, busy: false, error: message(cause) }; changed()
    })
  }
  function retry(): void { if (last && !disposed) update(last.recipe, last.supplied, last.skip, true) }
  function start(): () => void {
    disposed = false
    stop?.()
    stop = bridge().onProjectAccessChange?.((state) => {
      const next = accessKey(state)
      if (next === knownAccess) return
      knownAccess = next; cancel(); current = null; changed()
      if (last) update(last.recipe, last.supplied, last.skip, true)
    })
    return dispose
  }
  function dispose(): void { disposed = true; cancel(); stop?.(); stop = undefined; current = null }
  return { key, snapshot, update, retry, start, dispose }
}

export function useLayerColorLutPreview(recipe: ImageLayerRecipe, suppliedTables?: PreparedColorLutTables, skipPreparation = false): LayerColorLutPreviewState {
  const [, changed] = useState(0), session = useRef<ReturnType<typeof createLayerColorLutPreviewSession> | null>(null)
  if (!session.current) session.current = createLayerColorLutPreviewSession(previewBridge, () => changed((value) => value + 1))
  const active = session.current, key = active.key(recipe)
  useEffect(() => active.start(), [active])
  useEffect(() => { active.update(recipe, suppliedTables, skipPreparation) }, [active, key, suppliedTables, skipPreparation])
  return { ...active.snapshot(recipe, suppliedTables, skipPreparation), retry: active.retry }
}
