// 主窗口「创作 › 作品库」那一条通道的入参（I5）：字段只收认得的，编号逐个按格式核，数量和长度都有上限。
import { isRecord } from '../../input-guards'
import { MAXIMUM_INDEXED_ASSETS } from '../../ai-asset-index'
import { MAXIMUM_LIBRARY_FILM_IDS, MAXIMUM_LIBRARY_MATCHED_IDS, MAXIMUM_LIBRARY_PAGE_SIZE, type AiMediaLibraryQuery } from '../../ai-media-asset-service'

const assetIdPattern = /^[A-Za-z0-9_-]{43}$/
const listFields = new Set(['offset', 'limit', 'kind', 'search', 'filmAssetIds', 'matchedAssetIds'])
const kinds = ['all', 'image', 'video', 'clip', 'film'] as const
export const maximumLibrarySearchLength = 128

function isLibraryKind(value: unknown): value is (typeof kinds)[number] {
  return (kinds as readonly unknown[]).includes(value)
}

function parseAssetIds(value: unknown, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error('作品库请求格式错误')
  for (const entry of value) {
    if (typeof entry !== 'string' || !assetIdPattern.test(entry)) throw new Error('作品库请求格式错误')
  }
  return [...new Set(value as string[])]
}

export function parseAiLibraryListInput(value: unknown): AiMediaLibraryQuery {
  if (!isRecord(value) || Object.keys(value).some((field) => !listFields.has(field))) throw new Error('作品库请求格式错误')
  const query: AiMediaLibraryQuery = {}
  if (value.offset !== undefined) {
    if (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > MAXIMUM_INDEXED_ASSETS) throw new Error('作品库请求格式错误')
    query.offset = value.offset
  }
  if (value.limit !== undefined) {
    if (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > MAXIMUM_LIBRARY_PAGE_SIZE) throw new Error('作品库请求格式错误')
    query.limit = value.limit
  }
  if (value.kind !== undefined) {
    if (!isLibraryKind(value.kind)) throw new Error('作品库请求格式错误')
    query.kind = value.kind
  }
  if (value.search !== undefined) {
    if (typeof value.search !== 'string' || value.search.length > maximumLibrarySearchLength || /[\x00-\x1F\x7F]/.test(value.search)) throw new Error('作品库请求格式错误')
    query.search = value.search
  }
  if (value.filmAssetIds !== undefined) query.filmAssetIds = parseAssetIds(value.filmAssetIds, MAXIMUM_LIBRARY_FILM_IDS)
  if (value.matchedAssetIds !== undefined) query.matchedAssetIds = parseAssetIds(value.matchedAssetIds, MAXIMUM_LIBRARY_MATCHED_IDS)
  return query
}
