import type { CanvasAssetPage, CanvasAssetQuery, CanvasImageAssetSummary } from '../host'
import { canvasAssetContentUrlMatches } from '../asset-display-url'

export type TemplateAssetLoader = (query: CanvasAssetQuery) => Promise<CanvasAssetPage>
export type TemplateReferenceAssets = Readonly<Record<string, CanvasImageAssetSummary>>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit
}

function isFacet(value: unknown): value is { tag: string; count: number } {
  return record(value) && boundedText(value.tag, 160) && count(value.count)
}

export function isTemplateImageAsset(value: unknown): value is CanvasImageAssetSummary {
  if (!record(value) || value.mediaType !== 'image' || typeof value.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.assetId)) return false
  const thumbnail = typeof value.thumbnailUrl === 'string' && (canvasAssetContentUrlMatches(value.thumbnailUrl, 'image', value.assetId)
    || new RegExp(`^xingmang-asset://thumb/v[0-9]+/image/${value.assetId}$`).test(value.thumbnailUrl))
  return ['image/png', 'image/jpeg', 'image/webp'].includes(String(value.mimeType))
    && canvasAssetContentUrlMatches(value.localUrl, 'image', value.assetId) && thumbnail
    && boundedText(value.fileName, 1000) && value.fileName.length > 0
    && boundedText(value.createdAt, 64) && Number.isFinite(Date.parse(value.createdAt))
    && (value.displayName === undefined || boundedText(value.displayName, 1000))
    && (value.tags === undefined || (Array.isArray(value.tags) && value.tags.length <= 100 && value.tags.every((tag) => boundedText(tag, 160))))
    && (value.favorite === undefined || typeof value.favorite === 'boolean')
    && value.deletedAt === undefined
}

export function validateTemplateImagePage(value: unknown, query: CanvasAssetQuery): CanvasAssetPage {
  if (!record(value) || !Array.isArray(value.items) || value.items.length > 100 || !value.items.every(isTemplateImageAsset)
    || !count(value.offset) || !count(value.limit) || value.limit < 1 || value.limit > 100 || !count(value.total)
    || value.items.length > value.limit || typeof value.hasMore !== 'boolean'
    || (value.items.length > 0 && value.offset + value.items.length > value.total)
    || (value.items.length === 0 && value.total > value.offset)
    || value.offset !== query.offset || value.limit !== query.limit
    || value.hasMore !== (value.offset + value.items.length < value.total)
    || !record(value.facets) || !Array.isArray(value.facets.tags) || value.facets.tags.length > 1000
    || !value.facets.tags.every(isFacet)) {
    throw new Error('图片素材列表返回信息不完整，请重新加载。')
  }
  // The owner-scoped host supplies the objects. Never reconstruct a selectable
  // reference from a typed id or an external URL supplied by the form.
  return { items: value.items.map((asset) => ({ ...asset, displayName: asset.displayName || asset.fileName })), offset: value.offset, limit: value.limit, total: value.total, hasMore: value.hasMore, facets: { tags: value.facets.tags } }
}

export function buildTemplateImageQuery(search: string, offset = 0): CanvasAssetQuery {
  return { mediaType: 'image', view: 'all', source: 'all', sort: 'created-desc', search: search.trim().slice(0, 160), offset, limit: 24 }
}

export function templatePageImages(page: CanvasAssetPage): CanvasImageAssetSummary[] {
  const images: CanvasImageAssetSummary[] = []
  for (const asset of page.items) if (isTemplateImageAsset(asset)) images.push(asset)
  return images
}

export function templateImagePageOffset(page: CanvasAssetPage): number {
  return page.total > 0 ? Math.floor((page.total - 1) / page.limit) * page.limit : 0
}

export function retainTemplateReference(current: TemplateReferenceAssets, variableId: string, asset: unknown): TemplateReferenceAssets {
  if (!isTemplateImageAsset(asset)) throw new Error('这张参考图不可使用，请重新选择已保存的图片素材。')
  return { ...current, [variableId]: asset }
}

export function templateReferenceIds(assets: TemplateReferenceAssets): ReadonlySet<string> {
  return new Set(Object.values(assets).filter(isTemplateImageAsset).map((asset) => asset.assetId))
}

export function createTemplateAssetRequestGuard() {
  let epoch = 0
  return { begin() { epoch += 1; return epoch }, invalidate() { epoch += 1 }, current(candidate: number) { return candidate === epoch } }
}

export function createTemplateReferenceGuard() {
  let epoch = 0
  let templateId: string | null = null
  let variableId: string | null = null
  return {
    begin(template: string, variable: string) { epoch += 1; templateId = template; variableId = variable; return { epoch, templateId: template, variableId: variable } },
    invalidate() { epoch += 1; templateId = null; variableId = null },
    current(ticket: { epoch: number; templateId: string; variableId: string }) { return ticket.epoch === epoch && ticket.templateId === templateId && ticket.variableId === variableId },
  }
}

export async function loadTemplateImagePage(loader: TemplateAssetLoader, query: CanvasAssetQuery, signal: AbortSignal): Promise<CanvasAssetPage> {
  if (signal.aborted) throw new Error('素材列表等待已停止。')
  // IPC hosts have no per-query AbortSignal. Stop waiting locally and ignore
  // late replies; the existing web bridge separately bounds its HTTP request.
  let timer: ReturnType<typeof setTimeout> | undefined
  let stop: (() => void) | undefined
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error('素材列表等待已停止。'))
    signal.addEventListener('abort', stop, { once: true })
    timer = setTimeout(() => reject(new Error('图片素材读取超时，请重新加载。')), 25_000)
  })
  try {
    const result = await Promise.race([loader(query), stopped])
    if (signal.aborted) throw new Error('素材列表等待已停止。')
    return validateTemplateImagePage(result, query)
  } finally {
    clearTimeout(timer)
    if (stop) signal.removeEventListener('abort', stop)
  }
}
