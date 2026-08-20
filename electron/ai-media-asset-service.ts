import type { AiAssetStore, AiStoredAsset } from './ai-asset-store'
import type { AiStoredVideoAssetListItem, AiVideoAssetStore } from './ai-video-asset-store'
import type { AiAudioAssetStore, AiStoredAudioAssetListItem } from './ai-audio-asset-store'
import type { AiAssetMetadataStore, AiAssetSource } from './ai-asset-metadata-store'
import { MAXIMUM_INDEXED_ASSETS, type AiAssetIndexEntry } from './ai-asset-index'
import { assetThumbnailUrl } from './asset-thumbnail'

export type AiMediaAssetView = 'all' | 'favorites' | 'recent' | 'trash'
/**
 * `deleted-desc` is the recycle bin's own order and is not offered in the sort
 * control: a bin ordered by anything other than when things went into it makes
 * "what did I just delete" the hardest question to answer.
 */
export type AiMediaAssetSort = 'created-desc' | 'created-asc' | 'used-desc' | 'name-asc' | 'deleted-desc'

export interface AiMediaAssetListQuery {
  offset?: number
  limit?: number
  mediaType?: 'all' | 'image' | 'video' | 'audio'
  search?: string
  view?: AiMediaAssetView
  tag?: string
  source?: 'all' | AiAssetSource
  sort?: AiMediaAssetSort
  /**
   * Restricts the library to a known set of identifiers. "Find similar" resolves
   * a run or a source node to its assets outside this service and hands the set
   * in, so the restriction is applied before paging and the total stays honest.
   */
  assetIds?: readonly string[]
  /** Exact prompt match, used by "find similar" where a substring search would drag in unrelated work. */
  prompt?: string
}

export interface AiMediaAssetListPage {
  items: Array<
    | (AiStoredAsset & { createdAt: string; mediaType: 'image'; thumbnailUrl: string; displayName: string; favorite: boolean; tags: string[]; source: AiAssetSource; lastUsedAt?: string; deletedAt?: string; prompt?: string })
    | (AiStoredVideoAssetListItem & { displayName: string; favorite: boolean; tags: string[]; source: AiAssetSource; lastUsedAt?: string; deletedAt?: string; prompt?: string })
    | (AiStoredAudioAssetListItem & { displayName: string; favorite: boolean; tags: string[]; source: AiAssetSource; lastUsedAt?: string; deletedAt?: string; prompt?: string })
  >
  offset: number
  limit: number
  total: number
  hasMore: boolean
  facets: AiMediaAssetFacets
}

export interface AiMediaAssetFacets {
  /** Ordered by descending count, then by name. Counts cover the whole library. */
  tags: Array<{ tag: string; count: number }>
}

interface AiMediaAssetRow {
  entry: AiAssetIndexEntry
  displayName: string
  favorite: boolean
  tags: string[]
  source: AiAssetSource
  lastUsedAt?: string
  deletedAt?: string
  prompt?: string
}

// Bounded so the facet panel cannot grow a DTO without limit: the metadata
// store allows twelve tags per asset across five thousand assets.
const MAXIMUM_TAG_FACETS = 64

function tagFacets(rows: readonly AiMediaAssetRow[]): AiMediaAssetFacets['tags'] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const tag of row.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag, 'zh-CN'))
    .slice(0, MAXIMUM_TAG_FACETS)
}

