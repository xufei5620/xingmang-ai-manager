import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronLeft, ChevronRight, Download, Images, LoaderCircle, RefreshCw, Search, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetQuery, CanvasListedAssetSummary } from '../host'
import { SafeImage } from './MediaPreview'
import {
  accountAssetDetail, accountAssetItems, accountAssetLastPageOffset, accountAssetLibraryNote, accountAssetName,
  accountAssetPageSize, accountAssetQuery, accountAssetRangeLabel, accountAssetSearchMaxLength, validateAccountAssetPage,
} from './account-asset-library-model'
import './account-asset-library.css'

export interface AccountAssetLibraryViewProps {
  search: string
  page: CanvasAssetPage | null
  loading: boolean
  error: string | null
  preview: CanvasListedAssetSummary | null
  saving: boolean
  saveMessage: { kind: 'done' | 'error'; text: string } | null
  onSearchChange(search: string): void
  onRefresh(): void
  onPage(offset: number): void
  onPreview(asset: CanvasListedAssetSummary | null): void
  onSave(asset: CanvasListedAssetSummary): void
  onClose(): void
}

function AssetTile({ asset, onPreview }: { asset: CanvasListedAssetSummary; onPreview(asset: CanvasListedAssetSummary): void }) {
  const name = accountAssetName(asset)
  return <button type="button" className="account-asset-library-tile" aria-label={`查看图片：${name}`} title={name} onClick={() => onPreview(asset)}>
    {asset.mediaType === 'image' && <SafeImage src={asset.thumbnailUrl} fallbackSrc={asset.localUrl} alt={name} loading="lazy" />}
    <span>{name}</span>
    <small>{accountAssetDetail(asset)}</small>
  </button>
}

function AssetPreview({ asset, saving, saveMessage, onBack, onSave }: { asset: CanvasListedAssetSummary; saving: boolean; saveMessage: AccountAssetLibraryViewProps['saveMessage']; onBack(): void; onSave(): void }) {
  const name = accountAssetName(asset)
  return <div className="account-asset-library-preview">
    <div className="account-asset-library-preview-media">
      {asset.mediaType === 'image' && <SafeImage src={asset.localUrl} fallbackSrc={asset.thumbnailUrl} alt={name} />}
    </div>
    <div className="account-asset-library-preview-meta"><strong title={name}>{name}</strong><small>{accountAssetDetail(asset)}</small></div>
    {saveMessage && <p className={saveMessage.kind === 'error' ? 'account-asset-library-message is-error' : 'account-asset-library-message'} role={saveMessage.kind === 'error' ? 'alert' : 'status'}>{saveMessage.text}</p>}
    <footer>
      <button type="button" onClick={onBack}><ArrowLeft size={14} />返回列表</button>
      <button type="button" className="is-primary" disabled={saving} onClick={onSave}>{saving ? <LoaderCircle size={14} className="account-asset-library-spin" /> : <Download size={14} />}另存到电脑</button>
    </footer>
  </div>
}

/** The library as drawn from its state, kept apart so the markup can be checked without a host. */
export function AccountAssetLibraryView(props: AccountAssetLibraryViewProps) {
  const { search, page, loading, error, preview } = props
  const items = page ? accountAssetItems(page) : []
  const closeButton = useRef<HTMLButtonElement>(null)
  useEffect(() => { closeButton.current?.focus() }, [])
  return <div className="canvas-project-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose() }}>
    <section className="account-asset-library" role="dialog" aria-modal="true" aria-labelledby="account-asset-library-title" aria-busy={loading} onKeyDown={(event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      if (preview) props.onPreview(null)
      else props.onClose()
    }}>
      <header>
        <span><Images size={16} /><strong id="account-asset-library-title">素材库</strong></span>
        <button ref={closeButton} type="button" title="关闭" aria-label="关闭素材库" onClick={props.onClose}><X size={16} /></button>
      </header>
      <p className="account-asset-library-note">{accountAssetLibraryNote}</p>
      {preview ? <AssetPreview asset={preview} saving={props.saving} saveMessage={props.saveMessage} onBack={() => props.onPreview(null)} onSave={() => props.onSave(preview)} /> : <>
        <div className="account-asset-library-tools">
          <label><Search size={15} /><input aria-label="搜索素材库" value={search} maxLength={accountAssetSearchMaxLength} placeholder="搜索名称、标签" onChange={(event) => props.onSearchChange(event.target.value)} />{search && <button type="button" aria-label="清除搜索" onClick={() => props.onSearchChange('')}><X size={14} /></button>}</label>
          <button type="button" disabled={loading} onClick={props.onRefresh}><RefreshCw size={14} />刷新</button>
        </div>
        <div className="account-asset-library-content">
          {loading ? <div className="account-asset-library-status" role="status"><LoaderCircle size={24} className="account-asset-library-spin" /><p>正在读取素材…</p></div>
            : error ? <div className="account-asset-library-status is-error" role="alert"><p>素材没有读出来</p><small>{error}</small><button type="button" onClick={props.onRefresh}><RefreshCw size={14} />重新读取</button></div>
              : items.length === 0 ? <div className="account-asset-library-status"><Images size={28} /><p>{search.trim() ? '没有匹配的图片' : '素材库里还没有图片'}</p>{search.trim() && <><small>换个关键词，或清除搜索。</small><button type="button" onClick={() => props.onSearchChange('')}>清除搜索</button></>}</div>
                : <div className="account-asset-library-grid">{items.map((asset) => <AssetTile key={asset.assetId} asset={asset} onPreview={props.onPreview} />)}</div>}
        </div>
        <footer>
          <span>{loading ? '正在读取' : error || !page ? '' : accountAssetRangeLabel(page)}</span>
          <div>
            <button type="button" aria-label="上一页图片" disabled={loading || Boolean(error) || !page || page.offset === 0} onClick={() => page && props.onPage(Math.max(0, page.offset - accountAssetPageSize))}><ChevronLeft size={14} />上一页</button>
            <button type="button" aria-label="下一页图片" disabled={loading || Boolean(error) || !page || !page.hasMore} onClick={() => page && props.onPage(page.offset + accountAssetPageSize)}>下一页<ChevronRight size={14} /></button>
          </div>
        </footer>
      </>}
    </section>
  </div>
}

