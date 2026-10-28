import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight, Clock3, Copy, Download, Eye, Film, FolderOpen, MoreHorizontal, Music2, Pencil, Plus, RefreshCw, Search, ShieldCheck, SlidersHorizontal, Star, Tags, Trash2, TriangleAlert, X } from 'lucide-react'
import type { CanvasAssetPage, CanvasAssetQuery, CanvasAssetReferenceReport, CanvasAssetSummary } from '../host'
import type { AssetRef } from '../model'
import { isAssetMutationResult, type AssetMutationResult } from '../lib/asset-mutation-contract'
import { middleTruncate } from '../identifier-display'
import { AssetReferenceDetails, assetReferenceScanIncomplete } from './AssetReferenceDetails'
import { AudioPreview, MediaLightbox, SafeImage, VideoCoverImage, ViewportVideo, canvasAssetIsPreviewable, isLocalCanvasAssetUrl } from './MediaPreview'
import {
  formatMediaDuration as formatAssetDuration,
  mediaAssetAspectRatio,
  mediaAssetSizeLabel,
  mediaDurationLabel,
  mediaHoverTitle,
} from '../library/media-assets'
import {
  assetSelectionAfterKey,
  assetSelectionDetailId,
  assetSelectionForActivation,
  assetSelectionForContextMenu,
  assetSelectionSelectAll,
  emptyAssetSelection,
  isAssetSelected,
} from './asset-selection'
import { adjacentAssetId, assetGridKeyAction, rovingTabIndex, skeletonTileCount } from './asset-grid-keyboard'
import { assetEmptyState } from './asset-empty-state'
import { activeAssetFilters } from './asset-filter-chips'
import { updateAssetFavorite } from './asset-favorite'
import { combineCanvasAssetDetail, createCanvasAssetDetailGuard } from './asset-detail-state'
import {
  assetDensityLabel,
  assetDensityOrder,
  defaultAssetDensity,
  readAssetDensity,
  writeAssetDensity,
  type AssetDensity,
} from '../persistence/asset-density'
import { assetBatchDragIds, assetBatchDragMime, assetBatchSelectionError, assetBatchUnavailableReason, assetTrayBatchItems, maximumAssetBatchCount, orderedAssetBatchIds } from './asset-batch-selection'
import { useAssetBatchActions, useScopedAssetSelection } from './use-asset-batch-actions'
import { resolveCanvasAssetMutationResult, type CanvasAssetMutationAction, type CanvasAssetMutationResult } from './asset-mutation-batch'
import { parseAssetMetadataTagText } from '../library/asset-metadata-input'
import type { AssetCategoryDirectory } from '../lib/asset-category-contract'
import { AssetCategoryFilter } from './AssetCategorySelect'
import { AssetSourceTabs } from './AssetSourceTabs'
import { OfficialAssetBrowser } from './OfficialAssetBrowser'
import { AssetOriginNavigation } from './AssetOriginNavigation'
import type { CanvasAssetOriginResult } from '../lib/asset-origin-contract'
import type { OfficialAssetAccess } from './official-asset-browser-model'
import '../theme/editor-library.css'
import './asset-batch-actions.css'

interface AssetTrayProps {
  page: CanvasAssetPage
  query: Required<Pick<CanvasAssetQuery, 'offset' | 'limit' | 'mediaType' | 'view' | 'source' | 'sort'>> & Pick<CanvasAssetQuery, 'search' | 'tag' | 'prompt' | 'runId' | 'nodeId' | 'categoryId'>
  loading: boolean
  onQueryChange(query: CanvasAssetQuery): void
  onRefresh(): void
  onImport(): void
  categoryDirectory?: AssetCategoryDirectory | null
  categoryLoading?: boolean
  categoryError?: string
  categoryRecoveryPending?: boolean
  categoryRecoveryNotice?: ReactNode
  categorySelectionRevision?: number
  onReadCategories?(): void
  onManageCategories?(): void
  onMoveCategory?(assetIds: readonly string[]): void
  onAdd(assetId: string): void
  onAddMany?(assetIds: readonly string[]): Promise<void>
  onDownloadMany?(assetIds: readonly string[]): Promise<void>
  batchScope?: string
  recoverableMutations?: boolean
  mutationWritesBlocked?: boolean
  mutationRecoveryNotice?: ReactNode
  onFavoriteMany?(assetIds: readonly string[], favorite: boolean): Promise<AssetMutationResult>
  onAssetMenu(assetId: string): void
  onReadAssetOrigin?(assetId: string, signal: AbortSignal): Promise<CanvasAssetOriginResult>
  onReadDetail?(assetId: string, signal?: AbortSignal): Promise<CanvasAssetSummary>
  onRename?(assetId: string, displayName: string): void | Promise<void>
  onUpdateMetadata?(assetId: string, input: { favorite?: boolean; tags?: string[] }): void | Promise<void>
  onInspectReferences?(assetId: string): Promise<CanvasAssetReferenceReport>
  onCheckRunInputs?(assetId: string, retryUnavailable?: boolean): Promise<CanvasAssetReferenceReport>
  onDelete?(assetIds: readonly string[]): void | Promise<void | CanvasAssetMutationResult>
  onRestore?(assetIds: readonly string[]): void | Promise<void | CanvasAssetMutationResult>
  onPurge?(assetIds: readonly string[]): void | Promise<void | CanvasAssetMutationResult>
  onClose(): void
  embedded?: boolean
  officialAccess?: OfficialAssetAccess
  readOnly?: boolean
  sourceNavigation?: ReactNode
}

function assetLabel(asset: CanvasAssetSummary): string {
  if ((asset.mediaType === 'image' || asset.mediaType === 'video') && asset.width && asset.height) return `${asset.width}×${asset.height}`
  if ((asset.mediaType === 'video' || asset.mediaType === 'audio') && asset.durationSeconds) return formatAssetDuration(asset.durationSeconds)
  return asset.mediaType === 'video' ? '视频' : asset.mediaType === 'audio' ? '音频' : '图片'
}

/**
 * Hover readout for a tile. Resolution and duration each appear only when the
 * record actually carries them, so the tooltip never invents a number.
 */
function assetHoverTitle(asset: CanvasAssetSummary): string | undefined {
  const duration = mediaDurationLabel('durationSeconds' in asset ? asset.durationSeconds : undefined)
  return mediaHoverTitle([assetName(asset), mediaAssetSizeLabel(asset), duration ? `时长 ${duration}` : null])
}

