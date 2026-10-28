import type { AssetRef } from '../model'
import type { ImageTransformSize } from './geometry'

export type CompareMode = 'slider' | 'side-by-side' | 'grid' | 'opacity' | 'toggle'
export interface CompareImageSlot {
  /** An input-slot identity, independent of the asset currently produced by it. */
  key: string
  label: string
  asset?: AssetRef
  dimensions: ImageTransformSize
  onLoad?(image: HTMLImageElement): void
}
export interface CompareViewState {
  mode: CompareMode
  position: number
  a: string | null
  b: string | null
  sideBySideCount?: 2 | 3
  c?: string | null
  opacity?: number
  overlayVisible?: boolean
  grid: readonly (string | null)[]
}
export type CompareSelectionTarget = 'a' | 'b' | 'c' | 0 | 1 | 2 | 3
export interface ResolvedCompareSlot {
  key: string | null
  slot?: CompareImageSlot
  status: 'empty' | 'missing' | 'waiting' | 'ready'
  message: string
}

export function createCompareViewState(slots: readonly CompareImageSlot[], mode: CompareMode = 'slider'): CompareViewState {
  return { mode, position: 50, a: slots[0]?.key ?? null, b: slots[1]?.key ?? null, grid: Array.from({ length: 4 }, (_, index) => slots[index]?.key ?? null) }
}

export function resolveCompareSlot(slots: readonly CompareImageSlot[], key: string | null): ResolvedCompareSlot {
  if (key === null) return { key, status: 'empty', message: '请选择输入图片' }
  const slot = slots.find((entry) => entry.key === key)
  if (!slot) return { key, status: 'missing', message: '原输入已断开，请重新选择' }
  if (!slot.asset?.localUrl) return { key, slot, status: 'waiting', message: '等待此输入图片就绪' }
  return { key, slot, status: 'ready', message: '' }
}

export function compareSliderPosition(value: number): number {
  return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 50
}

export function changeCompareSelection(view: CompareViewState, target: CompareSelectionTarget, key: string | null): CompareViewState {
  if (target === 'a' || target === 'b' || target === 'c') return view[target] === key ? view : { ...view, [target]: key }
  const grid = Array.from({ length: 4 }, (_, index) => view.grid[index] ?? null)
  if (grid[target] === key && view.grid.length === 4) return view
  grid[target] = key
  return { ...view, grid }
}

export function compareViewSelections(view: CompareViewState): readonly (string | null)[] {
  return view.mode === 'grid' ? Array.from({ length: 4 }, (_, index) => view.grid[index] ?? null)
    : view.mode === 'side-by-side' && view.sideBySideCount === 3 ? [view.a, view.b, view.c ?? null] : [view.a, view.b]
}

export function changeCompareParallelCount(view: CompareViewState, count: 2 | 3, slots: readonly CompareImageSlot[]): CompareViewState {
  if ((view.sideBySideCount ?? 2) === count) return view
  return { ...view, sideBySideCount: count, ...(count === 3 && view.c === undefined ? { c: slots[2]?.key ?? null } : {}) }
}

export function compareStageAspectRatio(first: ResolvedCompareSlot): number {
  const size = first.slot?.dimensions
  return size && Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0 ? size.width / size.height : 4 / 3
}
