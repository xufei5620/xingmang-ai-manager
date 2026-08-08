import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { backup, DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { readBoundedUtf8FileSync } from './bounded-file'
import { sameLocalPathIdentity } from './path-identity'

const MAX_OPERATION_JOURNAL_BYTES = 64 * 1024 * 1024
const MAX_RECOVERY_WARNING_DETAILS = 32
const MAX_RETAINED_BACKUPS = 20
const BACKUP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export type SessionArchiveFilter = 'all' | 'active' | 'archived'

export interface CodexSessionListQuery {
  search?: string
  archive?: SessionArchiveFilter
  page?: number
  pageSize?: number
}

export interface CodexSessionSummary {
  id: string
  title: string
  cwd: string
  model: string
  modelProvider: string
  archived: boolean
  createdAt: number | null
  updatedAt: number | null
  tokensUsed: number
  rolloutAvailable: boolean
}

export interface CodexSessionStats {
  total: number
  active: number
  archived: number
  projects: number
  tokensUsed: number
}

export interface CodexSessionSchemaStatus {
  kind: 'codex-threads' | 'unsupported' | 'missing'
  readable: boolean
  mutationsAllowed: boolean
  reason: string
  columns: string[]
}

export interface CodexSessionPage {
  items: CodexSessionSummary[]
  total: number
  page: number
  pageSize: number
  pages: number
  stats: CodexSessionStats
  schema: CodexSessionSchemaStatus
}

export interface CodexSessionMessage {
  role: string
  text: string
  timestamp: string | null
}

export interface CodexSessionMessageStats {
  total: number
  user: number
  assistant: number
  system: number
  other: number
  invalidLines: number
}

export interface CodexSessionDetail {
  session: CodexSessionSummary
  messages: CodexSessionMessage[]
  messageStats: CodexSessionMessageStats
  messagesTruncated: boolean
}

export interface CodexSessionMutationResult {
  sessionId: string
  archived: boolean
  backupPath: string
  rolloutPath: string
  operationId: string
}

export interface CodexSessionExportResult {
  sessionId: string
  outputPath: string
  messages: number
}

export interface CodexSessionsCapabilities {
  schema: CodexSessionSchemaStatus
  databasePath: string
  backupDirectory: string
  trashDirectory: string
  operationJournalPath: string
  permanentDeleteAllowed: false
}

export type CodexSessionRecoveryWarningCode =
  | 'journal-read-failed'
  | 'journal-invalid-line'
  | 'database-unavailable'
  | 'operation-recovery-failed'
  | 'recovery-warnings-suppressed'

export interface CodexSessionRecoveryWarning {
  code: CodexSessionRecoveryWarningCode
  message: string
  detail: {
    lineNumber?: number
    operation?: 'archive' | 'restore'
    errorCode?: string
    pendingOperations?: number
    suppressedWarnings?: number
  }
}

export interface CodexSessionsOptions {
  codexHome?: string
  managerDataDirectory?: string
  databasePath?: string
  now?: () => number
  maxJsonLineBytes?: number
  onRecoveryWarning?: (warning: CodexSessionRecoveryWarning) => void
  hooks?: {
    afterMoveBeforeCommit?: (sourcePath: string, targetPath: string) => void | Promise<void>
  }
}

interface ThreadSchema {
  status: CodexSessionSchemaStatus
  columns: Set<string>
}

interface ThreadRow {
  id: string
  rolloutPath: string
  title: string
  cwd: string
  model: string
  modelProvider: string
  archived: boolean
  createdAt: number | null
  updatedAt: number | null
  tokensUsed: number
}

interface JournalEntry {
  operationId: string
  sessionId: string
  operation: 'archive' | 'restore'
  state: 'pending' | 'ready' | 'committed' | 'rolled-back'
  sourcePath: string
  targetPath: string
  backupPath: string
  timestamp: string
  error?: string
}

interface RecoveryJournalEntry extends JournalEntry {
  state: 'pending' | 'ready'
}

const DEFAULT_PAGE_SIZE = 20
const MAX_PAGE_SIZE = 100
const DETAIL_MESSAGE_LIMIT = 250
const DETAIL_TEXT_LIMIT = 24_000
const MAX_ROLLOUT_METADATA_BYTES = 1024 * 1024
const DEFAULT_MAX_JSON_LINE_BYTES = 8 * 1024 * 1024
const MANAGER_DIRECTORY_NAME = '.xingmang-ai-manager'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const number = asNumber(value)
  return Number.isFinite(number) ? number : null
}

function positiveInteger(value: number | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isInteger(value) || (value ?? 0) < 1) return fallback
  return Math.min(value as number, maximum)
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function optionalColumn(columns: Set<string>, name: string, fallback: string): string {
  return columns.has(name) ? quoteIdentifier(name) : fallback
}

function timestampExpression(columns: Set<string>, millisecondName: string, secondName: string): string {
  if (columns.has(millisecondName) && columns.has(secondName)) {
    return `COALESCE(${quoteIdentifier(millisecondName)}, ${quoteIdentifier(secondName)} * 1000)`
  }
  if (columns.has(millisecondName)) return quoteIdentifier(millisecondName)
  if (columns.has(secondName)) return `${quoteIdentifier(secondName)} * 1000`
  return 'NULL'
}

function stripWindowsNamespace(filePath: string): string {
  if (process.platform !== 'win32') return filePath
  if (/^\\\\\?\\UNC\\/i.test(filePath)) return `\\\\${filePath.slice(8)}`
  if (/^\\\\\?\\/i.test(filePath)) return filePath.slice(4)
  return filePath
}

function resolveFilePath(filePath: string): string {
  return path.resolve(stripWindowsNamespace(filePath))
}

function requireAbsoluteCodexHome(value: string): string {
  const selected = value.trim()
  if (!selected || selected.includes('\0') || !path.isAbsolute(stripWindowsNamespace(selected))) {
    throw new Error('CODEX_HOME 必须是不含 NUL 的绝对路径')
  }
  return resolveFilePath(selected)
}

