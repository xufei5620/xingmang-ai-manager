import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CodexSessionsService,
  type CodexSessionDetail,
  type CodexSessionPage,
  type CodexSessionsCapabilities,
} from './codex-sessions'
import { DirectoryEntryLimitError, readDirectoryEntries } from './bounded-directory'

export const providerSessionProviders = ['codex', 'claude', 'gemini', 'grok'] as const

export type ProviderSessionProvider = (typeof providerSessionProviders)[number]

export interface ProviderSessionCapability {
  provider: ProviderSessionProvider
  available: boolean
  readable: boolean
  readonly: boolean
  source: 'sqlite-jsonl' | 'jsonl' | 'json-jsonl'
  reason: string
  operations: {
    list: boolean
    detail: boolean
    exportMarkdown: boolean
    archive: boolean
    restore: boolean
  }
}

export interface ProviderSessionSummary {
  id: string
  provider: ProviderSessionProvider
  nativeId: string
  title: string
  cwd: string
  model: string
  archived: boolean
  readonly: boolean
  createdAt: number | null
  updatedAt: number | null
  messageCount: number | null
  sourcePath: string
  detailAvailable: boolean
}

export interface ProviderSessionMessage {
  role: string
  text: string
  timestamp: string | null
}

export interface ProviderSessionMessageStats {
  total: number
  user: number
  assistant: number
  system: number
  other: number
  invalidLines: number
}

export interface ProviderSessionDetail {
  session: ProviderSessionSummary
  messages: ProviderSessionMessage[]
  messageStats: ProviderSessionMessageStats
  messagesTruncated: boolean
  sourceTruncated: boolean
}

export interface ProviderSessionListQuery {
  provider?: ProviderSessionProvider | 'all'
  search?: string
  page?: number
  pageSize?: number
}

export interface ProviderSessionPage {
  items: ProviderSessionSummary[]
  total: number
  page: number
  pageSize: number
  pages: number
  stats: {
    total: number
    byProvider: Record<ProviderSessionProvider, number>
  }
  capabilities: Record<ProviderSessionProvider, ProviderSessionCapability>
}

export interface ProviderSessionExportResult {
  id: string
  provider: ProviderSessionProvider
  outputPath: string
  messages: number
  truncated: boolean
}

export interface CodexSessionReader {
  capabilities(): CodexSessionsCapabilities
  list(query?: { archive?: 'all' | 'active' | 'archived'; page?: number; pageSize?: number }): CodexSessionPage
  detail(sessionId: string): Promise<CodexSessionDetail>
  exportMarkdown(sessionId: string, destinationPath: string): Promise<{
    sessionId: string
    outputPath: string
    messages: number
  }>
}

export interface ProviderSessionsOptions {
  codexService?: CodexSessionReader
  codexHome?: string
  claudeProjectsRoot?: string
  geminiTmpRoot?: string
  grokSessionsRoot?: string
  listProbeBytes?: number
  maxTranscriptBytes?: number
  maxJsonLineBytes?: number
  maxFilesPerProvider?: number
}

interface ProviderRoots {
  claude: string
  gemini: string
  grok: string
}

interface SourceCandidate {
  provider: Exclude<ProviderSessionProvider, 'codex'>
  keyPath: string
  sourcePath: string
  summaryPath?: string
}

interface DiscoveryResult {
  files: string[]
  skipped: number
  errors: number
}

interface JsonLineScanResult {
  invalidLines: number
  sourceTruncated: boolean
}

interface MessageReadResult {
  messages: ProviderSessionMessage[]
  stats: ProviderSessionMessageStats
  sourceTruncated: boolean
  retainedTextTruncated: boolean
}

interface ProbeState {
  nativeId: string
  title: string
  cwd: string
  model: string
  createdAt: number | null
  updatedAt: number | null
  messageCount: number | null
  firstUserText: string
}

interface ProbeCacheEntry {
  fingerprint: string
  state: ProbeState
}

type MessageConsumer = (message: ProviderSessionMessage) => void | Promise<void>

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const DEFAULT_LIST_PROBE_BYTES = 512 * 1024
const DEFAULT_MAX_TRANSCRIPT_BYTES = 128 * 1024 * 1024
const DEFAULT_MAX_JSON_LINE_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_FILES = 50_000
const MAX_DISCOVERY_ENTRIES = 500_000
const DETAIL_MESSAGE_LIMIT = 250
const MESSAGE_TEXT_LIMIT = 24_000
const MAX_PROBE_CACHE_ENTRIES = 10_000

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1) return fallback
  return Math.min(value as number, maximum)
}

