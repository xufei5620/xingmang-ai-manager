import type { CanvasImageAssetSummary } from '../host'

export const officialAssetCategories = ['character', 'prop', 'clothing', 'other'] as const
export type OfficialAssetCategory = typeof officialAssetCategories[number]
export const maximumOfficialAssetBytes = 4 * 1024 * 1024
export const maximumOfficialCatalogBytes = 24 * 1024 * 1024
export const maximumOfficialAssetResponseBytes = 512 * 1024

export interface OfficialAssetIdentity { id: string; version: number }
export interface OfficialAssetProvenance extends OfficialAssetIdentity {
  title: string
  category: OfficialAssetCategory
  sha256: string
  attribution: string
  licenseLabel: string
}
export interface OfficialAssetItem extends OfficialAssetProvenance {
  tags: string[]
  description: string
  path: string
  bytes: number
  width: number
  height: number
}
export interface OfficialAssetManifest { version: 1; items: OfficialAssetItem[] }
export interface OfficialAssetQuery { search?: string; category?: 'all' | OfficialAssetCategory; offset?: number; limit?: number }
export interface OfficialAssetPage {
  items: OfficialAssetItem[]
  total: number
  offset: number
  limit: number
  hasMore: boolean
  counts: Record<'all' | OfficialAssetCategory, number>
}
export interface OfficialAssetAcquisition {
  asset: CanvasImageAssetSummary
  receipt: OfficialAssetIdentity & { operationId: string; sha256: string; bytes: number }
}

export class OfficialAssetError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'OFFICIAL_ASSET_INVALID') { super(message) }
}

/** Binding/mocked streams need not honor Request.signal. Bound the await itself. */
export function awaitOfficialAssetAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    function abort() { signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('官方素材读取已停止')) }
    if (signal.aborted) { void operation.catch(() => undefined); abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    operation.then((value) => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

function object(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || fields && Object.keys(value).some((key) => !fields.includes(key))) throw new OfficialAssetError('官方素材资料包含无效或未知字段')
  return value as Record<string, unknown>
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new OfficialAssetError('官方素材文字资料格式不正确')
  return value
}
function personalText(value: unknown, maximum: number): string {
  // Personal editing already permits multiline names/tags. A stricter public
  // catalog policy must not make a valid existing private copy unreadable.
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new OfficialAssetError('本人素材名称或标签格式不正确')
  return value
}
function personalTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new OfficialAssetError('本人素材标签过多或格式不正确')
  return value.map((entry) => personalText(entry, 40))
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new OfficialAssetError('官方素材编号、尺寸或数量超出范围')
  return value
}
function category(value: unknown): OfficialAssetCategory {
  if (typeof value !== 'string' || !officialAssetCategories.includes(value as OfficialAssetCategory)) throw new OfficialAssetError('官方素材分类不受支持')
  return value as OfficialAssetCategory
}
function sha256(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new OfficialAssetError('官方素材内容摘要无效')
  return value
}
function tags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new OfficialAssetError('官方素材标签过多或格式不正确')
  const result = value.map((entry) => text(entry, 40))
  if (new Set(result).size !== result.length) throw new OfficialAssetError('官方素材标签不能重复')
  return result
}

export function parseOfficialAssetIdentity(value: unknown): OfficialAssetIdentity {
  const input = object(value, ['id', 'version'])
  const id = text(input.id, 80)
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id)) throw new OfficialAssetError('官方素材编号无效')
  return { id, version: integer(input.version, 1, 1_000_000) }
}

export function parseOfficialAssetProvenance(value: unknown): OfficialAssetProvenance {
  const input = object(value, ['id', 'version', 'title', 'category', 'sha256', 'attribution', 'licenseLabel'])
  return { ...parseOfficialAssetIdentity({ id: input.id, version: input.version }), title: text(input.title, 120), category: category(input.category), sha256: sha256(input.sha256), attribution: text(input.attribution, 240), licenseLabel: text(input.licenseLabel, 240) }
}

export function parseOfficialAssetItem(value: unknown): OfficialAssetItem {
  const input = object(value, ['id', 'version', 'title', 'category', 'sha256', 'attribution', 'licenseLabel', 'tags', 'description', 'path', 'bytes', 'width', 'height'])
  const provenance = parseOfficialAssetProvenance(Object.fromEntries(['id', 'version', 'title', 'category', 'sha256', 'attribution', 'licenseLabel'].map((key) => [key, input[key]])))
  if (input.path !== `/official-assets/v1/${provenance.id}.png`) throw new OfficialAssetError('官方素材文件地址不在受支持的公开目录')
  const width = integer(input.width, 1, 4096), height = integer(input.height, 1, 4096)
  if (width * height > 16_777_216) throw new OfficialAssetError('官方素材像素超过处理预算')
  return { ...provenance, tags: tags(input.tags), description: text(input.description, 1200), path: input.path, bytes: integer(input.bytes, 1, maximumOfficialAssetBytes), width, height }
}

