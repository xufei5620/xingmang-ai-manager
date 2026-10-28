import type { CanvasAssetSummary } from '../host'
import type { AssetSelection } from './asset-selection'

export const maximumAssetBatchCount = 50
export const assetBatchDragMime = 'application/x-xingmang-asset-ids'

export interface AssetBatchItem { assetId: string; label: string; unavailableReason?: string }

export function assetBatchUnavailableReason(asset: { assetId: string; localUrl: string; kind?: string; mediaType?: string; deletedAt?: string }): string | undefined {
  if (asset.deletedAt) return '素材在回收站中，请先恢复'
  const kind = asset.kind ?? asset.mediaType
  if (!/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || !['image', 'video', 'audio'].includes(kind ?? '') || asset.localUrl !== `xingmang-asset://${kind}/${asset.assetId}`) return '素材尚未保存到当前账号，或原文件不可用'
  return undefined
}

export function assetTrayBatchItems(assets: readonly CanvasAssetSummary[]): AssetBatchItem[] {
  return assets.map((asset) => ({ assetId: asset.assetId, label: asset.displayName || asset.fileName, unavailableReason: assetBatchUnavailableReason(asset) }))
}

/** The displayed order is authoritative; click order and duplicated cached candidates are not. */
export function orderedAssetBatchIds(items: readonly AssetBatchItem[], selected: ReadonlySet<string>): string[] {
  return [...new Set(items.filter((item) => selected.has(item.assetId)).map((item) => item.assetId))]
}

export function assetBatchSelectionError(items: readonly AssetBatchItem[], ids: readonly string[]): string | undefined {
  if (!ids.length) return '请先选择素材'
  if (ids.length > maximumAssetBatchCount) return `一次最多处理 ${maximumAssetBatchCount} 项素材，请减少选择；不会只处理前 ${maximumAssetBatchCount} 项`
  const byId = new Map(items.map((item) => [item.assetId, item]))
  const errors = ids.flatMap((id) => {
    const item = byId.get(id)
    return !item ? ['素材已不在当前列表，请重新选择'] : item.unavailableReason ? [`${item.label}：${item.unavailableReason}`] : []
  })
  return errors.length ? errors.join('\n') : undefined
}

export function assetBatchDragIds(items: readonly AssetBatchItem[], selection: AssetSelection, targetId: string): string[] {
  const ids = selection.ids.has(targetId) ? orderedAssetBatchIds(items, selection.ids) : [targetId]
  const error = assetBatchSelectionError(items, ids)
  if (error) throw new Error(error)
  return ids
}

export interface AssetBatchActionState { busy: 'add' | 'download' | null; error: string; notice: string }
export const emptyAssetBatchActionState: AssetBatchActionState = { busy: null, error: '', notice: '' }

/** Scope changes invalidate feedback, never cancel an accepted host transaction or automatically retry it. */
export function createAssetBatchActionController() {
  let scope = '', epoch = 0, active = true, pending = false
  return {
    scope(next: string) { if (scope !== next) { scope = next; epoch++; pending = false } },
    activate() { active = true },
    dispose() { active = false; epoch++; pending = false },
    async run(kind: 'add' | 'download', ids: readonly string[], action: (ids: readonly string[]) => Promise<void>, update: (state: AssetBatchActionState) => void) {
      if (!active || pending) return
      pending = true
      const ticket = epoch
      const current = () => active && ticket === epoch
      update({ busy: kind, error: '', notice: '' })
      try {
        await action([...ids])
        if (current()) update({ busy: null, error: '', notice: kind === 'add' ? `已将 ${ids.length} 项素材加入画布，可一次撤销` : '下载准备已结束，请查看打包结果' })
      } catch (cause) {
        if (current()) update({ busy: null, error: cause instanceof Error ? cause.message : '批量操作未完成，请核对当前画布或下载记录后重试', notice: '' })
      } finally { if (current()) pending = false }
    },
  }
}