export interface AccountAssetLibraryProps {
  onListAssets(query: CanvasAssetQuery): Promise<CanvasAssetPage>
  onSave(assetId: string): Promise<{ saved: boolean }>
  onClose(): void
}

/**
 * The project center's library. Each listing is tied to the query it was
 * sent for, so a slow answer for an old search or page never replaces
 * the one the user is looking at.
 */
export function AccountAssetLibrary({ onListAssets, onSave, onClose }: AccountAssetLibraryProps) {
  const [search, setSearch] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [page, setPage] = useState<CanvasAssetPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<CanvasListedAssetSummary | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMessage, setSaveMessage] = useState<AccountAssetLibraryViewProps['saveMessage']>(null)
  const listing = useRef(0)
  const saveEpoch = useRef(0)

  useEffect(() => {
    const current = ++listing.current
    const query = accountAssetQuery(search, offset)
    const timer = window.setTimeout(() => {
      void onListAssets(query).then((next) => {
        if (current !== listing.current) return
        const checked = validateAccountAssetPage(next, query)
        if (checked.items.length === 0 && checked.offset > 0 && checked.offset >= checked.total) {
          setOffset(accountAssetLastPageOffset(checked))
          return
        }
        setPage(checked)
        setLoading(false)
      }).catch((reason) => {
        if (current !== listing.current) return
        setError(reason instanceof Error && reason.message ? reason.message : '素材列表没有读出来，请重新读取。')
        setLoading(false)
      })
    }, search ? 300 : 0)
    return () => { window.clearTimeout(timer); if (current === listing.current) listing.current += 1 }
  }, [onListAssets, search, offset, revision])

  useEffect(() => () => { listing.current += 1; saveEpoch.current += 1 }, [])

  // Every change of search, page or a refresh starts a new listing; the
  // effect below sends it, so the spinner goes up here rather than inside it.
  function startListing(change: () => void) {
    setLoading(true)
    setError(null)
    change()
  }

  function showPreview(asset: CanvasListedAssetSummary | null) {
    saveEpoch.current += 1
    setSaving(false)
    setSaveMessage(null)
    setPreview(asset)
  }

  async function save(asset: CanvasListedAssetSummary) {
    if (saving) return
    const epoch = ++saveEpoch.current
    setSaving(true)
    setSaveMessage(null)
    try {
      const result = await onSave(asset.assetId)
      if (epoch === saveEpoch.current && result.saved) setSaveMessage({ kind: 'done', text: `已另存「${accountAssetName(asset)}」` })
    } catch (reason) {
      if (epoch === saveEpoch.current) setSaveMessage({ kind: 'error', text: reason instanceof Error && reason.message ? reason.message : '另存没有完成，请重试。' })
    } finally {
      if (epoch === saveEpoch.current) setSaving(false)
    }
  }

  return <AccountAssetLibraryView
    search={search}
    page={page}
    loading={loading}
    error={error}
    preview={preview}
    saving={saving}
    saveMessage={saveMessage}
    onSearchChange={(next) => {
      const bounded = next.slice(0, accountAssetSearchMaxLength)
      if (bounded !== search || offset !== 0) startListing(() => { setSearch(bounded); setOffset(0) })
    }}
    onRefresh={() => startListing(() => setRevision((value) => value + 1))}
    onPage={(next) => { if (next !== offset) startListing(() => setOffset(next)) }}
    onPreview={showPreview}
    onSave={(asset) => void save(asset)}
    onClose={onClose}
  />
}