function normalizePath(filePath: string): string {
  let normalized = filePath
  if (process.platform === 'win32') {
    if (/^\\\\\?\\UNC\\/i.test(normalized)) normalized = `\\\\${normalized.slice(8)}`
    else if (/^\\\\\?\\/i.test(normalized)) normalized = normalized.slice(4)
  }
  const resolved = path.resolve(normalized)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(normalizePath(parentPath), normalizePath(childPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function stableSessionId(provider: Exclude<ProviderSessionProvider, 'codex'>, root: string, keyPath: string): string {
  let relative = path.relative(root, keyPath).split(path.sep).join('/')
  if (process.platform === 'win32') relative = relative.toLowerCase()
  return `${provider}:${createHash('sha256').update(relative).digest('hex')}`
}

function cleanText(value: string, maximum = 160): string {
  const cleaned = value.replace(/\s+/g, ' ').trim()
  return cleaned.length > maximum ? `${cleaned.slice(0, maximum)}…` : cleaned
}

function messageText(value: unknown, depth = 0): string {
  if (depth > 4) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((item) => messageText(item, depth + 1)).filter(Boolean).join('\n')
  }
  const record = asRecord(value)
  if (!record) return ''
  if (typeof record.text === 'string') return record.text
  if (typeof record.input_text === 'string') return record.input_text
  if (typeof record.output_text === 'string') return record.output_text
  if (record.type === 'tool_use' || record.type === 'tool_result' || record.type === 'thinking') return ''
  if ('content' in record) return messageText(record.content, depth + 1)
  return ''
}

function timestampMilliseconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isoTimestamp(value: unknown): string | null {
  const milliseconds = timestampMilliseconds(value)
  return milliseconds === null ? null : new Date(milliseconds).toISOString()
}

function truncateMessageText(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MESSAGE_TEXT_LIMIT ? `${trimmed.slice(0, MESSAGE_TEXT_LIMIT)}\n…` : trimmed
}

function emptyMessageStats(): ProviderSessionMessageStats {
  return { total: 0, user: 0, assistant: 0, system: 0, other: 0, invalidLines: 0 }
}

function recordMessage(stats: ProviderSessionMessageStats, message: ProviderSessionMessage): void {
  stats.total += 1
  if (message.role === 'user') stats.user += 1
  else if (message.role === 'assistant') stats.assistant += 1
  else if (message.role === 'system' || message.role === 'developer') stats.system += 1
  else stats.other += 1
}

function normalizeRole(role: string, provider: ProviderSessionProvider): string {
  const normalized = role.toLowerCase()
  if (normalized === 'user' || normalized === 'human') return 'user'
  if (normalized === 'assistant' || normalized === 'gemini' || normalized === 'claude' || normalized === 'grok') {
    return 'assistant'
  }
  if (normalized === 'system' || normalized === 'developer' || normalized === 'info' || normalized === 'error') {
    return normalized === 'developer' ? 'developer' : 'system'
  }
  return normalized || provider
}

function statTimestamp(stat: fs.Stats, kind: 'created' | 'updated'): number | null {
  const value = kind === 'created' ? stat.birthtimeMs : stat.mtimeMs
  return Number.isFinite(value) && value > 0 ? value : null
}

async function existingDirectory(root: string): Promise<boolean> {
  try {
    const info = await fsPromises.lstat(root)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function existingDirectorySync(root: string): boolean {
  try {
    const info = fs.lstatSync(root)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

async function safeRegularFileStat(filePath: string): Promise<fs.Stats> {
  const info = await fsPromises.lstat(filePath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new Error('会话源不是单链接普通文件')
  }
  return info
}

interface OpenedSafeRegularFile {
  handle: fs.promises.FileHandle
  stat: fs.Stats
}

async function openSafeRegularFile(filePath: string): Promise<OpenedSafeRegularFile> {
  const handle = await fsPromises.open(filePath, 'r')
  try {
    const [handleInfo, pathInfo, realPath] = await Promise.all([
      handle.stat(),
      fsPromises.lstat(filePath),
      fsPromises.realpath(filePath),
    ])
    if (
      !handleInfo.isFile()
      || !pathInfo.isFile()
      || pathInfo.isSymbolicLink()
      || handleInfo.nlink > 1
      || pathInfo.nlink > 1
    ) {
      throw new Error('会话源不是单链接普通文件')
    }
    if (handleInfo.dev !== pathInfo.dev || handleInfo.ino !== pathInfo.ino) {
      throw new Error('会话源在打开期间发生变化')
    }
    if (normalizePath(realPath) !== normalizePath(filePath)) {
      throw new Error('会话源经过了符号链接或目录联接')
    }
    return { handle, stat: handleInfo }
  } catch (error) {
    await handle.close().catch(() => undefined)
    throw error
  }
}

async function readOpenedUtf8File(
  opened: OpenedSafeRegularFile,
  byteLimit: number,
): Promise<string> {
  if (opened.stat.size > byteLimit) throw new Error('会话 JSON 文件超过安全读取上限')
  const buffer = Buffer.allocUnsafe(opened.stat.size)
  let offset = 0
  while (offset < buffer.length) {
    const { bytesRead } = await opened.handle.read(buffer, offset, buffer.length - offset, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  const after = await opened.handle.stat()
  if (after.size !== opened.stat.size) throw new Error('会话 JSON 文件在读取过程中发生变化')
  return buffer.subarray(0, offset).toString('utf8')
}

async function discoverFiles(
  root: string,
  accept: (filePath: string) => boolean,
  maximum: number,
): Promise<DiscoveryResult> {
  if (!await existingDirectory(root)) return { files: [], skipped: 0, errors: 0 }
  const realRoot = await fsPromises.realpath(root)
  const rootInfo = await fsPromises.lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return { files: [], skipped: 0, errors: 1 }
  }
  const pending = [realRoot]
  const visitedDirectories = new Set([normalizePath(realRoot)])
  const files: string[] = []
  const maximumEntries = Math.min(Math.max(maximum * 4, 10_000), MAX_DISCOVERY_ENTRIES)
  let inspectedEntries = 0
  let skipped = 0
  let errors = 0
  while (pending.length > 0) {
    const directory = pending.pop() as string
    let entries: fs.Dirent[]
    try {
      const remaining = maximumEntries - inspectedEntries
      if (remaining < 1) throw new DirectoryEntryLimitError('会话目录', maximumEntries)
      entries = await readDirectoryEntries(directory, remaining, '会话目录')
      inspectedEntries += entries.length
    } catch (error) {
      if (error instanceof DirectoryEntryLimitError) throw error
      errors += 1
      continue
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        skipped += 1
        continue
      }
      if (entry.isDirectory()) {
        try {
          const realDirectory = await fsPromises.realpath(candidate)
          if (!isInside(realRoot, realDirectory)) {
            skipped += 1
            continue
          }
          const key = normalizePath(realDirectory)
          if (visitedDirectories.has(key)) {
            skipped += 1
            continue
          }
          visitedDirectories.add(key)
          pending.push(realDirectory)
        } catch {
          errors += 1
        }
        continue
      }
      if (!entry.isFile() || !accept(candidate)) continue
      let realPath: string
      try {
        realPath = await fsPromises.realpath(candidate)
      } catch {
        errors += 1
        continue
      }
      const fileInfo = await fsPromises.lstat(candidate).catch(() => null)
      if (!fileInfo?.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink > 1) {
        skipped += 1
        continue
      }
      if (!isInside(realRoot, realPath)) {
        skipped += 1
        continue
      }
      files.push(realPath)
      if (files.length > maximum) throw new Error(`会话文件超过安全上限 ${maximum}`)
    }
  }
  files.sort((left, right) => left.localeCompare(right))
  return { files, skipped, errors }
}

async function scanJsonLines(
  filePath: string,
  byteLimit: number,
  lineLimit: number,
  onValue: (value: unknown) => void | Promise<void>,
): Promise<JsonLineScanResult> {
  const opened = await openSafeRegularFile(filePath)
  try {
    const sourceTruncated = opened.stat.size > byteLimit
    const end = Math.min(opened.stat.size, byteLimit) - 1
    if (end < 0) return { invalidLines: 0, sourceTruncated: false }
    const stream = opened.handle.createReadStream({
      encoding: 'utf8',
      start: 0,
      end,
      highWaterMark: 64 * 1024,
      autoClose: false,
    })
    let pending = ''
    let dropping = false
    let oversizedLine = false
    let invalidLines = 0

    const consumeLine = async (line: string): Promise<void> => {
      const trimmed = line.replace(/\r$/, '').trim()
      if (!trimmed) return
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed) as unknown
      } catch {
        invalidLines += 1
        return
      }
      await onValue(parsed)
    }

    for await (const rawChunk of stream) {
      const chunk = rawChunk as string
      let start = 0
      for (let index = 0; index < chunk.length; index += 1) {
        if (chunk.charCodeAt(index) !== 10) continue
        const segment = chunk.slice(start, index)
        start = index + 1
        if (dropping) {
          dropping = false
          continue
        }
        if (Buffer.byteLength(pending + segment, 'utf8') > lineLimit) {
          pending = ''
          oversizedLine = true
          invalidLines += 1
          continue
        }
        await consumeLine(pending + segment)
        pending = ''
      }
      const remainder = chunk.slice(start)
      if (dropping) continue
      if (Buffer.byteLength(pending + remainder, 'utf8') > lineLimit) {
        pending = ''
        dropping = true
        oversizedLine = true
        invalidLines += 1
      } else {
        pending += remainder
      }
    }
    if (!sourceTruncated && !dropping && pending) await consumeLine(pending)
    const after = await opened.handle.stat()
    const changedDuringRead = after.size !== opened.stat.size || after.mtimeMs !== opened.stat.mtimeMs
    return { invalidLines, sourceTruncated: sourceTruncated || oversizedLine || changedDuringRead }
  } finally {
    await opened.handle.close()
  }
}

async function readJsonBounded(filePath: string, byteLimit: number): Promise<{
  value: unknown | null
  invalidLines: number
  sourceTruncated: boolean
}> {
  const opened = await openSafeRegularFile(filePath)
  try {
    if (opened.stat.size > byteLimit) return { value: null, invalidLines: 0, sourceTruncated: true }
    const content = await readOpenedUtf8File(opened, byteLimit)
    try {
      return { value: JSON.parse(content) as unknown, invalidLines: 0, sourceTruncated: false }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return { value: null, invalidLines: 1, sourceTruncated: false }
    }
  } finally {
    await opened.handle.close()
  }
}

function parseClaudeMessage(entry: Record<string, unknown>): ProviderSessionMessage | null {
  if (entry.type !== 'user' && entry.type !== 'assistant') return null
  const message = asRecord(entry.message)
  if (!message) return null
  const text = messageText(message.content).trim()
  if (!text) return null
  return {
    role: normalizeRole(asString(message.role) || asString(entry.type), 'claude'),
    text,
    timestamp: isoTimestamp(entry.timestamp),
  }
}

function applyClaudeProbe(state: ProbeState, value: unknown): ProviderSessionMessage | null {
  const entry = asRecord(value)
  if (!entry) return null
  state.nativeId ||= asString(entry.sessionId) || asString(entry.session_id)
  state.cwd ||= asString(entry.cwd)
  const timestamp = timestampMilliseconds(entry.timestamp)
  if (timestamp !== null) {
    state.createdAt = state.createdAt === null ? timestamp : Math.min(state.createdAt, timestamp)
    state.updatedAt = state.updatedAt === null ? timestamp : Math.max(state.updatedAt, timestamp)
  }
  if (entry.type === 'custom-title') state.title = cleanText(asString(entry.customTitle)) || state.title
  else if (entry.type === 'ai-title' && !state.title) state.title = cleanText(asString(entry.aiTitle))
  const message = parseClaudeMessage(entry)
  if (!message) return null
  const body = asRecord(entry.message)
  if (!state.model) state.model = asString(body?.model)
  if (message.role === 'user' && !state.firstUserText) state.firstUserText = cleanText(message.text)
  return message
}

function parseGeminiMessage(value: unknown): ProviderSessionMessage | null {
  const entry = asRecord(value)
  if (!entry) return null
  const type = asString(entry.type) || asString(entry.role)
  if (!type) return null
  const text = messageText(entry.content).trim()
  if (!text) return null
  return {
    role: normalizeRole(type, 'gemini'),
    text,
    timestamp: isoTimestamp(entry.timestamp),
  }
}

function applyGeminiDocument(
  state: ProbeState,
  value: unknown,
  seenMessageIds?: Set<string>,
): ProviderSessionMessage[] {
  const document = asRecord(value)
  if (!document) return []
  state.nativeId ||= asString(document.sessionId)
    || (Array.isArray(document.messages) ? asString(document.id) : '')
  state.createdAt = timestampMilliseconds(document.startTime) ?? state.createdAt
  state.updatedAt = timestampMilliseconds(document.lastUpdated) ?? state.updatedAt
  const mutation = asRecord(document.$set)
  if (mutation) state.updatedAt = timestampMilliseconds(mutation.lastUpdated) ?? state.updatedAt
  const payload = mutation ?? document
  const messages = Array.isArray(payload.messages) ? payload.messages : [payload]
  const parsed: ProviderSessionMessage[] = []
  for (const item of messages) {
    const message = parseGeminiMessage(item)
    if (!message) continue
    const record = asRecord(item)
    const messageId = asString(record?.id)
    if (seenMessageIds && messageId) {
      if (seenMessageIds.has(messageId)) continue
      seenMessageIds.add(messageId)
    }
    parsed.push(message)
    if (!state.model) state.model = asString(record?.model)
    if (message.role === 'user' && !state.firstUserText) state.firstUserText = cleanText(message.text)
  }
  if (!seenMessageIds && Array.isArray(payload.messages)) state.messageCount = parsed.length
  return parsed
}

function parseGrokMessage(value: unknown): ProviderSessionMessage | null {
  const entry = asRecord(value)
  if (!entry) return null
  const type = asString(entry.type) || asString(entry.role)
  if (type !== 'user' && type !== 'assistant' && type !== 'system') return null
  const text = messageText(entry.content).trim()
  if (!text) return null
  return {
    role: normalizeRole(type, 'grok'),
    text,
    timestamp: isoTimestamp(entry.timestamp),
  }
}

function applyGrokSummary(state: ProbeState, value: unknown): void {
  const summary = asRecord(value)
  if (!summary) return
  const info = asRecord(summary.info)
  state.nativeId ||= asString(info?.id) || asString(summary.id)
  state.cwd ||= asString(info?.cwd) || asString(summary.cwd)
  state.title ||= cleanText(asString(summary.generated_title) || asString(summary.session_summary))
  state.model ||= asString(summary.current_model_id)
  state.createdAt = timestampMilliseconds(summary.created_at) ?? state.createdAt
  state.updatedAt = timestampMilliseconds(summary.last_active_at)
    ?? timestampMilliseconds(summary.updated_at)
    ?? state.updatedAt
  state.messageCount = asNumber(summary.num_chat_messages) ?? asNumber(summary.num_messages) ?? state.messageCount
}

function newProbeState(stat: fs.Stats): ProbeState {
  return {
    nativeId: '',
    title: '',
    cwd: '',
    model: '',
    createdAt: statTimestamp(stat, 'created'),
    updatedAt: statTimestamp(stat, 'updated'),
    messageCount: null,
    firstUserText: '',
  }
}

function finalizeExternalSummary(
  candidate: SourceCandidate,
  root: string,
  state: ProbeState,
): ProviderSessionSummary {
  const fallbackId = path.basename(candidate.keyPath, path.extname(candidate.keyPath))
  const nativeId = state.nativeId || fallbackId
  return {
    id: stableSessionId(candidate.provider, root, candidate.keyPath),
    provider: candidate.provider,
    nativeId,
    title: state.title || state.firstUserText || nativeId,
    cwd: state.cwd,
    model: state.model,
    archived: false,
    readonly: true,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    messageCount: state.messageCount,
    sourcePath: candidate.sourcePath,
    detailAvailable: candidate.provider !== 'grok' || path.basename(candidate.sourcePath).toLowerCase() === 'chat_history.jsonl',
  }
}

function codexSummary(summary: CodexSessionPage['items'][number], readonly: boolean): ProviderSessionSummary {
  return {
    id: `codex:${summary.id}`,
    provider: 'codex',
    nativeId: summary.id,
    title: summary.title,
    cwd: summary.cwd,
    model: summary.model,
    archived: summary.archived,
    readonly,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    messageCount: null,
    sourcePath: '',
    detailAvailable: summary.rolloutAvailable,
  }
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return 'AI'
  if (role === 'developer') return '开发者指令'
  if (role === 'system') return '系统'
  return role || '其他'
}

async function writeChunk(output: fs.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(text, 'utf8', (error) => error ? reject(error) : resolve())
  })
}

async function endStream(output: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.end(resolve)
    output.once('error', reject)
  })
}

