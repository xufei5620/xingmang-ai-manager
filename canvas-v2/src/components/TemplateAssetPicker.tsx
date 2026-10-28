import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, ImageIcon, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasImageAssetSummary } from '../host'
import { SafeImage } from './MediaPreview'
import { buildTemplateImageQuery, createTemplateAssetRequestGuard, isTemplateImageAsset, loadTemplateImagePage, templateImagePageOffset, templatePageImages, type TemplateAssetLoader } from './template-asset-picker-model'
import { AssetSourceTabs } from './AssetSourceTabs'
import { OfficialAssetBrowser } from './OfficialAssetBrowser'
import type { AssetLibrarySource, OfficialAssetAccess } from './official-asset-browser-model'
import './template-asset-picker.css'

interface TemplateAssetPickerProps {
  label: string
  description?: string
  cancelLabel?: string
  searchLabel?: string
  emptyHint?: string
  footerLabel?: string
  selected?: CanvasImageAssetSummary
  selectedIds?: ReadonlySet<string>
  choiceDisabled?(asset: CanvasImageAssetSummary): boolean
  fallbackPage: CanvasAssetPage
  onListAssets?: TemplateAssetLoader
  onChoose(asset: CanvasImageAssetSummary): void | Promise<void>
  onCancel(): void
  officialAccess?: OfficialAssetAccess
  scopeKey?: string
  onAcquired?(): void
}