function assetTypeName(asset: CanvasAssetSummary): string {
  return asset.mediaType === 'video' ? '视频' : asset.mediaType === 'audio' ? '音频' : '图片'
}

function assetAvailable(asset: CanvasAssetSummary): boolean {
  return canvasAssetIsPreviewable(asset)
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

export function AssetTray(props: AssetTrayProps) {
  const [official, setOfficial] = useState(false)
  const source = official && props.officialAccess ? 'official' : props.query.view === 'recent' ? 'recent' : 'mine'
  const navigation = <AssetSourceTabs value={source} official={Boolean(props.officialAccess)} onChange={(next) => {
    setOfficial(next === 'official')
    if (next !== 'official') props.onQueryChange({ ...props.query, offset: 0, view: next === 'recent' ? 'recent' : 'all', sort: next === 'recent' ? 'used-desc' : 'created-desc' })
  }} />
  if (source !== 'official' || !props.officialAccess) return <PersonalAssetTray {...props} sourceNavigation={navigation} />
  return <aside className={`asset-tray${props.embedded ? ' is-embedded' : ''}`} aria-label="官方素材"><header><strong>素材库</strong><button type="button" aria-label="关闭资产栏" onClick={props.onClose}><X size={16} /></button></header>{navigation}<OfficialAssetBrowser key={props.batchScope} access={props.officialAccess} scopeKey={props.batchScope ?? ''} readOnly={props.readOnly} onAcquired={props.onRefresh} onUse={props.onAddMany ? (assets) => props.onAddMany!(assets.map((asset) => asset.assetId)) : undefined} /></aside>
}

function PersonalAssetTray({ page, query, loading, onQueryChange, onRefresh, onImport, categoryDirectory, categoryLoading, categoryError, categoryRecoveryPending, categoryRecoveryNotice, categorySelectionRevision = 0, onReadCategories, onManageCategories, onMoveCategory, onAdd, onAddMany, onDownloadMany, batchScope, recoverableMutations = false, mutationWritesBlocked = false, mutationRecoveryNotice, onFavoriteMany, onAssetMenu, onReadAssetOrigin, onReadDetail, onRename, onUpdateMetadata, onInspectReferences, onCheckRunInputs, onDelete, onRestore, onPurge, onClose, embedded = false, sourceNavigation }: AssetTrayProps) {
  const [search, setSearch] = useState(query.search ?? '')
  const visibleAssetIds = useMemo(() => page.items.map((asset) => asset.assetId), [page.items])
  const selectionScope = JSON.stringify([batchScope ?? '', query.offset, query.limit, query.mediaType, query.view, query.source, query.sort, query.search ?? '', query.tag ?? '', query.prompt ?? '', query.runId ?? '', query.nodeId ?? '', query.categoryId === undefined ? 'all' : query.categoryId, categorySelectionRevision])
  const mutationContext = useRef({ scope: selectionScope, generation: 0, mounted: true, pending: false, writesBlocked: mutationWritesBlocked })
  if (mutationContext.current.scope !== selectionScope) { mutationContext.current.scope = selectionScope; mutationContext.current.generation++; mutationContext.current.pending = false }
  mutationContext.current.writesBlocked = mutationWritesBlocked
  const mutationGeneration = mutationContext.current.generation
  const [mutationState, setMutationState] = useState<{ generation: number; busy: CanvasAssetMutationAction | 'favorite' | 'unfavorite' | null; result: CanvasAssetMutationResult | null }>({ generation: mutationGeneration, busy: null, result: null })
  const mutationBusy = mutationState.generation === mutationGeneration ? mutationState.busy : null
  const mutationResult = mutationState.generation === mutationGeneration ? mutationState.result : null
  useEffect(() => { mutationContext.current.mounted = true; return () => { mutationContext.current.mounted = false; mutationContext.current.generation++; mutationContext.current.pending = false } }, [])
  const { selection, setSelection } = useScopedAssetSelection(selectionScope, visibleAssetIds)
  const batch = useAssetBatchActions(selectionScope)
  const actionsLocked = !!batch.busy || !!mutationBusy || mutationContext.current.pending
  const batchMayAdd = !!onAddMany || !onDownloadMany
  const batchItems = useMemo(() => assetTrayBatchItems(page.items), [page.items])
  const batchIds = orderedAssetBatchIds(batchItems, selection.ids)
  const batchError = assetBatchSelectionError(batchItems, batchIds)
  function runBatch(kind: 'add' | 'download') {
    if (loading || batch.busy || mutationContext.current.pending) return
    if (batchError) { batch.reportError(batchError); return }
    void batch.run(kind, batchIds, kind === 'add' ? onAddMany : onDownloadMany)
  }
  const [previewAsset, setPreviewAsset] = useState<CanvasAssetSummary | null>(null)
  const [renamingAsset, setRenamingAsset] = useState<CanvasAssetSummary | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [renameSaving, setRenameSaving] = useState(false)
  const renameGeneration = useRef(mutationGeneration)
  const [referenceAsset, setReferenceAsset] = useState<CanvasAssetSummary | null>(null)
  const [referenceReport, setReferenceReport] = useState<CanvasAssetReferenceReport | null>(null)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [referenceLoading, setReferenceLoading] = useState(false)
  const referenceBusy = useRef(false)
  const referenceEpoch = useRef(0)
  useEffect(() => () => { referenceEpoch.current += 1 }, [])
  const [taggingAsset, setTaggingAsset] = useState<CanvasAssetSummary | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [tagError, setTagError] = useState<string | null>(null)
  const [tagSaving, setTagSaving] = useState(false)
  const tagGeneration = useRef(mutationGeneration)
  useEffect(() => setSearch(query.search ?? ''), [query.search])
  const detailAssetId = assetSelectionDetailId(selection)
  const detailSummary = detailAssetId ? page.items.find((asset) => asset.assetId === detailAssetId) ?? null : null
  const [loadedDetail, setLoadedDetail] = useState<CanvasAssetSummary | null>(null)
  const [detailFailure, setDetailFailure] = useState<{ assetId: string; message: string } | null>(null)
  const [detailRetry, setDetailRetry] = useState(0)
  const detailGuard = useRef(createCanvasAssetDetailGuard())
  const needsDetail = detailSummary?.metadataLevel === 'summary'
  useEffect(() => {
    const guard = detailGuard.current
    const ticket = guard.begin()
    setLoadedDetail(null)
    setDetailFailure(null)
    if (!detailAssetId || !needsDetail) return () => guard.invalidate()
    const controller = new AbortController()
    const read = async () => {
      try {
        if (!onReadDetail) throw new Error('当前宿主暂不支持完整素材资料，请更新后重新读取')
        const detail = await onReadDetail(detailAssetId, controller.signal)
        if (detail.assetId !== detailAssetId || detail.metadataLevel !== 'complete') throw new Error('素材详情回执不一致，请重新读取')
        if (guard.current(ticket, controller.signal)) setLoadedDetail(detail)
      } catch (error) {
        if (guard.current(ticket, controller.signal)) setDetailFailure({ assetId: detailAssetId, message: error instanceof Error ? error.message : '素材详情读取失败，请重试' })
      }
    }
    void read()
    return () => { guard.invalidate(); controller.abort() }
  }, [detailAssetId, needsDetail, detailRetry, onReadDetail])
  const detailAsset = detailSummary ? combineCanvasAssetDetail(detailSummary, loadedDetail) : null
  const metadataPending = detailAsset?.metadataLevel === 'summary'
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
  // The undo affordance is the whole point of a soft delete: without it the bin
  // is somewhere you have to go looking, and a mistaken delete costs a trip.
  const [undoDeleteState, setUndoDeleteState] = useState<{ generation: number; ids: string[]; count: number } | null>(null)
  const undoDelete = !recoverableMutations && undoDeleteState?.generation === mutationGeneration ? undoDeleteState : null
  function setUndoDelete(value: { ids: string[]; count: number } | null) { setUndoDeleteState(value ? { ...value, generation: mutationGeneration } : null) }
  const [assetActionError, setAssetActionError] = useState<string | null>(null)
  const favoriteSavingRef = useRef(new Set<string>())
  const [favoriteSavingIds, setFavoriteSavingIds] = useState<ReadonlySet<string>>(() => new Set())
  const metadataScope = useRef(selectionScope)
  useEffect(() => {
    if (metadataScope.current === selectionScope) return
    metadataScope.current = selectionScope
    setRenamingAsset(null); setRenameSaving(false); setRenameError(null)
    setTaggingAsset(null); setTagSaving(false); setTagError(null)
    favoriteSavingRef.current.clear(); setFavoriteSavingIds(new Set())
    setAssetActionError(null)
  }, [selectionScope])
  const toggleFavorite = async (asset: CanvasAssetSummary) => {
    if (!mutationContext.current.mounted || mutationContext.current.generation !== mutationGeneration || !onUpdateMetadata || mutationContext.current.writesBlocked || mutationContext.current.pending || favoriteSavingRef.current.has(asset.assetId)) return
    const generation = mutationGeneration
    function current() { return mutationContext.current.mounted && mutationContext.current.generation === generation }
    mutationContext.current.pending = true
    favoriteSavingRef.current.add(asset.assetId)
    setFavoriteSavingIds(new Set(favoriteSavingRef.current))
    setAssetActionError(null)
    const error = await updateAssetFavorite(asset, onUpdateMetadata)
    if (!current()) return
    mutationContext.current.pending = false
    favoriteSavingRef.current.delete(asset.assetId)
    setFavoriteSavingIds(new Set(favoriteSavingRef.current))
    if (error) setAssetActionError(`收藏更新失败：${error}`)
  }
  useEffect(() => {
    if (!undoDelete) return undefined
    const timer = window.setTimeout(() => setUndoDelete(null), 10_000)
    return () => window.clearTimeout(timer)
  }, [undoDelete])
  const runMutation = async (action: CanvasAssetMutationAction, ids: string[]) => {
    const callback = action === 'delete' ? onDelete : action === 'restore' ? onRestore : onPurge
    if (!mutationContext.current.mounted || mutationContext.current.generation !== mutationGeneration || !callback || !ids.length || batch.busy || mutationContext.current.pending || action !== 'purge' && mutationContext.current.writesBlocked) return
    const generation = mutationGeneration
    function current() { return mutationContext.current.mounted && mutationContext.current.generation === generation }
    mutationContext.current.pending = true
    setMutationState({ generation, busy: action, result: null })
    setAssetActionError(null)
    try {
      const value = await callback([...ids])
      if (!current()) return
      if (recoverableMutations && action !== 'purge' && value === undefined) throw new Error('当前宿主未返回可恢复素材回执；选择仍保留，请核对原操作')
      const result = resolveCanvasAssetMutationResult(action, ids, value)
      const succeeded = result.outcomes.filter((item) => item.state === 'succeeded').map((item) => item.assetId)
      setSelection((previous) => {
        const remaining = new Set([...previous.ids].filter((assetId) => !succeeded.includes(assetId)))
        return { ids: remaining, anchor: previous.anchor && remaining.has(previous.anchor) ? previous.anchor : [...remaining][0] ?? null }
      })
      if (action === 'delete' && succeeded.length && !recoverableMutations) setUndoDelete({ ids: succeeded, count: succeeded.length })
      if (action === 'restore' && undoDelete) {
        const remaining = undoDelete.ids.filter((assetId) => !succeeded.includes(assetId))
        setUndoDelete(remaining.length ? { ids: remaining, count: remaining.length } : null)
      }
      setMutationState({ generation, busy: null, result })
    } catch (error) {
      if (current()) setAssetActionError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) { mutationContext.current.pending = false; setMutationState((previous) => ({ ...previous, busy: null })) }
    }
  }
  const favoriteMany = async (favorite: boolean) => {
    if (!mutationContext.current.mounted || mutationContext.current.generation !== mutationGeneration || !onFavoriteMany || mutationContext.current.pending || mutationContext.current.writesBlocked || batch.busy || loading || !batchIds.length || batchError) return
    const generation = mutationGeneration, ids = [...batchIds]
    function current() { return mutationContext.current.mounted && mutationContext.current.generation === generation }
    mutationContext.current.pending = true
    setMutationState({ generation, busy: favorite ? 'favorite' : 'unfavorite', result: null })
    setAssetActionError(null)
    try {
      const result = await onFavoriteMany(ids, favorite)
      if (!current()) return
      if (!isAssetMutationResult(result) || result.action !== (favorite ? 'favorite' : 'unfavorite') || result.outcomes.length !== ids.length || result.outcomes.some((item, index) => item.assetId !== ids[index])) throw new Error('所选素材回执身份不一致，请在操作记录中核对；当前选择仍保留')
      const succeeded = new Set(result.outcomes.filter((item) => item.state === 'succeeded').map((item) => item.assetId))
      setSelection((previous) => { const remaining = new Set([...previous.ids].filter((id) => !succeeded.has(id))); return { ids: remaining, anchor: previous.anchor && remaining.has(previous.anchor) ? previous.anchor : [...remaining][0] ?? null } })
      const rejected = result.outcomes.filter((item) => item.state === 'rejected')
      if (rejected.length) setAssetActionError(rejected.map((item) => item.message).join('；'))
    } catch (error) { if (current()) setAssetActionError(error instanceof Error ? error.message : '原收藏操作尚未确认，请在操作记录中核对') }
    finally { if (current()) { mutationContext.current.pending = false; setMutationState((previous) => ({ ...previous, busy: null })) } }
  }
  const runDelete = (ids: string[]) => runMutation('delete', ids)
  const runRestore = (ids: string[]) => runMutation('restore', ids)
  const runPurge = (ids: string[]) => runMutation('purge', ids)
  function moveCategory(ids: readonly string[]) {
    if (!mutationContext.current.mounted || mutationContext.current.generation !== mutationGeneration || actionsLocked || mutationContext.current.pending) return
    try { onMoveCategory?.(ids) } catch (cause) { setAssetActionError(cause instanceof Error ? cause.message : '素材分类尚未准备完成，请刷新核对') }
  }
  const [copyNotice, setCopyNotice] = useState<string | null>(null)
  useEffect(() => {
    if (!copyNotice) return undefined
    const timer = window.setTimeout(() => setCopyNotice(null), 2_400)
    return () => window.clearTimeout(timer)
  }, [copyNotice])
  const copyText = async (value: string, notice: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopyNotice(notice)
    } catch {
      setAssetActionError('复制失败，请手动选中后复制')
    }
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
  const filterChips = useMemo(() => activeAssetFilters(query, categoryDirectory?.items), [query, categoryDirectory])
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
      void toggleFavorite(asset)
      return true
    }
    setFocusIndex(action.index)
    tileRefs.current[action.index]?.focus()
    return true
  }

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    if (mutationContext.current.pending) return
    onQueryChange({ ...query, offset: 0, search: search.trim() })
  }
  const firstItem = page.total === 0 ? 0 : page.offset + 1
  const lastItem = page.offset + page.items.length
  const visibleTags = useMemo(() => page.facets.tags.slice(0, 12), [page.facets.tags])
  const beginRename = (asset: CanvasAssetSummary) => {
    if (!mutationContext.current.mounted || mutationContext.current.generation !== mutationGeneration || mutationContext.current.pending || mutationContext.current.writesBlocked) return
    renameGeneration.current = mutationGeneration
    setRenamingAsset(asset)
    setRenameDraft(assetName(asset))
    setRenameError(null)
  }
  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!mutationContext.current.mounted || mutationContext.current.generation !== mutationGeneration || !onRename || !renamingAsset || renameGeneration.current !== mutationContext.current.generation || renameSaving || mutationContext.current.pending || mutationContext.current.writesBlocked) return
    const generation = mutationGeneration
    function current() { return mutationContext.current.mounted && mutationContext.current.generation === generation }
    const displayName = renameDraft.trim()
    if (!displayName) {
      setRenameError('名称不能为空')
      return
    }
    mutationContext.current.pending = true
    setRenameSaving(true)
    setRenameError(null)
    try {
      await onRename(renamingAsset.assetId, displayName)
      if (current()) setRenamingAsset(null)
    } catch (error) {
      if (current()) setRenameError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) { mutationContext.current.pending = false; setRenameSaving(false) }
    }
  }
  const inspectReferences = async (asset: CanvasAssetSummary) => {
    if (!onInspectReferences || referenceBusy.current) return
    referenceBusy.current = true
    const epoch = ++referenceEpoch.current
    setReferenceAsset(asset)
    setReferenceReport(null)
    setReferenceError(null)
    setReferenceLoading(true)
    try {
      const report = await onInspectReferences(asset.assetId)
      if (epoch === referenceEpoch.current) setReferenceReport(report)
    } catch (error) {
      if (epoch === referenceEpoch.current) setReferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      referenceBusy.current = false
      if (epoch === referenceEpoch.current) setReferenceLoading(false)
    }
  }
  const checkRunInputs = async (retryUnavailable = false) => {
    if (!onCheckRunInputs || !referenceAsset || referenceBusy.current) return
    referenceBusy.current = true
    const epoch = ++referenceEpoch.current
    setReferenceError(null)
    setReferenceLoading(true)
    try {
      const report = await onCheckRunInputs(referenceAsset.assetId, retryUnavailable)
      if (epoch === referenceEpoch.current) setReferenceReport(report)
    } catch (error) {
      if (epoch === referenceEpoch.current) setReferenceError(error instanceof Error ? error.message : String(error))
    } finally {
      referenceBusy.current = false
      if (epoch === referenceEpoch.current) setReferenceLoading(false)
    }
  }
  const submitTags = async (event: FormEvent) => {
    event.preventDefault()
    if (!mutationContext.current.mounted || mutationContext.current.generation !== mutationGeneration || !onUpdateMetadata || !taggingAsset || tagGeneration.current !== mutationContext.current.generation || tagSaving || mutationContext.current.pending || mutationContext.current.writesBlocked) return
    const generation = mutationGeneration
    function current() { return mutationContext.current.mounted && mutationContext.current.generation === generation }
    let tags: string[]
    try { tags = parseAssetMetadataTagText(tagDraft) }
    catch (error) { setTagError(error instanceof Error ? error.message : '标签格式不正确'); return }
    mutationContext.current.pending = true
    setTagSaving(true)
    setTagError(null)
    try {
      await onUpdateMetadata(taggingAsset.assetId, { tags })
      if (current()) setTaggingAsset(null)
    } catch (error) {
      if (current()) setTagError(error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) { mutationContext.current.pending = false; setTagSaving(false) }
    }
  }

  return (
    <aside className={`asset-tray${embedded ? ' is-embedded' : ''}`} aria-label="本地资产">
      <header>
        <strong>素材库</strong>
        <span>{selection.ids.size > 1 ? `已选 ${selection.ids.size} / ${page.total}` : page.total}</span>
        <button type="button" title="导入 PNG、JPEG、WebP 图片、MP4 视频、MP3/WAV 音频；单个素材最多 32 MB" aria-label="从文件导入素材" onClick={onImport} disabled={loading || !!mutationBusy}><FolderOpen size={15} /></button>
        <button type="button" title="刷新资产" aria-label="刷新资产" onClick={onRefresh} disabled={loading || !!mutationBusy}><RefreshCw size={15} /></button>
        <button type="button" title="关闭资产栏" aria-label="关闭资产栏" onClick={onClose}><X size={16} /></button>
      </header>
      {sourceNavigation}
      {mutationRecoveryNotice}
      <nav className="asset-quick-views" aria-label="素材快速视图">
        <button type="button" className={query.view === 'all' ? 'is-active' : ''} aria-pressed={query.view === 'all'} disabled={!!mutationBusy} onClick={() => onQueryChange({ ...query, offset: 0, view: 'all' })}>全部</button>
        <button type="button" className={query.view === 'favorites' ? 'is-active' : ''} aria-pressed={query.view === 'favorites'} disabled={!!mutationBusy} onClick={() => onQueryChange({ ...query, offset: 0, view: 'favorites' })}><Star size={12} />收藏</button>
        <button type="button" className={query.view === 'recent' ? 'is-active' : ''} aria-pressed={query.view === 'recent'} disabled={!!mutationBusy} onClick={() => onQueryChange({ ...query, offset: 0, view: 'recent', sort: 'used-desc' })}><Clock3 size={12} />最近</button>
        {onDelete && <button type="button" className={query.view === 'trash' ? 'is-active' : ''} aria-pressed={query.view === 'trash'} disabled={!!mutationBusy} onClick={() => onQueryChange({ ...query, offset: 0, view: 'trash', sort: 'created-desc' })}><Trash2 size={12} />回收站</button>}
      </nav>
      {onManageCategories && <div className="asset-tray-category-controls">
        <AssetCategoryFilter items={categoryDirectory?.items ?? []} value={query.categoryId} onChange={(categoryId) => onQueryChange({ ...query, offset: 0, categoryId })} disabled={actionsLocked} loading={categoryLoading} directoryConfirmed={!!categoryDirectory && !categoryError} onManage={onManageCategories} />
        {query.categoryId !== undefined && <small>导入目标：{query.categoryId === null ? '未分类' : categoryDirectory?.items.find((item) => item.id === query.categoryId)?.name || '分类待核对'}</small>}
        {categoryError && <p role="alert">{categoryError}<button type="button" disabled={categoryLoading || actionsLocked} onClick={onReadCategories}>重新读取分类</button></p>}
        {categoryRecoveryNotice}
        {categoryRecoveryPending && <button type="button" disabled={actionsLocked} onClick={onManageCategories}>核对上次分类操作</button>}
      </div>}
      {(onAddMany || onDownloadMany) && <div className="asset-batch-toolbar" role="group" aria-label="素材批量复用">
        <div className="asset-batch-selection"><span>已选 {batchIds.length} 项</span><button type="button" disabled={loading || actionsLocked || !visibleAssetIds.length || visibleAssetIds.length > maximumAssetBatchCount} title={visibleAssetIds.length > maximumAssetBatchCount ? `本页超过 ${maximumAssetBatchCount} 项，请逐项选择` : '选择当前页，不包含其他分页'} onClick={() => setSelection(assetSelectionSelectAll(visibleAssetIds))}>全选本页</button><button type="button" disabled={actionsLocked || !batchIds.length} onClick={() => setSelection(emptyAssetSelection)}>取消选择</button></div>
        <div className="asset-batch-buttons">
          {onAddMany && <button type="button" disabled={loading || actionsLocked || !!batchError} title={batchError || '按列表顺序创建独立素材节点，不覆盖当前产物'} onClick={() => runBatch('add')}><Plus size={13} />{batch.busy === 'add' ? '正在加入…' : '加入画布'}</button>}
          {onDownloadMany && <button type="button" disabled={loading || actionsLocked || !!batchError} title={batchError || '按列表顺序打包所选原文件'} onClick={() => runBatch('download')}><Download size={13} />{batch.busy === 'download' ? '正在打包…' : '打包下载'}</button>}
        </div>
        <small>按当前列表顺序处理，最多 {maximumAssetBatchCount} 项{batchMayAdd ? '；可整体拖入画布。' : '；当前仅可打包下载。'}</small>
        {batchIds.length > 0 && batchError && <p role="status">{batchError}</p>}
        {batch.error && <p role="alert">{batch.error}</p>}{batch.notice && <p role="status">{batch.notice}</p>}
      </div>}
      {selection.ids.size > 0 && (onDelete || onRestore || onFavoriteMany) && (
        <div className="asset-selection-bar" role="group" aria-label="选中素材操作">
          <span>已选 {selection.ids.size} 项</span>
          {onMoveCategory && <button type="button" disabled={actionsLocked || categoryLoading || !categoryDirectory} onClick={() => moveCategory(batchIds)}>移动分类</button>}
          {query.view !== 'trash' && onFavoriteMany && <><button type="button" disabled={actionsLocked || mutationWritesBlocked || Boolean(batchError)} onClick={() => void favoriteMany(true)}>收藏所选</button><button type="button" disabled={actionsLocked || mutationWritesBlocked || Boolean(batchError)} onClick={() => void favoriteMany(false)}>取消收藏所选</button></>}
          {query.view === 'trash'
            ? <>
                {onRestore && <button type="button" disabled={actionsLocked || mutationWritesBlocked} onClick={() => void runRestore(batchIds)}>恢复</button>}
                {onPurge && <button type="button" className="is-danger" disabled={actionsLocked} onClick={() => void runPurge([...selection.ids])}>彻底删除</button>}
              </>
            : onDelete && <button type="button" disabled={actionsLocked || mutationWritesBlocked} onClick={() => void runDelete(batchIds)}>删除</button>}
        </div>
      )}
      {(assetActionError || mutationBusy || mutationResult || undoDelete) && <div className="asset-mutation-feedback">
        {assetActionError && <p className="asset-tray-action-error" role="alert">{assetActionError}</p>}
        {mutationBusy && <p className="asset-tray-copy-notice" role="status">{recoverableMutations && mutationBusy !== 'purge' ? '整批请求已交给原操作记录，正在等待回执；关闭不会撤销已提交批次。' : '正在逐项整理素材，请稍候…'}</p>}
        {mutationResult && <section className="asset-mutation-result" aria-label="素材整理结果" role="status">
          <strong>{mutationResult.outcomes.filter((item) => item.state === 'succeeded').length} 项成功 · {mutationResult.outcomes.filter((item) => item.state === 'rejected').length} 项已拒绝 · {mutationResult.outcomes.filter((item) => item.state === 'unconfirmed').length} 项未确认 · {mutationResult.outcomes.filter((item) => item.state === 'not-started').length} 项未发送</strong>
          {(mutationResult.outcomes.some((item) => item.state !== 'succeeded') || mutationResult.refreshError) && <div className="asset-mutation-issues">
            {mutationResult.outcomes.filter((item) => item.state !== 'succeeded').map((item) => <p key={item.assetId}>{page.items.find((asset) => asset.assetId === item.assetId)?.displayName || item.assetId}：{item.message}</p>)}
            {mutationResult.refreshError && <p>{mutationResult.refreshError}</p>}
          </div>}
        </section>}
        {undoDelete && (
          <div className="asset-undo-toast" role="status" aria-live="polite">
            <span>已移入回收站 {undoDelete.count} 项</span>
            <button type="button" onClick={() => void runRestore(undoDelete.ids)}>撤销</button>
            <button type="button" aria-label="关闭撤销提示" onClick={() => setUndoDelete(null)}><X size={13} /></button>
          </div>
        )}
      </div>}
      {/* One tool row instead of three stacked ones. The selects were about
          eighty pixels of chrome sitting at their defaults nearly all the time;
          they move into a popover, and what is actually narrowing the results
          shows below as chips that can each be taken off. */}
      <div className="asset-tray-toolbar">
        <form className="asset-tray-search" role="search" onSubmit={submitSearch}>
          <label>
            <Search size={14} aria-hidden="true" />
            <input ref={searchInputRef} value={search} disabled={!!mutationBusy} maxLength={128} aria-label="搜索本地资产" placeholder="搜索名称或资产 ID" onChange={(event) => setSearch(event.target.value)} />
            {search && <button type="button" className="asset-search-clear" aria-label="清空素材搜索" onClick={() => { setSearch(''); onQueryChange({ ...query, offset: 0, search: '' }); searchInputRef.current?.focus() }}><X size={13} /></button>}
          </label>
          <button type="submit" className="asset-search-submit" aria-label="搜索素材" disabled={!!mutationBusy}>搜索</button>
        </form>
        <div className="asset-filter-anchor" ref={filterAnchorRef}>
          <button
            type="button"
            className={`asset-filter-trigger${filterCount > 0 ? ' is-active' : ''}`}
            title="筛选与排序"
            aria-label="筛选与排序"
            aria-expanded={filterMenuOpen}
            disabled={!!mutationBusy}
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
        style={{ gridTemplateColumns: `repeat(${density === 'compact' ? 3 : density === 'cozy' ? 2 : 1}, minmax(0, 1fr))` }}
        aria-busy={loading}
        aria-multiselectable="true"
        onClick={(event) => { if (!actionsLocked && event.target === event.currentTarget) setSelection(emptyAssetSelection) }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (actionsLocked || mutationContext.current.pending) { if (['Delete', 'Escape', 'a', 'A'].includes(event.key)) { event.preventDefault(); event.stopPropagation() }; return }
          if (event.key === 'Delete' && selection.ids.size > 0) {
            event.preventDefault()
            // Delete never destroys anything here; in the bin it restores
            // instead, because the destructive twin needs a deliberate press.
            void (query.view === 'trash' ? runRestore([...selection.ids]) : runDelete([...selection.ids]))
            return
          }
          if (!(event.key === 'a' || event.key === 'A') || !(event.ctrlKey || event.metaKey)) return
          event.preventDefault(); event.stopPropagation()
          if ((onAddMany || onDownloadMany) && visibleAssetIds.length > maximumAssetBatchCount) { batch.reportError(`本页超过 ${maximumAssetBatchCount} 项，请逐项选择`); return }
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
                if (empty.kind === 'clear-filters') return onQueryChange({ ...query, offset: 0, tag: undefined, mediaType: 'all', source: 'all', prompt: undefined, runId: undefined, nodeId: undefined, categoryId: undefined })
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
          const metadata = assetLabel(asset)
          const canAdd = batchMayAdd && !assetBatchUnavailableReason(asset) && query.view !== 'trash'
          const batchLocked = actionsLocked
          return (
            <article
              className={`asset-tray-item asset-tray-item-${asset.mediaType}${selected ? ' is-selected' : ''}${expanded ? ' is-expanded' : ''}`}
              key={asset.assetId}
              aria-label={`${name}，${assetLabel(asset)}`}
              onContextMenu={(event) => {
                event.preventDefault()
                if (batchLocked) return
                // Acting on one of several selected tiles must not silently
                // discard the rest of the selection.
                setSelection((value) => assetSelectionForContextMenu(value, asset.assetId))
                onAssetMenu(asset.assetId)
              }}
              draggable={canAdd && !batchLocked}
              // Recent use is recorded by whoever accepts the drop. Marking it
              // here counted drags that were cancelled, dropped on nothing or
              // rejected for the wrong media type, which pushed assets the user
              // never placed to the top of the recent view.
              onDragStart={(event) => {
                if (!canAdd || batchLocked) { event.preventDefault(); return }
                try {
                  const ids = assetBatchDragIds(batchItems, selection, asset.assetId)
                  event.dataTransfer.setData(assetBatchDragMime, JSON.stringify(ids))
                  if (ids.length === 1) event.dataTransfer.setData('application/x-xingmang-asset-id', ids[0])
                  event.dataTransfer.effectAllowed = 'copy'
                } catch (cause) { event.preventDefault(); batch.reportError(cause instanceof Error ? cause.message : '无法拖入所选素材，请重新选择') }
              }}
            >
              <div
                className="asset-tray-item-preview"
                role="group"
                title={assetHoverTitle(asset)}
                ref={(element) => { tileRefs.current[index] = element }}
                // Roving tabindex: the grid is one tab stop, not one per tile,
                // so Tab reaches the pagination controls without twenty-four
                // presses. Arrow keys move within it.
                tabIndex={index === tabStopIndex ? 0 : -1}
                aria-label={`查看素材详情：${name}`}
                aria-expanded={expanded}
                aria-controls="asset-tray-detail-panel"
                onFocus={() => setFocusIndex(index)}
                onClick={(event) => { if (!batchLocked) setSelection((value) => assetSelectionForActivation(
                  value, asset.assetId, visibleAssetIds, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey },
                )) }}
                onDoubleClick={() => { if (available) setPreviewAsset(asset) }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                  if (batchLocked) return
                  const next = assetSelectionAfterKey(
                    event.key, selection, asset.assetId, visibleAssetIds, { toggle: event.ctrlKey || event.metaKey, range: event.shiftKey },
                  )
                  if (next === undefined) {
                    if (handleGridKey(event.key, index, asset)) event.preventDefault()
                    return
                  }
                  event.preventDefault(); event.stopPropagation()
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
                  : asset.mediaType === 'video'
                    ? <VideoCoverImage
                        thumbnailUrl={asset.thumbnailUrl}
                        videoUrl={asset.localUrl}
                        alt={name}
                        loading="lazy"
                        fallbackLabel={available ? 'MP4 视频' : '素材不可用'}
                      />
                    : available
                      ? <SafeImage
                          src={asset.thumbnailUrl}
                          fallbackSrc={asset.localUrl}
                          alt={name}
                          loading="lazy"
                        />
                      : <span className="asset-video-placeholder"><Film size={22} /><small>素材不可用</small></span>}
              </div>
                {(onAddMany || onDownloadMany) && <label className="asset-batch-checkbox asset-tray-batch-select" title={selected ? '取消选择' : '选择素材'}><input type="checkbox" aria-label={`选择素材：${name}`} checked={selected} disabled={batchLocked || loading} onChange={() => setSelection((value) => assetSelectionForActivation(value, asset.assetId, visibleAssetIds, { toggle: true }))} /><span>选择</span></label>}
              <div className="asset-tray-item-tools" aria-label="素材操作">
                {onUpdateMetadata && <button type="button" className={asset.favorite ? 'is-favorite' : ''} title={asset.favorite ? '取消收藏' : '收藏'} aria-label={`${asset.favorite ? '取消收藏' : '收藏'}：${name}`} aria-pressed={asset.favorite} disabled={actionsLocked || mutationWritesBlocked || favoriteSavingIds.has(asset.assetId)} onClick={() => void toggleFavorite(asset)}><Star size={13} fill={asset.favorite ? 'currentColor' : 'none'} /></button>}
                <button type="button" className="is-optional-preview" disabled={!available} title="放大预览" aria-label={`放大预览：${name}`} onClick={() => setPreviewAsset(asset)}><Eye size={13} /></button>
                {onRename && <button type="button" className="is-optional-rename" title="重命名" aria-label={`重命名素材：${name}`} disabled={actionsLocked || mutationWritesBlocked} onClick={() => beginRename(asset)}><Pencil size={13} /></button>}
                <button type="button" className="is-optional-menu" title="更多操作" aria-label={`打开素材操作：${name}`} onClick={() => onAssetMenu(asset.assetId)}><MoreHorizontal size={13} /></button>
              </div>
              <div className="asset-tray-item-meta">
                <div><span title={name}>{name}</span><small>{metadata === assetTypeName(asset) ? metadata : `${assetTypeName(asset)} · ${metadata}`}</small></div>
                <button type="button" className="asset-tray-add" title={canAdd ? '添加到画布' : !batchMayAdd ? '当前项目只读，不能添加素材' : query.view === 'trash' || asset.deletedAt ? '恢复素材后可添加到画布' : '素材不可用'} aria-label={`添加资产到画布：${name}`} disabled={!canAdd || batchLocked} onClick={() => { onAdd(asset.assetId); setCopyNotice(`已添加「${name}」到画布`) }}><Plus size={15} /></button>
              </div>
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
                  : <SafeImage src={asset.thumbnailUrl} fallbackSrc={asset.localUrl} alt={name} loading="lazy" />}
            </div>
            <div className="asset-tray-item-details">
              <div className="asset-tray-item-detail-head">
                <strong title={name}>{name}</strong>
                {!available && <span className="asset-unavailable-badge">不可用</span>}
                <button type="button" title="放大预览" aria-label={`放大预览：${name}`} disabled={!available} onClick={() => setPreviewAsset(asset)}><Eye size={12} /></button>
                {onRename && <button type="button" title="重命名" aria-label={`重命名素材：${name}`} disabled={actionsLocked || mutationWritesBlocked} onClick={() => beginRename(asset)}><Pencil size={12} /></button>}
                {onUpdateMetadata && <button type="button" title="编辑标签" aria-label={`编辑素材标签：${name}`} disabled={actionsLocked || mutationWritesBlocked} onClick={() => { if (!mutationContext.current.mounted || mutationContext.current.generation !== mutationGeneration || mutationContext.current.pending || mutationContext.current.writesBlocked) return; tagGeneration.current = mutationGeneration; setTaggingAsset(asset); setTagDraft((asset.tags ?? []).join(', ')); setTagError(null) }}><Tags size={12} /></button>}
                {onInspectReferences && <button type="button" title="检查引用与删除保护" aria-label={`检查素材引用：${name}`} onClick={() => void inspectReferences(asset)}><ShieldCheck size={12} /></button>}
                <button type="button" title="关闭详情" aria-label={`关闭素材详情：${name}`} onClick={() => setSelection(emptyAssetSelection)}><X size={12} /></button>
              </div>
              {/* The prompt comes first because it is what the person who made
                  the image remembers about it; the file name and the hash are
                  what the computer remembers. */}
              {metadataPending && <div className="asset-detail-metadata-status" role={detailFailure?.assetId === detailAssetId ? 'alert' : 'status'}>
                {detailFailure?.assetId === detailAssetId ? <><p>{detailFailure.message}</p><button type="button" onClick={() => setDetailRetry((value) => value + 1)}>重新读取素材详情</button></> : <p>正在读取完整提示词和生成来源…</p>}
              </div>}
              {asset.prompt && (
                <div className="asset-detail-prompt">
                  <div className="asset-detail-prompt-head">
                    <dt>提示词</dt>
                    <button type="button" title="复制提示词" aria-label={`复制提示词：${name}`} onClick={() => void copyText(asset.prompt!, '提示词已复制')}><Copy size={12} /></button>
                  </div>
                  <p>{asset.prompt}</p>
                </div>
              )}
              <div className="asset-detail-similar" role="group" aria-label="查找相似素材">
                {asset.prompt && <button type="button" onClick={() => onQueryChange({ ...query, offset: 0, prompt: asset.prompt, runId: undefined, nodeId: undefined })}>同提示词</button>}
                {asset.lineage && <button type="button" onClick={() => onQueryChange({ ...query, offset: 0, runId: asset.lineage!.runId, nodeId: undefined, prompt: undefined })}>同一次运行</button>}
                {asset.lineage && <button type="button" onClick={() => onQueryChange({ ...query, offset: 0, nodeId: asset.lineage!.nodeId, runId: undefined, prompt: undefined })}>同来源节点</button>}
              </div>
              {onMoveCategory && <div className="asset-detail-similar"><span>分类：{asset.categoryId ? categoryDirectory?.items.find((item) => item.id === asset.categoryId)?.name || '分类待核对' : '未分类'}</span><button type="button" disabled={actionsLocked || categoryLoading || !categoryDirectory} aria-label={`移动素材分类：${name}`} onClick={() => moveCategory([asset.assetId])}>移动分类</button></div>}
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
                <div><dt>来源</dt><dd>{asset.officialSource ? `官方素材 · ${asset.officialSource.title}` : asset.source === 'generated' ? 'AI 生成' : asset.source === 'imported' ? '本地导入' : '历史素材'}</dd></div>
                {asset.officialSource && <><div><dt>出处</dt><dd>{asset.officialSource.attribution}</dd></div><div><dt>使用说明</dt><dd>{asset.officialSource.licenseLabel}</dd></div></>}
                {asset.lastUsedAt && <div><dt>最近使用</dt><dd>{new Date(asset.lastUsedAt).toLocaleString()}</dd></div>}
                {asset.lineage && <div><dt>生成来源</dt><dd>{asset.lineage.sourceAssetIds.length} 个上游素材</dd></div>}
                {/* Shown in full: this panel exists to give the exact value, and
                    a truncated hash cannot be copied. */}
                <div><dt>资产 ID</dt><dd className="is-identifier" title={asset.assetId}>
                  {asset.assetId}
                  <button type="button" title="复制资产 ID" aria-label={`复制资产 ID：${name}`} onClick={() => void copyText(asset.assetId, '资产 ID 已复制')}><Copy size={11} /></button>
                </dd></div>
              </dl>
              {/* Project-scoped complete details hide provenance; only the strict asset lookup can establish its source. */}
              {onReadAssetOrigin && <AssetOriginNavigation assetId={asset.assetId} scopeKey={batchScope ?? selectionScope} readOrigin={onReadAssetOrigin} active={() => mutationContext.current.mounted && mutationContext.current.scope === selectionScope} />}
              {(asset.tags?.length ?? 0) > 0 && <div className="asset-item-tags">{asset.tags?.map((tag) => <button type="button" key={tag} onClick={() => onQueryChange({ ...query, offset: 0, tag })}>{tag}</button>)}</div>}
            </div>
          </section>
        )
      })()}
      {copyNotice && <p className="asset-tray-copy-notice" role="status">{copyNotice}</p>}
      <footer className="asset-tray-pagination">
        <span>{firstItem}-{lastItem} / {page.total}</span>
        <button type="button" title="上一页" aria-label="上一页资产" disabled={loading || !!mutationBusy || page.offset === 0} onClick={() => onQueryChange({ ...query, offset: Math.max(0, page.offset - page.limit) })}><ChevronLeft size={15} /></button>
        <button type="button" title="下一页" aria-label="下一页资产" disabled={loading || !!mutationBusy || !page.hasMore} onClick={() => onQueryChange({ ...query, offset: page.offset + page.limit })}><ChevronRight size={15} /></button>
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
      {renamingAsset && renameGeneration.current === mutationGeneration && (
        <div className="asset-rename-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !renameSaving) setRenamingAsset(null)
        }}>
          <form className="asset-rename-dialog" role="dialog" aria-modal="true" aria-label="重命名素材" onSubmit={(event) => void submitRename(event)}>
            <header><strong>重命名素材</strong><button type="button" title="关闭" aria-label="关闭重命名" disabled={renameSaving} onClick={() => setRenamingAsset(null)}><X size={16} /></button></header>
            <label>
              <span>显示名称</span>
              <input autoFocus disabled={renameSaving} value={renameDraft} maxLength={160} onChange={(event) => setRenameDraft(event.target.value)} />
            </label>
            <small>更新素材库中的显示名称，不会修改原文件名。</small>
            {renameError && <p role="alert">{renameError}</p>}
            <footer>
              <button type="button" disabled={renameSaving} onClick={() => setRenamingAsset(null)}>取消</button>
              <button type="submit" className="is-primary" disabled={renameSaving || mutationWritesBlocked || !renameDraft.trim()}>{renameSaving ? '保存中…' : '保存'}</button>
            </footer>
          </form>
        </div>
      )}
      {taggingAsset && tagGeneration.current === mutationGeneration && (
        <div className="asset-rename-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !tagSaving) setTaggingAsset(null)
        }}>
          <form className="asset-rename-dialog asset-tag-dialog" role="dialog" aria-modal="true" aria-label="编辑素材标签" onSubmit={(event) => void submitTags(event)}>
            <header><strong>编辑素材标签</strong><button type="button" title="关闭" aria-label="关闭标签编辑" disabled={tagSaving} onClick={() => setTaggingAsset(null)}><X size={16} /></button></header>
            <label>
              <span>标签</span>
              <input autoFocus disabled={tagSaving} value={tagDraft} maxLength={1_000} placeholder="例如：产品图, 已定稿" onChange={(event) => setTagDraft(event.target.value)} />
            </label>
            <small>使用中英文逗号分隔，最多 20 个，每个最多 40 个字符。</small>
            {tagError && <p role="alert">{tagError}</p>}
            <footer>
              <button type="button" disabled={tagSaving} onClick={() => setTaggingAsset(null)}>取消</button>
              <button type="submit" className="is-primary" disabled={tagSaving || mutationWritesBlocked}>{tagSaving ? '保存中…' : '保存'}</button>
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
              <span>{referenceReport && (referenceReport.inUse || assetReferenceScanIncomplete(referenceReport)) ? <TriangleAlert size={16} /> : <ShieldCheck size={16} />}<strong>素材引用检查</strong></span>
              <button type="button" title="关闭" aria-label="关闭素材引用检查" disabled={referenceLoading} onClick={() => setReferenceAsset(null)}><X size={16} /></button>
            </header>
            <div className="asset-reference-target"><strong title={assetName(referenceAsset)}>{assetName(referenceAsset)}</strong><small title={referenceAsset.assetId}>{middleTruncate(referenceAsset.assetId, 20)}</small></div>
            {referenceLoading && <p role="status">正在核对素材引用…</p>}
            {referenceError && <p className="asset-reference-error" role="alert">{referenceError}</p>}
            {referenceReport && <AssetReferenceDetails report={referenceReport} loading={referenceLoading} onCheckRunInputs={onCheckRunInputs ? (retryUnavailable) => { void checkRunInputs(retryUnavailable) } : undefined} />}
            <footer><button type="button" disabled={referenceLoading} onClick={() => setReferenceAsset(null)}>关闭</button></footer>
          </section>
        </div>
      )}
    </aside>
  )
}
