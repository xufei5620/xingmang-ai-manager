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
const STORE_VERSION = 1
const MAXIMUM_BYTES = 2 * 1024 * 1024
const MAXIMUM_ITEMS = 5_000
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const INVALID_DISPLAY_NAME_CHARACTERS = /[\x00-\x1F\x7F<>:"/\\|?*]/

export interface AiAssetLogicalMetadata {
  displayName: string
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

function parseItem(value: unknown): AiAssetMetadataItem {
  if (!isRecord(value) || !hasOnlyFields(value, ['assetId', 'displayName', 'updatedAt'])) {
    throw new Error('AI 素材元数据格式错误')
  }
  if (typeof value.assetId !== 'string') throw new Error('AI 素材标识格式错误')
  assertAssetId(value.assetId)
  if (!isIsoDate(value.updatedAt)) throw new Error('AI 素材更新时间格式错误')
  return {
    assetId: value.assetId,
    displayName: normalizeAiAssetDisplayName(value.displayName),
    updatedAt: value.updatedAt,
  }
}

function parseState(content: string, userId: number): AiAssetMetadataState {
  const value = JSON.parse(content) as unknown
  if (
    !isRecord(value)
    || !hasOnlyFields(value, ['version', 'userId', 'items'])
    || value.version !== STORE_VERSION
    || value.userId !== userId
    || !Array.isArray(value.items)
    || value.items.length > MAXIMUM_ITEMS
  ) {
    throw new Error('AI 素材元数据版本、账号或数量无效')
  }
  const items = value.items.map(parseItem)
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
        .map(({ assetId, displayName, updatedAt }) => [assetId, { displayName, updatedAt }]))
    })
  }

  rename(userId: number, assetId: string, displayNameInput: string): Promise<AiAssetMetadataItem> {
    return this.enqueue(userId, async () => {
      assertAssetId(assetId)
      const displayName = normalizeAiAssetDisplayName(displayNameInput)
      const state = await this.readState(userId)
      const updatedAt = this.now().toISOString()
      const existing = state.items.find((item) => item.assetId === assetId)
      if (existing) {
        existing.displayName = displayName
        existing.updatedAt = updatedAt
      } else {
        if (state.items.length >= MAXIMUM_ITEMS) throw new Error(`AI 素材元数据最多保存 ${MAXIMUM_ITEMS} 条`)
        state.items.push({ assetId, displayName, updatedAt })
      }
      await this.writeState(userId, state)
      return { assetId, displayName, updatedAt }
    })
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