function safeMarkdownFileName(summary: ProviderSessionSummary): string {
  const safe = summary.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80)
  return `${safe || `${summary.provider}-session`}-${summary.nativeId.slice(0, 8)}.md`
}

function providerFromId(id: string): ProviderSessionProvider {
  const separator = id.indexOf(':')
  const provider = separator > 0 ? id.slice(0, separator) : ''
  if (!providerSessionProviders.includes(provider as ProviderSessionProvider)) {
    throw new Error('会话 ID 缺少有效 Provider 前缀')
  }
  return provider as ProviderSessionProvider
}

export class ProviderSessionsService {
  readonly codexService: CodexSessionReader
  readonly roots: ProviderRoots
  private readonly listProbeBytes: number
  private readonly maxTranscriptBytes: number
  private readonly maxJsonLineBytes: number
  private readonly maxFilesPerProvider: number
  private readonly probeCache = new Map<string, ProbeCacheEntry>()
  private readonly candidateIndex = new Map<string, SourceCandidate>()

  constructor(options: ProviderSessionsOptions = {}) {
    const home = os.homedir()
    this.codexService = options.codexService ?? new CodexSessionsService({ codexHome: options.codexHome })
    this.roots = {
      claude: path.resolve(options.claudeProjectsRoot ?? path.join(home, '.claude', 'projects')),
      gemini: path.resolve(options.geminiTmpRoot ?? path.join(home, '.gemini', 'tmp')),
      grok: path.resolve(options.grokSessionsRoot ?? path.join(home, '.grok', 'sessions')),
    }
    this.listProbeBytes = positiveInteger(options.listProbeBytes, DEFAULT_LIST_PROBE_BYTES, 16 * 1024 * 1024)
    this.maxTranscriptBytes = positiveInteger(
      options.maxTranscriptBytes,
      DEFAULT_MAX_TRANSCRIPT_BYTES,
      1024 * 1024 * 1024,
    )
    this.maxJsonLineBytes = positiveInteger(
      options.maxJsonLineBytes,
      DEFAULT_MAX_JSON_LINE_BYTES,
      64 * 1024 * 1024,
    )
    this.maxFilesPerProvider = positiveInteger(options.maxFilesPerProvider, DEFAULT_MAX_FILES, 500_000)
  }

