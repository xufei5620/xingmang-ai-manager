import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redactCommandText } from './command-runner'
import { drainStartupFailures, redactHomeDirectory, STARTUP_LOG_FILE_NAME } from './startup-log'
import {
  appendSafeUtf8File,
  assertSafeDataFile,
  ensureSafeDataDirectory,
  readSafeUtf8File,
  removeSafeDataFile,
} from './safe-local-data'

export type RuntimeLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface RuntimeLogEntry {
  id: string
  timestamp: string
  level: RuntimeLogLevel
  source: string
  event: string
  message: string
  detail: Record<string, unknown> | null
}

export interface RuntimeLogSnapshot {
  generatedAt: string
  directory: string
  filePath: string
  sizeBytes: number
  total: number
  truncated: boolean
  counts: Record<RuntimeLogLevel, number>
  sources: string[]
  // The log file survives restarts, so the feedback page cannot tell this run's
  // entries from the previous one's without knowing which process wrote them.
  // Entry ids carry the writing pid; a pid the OS has since reused is ruled out
  // by also requiring the entry to be no older than this run.
  currentProcessId: number
  startedAt: string
  entries: RuntimeLogEntry[]
}

export interface RuntimeLogStoreOptions {
  directory: string
  appName: string
  appVersion: string
  packaged: boolean
  maxFileBytes?: number
  archiveCount?: number
  now?: () => Date
  /** 反馈报告头部那段「工具与配置」的读取预算，缺省 2 秒（测试用）。 */
  environmentTimeoutMs?: number
}

/**
 * 反馈报告头部要带的「工具与配置」几行。由 main.ts 在服务起来之后接上，
 * 本模块不认识 CLI 也不认识配置文件，只负责限时取用与脱敏。
 */
export type RuntimeEnvironmentDescriber = () => Promise<readonly string[]>

/**
 * 「最近一次自检」那几行，同样由 main.ts 接上。读的是主进程内存里已有的上一份
 * 结果，本模块不认识诊断项，也不会因为要生成报告而触发一次新的自检。
 */
export type RuntimeSelfCheckDescriber = () => Promise<readonly string[]>

const ENVIRONMENT_TIMEOUT_MS = 2_000
const ENVIRONMENT_UNREADABLE = '未能读取'
const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|token|secret|password|credential|cookie)/i
const MAX_TEXT_LENGTH = 8_192
const MAX_DETAIL_DEPTH = 5
const MAX_DETAIL_ITEMS = 128
const MAX_LINE_BYTES = 256 * 1024
const MAX_SNAPSHOT_LIMIT = 2_000

// Lives in startup-log because that module must redact without importing
// anything that could itself be the failure it is recording. Re-exported here
// so existing callers keep their import path.
export { redactHomeDirectory }

function safeText(value: string): string {
  return redactCommandText(value).slice(0, MAX_TEXT_LENGTH)
}

function sanitizeValue(value: unknown, depth = 0, key = ''): unknown {
  if (SENSITIVE_KEY.test(key)) return '[REDACTED]'
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return value ?? null
  }
  if (typeof value === 'string') return safeText(value)
  if (typeof value === 'bigint') return value.toString()
  if (depth >= MAX_DETAIL_DEPTH) return '[TRUNCATED]'
  if (value instanceof Error) {
    const metadata = Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_DETAIL_ITEMS)
        .map(([name, entry]) => [name, sanitizeValue(entry, depth + 1, name)]),
    )
    return {
      ...metadata,
      name: safeText(value.name),
      message: safeText(value.message),
      stack: value.stack ? safeText(value.stack) : null,
    }
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_DETAIL_ITEMS).map((entry) => sanitizeValue(entry, depth + 1))
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_DETAIL_ITEMS)
        .map(([name, entry]) => [name, sanitizeValue(entry, depth + 1, name)]),
    )
  }
  return safeText(String(value))
}

function sanitizeDetail(detail: unknown): Record<string, unknown> | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  return sanitizeValue(detail) as Record<string, unknown>
}

function emptyCounts(): Record<RuntimeLogLevel, number> {
  return { debug: 0, info: 0, warn: 0, error: 0 }
}

function validEntry(value: unknown): value is RuntimeLogEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const entry = value as Partial<RuntimeLogEntry>
  return typeof entry.id === 'string'
    && typeof entry.timestamp === 'string'
    && ['debug', 'info', 'warn', 'error'].includes(entry.level ?? '')
    && typeof entry.source === 'string'
    && typeof entry.event === 'string'
    && typeof entry.message === 'string'
    && (entry.detail === null || (typeof entry.detail === 'object' && !Array.isArray(entry.detail)))
}

