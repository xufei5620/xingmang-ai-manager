import type { CanvasAssetPage, CanvasAssetQuery, CanvasAssetSummary, CanvasListedAssetSummary } from '../host'
import { isTemplateImageAsset, type TemplateAssetLoader } from './template-asset-picker-model'
import { canvasAssetContentUrlMatches } from '../asset-display-url'

export type WorkshopAssetMediaType = CanvasAssetSummary['mediaType']

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mediaType(value: unknown): value is WorkshopAssetMediaType {
  return value === 'image' || value === 'video' || value === 'audio'
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function text(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0) && !/[\x00-\x1f\x7f]/.test(value)
}

function date(value: unknown): value is string {
  return text(value, 64) && Number.isFinite(Date.parse(value))
}

function optionalDimension(value: unknown): boolean {
  return value === undefined || typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 100_000
}

function optionalDuration(value: unknown): boolean {
  return value === undefined || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
}

function contentUrl(value: unknown, kind: WorkshopAssetMediaType, assetId: string): boolean {
  return canvasAssetContentUrlMatches(value, kind, assetId)
}

function thumbnailUrl(value: unknown, kind: WorkshopAssetMediaType, assetId: string): boolean {
  return contentUrl(value, kind, assetId) || value === `xingmang-asset://thumbnail/${assetId}`
    || typeof value === 'string' && new RegExp(`^xingmang-asset://thumb/v[0-9]+/${kind}/${assetId}$`).test(value)
}

export function isWorkshopLibraryAsset(value: unknown, expectedType: WorkshopAssetMediaType): value is CanvasAssetSummary {
  if (expectedType === 'image') return isTemplateImageAsset(value)
  if (!mediaType(expectedType) || !record(value) || value.mediaType !== expectedType || typeof value.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.assetId)) return false
  if (!contentUrl(value.localUrl, expectedType, value.assetId) || !thumbnailUrl(value.thumbnailUrl, expectedType, value.assetId)
    || !text(value.fileName, 1000) || !date(value.createdAt) || value.deletedAt !== undefined
    || value.displayName !== undefined && !text(value.displayName, 1000, true)
    || value.favorite !== undefined && typeof value.favorite !== 'boolean'
    || value.source !== undefined && (typeof value.source !== 'string' || !['generated', 'imported', 'legacy'].includes(value.source))
    || value.lastUsedAt !== undefined && !date(value.lastUsedAt)
    || value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 100 || !value.tags.every((tag) => text(tag, 160, true)))
    || !optionalDimension(value.width) || !optionalDimension(value.height) || !optionalDuration(value.durationSeconds)) return false
  // Lists include generated and legacy assets. The server represents a legacy
  // video's absent upstream task as an empty string; it is not an upload receipt.
  return expectedType === 'video' ? value.mimeType === 'video/mp4' && text(value.taskId, 256, true)
    : typeof value.mimeType === 'string' && ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4'].includes(value.mimeType)
}

function assertQuery(query: CanvasAssetQuery): WorkshopAssetMediaType {
  if (!record(query) || !mediaType(query.mediaType) || !count(query.offset) || query.offset > 2_147_483_647 || query.limit !== 24
    || query.view !== 'all' && query.view !== 'recent' || query.source !== 'all'
    || query.sort !== (query.view === 'recent' ? 'used-desc' : 'created-desc')
    || query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 160)
    || query.categoryId !== undefined && query.categoryId !== null && (typeof query.categoryId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query.categoryId))) throw new Error('素材查询条件无效，请重新打开素材选择。')
  return query.mediaType
}

export function buildWorkshopAssetQuery(mediaType: WorkshopAssetMediaType, search: string, offset = 0, source: 'mine' | 'recent' = 'mine'): CanvasAssetQuery {
  if (typeof search !== 'string' || source !== 'mine' && source !== 'recent') throw new Error('素材查询条件无效，请重新打开素材选择。')
  const query: CanvasAssetQuery = { mediaType, view: source === 'recent' ? 'recent' : 'all', source: 'all', sort: source === 'recent' ? 'used-desc' : 'created-desc', search: search.trim().slice(0, 160), offset, limit: 24 }
  assertQuery(query)
  return query
}

