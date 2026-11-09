import fs from 'node:fs'
import path from 'node:path'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import { isRecord } from './input-guards'
import {
  assertSafeDataFile,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const FILE_LABEL = 'AI 素材元数据'
/** Version of one shard file. Versions 1 to 4 are the single-file layout. */
const STORE_VERSION = 5
const MEGABYTE = 1024 * 1024
/**
 * Ceiling for one shard file, read and written alike. Sixteen shards of 16 MB
 * hold roughly 250,000 records with a 300 character prompt, and still more
 * than the library's 20,000 indexed assets when every record carries the
 * longest prompt, name and tags allowed.
 */
const MAXIMUM_SHARD_BYTES = 16 * MEGABYTE
const SHARD_COUNT = 16
/**
 * 0.2.24 之前每个账号只有一个 asset-metadata.json，上限 2 MB / 5,000 条：提示词三百来字时
 * 不到 2,000 个作品就写满，之后新作品的提示词静默丢失，再满一点连删除都删不掉（深查 M-1）。
 * 现在记录按作品编号分进 asset-metadata/ 下的 16 个分片，老文件第一次用到时并进去，
 * 原样改名留作备份（见 adoptLegacyFile）。搬作品目录时两种都要认出来合并而不是跳过。
 */
export const aiAssetMetadataFileName = 'asset-metadata.json'
export const aiAssetMetadataDirectoryName = 'asset-metadata'
export const aiAssetMetadataShardFilePattern = /^shard-[0-9a-f]\.json$/
export const aiAssetMetadataMaximumBytes = MAXIMUM_SHARD_BYTES
const MAXIMUM_TAGS = 12
const MAXIMUM_TAG_LENGTH = 32
const MAXIMUM_PROMPT_LENGTH = 2_000
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
  /**
   * The prompt that produced the asset, recorded once at generation time. It is
   * the only thing about a generated image the person who made it can recall
   * later, so it is what the library indexes and what "find similar" matches on.
   */
  prompt?: string
  /**
   * Set while the asset sits in the recycle bin. Deletion is logical here and
   * only becomes a file operation when the bin is emptied, so a mistaken delete
   * costs an undo rather than a restore from the OS trash.
   */
  deletedAt?: string
  updatedAt: string
}

export interface AiAssetMetadataItem extends AiAssetLogicalMetadata {
  assetId: string
}

export interface AiAssetMetadataStoreOptions {
  outputRoot: string
  now?: () => Date
  randomUUID?: () => string
  /** Tests only: a small ceiling so the recycle-bin headroom can be exercised. */
  maximumShardBytes?: number
}

/**
 * How much room a write may use. Recycle-bin moves (delete, restore, forget)
 * may fill a shard to the ceiling; anything that adds information stops one
 * sixteenth short of it, so a full shard can always still be cleaned up.
 */
type WriteBudget = 'grow' | 'recycle'

function assertUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('AI 素材账号标识格式错误')
}

function assertAssetId(assetId: string): void {
  if (!ASSET_ID_PATTERN.test(assetId)) throw new Error('AI 素材标识格式错误')
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

export function normalizeAiAssetPrompt(value: unknown): string {
  if (typeof value !== 'string') throw new Error('AI 素材提示词格式错误')
  // Control characters other than newline would corrupt the stored JSON view
  // and are never part of a prompt a person typed.
  const prompt = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim().slice(0, MAXIMUM_PROMPT_LENGTH)
  if (!prompt) throw new Error('AI 素材提示词格式错误')
  return prompt
}

/**
 * Which shard holds an asset's record. FNV-1a over the whole identifier: ids
 * are random base64url today, and hashing every character keeps the shards
 * even for any id the pattern admits. Shard names are lower-case hex, so the
 * case-insensitive file systems of Windows and macOS cannot fold two together.
 */
export function aiAssetMetadataShardOf(assetId: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < assetId.length; index += 1) {
    hash ^= assetId.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) % SHARD_COUNT
}

function parseSource(value: unknown): AiAssetSource | undefined {
  if (value === undefined) return undefined
  if (value !== 'generated' && value !== 'imported' && value !== 'legacy') throw new Error('AI 素材来源格式错误')
  return value
}

