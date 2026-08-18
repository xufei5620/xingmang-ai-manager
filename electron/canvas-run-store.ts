import fs from 'node:fs'
import path from 'node:path'
import { randomUUID as nodeRandomUUID } from 'node:crypto'
import {
  assertSafeDataFile,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  writeAtomicSafeUtf8File,
} from './safe-local-data'
import {
  canvasRunContractVersion,
  type CanvasRunAsset,
  type CanvasRunAssetLineage,
  type CanvasRunAssetManifestEntry,
  type CanvasRunCacheEntry,
  type CanvasRunNodeKind,
  type CanvasRunRecord,
} from './canvas-run-contract'

const DEFAULT_MAXIMUM_BYTES = 8 * 1024 * 1024
const DEFAULT_RUN_RETENTION = 100
const DEFAULT_CACHE_RETENTION = 500
const DEFAULT_ASSET_RETENTION = 2_000
const FILE_LABEL = '画布运行记录'
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/
const ASSET_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/
const PROJECT_ID_PATTERN = /^[a-f0-9-]{36}$/
const CACHEABLE_NODE_KINDS = new Set<CanvasRunNodeKind>([
  'text', 'image', 'video', 'prompt', 'image-input', 'video-input', 'audio-input', 'image-generate', 'image-edit',
  'video-generate', 'frame-extract', 'router', 'gallery', 'output', 'group', 'note',
])
const CANVAS_RUN_NODE_STAGES = new Set([
  'validating', 'resolving-cache', 'waiting-slot', 'submitting', 'processing', 'downloading', 'saving',
])

interface CanvasRunStateFile {
  version: typeof canvasRunContractVersion
  userId: number
  runs: CanvasRunRecord[]
  cache: CanvasRunCacheEntry[]
  assets: CanvasRunAssetManifestEntry[]
}

export interface CanvasRunAssetResolver {
  readOwned(userId: number, assetId: string): Promise<{ asset: Omit<CanvasRunAsset, 'kind'> }>
}

export interface CanvasRunStoreOptions {
  rootDirectory: string
  assets: CanvasRunAssetResolver
  maximumBytes?: number
  runRetention?: number
  cacheRetention?: number
  assetRetention?: number
  now?: () => Date
  randomUUID?: () => string
}

function assertPositiveInteger(value: number, label: string, maximum = 100_000): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`${label}配置无效`)
}

function requireUserId(userId: number): void {
  assertPositiveInteger(userId, '画布账号标识', Number.MAX_SAFE_INTEGER)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 20 && value.length <= 40 && !Number.isNaN(Date.parse(value))
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1F\x7F]/.test(value)
}

function safeAsset(value: unknown): value is CanvasRunAsset {
  if (!isRecord(value) || (value.kind !== 'image' && value.kind !== 'video' && value.kind !== 'audio')) return false
  if (typeof value.assetId !== 'string' || !ASSET_ID_PATTERN.test(value.assetId)) return false
  if (value.localUrl !== `xingmang-asset://${value.kind}/${value.assetId}`) return false
  if (value.mimeType !== undefined && (typeof value.mimeType !== 'string' || value.mimeType.length > 128)) return false
  if (value.width !== undefined && (!Number.isSafeInteger(value.width) || (value.width as number) <= 0)) return false
  if (value.height !== undefined && (!Number.isSafeInteger(value.height) || (value.height as number) <= 0)) return false
  if (value.taskId !== undefined && !safeIdentifier(value.taskId)) return false
  return true
}

