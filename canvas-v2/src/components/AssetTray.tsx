import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, Clock3, Eye, Film, FolderOpen, MoreHorizontal, Music2, Pencil, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Star, Tags, TriangleAlert, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetQuery, CanvasAssetReferenceReport, CanvasAssetSummary } from '../host'
import type { AssetRef } from '../model'
import { middleTruncate } from '../identifier-display'
import { AudioPreview, MediaLightbox, SafeImage, ViewportVideo, isLocalCanvasAssetUrl } from './MediaPreview'
import { mediaAssetAspectRatio } from '../library/media-assets'
import {
  assetSelectionAfterKey,
  assetSelectionDetailId,
  assetSelectionForActivation,
  assetSelectionForContextMenu,
  assetSelectionSelectAll,
  emptyAssetSelection,
  isAssetSelected,
  retainedAssetSelection,
  type AssetSelection,
} from './asset-selection'
import { adjacentAssetId, assetGridKeyAction, rovingTabIndex, skeletonTileCount } from './asset-grid-keyboard'
import { assetEmptyState } from './asset-empty-state'
import { activeAssetFilters } from './asset-filter-chips'
import {
  assetDensityLabel,
  assetDensityOrder,
  assetDensityTileSize,
  defaultAssetDensity,
  readAssetDensity,
  writeAssetDensity,
  type AssetDensity,
} from '../persistence/asset-density'

interface AssetTrayProps {
  page: CanvasAssetPage
  query: Required<Pick<CanvasAssetQuery, 'offset' | 'limit' | 'mediaType' | 'view' | 'source' | 'sort'>> & Pick<CanvasAssetQuery, 'search' | 'tag'>
  loading: boolean
  onQueryChange(query: CanvasAssetQuery): void
  onRefresh(): void
  onImport(): void
  onAdd(assetId: string): void
  onAssetMenu(assetId: string): void
  onLocateSourceNode?(nodeId: string): void
  onRename?(assetId: string, displayName: string): void | Promise<void>
  onUpdateMetadata?(assetId: string, input: { favorite?: boolean; tags?: string[] }): void | Promise<void>
  onMarkUsed?(assetId: string): void | Promise<void>
  onInspectReferences?(assetId: string): Promise<CanvasAssetReferenceReport>
  onClose(): void
  embedded?: boolean
}

function assetLabel(asset: CanvasAssetSummary): string {
  if ((asset.mediaType === 'image' || asset.mediaType === 'video') && asset.width && asset.height) return `${asset.width}×${asset.height}`
  if ((asset.mediaType === 'video' || asset.mediaType === 'audio') && asset.durationSeconds) return formatAssetDuration(asset.durationSeconds)
  return asset.mediaType === 'video' ? '视频' : asset.mediaType === 'audio' ? '音频' : '图片'
}

function assetTypeName(asset: CanvasAssetSummary): string {
  return asset.mediaType === 'video' ? '视频' : asset.mediaType === 'audio' ? '音频' : '图片'
}