function normalizeForComparison(filePath: string): string {
  const resolved = resolveFilePath(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(normalizeForComparison(parentPath), normalizeForComparison(childPath))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function ensureInside(parentPath: string, childPath: string, label: string): string {
  const resolved = resolveFilePath(childPath)
  if (!isInside(parentPath, resolved)) throw new Error(`${label}不在 CODEX_HOME 内，已拒绝操作`)
  return resolved
}

function databaseExists(databasePath: string): boolean {
  try {
    const info = fs.lstatSync(databasePath)
    // The session database is an application-owned file. Following a link here
    // could make a malformed CODEX_HOME expose an unrelated SQLite database.
    return info.isFile() && info.nlink <= 1 && !info.isSymbolicLink()
  } catch {
    return false
  }
}

function openReadOnly(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath, { readOnly: true, allowExtension: false })
  database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;')
  return database
}

function inspectSchema(database: DatabaseSync): ThreadSchema {
  const table = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
  ).get()
  if (!table) {
    return {
      columns: new Set(),
      status: {
        kind: 'unsupported',
        readable: false,
        mutationsAllowed: false,
        reason: '未找到 Codex threads 表，仅允许检查数据库',
        columns: [],
      },
    }
  }

  const columns = new Set(
    database.prepare("PRAGMA table_info('threads')").all()
      .map((row) => asString((row as Record<string, SQLOutputValue>).name))
      .filter(Boolean),
  )
  const readable = columns.has('id')
  const mutationsAllowed = readable
    && columns.has('rollout_path')
    && columns.has('archived')
  const reason = !readable
    ? 'threads 表缺少 id 列，未识别的 schema 不会被写入'
    : mutationsAllowed
      ? '已识别 Codex threads schema，已开放受保护的归档与恢复'
      : '可读取会话，但 schema 缺少归档所需列，写操作已禁用'
  return {
    columns,
    status: {
      kind: readable ? 'codex-threads' : 'unsupported',
      readable,
      mutationsAllowed,
      reason,
      columns: [...columns].sort(),
    },
  }
}

function missingSchemaStatus(): CodexSessionSchemaStatus {
  return {
    kind: 'missing',
    readable: false,
    mutationsAllowed: false,
    reason: '未找到 Codex 会话数据库',
    columns: [],
  }
}

function threadSelect(columns: Set<string>): string {
  return [
    'id AS id',
    `${optionalColumn(columns, 'rollout_path', "''")} AS rollout_path`,
    `${optionalColumn(columns, 'title', "''")} AS title`,
    `${optionalColumn(columns, 'cwd', "''")} AS cwd`,
    `${optionalColumn(columns, 'model', "''")} AS model`,
    `${optionalColumn(columns, 'model_provider', "''")} AS model_provider`,
    `${optionalColumn(columns, 'archived', '0')} AS archived`,
    `${timestampExpression(columns, 'created_at_ms', 'created_at')} AS created_at_ms`,
    `${timestampExpression(columns, 'updated_at_ms', 'updated_at')} AS updated_at_ms`,
    `${optionalColumn(columns, 'tokens_used', '0')} AS tokens_used`,
  ].join(', ')
}

function mapThreadRow(row: Record<string, SQLOutputValue>): ThreadRow {
  return {
    id: asString(row.id),
    rolloutPath: asString(row.rollout_path),
    title: asString(row.title),
    cwd: asString(row.cwd),
    model: asString(row.model),
    modelProvider: asString(row.model_provider),
    archived: asNumber(row.archived) !== 0,
    createdAt: nullableNumber(row.created_at_ms),
    updatedAt: nullableNumber(row.updated_at_ms),
    tokensUsed: asNumber(row.tokens_used),
  }
}

function toSummary(row: ThreadRow, codexHome: string): CodexSessionSummary {
  let rolloutAvailable = false
  if (row.rolloutPath && isInside(codexHome, row.rolloutPath)) {
    try {
      const info = fs.lstatSync(row.rolloutPath)
      rolloutAvailable = info.isFile() && info.nlink <= 1 && !info.isSymbolicLink()
    } catch {
      rolloutAvailable = false
    }
  }
  return {
    id: row.id,
    title: row.title || row.id,
    cwd: row.cwd,
    model: row.model,
    modelProvider: row.modelProvider,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tokensUsed: row.tokensUsed,
    rolloutAvailable,
  }
}

function searchClause(columns: Set<string>, search: string): { sql: string; values: string[] } {
  const searchable = ['id', 'title', 'cwd', 'model', 'model_provider', 'first_user_message']
    .filter((column) => columns.has(column))
  if (!search || searchable.length === 0) return { sql: '', values: [] }
  const escaped = search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  return {
    sql: `(${searchable.map((column) => `COALESCE(${quoteIdentifier(column)}, '') LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    values: searchable.map(() => `%${escaped}%`),
  }
}