type ItemVersion = 1 | 2 | 3 | 4 | typeof STORE_VERSION

function parseItem(value: unknown, version: ItemVersion): AiAssetMetadataItem {
  const allowedFields = version === 1
    ? ['assetId', 'displayName', 'updatedAt']
    : version === 2
      ? ['assetId', 'displayName', 'favorite', 'tags', 'lastUsedAt', 'source', 'updatedAt']
      : version === 3
        ? ['assetId', 'displayName', 'favorite', 'tags', 'lastUsedAt', 'source', 'deletedAt', 'updatedAt']
        : ['assetId', 'displayName', 'favorite', 'tags', 'lastUsedAt', 'source', 'prompt', 'deletedAt', 'updatedAt']
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
  if (value.deletedAt !== undefined && !isIsoDate(value.deletedAt)) throw new Error('AI 素材删除时间格式错误')
  const prompt = value.prompt === undefined ? undefined : normalizeAiAssetPrompt(value.prompt)
  return {
    assetId: value.assetId,
    ...(displayName ? { displayName } : {}),
    ...(value.favorite === true ? { favorite: true } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(typeof value.lastUsedAt === 'string' ? { lastUsedAt: value.lastUsedAt } : {}),
    ...(source ? { source } : {}),
    ...(prompt ? { prompt } : {}),
    ...(typeof value.deletedAt === 'string' ? { deletedAt: value.deletedAt } : {}),
    updatedAt: value.updatedAt,
  }
}

function parseItems(value: unknown[], version: ItemVersion): AiAssetMetadataItem[] {
  const items = value.map((item) => parseItem(item, version))
  if (new Set(items.map((item) => item.assetId)).size !== items.length) {
    throw new Error('AI 素材元数据标识重复')
  }
  return items
}

/**
 * Reads either layout: a single-file state from before 0.2.24 (versions 1 to
 * 4) or one shard. When `shard` is given only that shard is accepted. A record
 * filed under the wrong shard is refused rather than moved, so it can never sit
 * unseen beside a second record for the same asset.
 */
function parseStoredItems(content: string, userId: number, shard?: number): AiAssetMetadataItem[] {
  const value = JSON.parse(content) as unknown
  if (!isRecord(value) || value.userId !== userId || !Array.isArray(value.items)) {
    throw new Error('AI 素材元数据版本、账号或数量无效')
  }
  if (value.version === STORE_VERSION) {
    if (
      !hasOnlyFields(value, ['version', 'userId', 'shard', 'items'])
      || typeof value.shard !== 'number'
      || !Number.isInteger(value.shard)
      || value.shard < 0
      || value.shard >= SHARD_COUNT
      || (shard !== undefined && value.shard !== shard)
    ) {
      throw new Error('AI 素材元数据版本、账号或数量无效')
    }
    const items = parseItems(value.items, STORE_VERSION)
    if (items.some((item) => aiAssetMetadataShardOf(item.assetId) !== value.shard)) throw new Error('AI 素材元数据格式错误')
    return items
  }
  if (
    shard !== undefined
    || (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4)
    || !hasOnlyFields(value, ['version', 'userId', 'items'])
  ) {
    throw new Error('AI 素材元数据版本、账号或数量无效')
  }
  return parseItems(value.items, value.version)
}

// Written once and never cleared by the user, so an older record may fill them
// in when the newer one lacks them. Favorite, tags and deletedAt are toggles:
// their absence on the newer record is itself a choice and must win.
const FILL_IN_FIELDS = ['displayName', 'source', 'prompt'] as const

function isNewer(left: AiAssetMetadataItem, right: AiAssetMetadataItem): boolean {
  return Date.parse(left.updatedAt) > Date.parse(right.updatedAt)
}

/**
 * Combines the records of two copies of one account's metadata file (the old
 * output folder and the new one) without dropping any asset. A record present
 * on one side only is kept as it is. When both sides have the same asset, the
 * more recently updated record wins; on a tie the current side wins, so
 * merging the same legacy file twice changes nothing.
 */
export function mergeAiAssetMetadataItems(
  current: readonly AiAssetMetadataItem[],
  legacy: readonly AiAssetMetadataItem[],
): AiAssetMetadataItem[] {
  const merged = current.map((item) => structuredClone(item))
  const index = new Map(merged.map((item, position) => [item.assetId, position]))
  for (const incoming of legacy) {
    const position = index.get(incoming.assetId)
    if (position === undefined) {
      index.set(incoming.assetId, merged.length)
      merged.push(structuredClone(incoming))
      continue
    }
    const existing = merged[position]
    const newer = isNewer(incoming, existing) ? incoming : existing
    const older = newer === incoming ? existing : incoming
    const item: AiAssetMetadataItem = structuredClone(newer)
    for (const field of FILL_IN_FIELDS) {
      if (item[field] === undefined && older[field] !== undefined) Object.assign(item, { [field]: older[field] })
    }
    if (older.lastUsedAt && (!item.lastUsedAt || Date.parse(older.lastUsedAt) > Date.parse(item.lastUsedAt))) {
      item.lastUsedAt = older.lastUsedAt
    }
    merged[position] = item
  }
  return merged
}

function groupByShard(items: readonly AiAssetMetadataItem[]): Map<number, AiAssetMetadataItem[]> {
  const groups = new Map<number, AiAssetMetadataItem[]>()
  for (const item of items) {
    const shard = aiAssetMetadataShardOf(item.assetId)
    const group = groups.get(shard)
    if (group) group.push(item)
    else groups.set(shard, [item])
  }
  return groups
}

/** Overlays records still waiting in the single file; merging clones every record, so skip it when there are none. */
function withPending(items: AiAssetMetadataItem[], pending: readonly AiAssetMetadataItem[]): AiAssetMetadataItem[] {
  return pending.length === 0 ? items : mergeAiAssetMetadataItems(items, pending)
}

function toLogicalRecords(items: readonly AiAssetMetadataItem[]): Record<string, AiAssetLogicalMetadata> {
  return Object.fromEntries(items.map(({ assetId, ...metadata }) => [assetId, structuredClone(metadata)]))
}

export class AiAssetMetadataStore {
  private readonly outputRoot: string
  private readonly now: () => Date
  private readonly randomUUID: () => string
  private readonly maximumShardBytes: number
  private readonly queues = new Map<number, Promise<void>>()

  constructor(options: AiAssetMetadataStoreOptions) {
    this.outputRoot = path.resolve(options.outputRoot)
    this.now = options.now ?? (() => new Date())
    this.randomUUID = options.randomUUID ?? nodeRandomUUID
    this.maximumShardBytes = options.maximumShardBytes ?? MAXIMUM_SHARD_BYTES
  }

  /**
   * Returns every logical record for one account. The library index can exceed
   * the 1,500 identifier ceiling that `getMany` enforces, and joining a full
   * index in 1,500 wide chunks would re-read and re-parse every shard once per
   * chunk. Each shard is bounded by its byte ceiling, so one pass is safe.
   */
  getAll(userId: number): Promise<Record<string, AiAssetLogicalMetadata>> {
    return this.run(userId, async (pending) => {
      const items: AiAssetMetadataItem[] = []
      for (let shard = 0; shard < SHARD_COUNT; shard += 1) items.push(...await this.readShard(userId, shard))
      return toLogicalRecords(withPending(items, pending))
    })
  }

  getMany(userId: number, assetIds: readonly string[]): Promise<Record<string, AiAssetLogicalMetadata>> {
    return this.run(userId, async (pending) => {
      if (assetIds.length > 1_500) throw new Error('AI 素材元数据查询数量超限')
      const wanted = new Set(assetIds)
      for (const assetId of wanted) assertAssetId(assetId)
      const shards = new Set([...wanted].map((assetId) => aiAssetMetadataShardOf(assetId)))
      const items: AiAssetMetadataItem[] = []
      for (const shard of shards) items.push(...await this.readShard(userId, shard))
      return toLogicalRecords(withPending(items, pending).filter((item) => wanted.has(item.assetId)))
    })
  }

  rename(userId: number, assetId: string, displayNameInput: string): Promise<AiAssetMetadataItem> {
    return this.run(userId, async () => {
      assertAssetId(assetId)
      const displayName = normalizeAiAssetDisplayName(displayNameInput)
      const items = await this.readShard(userId, aiAssetMetadataShardOf(assetId))
      const updatedAt = this.now().toISOString()
      const existing = this.upsert(items, assetId, updatedAt)
      existing.displayName = displayName
      await this.writeShard(userId, aiAssetMetadataShardOf(assetId), items, 'grow')
      return structuredClone(existing)
    })
  }

  updatePreferences(userId: number, assetId: string, input: { favorite?: boolean; tags?: unknown }): Promise<AiAssetMetadataItem> {
    return this.run(userId, async () => {
      assertAssetId(assetId)
      if (input.favorite === undefined && input.tags === undefined) throw new Error('AI 素材整理信息不能为空')
      if (input.favorite !== undefined && typeof input.favorite !== 'boolean') throw new Error('AI 素材收藏状态格式错误')
      const tags = input.tags === undefined ? undefined : normalizeAiAssetTags(input.tags)
      const items = await this.readShard(userId, aiAssetMetadataShardOf(assetId))
      const updatedAt = this.now().toISOString()
      const item = this.upsert(items, assetId, updatedAt)
      if (input.favorite !== undefined) {
        if (input.favorite) item.favorite = true
        else delete item.favorite
      }
      if (tags !== undefined) {
        if (tags.length > 0) item.tags = tags
        else delete item.tags
      }
      await this.writeShard(userId, aiAssetMetadataShardOf(assetId), items, 'grow')
      return structuredClone(item)
    })
  }

  /**
   * Appends one tag and keeps every tag already there. The app tags a picture it
   * has just stored itself (one that arrived after a stop), and replacing the
   * list through updatePreferences would need a read first, which could drop a
   * tag the user added in between. A tag already present, in any case, or a
   * full list leaves the record as it is.
   */
  addTag(userId: number, assetId: string, tagInput: string): Promise<AiAssetMetadataItem> {
    return this.run(userId, async () => {
      assertAssetId(assetId)
      const [tag] = normalizeAiAssetTags([tagInput])
      const items = await this.readShard(userId, aiAssetMetadataShardOf(assetId))
      const existing = items.find((entry) => entry.assetId === assetId)
      const current = existing?.tags ?? []
      const key = tag.toLocaleLowerCase('zh-CN')
      if (existing && (current.length >= MAXIMUM_TAGS || current.some((entry) => entry.toLocaleLowerCase('zh-CN') === key))) {
        return structuredClone(existing)
      }
      const item = this.upsert(items, assetId, this.now().toISOString())
      item.tags = [...current, tag]
      await this.writeShard(userId, aiAssetMetadataShardOf(assetId), items, 'grow')
      return structuredClone(item)
    })
  }

  markUsed(userId: number, assetId: string): Promise<AiAssetMetadataItem> {
    return this.run(userId, async () => {
      assertAssetId(assetId)
      const items = await this.readShard(userId, aiAssetMetadataShardOf(assetId))
      const updatedAt = this.now().toISOString()
      const item = this.upsert(items, assetId, updatedAt)
      item.lastUsedAt = updatedAt
      await this.writeShard(userId, aiAssetMetadataShardOf(assetId), items, 'grow')
      return structuredClone(item)
    })
  }

  /**
   * Moves an asset to the recycle bin. Nothing on disk changes: the file is
   * only handed to the OS trash when the bin is emptied, so undoing costs one
   * click rather than a trip through the system trash.
   */
  softDelete(userId: number, assetId: string): Promise<AiAssetMetadataItem> {
    return this.run(userId, async () => {
      assertAssetId(assetId)
      const items = await this.readShard(userId, aiAssetMetadataShardOf(assetId))
      const updatedAt = this.now().toISOString()
      const item = this.upsert(items, assetId, updatedAt)
      // Re-deleting keeps the original moment, so the bin stays ordered by when
      // things were actually thrown away.
      if (!item.deletedAt) item.deletedAt = updatedAt
      await this.writeShard(userId, aiAssetMetadataShardOf(assetId), items, 'recycle')
      return structuredClone(item)
    })
  }

  restore(userId: number, assetId: string): Promise<AiAssetMetadataItem> {
    return this.run(userId, async () => {
      assertAssetId(assetId)
      const items = await this.readShard(userId, aiAssetMetadataShardOf(assetId))
      const item = items.find((entry) => entry.assetId === assetId)
      if (!item?.deletedAt) throw new Error('该素材不在回收站中')
      delete item.deletedAt
      item.updatedAt = this.now().toISOString()
      await this.writeShard(userId, aiAssetMetadataShardOf(assetId), items, 'recycle')
      return structuredClone(item)
    })
  }

  /**
   * Drops the record entirely. Called after the bytes are gone, so a metadata
   * row cannot outlive its file and reappear as a broken tile.
   */
  forget(userId: number, assetId: string): Promise<void> {
    return this.run(userId, async () => {
      assertAssetId(assetId)
      const items = await this.readShard(userId, aiAssetMetadataShardOf(assetId))
      const index = items.findIndex((entry) => entry.assetId === assetId)
      if (index === -1) return
      items.splice(index, 1)
      await this.writeShard(userId, aiAssetMetadataShardOf(assetId), items, 'recycle')
    })
  }

  setSource(userId: number, assetId: string, source: AiAssetSource, prompt?: string): Promise<AiAssetMetadataItem> {
    return this.run(userId, async () => {
      assertAssetId(assetId)
      const normalizedSource = parseSource(source)
      if (!normalizedSource) throw new Error('AI 素材来源格式错误')
      // The prompt is written here rather than through its own mutator because
      // it is a fact about how the asset came to exist, not something the user
      // can edit afterwards.
      const normalizedPrompt = prompt === undefined ? undefined : normalizeAiAssetPrompt(prompt)
      const items = await this.readShard(userId, aiAssetMetadataShardOf(assetId))
      const updatedAt = this.now().toISOString()
      const item = this.upsert(items, assetId, updatedAt)
      item.source = normalizedSource
      if (normalizedPrompt) item.prompt = normalizedPrompt
      await this.writeShard(userId, aiAssetMetadataShardOf(assetId), items, 'grow')
      return structuredClone(item)
    })
  }

  /**
   * Folds a metadata file carried over from another output folder into this
   * account's state: a single-file state from before 0.2.24, or one shard. It
   * runs in the same per-account queue as every other write, so a favorite or a
   * new asset recorded while the move is under way is not lost to a
   * read-modify-write race. An unreadable file, or one that could not be fully
   * written, throws and is left for the caller to keep; it is never treated as
   * empty.
   */
  mergeLegacy(userId: number, content: string): Promise<void> {
    return this.run(userId, async () => {
      const incoming = parseStoredItems(content, userId)
      if (incoming.length === 0) return
      const failure = await this.mergeIntoShards(userId, incoming)
      if (failure !== null) throw failure
    })
  }

  private upsert(items: AiAssetMetadataItem[], assetId: string, updatedAt: string): AiAssetMetadataItem {
    const existing = items.find((item) => item.assetId === assetId)
    if (existing) {
      existing.updatedAt = updatedAt
      return existing
    }
    const item = { assetId, updatedAt }
    items.push(item)
    return item
  }

  private accountDirectory(userId: number): string {
    return path.join(this.outputRoot, `user-${userId}`)
  }

  private legacyFilePath(userId: number): string {
    return path.join(this.accountDirectory(userId), aiAssetMetadataFileName)
  }

  private shardDirectory(userId: number): string {
    return path.join(this.accountDirectory(userId), aiAssetMetadataDirectoryName)
  }

  private shardPath(userId: number, shard: number): string {
    return path.join(this.shardDirectory(userId), `shard-${shard.toString(16)}.json`)
  }

  /**
   * Runs one operation in the account's queue after adopting any single-file
   * state still beside the shards. The operation receives the records that are
   * still only in that file because they could not be written yet, so reads
   * keep showing names, prompts and the recycle bin meanwhile.
   */
  private run<T>(userId: number, operation: (pending: AiAssetMetadataItem[]) => Promise<T>): Promise<T> {
    return this.enqueue(userId, async () => operation(await this.adoptLegacyFile(userId)))
  }

  /**
   * One-time move from the single file to the shards, checked on every
   * operation because a moved account folder can bring a single file back
   * (migrateLegacyAiOutput renames whole folders). Nothing is ever deleted:
   * - unreadable right now (an antivirus lock, a link this store refuses to
   *   follow): left exactly where it is, tried again next time;
   * - not valid metadata: renamed aside as a .corrupt backup, as before;
   * - merged into every shard: renamed aside as a .migrated backup, so it is
   *   never merged again and a record forgotten later cannot come back.
   * If a shard cannot be written the file stays, its records are handed to the
   * caller, and merging again later is harmless (the newer record wins).
   */
  private async adoptLegacyFile(userId: number): Promise<AiAssetMetadataItem[]> {
    const legacyPath = this.legacyFilePath(userId)
    let content: string | null
    try {
      content = await readSafeUtf8File(legacyPath, FILE_LABEL, MAXIMUM_SHARD_BYTES)
    } catch {
      return []
    }
    if (content === null) return []
    let legacy: AiAssetMetadataItem[]
    try {
      legacy = parseStoredItems(content, userId)
    } catch {
      await this.backupAside(legacyPath, 'corrupt')
      return []
    }
    if (await this.mergeIntoShards(userId, legacy) !== null) return legacy
    await this.backupAside(legacyPath, 'migrated')
    return []
  }

  /** Merges records into their shards; returns the first failure, if any, after trying every shard. */
  private async mergeIntoShards(userId: number, incoming: readonly AiAssetMetadataItem[]): Promise<unknown> {
    let failure: unknown = null
    for (const [shard, records] of groupByShard(incoming)) {
      try {
        const current = await this.readShard(userId, shard)
        const merged = mergeAiAssetMetadataItems(current, records)
        if (JSON.stringify(merged) === JSON.stringify(current)) continue
        await this.writeShard(userId, shard, merged, 'recycle')
      } catch (error) {
        failure ??= error
      }
    }
    return failure
  }

  private async readShard(userId: number, shard: number): Promise<AiAssetMetadataItem[]> {
    const filePath = this.shardPath(userId, shard)
    try {
      const content = await readSafeUtf8File(filePath, FILE_LABEL, this.maximumShardBytes)
      return content === null ? [] : parseStoredItems(content, userId, shard)
    } catch {
      await this.backupAside(filePath, 'corrupt')
      return []
    }
  }

  private async backupAside(filePath: string, reason: 'corrupt' | 'migrated'): Promise<void> {
    try {
      if (!assertSafeDataFile(filePath, FILE_LABEL)) return
      await fs.promises.rename(filePath, `${filePath}.${reason}-${this.now().getTime()}-${this.randomUUID()}.bak`)
    } catch {
      // Unsafe or locked paths remain untouched.
    }
  }

  private async writeShard(userId: number, shard: number, items: AiAssetMetadataItem[], budget: WriteBudget): Promise<void> {
    ensureSafeDataDirectory(this.outputRoot, FILE_LABEL)
    ensureSafeDataDirectory(this.accountDirectory(userId), FILE_LABEL)
    ensureSafeDataDirectory(this.shardDirectory(userId), FILE_LABEL)
    // Compact on purpose: indentation was a tenth of the old file.
    const content = `${JSON.stringify({ version: STORE_VERSION, userId, shard, items })}\n`
    const limit = budget === 'recycle'
      ? this.maximumShardBytes
      : this.maximumShardBytes - Math.floor(this.maximumShardBytes / SHARD_COUNT)
    if (Buffer.byteLength(content, 'utf8') > limit) {
      throw new Error(`AI 素材元数据文件超过 ${Math.floor(limit / MEGABYTE)} MB 安全上限`)
    }
    await writeAtomicSafeUtf8File(this.shardPath(userId, shard), content, FILE_LABEL)
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