  capabilities(): Record<ProviderSessionProvider, ProviderSessionCapability> {
    const codex = this.codexService.capabilities()
    const codexReadable = codex.schema.readable
    const codexWritable = codex.schema.mutationsAllowed
    return {
      codex: {
        provider: 'codex',
        available: codex.schema.kind !== 'missing',
        readable: codexReadable,
        readonly: !codexWritable,
        source: 'sqlite-jsonl',
        reason: codex.schema.reason,
        operations: {
          list: codexReadable,
          detail: codexReadable,
          exportMarkdown: codexReadable,
          archive: codexWritable,
          restore: codexWritable,
        },
      },
      claude: this.externalCapability('claude', 'jsonl'),
      gemini: this.externalCapability('gemini', 'json-jsonl'),
      grok: this.externalCapability('grok', 'json-jsonl'),
    }
  }

  async list(query: ProviderSessionListQuery = {}): Promise<ProviderSessionPage> {
    const provider = query.provider ?? 'all'
    const selected = provider === 'all' ? [...providerSessionProviders] : [provider]
    const capabilities = this.capabilities()
    const items: ProviderSessionSummary[] = []
    for (const current of selected) {
      try {
        const providerItems = current === 'codex'
          ? this.listCodexSessions()
          : await this.listExternalSessions(current)
        items.push(...providerItems)
        if (current !== 'codex') {
          const capability = capabilities[current]
          capability.available = await existingDirectory(this.roots[current])
          capability.readable = capability.available
          capability.reason = capability.available
            ? `已读取 ${providerItems.length} 个本地会话；该 Provider 仅开放只读管理`
            : '未找到本地会话目录'
          capability.operations.list = capability.available
          capability.operations.detail = capability.available
          capability.operations.exportMarkdown = capability.available
        }
      } catch (error) {
        const capability = capabilities[current]
        capability.readable = false
        capability.reason = error instanceof Error ? error.message : String(error)
        capability.operations.list = false
        capability.operations.detail = false
        capability.operations.exportMarkdown = false
      }
    }

    const search = query.search?.trim().toLocaleLowerCase() ?? ''
    const filtered = search
      ? items.filter((item) => [item.title, item.cwd, item.model, item.nativeId, item.provider]
        .some((value) => value.toLocaleLowerCase().includes(search)))
      : items
    filtered.sort((left, right) => (
      (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0)
      || left.provider.localeCompare(right.provider)
      || left.id.localeCompare(right.id)
    ))
    const byProvider: Record<ProviderSessionProvider, number> = { codex: 0, claude: 0, gemini: 0, grok: 0 }
    for (const item of filtered) byProvider[item.provider] += 1
    const pageSize = positiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const requestedPage = positiveInteger(query.page, 1, Number.MAX_SAFE_INTEGER)
    const pages = filtered.length === 0 ? 0 : Math.ceil(filtered.length / pageSize)
    const page = pages === 0 ? 1 : Math.min(requestedPage, pages)
    return {
      items: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
      page,
      pageSize,
      pages,
      stats: { total: filtered.length, byProvider },
      capabilities,
    }
  }