function safeRunRecord(value: unknown, userId: number): value is CanvasRunRecord {
  if (!isRecord(value) || value.version !== canvasRunContractVersion || value.userId !== userId) return false
  if (!safeIdentifier(value.runId) || !safeIdentifier(value.graphRevision)) return false
  if (value.projectId !== undefined && (typeof value.projectId !== 'string' || !PROJECT_ID_PATTERN.test(value.projectId))) return false
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.startedAt)) return false
  if (!Array.isArray(value.nodes) || !Array.isArray(value.events)) return false
  if (value.nodes.length > 5_000 || value.events.length > 25_000) return false
  const safeProgress = (entry: Record<string, unknown>, progressKey: string, modeKey: string, healthKey: string) => (
    (entry[progressKey] === undefined || (typeof entry[progressKey] === 'number' && Number.isFinite(entry[progressKey]) && (entry[progressKey] as number) >= 0 && (entry[progressKey] as number) <= 100))
    && (entry[modeKey] === undefined || entry[modeKey] === 'determinate' || entry[modeKey] === 'indeterminate')
    && (entry[healthKey] === undefined || entry[healthKey] === 'normal' || entry[healthKey] === 'delayed')
  )
  if (value.nodes.some((node) => !isRecord(node)
    || (node.latestStage !== undefined && !CANVAS_RUN_NODE_STAGES.has(node.latestStage as string))
    || !safeProgress(node, 'latestProgress', 'latestProgressMode', 'latestHealth'))) return false
  if (value.events.some((event) => !isRecord(event)
    || (event.type === 'node-stage' && (!CANVAS_RUN_NODE_STAGES.has(event.stage as string)
      || !safeProgress(event, 'progress', 'progressMode', 'health'))))) return false
  return value.status === 'running'
    || value.status === 'succeeded'
    || value.status === 'partial'
    || value.status === 'failed'
    || value.status === 'cancelled'
    || value.status === 'interrupted'
}

function safeCacheEntry(value: unknown): value is CanvasRunCacheEntry {
  if (!isRecord(value) || value.version !== canvasRunContractVersion) return false
  if (typeof value.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(value.fingerprint)) return false
  if (!CACHEABLE_NODE_KINDS.has(value.nodeKind as CanvasRunNodeKind)) return false
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.lastUsedAt)) return false
  if (value.outputText !== undefined && (typeof value.outputText !== 'string' || value.outputText.length > 100_000)) return false
  if (value.candidate !== undefined) {
    if (!isRecord(value.candidate) || !safeIdentifier(value.candidate.candidateId)) return false
    if (!safeIdentifier(value.candidate.attemptId) || !isIsoDate(value.candidate.createdAt)) return false
    if (!safeAsset(value.candidate.asset)) return false
  }
  return value.outputText !== undefined || value.candidate !== undefined
}

function safeManifestEntry(value: unknown): value is CanvasRunAssetManifestEntry {
  return isRecord(value)
    && value.version === canvasRunContractVersion
    && safeAsset(value.asset)
    && isIsoDate(value.createdAt)
    && isIsoDate(value.lastVerifiedAt)
    && (value.lineage === undefined || safeLineage(value.lineage))
}

function safeLineage(value: unknown): value is CanvasRunAssetLineage {
  if (!isRecord(value) || value.origin !== 'generated') return false
  if (!safeIdentifier(value.runId) || !safeIdentifier(value.graphRevision)
    || !safeIdentifier(value.nodeId) || !safeIdentifier(value.attemptId) || !safeIdentifier(value.candidateId)) return false
  if (value.projectId !== undefined && (typeof value.projectId !== 'string' || !PROJECT_ID_PATTERN.test(value.projectId))) return false
  return Array.isArray(value.sourceAssetIds)
    && value.sourceAssetIds.length <= 256
    && value.sourceAssetIds.every((assetId) => typeof assetId === 'string' && ASSET_ID_PATTERN.test(assetId))
}

function parseState(content: string, userId: number): CanvasRunStateFile {
  const value = JSON.parse(content) as unknown
  if (!isRecord(value) || value.version !== canvasRunContractVersion || value.userId !== userId) {
    throw new Error('画布运行记录版本或账号不匹配')
  }
  if (!Array.isArray(value.runs) || !value.runs.every((run) => safeRunRecord(run, userId))) {
    throw new Error('画布运行历史格式错误')
  }
  if (!Array.isArray(value.cache) || !value.cache.every(safeCacheEntry)) throw new Error('画布运行缓存格式错误')
  if (!Array.isArray(value.assets) || !value.assets.every(safeManifestEntry)) throw new Error('画布资产清单格式错误')
  return value as unknown as CanvasRunStateFile
}