/**
 * 单个日志文件解析后的样子。归档文件轮转完就不会再变，所以这份摘要可以按
 * 「大小 + 修改时间 + inode」缓存起来复用，反馈页第二次打开就不必再读一遍。
 * 只留尾部若干条：snapshot 最多回 MAX_SNAPSHOT_LIMIT 条，更早的永远进不了结果，
 * 留着只会让主进程白白多占一份内存。
 */
export interface RuntimeLogFileSummary {
  entries: RuntimeLogEntry[]
  total: number
  counts: Record<RuntimeLogLevel, number>
  sources: string[]
  sizeBytes: number
}

function emptySummary(): RuntimeLogFileSummary {
  return { entries: [], total: 0, counts: emptyCounts(), sources: [], sizeBytes: 0 }
}

function normalizeEntry(value: RuntimeLogEntry): RuntimeLogEntry {
  return {
    level: value.level,
    id: safeText(value.id),
    timestamp: safeText(value.timestamp),
    source: safeText(value.source).slice(0, 80),
    event: safeText(value.event).slice(0, 120),
    message: safeText(value.message),
    detail: sanitizeDetail(value.detail),
  }
}

/**
 * 逐行解析一个日志文件。计数与来源要全量统计，但只有尾部那些条目会被展示，
 * 所以先按原样滚动留一小段，最后才对这一段做脱敏——8 MB 日志里绝大多数条目
 * 的 sanitizeDetail 就此省掉了。
 */
export function summarizeRuntimeLogFile(content: string): RuntimeLogFileSummary {
  const counts = emptyCounts()
  const sources = new Set<string>()
  const recent: RuntimeLogEntry[] = []
  let total = 0
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch {
      // A partial final line must not make the rest of the log unreadable.
      continue
    }
    if (!validEntry(value)) continue
    total += 1
    counts[value.level] += 1
    sources.add(safeText(value.source).slice(0, 80))
    recent.push(value)
    if (recent.length >= MAX_SNAPSHOT_LIMIT * 2) recent.splice(0, recent.length - MAX_SNAPSHOT_LIMIT)
  }
  return {
    entries: recent.slice(-MAX_SNAPSHOT_LIMIT).map(normalizeEntry),
    total,
    counts,
    sources: [...sources],
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  }
}

function mergeSummaries(parts: readonly RuntimeLogFileSummary[]): RuntimeLogFileSummary {
  const merged = emptySummary()
  const sources = new Set<string>()
  const entries: RuntimeLogEntry[] = []
  for (const part of parts) {
    entries.push(...part.entries)
    merged.total += part.total
    merged.sizeBytes += part.sizeBytes
    for (const level of Object.keys(merged.counts) as RuntimeLogLevel[]) {
      merged.counts[level] += part.counts[level]
    }
    for (const source of part.sources) sources.add(source)
  }
  merged.entries = entries.slice(-MAX_SNAPSHOT_LIMIT)
  merged.sources = [...sources]
  return merged
}

/**
 * 缓存键。大小与修改时间挡住「同一个文件被追加了」，inode 再挡住「轮转后换成了
 * 另一个恰好同样大小、同样时间的文件」——重命名会把 mtime 一起带过去。
 */
