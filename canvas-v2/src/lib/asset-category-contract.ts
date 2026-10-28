/** Private library organization never enters workflow content or asset bytes. */
export interface AssetCategoryCounts { active: number; trash: number }

export interface AssetCategorySummary {
  id: string
  name: string
  version: number
  createdAt: string
  updatedAt: string
  counts: AssetCategoryCounts
}

export interface AssetCategoryDirectory {
  version: 1
  items: AssetCategorySummary[]
  uncategorized: AssetCategoryCounts
}

export interface AssetCategorySelection {
  assetId: string
  /** Zero means the asset has no separate organization row yet. */
  expectedOrganizationVersion: number
}

export type AssetCategoryInput =
  | { action: 'create-category'; operationId: string; name: string }
  | { action: 'rename-category'; operationId: string; id: string; expectedVersion: number; name: string }
  | { action: 'delete-category'; operationId: string; id: string; expectedVersion: number }
  | { action: 'move'; operationId: string; assets: AssetCategorySelection[]; categoryId: string | null; expectedCategoryVersion?: number }

export interface AssetCategoryAssignment {
  assetId: string
  categoryId: string | null
  organizationVersion: number
}
export interface AssetCategoryAssignmentDetail extends AssetCategoryAssignment { displayName: string }

export type AssetCategoryResult = (
  | { action: 'create-category' | 'rename-category'; category: AssetCategorySummary }
  | { action: 'delete-category'; categoryId: string; movedAssetCount: number }
  | { action: 'move'; assignments: AssetCategoryAssignment[] }
) & { operationId: string; requestDigest: string }

export type AssetCategoryOperationInspection =
  | { status: 'missing'; operationId: string; requestDigest: string }
  | { status: 'applied'; operationId: string; requestDigest: string; result: AssetCategoryResult }

/** Absent means all; null means uncategorized; a UUID means that owned category. */
export interface AssetCategoryFilter { version: 1; categoryId: string | null }

export interface AssetCategoryUploadTarget {
  categoryId?: string | null
  /** Required with a UUID; omitted for all/uncategorized. */
  expectedCategoryVersion?: number
}

export const maximumAssetCategories = 100
export const maximumAssetCategoryNameLength = 80
export const maximumAssetCategoryMoveCount = 50
export const uncategorizedAssetCategoryUrlValue = 'uncategorized'

export function isAssetCategoryId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function assetCategoryUrlValue(categoryId: string | null | undefined): string | undefined {
  if (categoryId === undefined) return undefined
  if (categoryId === null) return uncategorizedAssetCategoryUrlValue
  if (!isAssetCategoryId(categoryId)) throw new Error('素材分类编号格式不正确')
  return categoryId
}

export function assetCategoryFromUrlValue(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined
  if (value === uncategorizedAssetCategoryUrlValue) return null
  if (!isAssetCategoryId(value)) throw new Error('素材分类编号格式不正确')
  return value
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error('素材分类操作字段不正确')
  return value
}
function identifier(value: unknown): string {
  if (!isAssetCategoryId(value)) throw new Error('素材分类或操作编号格式不正确')
  return value.toLowerCase()
}
function version(value: unknown, zero = false): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value >= Number.MAX_SAFE_INTEGER) throw new Error('素材分类版本不正确，请刷新核对')
  return value
}
function categoryName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximumAssetCategoryNameLength || /[\x00-\x1f\x7f]/.test(value)) throw new Error('分类名称不能为空，最多80个字符，不能包含换行或控制字符')
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('分类名称包含无效字符') }
    else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('分类名称包含无效字符')
  }
  return value.trim()
}

export function parseAssetCategoryInput(value: unknown): AssetCategoryInput {
  if (!object(value)) throw new Error('素材分类操作格式不正确')
  const operationId = identifier(value.operationId)
  if (value.action === 'create-category') {
    const input = fields(value, ['action', 'operationId', 'name'])
    return { action: 'create-category', operationId, name: categoryName(input.name) }
  }
  if (value.action === 'rename-category') {
    const input = fields(value, ['action', 'operationId', 'id', 'expectedVersion', 'name'])
    return { action: 'rename-category', operationId, id: identifier(input.id), expectedVersion: version(input.expectedVersion), name: categoryName(input.name) }
  }
  if (value.action === 'delete-category') {
    const input = fields(value, ['action', 'operationId', 'id', 'expectedVersion'])
    return { action: 'delete-category', operationId, id: identifier(input.id), expectedVersion: version(input.expectedVersion) }
  }
  if (value.action !== 'move') throw new Error('素材分类操作不受支持')
  const input = fields(value, ['action', 'operationId', 'assets', 'categoryId', 'expectedCategoryVersion'])
  if (!Array.isArray(input.assets) || !input.assets.length || input.assets.length > maximumAssetCategoryMoveCount) throw new Error('请一次选择1–50个素材移动分类')
  const assets = input.assets.map((value) => {
    const item = fields(value, ['assetId', 'expectedOrganizationVersion'])
    if (typeof item.assetId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(item.assetId)) throw new Error('素材编号格式不正确')
    return { assetId: item.assetId, expectedOrganizationVersion: version(item.expectedOrganizationVersion, true) }
  })
  if (new Set(assets.map((item) => item.assetId)).size !== assets.length) throw new Error('不能重复选择同一个素材')
  if (input.categoryId === null) {
    if (input.expectedCategoryVersion !== undefined) throw new Error('未分类不接受分类版本')
    return { action: 'move', operationId, assets, categoryId: null }
  }
  return { action: 'move', operationId, assets, categoryId: identifier(input.categoryId), expectedCategoryVersion: version(input.expectedCategoryVersion) }
}