function emptyState(userId: number): CanvasRunStateFile {
  return { version: canvasRunContractVersion, userId, runs: [], cache: [], assets: [] }
}

function stateContainsSecretOrPath(content: string): boolean {
  return /\bBearer\s+\S+/i.test(content)
    || /\bsk-[a-z0-9._-]{8,}\b/i.test(content)
    || /"(?:apiKey|accessToken|refreshToken|remoteUrl|filePath)"\s*:/i.test(content)
    || /https?:\/\//i.test(content)
    || /(?:[A-Za-z]:\\|file:\/\/)/i.test(content)
}

function cloneState(state: CanvasRunStateFile): CanvasRunStateFile {
  return structuredClone(state)
}

export class CanvasRunStore {
  private readonly rootDirectory: string
  private readonly assets: CanvasRunAssetResolver
  private readonly maximumBytes: number
  private readonly runRetention: number
  private readonly cacheRetention: number
  private readonly assetRetention: number
  private readonly now: () => Date
  private readonly randomUUID: () => string
  private readonly queues = new Map<number, Promise<void>>()

  constructor(options: CanvasRunStoreOptions) {
    this.rootDirectory = path.resolve(options.rootDirectory)
    this.assets = options.assets
    this.maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES
    this.runRetention = options.runRetention ?? DEFAULT_RUN_RETENTION
    this.cacheRetention = options.cacheRetention ?? DEFAULT_CACHE_RETENTION
    this.assetRetention = options.assetRetention ?? DEFAULT_ASSET_RETENTION
    this.now = options.now ?? (() => new Date())
    this.randomUUID = options.randomUUID ?? nodeRandomUUID
    assertPositiveInteger(this.maximumBytes, '画布记录大小上限', 64 * 1024 * 1024)
    assertPositiveInteger(this.runRetention, '画布运行历史保留数')
    assertPositiveInteger(this.cacheRetention, '画布缓存保留数')
    assertPositiveInteger(this.assetRetention, '画布资产清单保留数')
  }

  async initializeUser(userId: number): Promise<CanvasRunRecord[]> {
    return this.enqueue(userId, async () => {
      const state = await this.readState(userId)
      let changed = false
      const recoveredAt = this.now()
      for (const run of state.runs) {
        if (run.status !== 'running') continue
        run.status = 'interrupted'
        run.completedAt = recoveredAt.toISOString()
        run.durationMs = Math.max(0, recoveredAt.getTime() - Date.parse(run.startedAt))
        for (const node of run.nodes) {
          if (node.state === 'queued' || node.state === 'running' || node.state === 'cancelling') {
            node.state = 'interrupted'
            node.errorMessage = '应用上次退出时节点仍在运行，未自动重试付费操作'
          }
        }
        changed = true
      }
      if (changed) await this.writeState(userId, state)
      return structuredClone(state.runs)
    })
  }

  async listRuns(userId: number): Promise<CanvasRunRecord[]> {
    return this.enqueue(userId, async () => structuredClone((await this.readState(userId)).runs))
  }

  async getRun(userId: number, runId: string): Promise<CanvasRunRecord | null> {
    return this.enqueue(userId, async () => {
      if (!safeIdentifier(runId)) throw new Error('画布运行标识格式错误')
      const run = (await this.readState(userId)).runs.find((entry) => entry.runId === runId)
      return run ? structuredClone(run) : null
    })
  }

