import { useEffect, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, Eye, Film, FolderOpen, MoreHorizontal, Music2, Pencil, Plus, RefreshCw, Search, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetQuery, CanvasAssetSummary } from '../host'
import type { AssetRef } from '../model'
import { AudioPreview, MediaLightbox, SafeImage, ViewportVideo, isLocalCanvasAssetUrl } from './MediaPreview'
import { mediaAssetAspectRatio } from '../library/media-assets'

interface AssetTrayProps {
  page: CanvasAssetPage
  query: Required<Pick<CanvasAssetQuery, 'offset' | 'limit' | 'mediaType'>> & Pick<CanvasAssetQuery, 'search'>
  loading: boolean
  onQueryChange(query: CanvasAssetQuery): void
  onRefresh(): void
  onImport(): void
  onAdd(assetId: string): void
  onAssetMenu(assetId: string): void
  onRename?(assetId: string, displayName: string): void | Promise<void>
  onClose(): void
}

function assetLabel(asset: CanvasAssetSummary): string {
  if ((asset.mediaType === 'image' || asset.mediaType === 'video') && asset.width && asset.height) return `${asset.width}×${asset.height}`
  if ((asset.mediaType === 'video' || asset.mediaType === 'audio') && asset.durationSeconds) return formatAssetDuration(asset.durationSeconds)
  return asset.mediaType === 'video' ? '视频' : asset.mediaType === 'audio' ? '音频' : '图片'
}

function assetTypeName(asset: CanvasAssetSummary): string {
  return asset.mediaType === 'video' ? '视频' : asset.mediaType === 'audio' ? '音频' : '图片'
}

export function formatAssetDuration(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  const seconds = Math.floor(value)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const tail = `${String(minutes % 60).padStart(hours ? 2 : 1, '0')}:${String(seconds % 60).padStart(2, '0')}`
  return hours ? `${hours}:${tail}` : tail
}

function assetName(asset: CanvasAssetSummary): string {
  return asset.displayName || asset.fileName
}

function assetCreatedAt(asset: CanvasAssetSummary): string {
  const date = new Date(asset.createdAt)
  return Number.isNaN(date.getTime()) ? asset.createdAt : date.toLocaleString()
}

function assetRef(asset: CanvasAssetSummary): AssetRef {
  return {
    kind: asset.mediaType,
    assetId: asset.assetId,
    localUrl: asset.localUrl,
    ...('width' in asset && asset.width ? { width: asset.width } : {}),
    ...('height' in asset && asset.height ? { height: asset.height } : {}),
  }
}

