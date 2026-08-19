import fs from 'node:fs'
import path from 'node:path'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import {
  assertSafeDataFile,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const FILE_LABEL = 'AI 素材元数据'
const STORE_VERSION = 2
const MAXIMUM_BYTES = 2 * 1024 * 1024
const MAXIMUM_ITEMS = 5_000
const MAXIMUM_TAGS = 12
const MAXIMUM_TAG_LENGTH = 32
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const INVALID_DISPLAY_NAME_CHARACTERS = /[\x00-\x1F\x7F<>:"/\\|?*]/
const INVALID_TAG_CHARACTERS = /[\x00-\x1F\x7F]/

export type AiAssetSource = 'generated' | 'imported' | 'legacy'

export interface AiAssetLogicalMetadata {
  displayName?: string
  favorite?: boolean
  tags?: string[]
  lastUsedAt?: string
  source?: AiAssetSource
  updatedAt: string
}

export interface AiAssetMetadataItem extends AiAssetLogicalMetadata {
  assetId: string
}

interface AiAssetMetadataState {
  version: typeof STORE_VERSION
  userId: number
  items: AiAssetMetadataItem[]
}

export interface AiAssetMetadataStoreOptions {
  outputRoot: string
  now?: () => Date
  randomUUID?: () => string
}

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('AI 素材账号标识格式错误')
}

function assertAssetId(assetId: string): void {
  if (!ASSET_ID_PATTERN.test(assetId)) throw new Error('AI 素材标识格式错误')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const allowed = new Set(fields)
  return Object.keys(value).every((field) => allowed.has(field))
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 20
    && value.length <= 40
    && !Number.isNaN(Date.parse(value))
}

export function normalizeAiAssetDisplayName(value: unknown): string {
  if (typeof value !== 'string') throw new Error('AI 素材显示名称格式错误')
  const displayName = value.trim()
  if (!displayName || displayName.length > 120 || INVALID_DISPLAY_NAME_CHARACTERS.test(displayName)) {
    throw new Error('AI 素材显示名称格式错误')
  }
  return displayName
}

export function normalizeAiAssetTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_TAGS) throw new Error('AI 素材标签格式错误')
  const tags = value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('AI 素材标签格式错误')
    const tag = entry.trim()
    if (!tag || tag.length > MAXIMUM_TAG_LENGTH || INVALID_TAG_CHARACTERS.test(tag)) throw new Error('AI 素材标签格式错误')
    return tag
  })
  if (new Set(tags.map((tag) => tag.toLocaleLowerCase('zh-CN'))).size !== tags.length) throw new Error('AI 素材标签不能重复')
  return tags
}

function parseSource(value: unknown): AiAssetSource | undefined {
  if (value === undefined) return undefined
  if (value !== 'generated' && value !== 'imported' && value !== 'legacy') throw new Error('AI 素材来源格式错误')
  return value
}

