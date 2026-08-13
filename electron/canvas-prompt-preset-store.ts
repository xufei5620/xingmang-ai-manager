import fs from 'node:fs'
import path from 'node:path'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import {
  assertSafeDataFile,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'

const FILE_LABEL = '画布提示词预设'
const STORE_VERSION = 1
const MAXIMUM_BYTES = 2 * 1024 * 1024
const MAXIMUM_ITEMS = 500
const CONTROL_CHARACTERS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/

export interface CanvasPromptPreset {
  id: string
  name: string
  prompt: string
  tags: string[]
  createdAt: string
  updatedAt: string
  provenance: 'user-created'
}

interface PresetState {
  version: typeof STORE_VERSION
  userId: number
  items: CanvasPromptPreset[]
}

export interface CanvasPromptPresetInput {
  name: string
  prompt: string
  tags?: string[]
}

export interface CanvasPromptPresetUpdate {
  id: string
  name?: string
  prompt?: string
  tags?: string[]
}

export interface CanvasPromptPresetStoreOptions {
  rootDirectory: string
  now?: () => Date
  randomUUID?: () => string
}

function validUserId(userId: number): void {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('画布账号标识格式错误')
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${label}格式错误`)
  }
  return value.trim()
}

function normalizedTags(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 16) throw new Error('提示词标签格式错误')
  const tags = value.map((tag) => boundedText(tag, '提示词标签', 32))
  if (new Set(tags).size !== tags.length) throw new Error('提示词标签不能重复')
  return tags
}

function normalizedInput(input: CanvasPromptPresetInput): CanvasPromptPresetInput {
  return {
    name: boundedText(input.name, '提示词名称', 100),
    prompt: boundedText(input.prompt, '提示词内容', 40_000),
    tags: normalizedTags(input.tags),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const allowed = new Set(fields)
  return Object.keys(value).every((key) => allowed.has(key))
}

function validIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && !Number.isNaN(Date.parse(value))
}

function parsePreset(value: unknown): CanvasPromptPreset {
  if (!isRecord(value) || !exactFields(value, ['id', 'name', 'prompt', 'tags', 'createdAt', 'updatedAt', 'provenance'])) {
    throw new Error('提示词预设格式错误')
  }
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(value.id)) throw new Error('提示词预设标识格式错误')
  if (!validIsoDate(value.createdAt) || !validIsoDate(value.updatedAt) || value.provenance !== 'user-created') {
    throw new Error('提示词预设元数据格式错误')
  }
  const input = normalizedInput({ name: value.name as string, prompt: value.prompt as string, tags: value.tags as string[] })
  return { id: value.id, ...input, tags: input.tags ?? [], createdAt: value.createdAt, updatedAt: value.updatedAt, provenance: 'user-created' }
}

function parseState(content: string, userId: number): PresetState {
  const value = JSON.parse(content) as unknown
  if (!isRecord(value) || !exactFields(value, ['version', 'userId', 'items']) || value.version !== STORE_VERSION || value.userId !== userId) {
    throw new Error('提示词预设版本或账号不匹配')
  }
  if (!Array.isArray(value.items) || value.items.length > MAXIMUM_ITEMS) throw new Error('提示词预设数量超限')
  const items = value.items.map(parsePreset)
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('提示词预设标识重复')
  return { version: STORE_VERSION, userId, items }
}

export class CanvasPromptPresetStore {
  private readonly rootDirectory: string
  private readonly now: () => Date
  private readonly randomUUID: () => string
  private readonly queues = new Map<number, Promise<void>>()

  constructor(options: CanvasPromptPresetStoreOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory)
    this.now = options.now ?? (() => new Date())
    this.randomUUID = options.randomUUID ?? nodeRandomUUID
  }

  list(userId: number): Promise<CanvasPromptPreset[]> {
    return this.enqueue(userId, async () => structuredClone((await this.readState(userId)).items))
  }

  create(userId: number, input: CanvasPromptPresetInput): Promise<CanvasPromptPreset> {
    return this.enqueue(userId, async () => {
      const state = await this.readState(userId)
      if (state.items.length >= MAXIMUM_ITEMS) throw new Error(`提示词预设最多保存 ${MAXIMUM_ITEMS} 条`)
      const normalized = normalizedInput(input)
      const timestamp = this.now().toISOString()
      const item: CanvasPromptPreset = {
        id: this.randomUUID(), ...normalized, tags: normalized.tags ?? [],
        createdAt: timestamp, updatedAt: timestamp, provenance: 'user-created',
      }
      if (!/^[A-Za-z0-9_-]{16,80}$/.test(item.id)) throw new Error('无法生成提示词预设标识')
      state.items.unshift(item)
      await this.writeState(userId, state)
      return structuredClone(item)
    })
  }

  update(userId: number, patch: CanvasPromptPresetUpdate): Promise<CanvasPromptPreset> {
    return this.enqueue(userId, async () => {
      if (!/^[A-Za-z0-9_-]{16,80}$/.test(patch.id)) throw new Error('提示词预设标识格式错误')
      const state = await this.readState(userId)
      const item = state.items.find((entry) => entry.id === patch.id)
      if (!item) throw new Error('提示词预设不存在')
      const normalized = normalizedInput({
        name: patch.name ?? item.name,
        prompt: patch.prompt ?? item.prompt,
        tags: patch.tags ?? item.tags,
      })
      Object.assign(item, normalized, { tags: normalized.tags ?? [], updatedAt: this.now().toISOString() })
      await this.writeState(userId, state)
      return structuredClone(item)
    })
  }

  delete(userId: number, id: string): Promise<boolean> {
    return this.enqueue(userId, async () => {
      if (!/^[A-Za-z0-9_-]{16,80}$/.test(id)) throw new Error('提示词预设标识格式错误')
      const state = await this.readState(userId)
      const next = state.items.filter((item) => item.id !== id)
      if (next.length === state.items.length) return false
      state.items = next
      await this.writeState(userId, state)
      return true
    })
  }

  private userDirectory(userId: number): string { return path.join(this.rootDirectory, `user-${userId}`) }
  private filePath(userId: number): string { return path.join(this.userDirectory(userId), 'prompt-presets.json') }

  private async readState(userId: number): Promise<PresetState> {
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
      // Unsafe paths stay untouched; the caller receives an empty in-memory state.
    }
  }

  private async writeState(userId: number, state: PresetState): Promise<void> {
    ensureSafeDataDirectory(this.rootDirectory, FILE_LABEL)
    ensureSafeDataDirectory(this.userDirectory(userId), FILE_LABEL)
    const content = `${JSON.stringify(state, null, 2)}\n`
    if (Buffer.byteLength(content, 'utf8') > MAXIMUM_BYTES) throw new Error('提示词预设文件超过 2 MB 安全上限')
    await writeAtomicSafeUtf8File(this.filePath(userId), content, FILE_LABEL)
  }

  private enqueue<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    validUserId(userId)
    const previous = this.queues.get(userId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.queues.set(userId, tail)
    void tail.then(() => { if (this.queues.get(userId) === tail) this.queues.delete(userId) })
    return result
  }
}