function whereClause(
  columns: Set<string>,
  query: CodexSessionListQuery,
): { sql: string; values: Array<string | number> } {
  const clauses: string[] = []
  const values: Array<string | number> = []
  if (columns.has('archived') && query.archive && query.archive !== 'all') {
    clauses.push(`${quoteIdentifier('archived')} = ?`)
    values.push(query.archive === 'archived' ? 1 : 0)
  }
  const search = searchClause(columns, query.search?.trim() ?? '')
  if (search.sql) {
    clauses.push(search.sql)
    values.push(...search.values)
  }
  return { sql: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', values }
}

function bindAll(statement: ReturnType<DatabaseSync['prepare']>, values: Array<string | number>): unknown[] {
  return statement.all(...values)
}

function getThread(database: DatabaseSync, schema: ThreadSchema, sessionId: string): ThreadRow {
  if (!schema.status.readable) throw new Error(schema.status.reason)
  const row = database.prepare(
    `SELECT ${threadSelect(schema.columns)} FROM threads WHERE id = ? LIMIT 1`,
  ).get(sessionId) as Record<string, SQLOutputValue> | undefined
  if (!row) throw new Error(`未找到会话：${sessionId}`)
  return mapThreadRow(row)
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((item) => {
    const record = asRecord(item)
    if (!record) return ''
    if (typeof record.text === 'string') return record.text
    if (typeof record.input_text === 'string') return record.input_text
    if (typeof record.output_text === 'string') return record.output_text
    return ''
  }).filter(Boolean).join('\n')
}

function extractMessage(value: unknown): CodexSessionMessage | null {
  const entry = asRecord(value)
  if (!entry || entry.type !== 'response_item') return null
  const payload = asRecord(entry.payload)
  if (!payload || payload.type !== 'message') return null
  const role = asString(payload.role) || 'other'
  const text = contentText(payload.content).trim()
  if (!text) return null
  return {
    role,
    text: text.length > DETAIL_TEXT_LIMIT ? `${text.slice(0, DETAIL_TEXT_LIMIT)}\n…` : text,
    timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : null,
  }
}

async function validateRollout(
  codexHome: string,
  rolloutPath: string,
  sessionId: string,
): Promise<string> {
  if (!rolloutPath) throw new Error('会话缺少 rollout_path，已拒绝操作')
  const safePath = ensureInside(codexHome, rolloutPath, 'rollout_path')
  const info = await fsPromises.lstat(safePath)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) {
    throw new Error('rollout_path 不是单链接普通文件，已拒绝操作')
  }
  const homeRealPath = await fsPromises.realpath(codexHome)
  const rolloutRealPath = await fsPromises.realpath(safePath)
  if (!isInside(homeRealPath, rolloutRealPath)) {
    throw new Error('rollout_path 经由符号链接越出 CODEX_HOME，已拒绝操作')
  }

  const firstLine = (await readFirstLineBounded(
    rolloutRealPath,
    MAX_ROLLOUT_METADATA_BYTES,
    'rollout 首条元数据',
  )).trim()
  if (!firstLine) throw new Error('rollout 文件为空，已拒绝操作')
  let first: unknown
  try {
    first = JSON.parse(firstLine) as unknown
  } catch {
    throw new Error('rollout 首条记录不是有效 JSON，已拒绝操作')
  }
  const record = asRecord(first)
  const payload = asRecord(record?.payload)
  if (record?.type !== 'session_meta' || asString(payload?.id) !== sessionId) {
    throw new Error('rollout 首条 session_meta.id 与 SQLite 会话 ID 不匹配')
  }
  return sameLocalPathIdentity(safePath, rolloutRealPath) ? safePath : rolloutRealPath
}

async function readFirstLineBounded(filePath: string, maximumBytes: number, label: string): Promise<string> {
  const handle = await fsPromises.open(filePath, 'r')
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1) throw new Error(`${label}不是单链接普通文件`)
    const length = Math.min(before.size, maximumBytes + 1)
    const buffer = Buffer.allocUnsafe(length)
    let offset = 0
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const newline = buffer.subarray(0, offset).indexOf(0x0a)
    if (newline < 0 && before.size > maximumBytes) throw new Error(`${label}超过 1024 KB 安全上限`)
    const after = await handle.stat()
    if (after.size !== before.size || after.nlink !== before.nlink) throw new Error(`${label}在读取过程中发生变化`)
    return buffer.subarray(0, newline >= 0 ? newline : offset).toString('utf8').replace(/\r$/, '')
  } finally {
    await handle.close()
  }
}

function validateRolloutIdentitySync(rolloutPath: string, sessionId: string): void {
  const descriptor = fs.openSync(rolloutPath, 'r')
  const chunks: Buffer[] = []
  const buffer = Buffer.allocUnsafe(4096)
  let bytesRead = 0
  let total = 0
  const maximumMetadataBytes = 1024 * 1024
  try {
    while (total < maximumMetadataBytes) {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, total)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      total += bytesRead
      if (buffer.subarray(0, bytesRead).includes(0x0a)) break
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const firstLine = Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0]?.trim()
  if (!firstLine) throw new Error('中断操作的 rollout 文件为空')
  let parsed: unknown
  try {
    parsed = JSON.parse(firstLine) as unknown
  } catch {
    throw new Error('中断操作的 rollout 首条记录不是有效 JSON')
  }
  const record = asRecord(parsed)
  const payload = asRecord(record?.payload)
  if (record?.type !== 'session_meta' || asString(payload?.id) !== sessionId) {
    throw new Error('中断操作的 rollout 与 SQLite 会话 ID 不匹配')
  }
}

async function streamMessages(
  rolloutPath: string,
  maximumLineBytes: number,
  onMessage: (message: CodexSessionMessage) => void | Promise<void>,
): Promise<CodexSessionMessageStats> {
  const stats: CodexSessionMessageStats = {
    total: 0,
    user: 0,
    assistant: 0,
    system: 0,
    other: 0,
    invalidLines: 0,
  }
  const consumeLine = async (line: string): Promise<void> => {
    const trimmed = line.replace(/\r$/, '').trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed) as unknown
    } catch {
      stats.invalidLines += 1
      return
    }
    const message = extractMessage(parsed)
    if (!message) return
    stats.total += 1
    if (message.role === 'user') stats.user += 1
    else if (message.role === 'assistant') stats.assistant += 1
    else if (message.role === 'system' || message.role === 'developer') stats.system += 1
    else stats.other += 1
    await onMessage(message)
  }

  const input = fs.createReadStream(rolloutPath, { encoding: 'utf8', highWaterMark: 64 * 1024 })
  let pending = ''
  let droppingOversizedLine = false
  for await (const rawChunk of input) {
    const chunk = rawChunk as string
    let start = 0
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk.charCodeAt(index) !== 10) continue
      const segment = chunk.slice(start, index)
      start = index + 1
      if (droppingOversizedLine) {
        droppingOversizedLine = false
        continue
      }
      if (Buffer.byteLength(pending, 'utf8') + Buffer.byteLength(segment, 'utf8') > maximumLineBytes) {
        pending = ''
        stats.invalidLines += 1
        continue
      }
      await consumeLine(pending + segment)
      pending = ''
    }
    const remainder = chunk.slice(start)
    if (droppingOversizedLine) continue
    if (Buffer.byteLength(pending, 'utf8') + Buffer.byteLength(remainder, 'utf8') > maximumLineBytes) {
      pending = ''
      droppingOversizedLine = true
      stats.invalidLines += 1
    } else {
      pending += remainder
    }
  }
  if (!droppingOversizedLine && pending) await consumeLine(pending)
  return stats
}

async function writeChunk(output: fs.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.write(text, 'utf8', (error) => error ? reject(error) : resolve())
  })
}

function safeMarkdownFileName(title: string, sessionId: string): string {
  const safe = title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80)
  return `${safe || 'Codex-session'}-${sessionId.slice(0, 8)}.md`
}