  async getAssetLineage(userId: number, assetIds: readonly string[]): Promise<Record<string, CanvasRunAssetLineage>> {
    return this.enqueue(userId, async () => {
      if (assetIds.length > 1_500) throw new Error('画布资产谱系查询数量超限')
      const wanted = new Set(assetIds)
      if ([...wanted].some((assetId) => !ASSET_ID_PATTERN.test(assetId))) throw new Error('画布资产标识格式错误')
      const state = await this.readState(userId)
      return Object.fromEntries(state.assets
        .filter((entry) => entry.lineage && wanted.has(entry.asset.assetId))
        .map((entry) => [entry.asset.assetId, structuredClone(entry.lineage!)]))
    })
  }

  async saveRun(userId: number, run: CanvasRunRecord): Promise<void> {
    return this.enqueue(userId, async () => {
      if (!safeRunRecord(run, userId)) throw new Error('画布运行记录格式错误')
      const state = await this.readState(userId)
      const copy = structuredClone(run)
      const existing = state.runs.findIndex((entry) => entry.runId === copy.runId)
      if (existing >= 0) state.runs.splice(existing, 1)
      state.runs.unshift(copy)
      state.runs = state.runs.slice(0, this.runRetention)
      for (const node of copy.nodes) {
        for (const attempt of node.attempts) {
          for (const candidate of attempt.candidates) {
            this.recordAssetInState(state, candidate.asset, candidate.createdAt, attempt.cached ? undefined : {
              origin: 'generated',
              runId: copy.runId,
              graphRevision: copy.graphRevision,
              nodeId: node.nodeId,
              attemptId: attempt.attemptId,
              candidateId: candidate.candidateId,
              ...(copy.projectId ? { projectId: copy.projectId } : {}),
              sourceAssetIds: [...(attempt.inputAssetIds ?? [])],
            })
          }
        }
      }
      await this.writeState(userId, state)
    })
  }

  async resolveCache(userId: number, fingerprint: string): Promise<CanvasRunCacheEntry | null> {
    return this.enqueue(userId, async () => {
      if (!FINGERPRINT_PATTERN.test(fingerprint)) throw new Error('画布节点指纹格式错误')
      const state = await this.readState(userId)
      const index = state.cache.findIndex((entry) => entry.fingerprint === fingerprint)
      if (index < 0) return null
      const cached = state.cache[index]
      if (cached.candidate) {
        try {
          const owned = await this.assets.readOwned(userId, cached.candidate.asset.assetId)
          cached.candidate.asset = {
            kind: cached.candidate.asset.kind,
            ...structuredClone(owned.asset),
          }
        } catch {
          state.cache.splice(index, 1)
          state.assets = state.assets.filter((entry) => entry.asset.assetId !== cached.candidate?.asset.assetId)
          await this.writeState(userId, state)
          return null
        }
      }
      cached.lastUsedAt = this.now().toISOString()
      state.cache.splice(index, 1)
      state.cache.unshift(cached)
      await this.writeState(userId, state)
      return structuredClone(cached)
    })
  }

  async storeCache(userId: number, entry: CanvasRunCacheEntry): Promise<void> {
    return this.enqueue(userId, async () => {
      if (!safeCacheEntry(entry)) throw new Error('画布节点缓存格式错误')
      if (entry.candidate) await this.assets.readOwned(userId, entry.candidate.asset.assetId)
      const state = await this.readState(userId)
      state.cache = [structuredClone(entry), ...state.cache.filter((item) => item.fingerprint !== entry.fingerprint)]
        .slice(0, this.cacheRetention)
      if (entry.candidate) this.recordAssetInState(state, entry.candidate.asset, entry.candidate.createdAt)
      await this.writeState(userId, state)
    })
  }