  async detail(id: string): Promise<ProviderSessionDetail> {
    const provider = providerFromId(id)
    if (provider === 'codex') {
      const nativeId = id.slice('codex:'.length)
      if (!nativeId) throw new Error('会话 ID 为空')
      const detail = await this.codexService.detail(nativeId)
      const readonly = !this.codexService.capabilities().schema.mutationsAllowed
      return {
        session: codexSummary(detail.session, readonly),
        messages: detail.messages,
        messageStats: detail.messageStats,
        messagesTruncated: detail.messagesTruncated,
        sourceTruncated: false,
      }
    }
    const session = await this.resolveExternalSummary(provider, id)
    const content = await this.readExternalMessages(session)
    return {
      session,
      messages: content.messages,
      messageStats: content.stats,
        messagesTruncated: content.messages.length < content.stats.total
          || content.sourceTruncated
          || content.retainedTextTruncated
          || content.stats.invalidLines > 0,
      sourceTruncated: content.sourceTruncated,
    }
  }

  async exportMarkdown(id: string, destinationPath: string): Promise<ProviderSessionExportResult> {
    const provider = providerFromId(id)
    if (provider === 'codex') {
      const nativeId = id.slice('codex:'.length)
      const exported = await this.codexService.exportMarkdown(nativeId, destinationPath)
      return { id, provider, outputPath: exported.outputPath, messages: exported.messages, truncated: false }
    }
    const session = await this.resolveExternalSummary(provider, id)
    let outputPath = path.resolve(destinationPath)
    try {
      if ((await fsPromises.stat(outputPath)).isDirectory()) outputPath = path.join(outputPath, safeMarkdownFileName(session))
    } catch {
      if (!path.extname(outputPath)) outputPath = path.join(outputPath, safeMarkdownFileName(session))
    }
    if (path.extname(outputPath).toLowerCase() !== '.md') throw new Error('会话导出文件必须使用 .md 扩展名')
    await fsPromises.mkdir(path.dirname(outputPath), { recursive: true })
    // 先写同目录临时文件，成功后 rename 原子覆盖，避免失败时破坏用户已有文件。
    const tempPath = `${outputPath}.${randomUUID()}.tmp`
    const handle = await fsPromises.open(tempPath, 'wx', 0o600)
    const output = handle.createWriteStream({ encoding: 'utf8' })
    try {
      // Titles come from untrusted session content; a newline or '## ' inside
      // one would break the exported Markdown structure.
      await writeChunk(output, `# ${cleanText(session.title)}\n\n`)
      await writeChunk(output, `- Provider：\`${session.provider}\`\n- 会话 ID：\`${session.nativeId}\`\n`)
      if (session.cwd) await writeChunk(output, `- 工作目录：\`${session.cwd.replaceAll('`', '\\`')}\`\n`)
      if (session.model) await writeChunk(output, `- 模型：\`${session.model.replaceAll('`', '\\`')}\`\n`)
      await writeChunk(output, '\n---\n\n')
      const content = await this.readExternalMessages(session, async (message) => {
        await writeChunk(output, `## ${cleanText(roleLabel(message.role))}\n\n${message.text}\n\n`)
      }, 0)
      const truncated = content.sourceTruncated || content.stats.invalidLines > 0
      if (truncated) {
        await writeChunk(output, '> 注意：源会话超过安全读取上限或含有损坏记录，本导出文件已明确标记为不完整。\n')
      }
      await endStream(output)
      await fsPromises.rename(tempPath, outputPath)
      return {
        id,
        provider,
        outputPath,
        messages: content.stats.total,
        truncated,
      }
    } catch (error) {
      output.destroy()
      await fsPromises.rm(tempPath, { force: true })
      throw error
    }
  }