export function TemplateAssetPicker({ label, selected, selectedIds, choiceDisabled, fallbackPage, onListAssets, onChoose, onCancel, officialAccess, scopeKey = '', onAcquired, description = '只选择参考素材，不会运行模型或改动画布。', cancelLabel = '取消参考图选择，返回模板', searchLabel = '搜索模板参考图片', emptyHint = '可以返回模板，导入一张自己的图片。', footerLabel = '取消选择' }: TemplateAssetPickerProps) {
  const [source, setSource] = useState<AssetLibrarySource>('mine')
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<CanvasAssetPage | null>(null)
  const [loading, setLoading] = useState(Boolean(onListAssets))
  const [error, setError] = useState<string | null>(null)
  const [choiceError, setChoiceError] = useState('')
  const choiceEpoch = useRef(0), choosing = useRef(false)
  useEffect(() => () => { choiceEpoch.current++; choosing.current = false }, [scopeKey, source])
  const [revision, setRevision] = useState(0)
  const guard = useRef(createTemplateAssetRequestGuard())
  const controller = useRef<AbortController | null>(null)
  const cancelButton = useRef<HTMLButtonElement>(null)

  useEffect(() => { cancelButton.current?.focus() }, [])

  useEffect(() => {
    const current = new AbortController()
    controller.current?.abort()
    controller.current = current
    const epoch = guard.current.begin()
    setPage(null)
    setError(null)
    if (!onListAssets || source === 'official') { setLoading(false); return () => { guard.current.invalidate(); current.abort() } }
    setLoading(true)
    const timer = setTimeout(() => {
      const query = { ...buildTemplateImageQuery(search, offset), ...(source === 'recent' ? { view: 'recent' as const, sort: 'used-desc' as const } : {}) }
      void loadTemplateImagePage(onListAssets, query, current.signal).then((next) => {
        if (current.signal.aborted || !guard.current.current(epoch)) return
        if (next.items.length === 0 && next.offset > templateImagePageOffset(next)) {
          setOffset(templateImagePageOffset(next))
          return
        }
        setPage(next)
      }).catch((reason) => {
        if (!current.signal.aborted && guard.current.current(epoch)) setError(reason instanceof Error ? reason.message : '图片素材未加载完成，请重试。')
      }).finally(() => {
        if (!current.signal.aborted && guard.current.current(epoch)) setLoading(false)
      })
    }, search ? 300 : 0)
    return () => { clearTimeout(timer); guard.current.invalidate(); current.abort() }
  }, [onListAssets, search, offset, revision, source, scopeKey])

  function invalidate() { guard.current.invalidate(); controller.current?.abort(); setPage(null); setError(null); setLoading(Boolean(onListAssets)) }
  function searchChanged(value: string) { invalidate(); setSearch(value); setOffset(0) }
  function changePage(next: number) { invalidate(); setOffset(next) }
  async function choose(asset: CanvasImageAssetSummary) {
    if (choosing.current || loading || error || !isTemplateImageAsset(asset) || choiceDisabled?.(asset)) return
    guard.current.invalidate()
    controller.current?.abort()
    const epoch = choiceEpoch.current
    choosing.current = true; setChoiceError('')
    try { await onChoose(asset) } catch (reason) { if (choiceEpoch.current === epoch) setChoiceError(reason instanceof Error ? reason.message : '图片选择未完成，请重试。') }
    finally { if (choiceEpoch.current === epoch) choosing.current = false }
  }

  const fallbackImages = templatePageImages(fallbackPage).filter((asset) => (source !== 'recent' || !!asset.lastUsedAt) && [asset.displayName, asset.fileName, ...(asset.tags ?? [])].join(' ').toLocaleLowerCase('zh-CN').includes(search.trim().toLocaleLowerCase('zh-CN')))
  if (source === 'recent') fallbackImages.sort((left, right) => Date.parse(right.lastUsedAt ?? '') - Date.parse(left.lastUsedAt ?? ''))
  const items = onListAssets ? page ? templatePageImages(page) : [] : fallbackImages
  const total = onListAssets ? page?.total ?? 0 : fallbackImages.length

  return <div className="template-asset-picker" aria-labelledby="template-asset-picker-title" aria-busy={loading}>
    <div className="template-asset-picker-heading"><button ref={cancelButton} type="button" className="template-back" aria-label={cancelLabel} onClick={onCancel}><ArrowLeft size={16} /></button><div><h3 id="template-asset-picker-title">为“{label}”选择图片</h3><p>{description}</p></div></div>
    {choiceError && <p className="template-reference-message is-error" role="alert">{choiceError}</p>}
    <AssetSourceTabs value={source} official={Boolean(officialAccess)} onChange={(next) => { invalidate(); choosing.current = false; setChoiceError(''); setSource(next); setOffset(0) }} />
    {source === 'official' && officialAccess ? <OfficialAssetBrowser access={officialAccess} scopeKey={scopeKey} single onAcquired={onAcquired} onUse={(assets) => onChoose(assets[0])} useLabel="选用" /> : <>
    <div className="template-asset-picker-tools"><label><Search size={16} /><input aria-label={searchLabel} value={search} maxLength={160} placeholder={onListAssets ? '搜索完整图片素材库名称、标签' : '搜索已加载图片名称、标签'} onChange={(event) => searchChanged(event.target.value)} />{search && <button type="button" aria-label="清除图片搜索" onClick={() => searchChanged('')}><X size={15} /></button>}</label>{onListAssets && <button type="button" className="template-import-asset" disabled={loading} onClick={() => { invalidate(); setRevision((value) => value + 1) }}><RefreshCw size={14} />刷新列表</button>}</div>
    {!onListAssets && <p className="template-asset-picker-note">当前宿主仅提供已加载素材，未提供完整素材库分页；仍可返回模板导入本地图片。</p>}
    <div className="template-asset-picker-content">
      {loading ? <div className="template-asset-picker-status" role="status"><LoaderCircle size={24} className="template-asset-spin" /><p>正在读取图片素材…</p></div> : error ? <div className="template-asset-picker-status is-error" role="alert"><p>图片素材未加载完成</p><small>{error}</small><button type="button" className="template-import-asset" onClick={() => { invalidate(); setRevision((value) => value + 1) }}><RefreshCw size={14} />重新加载</button></div> : items.length === 0 ? <div className="template-asset-picker-status"><ImageIcon size={28} /><p>{search.trim() ? '没有匹配的图片素材' : onListAssets ? '素材库中暂无可用图片' : '已加载素材中暂无图片'}</p><small>{search.trim() ? '换个关键词，或清除搜索后再选择。' : emptyHint}</small>{search && <button type="button" className="template-import-asset" onClick={() => searchChanged('')}>清除搜索</button>}</div> : <div className="template-asset-picker-grid">{items.map((asset) => <button type="button" className={(selected?.assetId === asset.assetId || selectedIds?.has(asset.assetId)) ? 'is-selected' : ''} key={asset.assetId} aria-label={`选择图片：${asset.displayName || asset.fileName}`} aria-pressed={(selected?.assetId === asset.assetId || selectedIds?.has(asset.assetId))} disabled={choiceDisabled?.(asset)} onClick={() => void choose(asset)}><SafeImage src={asset.thumbnailUrl} fallbackSrc={asset.localUrl} alt={asset.displayName || asset.fileName} loading="lazy" /><span>{asset.displayName || asset.fileName}</span>{(selected?.assetId === asset.assetId || selectedIds?.has(asset.assetId)) && <i><Check size={15} /></i>}</button>)}</div>}
    </div>
    <footer><span>{loading ? '正在加载当前范围' : error ? '当前范围尚未确认' : onListAssets && page ? `${page.items.length ? `${page.offset + 1}–${page.offset + page.items.length}` : '0'} / ${total} 张图片` : `已加载 ${total} 张匹配图片`}</span><div>{onListAssets && <><button type="button" className="template-import-asset" aria-label="上一页图片" disabled={loading || Boolean(error) || !page || offset === 0} onClick={() => changePage(Math.max(0, offset - 24))}><ChevronLeft size={15} />上一页</button><button type="button" className="template-import-asset" aria-label="下一页图片" disabled={loading || Boolean(error) || !page?.hasMore} onClick={() => changePage(offset + 24)}>下一页<ChevronRight size={15} /></button></>}<button type="button" className="template-import-asset" onClick={onCancel}>{footerLabel}</button></div></footer>
  </>}
  </div>
}