function invalidPage(): never {
  throw new Error('素材列表返回信息不完整，请重新加载。')
}

function isFacet(value: unknown): value is { tag: string; count: number } {
  return record(value) && text(value.tag, 160, true) && count(value.count)
}

export function validateWorkshopAssetPage(value: unknown, query: CanvasAssetQuery): CanvasAssetPage {
  const kind = assertQuery(query)
  if (!record(value) || !Array.isArray(value.items) || !count(value.offset) || value.offset !== query.offset
    || value.limit !== 24 || value.limit !== query.limit || !count(value.total) || typeof value.hasMore !== 'boolean'
    || value.items.length !== Math.max(0, Math.min(24, value.total - value.offset))
    || value.hasMore !== (value.offset + value.items.length < value.total)
    || !record(value.facets) || !Array.isArray(value.facets.tags) || value.facets.tags.length > 1000
    || !value.facets.tags.every(isFacet) || new Set(value.facets.tags.map((facet) => facet.tag)).size !== value.facets.tags.length) invalidPage()
  let categoryFilter: CanvasAssetPage['categoryFilter']
  if (query.categoryId !== undefined) {
    const requested = query.categoryId === null ? null : query.categoryId.toLowerCase()
    if (!record(value.categoryFilter) || value.categoryFilter.version !== 1 || value.categoryFilter.categoryId !== requested) invalidPage()
    categoryFilter = { version: 1, categoryId: requested }
  } else if (value.categoryFilter !== undefined) invalidPage()
  const items: CanvasListedAssetSummary[] = []
  const ids = new Set<string>()
  for (const item of value.items) {
    if (!isWorkshopLibraryAsset(item, kind) || ids.has(item.assetId)) invalidPage()
    ids.add(item.assetId)
    items.push({ ...item, displayName: item.displayName || item.fileName })
  }
  // A valid id is not ownership proof. Only the owner-scoped host supplies
  // these summaries; choosing one still requires the host's current detail read.
  return { items, offset: value.offset, limit: 24, total: value.total, hasMore: value.hasMore, facets: { tags: value.facets.tags.map((facet) => ({ ...facet })) }, ...(categoryFilter ? { categoryFilter } : {}) }
}

export async function loadWorkshopAssetPage(loader: TemplateAssetLoader, query: CanvasAssetQuery, signal: AbortSignal): Promise<CanvasAssetPage> {
  if (signal.aborted) throw new Error('素材列表等待已停止。')
  const expected = { ...query }
  assertQuery(expected)
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error('素材列表等待已停止。'))
    signal.addEventListener('abort', stop, { once: true })
    timer = setTimeout(() => reject(new Error('素材读取超时，请重新加载。')), 25_000)
  })
  try {
    // IPC cannot abort the underlying operation. Race only the local wait and
    // let each UI session's own request ticket reject late or superseded pages.
    const pending = Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('素材列表等待已停止。')
      return loader({ ...expected })
    })
    const result = await Promise.race([pending, stopped])
    if (signal.aborted) throw new Error('素材列表等待已停止。')
    return validateWorkshopAssetPage(result, expected)
  } finally {
    clearTimeout(timer)
    if (stop) signal.removeEventListener('abort', stop)
  }
}

export function workshopPageAssets(page: CanvasAssetPage, mediaType: WorkshopAssetMediaType): CanvasAssetSummary[] {
  return page.items.filter((asset) => isWorkshopLibraryAsset(asset, mediaType))
}

export function workshopAssetPageOffset(page: CanvasAssetPage): number {
  if (!count(page.total) || page.limit !== 24) throw new Error('素材列表返回信息不完整，请重新加载。')
  return page.total > 0 ? Math.floor((page.total - 1) / page.limit) * page.limit : 0
}