export function createAiMediaAssetService(options: {
  images: Pick<AiAssetStore, 'readOwned' | 'listOwnedIndex' | 'copy' | 'saveAs' | 'contextMenu' | 'resolveOwnedFilePath' | 'forgetOwned'>
  videos: Pick<AiVideoAssetStore, 'readOwned' | 'listOwnedIndex' | 'saveAs' | 'contextMenu' | 'resolveOwnedFilePath'>
  audios?: Pick<AiAudioAssetStore, 'readOwned' | 'listOwnedIndex' | 'saveAs' | 'contextMenu' | 'resolveOwnedFilePath'>
  metadata: Pick<AiAssetMetadataStore, 'getAll' | 'rename' | 'updatePreferences' | 'markUsed' | 'setSource' | 'softDelete' | 'restore' | 'forget'>
  /**
   * Hands the file to the OS recycle bin. Injected so tests never delete
   * anything real, and so the service never imports Electron's shell.
   */
  trashItem: (filePath: string) => Promise<void>
}) {
  async function readOwned(userId: number, assetId: string, kind?: 'image' | 'video' | 'audio') {
    if (kind === 'image') return options.images.readOwned(userId, assetId)
    if (kind === 'video') return options.videos.readOwned(userId, assetId)
    if (kind === 'audio') {
      if (!options.audios) throw new Error('音频素材能力不可用')
      return options.audios.readOwned(userId, assetId)
    }
    try {
      return await options.images.readOwned(userId, assetId)
    } catch {
      try { return await options.videos.readOwned(userId, assetId) } catch {
        if (!options.audios) throw new Error('AI 素材不存在或无权访问')
        return options.audios.readOwned(userId, assetId)
      }
    }
  }

  async function listOwnedPage(userId: number, query: AiMediaAssetListQuery = {}): Promise<AiMediaAssetListPage> {
    const offset = query.offset ?? 0
    const limit = query.limit ?? 24
    const mediaType = query.mediaType ?? 'all'
    const search = query.search?.trim() ?? ''
    const view = query.view ?? 'all'
    const tag = query.tag?.trim() ?? ''
    const source = query.source ?? 'all'
    const sort = query.sort ?? (view === 'recent' ? 'used-desc' : view === 'trash' ? 'deleted-desc' : 'created-desc')
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAXIMUM_INDEXED_ASSETS) throw new Error('AI 素材分页位置无效')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('AI 素材分页数量无效')
    if (!['all', 'image', 'video', 'audio'].includes(mediaType)) throw new Error('AI 素材媒体类型无效')
    if (search.length > 128 || /[\x00-\x1F\x7F]/.test(search)) throw new Error('AI 素材搜索内容无效')
    if (!['all', 'favorites', 'recent', 'trash'].includes(view)) throw new Error('AI 素材快速视图无效')
    if (tag.length > 32 || /[\x00-\x1F\x7F]/.test(tag)) throw new Error('AI 素材标签筛选无效')
    if (!['all', 'generated', 'imported', 'legacy'].includes(source)) throw new Error('AI 素材来源筛选无效')
    if (!['created-desc', 'created-asc', 'used-desc', 'name-asc', 'deleted-desc'].includes(sort)) throw new Error('AI 素材排序无效')
    const promptFilter = query.prompt?.trim() ?? ''
    if (promptFilter.length > 2_000) throw new Error('AI 素材提示词筛选无效')
    const restriction = query.assetIds ? new Set(query.assetIds) : null
    if (restriction && restriction.size > MAXIMUM_INDEXED_ASSETS) throw new Error('AI 素材筛选集合过大')
    // Filtering, sorting and paging all run on the complete index. The previous
    // implementation asked each store for its first 500 fully-decoded assets and
    // only then searched and sorted, so past that ceiling the library silently
    // answered from an arbitrary slice while reporting its size as the total.
    const [images, videos, audios] = await Promise.all([
      mediaType === 'video' || mediaType === 'audio' ? [] : options.images.listOwnedIndex(userId),
      mediaType === 'image' || mediaType === 'audio' ? [] : options.videos.listOwnedIndex(userId),
      mediaType === 'image' || mediaType === 'video' || !options.audios ? [] : options.audios.listOwnedIndex(userId),
    ])
    const metadata = await options.metadata.getAll(userId)
    const normalizedSearch = search.toLocaleLowerCase('zh-CN')
    const scoped = [...images, ...videos, ...audios]
      .map((entry): AiMediaAssetRow => {
        const logical = metadata[entry.assetId]
        return {
          entry,
          displayName: logical?.displayName ?? entry.fileName,
          favorite: logical?.favorite === true,
          tags: [...(logical?.tags ?? [])],
          source: logical?.source ?? 'legacy' as AiAssetSource,
          ...(logical?.lastUsedAt ? { lastUsedAt: logical.lastUsedAt } : {}),
          ...(logical?.deletedAt ? { deletedAt: logical.deletedAt } : {}),
          ...(logical?.prompt ? { prompt: logical.prompt } : {}),
        }
      })
      .filter((row) => !restriction || restriction.has(row.entry.assetId))
      .filter((row) => !promptFilter || row.prompt === promptFilter)
      // A deleted asset is absent from every view but the bin, and the bin
      // contains nothing else. Leaking one into the normal library would make
      // "deleted" mean nothing.
      .filter((row) => (view === 'trash') === Boolean(row.deletedAt))
      .filter((row) => view !== 'favorites' || row.favorite)
      .filter((row) => view !== 'recent' || Boolean(row.lastUsedAt))
      .filter((row) => source === 'all' || row.source === source)
      // The prompt is searchable because it is the one thing a person reliably
      // remembers about an image they generated weeks ago.
      .filter((row) => !normalizedSearch || [row.displayName, row.entry.fileName, row.entry.assetId, row.prompt ?? '', ...row.tags]
        .some((value) => value.toLocaleLowerCase('zh-CN').includes(normalizedSearch)))
    // Counted before the tag filter so that picking one tag does not erase its
    // siblings from the panel, and over the whole scoped library rather than
    // the current page, which used to make the tag list change while paging.
    const facets = { tags: tagFacets(scoped) }
    const rows = scoped
      .filter((row) => !tag || row.tags.includes(tag))
      .sort((left, right) => {
        if (sort === 'created-asc') return left.entry.createdAt.localeCompare(right.entry.createdAt) || left.entry.assetId.localeCompare(right.entry.assetId)
        if (sort === 'used-desc') return (right.lastUsedAt ?? '').localeCompare(left.lastUsedAt ?? '') || right.entry.createdAt.localeCompare(left.entry.createdAt) || right.entry.assetId.localeCompare(left.entry.assetId)
        if (sort === 'name-asc') return left.displayName.localeCompare(right.displayName, 'zh-CN') || right.entry.createdAt.localeCompare(left.entry.createdAt) || right.entry.assetId.localeCompare(left.entry.assetId)
        if (sort === 'deleted-desc') return (right.deletedAt ?? '').localeCompare(left.deletedAt ?? '') || right.entry.createdAt.localeCompare(left.entry.createdAt) || right.entry.assetId.localeCompare(left.entry.assetId)
        return right.entry.createdAt.localeCompare(left.entry.createdAt) || right.entry.assetId.localeCompare(left.entry.assetId)
      })
    const page = rows.slice(offset, offset + limit)
    return {
      items: await hydrateRows(userId, page),
      offset,
      limit,
      total: rows.length,
      hasMore: offset + page.length < rows.length,
      facets,
    }
  }

  /**
   * Reads media for one page only. Hydration stays serial because each read
   * pulls a whole file into memory under the owning store's size ceiling, and
   * a 128 MB video times any concurrency factor is a real memory spike. Serial
   * reads of at most `limit` files still cost a fraction of the old path, which
   * decoded up to 500 files before it could answer.
   */
  async function hydrateRows(userId: number, rows: readonly AiMediaAssetRow[]): Promise<AiMediaAssetListPage['items']> {
    const items: AiMediaAssetListPage['items'] = []
    for (const row of rows) {
      const organization = {
        displayName: row.displayName,
        favorite: row.favorite,
        tags: row.tags,
        source: row.source,
        ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
        ...(row.deletedAt ? { deletedAt: row.deletedAt } : {}),
        ...(row.prompt ? { prompt: row.prompt } : {}),
      }
      try {
        // A file deleted or damaged between indexing and hydration is omitted
        // rather than failing the whole page.
        // thumbnailUrl points at the derived 320 pixel image rather than the
        // original. A grid of two dozen tiles used to decode close to a hundred
        // megabytes of full resolution bitmaps for previews a few hundred
        // pixels wide.
        if (row.entry.mediaType === 'image') {
          const { asset } = await options.images.readOwned(userId, row.entry.assetId)
          items.push({ ...asset, createdAt: row.entry.createdAt, mediaType: 'image', thumbnailUrl: assetThumbnailUrl(row.entry.assetId, 'image'), ...organization })
        } else if (row.entry.mediaType === 'video') {
          const { asset } = await options.videos.readOwned(userId, row.entry.assetId)
          items.push({ ...asset, createdAt: row.entry.createdAt, mediaType: 'video', thumbnailUrl: assetThumbnailUrl(row.entry.assetId, 'video'), ...organization })
        } else if (options.audios) {
          const { asset } = await options.audios.readOwned(userId, row.entry.assetId)
          items.push({ ...asset, createdAt: row.entry.createdAt, mediaType: 'audio', thumbnailUrl: asset.localUrl, ...organization })
        }
      } catch {
        continue
      }
    }
    return items
  }

  async function assetKind(userId: number, assetId: string): Promise<'image' | 'video' | 'audio'> {
    try {
      await options.images.readOwned(userId, assetId)
      return 'image'
    } catch {
      try { await options.videos.readOwned(userId, assetId); return 'video' } catch {
        if (!options.audios) throw new Error('AI 素材不存在或无权访问')
        await options.audios.readOwned(userId, assetId); return 'audio'
      }
    }
  }

  async function copy(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    if (await assetKind(userId, assetId) !== 'image') throw new Error('视频不支持复制，请使用另存为')
    await options.images.copy(userId, assetId, authorize)
  }

  async function saveAs(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<boolean> {
    const kind = await assetKind(userId, assetId)
    if (kind === 'image') return options.images.saveAs(userId, assetId, authorize)
    if (kind === 'video') return options.videos.saveAs(userId, assetId, authorize)
    if (!options.audios) throw new Error('音频素材能力不可用')
    return options.audios.saveAs(userId, assetId, authorize)
  }

  async function contextMenu(userId: number, assetId: string, authorize?: () => void | Promise<void>): Promise<void> {
    const kind = await assetKind(userId, assetId)
    if (kind === 'image') return options.images.contextMenu(userId, assetId, authorize)
    if (kind === 'video') return options.videos.contextMenu(userId, assetId, authorize)
    if (!options.audios) throw new Error('音频素材能力不可用')
    return options.audios.contextMenu(userId, assetId, authorize)
  }

  async function rename(userId: number, assetId: string, displayName: string) {
    await readOwned(userId, assetId)
    const renamed = await options.metadata.rename(userId, assetId, displayName)
    return { assetId: renamed.assetId, displayName: renamed.displayName }
  }

  async function updateMetadata(userId: number, assetId: string, input: { favorite?: boolean; tags?: string[] }) {
    await readOwned(userId, assetId)
    const updated = await options.metadata.updatePreferences(userId, assetId, input)
    return {
      assetId: updated.assetId,
      favorite: updated.favorite === true,
      tags: [...(updated.tags ?? [])],
      ...(updated.lastUsedAt ? { lastUsedAt: updated.lastUsedAt } : {}),
    }
  }

  async function markUsed(userId: number, assetId: string) {
    await readOwned(userId, assetId)
    const updated = await options.metadata.markUsed(userId, assetId)
    return { assetId: updated.assetId, lastUsedAt: updated.lastUsedAt as string }
  }

  async function setSource(userId: number, assetId: string, source: AiAssetSource, prompt?: string) {
    await readOwned(userId, assetId)
    const updated = await options.metadata.setSource(userId, assetId, source, prompt)
    return { assetId: updated.assetId, source: updated.source as AiAssetSource }
  }

  /**
   * Moves an asset to the recycle bin. Nothing is written outside the metadata
   * file, so this is cheap to undo and cannot lose bytes.
   */
  async function softDelete(userId: number, assetId: string) {
    await readOwned(userId, assetId)
    const deleted = await options.metadata.softDelete(userId, assetId)
    return { assetId: deleted.assetId, deletedAt: deleted.deletedAt as string }
  }

  async function restore(userId: number, assetId: string) {
    await readOwned(userId, assetId)
    const restored = await options.metadata.restore(userId, assetId)
    return { assetId: restored.assetId }
  }

  /**
   * Empties one asset out of the bin for good.
   *
   * Reference blocking happens here and only here. Refusing to soft delete a
   * referenced asset would make the bin useless -- assets are referenced
   * precisely because they were used -- while permanent deletion is the point
   * of no return, and a workflow that loses an input it still points at cannot
   * be repaired by undo.
   *
   * The bytes go to the OS trash rather than to unlink: this is a user's
   * artwork, and the last recoverable copy should not depend on us.
   */
  async function purge(
    userId: number,
    assetId: string,
    references?: () => Promise<{ inUse: boolean }>,
  ) {
    const kind = await assetKind(userId, assetId)
    if (references) {
      const report = await references()
      if (report.inUse) throw new Error('该素材仍被工作流或运行记录引用，无法彻底删除')
    }
    const filePath = kind === 'image'
      ? await options.images.resolveOwnedFilePath(userId, assetId)
      : kind === 'video'
        ? await options.videos.resolveOwnedFilePath(userId, assetId)
        : await (options.audios ?? never('音频素材能力不可用')).resolveOwnedFilePath(userId, assetId)
    await options.trashItem(filePath)
    if (kind === 'image') options.images.forgetOwned(assetId)
    // Metadata is dropped last: a record without a file shows as a broken tile,
    // while a file without a record is simply an unnamed asset.
    await options.metadata.forget(userId, assetId)
    return { assetId }
  }

  function never(message: string): never {
    throw new Error(message)
  }

  return { readOwned, listOwnedPage, copy, saveAs, contextMenu, rename, updateMetadata, markUsed, setSource, softDelete, restore, purge }
}

export type AiMediaAssetService = ReturnType<typeof createAiMediaAssetService>