async function fingerprintLogFile(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.promises.lstat(filePath)
    return `${stats.size}:${stats.mtimeMs}:${stats.ino}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function removeIfPresent(filePath: string): Promise<void> {
  await removeSafeDataFile(filePath, '运行日志文件')
}

async function renameIfPresent(source: string, destination: string): Promise<void> {
  if (!assertSafeDataFile(source, '运行日志文件')) return
  await removeIfPresent(destination)
  await fs.promises.rename(source, destination)
}

export class RuntimeLogStore {
  readonly directory: string
  readonly filePath: string
  readonly startedAt: string
  private readonly appName: string
  private readonly appVersion: string
  private readonly packaged: boolean
  private readonly maxFileBytes: number
  private readonly archiveCount: number
  private readonly now: () => Date
  private readonly environmentTimeoutMs: number
  private describeEnvironment: RuntimeEnvironmentDescriber | null = null
  private describeSelfCheck: RuntimeSelfCheckDescriber | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  // 每个日志文件一份解析结果，键是文件路径，所以最多 archiveCount + 1 份，天然有界。
  private readonly parsedFiles = new Map<string, { fingerprint: string; summary: RuntimeLogFileSummary }>()
  private sequence = 0

  constructor(options: RuntimeLogStoreOptions) {
    this.directory = path.resolve(options.directory)
    this.filePath = path.join(this.directory, 'runtime.jsonl')
    this.appName = options.appName
    this.appVersion = options.appVersion
    this.packaged = options.packaged
    this.maxFileBytes = options.maxFileBytes ?? 2 * 1024 * 1024
    this.archiveCount = options.archiveCount ?? 3
    this.now = options.now ?? (() => new Date())
    this.environmentTimeoutMs = options.environmentTimeoutMs ?? ENVIRONMENT_TIMEOUT_MS
    this.startedAt = this.now().toISOString()
    this.adoptStartupFailures()
  }

  /**
   * 接上「工具与配置」那段的读取。报告随时可能被生成，而这段数据要等系统服务
   * 起来才有，所以不放构造参数里。
   */
  attachEnvironmentDescriber(describe: RuntimeEnvironmentDescriber): void {
    this.describeEnvironment = describe
  }

  /** 同上，接上「最近一次自检」那段。 */
  attachSelfCheckDescriber(describe: RuntimeSelfCheckDescriber): void {
    this.describeSelfCheck = describe
  }

  /**
   * Folds any pre-startup crash records into the runtime log. A failure early
   * enough to miss this store still lands on disk, and once the app does start
   * it has to reach the feedback page and the diagnostics export — both of
   * which read the runtime log and nothing else.
   */
  private adoptStartupFailures(): void {
    const filePath = path.join(this.directory, STARTUP_LOG_FILE_NAME)
    const recorded = drainStartupFailures(filePath)
    if (!recorded) return
    this.log('error', 'main', 'startup.failure.recovered', '上次启动失败，已找回早期日志', {
      source: filePath,
      records: recorded.split(/\n{2,}/).filter((record) => record.trim()),
    })
  }

  log(
    level: RuntimeLogLevel,
    source: string,
    event: string,
    message: string,
    detail?: unknown,
  ): void {
    const timestamp = this.now().toISOString()
    const entry: RuntimeLogEntry = {
      id: `${timestamp}:${process.pid}:${this.sequence += 1}`,
      timestamp,
      level,
      source: safeText(source).slice(0, 80),
      event: safeText(event).slice(0, 120),
      message: safeText(message),
      detail: sanitizeDetail(detail),
    }
    let line = `${JSON.stringify(entry)}\n`
    if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
      // A single oversized entry would instantly rotate the whole file away.
      line = `${JSON.stringify({ ...entry, detail: { truncated: '[TRUNCATED: detail too large]' } })}\n`
    }
    this.writeQueue = this.writeQueue
      .then(() => this.append(line))
      .catch(() => undefined)
  }

  exception(source: string, event: string, error: unknown, detail?: Record<string, unknown>): void {
    const message = error instanceof Error ? error.message : String(error)
    this.log('error', source, event, message || '未知错误', {
      ...detail,
      error,
    })
  }

  private archivePath(index: number): string {
    return `${this.filePath}.${index}`
  }

  private async append(line: string): Promise<void> {
    ensureSafeDataDirectory(this.directory, '运行日志目录')
    const lineBytes = Buffer.byteLength(line, 'utf8')
    let currentBytes = 0
    if (assertSafeDataFile(this.filePath, '运行日志文件')) {
      currentBytes = (await fs.promises.stat(this.filePath)).size
    }
    if (currentBytes > 0 && currentBytes + lineBytes > this.maxFileBytes) {
      // 轮转后每个路径指向的都是另一个文件，指纹本来也会失配；这里顺手清掉，
      // 免得被挤掉的那一份归档白占内存。
      this.parsedFiles.clear()
      if (this.archiveCount > 0) {
        await removeIfPresent(this.archivePath(this.archiveCount))
        for (let index = this.archiveCount - 1; index >= 1; index -= 1) {
          await renameIfPresent(this.archivePath(index), this.archivePath(index + 1))
        }
        await renameIfPresent(this.filePath, this.archivePath(1))
      } else {
        await removeIfPresent(this.filePath)
      }
    }
    await appendSafeUtf8File(this.filePath, line, '运行日志文件')
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    // Reads and clears share the write queue so an in-flight append can never
    // rotate or truncate a file while it is being read.
    const result = this.writeQueue.then(task)
    this.writeQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private readSummary(): Promise<RuntimeLogFileSummary> {
    return this.runExclusive(async () => {
      const parts: RuntimeLogFileSummary[] = []
      const files = [
        ...Array.from({ length: this.archiveCount }, (_, index) => this.archivePath(this.archiveCount - index)),
        this.filePath,
      ]
      for (const filePath of files) {
        try {
          const fingerprint = await fingerprintLogFile(filePath)
          if (fingerprint === null) {
            this.parsedFiles.delete(filePath)
            continue
          }
          const cached = this.parsedFiles.get(filePath)
          if (cached && cached.fingerprint === fingerprint) {
            parts.push(cached.summary)
            continue
          }
          const content = await readSafeUtf8File(
            filePath,
            '运行日志文件',
            this.maxFileBytes + MAX_TEXT_LENGTH * 4,
          )
          if (content === null) {
            this.parsedFiles.delete(filePath)
            continue
          }
          const summary = summarizeRuntimeLogFile(content)
          // 读完再对一次指纹：只有确实没变过的那一份才值得留下来复用。
          if (await fingerprintLogFile(filePath) === fingerprint) {
            this.parsedFiles.set(filePath, { fingerprint, summary })
          } else {
            this.parsedFiles.delete(filePath)
          }
          parts.push(summary)
        } catch (error) {
          this.parsedFiles.delete(filePath)
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          // One unreadable file must not take down the whole log page.
          const timestamp = this.now().toISOString()
          const entry: RuntimeLogEntry = {
            id: `${timestamp}:${process.pid}:${this.sequence += 1}`,
            timestamp,
            level: 'warn',
            source: 'runtime-log',
            event: 'read-failed',
            message: safeText(`无法读取日志文件 ${path.basename(filePath)}：${
              error instanceof Error ? error.message : String(error)
            }`),
            detail: null,
          }
          parts.push({
            entries: [entry],
            total: 1,
            counts: { ...emptyCounts(), warn: 1 },
            sources: [entry.source],
            sizeBytes: 0,
          })
        }
      }
      return mergeSummaries(parts)
    })
  }

  async snapshot(limit = 1_000): Promise<RuntimeLogSnapshot> {
    const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), MAX_SNAPSHOT_LIMIT) : 1_000
    const summary = await this.readSummary()
    const selected = summary.entries.slice(-safeLimit).reverse()
    return {
      generatedAt: this.now().toISOString(),
      directory: this.directory,
      filePath: this.filePath,
      sizeBytes: summary.sizeBytes,
      total: summary.total,
      truncated: summary.total > selected.length,
      counts: summary.counts,
      sources: [...summary.sources].sort((left, right) => left.localeCompare(right)),
      currentProcessId: process.pid,
      startedAt: this.startedAt,
      entries: selected,
    }
  }

  clear(): Promise<void> {
    return this.runExclusive(async () => {
      this.parsedFiles.clear()
      await Promise.all([
        removeIfPresent(this.filePath),
        ...Array.from({ length: this.archiveCount }, (_, index) => removeIfPresent(this.archivePath(index + 1))),
      ])
    })
  }

  async captureFeedbackReport(limit = 600): Promise<{ text: string; entries: number }> {
    const snapshot = await this.snapshot(limit)
    const home = os.homedir()
    const scrubHome = (value: string) => redactHomeDirectory(value, home)
    const lines = [
      `${this.appName} 反馈与诊断`,
      `生成时间: ${snapshot.generatedAt}`,
      `应用版本: ${this.appVersion}`,
      `运行模式: ${this.packaged ? 'packaged' : 'development'}`,
      `系统: ${process.platform} ${os.release()} ${process.arch}`,
      `Electron: ${process.versions.electron ?? 'unknown'}`,
      `Node.js: ${process.versions.node}`,
      `日志条数: ${snapshot.total}${snapshot.truncated ? `（附最近 ${snapshot.entries.length} 条）` : ''}`,
      `日志目录: ${scrubHome(snapshot.directory)}`,
    ]
    const environment = await this.describeSectionLines(this.describeEnvironment)
    if (environment.length) lines.push('', '工具与配置:', ...environment.map(scrubHome))
    const selfCheck = await this.describeSectionLines(this.describeSelfCheck)
    if (selfCheck.length) lines.push('', '最近一次自检:', ...selfCheck.map(scrubHome))
    lines.push('', '运行日志:')
    for (const entry of [...snapshot.entries].reverse()) {
      const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : ''
      lines.push(scrubHome(
        `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}/${entry.event}] ${entry.message}${detail}`,
      ))
    }
    return { text: `${lines.join('\n')}\n`, entries: snapshot.total }
  }

  /**
   * 取不到就算了：反馈报告本身（尤其是运行日志）比这几行重要得多，所以给一个
   * 总预算，超时或抛错都退回一行说明，报告照常生成。每段各自计时，一段超时不
   * 影响另一段。
   */
  private async describeSectionLines(describe: RuntimeEnvironmentDescriber | null): Promise<string[]> {
    if (!describe) return []
    let timer: NodeJS.Timeout | undefined
    try {
      const timedOut = Symbol('timeout')
      const lines = await Promise.race([
        Promise.resolve().then(describe),
        new Promise<typeof timedOut>((resolve) => {
          timer = setTimeout(() => resolve(timedOut), this.environmentTimeoutMs)
        }),
      ])
      if (lines === timedOut) return [`${ENVIRONMENT_UNREADABLE}（读取超时）`]
      return lines.map((line) => safeText(line)).filter((line) => line.length > 0)
    } catch {
      return [ENVIRONMENT_UNREADABLE]
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async feedbackReport(limit = 600): Promise<string> {
    return (await this.captureFeedbackReport(limit)).text
  }
}