  async reconcileAssets(userId: number): Promise<CanvasRunAssetManifestEntry[]> {
    return this.enqueue(userId, async () => {
      const state = await this.readState(userId)
      const verified: CanvasRunAssetManifestEntry[] = []
      const missing = new Set<string>()
      for (const entry of state.assets) {
        try {
          const owned = await this.assets.readOwned(userId, entry.asset.assetId)
          verified.push({
            ...entry,
            asset: { kind: entry.asset.kind, ...structuredClone(owned.asset) },
            lastVerifiedAt: this.now().toISOString(),
          })
        } catch {
          missing.add(entry.asset.assetId)
        }
      }
      state.assets = verified.slice(0, this.assetRetention)
      if (missing.size > 0) {
        state.cache = state.cache.filter((entry) => !entry.candidate || !missing.has(entry.candidate.asset.assetId))
      }
      await this.writeState(userId, state)
      return structuredClone(state.assets)
    })
  }

  private recordAssetInState(
    state: CanvasRunStateFile,
    asset: CanvasRunAsset,
    createdAt: string,
    lineage?: CanvasRunAssetLineage,
  ): void {
    if (!safeAsset(asset)) throw new Error('画布资产记录格式错误')
    const existing = state.assets.find((entry) => entry.asset.assetId === asset.assetId)
    const entry: CanvasRunAssetManifestEntry = existing
      ? {
        ...existing,
        asset: structuredClone(asset),
        lastVerifiedAt: this.now().toISOString(),
        ...(existing.lineage ? { lineage: existing.lineage } : lineage ? { lineage: structuredClone(lineage) } : {}),
      }
      : {
        version: canvasRunContractVersion,
        asset: structuredClone(asset),
        createdAt,
        lastVerifiedAt: this.now().toISOString(),
        ...(lineage ? { lineage: structuredClone(lineage) } : {}),
      }
    state.assets = [entry, ...state.assets.filter((item) => item.asset.assetId !== asset.assetId)]
      .slice(0, this.assetRetention)
  }

  private userDirectory(userId: number): string {
    requireUserId(userId)
    return path.join(this.rootDirectory, `user-${userId}`)
  }

  private filePath(userId: number): string {
    return path.join(this.userDirectory(userId), 'canvas-runtime.json')
  }

  private async readState(userId: number): Promise<CanvasRunStateFile> {
    requireUserId(userId)
    const filePath = this.filePath(userId)
    let content: string | null
    try {
      content = await readSafeUtf8File(filePath, FILE_LABEL, this.maximumBytes)
      if (content === null) return emptyState(userId)
      if (stateContainsSecretOrPath(content)) throw new Error('画布运行记录包含密钥、远程地址或本地路径')
      return parseState(content, userId)
    } catch {
      await this.backupCorruptState(filePath)
      return emptyState(userId)
    }
  }

  private async backupCorruptState(filePath: string): Promise<void> {
    try {
      if (!assertSafeDataFile(filePath, FILE_LABEL)) return
      const backupPath = `${filePath}.corrupt-${this.now().getTime()}-${this.randomUUID()}.bak`
      await fs.promises.rename(filePath, backupPath)
    } catch {
      // Unsafe paths are deliberately left untouched. Recovery still degrades
      // to an empty in-memory state instead of following attacker-controlled links.
    }
  }

  private async writeState(userId: number, state: CanvasRunStateFile): Promise<void> {
    const directory = this.userDirectory(userId)
    ensureSafeDataDirectory(this.rootDirectory, FILE_LABEL)
    ensureSafeDataDirectory(directory, FILE_LABEL)
    const normalized = cloneState(state)
    normalized.runs = normalized.runs.slice(0, this.runRetention)
    normalized.cache = normalized.cache.slice(0, this.cacheRetention)
    normalized.assets = normalized.assets.slice(0, this.assetRetention)
    const content = `${JSON.stringify(normalized, null, 2)}\n`
    if (Buffer.byteLength(content, 'utf8') > this.maximumBytes) throw new Error('画布运行记录超过安全上限')
    if (stateContainsSecretOrPath(content)) throw new Error('画布运行记录包含密钥、远程地址或本地路径')
    await writeAtomicSafeUtf8File(this.filePath(userId), content, FILE_LABEL)
  }

  private enqueue<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    requireUserId(userId)
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