function parseItem(value: unknown, version: 1 | typeof STORE_VERSION): AiAssetMetadataItem {
  const allowedFields = version === 1
    ? ['assetId', 'displayName', 'updatedAt']
    : ['assetId', 'displayName', 'favorite', 'tags', 'lastUsedAt', 'source', 'updatedAt']
  if (!isRecord(value) || !hasOnlyFields(value, allowedFields)) {
    throw new Error('AI 素材元数据格式错误')
  }
  if (typeof value.assetId !== 'string') throw new Error('AI 素材标识格式错误')
  assertAssetId(value.assetId)
  if (!isIsoDate(value.updatedAt)) throw new Error('AI 素材更新时间格式错误')
  const displayName = value.displayName === undefined ? undefined : normalizeAiAssetDisplayName(value.displayName)
  const tags = value.tags === undefined ? undefined : normalizeAiAssetTags(value.tags)
  const source = parseSource(value.source)
  if (version === 1 && !displayName) throw new Error('AI 素材显示名称格式错误')
  if (value.favorite !== undefined && typeof value.favorite !== 'boolean') throw new Error('AI 素材收藏状态格式错误')
  if (value.lastUsedAt !== undefined && !isIsoDate(value.lastUsedAt)) throw new Error('AI 素材最近使用时间格式错误')
  return {
    assetId: value.assetId,
    ...(displayName ? { displayName } : {}),
    ...(value.favorite === true ? { favorite: true } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(typeof value.lastUsedAt === 'string' ? { lastUsedAt: value.lastUsedAt } : {}),
    ...(source ? { source } : {}),
    updatedAt: value.updatedAt,
  }
}

function parseState(content: string, userId: number): AiAssetMetadataState {
  const value = JSON.parse(content) as unknown
  const version = isRecord(value) && (value.version === 1 || value.version === STORE_VERSION) ? value.version : null
  if (
    !isRecord(value)
    || !hasOnlyFields(value, ['version', 'userId', 'items'])
    || version === null
    || value.userId !== userId
    || !Array.isArray(value.items)
    || value.items.length > MAXIMUM_ITEMS
  ) {
    throw new Error('AI 素材元数据版本、账号或数量无效')
  }
  const items = value.items.map((item) => parseItem(item, version))
  if (new Set(items.map((item) => item.assetId)).size !== items.length) {
    throw new Error('AI 素材元数据标识重复')
  }
  return { version: STORE_VERSION, userId, items }
}

export class AiAssetMetadataStore {
  private readonly outputRoot: string
  private readonly now: () => Date
  private readonly randomUUID: () => string
  private readonly queues = new Map<number, Promise<void>>()

  constructor(options: AiAssetMetadataStoreOptions) {
    this.outputRoot = path.resolve(options.outputRoot)
    this.now = options.now ?? (() => new Date())
    this.randomUUID = options.randomUUID ?? nodeRandomUUID
  }

  getMany(userId: number, assetIds: readonly string[]): Promise<Record<string, AiAssetLogicalMetadata>> {
    return this.enqueue(userId, async () => {
      if (assetIds.length > 1_500) throw new Error('AI 素材元数据查询数量超限')
      const wanted = new Set(assetIds)
      for (const assetId of wanted) assertAssetId(assetId)
      const state = await this.readState(userId)
      return Object.fromEntries(state.items
        .filter((item) => wanted.has(item.assetId))
        .map(({ assetId, ...metadata }) => [assetId, structuredClone(metadata)]))
    })
  }

  rename(userId: number, assetId: string, displayNameInput: string): Promise<AiAssetMetadataItem> {
    return this.enqueue(userId, async () => {
      assertAssetId(assetId)
      const displayName = normalizeAiAssetDisplayName(displayNameInput)
      const state = await this.readState(userId)
      const updatedAt = this.now().toISOString()
      const existing = this.upsert(state, assetId, updatedAt)
      existing.displayName = displayName
      await this.writeState(userId, state)
      return structuredClone(existing)
    })
  }

  updatePreferences(userId: number, assetId: string, input: { favorite?: boolean; tags?: unknown }): Promise<AiAssetMetadataItem> {
    return this.enqueue(userId, async () => {
      assertAssetId(assetId)
      if (input.favorite === undefined && input.tags === undefined) throw new Error('AI 素材整理信息不能为空')
      if (input.favorite !== undefined && typeof input.favorite !== 'boolean') throw new Error('AI 素材收藏状态格式错误')
      const tags = input.tags === undefined ? undefined : normalizeAiAssetTags(input.tags)
      const state = await this.readState(userId)
      const updatedAt = this.now().toISOString()
      const item = this.upsert(state, assetId, updatedAt)
      if (input.favorite !== undefined) {
        if (input.favorite) item.favorite = true
        else delete item.favorite
      }
      if (tags !== undefined) {
        if (tags.length > 0) item.tags = tags
        else delete item.tags
      }
      await this.writeState(userId, state)
      return structuredClone(item)
    })
  }

  markUsed(userId: number, assetId: string): Promise<AiAssetMetadataItem> {
    return this.enqueue(userId, async () => {
      assertAssetId(assetId)
      const state = await this.readState(userId)
      const updatedAt = this.now().toISOString()
      const item = this.upsert(state, assetId, updatedAt)
      item.lastUsedAt = updatedAt
      await this.writeState(userId, state)
      return structuredClone(item)
    })
  }

  setSource(userId: number, assetId: string, source: AiAssetSource): Promise<AiAssetMetadataItem> {
    return this.enqueue(userId, async () => {
      assertAssetId(assetId)
      const normalizedSource = parseSource(source)
      if (!normalizedSource) throw new Error('AI 素材来源格式错误')
      const state = await this.readState(userId)
      const updatedAt = this.now().toISOString()
      const item = this.upsert(state, assetId, updatedAt)
      item.source = normalizedSource
      await this.writeState(userId, state)
      return structuredClone(item)
    })
  }

  private upsert(state: AiAssetMetadataState, assetId: string, updatedAt: string): AiAssetMetadataItem {
    const existing = state.items.find((item) => item.assetId === assetId)
    if (existing) {
      existing.updatedAt = updatedAt
      return existing
    }
    if (state.items.length >= MAXIMUM_ITEMS) throw new Error(`AI 素材元数据最多保存 ${MAXIMUM_ITEMS} 条`)
    const item = { assetId, updatedAt }
    state.items.push(item)
    return item
  }

  private accountDirectory(userId: number): string {
    return path.join(this.outputRoot, `user-${userId}`)
  }

  private filePath(userId: number): string {
    return path.join(this.accountDirectory(userId), 'asset-metadata.json')
  }

  private async readState(userId: number): Promise<AiAssetMetadataState> {
    const filePath = this.filePath(userId)
    try {
      const content = await readSafeUtf8File(filePath, FILE_LABEL, MAXIMUM_BYTES)
      return content === null ? { version: STORE_VERSION, userId, items: [] } : parseState(content, userId)
    } catch {
      await this.backupCorrupt(filePath)
      return { version: STORE_VERSION, userId, items: [] }
    }
  }

  private async backupCorrupt(filePath: string): Promise<void> {
    try {
      if (!assertSafeDataFile(filePath, FILE_LABEL)) return
      await fs.promises.rename(filePath, `${filePath}.corrupt-${this.now().getTime()}-${this.randomUUID()}.bak`)
    } catch {
      // Unsafe paths remain untouched. Callers receive an empty in-memory state.
    }
  }

  private async writeState(userId: number, state: AiAssetMetadataState): Promise<void> {
    ensureSafeDataDirectory(this.outputRoot, FILE_LABEL)
    ensureSafeDataDirectory(this.accountDirectory(userId), FILE_LABEL)
    const content = `${JSON.stringify(state, null, 2)}\n`
    if (Buffer.byteLength(content, 'utf8') > MAXIMUM_BYTES) {
      throw new Error('AI 素材元数据文件超过 2 MB 安全上限')
    }
    await writeAtomicSafeUtf8File(this.filePath(userId), content, FILE_LABEL)
  }

  private enqueue<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    assertUserId(userId)
    const previous = this.queues.get(userId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(userId, tail)
    void tail.then(() => {
      if (this.queues.get(userId) === tail) this.queues.delete(userId)
    })
    return result
  }
}