export async function assetCategoryRequestDigest(value: unknown): Promise<string> {
  const input = parseAssetCategoryInput(value)
  const bytes = new TextEncoder().encode(JSON.stringify(input))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((part) => part.toString(16).padStart(2, '0')).join('')
}

function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
function counts(value: unknown): value is AssetCategoryCounts { return object(value) && count(value.active) && count(value.trash) }
export function isAssetCategorySummary(value: unknown): value is AssetCategorySummary {
  return object(value) && isAssetCategoryId(value.id) && typeof value.name === 'string' && value.name === value.name.trim() && value.name.length > 0 && value.name.length <= maximumAssetCategoryNameLength
    && count(value.version) && value.version > 0 && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt)) && counts(value.counts)
}
export function isAssetCategoryDirectory(value: unknown): value is AssetCategoryDirectory {
  return object(value) && value.version === 1 && Array.isArray(value.items) && value.items.length <= maximumAssetCategories && value.items.every(isAssetCategorySummary)
    && new Set(value.items.map((item) => item.id)).size === value.items.length && counts(value.uncategorized)
}
export function isAssetCategoryResult(value: unknown): value is AssetCategoryResult {
  if (!object(value) || !isAssetCategoryId(value.operationId) || typeof value.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.requestDigest)) return false
  if (value.action === 'create-category' || value.action === 'rename-category') return isAssetCategorySummary(value.category)
  if (value.action === 'delete-category') return isAssetCategoryId(value.categoryId) && count(value.movedAssetCount)
  return value.action === 'move' && Array.isArray(value.assignments) && value.assignments.length > 0 && value.assignments.length <= maximumAssetCategoryMoveCount
    && value.assignments.every((item) => object(item) && typeof item.assetId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(item.assetId) && (item.categoryId === null || isAssetCategoryId(item.categoryId)) && count(item.organizationVersion) && item.organizationVersion > 0)
    && new Set(value.assignments.map((item) => item.assetId)).size === value.assignments.length
}
export function confirmAssetCategoryResult(input: AssetCategoryInput, result: AssetCategoryResult): void {
  if (input.action !== result.action || input.operationId !== result.operationId) throw new Error('素材分类回执与原操作不一致，请核对原操作')
  if (input.action === 'move' && result.action === 'move') {
    if (input.assets.length !== result.assignments.length || result.assignments.some((item, index) => item.assetId !== input.assets[index].assetId || item.categoryId !== input.categoryId || item.organizationVersion !== input.assets[index].expectedOrganizationVersion + 1)) throw new Error('分类移动回执不完整，请核对原操作')
  } else if (input.action === 'create-category' && result.action === 'create-category') {
    if (result.category.name !== input.name || result.category.version !== 1) throw new Error('分类创建回执不一致，请核对原操作')
  } else if (input.action === 'rename-category' && result.action === 'rename-category') {
    if (result.category.id !== input.id || result.category.name !== input.name || result.category.version !== input.expectedVersion + 1) throw new Error('分类改名回执不一致，请核对原操作')
  } else if (input.action === 'delete-category' && result.action === 'delete-category' && result.categoryId !== input.id) throw new Error('分类删除回执不一致，请核对原操作')
}

export function assertAssetCategoryPageFilter(query: { categoryId?: string | null }, page: { categoryFilter?: AssetCategoryFilter }): void {
  if (query.categoryId !== undefined && (page.categoryFilter?.version !== 1 || page.categoryFilter.categoryId !== query.categoryId)) throw new Error('服务端未确认分类筛选，请刷新或重新进入素材库')
}

export function parseAssetCategoryAssetIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maximumAssetCategoryMoveCount || !value.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id)) || new Set(value).size !== value.length) throw new Error('请提供1–50个不重复的素材编号')
  return [...value]
}