  private externalCapability(
    provider: Exclude<ProviderSessionProvider, 'codex'>,
    source: ProviderSessionCapability['source'],
  ): ProviderSessionCapability {
    const available = existingDirectorySync(this.roots[provider])
    return {
      provider,
      available,
      readable: available,
      readonly: true,
      source,
      reason: available ? '已找到本地会话目录，仅开放只读操作' : '未找到本地会话目录',
      operations: {
        list: available,
        detail: available,
        exportMarkdown: available,
        archive: false,
        restore: false,
      },
    }
  }

  private listCodexSessions(): ProviderSessionSummary[] {
    let stable = new Map<string, CodexSessionPage['items'][number]>()
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const first = this.codexService.list({ archive: 'all', page: 1, pageSize: 100 })
      const items = new Map(first.items.map((item) => [item.id, item]))
      for (let page = 2; page <= first.pages; page += 1) {
        for (const item of this.codexService.list({ archive: 'all', page, pageSize: 100 }).items) {
          items.set(item.id, item)
        }
      }
      stable = items
      const finalTotal = this.codexService.list({ archive: 'all', page: 1, pageSize: 1 }).total
      if (items.size === finalTotal) break
    }
    const readonly = !this.codexService.capabilities().schema.mutationsAllowed
    return [...stable.values()].map((item) => codexSummary(item, readonly))
  }

  private async sourceCandidates(
    provider: Exclude<ProviderSessionProvider, 'codex'>,
  ): Promise<SourceCandidate[]> {
    const candidates = await this.discoverSourceCandidates(provider)
    for (const candidate of candidates) {
      const id = stableSessionId(provider, this.roots[provider], candidate.keyPath)
      this.candidateIndex.delete(id)
      this.candidateIndex.set(id, candidate)
    }
    while (this.candidateIndex.size > MAX_PROBE_CACHE_ENTRIES) {
      this.candidateIndex.delete(this.candidateIndex.keys().next().value as string)
    }
    return candidates
  }

  private async discoverSourceCandidates(
    provider: Exclude<ProviderSessionProvider, 'codex'>,
  ): Promise<SourceCandidate[]> {
    const root = this.roots[provider]
    if (provider === 'claude') {
      const discovery = await discoverFiles(root, (file) => file.toLowerCase().endsWith('.jsonl'), this.maxFilesPerProvider)
      return discovery.files.map((sourcePath) => ({ provider, keyPath: sourcePath, sourcePath }))
    }
    if (provider === 'gemini') {
      const discovery = await discoverFiles(
        root,
        (file) => /^session-.*\.(json|jsonl)$/i.test(path.basename(file)),
        this.maxFilesPerProvider,
      )
      return discovery.files.map((sourcePath) => ({ provider, keyPath: sourcePath, sourcePath }))
    }
    const discovery = await discoverFiles(
      root,
      (file) => /^(chat_history\.jsonl|summary\.json)$/i.test(path.basename(file)),
      this.maxFilesPerProvider * 2,
    )
    const grouped = new Map<string, { history?: string; summary?: string }>()
    for (const file of discovery.files) {
      const directory = path.dirname(file)
      const entry = grouped.get(directory) ?? {}
      if (path.basename(file).toLowerCase() === 'chat_history.jsonl') entry.history = file
      else entry.summary = file
      grouped.set(directory, entry)
    }
    if (grouped.size > this.maxFilesPerProvider) throw new Error(`会话文件超过安全上限 ${this.maxFilesPerProvider}`)
    return [...grouped.entries()].map(([keyPath, files]) => ({
      provider,
      keyPath,
      sourcePath: files.history ?? files.summary as string,
      summaryPath: files.summary,
    }))
  }

  private async listExternalSessions(
    provider: Exclude<ProviderSessionProvider, 'codex'>,
  ): Promise<ProviderSessionSummary[]> {
    const candidates = await this.sourceCandidates(provider)
    const items: ProviderSessionSummary[] = []
    for (const candidate of candidates) {
      try {
        items.push(await this.probeExternalSession(candidate))
      } catch {
        try {
          const stat = await safeRegularFileStat(candidate.sourcePath)
          items.push(finalizeExternalSummary(candidate, this.roots[provider], newProbeState(stat)))
        } catch {
          // The file disappeared after discovery; it is not a stable local session anymore.
        }
      }
    }
    return items
  }

  private async probeFingerprint(candidate: SourceCandidate, stat: fs.Stats): Promise<string> {
    // The inode guards against a rewrite that lands in the same millisecond
    // with the same size; the summary file participates for grok candidates.
    let fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ino}`
    if (candidate.summaryPath) {
      const summaryStat = await fsPromises.lstat(candidate.summaryPath).catch(() => null)
      fingerprint += summaryStat ? `|${summaryStat.size}:${summaryStat.mtimeMs}:${summaryStat.ino}` : '|missing'
    }
    return fingerprint
  }

  private async probeExternalSession(candidate: SourceCandidate): Promise<ProviderSessionSummary> {
    const stat = await safeRegularFileStat(candidate.sourcePath)
    const cacheKey = normalizePath(candidate.sourcePath)
    const fingerprint = await this.probeFingerprint(candidate, stat)
    const cached = this.probeCache.get(cacheKey)
    if (cached && cached.fingerprint === fingerprint) {
      this.probeCache.delete(cacheKey)
      this.probeCache.set(cacheKey, cached)
      return finalizeExternalSummary(candidate, this.roots[candidate.provider], { ...cached.state })
    }
    const state = newProbeState(stat)
    if (candidate.provider === 'claude') {
      let count = 0
      const scan = await scanJsonLines(candidate.sourcePath, this.listProbeBytes, this.maxJsonLineBytes, (value) => {
        if (applyClaudeProbe(state, value)) count += 1
      })
      if (!scan.sourceTruncated) state.messageCount = count
    } else if (candidate.provider === 'gemini') {
      if (candidate.sourcePath.toLowerCase().endsWith('.jsonl')) {
        let count = 0
        const seenMessageIds = new Set<string>()
        const scan = await scanJsonLines(candidate.sourcePath, this.listProbeBytes, this.maxJsonLineBytes, (value) => {
          const messages = applyGeminiDocument(state, value, seenMessageIds)
          count += messages.length
        })
        if (!scan.sourceTruncated) state.messageCount = count
      } else {
        const document = await readJsonBounded(candidate.sourcePath, this.maxTranscriptBytes)
        if (document.value) applyGeminiDocument(state, document.value)
      }
    } else {
      if (candidate.summaryPath) {
        const summary = await readJsonBounded(candidate.summaryPath, Math.min(this.maxTranscriptBytes, 16 * 1024 * 1024))
        if (summary.value) applyGrokSummary(state, summary.value)
      }
      if (path.basename(candidate.sourcePath).toLowerCase() === 'chat_history.jsonl') {
        let count = 0
        const scan = await scanJsonLines(candidate.sourcePath, this.listProbeBytes, this.maxJsonLineBytes, (value) => {
          const message = parseGrokMessage(value)
          if (!message) return
          count += 1
          if (message.role === 'user' && !state.firstUserText) state.firstUserText = cleanText(message.text)
          const record = asRecord(value)
          if (!state.model) state.model = asString(record?.model_id)
        })
        if (!scan.sourceTruncated && state.messageCount === null) state.messageCount = count
      }
    }
    this.probeCache.delete(cacheKey)
    this.probeCache.set(cacheKey, { fingerprint, state: { ...state } })
    while (this.probeCache.size > MAX_PROBE_CACHE_ENTRIES) {
      this.probeCache.delete(this.probeCache.keys().next().value as string)
    }
    return finalizeExternalSummary(candidate, this.roots[candidate.provider], state)
  }

  private async resolveExternalSummary(
    provider: Exclude<ProviderSessionProvider, 'codex'>,
    id: string,
  ): Promise<ProviderSessionSummary> {
    // The cached candidate avoids a full rescan, but the file must still prove
    // it is a live regular file before the mapping is trusted.
    const known = this.candidateIndex.get(id)
    if (known && known.provider === provider) {
      try {
        await safeRegularFileStat(known.sourcePath)
        return await this.probeExternalSession(known)
      } catch {
        this.candidateIndex.delete(id)
      }
    }
    const candidates = await this.sourceCandidates(provider)
    const candidate = candidates.find((entry) => stableSessionId(provider, this.roots[provider], entry.keyPath) === id)
    if (!candidate) throw new Error(`未找到 ${provider} 会话`)
    return this.probeExternalSession(candidate)
  }

  private async readExternalMessages(
    session: ProviderSessionSummary,
    consumer?: MessageConsumer,
    retainLimit = DETAIL_MESSAGE_LIMIT,
  ): Promise<MessageReadResult> {
    const messages: ProviderSessionMessage[] = []
    const stats = emptyMessageStats()
    let retainedTextTruncated = false
    const accept = async (message: ProviderSessionMessage | null): Promise<void> => {
      if (!message) return
      recordMessage(stats, message)
      await consumer?.(message)
      if (retainLimit > 0) {
        const retainedText = truncateMessageText(message.text)
        if (retainedText !== message.text) retainedTextTruncated = true
        messages.push({ ...message, text: retainedText })
        if (messages.length > retainLimit) messages.shift()
      }
    }
    let sourceTruncated = false
    if (session.provider === 'claude') {
      const scan = await scanJsonLines(session.sourcePath, this.maxTranscriptBytes, this.maxJsonLineBytes, async (value) => {
        const entry = asRecord(value)
        await accept(entry ? parseClaudeMessage(entry) : null)
      })
      stats.invalidLines += scan.invalidLines
      sourceTruncated = scan.sourceTruncated
    } else if (session.provider === 'gemini') {
      if (session.sourcePath.toLowerCase().endsWith('.jsonl')) {
        const state = newProbeState(await safeRegularFileStat(session.sourcePath))
        const seenMessageIds = new Set<string>()
        const scan = await scanJsonLines(session.sourcePath, this.maxTranscriptBytes, this.maxJsonLineBytes, async (value) => {
          for (const message of applyGeminiDocument(state, value, seenMessageIds)) await accept(message)
        })
        stats.invalidLines += scan.invalidLines
        sourceTruncated = scan.sourceTruncated
      } else {
        const document = await readJsonBounded(session.sourcePath, this.maxTranscriptBytes)
        stats.invalidLines += document.invalidLines
        sourceTruncated = document.sourceTruncated
        if (document.value) {
          const state = newProbeState(await safeRegularFileStat(session.sourcePath))
          for (const message of applyGeminiDocument(state, document.value)) await accept(message)
        }
      }
    } else if (path.basename(session.sourcePath).toLowerCase() === 'chat_history.jsonl') {
      const scan = await scanJsonLines(session.sourcePath, this.maxTranscriptBytes, this.maxJsonLineBytes, async (value) => {
        await accept(parseGrokMessage(value))
      })
      stats.invalidLines += scan.invalidLines
      sourceTruncated = scan.sourceTruncated
    }
    return { messages, stats, sourceTruncated, retainedTextTruncated }
  }
}
