import { useEffect, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, FolderOpen, RefreshCw, Search, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetQuery } from '../host'
import { SafeImage } from './MediaPreview'

interface AssetTrayProps {
  page: CanvasAssetPage
  query: Required<Pick<CanvasAssetQuery, 'offset' | 'limit' | 'mediaType'>> & Pick<CanvasAssetQuery, 'search'>
  loading: boolean
  onQueryChange(query: CanvasAssetQuery): void
  onRefresh(): void
  onImport(): void
  onAdd(assetId: string): void
  onAssetMenu(assetId: string): void
  onClose(): void
}

export function AssetTray({ page, query, loading, onQueryChange, onRefresh, onImport, onAdd, onAssetMenu, onClose }: AssetTrayProps) {
  const [search, setSearch] = useState(query.search ?? '')
  useEffect(() => setSearch(query.search ?? ''), [query.search])

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    onQueryChange({ ...query, offset: 0, search: search.trim() })
  }
  const firstItem = page.total === 0 ? 0 : page.offset + 1
  const lastItem = page.offset + page.items.length

  return (
    <aside className="asset-tray" aria-label="本地资产">
      <header>
        <strong>本地资产</strong>
        <span>{page.total}</span>
        <button type="button" title="从文件导入图片" aria-label="从文件导入图片" onClick={onImport} disabled={loading}><FolderOpen size={15} /></button>
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
          onChange={(event) => onQueryChange({ ...query, offset: 0, mediaType: event.target.value as 'all' | 'image' })}
        >
          <option value="all">全部类型</option>
          <option value="image">图片</option>
        </select>
      </form>
      <div className="asset-tray-grid">
        {loading && <p className="asset-tray-empty" role="status" aria-live="polite">正在读取...</p>}
        {!loading && page.items.length === 0 && <p className="asset-tray-empty">没有符合条件的本地资产</p>}
        {page.items.map((asset) => (
          <button
            type="button"
            className="asset-tray-item"
            key={asset.assetId}
            title={`${asset.fileName}\n${new Date(asset.createdAt).toLocaleString()}\n单击添加到画布，右键打开操作`}
            aria-label={`添加资产到画布：${asset.fileName}`}
            onClick={() => onAdd(asset.assetId)}
            onContextMenu={(event) => { event.preventDefault(); onAssetMenu(asset.assetId) }}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData('application/x-xingmang-asset-id', asset.assetId)
              event.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <SafeImage src={asset.thumbnailUrl} alt={asset.fileName} loading="lazy" />
            <span>{asset.width && asset.height ? `${asset.width}×${asset.height}` : asset.fileName}</span>
          </button>
        ))}
      </div>
      <footer className="asset-tray-pagination">
        <span>{firstItem}-{lastItem} / {page.total}</span>
        <button type="button" title="上一页" aria-label="上一页资产" disabled={loading || page.offset === 0} onClick={() => onQueryChange({ ...query, offset: Math.max(0, page.offset - page.limit) })}><ChevronLeft size={15} /></button>
        <button type="button" title="下一页" aria-label="下一页资产" disabled={loading || !page.hasMore} onClick={() => onQueryChange({ ...query, offset: page.offset + page.limit })}><ChevronRight size={15} /></button>
      </footer>
    </aside>
  )
}
