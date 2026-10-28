import type { CanvasImageAssetSummary, OfficialAssetItem, OfficialAssetPage, OfficialAssetQuery, OfficialAssetAcquisition } from '../host'
import { isTemplateImageAsset } from './template-asset-picker-model'

export type AssetLibrarySource = 'official' | 'mine' | 'recent'
export interface OfficialAssetAccess {
  list(query: OfficialAssetQuery, signal?: AbortSignal): Promise<OfficialAssetPage>
  acquire(input: { id: string; version: number }, signal?: AbortSignal): Promise<OfficialAssetAcquisition>
  inspect(input: { id: string; version: number }, signal?: AbortSignal): Promise<OfficialAssetAcquisition>
}
export const officialAssetCategories = [{ id: 'all', label: '全部' }, { id: 'character', label: '角色' }, { id: 'prop', label: '道具' }, { id: 'clothing', label: '服装' }, { id: 'other', label: '其他' }] as const
export function officialAssetKey(item: Pick<OfficialAssetItem, 'id' | 'version'>): string { return `${item.id}@${item.version}` }
export function acquiredOfficialImage(item: OfficialAssetItem, result: OfficialAssetAcquisition): CanvasImageAssetSummary {
  if (!isTemplateImageAsset(result.asset) || result.receipt.id !== item.id || result.receipt.version !== item.version || result.receipt.sha256 !== item.sha256 || result.receipt.bytes !== item.bytes) throw new Error('取得回执与所选素材不一致，请核对取得结果后再使用。')
  return result.asset
}
export function orderedOfficialSelection(items: readonly OfficialAssetItem[], selected: readonly string[]): OfficialAssetItem[] {
  const ids = new Set(selected)
  return items.filter((item) => ids.has(officialAssetKey(item)))
}
export async function acquireOfficialSelection(input: { items: readonly OfficialAssetItem[]; access: OfficialAssetAccess; signal: AbortSignal; current(): boolean; remember(item: OfficialAssetItem, asset: CanvasImageAssetSummary): void; progress(completed: number): void }): Promise<CanvasImageAssetSummary[]> {
  if (!input.items.length || input.items.length > 24) throw new Error('请选择 1–24 份官方素材。')
  const assets: CanvasImageAssetSummary[] = []
  for (const item of input.items) {
    if (input.signal.aborted || !input.current()) throw new Error('素材选择范围已变化；已经取得的副本仍在我的素材中。')
    const result = await input.access.acquire({ id: item.id, version: item.version }, input.signal)
    if (input.signal.aborted || !input.current()) throw new Error('素材选择范围已变化；已经取得的副本仍在我的素材中。')
    const asset = acquiredOfficialImage(item, result)
    input.remember(item, asset); assets.push(asset); input.progress(assets.length)
  }
  return assets
}