function markdownHeadingText(value: string, maximum = 160): string {
  // Newlines or '## ' fragments inside a heading would break the exported
  // document structure, so headings are collapsed to one bounded line.
  const cleaned = value.replace(/\s+/g, ' ').trim()
  return cleaned.length > maximum ? `${cleaned.slice(0, maximum)}…` : cleaned
}

function roleLabel(role: string): string {
  if (role === 'user') return '用户'
  if (role === 'assistant') return 'Codex'
  if (role === 'developer') return '开发者指令'
  if (role === 'system') return '系统'
  return role || '其他'
}

async function endStream(output: fs.WriteStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    output.end(resolve)
    output.once('error', reject)
  })
}

/**
 * `moveFileDurably` reserves the target with a hard link before unlinking the
 * source, so an interrupted move can leave both names on a single inode.
 * Dropping either name is only safe once that exact shape is confirmed — an
 * unrelated file that happens to sit at the target must never be removed.
 */
function isSameInodeLinkPair(sourceInfo: fs.BigIntStats, targetInfo: fs.BigIntStats): boolean {
  return sourceInfo.isFile() && !sourceInfo.isSymbolicLink()
    && targetInfo.isFile() && !targetInfo.isSymbolicLink()
    && sourceInfo.dev === targetInfo.dev
    && sourceInfo.ino === targetInfo.ino
}

