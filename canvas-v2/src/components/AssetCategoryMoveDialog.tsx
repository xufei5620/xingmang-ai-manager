import { useEffect, useRef, useState } from 'react'
import type { AssetCategoryDirectory, AssetCategorySelection } from '../lib/asset-category-contract'
import { maximumAssetCategoryMoveCount } from '../lib/asset-category-contract'
import { AssetCategoryDialogFrame } from './AssetCategoryDialogFrame'
import { AssetCategorySelect } from './AssetCategorySelect'
import { useAssetCategoryOperation, type AssetCategoryOperationProps } from './asset-category-operation'

export interface AssetCategoryMoveAsset extends AssetCategorySelection { displayName?: string; categoryId?: string | null }

export interface AssetCategoryMoveDialogProps extends AssetCategoryOperationProps {
  directory: AssetCategoryDirectory | null
  assets?: readonly AssetCategoryMoveAsset[]
  initialCategoryId?: string | null
  onReadDirectory(signal?: AbortSignal): Promise<AssetCategoryDirectory>
  onReadAssets?(ids: readonly string[], signal?: AbortSignal): Promise<AssetCategoryMoveAsset[]>
  onClose(): void
}

export function AssetCategoryMoveDialog(props: AssetCategoryMoveDialogProps) {
  const [directory, setDirectory] = useState(props.directory)
  const [assets, setAssets] = useState<AssetCategoryMoveAsset[]>(() => [...(props.recovery?.action === 'move' ? props.recovery.assets : props.assets ?? [])])
  const [destination, setDestination] = useState<string | null | undefined>(() => props.recovery?.action === 'move' ? props.recovery.categoryId : props.initialCategoryId)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [review, setReview] = useState<AssetCategoryMoveAsset[] | null>(null)
  const guard = useRef({ scope: props.scopeKey, generation: 0, mounted: true }), controller = useRef<AbortController | null>(null)
  if (guard.current.scope !== props.scopeKey) { guard.current.scope = props.scopeKey; guard.current.generation++; controller.current?.abort() }
  const operation = useAssetCategoryOperation(props)
  useEffect(() => { setDirectory(props.directory) }, [props.directory])
  useEffect(() => { guard.current.mounted = true; return () => { guard.current.mounted = false; guard.current.generation++; controller.current?.abort() } }, [])
  const selectedCategory = typeof destination === 'string' ? directory?.items.find((item) => item.id === destination) : null
  const selectionError = !assets.length || assets.length > maximumAssetCategoryMoveCount || new Set(assets.map((item) => item.assetId)).size !== assets.length
  const locked = operation.locked || reading
  const pending = operation.pending
  async function readLatest() {
    if (reading || operation.busy || props.disabled) return
    const active = new AbortController(), generation = ++guard.current.generation
    controller.current?.abort(); controller.current = active; setReading(true); setError('')
    try {
      const next = await props.onReadDirectory(active.signal)
      const nextAssets = props.onReadAssets ? await props.onReadAssets(assets.map((item) => item.assetId), active.signal) : null
      if (!guard.current.mounted || active.signal.aborted || generation !== guard.current.generation) return
      if (nextAssets && (nextAssets.length !== assets.length || new Set(nextAssets.map((item) => item.assetId)).size !== assets.length || nextAssets.some((item) => !assets.some((asset) => asset.assetId === item.assetId)))) throw new Error('素材资料回执与原选择不一致，请重新读取')
      setDirectory(next); setReview(nextAssets)
      if (typeof destination === 'string' && !next.items.some((item) => item.id === destination)) setDestination(undefined)
      if (!operation.rejected) operation.clearError()
    } catch (cause) { if (guard.current.mounted && !active.signal.aborted && generation === guard.current.generation) setError(cause instanceof Error ? cause.message : '素材分类资料读取未完成') }
    finally { if (guard.current.mounted && generation === guard.current.generation) setReading(false) }
  }
  function move() {
    if (locked || selectionError || destination === undefined || typeof destination === 'string' && !selectedCategory || operation.rejected) return
    void operation.submit({ action: 'move', operationId: crypto.randomUUID(), assets: assets.map((item) => ({ assetId: item.assetId, expectedOrganizationVersion: item.expectedOrganizationVersion })), categoryId: destination, ...(selectedCategory ? { expectedCategoryVersion: selectedCategory.version } : {}) })
  }
  return <AssetCategoryDialogFrame title="移动素材分类" canClose={!reading && operation.canClose} onClose={props.onClose}>
    {props.recoveryNotice}
    <p>将所选 {assets.length} 份素材整理到目标分类。不会复制文件、移动节点或改变回收状态。</p>
    {selectionError && <p role="alert">请选择 1–{maximumAssetCategoryMoveCount} 份不同素材后再移动。</p>}
    {pending && <div className="asset-category-dialog-review" role="status"><strong>上次分类移动尚未确认</strong>{pending.action === 'move' && <p>{pending.assets.length} 份素材 → {pending.categoryId === null ? '未分类' : directory?.items.find((item) => item.id === pending?.categoryId)?.name || '原目标分类待核对'}</p>}<p>仅核对原操作，不会生成新的移动请求。</p><button type="button" disabled={operation.busy || props.disabled} onClick={() => void operation.inspect()}>核对原分类操作</button>{operation.missing && <button type="button" disabled={operation.busy || props.disabled} onClick={() => void operation.retry()}>沿用原操作重试</button>}</div>}
    <AssetCategorySelect items={directory?.items ?? []} value={destination} onChange={setDestination} mode="destination" label="移动到素材分类" disabled={locked} directoryConfirmed={!!directory} />
    <button type="button" disabled={operation.busy || reading || props.disabled} onClick={() => void readLatest()}>{reading ? '正在读取最新资料…' : '读取最新分类与素材资料'}</button>
    {operation.error && <p role="alert">{operation.error}</p>}{error && <p role="alert">{error}</p>}
    {operation.rejected && <p role="status">本次移动已被拒绝，原选择仍保留。读取最新资料并核对后再提交；不会覆盖其他页面的修改。</p>}
    {operation.rejected && !props.onReadAssets && <p>请关闭后刷新素材库，重新选择需要移动的素材。</p>}
    {review && <div className="asset-category-dialog-review"><strong>最新素材归属，等待你核对</strong><ul className="asset-category-move-result">{review.map((item) => <li key={item.assetId}>{item.displayName || item.assetId}：{item.categoryId ? directory?.items.find((category) => category.id === item.categoryId)?.name || '原分类已不可用' : '未分类'}</li>)}</ul><button type="button" disabled={locked} onClick={() => { setAssets(review); setReview(null); operation.clearError() }}>采用最新资料，保留目标分类</button><small>采用后仍需点击“确认移动分类”，才会提交。</small></div>}
    <details><summary>查看所选 {assets.length} 份素材</summary><ul className="asset-category-move-result">{assets.map((item) => <li key={item.assetId}>{item.displayName || item.assetId}</li>)}</ul></details>
    <footer><button type="button" disabled={!operation.canClose || reading} onClick={props.onClose}>{pending ? '关闭，保留待核对操作' : '取消移动分类'}</button><button type="button" className="is-primary" disabled={locked || selectionError || !directory || destination === undefined || typeof destination === 'string' && !selectedCategory || operation.rejected || !!review} onClick={move}>{operation.busy ? '正在核对移动…' : '确认移动分类'}</button></footer>
  </AssetCategoryDialogFrame>
}
