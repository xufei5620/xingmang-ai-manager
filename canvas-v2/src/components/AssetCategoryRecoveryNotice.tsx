import type { AssetCategoryRecoveryState } from '../lib/asset-category-recovery'

export function AssetCategoryRecoveryNotice({ state, onReload }: { state: Pick<AssetCategoryRecoveryState, 'loading' | 'ready' | 'error' | 'writeError'>; onReload(): Promise<unknown> }) {
  const message = state.error || state.writeError
  if (!message && !state.loading) return null
  return <div className="asset-category-dialog-review" role={message ? 'alert' : 'status'}>
    <span>{message || '正在读取本机分类操作记录，素材列表仍可使用…'}</span>
    {message && <button type="button" disabled={state.loading} onClick={() => void onReload().catch(() => undefined)}>重读分类操作记录</button>}
  </div>
}
