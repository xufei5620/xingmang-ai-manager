import path from 'node:path'
import { ensureSafeDataDirectory, readSafeUtf8File, writeAtomicSafeUtf8File } from './safe-local-data'

/**
 * The summary a single probe extracts from one session file. Only this
 * metadata is cached: transcript text never leaves the source file, so a
 * stolen or hand-edited cache exposes nothing the session list does not
 * already show.
 */
export interface ProviderSessionProbeState {
  nativeId: string
  title: string
  cwd: string
  model: string
  createdAt: number | null
  updatedAt: number | null
  messageCount: number | null
  firstUserText: string
}

export interface ProviderSessionProbeEntry {
  /** Which sweep owns this entry, so a full sweep can prune its own leftovers. */
  scope: string
  fingerprint: string
  state: ProviderSessionProbeState
}

export type ProviderSessionProbeCacheWarningCode =
  | 'probe-cache-read-failed'
  | 'probe-cache-discarded'
  | 'probe-cache-write-failed'

export interface ProviderSessionProbeCacheWarning {
  code: ProviderSessionProbeCacheWarningCode
  message: string
  detail?: string
}

export interface ProviderSessionProbeCacheOptions {
  /** Omitted keeps the cache memory-only, which is the pre-0.2.9 behaviour. */
  filePath?: string
  maxEntries?: number
  onWarning?: (warning: ProviderSessionProbeCacheWarning) => void
}

// Bumped whenever the stored shape changes; a mismatch discards the whole
// file instead of trying to migrate metadata that is cheap to rebuild.
export const PROBE_CACHE_VERSION = 1

const fileLabel = '会话探测缓存'
const defaultMaxEntries = 10_000
const maximumReadBytes = 4 * 1024 * 1024
// One cached probe costs roughly 700 bytes, so this budget keeps a few
// thousand of the most recent sessions. Anything trimmed simply falls back to
// reading the session file, which is what every launch used to do.
const maximumWriteBytes = 2 * 1024 * 1024
const documentOverheadBytes = 64
const maximumKeyLength = 1024
const maximumFingerprintLength = 256
const maximumScopeLength = 64
const maximumTextLength = 2048

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cachedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // A hand-edited cache must not be able to push an oversized title into the
  // list; the probe itself never produces anything near this length.
  return value.slice(0, maximumTextLength)
}

function cachedNumber(value: unknown): number | null | undefined {
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseProbeState(value: unknown): ProviderSessionProbeState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const nativeId = cachedText(record.nativeId)
  const title = cachedText(record.title)
  const cwd = cachedText(record.cwd)
  const model = cachedText(record.model)
  const firstUserText = cachedText(record.firstUserText)
  const createdAt = cachedNumber(record.createdAt)
  const updatedAt = cachedNumber(record.updatedAt)
  const messageCount = cachedNumber(record.messageCount)
  if (nativeId === null || title === null || cwd === null || model === null || firstUserText === null) return null
  if (createdAt === undefined || updatedAt === undefined || messageCount === undefined) return null
  return { nativeId, title, cwd, model, createdAt, updatedAt, messageCount, firstUserText }
}

function parseEntry(value: unknown): { key: string; entry: ProviderSessionProbeEntry } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const key = record.key
  const fingerprint = record.fingerprint
  const scope = record.scope
  if (typeof key !== 'string' || !key || key.length > maximumKeyLength) return null
  if (typeof fingerprint !== 'string' || !fingerprint || fingerprint.length > maximumFingerprintLength) return null
  if (typeof scope !== 'string' || !scope || scope.length > maximumScopeLength) return null
  const state = parseProbeState(record.state)
  if (!state) return null
  return { key, entry: { scope, fingerprint, state } }
}

/**
 * Returns null when the document is unusable as a whole (wrong version,
 * invalid JSON, wrong container shape). Individual malformed entries are
 * dropped instead, because one bad line should not cost a full rescan.
 */
export function parseProbeCacheDocument(
  content: string,
  maxEntries: number,
): Map<string, ProviderSessionProbeEntry> | null {
  let document: unknown
  try {
    document = JSON.parse(content) as unknown
  } catch {
    return null
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return null
  const record = document as Record<string, unknown>
  if (record.version !== PROBE_CACHE_VERSION) return null
  if (!Array.isArray(record.entries)) return null
  const entries = new Map<string, ProviderSessionProbeEntry>()
  // Oldest first on disk, so replaying the array rebuilds the same LRU order.
  for (const value of record.entries) {
    const parsed = parseEntry(value)
    if (!parsed) continue
    entries.delete(parsed.key)
    entries.set(parsed.key, parsed.entry)
  }
  while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string)
  return entries
}

