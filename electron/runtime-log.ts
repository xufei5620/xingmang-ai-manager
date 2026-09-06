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
}

const SENSITIVE_KEY = /(?:api[_-]?key|authorization|bearer|token|secret|password|credential|cookie)/i
const MAX_TEXT_LENGTH = 8_192
const MAX_DETAIL_DEPTH = 5
const MAX_DETAIL_ITEMS = 128
const MAX_LINE_BYTES = 256 * 1024

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
  private readonly appName: string
  private readonly appVersion: string
  private readonly packaged: boolean
  private readonly maxFileBytes: number
  private readonly archiveCount: number
  private readonly now: () => Date
  private writeQueue: Promise<void> = Promise.resolve()
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
    this.adoptStartupFailures()
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

  private readEntries(): Promise<{ entries: RuntimeLogEntry[]; sizeBytes: number }> {
    return this.runExclusive(async () => {
      const entries: RuntimeLogEntry[] = []
      let sizeBytes = 0
      const files = [
        ...Array.from({ length: this.archiveCount }, (_, index) => this.archivePath(this.archiveCount - index)),
        this.filePath,
      ]
      for (const filePath of files) {
        try {
          const content = await readSafeUtf8File(
            filePath,
            '运行日志文件',
            this.maxFileBytes + MAX_TEXT_LENGTH * 4,
          )
          if (content === null) continue
          sizeBytes += Buffer.byteLength(content, 'utf8')
          for (const line of content.split(/\r?\n/)) {
            if (!line.trim()) continue
            try {
              const value = JSON.parse(line) as unknown
              if (validEntry(value)) entries.push({
                level: value.level,
                id: safeText(value.id),
                timestamp: safeText(value.timestamp),
                source: safeText(value.source).slice(0, 80),
                event: safeText(value.event).slice(0, 120),
                message: safeText(value.message),
                detail: sanitizeDetail(value.detail),
              })
            } catch {
              // A partial final line must not make the rest of the log unreadable.
            }
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          // One unreadable file must not take down the whole log page.
          const timestamp = this.now().toISOString()
          entries.push({
            id: `${timestamp}:${process.pid}:${this.sequence += 1}`,
            timestamp,
            level: 'warn',
            source: 'runtime-log',
            event: 'read-failed',
            message: safeText(`无法读取日志文件 ${path.basename(filePath)}：${
              error instanceof Error ? error.message : String(error)
            }`),
            detail: null,
          })
        }
      }
      return { entries, sizeBytes }
    })
  }

  async snapshot(limit = 1_000): Promise<RuntimeLogSnapshot> {
    const safeLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 2_000) : 1_000
    const { entries, sizeBytes } = await this.readEntries()
    const counts = emptyCounts()
    const sources = new Set<string>()
    for (const entry of entries) {
      counts[entry.level] += 1
      sources.add(entry.source)
    }
    const selected = entries.slice(-safeLimit).reverse()
    return {
      generatedAt: this.now().toISOString(),
      directory: this.directory,
      filePath: this.filePath,
      sizeBytes,
      total: entries.length,
      truncated: entries.length > selected.length,
      counts,
      sources: [...sources].sort((left, right) => left.localeCompare(right)),
      entries: selected,
    }
  }

  clear(): Promise<void> {
    return this.runExclusive(async () => {
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
      '',
      '运行日志:',
    ]
    for (const entry of [...snapshot.entries].reverse()) {
      const detail = entry.detail ? ` ${JSON.stringify(entry.detail)}` : ''
      lines.push(scrubHome(
        `[${entry.timestamp}] [${entry.level.toUpperCase()}] [${entry.source}/${entry.event}] ${entry.message}${detail}`,
      ))
    }
    return { text: `${lines.join('\n')}\n`, entries: snapshot.total }
  }

  async feedbackReport(limit = 600): Promise<string> {
    return (await this.captureFeedbackReport(limit)).text
  }
}