export function parseOfficialAssetManifest(value: unknown): OfficialAssetManifest {
  const input = object(value, ['version', 'items'])
  if (input.version !== 1 || !Array.isArray(input.items) || !input.items.length || input.items.length > 100) throw new OfficialAssetError('官方素材目录版本或数量不受支持')
  const items = input.items.map(parseOfficialAssetItem)
  if (new Set(items.map((item) => item.id)).size !== items.length || new Set(items.map((item) => item.path)).size !== items.length) throw new OfficialAssetError('官方素材目录编号或路径重复')
  if (items.reduce((sum, item) => sum + item.bytes, 0) > maximumOfficialCatalogBytes) throw new OfficialAssetError('官方素材目录超过文件容量预算')
  return { version: 1, items }
}

export function parseOfficialAssetQuery(value: unknown = {}): Required<OfficialAssetQuery> {
  const input = object(value, ['search', 'category', 'offset', 'limit'])
  if (input.search !== undefined && (typeof input.search !== 'string' || input.search.length > 160 || /[\x00-\x1f\x7f]/.test(input.search))) throw new OfficialAssetError('官方素材搜索词格式不正确')
  return { search: typeof input.search === 'string' ? input.search.trim() : '', category: input.category === undefined || input.category === 'all' ? 'all' : category(input.category), offset: input.offset === undefined ? 0 : integer(input.offset, 0, 2_147_483_647), limit: input.limit === undefined ? 24 : integer(input.limit, 1, 100) }
}

export function parseOfficialAssetPage(value: unknown): OfficialAssetPage {
  const input = object(value, ['items', 'total', 'offset', 'limit', 'hasMore', 'counts'])
  const counts = object(input.counts, ['all', ...officialAssetCategories])
  const parsedCounts = Object.fromEntries(['all', ...officialAssetCategories].map((key) => [key, integer(counts[key], 0, 100)])) as OfficialAssetPage['counts']
  const total = integer(input.total, 0, 100), offset = integer(input.offset, 0, 2_147_483_647), limit = integer(input.limit, 1, 100)
  if (!Array.isArray(input.items) || input.items.length > limit || input.items.length !== Math.min(limit, Math.max(0, total - offset)) || typeof input.hasMore !== 'boolean' || input.hasMore !== (offset + input.items.length < total) || parsedCounts.all !== officialAssetCategories.reduce((sum, key) => sum + parsedCounts[key], 0) || total > parsedCounts.all) throw new OfficialAssetError('官方素材分页或统计不一致')
  const items = input.items.map(parseOfficialAssetItem)
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new OfficialAssetError('官方素材分页包含重复条目')
  return { items, total, offset, limit, hasMore: input.hasMore, counts: parsedCounts }
}

export function parseOfficialAssetAcquisition(value: unknown, expected?: OfficialAssetIdentity): OfficialAssetAcquisition {
  const input = object(value, ['asset', 'receipt']), receipt = object(input.receipt, ['operationId', 'id', 'version', 'sha256', 'bytes'])
  const identity = parseOfficialAssetIdentity({ id: receipt.id, version: receipt.version })
  if (expected && (identity.id !== expected.id || identity.version !== expected.version) || typeof receipt.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt.operationId)) throw new OfficialAssetError('取得回执与原官方素材不一致')
  const provenance = parseOfficialAssetProvenance(object(input.asset).officialSource), asset = object(input.asset)
  if (provenance.id !== identity.id || provenance.version !== identity.version || provenance.sha256 !== sha256(receipt.sha256) || typeof asset.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(asset.assetId) || asset.source !== 'imported' || asset.mediaType !== 'image' || asset.mimeType !== 'image/png' || asset.deletedAt !== undefined || asset.localUrl !== `xingmang-asset://image/${asset.assetId}` || asset.thumbnailUrl !== asset.localUrl || typeof asset.createdAt !== 'string' || !Number.isFinite(Date.parse(asset.createdAt)) || typeof asset.favorite !== 'boolean') throw new OfficialAssetError('官方素材尚未确认为本人可用图片，请核对原操作')
  const checked: CanvasImageAssetSummary = { assetId: asset.assetId, source: 'imported', mediaType: 'image', mimeType: 'image/png', localUrl: asset.localUrl, thumbnailUrl: asset.localUrl, fileName: personalText(asset.fileName, 160), displayName: personalText(asset.displayName, 160), createdAt: asset.createdAt, width: integer(asset.width, 1, 4096), height: integer(asset.height, 1, 4096), favorite: asset.favorite, tags: personalTags(asset.tags), officialSource: provenance, ...(typeof asset.lastUsedAt === 'string' && Number.isFinite(Date.parse(asset.lastUsedAt)) ? { lastUsedAt: asset.lastUsedAt } : {}) }
  return { asset: checked, receipt: { ...identity, operationId: receipt.operationId, sha256: provenance.sha256, bytes: integer(receipt.bytes, 1, maximumOfficialAssetBytes) } }
}