export function serializeProbeCache(
  entries: Map<string, ProviderSessionProbeEntry>,
  budgetBytes = maximumWriteBytes - documentOverheadBytes,
): string {
  const ordered = [...entries.entries()]
  const encoded: string[] = []
  let used = 0
  // Filled newest first so that a cache over the byte budget keeps the
  // sessions the user is most likely to open next.
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const [key, entry] = ordered[index] as [string, ProviderSessionProbeEntry]
    const line = JSON.stringify({ key, scope: entry.scope, fingerprint: entry.fingerprint, state: entry.state })
    const cost = Buffer.byteLength(line, 'utf8') + 1
    if (used + cost > budgetBytes) break
    used += cost
    encoded.push(line)
  }
  encoded.reverse()
  return `{"version":${PROBE_CACHE_VERSION},"entries":[${encoded.join(',')}]}\n`
}

export class ProviderSessionProbeCache {
  private readonly filePath: string | null
  private readonly maxEntries: number
  private readonly onWarning: (warning: ProviderSessionProbeCacheWarning) => void
  private readonly entries = new Map<string, ProviderSessionProbeEntry>()
  private loading: Promise<void> | null = null
  private dirty = false
  private writing: Promise<void> = Promise.resolve()

  constructor(options: ProviderSessionProbeCacheOptions = {}) {
    this.filePath = options.filePath ? path.resolve(options.filePath) : null
    this.maxEntries = Number.isInteger(options.maxEntries) && (options.maxEntries ?? 0) > 0
      ? options.maxEntries as number
      : defaultMaxEntries
    this.onWarning = options.onWarning ?? (() => undefined)
  }

  /** Reads the stored cache at most once per process; safe to await per file. */
  ready(): Promise<void> {
    if (!this.loading) this.loading = this.load()
    return this.loading
  }

  get(key: string): ProviderSessionProbeEntry | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key: string, entry: ProviderSessionProbeEntry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value as string)
    }
    this.dirty = true
  }

  delete(key: string): void {
    if (this.entries.delete(key)) this.dirty = true
  }

  /**
   * Drops everything this scope cached but did not see this time. Matching on
   * the recorded scope rather than on the key's path prefix is what makes it
   * correct when the root is reached through a symlink, as /tmp is on macOS:
   * the probed paths are resolved and the configured root is not.
   */
  pruneScope(scope: string, seen: Set<string>): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.scope !== scope || seen.has(key)) continue
      this.entries.delete(key)
      this.dirty = true
    }
  }

  keys(): string[] {
    return [...this.entries.keys()]
  }

  get size(): number {
    return this.entries.size
  }

  async persist(): Promise<void> {
    if (!this.filePath || !this.dirty) return
    this.dirty = false
    const target = this.filePath
    const write = this.writing.then(async () => {
      try {
        ensureSafeDataDirectory(path.dirname(target), fileLabel)
        await writeAtomicSafeUtf8File(target, serializeProbeCache(this.entries), fileLabel)
      } catch (error) {
        // A cache that cannot be written only costs the next launch a full
        // rescan, so the session list must not fail because of it.
        this.onWarning({
          code: 'probe-cache-write-failed',
          message: '会话探测缓存写入失败，下次启动会重新读取会话文件',
          detail: errorText(error),
        })
      }
    })
    this.writing = write
    return write
  }

  private async load(): Promise<void> {
    if (!this.filePath) return
    let content: string | null = null
    try {
      content = await readSafeUtf8File(this.filePath, fileLabel, maximumReadBytes)
    } catch (error) {
      this.onWarning({
        code: 'probe-cache-read-failed',
        message: '会话探测缓存读取失败，本次启动会重新读取会话文件',
        detail: errorText(error),
      })
      return
    }
    if (content === null) return
    const parsed = parseProbeCacheDocument(content, this.maxEntries)
    if (!parsed) {
      // Corrupt or written by another version: rebuild silently, and mark the
      // cache dirty so the next probe run replaces the file.
      this.dirty = true
      this.onWarning({
        code: 'probe-cache-discarded',
        message: '会话探测缓存格式不可用，已重新建立',
      })
      return
    }
    for (const [key, entry] of parsed) {
      if (this.entries.has(key)) continue
      this.entries.set(key, entry)
    }
  }
}