function assetAvailable(asset: CanvasAssetSummary): boolean {
  const source = asset.mediaType === 'image' ? asset.thumbnailUrl : asset.localUrl
  return isLocalCanvasAssetUrl(source, asset.mediaType)
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

export function AssetTray({ page, query, loading, onQueryChange, onRefresh, onImport, onAdd, onAssetMenu, onLocateSourceNode, onRename, onUpdateMetadata, onMarkUsed, onInspectReferences, onClose, embedded = false }: AssetTrayProps) {
  const [search, setSearch] = useState(query.search ?? '')
  const [selection, setSelection] = useState<AssetSelection>(emptyAssetSelection)
  const [previewAsset, setPreviewAsset] = useState<CanvasAssetSummary | null>(null)
  const [renamingAsset, setRenamingAsset] = useState<CanvasAssetSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameSaving, setRenameSaving] = useState(false)
  const [referenceAsset, setReferenceAsset] = useState<CanvasAssetSummary | null>(null)
  const [referenceReport, setReferenceReport] = useState<CanvasAssetReferenceReport | null>(null)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [referenceLoading, setReferenceLoading] = useState(false)
  const [taggingAsset, setTaggingAsset] = useState<CanvasAssetSummary | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  const [tagSaving, setTagSaving] = useState(false)
  useEffect(() => setSearch(query.search ?? ''), [query.search])
  const visibleAssetIds = useMemo(() => page.items.map((asset) => asset.assetId), [page.items])
  useEffect(() => {
    setSelection((value) => retainedAssetSelection(value, visibleAssetIds))
  }, [visibleAssetIds])
  const detailAssetId = assetSelectionDetailId(selection)
  const detailAsset = detailAssetId ? page.items.find((asset) => asset.assetId === detailAssetId) ?? null : null
  const skeletonTiles = useMemo(
    () => Array.from({ length: skeletonTileCount(loading, page.items.length, query.limit) }, (_, index) => index),
    [loading, page.items.length, query.limit],
  )
  // Read once on mount rather than on every render: reading localStorage is
  // synchronous and the tray re-renders on every keystroke in the search box.
  const [density, setDensityState] = useState<AssetDensity>(defaultAssetDensity)
  useEffect(() => setDensityState(readAssetDensity()), [])
  const setDensity = (next: AssetDensity) => {
    setDensityState(next)
    writeAssetDensity(next)
  }
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)
  const filterAnchorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!filterMenuOpen) return undefined
    // Pointer down rather than click: a select inside the popover swallows the
    // click that dismisses its own dropdown, which would leave the popover open
    // behind it on some platforms.
    const closeOnOutside = (event: PointerEvent) => {
      const anchor = filterAnchorRef.current
      if (anchor && event.target instanceof Node && !anchor.contains(event.target)) setFilterMenuOpen(false)
    }
    window.addEventListener('pointerdown', closeOnOutside)
    return () => window.removeEventListener('pointerdown', closeOnOutside)
  }, [filterMenuOpen])
  const filterChips = useMemo(() => activeAssetFilters(query), [query])
  const filterCount = filterChips.length
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const tileRefs = useRef<(HTMLDivElement | null)[]>([])
  const [focusIndex, setFocusIndex] = useState(-1)
  const tabStopIndex = rovingTabIndex(
    focusIndex,
    detailAssetId ? visibleAssetIds.indexOf(detailAssetId) : -1,
    visibleAssetIds.length,
  )
  const previewNeighbour = (step: -1 | 1): CanvasAssetSummary | null => {
    const assetId = adjacentAssetId(visibleAssetIds, previewAsset?.assetId ?? null, step)
    return assetId ? page.items.find((asset) => asset.assetId === assetId) ?? null : null
  }
  const handleGridKey = (key: string, index: number, asset: CanvasAssetSummary): boolean => {
    // Column count comes from the live layout rather than a constant: the grid
    // is responsive and audio tiles span a full row, so a hard-coded stride
    // would send ArrowDown to the wrong tile at some widths.
    const columns = gridRef.current
      ? getComputedStyle(gridRef.current).gridTemplateColumns.split(' ').filter(Boolean).length
      : 2
    const action = assetGridKeyAction(key, index, visibleAssetIds.length, columns)
    if (!action) return false
    if (action.kind === 'search') {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
      return true
    }
    if (action.kind === 'favorite') {
      if (!onUpdateMetadata) return false
      void onUpdateMetadata(asset.assetId, { favorite: !asset.favorite })
      return true
    }
    setFocusIndex(action.index)
    tileRefs.current[action.index]?.focus()
    return true
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    onQueryChange({ ...query, offset: 0, search: search.trim() })
  }
  const firstItem = page.total === 0 ? 0 : page.offset + 1
  const lastItem = page.offset + page.items.length
  const visibleTags = useMemo(() => page.facets.tags.slice(0, 12), [page.facets.tags])
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
  const inspectReferences = async (asset: CanvasAssetSummary) => {
    if (!onInspectReferences || referenceLoading) return
    setReferenceAsset(asset)
    setReferenceReport(null)
    setReferenceError(null)
    setReferenceLoading(true)
    try {
      setReferenceReport(await onInspectReferences(asset.assetId))
    } catch (error) {
      setReferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      setReferenceLoading(false)
    }
  }
  const submitTags = async (event: FormEvent) => {
    event.preventDefault()
    if (!onUpdateMetadata || !taggingAsset || tagSaving) return
    const tags = tagDraft.split(/[,\uff0c]/).map((tag) => tag.trim()).filter(Boolean)
    if (tags.length > 12 || tags.some((tag) => tag.length > 32) || new Set(tags.map((tag) => tag.toLocaleLowerCase('zh-CN'))).size !== tags.length) {
      setTagError('最多 12 个不重复标签，每个不超过 32 个字符')
      return
    }
    setTagSaving(true)
    setTagError(null)
    try {
      await onUpdateMetadata(taggingAsset.assetId, { tags })
      setTaggingAsset(null)
    } catch (error) {
      setTagError(error instanceof Error ? error.message : String(error))
    } finally {
      setTagSaving(false)
    }
  }

  return (
    <aside className={`asset-tray${embedded ? ' is-embedded' : ''}`} aria-label="本地资产">
      <header>
        <strong>素材库</strong>
        <span>{selection.ids.size > 1 ? `已选 ${selection.ids.size} / ${page.total}` : page.total}</span>
        <button type="button" title="从文件导入素材" aria-label="从文件导入素材" onClick={onImport} disabled={loading}><FolderOpen size={15} /></button>
        <button type="button" title="刷新资产" aria-label="刷新资产" onClick={onRefresh} disabled={loading}><RefreshCw size={15} /></button>
        <button type="button" title="关闭资产栏" aria-label="关闭资产栏" onClick={onClose}><X size={16} /></button>
      </header>
      <nav className="asset-quick-views" aria-label="素材快速视图">
        <button type="button" className={query.view === 'all' ? 'is-active' : ''} aria-pressed={query.view === 'all'} onClick={() => onQueryChange({ ...query, offset: 0, view: 'all' })}>全部</button>
        <button type="button" className={query.view === 'favorites' ? 'is-active' : ''} aria-pressed={query.view === 'favorites'} onClick={() => onQueryChange({ ...query, offset: 0, view: 'favorites' })}><Star size={12} />收藏</button>
        <button type="button" className={query.view === 'recent' ? 'is-active' : ''} aria-pressed={query.view === 'recent'} onClick={() => onQueryChange({ ...query, offset: 0, view: 'recent', sort: 'used-desc' })}><Clock3 size={12} />最近</button>
      </nav>
      {/* One tool row instead of three stacked ones. The selects were about
          eighty pixels of chrome sitting at their defaults nearly all the time;
          they move into a popover, and what is actually narrowing the results
          shows below as chips that can each be taken off. */}
      <div className="asset-tray-toolbar">
        <form className="asset-tray-search" role="search" onSubmit={submitSearch}>
          <label>
            <Search size={14} aria-hidden="true" />
            <input ref={searchInputRef} value={search} maxLength={128} aria-label="搜索本地资产" placeholder="名称或资产 ID" onChange={(event) => setSearch(event.target.value)} />
          </label>
        </form>
        <div className="asset-filter-anchor" ref={filterAnchorRef}>
          <button
            type="button"
            className={`asset-filter-trigger${filterCount > 0 ? ' is-active' : ''}`}
            title="筛选与排序"
            aria-label="筛选与排序"
            aria-expanded={filterMenuOpen}
            aria-haspopup="dialog"
            onClick={() => setFilterMenuOpen((open) => !open)}
          >
            <SlidersHorizontal size={14} />
            {filterCount > 0 && <small>{filterCount}</small>}
          </button>
          {filterMenuOpen && (
            <div
              className="asset-filter-popover"
              role="dialog"
              aria-label="筛选与排序"
              onKeyDown={(event) => { if (event.key === 'Escape') setFilterMenuOpen(false) }}
            >
              <label>
                <span>类型</span>
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
              </label>
              <label>
                <span>来源</span>
                <select aria-label="素材来源" value={query.source} onChange={(event) => onQueryChange({ ...query, offset: 0, source: event.target.value as CanvasAssetQuery['source'] })}>
                  <option value="all">全部来源</option>
                  <option value="generated">AI 生成</option>
                  <option value="imported">本地导入</option>
                  <option value="legacy">历史素材</option>
                </select>
              </label>
              <label>
                <span>排序</span>
                <select aria-label="素材排序" value={query.sort} onChange={(event) => onQueryChange({ ...query, offset: 0, sort: event.target.value as CanvasAssetQuery['sort'] })}>
                  <option value="created-desc">最新创建</option>
                  <option value="created-asc">最早创建</option>
                  <option value="used-desc">最近使用</option>
                  <option value="name-asc">名称</option>
                </select>
              </label>
              {(visibleTags.length > 0 || query.tag) && (
                <div className="asset-tag-filter" aria-label="按标签筛选">
                  {query.tag && <button type="button" className="is-active" onClick={() => onQueryChange({ ...query, offset: 0, tag: '' })}>{query.tag}<X size={11} /></button>}
                  {visibleTags.filter(({ tag }) => tag !== query.tag).map(({ tag, count }) => (
                    <button type="button" key={tag} onClick={() => onQueryChange({ ...query, offset: 0, tag })}>
                      {tag}<small>{count}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="asset-density-switch" role="group" aria-label="素材密度">
          {assetDensityOrder.map((value) => (
            <button
              type="button"
              key={value}
              className={value === density ? 'is-active' : ''}
              title={`${assetDensityLabel[value]}密度`}
              aria-label={`${assetDensityLabel[value]}密度`}
              aria-pressed={value === density}
              onClick={() => setDensity(value)}
            >{assetDensityLabel[value]}</button>
          ))}
        </div>
      </div>
      {filterChips.length > 0 && (
        <div className="asset-filter-chips" aria-label="生效中的筛选">
          {filterChips.map((chip) => (
            <button
              type="button"
              key={chip.id}
              aria-label={`移除筛选：${chip.label}`}
              onClick={() => {
                if (chip.id === 'search') setSearch('')
                onQueryChange({ ...query, offset: 0, ...chip.patch })
              }}
            >{chip.label}<X size={11} /></button>
          ))}
        </div>
      )}
      <div
        className={`asset-tray-grid is-density-${density}${loading ? ' is-loading' : ''}`}
        ref={gridRef}
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${assetDensityTileSize[density]}px, 1fr))` }}
        aria-busy={loading}
        aria-multiselectable="true"
        onClick={(event) => { if (event.target === event.currentTarget) setSelection(emptyAssetSelection) }}
        onKeyDown={(event) => {
          if (!(event.key === 'a' || event.key === 'A') || !(event.ctrlKey || event.metaKey)) return
          event.preventDefault()
          setSelection(assetSelectionSelectAll(visibleAssetIds))
        }}
      >
        <p className="asset-tray-live-status" role="status" aria-live="polite">{loading ? '正在读取素材' : ''}</p>
        {skeletonTiles.map((key) => <div className="asset-tray-skeleton" key={key} aria-hidden="true" />)}
        {!loading && page.items.length === 0 && (() => {
          const empty = assetEmptyState(query)
          return (
            <div className="asset-tray-empty">
              <strong>{empty.title}</strong>
              <p>{empty.description}</p>
              <button type="button" onClick={() => {
                if (empty.kind === 'import') return onImport()
                if (empty.kind === 'clear-search') { setSearch(''); return onQueryChange({ ...query, offset: 0, search: '' }) }
                if (empty.kind === 'clear-filters') return onQueryChange({ ...query, offset: 0, tag: undefined, mediaType: 'all', source: 'all' })
                onQueryChange({ ...query, offset: 0, view: 'all' })
              }}>{empty.label}</button>
            </div>
          )
        })()}
        {page.items.map((asset, index) => {
          const selected = isAssetSelected(selection, asset.assetId)
          const expanded = detailAssetId === asset.assetId
          const name = assetName(asset)
          const available = assetAvailable(asset)
          return (
            <article
              className={`asset-tray-item asset-tray-item-${asset.mediaType}${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}`}
              key={asset.assetId}
              aria-label={`${name}，${assetLabel(asset)}`}
              onContextMenu={(event) => {
                event.preventDefault()
                // Acting on one of several selected tiles must not silently
                // discard the rest of the selection.
                setSelection((value) => assetSelectionForContextMenu(value, asset.assetId))
                onAssetMenu(asset.assetId)
              }}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.setData('application/x-xingmang-asset-id', asset.assetId)
                event.dataTransfer.effectAllowed = 'copy'
                void onMarkUsed?.(asset.assetId)
              }}
            >
              <div
                className="asset-tray-item-preview"
                role="group"
                ref={(element) => { tileRefs.current[index] = element }}
                // Roving tabindex: the grid is one tab stop, not one per tile,
                // so Tab reaches the pagination controls without twenty-four
                // presses. Arrow keys move within it.
                tabIndex={index === tabStopIndex ? 0 : -1}
                aria-label={`查看素材详情：${name}`}
                aria-expanded={expanded}
                aria-controls="asset-tray-detail-panel"
                onFocus={() => setFocusIndex(index)}
                onClick={(event) => setSelection((value) => assetSelectionForActivation(
                  value, asset.assetId, visibleAssetIds, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey },
                ))}
                onDoubleClick={() => setPreviewAsset(asset)}
                onKeyDown={(event) => {
                  const next = assetSelectionAfterKey(
                    event.key, selection, asset.assetId, visibleAssetIds, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey },
                  )
                  if (next === undefined) {
                    if (handleGridKey(event.key, index, asset)) event.preventDefault()
                    return
                  }
                  event.preventDefault()
                  setSelection(next)
                }}
              >
                {/* The grid holds no live media at all: players live in the
                    detail panel below, so at most one exists at a time. A page
                    of tiles each holding their own <video> used to decode the
                    full source media just to paint a preview a few hundred
                    pixels wide. */}
                {asset.mediaType === 'audio'
                  ? <span className="asset-audio-placeholder"><Music2 size={22} /><small>{available ? '音频素材' : '素材不可用'}</small></span>
                  : available
                    ? <SafeImage
                        src={asset.thumbnailUrl}
                        alt={name}
                        loading="lazy"
                        fallbackLabel={asset.mediaType === 'video' ? 'MP4 视频' : '素材不可用'}
                        style={{ aspectRatio: mediaAssetAspectRatio(asset) }}
                      />
                    : <span className="asset-video-placeholder"><Film size={22} /><small>素材不可用</small></span>}
              </div>
              <div className="asset-tray-item-tools" aria-label="素材操作">
                {onUpdateMetadata && <button type="button" className={asset.favorite ? 'is-favorite' : ''} title={asset.favorite ? '取消收藏' : '收藏'} aria-label={`${asset.favorite ? '取消收藏' : '收藏'}：${name}`} aria-pressed={asset.favorite} onClick={() => void onUpdateMetadata(asset.assetId, { favorite: !asset.favorite })}><Star size={13} fill={asset.favorite ? 'currentColor' : 'none'} /></button>}
                <button type="button" title="添加到画布" aria-label={`添加资产到画布：${name}`} onClick={() => onAdd(asset.assetId)}><Plus size={13} /></button>
                <button type="button" className="is-optional-preview" title="放大预览" aria-label={`放大预览：${name}`} onClick={() => setPreviewAsset(asset)}><Eye size={13} /></button>
                {onRename && <button type="button" className="is-optional-rename" title="重命名" aria-label={`重命名素材：${name}`} onClick={() => beginRename(asset)}><Pencil size={13} /></button>}
                <button type="button" className="is-optional-menu" title="更多操作" aria-label={`打开素材操作：${name}`} onClick={() => onAssetMenu(asset.assetId)}><MoreHorizontal size={13} /></button>
              </div>
              <div className="asset-tray-item-meta"><span title={name}>{name}</span><small>{assetLabel(asset)}</small></div>
            </article>
          )
        })}
      </div>
      {/* The detail panel is docked below the grid rather than expanded inside
          the tile. Growing a tile in place reflowed every tile after it, which
          moved the thing being inspected out from under the pointer. */}
      {detailAsset && (() => {
        const asset = detailAsset
        const name = assetName(asset)
        const available = assetAvailable(asset)
        return (
          <section className="asset-tray-detail" id="asset-tray-detail-panel" aria-live="polite" aria-label={`素材详情：${name}`}>
            <div className="asset-tray-detail-preview">
              {asset.mediaType === 'audio'
                ? isLocalCanvasAssetUrl(asset.localUrl, 'audio')
                  ? <AudioPreview src={asset.localUrl} aria-label={name} />
                  : <span className="asset-audio-placeholder"><Music2 size={22} /><small>素材不可用</small></span>
                : asset.mediaType === 'video'
                  ? isLocalCanvasAssetUrl(asset.localUrl, 'video')
                    ? <ViewportVideo src={asset.localUrl} aria-label={name} muted controls preload="metadata" style={{ aspectRatio: mediaAssetAspectRatio(asset) }} />
                    : <span className="asset-video-placeholder"><Film size={22} /><small>素材不可用</small></span>
                  : <SafeImage src={asset.thumbnailUrl} alt={name} loading="lazy" />}
            </div>
            <div className="asset-tray-item-details">
              <div className="asset-tray-item-detail-head">
                <strong title={name}>{name}</strong>
                {!available && <span className="asset-unavailable-badge">不可用</span>}
                {onRename && <button type="button" title="重命名" aria-label={`重命名素材：${name}`} onClick={() => beginRename(asset)}><Pencil size={12} /></button>}
                {onUpdateMetadata && <button type="button" title="编辑标签" aria-label={`编辑素材标签：${name}`} onClick={() => { setTaggingAsset(asset); setTagDraft((asset.tags ?? []).join(', ')); setTagError(null) }}><Tags size={12} /></button>}
                {onInspectReferences && <button type="button" title="检查引用与删除保护" aria-label={`检查素材引用：${name}`} onClick={() => void inspectReferences(asset)}><ShieldCheck size={12} /></button>}
                <button type="button" title="关闭详情" aria-label={`关闭素材详情：${name}`} onClick={() => setSelection(emptyAssetSelection)}><X size={12} /></button>
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
                <div><dt>来源</dt><dd>{asset.source === 'generated' ? 'AI 生成' : asset.source === 'imported' ? '本地导入' : '历史素材'}</dd></div>
                {asset.lastUsedAt && <div><dt>最近使用</dt><dd>{new Date(asset.lastUsedAt).toLocaleString()}</dd></div>}
                {asset.lineage && <div><dt>生成来源</dt><dd>
                  {onLocateSourceNode
                    ? <button type="button" className="asset-lineage-link" title="定位到生成节点" onClick={() => onLocateSourceNode(asset.lineage!.nodeId)}>{asset.lineage.nodeId}</button>
                    : asset.lineage.nodeId}
                  {` · ${asset.lineage.sourceAssetIds.length} 个上游素材`}
                </dd></div>}
                {/* Shown in full: this panel exists to give the exact value, and
                    a truncated hash cannot be copied. */}
                <div><dt>资产 ID</dt><dd className="is-identifier" title={asset.assetId}>{asset.assetId}</dd></div>
              </dl>
              {(asset.tags?.length ?? 0) > 0 && <div className="asset-item-tags">{asset.tags?.map((tag) => <button type="button" key={tag} onClick={() => onQueryChange({ ...query, offset: 0, tag })}>{tag}</button>)}</div>}
            </div>
          </section>
        )
      })()}
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
        onPrevious={previewNeighbour(-1) ? () => setPreviewAsset(previewNeighbour(-1)) : undefined}
        onNext={previewNeighbour(1) ? () => setPreviewAsset(previewNeighbour(1)) : undefined}
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
      {taggingAsset && (
        <div className="asset-rename-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !tagSaving) setTaggingAsset(null)
        }}>
          <form className="asset-rename-dialog asset-tag-dialog" role="dialog" aria-modal="true" aria-label="编辑素材标签" onSubmit={(event) => void submitTags(event)}>
            <header><strong>编辑素材标签</strong><button type="button" title="关闭" aria-label="关闭标签编辑" disabled={tagSaving} onClick={() => setTaggingAsset(null)}><X size={16} /></button></header>
            <label>
              <span>标签</span>
              <input autoFocus value={tagDraft} maxLength={395} placeholder="例如：产品图, 已定稿" onChange={(event) => setTagDraft(event.target.value)} />
            </label>
            <small>使用中英文逗号分隔，最多 12 个。</small>
            {tagError && <p role="alert">{tagError}</p>}
            <footer>
              <button type="button" disabled={tagSaving} onClick={() => setTaggingAsset(null)}>取消</button>
              <button type="submit" className="is-primary" disabled={tagSaving}>{tagSaving ? '保存中…' : '保存'}</button>
            </footer>
          </form>
        </div>
      )}
      {referenceAsset && (
        <div className="asset-reference-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !referenceLoading) setReferenceAsset(null)
        }}>
          <section className="asset-reference-dialog" role="dialog" aria-modal="true" aria-label="素材引用检查">
            <header>
              <span>{referenceReport?.inUse ? <TriangleAlert size={16} /> : <ShieldCheck size={16} />}<strong>素材引用检查</strong></span>
              <button type="button" title="关闭" aria-label="关闭素材引用检查" disabled={referenceLoading} onClick={() => setReferenceAsset(null)}><X size={16} /></button>
            </header>
            <div className="asset-reference-target"><strong title={assetName(referenceAsset)}>{assetName(referenceAsset)}</strong><small title={referenceAsset.assetId}>{middleTruncate(referenceAsset.assetId, 20)}</small></div>
            {referenceLoading && <p role="status">正在扫描当前画布、项目和运行记录…</p>}
            {referenceError && <p className="asset-reference-error" role="alert">{referenceError}</p>}
            {referenceReport && (
              <>
                <p className={referenceReport.inUse ? 'is-referenced' : 'is-clear'}>
                  <strong>{referenceReport.inUse ? '素材仍被工作流引用' : '未发现工作流引用'}</strong>
                  <span>{referenceReport.inUse ? '为避免破坏项目、候选或运行记录，本版本不会删除该素材。' : '安全检查已完成；本次只生成引用报告，没有删除本地文件。'}</span>
                </p>
                <dl className="asset-reference-summary">
                  <div><dt>当前画布</dt><dd>{referenceReport.currentProject.nodeIds.length} 个节点</dd></div>
                  <div><dt>已保存项目</dt><dd>{referenceReport.projects.length} 个项目</dd></div>
                  <div><dt>运行与候选</dt><dd>{referenceReport.runs.length} 条运行</dd></div>
                </dl>
                {(referenceReport.projects.length > 0 || referenceReport.runs.length > 0) && (
                  <div className="asset-reference-list">
                    {referenceReport.projects.slice(0, 8).map((project) => (
                      <div key={project.projectId}><span><strong>{project.projectName}</strong><small>{project.archived ? '已归档项目' : '已保存项目'}</small></span><em>{project.nodeIds.length} 个节点</em></div>
                    ))}
                    {referenceReport.runs.slice(0, 8).map((run) => (
                      <div key={run.runId}><span><strong title={run.runId}>{run.runId}</strong><small>{run.inputReferenceCount} 次输入 · {run.candidateReferenceCount} 个候选</small></span><em>{run.nodeIds.length} 个节点</em></div>
                    ))}
                  </div>
                )}
              </>
            )}
            <footer><button type="button" disabled={referenceLoading} onClick={() => setReferenceAsset(null)}>关闭</button></footer>
          </section>
        </div>
      )}
    </aside>
  )
}