export function AssetTray({ page, query, loading, onQueryChange, onRefresh, onImport, onAdd, onAssetMenu, onRename, onClose }: AssetTrayProps) {
  const [search, setSearch] = useState(query.search ?? '')
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)
  const [previewAsset, setPreviewAsset] = useState<CanvasAssetSummary | null>(null)
  const [renamingAsset, setRenamingAsset] = useState<CanvasAssetSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameSaving, setRenameSaving] = useState(false)
  useEffect(() => setSearch(query.search ?? ''), [query.search])
  useEffect(() => {
    if (selectedAssetId && !page.items.some((asset) => asset.assetId === selectedAssetId)) setSelectedAssetId(null)
  }, [page.items, selectedAssetId])

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    onQueryChange({ ...query, offset: 0, search: search.trim() })
  }
  const firstItem = page.total === 0 ? 0 : page.offset + 1
  const lastItem = page.offset + page.items.length
  const beginRename = (asset: CanvasAssetSummary) => {
    setRenamingAsset(asset)
    setRenameDraft(assetName(asset))
    setRenameError(null)
  }
  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!onRename || !renamingAsset || renameSaving) return
    const displayName = renameDraft.trim()
    if (!displayName) {
      setRenameError('名称不能为空')
      return
    }
    setRenameSaving(true)
    setRenameError(null)
    try {
      await onRename(renamingAsset.assetId, displayName)
      setRenamingAsset(null)
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      setRenameSaving(false)
    }
  }

  return (
    <aside className="asset-tray" aria-label="本地资产">
      <header>
        <strong>本地资产</strong>
        <span>{page.total}</span>
        <button type="button" title="从文件导入素材" aria-label="从文件导入素材" onClick={onImport} disabled={loading}><FolderOpen size={15} /></button>
        <button type="button" title="刷新资产" aria-label="刷新资产" onClick={onRefresh} disabled={loading}><RefreshCw size={15} /></button>
        <button type="button" title="关闭资产栏" aria-label="关闭资产栏" onClick={onClose}><X size={16} /></button>
      </header>
      <form className="asset-tray-filters" role="search" onSubmit={submitSearch}>
        <label>
          <Search size={14} aria-hidden="true" />
          <input value={search} maxLength={128} aria-label="搜索本地资产" placeholder="名称或资产 ID" onChange={(event) => setSearch(event.target.value)} />
        </label>
        <select
          aria-label="资产类型"
          value={query.mediaType}
          onChange={(event) => onQueryChange({ ...query, offset: 0, mediaType: event.target.value as 'all' | 'image' | 'video' | 'audio' })}
        >
          <option value="all">全部类型</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="audio">音频</option>
        </select>
      </form>
      <div className="asset-tray-grid">
        {loading && <p className="asset-tray-empty" role="status" aria-live="polite">正在读取...</p>}
        {!loading && page.items.length === 0 && <p className="asset-tray-empty">没有符合条件的本地资产</p>}
        {page.items.map((asset) => {
          const selected = selectedAssetId === asset.assetId
          const name = assetName(asset)
          return (
            <article
              className={`asset-tray-item asset-tray-item-${asset.mediaType}${selected ? ' is-selected' : ''}`}
              key={asset.assetId}
              aria-label={`${name}，${assetLabel(asset)}`}
              onMouseLeave={(event) => {
                setSelectedAssetId((value) => value === asset.assetId ? null : value)
                const focused = document.activeElement
                if (focused instanceof HTMLElement && event.currentTarget.contains(focused)) focused.blur()
              }}
              onContextMenu={(event) => { event.preventDefault(); onAssetMenu(asset.assetId) }}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-xingmang-asset-id', asset.assetId)
                event.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <div
                className="asset-tray-item-preview"
                role="group"
                tabIndex={0}
                aria-label={`查看素材详情：${name}`}
                onClick={() => setSelectedAssetId(asset.assetId)}
                onDoubleClick={() => setPreviewAsset(asset)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelectedAssetId(asset.assetId)
                  }
                }}
              >
                {asset.mediaType === 'image'
                  ? <SafeImage src={asset.thumbnailUrl} alt={name} loading="lazy" />
                  : asset.mediaType === 'audio' && isLocalCanvasAssetUrl(asset.localUrl, 'audio')
                    ? <AudioPreview src={asset.localUrl} aria-label={name} />
                    : asset.mediaType === 'video' && isLocalCanvasAssetUrl(asset.localUrl, 'video')
                      ? <ViewportVideo src={asset.localUrl} aria-label={name} muted controls={selected} preload="metadata" style={{ aspectRatio: mediaAssetAspectRatio(asset) }} />
                      : asset.mediaType === 'audio'
                        ? <span className="asset-audio-placeholder"><Music2 size={22} /><small>音频素材</small></span>
                        : <span className="asset-video-placeholder"><Film size={22} /><small>MP4 视频</small></span>}
              </div>
              <div className="asset-tray-item-tools" aria-label="素材操作">
                <button type="button" title="添加到画布" aria-label={`添加资产到画布：${name}`} onClick={() => onAdd(asset.assetId)}><Plus size={13} /></button>
                <button type="button" title="放大预览" aria-label={`放大预览：${name}`} onClick={() => setPreviewAsset(asset)}><Eye size={13} /></button>
                {onRename && <button type="button" title="重命名" aria-label={`重命名素材：${name}`} onClick={() => beginRename(asset)}><Pencil size={13} /></button>}
                <button type="button" title="更多操作" aria-label={`打开素材操作：${name}`} onClick={() => onAssetMenu(asset.assetId)}><MoreHorizontal size={13} /></button>
              </div>
              {selected
                ? <div className="asset-tray-item-details" aria-live="polite">
                    <div className="asset-tray-item-detail-head">
                      <strong title={name}>{name}</strong>
                      {onRename && <button type="button" title="重命名" aria-label={`重命名素材：${name}`} onClick={() => beginRename(asset)}><Pencil size={12} /></button>}
                    </div>
                    <dl>
                      <div><dt>类型</dt><dd>{assetTypeName(asset)} · {asset.mimeType}</dd></div>
                      {(asset.mediaType === 'image' || asset.mediaType === 'video') && asset.width && asset.height
                        ? <div><dt>分辨率</dt><dd>{asset.width} × {asset.height}</dd></div>
                        : null}
                      {(asset.mediaType === 'video' || asset.mediaType === 'audio') && asset.durationSeconds
                        ? <div><dt>时长</dt><dd>{formatAssetDuration(asset.durationSeconds)}</dd></div>
                        : null}
                      <div><dt>原文件</dt><dd title={asset.fileName}>{asset.fileName}</dd></div>
                      <div><dt>创建时间</dt><dd>{assetCreatedAt(asset)}</dd></div>
                      <div><dt>资产 ID</dt><dd title={asset.assetId}>{asset.assetId}</dd></div>
                    </dl>
                  </div>
                : <div className="asset-tray-item-meta"><span title={name}>{name}</span><small>{assetLabel(asset)}</small></div>}
            </article>
          )
        })}
      </div>
      <footer className="asset-tray-pagination">
        <span>{firstItem}-{lastItem} / {page.total}</span>
        <button type="button" title="上一页" aria-label="上一页资产" disabled={loading || page.offset === 0} onClick={() => onQueryChange({ ...query, offset: Math.max(0, page.offset - page.limit) })}><ChevronLeft size={15} /></button>
        <button type="button" title="下一页" aria-label="下一页资产" disabled={loading || !page.hasMore} onClick={() => onQueryChange({ ...query, offset: page.offset + page.limit })}><ChevronRight size={15} /></button>
      </footer>
      <MediaLightbox
        asset={previewAsset ? assetRef(previewAsset) : null}
        title={previewAsset ? assetName(previewAsset) : undefined}
        createdAt={previewAsset?.createdAt}
        onClose={() => setPreviewAsset(null)}
        onAssetMenu={onAssetMenu}
        onRename={onRename && previewAsset ? () => beginRename(previewAsset) : undefined}
      />
      {renamingAsset && (
        <div className="asset-rename-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !renameSaving) setRenamingAsset(null)
        }}>
          <form className="asset-rename-dialog" role="dialog" aria-modal="true" aria-label="重命名素材" onSubmit={(event) => void submitRename(event)}>
            <header><strong>重命名素材</strong><button type="button" title="关闭" aria-label="关闭重命名" disabled={renameSaving} onClick={() => setRenamingAsset(null)}><X size={16} /></button></header>
            <label>
              <span>显示名称</span>
              <input autoFocus value={renameDraft} maxLength={120} onChange={(event) => setRenameDraft(event.target.value)} />
            </label>
            <small>只修改画布里的显示名称，不会改动本地文件名。</small>
            {renameError && <p role="alert">{renameError}</p>}
            <footer>
              <button type="button" disabled={renameSaving} onClick={() => setRenamingAsset(null)}>取消</button>
              <button type="submit" className="is-primary" disabled={renameSaving || !renameDraft.trim()}>{renameSaving ? '保存中…' : '保存'}</button>
            </footer>
          </form>
        </div>
      )}
    </aside>
  )
}