async function moveFileDurably(sourcePath: string, targetPath: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true })
  // A hard-link gives us an atomic, no-overwrite target reservation on the
  // same volume. Falling back to COPYFILE_EXCL keeps the same no-overwrite
  // guarantee across volumes and on filesystems that do not support links.
  let targetCreated = false
  try {
    try {
      await fsPromises.link(sourcePath, targetPath)
      targetCreated = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EOPNOTSUPP') throw error
      await fsPromises.copyFile(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
      targetCreated = true
    }
    const targetHandle = await fsPromises.open(targetPath, 'r+')
    try {
      await targetHandle.sync()
    } finally {
      await targetHandle.close()
    }
    await fsPromises.rm(sourcePath)
  } catch (error) {
    if (targetCreated) await fsPromises.rm(targetPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function moveFileDurablySync(sourcePath: string, targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  let targetCreated = false
  try {
    try {
      fs.linkSync(sourcePath, targetPath)
      targetCreated = true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'EOPNOTSUPP') throw error
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL)
      targetCreated = true
    }
    const descriptor = fs.openSync(targetPath, 'r+')
    try {
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    fs.rmSync(sourcePath)
  } catch (error) {
    if (targetCreated) {
      try {
        fs.rmSync(targetPath, { force: true })
      } catch {
        // Preserve the original durability failure; recovery will still see the journal entry.
      }
    }
    throw error
  }
}

async function availableTarget(directory: string, basename: string, sessionId: string): Promise<string> {
  const direct = path.join(directory, basename)
  try {
    await fsPromises.lstat(direct)
  } catch {
    return direct
  }
  const extension = path.extname(basename)
  const stem = path.basename(basename, extension)
  return path.join(directory, `${stem}-${sessionId.slice(0, 8)}-${randomUUID().slice(0, 8)}${extension}`)
}

function mutationUpdateSql(columns: Set<string>): string {
  const assignments = ['archived = ?', 'rollout_path = ?']
  if (columns.has('archived_at')) assignments.push('archived_at = ?')
  return `UPDATE threads SET ${assignments.join(', ')} WHERE id = ?`
}

function mutationUpdateValues(
  columns: Set<string>,
  archived: boolean,
  rolloutPath: string,
  now: number,
  sessionId: string,
): Array<string | number | null> {
  const values: Array<string | number | null> = [archived ? 1 : 0, rolloutPath]
  if (columns.has('archived_at')) values.push(archived ? Math.floor(now / 1000) : null)
  values.push(sessionId)
  return values
}

function isJournalEntry(value: unknown): value is JournalEntry {
  const entry = asRecord(value)
  return Boolean(
    entry
    && typeof entry.operationId === 'string'
    && typeof entry.sessionId === 'string'
    && (entry.operation === 'archive' || entry.operation === 'restore')
    && (entry.state === 'pending' || entry.state === 'ready' || entry.state === 'committed' || entry.state === 'rolled-back')
    && typeof entry.sourcePath === 'string'
    && typeof entry.targetPath === 'string'
    && typeof entry.backupPath === 'string'
    && typeof entry.timestamp === 'string',
  )
}

function recoveryErrorCode(error: unknown): string {
  const candidate = error as { code?: unknown; name?: unknown }
  if (typeof candidate?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(candidate.code)) {
    return candidate.code
  }
  if (typeof candidate?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(candidate.name)) {
    return candidate.name
  }
  return 'UNKNOWN_ERROR'
}

function isExplicitlyTruncatedJson(line: string, error: unknown): boolean {
  if (!(error instanceof SyntaxError)) return false
  const input = line.trimEnd()
  const message = error.message
  if (/unexpected end of json input|unterminated string/i.test(message)) return true
  const position = message.match(/\bposition\s+(\d+)\b/i)?.[1]
  return position !== undefined && Number(position) >= input.length
}

export class CodexSessionsService {
  readonly codexHome: string
  readonly databasePath: string
  readonly managerDataDirectory: string
  readonly backupDirectory: string
  readonly trashDirectory: string
  readonly operationJournalPath: string
  private readonly now: () => number
  private readonly maxJsonLineBytes: number
  private readonly onRecoveryWarning: NonNullable<CodexSessionsOptions['onRecoveryWarning']>
  private readonly hooks: NonNullable<CodexSessionsOptions['hooks']>
  private mutationQueue: Promise<unknown> = Promise.resolve()
  private recoveryWarningsEmitted = 0
  private recoveryWarningsSuppressed = 0

  constructor(options: CodexSessionsOptions = {}) {
    this.codexHome = options.codexHome === undefined
      ? path.join(os.homedir(), '.codex')
      : requireAbsoluteCodexHome(options.codexHome)
    this.databasePath = resolveFilePath(options.databasePath ?? path.join(this.codexHome, 'state_5.sqlite'))
    this.managerDataDirectory = resolveFilePath(
      options.managerDataDirectory ?? path.join(os.homedir(), MANAGER_DIRECTORY_NAME, 'sessions'),
    )
    this.backupDirectory = path.join(this.managerDataDirectory, 'backups')
    this.trashDirectory = path.join(this.managerDataDirectory, 'trash')
    this.operationJournalPath = path.join(this.managerDataDirectory, 'operations.jsonl')
    this.now = options.now ?? Date.now
    this.maxJsonLineBytes = positiveInteger(
      options.maxJsonLineBytes,
      DEFAULT_MAX_JSON_LINE_BYTES,
      64 * 1024 * 1024,
    )
    this.onRecoveryWarning = options.onRecoveryWarning ?? (() => undefined)
    this.hooks = options.hooks ?? {}
    try {
      this.recoverInterruptedOperations()
    } finally {
      this.flushSuppressedRecoveryWarnings()
    }
  }

  capabilities(): CodexSessionsCapabilities {
    return {
      schema: this.schemaStatus(),
      databasePath: this.databasePath,
      backupDirectory: this.backupDirectory,
      trashDirectory: this.trashDirectory,
      operationJournalPath: this.operationJournalPath,
      permanentDeleteAllowed: false,
    }
  }

  schemaStatus(): CodexSessionSchemaStatus {
    if (!databaseExists(this.databasePath)) return missingSchemaStatus()
    const database = openReadOnly(this.databasePath)
    try {
      return inspectSchema(database).status
    } finally {
      database.close()
    }
  }

  list(query: CodexSessionListQuery = {}): CodexSessionPage {
    const page = positiveInteger(query.page, 1)
    const pageSize = positiveInteger(query.pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    if (!databaseExists(this.databasePath)) {
      return {
        items: [], total: 0, page, pageSize, pages: 0,
        stats: { total: 0, active: 0, archived: 0, projects: 0, tokensUsed: 0 },
        schema: missingSchemaStatus(),
      }
    }

    const database = openReadOnly(this.databasePath)
    try {
      const schema = inspectSchema(database)
      if (!schema.status.readable) {
        return {
          items: [], total: 0, page, pageSize, pages: 0,
          stats: { total: 0, active: 0, archived: 0, projects: 0, tokensUsed: 0 },
          schema: schema.status,
        }
      }
      const where = whereClause(schema.columns, query)
      const totalRow = database.prepare(`SELECT COUNT(*) AS count FROM threads${where.sql}`)
        .get(...where.values) as Record<string, SQLOutputValue>
      const total = asNumber(totalRow.count)
      const pages = total === 0 ? 0 : Math.ceil(total / pageSize)
      const safePage = pages === 0 ? 1 : Math.min(page, pages)
      const order = timestampExpression(schema.columns, 'updated_at_ms', 'updated_at')
      const statement = database.prepare(
        `SELECT ${threadSelect(schema.columns)} FROM threads${where.sql}
         ORDER BY COALESCE(${order}, 0) DESC, id DESC LIMIT ? OFFSET ?`,
      )
      const rows = bindAll(statement, [...where.values, pageSize, (safePage - 1) * pageSize])
        .map((row) => mapThreadRow(row as Record<string, SQLOutputValue>))
      const stats = database.prepare(
        `SELECT COUNT(*) AS total,
          ${schema.columns.has('archived') ? 'SUM(CASE WHEN archived = 0 THEN 1 ELSE 0 END)' : 'COUNT(*)'} AS active,
          ${schema.columns.has('archived') ? 'SUM(CASE WHEN archived <> 0 THEN 1 ELSE 0 END)' : '0'} AS archived,
          ${schema.columns.has('cwd') ? "COUNT(DISTINCT NULLIF(cwd, ''))" : '0'} AS projects,
          ${schema.columns.has('tokens_used') ? 'COALESCE(SUM(tokens_used), 0)' : '0'} AS tokens_used
         FROM threads`,
      ).get() as Record<string, SQLOutputValue>
      return {
        items: rows.map((row) => toSummary(row, this.codexHome)),
        total,
        page: safePage,
        pageSize,
        pages,
        stats: {
          total: asNumber(stats.total),
          active: asNumber(stats.active),
          archived: asNumber(stats.archived),
          projects: asNumber(stats.projects),
          tokensUsed: asNumber(stats.tokens_used),
        },
        schema: schema.status,
      }
    } finally {
      database.close()
    }
  }

  async detail(sessionId: string): Promise<CodexSessionDetail> {
    const { row, schema } = this.readThread(sessionId)
    if (!schema.status.readable) throw new Error(schema.status.reason)
    const rolloutPath = await validateRollout(this.codexHome, row.rolloutPath, row.id)
    const messages: CodexSessionMessage[] = []
    const messageStats = await streamMessages(rolloutPath, this.maxJsonLineBytes, (message) => {
      messages.push(message)
      if (messages.length > DETAIL_MESSAGE_LIMIT) messages.shift()
    })
    return {
      session: toSummary(row, this.codexHome),
      messages,
      messageStats,
      messagesTruncated: messageStats.total > messages.length,
    }
  }

  async exportMarkdown(sessionId: string, destinationPath: string): Promise<CodexSessionExportResult> {
    const { row } = this.readThread(sessionId)
    const rolloutPath = await validateRollout(this.codexHome, row.rolloutPath, row.id)
    let outputPath = path.resolve(destinationPath)
    try {
      if ((await fsPromises.stat(outputPath)).isDirectory()) {
        outputPath = path.join(outputPath, safeMarkdownFileName(row.title, row.id))
      }
    } catch {
      if (!path.extname(outputPath)) outputPath = path.join(outputPath, safeMarkdownFileName(row.title, row.id))
    }
    if (path.extname(outputPath).toLowerCase() !== '.md') throw new Error('会话导出文件必须使用 .md 扩展名')
    await fsPromises.mkdir(path.dirname(outputPath), { recursive: true })
    // 先写同目录临时文件，成功后 rename 原子覆盖，避免失败时破坏用户已有文件。
    const tempPath = `${outputPath}.${randomUUID()}.tmp`
    const outputHandle = await fsPromises.open(tempPath, 'wx', 0o600)
    const output = outputHandle.createWriteStream({ encoding: 'utf8' })
    try {
      await writeChunk(output, `# ${markdownHeadingText(row.title || row.id)}\n\n`)
      await writeChunk(output, `- 会话 ID：\`${row.id}\`\n`)
      if (row.cwd) await writeChunk(output, `- 工作目录：\`${row.cwd.replaceAll('`', '\\`')}\`\n`)
      if (row.model) await writeChunk(output, `- 模型：\`${row.model.replaceAll('`', '\\`')}\`\n`)
      await writeChunk(output, '\n---\n\n')
      const stats = await streamMessages(rolloutPath, this.maxJsonLineBytes, async (message) => {
        await writeChunk(output, `## ${markdownHeadingText(roleLabel(message.role))}\n\n${message.text}\n\n`)
      })
      await endStream(output)
      await fsPromises.rename(tempPath, outputPath)
      return { sessionId, outputPath, messages: stats.total }
    } catch (error) {
      output.destroy()
      await fsPromises.rm(tempPath, { force: true })
      throw error
    }
  }

  archive(sessionId: string): Promise<CodexSessionMutationResult> {
    return this.enqueueMutation(() => this.changeArchiveState(sessionId, true))
  }

  restore(sessionId: string): Promise<CodexSessionMutationResult> {
    return this.enqueueMutation(() => this.changeArchiveState(sessionId, false))
  }

  private readThread(sessionId: string): { row: ThreadRow; schema: ThreadSchema } {
    if (!databaseExists(this.databasePath)) throw new Error('未找到 Codex 会话数据库')
    const database = openReadOnly(this.databasePath)
    try {
      const schema = inspectSchema(database)
      return { row: getThread(database, schema, sessionId), schema }
    } finally {
      database.close()
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private async createBackup(operation: 'archive' | 'restore', sessionId: string): Promise<string> {
    await fsPromises.mkdir(this.backupDirectory, { recursive: true })
    await fsPromises.mkdir(this.trashDirectory, { recursive: true })
    const timestamp = new Date(this.now()).toISOString().replaceAll(':', '-').replaceAll('.', '-')
    const targetPath = path.join(
      this.backupDirectory,
      `state_5-${timestamp}-${operation}-${sessionId.slice(0, 8)}-${randomUUID().slice(0, 8)}.sqlite`,
    )
    const source = openReadOnly(this.databasePath)
    try {
      await backup(source, targetPath)
    } finally {
      source.close()
    }
    const handle = await fsPromises.open(targetPath, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      this.cleanupBackups(targetPath)
    } catch {
      // Cleanup is best-effort; an unreadable journal must never delete backups.
    }
    return targetPath
  }

  private cleanupBackups(currentBackupPath: string): void {
    // Journal-referenced backups are the last line of defense for interrupted
    // operations, so the protected set is resolved before anything is deleted.
    const protectedPaths = new Set(
      this.interruptedOperations().map((entry) => normalizeForComparison(entry.backupPath)),
    )
    protectedPaths.add(normalizeForComparison(currentBackupPath))
    const candidates: Array<{ filePath: string; mtimeMs: number }> = []
    for (const entry of fs.readdirSync(this.backupDirectory, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      if (!entry.name.startsWith('state_5-') || !entry.name.endsWith('.sqlite')) continue
      const filePath = path.join(this.backupDirectory, entry.name)
      if (protectedPaths.has(normalizeForComparison(filePath))) continue
      try {
        const info = fs.lstatSync(filePath)
        if (!info.isFile() || info.isSymbolicLink()) continue
        candidates.push({ filePath, mtimeMs: info.mtimeMs })
      } catch {
        // A vanished entry needs no cleanup.
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
    const cutoff = this.now() - BACKUP_RETENTION_MS
    for (const [index, candidate] of candidates.entries()) {
      if (index < MAX_RETAINED_BACKUPS && candidate.mtimeMs >= cutoff) continue
      try {
        fs.rmSync(candidate.filePath, { force: true })
      } catch {
        // Leftover backups are retried on the next mutation.
      }
    }
  }

  private async appendJournal(entry: JournalEntry): Promise<void> {
    await fsPromises.mkdir(this.managerDataDirectory, { recursive: true })
    const handle = await fsPromises.open(this.operationJournalPath, 'a', 0o600)
    try {
      await handle.write(`${JSON.stringify(entry)}\n`, undefined, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  private appendJournalSync(entry: JournalEntry): void {
    fs.mkdirSync(this.managerDataDirectory, { recursive: true })
    const descriptor = fs.openSync(this.operationJournalPath, 'a', 0o600)
    try {
      fs.writeSync(descriptor, `${JSON.stringify(entry)}\n`, undefined, 'utf8')
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
  }

  private interruptedOperations(): RecoveryJournalEntry[] {
    let contents: string
    try {
      contents = readBoundedUtf8FileSync(
        this.operationJournalPath,
        MAX_OPERATION_JOURNAL_BYTES,
        'Codex 会话操作日志',
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const latest = new Map<string, JournalEntry>()
    const lines = contents.split(/\r?\n/)
    const partialLastLine = !/\r?\n$/.test(contents) ? lines.length - 1 : -1
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as unknown
        if (isJournalEntry(entry)) {
          latest.set(entry.operationId, entry)
        } else {
          this.warnRecovery('journal-invalid-line', 'Codex 会话操作日志包含结构无效的记录', {
            lineNumber: index + 1,
            errorCode: 'INVALID_RECORD',
          })
        }
      } catch (error) {
        if (index === partialLastLine && isExplicitlyTruncatedJson(line, error)) continue
        this.warnRecovery('journal-invalid-line', 'Codex 会话操作日志包含无法解析的记录', {
          lineNumber: index + 1,
          errorCode: recoveryErrorCode(error),
        })
      }
    }
    return [...latest.values()].filter(
      (entry): entry is RecoveryJournalEntry => entry.state === 'pending' || entry.state === 'ready',
    )
  }

  private warnRecovery(
    code: CodexSessionRecoveryWarningCode,
    message: string,
    detail: CodexSessionRecoveryWarning['detail'],
  ): void {
    if (this.recoveryWarningsEmitted >= MAX_RECOVERY_WARNING_DETAILS) {
      this.recoveryWarningsSuppressed += 1
      return
    }
    this.recoveryWarningsEmitted += 1
    try {
      this.onRecoveryWarning({ code, message, detail })
    } catch {
      // Recovery observability must not turn an otherwise recoverable startup into a crash.
    }
  }

  private flushSuppressedRecoveryWarnings(): void {
    if (this.recoveryWarningsSuppressed === 0) return
    const suppressedWarnings = this.recoveryWarningsSuppressed
    this.recoveryWarningsSuppressed = 0
    try {
      this.onRecoveryWarning({
        code: 'recovery-warnings-suppressed',
        message: 'Codex 会话启动恢复产生过多告警，已省略其余明细',
        detail: { suppressedWarnings },
      })
    } catch {
      // The summary is best-effort and must not make startup fail.
    }
  }

  private recoveryPaths(entry: RecoveryJournalEntry): { sourcePath: string; targetPath: string } {
    const sourcePath = ensureInside(this.codexHome, entry.sourcePath, '恢复源文件')
    const targetPath = ensureInside(this.codexHome, entry.targetPath, '恢复目标文件')
    const sessionsDirectory = path.join(this.codexHome, 'sessions')
    const archivedDirectory = path.join(this.codexHome, 'archived_sessions')
    const validLayout = entry.operation === 'archive'
      ? isInside(sessionsDirectory, sourcePath) && isInside(archivedDirectory, targetPath)
      : isInside(archivedDirectory, sourcePath) && isInside(sessionsDirectory, targetPath)
    if (!validLayout) throw new Error('中断操作路径不符合 Codex 会话目录结构')
    return { sourcePath, targetPath }
  }

  private recoverInterruptedOperations(): void {
    let interrupted: RecoveryJournalEntry[]
    try {
      interrupted = this.interruptedOperations()
    } catch (error) {
      this.warnRecovery('journal-read-failed', 'Codex 会话操作日志读取失败，已跳过启动恢复', {
        errorCode: recoveryErrorCode(error),
      })
      return
    }
    if (interrupted.length === 0) return
    if (!databaseExists(this.databasePath)) {
      this.warnRecovery('database-unavailable', 'Codex 会话数据库不可用，未能执行启动恢复', {
        pendingOperations: interrupted.length,
      })
      return
    }

    for (const entry of interrupted) {
      let database: DatabaseSync | null = null
      let transaction = false
      try {
        const { sourcePath, targetPath } = this.recoveryPaths(entry)
        database = new DatabaseSync(this.databasePath, { allowExtension: false })
        // Startup recovery runs synchronously on the main process; a busy Codex
        // must not block it for seconds — failures are retried on the next start.
        database.exec('PRAGMA busy_timeout = 500; PRAGMA foreign_keys = ON; BEGIN IMMEDIATE')
        transaction = true
        const schema = inspectSchema(database)
        if (!schema.status.mutationsAllowed) throw new Error(schema.status.reason)
        const row = getThread(database, schema, entry.sessionId)
        const expectedArchived = entry.operation === 'archive'
        const databaseCommitted = row.archived === expectedArchived
          && normalizeForComparison(row.rolloutPath) === normalizeForComparison(targetPath)
        const databaseRolledBack = row.archived !== expectedArchived
          && normalizeForComparison(row.rolloutPath) === normalizeForComparison(sourcePath)

        if (databaseCommitted && fs.existsSync(targetPath)) {
          validateRolloutIdentitySync(targetPath, entry.sessionId)
          database.exec('COMMIT')
          transaction = false
          this.appendJournalSync({ ...entry, state: 'committed' })
          continue
        }
        if (databaseRolledBack) {
          const sourceExists = fs.existsSync(sourcePath)
          const targetExists = fs.existsSync(targetPath)
          if (!sourceExists && targetExists) {
            validateRolloutIdentitySync(targetPath, entry.sessionId)
            moveFileDurablySync(targetPath, sourcePath)
          } else if (sourceExists && targetExists) {
            // A crash between link and rm leaves source and target as hard links
            // to the same inode; deleting the target completes the rollback.
            // changeArchiveState defers to this path too when a locked rollout
            // kept it from dropping the extra name in-process.
            const sourceInfo = fs.lstatSync(sourcePath, { bigint: true })
            const targetInfo = fs.lstatSync(targetPath, { bigint: true })
            if (!isSameInodeLinkPair(sourceInfo, targetInfo)) {
              throw new Error('中断操作的 JSONL 文件状态不唯一，已保留现状和备份')
            }
            fs.rmSync(targetPath)
          } else if (!sourceExists) {
            throw new Error('中断操作的 JSONL 文件状态不唯一，已保留现状和备份')
          }
          database.exec('COMMIT')
          transaction = false
          this.appendJournalSync({ ...entry, state: 'rolled-back', error: '启动时已恢复未提交操作' })
          continue
        }
        throw new Error('SQLite 会话状态已变化，已保留中断操作和备份')
      } catch (error) {
        if (transaction && database) {
          try { database.exec('ROLLBACK') } catch { /* Preserve all artifacts for manual recovery. */ }
        }
        this.warnRecovery('operation-recovery-failed', 'Codex 会话中断操作自动恢复失败，已保留现状和备份', {
          operation: entry.operation,
          errorCode: recoveryErrorCode(error),
        })
      } finally {
        database?.close()
      }
    }
  }

  private async originalActivePath(sessionId: string, currentPath: string): Promise<string | null> {
    try {
      const before = await fsPromises.stat(this.operationJournalPath)
      if (!before.isFile() || before.size > MAX_OPERATION_JOURNAL_BYTES) {
        throw new Error('Codex 会话操作日志超过 64 MB 安全上限')
      }
      const input = fs.createReadStream(this.operationJournalPath, {
        encoding: 'utf8',
        start: 0,
        end: MAX_OPERATION_JOURNAL_BYTES - 1,
      })
      const lines = readline.createInterface({ input, crlfDelay: Infinity })
      let original: string | null = null
      try {
        for await (const line of lines) {
          if (!line.trim()) continue
          let entry: JournalEntry
          try {
            entry = JSON.parse(line) as JournalEntry
          } catch {
            continue
          }
          if (
            entry.sessionId === sessionId
            && entry.operation === 'archive'
            && entry.state === 'committed'
            && normalizeForComparison(entry.targetPath) === normalizeForComparison(currentPath)
          ) original = entry.sourcePath
        }
      } finally {
        lines.close()
        input.destroy()
      }
      const after = await fsPromises.stat(this.operationJournalPath)
      if (after.size !== before.size) throw new Error('Codex 会话操作日志在读取过程中发生变化')
      return original
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async archiveTarget(row: ThreadRow, sourcePath: string, archived: boolean): Promise<string> {
    if (archived) {
      const directory = ensureInside(this.codexHome, path.join(this.codexHome, 'archived_sessions'), '归档目录')
      await fsPromises.mkdir(directory, { recursive: true })
      return availableTarget(directory, path.basename(sourcePath), row.id)
    }
    const recorded = await this.originalActivePath(row.id, sourcePath)
    if (recorded && isInside(path.join(this.codexHome, 'sessions'), recorded)) {
      try {
        await fsPromises.access(recorded)
      } catch {
        return ensureInside(this.codexHome, recorded, '恢复目录')
      }
    }
    const recoveredDirectory = ensureInside(
      this.codexHome,
      path.join(this.codexHome, 'sessions', 'recovered'),
      '恢复目录',
    )
    await fsPromises.mkdir(recoveredDirectory, { recursive: true })
    return availableTarget(recoveredDirectory, path.basename(sourcePath), row.id)
  }

  private async changeArchiveState(sessionId: string, archived: boolean): Promise<CodexSessionMutationResult> {
    const { row, schema } = this.readThread(sessionId)
    if (!schema.status.mutationsAllowed) throw new Error(schema.status.reason)
    if (row.archived === archived) {
      throw new Error(archived ? '会话已经归档' : '会话已经处于活动状态')
    }
    const sourcePath = await validateRollout(this.codexHome, row.rolloutPath, row.id)
    const targetPath = ensureInside(
      this.codexHome,
      await this.archiveTarget(row, sourcePath, archived),
      archived ? '归档目标' : '恢复目标',
    )
    const operation = archived ? 'archive' : 'restore'
    const operationId = randomUUID()
    const backupPath = await this.createBackup(operation, row.id)
    const journalBase = {
      operationId,
      sessionId: row.id,
      operation,
      sourcePath,
      targetPath,
      backupPath,
      timestamp: new Date(this.now()).toISOString(),
    } as const
    await this.appendJournal({ ...journalBase, state: 'pending' })

    const database = new DatabaseSync(this.databasePath, { allowExtension: false })
    database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    let moved = false
    let transaction = false
    let committed = false
    try {
      database.exec('BEGIN IMMEDIATE')
      transaction = true
      const liveSchema = inspectSchema(database)
      if (!liveSchema.status.mutationsAllowed) throw new Error(liveSchema.status.reason)
      const liveRow = getThread(database, liveSchema, row.id)
      if (liveRow.archived !== row.archived || normalizeForComparison(liveRow.rolloutPath) !== normalizeForComparison(row.rolloutPath)) {
        throw new Error('会话在备份期间已被 Codex 修改，请刷新后重试')
      }
      const update = database.prepare(mutationUpdateSql(liveSchema.columns)).run(
        ...mutationUpdateValues(liveSchema.columns, archived, targetPath, this.now(), row.id),
      )
      if (Number(update.changes) !== 1) throw new Error('会话索引更新失败')
      await moveFileDurably(sourcePath, targetPath)
      moved = true
      await this.hooks.afterMoveBeforeCommit?.(sourcePath, targetPath)
      await this.appendJournal({ ...journalBase, state: 'ready' })
      database.exec('COMMIT')
      transaction = false
      committed = true
      // The durable "ready" record is written before COMMIT. A final journal
      // append failure must not move the JSONL back after SQLite has committed.
      await this.appendJournal({ ...journalBase, state: 'committed' }).catch(() => undefined)
      return {
        sessionId: row.id,
        archived,
        backupPath,
        rolloutPath: targetPath,
        operationId,
      }
    } catch (error) {
      if (transaction) {
        try { database.exec('ROLLBACK') } catch { /* The online backup remains available. */ }
      }
      let rollbackError: unknown = null
      let unresolvedLinkPair = false
      if (!committed) {
        try {
          const sourceExists = await fsPromises.access(sourcePath).then(() => true, () => false)
          const targetExists = await fsPromises.access(targetPath).then(() => true, () => false)
          if (moved || (!sourceExists && targetExists)) {
            await moveFileDurably(targetPath, sourcePath)
          } else if (sourceExists && targetExists) {
            // moveFileDurably linked the target, then failed to unlink the
            // source *and* failed to drop the target again. A Windows scanner
            // holding both names without FILE_SHARE_DELETE produces exactly
            // this. The rollout is now nlink=2, which validateRollout refuses,
            // so leaving it here would make the session permanently unusable —
            // including the "archive again to heal it" path.
            const sourceInfo = await fsPromises.lstat(sourcePath, { bigint: true })
            const targetInfo = await fsPromises.lstat(targetPath, { bigint: true })
            if (isSameInodeLinkPair(sourceInfo, targetInfo)) {
              // Dropping the extra name completes the rollback. While it stays
              // locked the operation must remain recoverable: recording
              // 'rolled-back' would hide it from startup recovery, which is
              // the only code that can still repair the link pair.
              unresolvedLinkPair = await fsPromises.rm(targetPath).then(() => false, () => true)
            }
          }
        } catch (moveError) {
          rollbackError = moveError
        }
      }
      const failureMessage = error instanceof Error ? error.message : String(error)
      await this.appendJournal({
        ...journalBase,
        state: rollbackError
          ? 'ready'
          : unresolvedLinkPair
            ? 'pending'
            : 'rolled-back',
        error: rollbackError
          ? `${failureMessage}；JSONL 自动回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
          : unresolvedLinkPair
            ? `${failureMessage}；JSONL 目标副本仍被占用，将在下次启动时自动清理`
            : failureMessage,
      }).catch(() => undefined)
      if (rollbackError) {
        throw new Error(`会话操作失败，JSONL 自动回滚未完成；已保留 SQLite 备份和恢复日志：${backupPath}`)
      }
      if (unresolvedLinkPair) {
        throw new Error(`会话操作失败，会话文件正被其他程序占用；请关闭占用它的程序（如杀毒或备份软件）后重启本工具，将自动修复：${backupPath}`)
      }
      throw error
    } finally {
      database.close()
    }
  }
}
