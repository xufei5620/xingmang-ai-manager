import fs from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CodexSessionsService,
  type CodexSessionRecoveryWarning,
  type CodexSessionsOptions,
} from './codex-sessions'

const temporaryDirectories: string[] = []
const openDatabases: DatabaseSync[] = []

interface Fixture {
  root: string
  codexHome: string
  managerData: string
  databasePath: string
  rolloutPath: string
}

function fixture(sessionId = 'session-1'): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-sessions-test-'))
  temporaryDirectories.push(root)
  const codexHome = path.join(root, '.codex')
  const managerData = path.join(root, 'manager-data')
  const sessionDirectory = path.join(codexHome, 'sessions', '2026', '07', '24')
  fs.mkdirSync(sessionDirectory, { recursive: true })
  const rolloutPath = path.join(sessionDirectory, `rollout-${sessionId}.jsonl`)
  writeRollout(rolloutPath, sessionId)
  return {
    root,
    codexHome,
    managerData,
    databasePath: path.join(codexHome, 'state_5.sqlite'),
    rolloutPath,
  }
}

function writeRollout(filePath: string, sessionId: string, extraLines: string[] = []): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const entries = [
    JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: 'C:/project' } }),
    JSON.stringify({
      timestamp: '2026-07-24T01:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '请检查项目' }] },
    }),
    JSON.stringify({
      timestamp: '2026-07-24T01:00:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '检查完成' }] },
    }),
    ...extraLines,
  ]
  fs.writeFileSync(filePath, `${entries.join('\n')}\n`, 'utf8')
}

function createThreadsDatabase(databasePath: string, wal = false): DatabaseSync {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  if (wal) database.exec('PRAGMA journal_mode = WAL')
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model TEXT,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      updated_at_ms INTEGER
    )
  `)
  return database
}

function insertThread(
  database: DatabaseSync,
  values: {
    id: string
    rolloutPath: string
    title?: string
    cwd?: string
    archived?: boolean
    updatedAt?: number
    tokens?: number
  },
): void {
  const updatedAt = values.updatedAt ?? 1_721_780_000
  database.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, title, cwd, model_provider,
      model, tokens_used, archived, archived_at, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.id,
    values.rolloutPath,
    updatedAt - 100,
    updatedAt,
    values.title ?? values.id,
    values.cwd ?? 'C:/project',
    'xingmang',
    'gpt-5.6-sol',
    values.tokens ?? 10,
    values.archived ? 1 : 0,
    values.archived ? updatedAt : null,
    updatedAt * 1000,
  )
}

function service(data: Fixture, hooks?: CodexSessionsOptions['hooks']): CodexSessionsService {
  return new CodexSessionsService({
    codexHome: data.codexHome,
    databasePath: data.databasePath,
    managerDataDirectory: data.managerData,
    now: () => 1_721_800_000_123,
    hooks,
  })
}

function lastJournalEntry(journalPath: string): Record<string, unknown> {
  const lines = fs.readFileSync(journalPath, 'utf8').split(/\r?\n/).filter((line) => line.trim())
  return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>
}

function sameInode(left: string, right: string): boolean {
  const leftInfo = fs.lstatSync(left, { bigint: true })
  const rightInfo = fs.lstatSync(right, { bigint: true })
  return leftInfo.dev === rightInfo.dev && leftInfo.ino === rightInfo.ino
}

/**
 * Reproduces the Windows failure this guards against: a scanner holding the
 * rollout without FILE_SHARE_DELETE makes every unlink fail with EPERM while
 * the hard link created by moveFileDurably survives. Verified against a real
 * FileShare.Read handle on Windows; mocked here so it runs on every platform.
 */
function refuseUnlink(paths: readonly string[], options: { releaseTargetAfter?: number } = {}): () => void {
  const blocked = new Set(paths)
  const realRm = fsPromises.rm
  let attempts = 0
  const spy = vi.spyOn(fsPromises, 'rm').mockImplementation(async (target, rmOptions) => {
    if (blocked.has(String(target))) {
      attempts += 1
      if (options.releaseTargetAfter === undefined || attempts <= options.releaseTargetAfter) {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' })
      }
      if (String(target) === paths[0]) {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' })
      }
    }
    return realRm(target, rmOptions)
  })
  return () => spy.mockRestore()
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const database of openDatabases.splice(0)) {
    try { database.close() } catch { /* Already closed by the test. */ }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('CodexSessionsService', () => {
  it.each([
    { label: 'empty', value: '' },
    { label: 'whitespace', value: '   ' },
    { label: 'relative', value: 'relative-codex' },
    { label: 'NUL', value: `invalid\0codex` },
  ])('rejects an explicitly configured $label CODEX_HOME', ({ value }) => {
    const data = fixture()

    expect(() => new CodexSessionsService({
      codexHome: value,
      managerDataDirectory: data.managerData,
    })).toThrow('CODEX_HOME')
  })

  it('trims an explicitly configured absolute CODEX_HOME', () => {
    const data = fixture()
    const selected = `  ${data.codexHome}  `

    const sessions = new CodexSessionsService({
      codexHome: selected,
      managerDataDirectory: data.managerData,
    })

    expect(sessions.codexHome).toBe(path.resolve(data.codexHome))
    expect(sessions.databasePath).toBe(path.join(data.codexHome, 'state_5.sqlite'))
  })

  it('keeps the legacy homedir fallback even when process.env.CODEX_HOME is set', () => {
    const data = fixture()
    vi.stubEnv('CODEX_HOME', path.join(data.root, 'wrong-codex'))

    const sessions = new CodexSessionsService({ managerDataDirectory: data.managerData })

    expect(sessions.codexHome).toBe(path.join(os.homedir(), '.codex'))
  })

  it('uses the live WAL threads table as the authoritative paged and searchable index', () => {
    const data = fixture('session-1')
    fs.writeFileSync(
      path.join(data.codexHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: 'stale-index-only-session', title: '旧索引会话' })}\n`,
      'utf8',
    )
    const database = createThreadsDatabase(data.databasePath, true)
    openDatabases.push(database)
    insertThread(database, {
      id: 'session-1', rolloutPath: data.rolloutPath, title: '支付项目', cwd: 'C:/pay', updatedAt: 300, tokens: 20,
    })
    const secondRollout = path.join(data.codexHome, 'archived_sessions', 'rollout-session-2.jsonl')
    writeRollout(secondRollout, 'session-2')
    insertThread(database, {
      id: 'session-2', rolloutPath: secondRollout, title: '历史会话', cwd: 'C:/old', archived: true, updatedAt: 200, tokens: 30,
    })
    const thirdRollout = path.join(data.codexHome, 'sessions', 'rollout-session-3.jsonl')
    writeRollout(thirdRollout, 'session-3')
    insertThread(database, {
      id: 'session-3', rolloutPath: thirdRollout, title: '其他会话', cwd: 'C:/pay', updatedAt: 100, tokens: 40,
    })

    const firstPage = service(data).list({ page: 1, pageSize: 2 })
    expect(firstPage.items.map((item) => item.id)).toEqual(['session-1', 'session-2'])
    expect(firstPage).toMatchObject({ total: 3, page: 1, pageSize: 2, pages: 2 })
    expect(firstPage.stats).toEqual({ total: 3, active: 2, archived: 1, projects: 2, tokensUsed: 90 })
    expect(firstPage.schema.mutationsAllowed).toBe(true)

    const searched = service(data).list({ search: '支付', archive: 'active' })
    expect(searched.items.map((item) => item.id)).toEqual(['session-1'])
  })

  it('does not fall back to session_index.jsonl when the authoritative SQLite database is missing', () => {
    const data = fixture('session-1')
    fs.writeFileSync(
      path.join(data.codexHome, 'session_index.jsonl'),
      `${JSON.stringify({ id: 'index-only-session', title: '不完整旧索引' })}\n`,
      'utf8',
    )

    expect(service(data).list()).toMatchObject({
      items: [],
      total: 0,
      schema: { kind: 'missing', readable: false, mutationsAllowed: false },
    })
  })

  it('does not open an authoritative SQLite database with multiple hard links', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    fs.linkSync(data.databasePath, path.join(data.codexHome, 'state-linked.sqlite'))

    expect(service(data).list()).toMatchObject({
      items: [],
      schema: { kind: 'missing', readable: false, mutationsAllowed: false },
    })
  })

  it('falls back to second timestamps when nullable millisecond columns are empty', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, {
      id: 'session-1', rolloutPath: data.rolloutPath, updatedAt: 321,
    })
    database.exec('ALTER TABLE threads ADD COLUMN created_at_ms INTEGER')
    database.prepare('UPDATE threads SET created_at_ms = NULL, updated_at_ms = NULL WHERE id = ?').run('session-1')
    database.close()

    expect(service(data).list().items[0]).toMatchObject({
      id: 'session-1',
      createdAt: 221_000,
      updatedAt: 321_000,
    })
  })

  it('accepts Codex Windows namespace rollout paths as paths inside CODEX_HOME', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    const namespacedPath = path.toNamespacedPath(data.rolloutPath)
    insertThread(database, { id: 'session-1', rolloutPath: namespacedPath })
    database.close()

    const sessions = service(data)
    expect(sessions.list().items[0].rolloutAvailable).toBe(true)
    await expect(sessions.detail('session-1')).resolves.toMatchObject({
      session: { id: 'session-1', rolloutAvailable: true },
    })
  })

  it('keeps an unrecognized threads schema read-only and disables mutations', async () => {
    const data = fixture('session-1')
    const database = new DatabaseSync(data.databasePath)
    database.exec('CREATE TABLE threads (session_id TEXT PRIMARY KEY, payload TEXT)')
    database.close()

    const sessions = service(data)
    const page = sessions.list()
    expect(page.schema).toMatchObject({ kind: 'unsupported', readable: false, mutationsAllowed: false })
    await expect(sessions.archive('session-1')).rejects.toThrow('schema')
  })

  it('rejects a rollout path that traverses outside CODEX_HOME', async () => {
    const data = fixture('session-1')
    const outside = path.join(data.root, 'outside.jsonl')
    writeRollout(outside, 'session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: outside })
    database.close()

    await expect(service(data).detail('session-1')).rejects.toThrow('CODEX_HOME')
  })

  it('rejects a rollout whose first session_meta.id does not match SQLite', async () => {
    const data = fixture('session-1')
    writeRollout(data.rolloutPath, 'different-session')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()

    await expect(service(data).detail('session-1')).rejects.toThrow('session_meta.id')
  })

  it('rejects an oversized first metadata line before parsing the rollout', async () => {
    const data = fixture('session-1')
    fs.writeFileSync(data.rolloutPath, JSON.stringify({
      type: 'session_meta',
      payload: { id: 'session-1', padding: 'x'.repeat(1024 * 1024) },
    }), 'utf8')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()

    await expect(service(data).detail('session-1')).rejects.toThrow('1024 KB 安全上限')
  })

  it('marks a multiply-linked rollout unavailable and refuses to read it', async () => {
    const data = fixture('session-1')
    fs.linkSync(data.rolloutPath, path.join(path.dirname(data.rolloutPath), 'linked-rollout.jsonl'))
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()

    const sessions = service(data)
    expect(sessions.list().items[0].rolloutAvailable).toBe(false)
    await expect(sessions.detail('session-1')).rejects.toThrow('单链接普通文件')
  })

  it('streams message details and Markdown export without accepting damaged JSON lines as messages', async () => {
    const data = fixture('session-1')
    fs.appendFileSync(data.rolloutPath, '{broken-json\n', 'utf8')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath, title: '导出测试' })
    database.close()

    const sessions = service(data)
    const detail = await sessions.detail('session-1')
    expect(detail.messages.map((message) => message.text)).toEqual(['请检查项目', '检查完成'])
    expect(detail.messageStats).toMatchObject({ total: 2, user: 1, assistant: 1, invalidLines: 1 })

    const outputPath = path.join(data.root, 'exports', 'session.md')
    const exported = await sessions.exportMarkdown('session-1', outputPath)
    expect(exported).toMatchObject({ sessionId: 'session-1', outputPath, messages: 2 })
    expect(fs.readFileSync(outputPath, 'utf8')).toContain('## Codex\n\n检查完成')

    const reExported = await sessions.exportMarkdown('session-1', outputPath)
    expect(reExported).toMatchObject({ sessionId: 'session-1', outputPath, messages: 2 })
    expect(fs.readdirSync(path.dirname(outputPath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps an existing non-.md file intact when export fails on extension validation', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const notesPath = path.join(data.root, 'notes.txt')
    fs.writeFileSync(notesPath, '用户原有内容', 'utf8')

    await expect(service(data).exportMarkdown('session-1', notesPath)).rejects.toThrow('.md 扩展名')
    expect(fs.readFileSync(notesPath, 'utf8')).toBe('用户原有内容')
  })

  it('drops an oversized JSONL record while preserving later valid messages', async () => {
    const data = fixture('session-1')
    const laterMessage = JSON.stringify({
      timestamp: '2026-07-24T01:00:02.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '后续消息' }] },
    })
    fs.appendFileSync(data.rolloutPath, `${JSON.stringify({ padding: 'x'.repeat(300) })}\n${laterMessage}\n`, 'utf8')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const sessions = new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      maxJsonLineBytes: 256,
    })

    const detail = await sessions.detail('session-1')

    expect(detail.messages.map((message) => message.text)).toEqual(['请检查项目', '检查完成', '后续消息'])
    expect(detail.messageStats).toMatchObject({ total: 3, invalidLines: 1 })
  })

  it('creates an online SQLite backup before archive and restores the original active path', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath, true)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath, title: '可归档会话' })
    database.close()

    const sessions = service(data)
    const archived = await sessions.archive('session-1')
    expect(fs.existsSync(archived.backupPath)).toBe(true)
    expect(fs.existsSync(data.rolloutPath)).toBe(false)
    expect(archived.rolloutPath).toContain(`${path.sep}archived_sessions${path.sep}`)
    expect(fs.existsSync(archived.rolloutPath)).toBe(true)
    const backupDatabase = new DatabaseSync(archived.backupPath, { readOnly: true })
    expect(backupDatabase.prepare('SELECT archived, rollout_path FROM threads WHERE id = ?').get('session-1'))
      .toMatchObject({ archived: 0, rollout_path: data.rolloutPath })
    backupDatabase.close()

    const liveAfterArchive = new DatabaseSync(data.databasePath, { readOnly: true })
    expect(liveAfterArchive.prepare('SELECT archived, rollout_path FROM threads WHERE id = ?').get('session-1'))
      .toMatchObject({ archived: 1, rollout_path: archived.rolloutPath })
    expect(liveAfterArchive.prepare('SELECT updated_at, updated_at_ms FROM threads WHERE id = ?').get('session-1'))
      .toMatchObject({ updated_at: 1_721_780_000, updated_at_ms: 1_721_780_000_000 })
    liveAfterArchive.close()

    const restored = await sessions.restore('session-1')
    expect(restored.archived).toBe(false)
    expect(restored.rolloutPath).toBe(data.rolloutPath)
    expect(fs.existsSync(data.rolloutPath)).toBe(true)
    expect(fs.existsSync(archived.rolloutPath)).toBe(false)
    const operations = fs.readFileSync(sessions.operationJournalPath, 'utf8')
      .trim().split(/\r?\n/).map((line) => JSON.parse(line) as { state: string })
    expect(operations.filter((entry) => entry.state === 'committed')).toHaveLength(2)
  })

  it('never overwrites an existing archive target with the same basename', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const directTarget = path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath))
    fs.mkdirSync(path.dirname(directTarget), { recursive: true })
    fs.writeFileSync(directTarget, 'existing archive', 'utf8')

    const archived = await service(data).archive('session-1')

    expect(archived.rolloutPath).not.toBe(directTarget)
    expect(fs.readFileSync(directTarget, 'utf8')).toBe('existing archive')
  })

  it('recovers a JSONL move when the process stopped before the SQLite transaction committed', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const targetPath = path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath))
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.renameSync(data.rolloutPath, targetPath)
    fs.mkdirSync(data.managerData, { recursive: true })
    const journalBase = {
      operationId: 'recover-operation',
      sessionId: 'session-1',
      operation: 'archive',
      sourcePath: data.rolloutPath,
      targetPath,
      backupPath: path.join(data.managerData, 'backups', 'state_5.sqlite'),
      timestamp: '2026-07-24T01:00:00.000Z',
    }
    fs.writeFileSync(
      path.join(data.managerData, 'operations.jsonl'),
      `${JSON.stringify({ ...journalBase, state: 'pending' })}\n${JSON.stringify({ ...journalBase, state: 'ready' })}\n`,
      'utf8',
    )

    const sessions = service(data)
    expect(fs.existsSync(data.rolloutPath)).toBe(true)
    expect(fs.existsSync(targetPath)).toBe(false)
    expect(fs.readFileSync(sessions.operationJournalPath, 'utf8')).toContain('启动时已恢复未提交操作')
    expect(sessions.list().items[0]).toMatchObject({ archived: false, rolloutAvailable: true })
  })

  it('recovers duplicate hard links left by a crash between link and unlink', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const targetPath = path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath))
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.linkSync(data.rolloutPath, targetPath)
    fs.mkdirSync(data.managerData, { recursive: true })
    fs.writeFileSync(path.join(data.managerData, 'operations.jsonl'), `${JSON.stringify({
      operationId: 'linked-operation',
      sessionId: 'session-1',
      operation: 'archive',
      state: 'pending',
      sourcePath: data.rolloutPath,
      targetPath,
      backupPath: path.join(data.managerData, 'backups', 'state_5.sqlite'),
      timestamp: '2026-07-24T01:00:00.000Z',
    })}\n`, 'utf8')

    const sessions = service(data)

    expect(fs.existsSync(data.rolloutPath)).toBe(true)
    expect(fs.existsSync(targetPath)).toBe(false)
    expect(fs.readFileSync(sessions.operationJournalPath, 'utf8')).toContain('"state":"rolled-back"')
    expect(sessions.list().items[0]).toMatchObject({ archived: false, rolloutAvailable: true })
  })

  it('keeps refusing recovery when source and target are different files', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const targetPath = path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath))
    writeRollout(targetPath, 'session-1')
    fs.mkdirSync(data.managerData, { recursive: true })
    fs.writeFileSync(path.join(data.managerData, 'operations.jsonl'), `${JSON.stringify({
      operationId: 'ambiguous-operation',
      sessionId: 'session-1',
      operation: 'archive',
      state: 'pending',
      sourcePath: data.rolloutPath,
      targetPath,
      backupPath: path.join(data.managerData, 'backups', 'state_5.sqlite'),
      timestamp: '2026-07-24T01:00:00.000Z',
    })}\n`, 'utf8')
    const warnings: CodexSessionRecoveryWarning[] = []

    new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      onRecoveryWarning: (warning) => warnings.push(warning),
    })

    expect(fs.existsSync(data.rolloutPath)).toBe(true)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(warnings).toMatchObject([{ code: 'operation-recovery-failed' }])
  })

  it('prunes stale backups while keeping journal-referenced recovery backups', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const backupDirectory = path.join(data.managerData, 'backups')
    fs.mkdirSync(backupDirectory, { recursive: true })
    const staleBackup = path.join(backupDirectory, 'state_5-old-archive-stale.sqlite')
    const protectedBackup = path.join(backupDirectory, 'state_5-old-archive-referenced.sqlite')
    const unrelatedFile = path.join(backupDirectory, 'unrelated-notes.txt')
    const oldTime = new Date(1_721_800_000_123 - 8 * 24 * 60 * 60 * 1000)
    for (const filePath of [staleBackup, protectedBackup, unrelatedFile]) {
      fs.writeFileSync(filePath, 'backup-bytes', 'utf8')
      fs.utimesSync(filePath, oldTime, oldTime)
    }
    fs.writeFileSync(path.join(data.managerData, 'operations.jsonl'), `${JSON.stringify({
      operationId: 'ghost-operation',
      sessionId: 'ghost-session',
      operation: 'archive',
      state: 'pending',
      sourcePath: path.join(data.codexHome, 'sessions', 'rollout-ghost.jsonl'),
      targetPath: path.join(data.codexHome, 'archived_sessions', 'rollout-ghost.jsonl'),
      backupPath: protectedBackup,
      timestamp: '2026-07-24T01:00:00.000Z',
    })}\n`, 'utf8')

    const sessions = new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      now: () => 1_721_800_000_123,
      onRecoveryWarning: () => undefined,
    })
    const archived = await sessions.archive('session-1')

    expect(fs.existsSync(staleBackup)).toBe(false)
    expect(fs.existsSync(protectedBackup)).toBe(true)
    expect(fs.existsSync(unrelatedFile)).toBe(true)
    expect(fs.existsSync(archived.backupPath)).toBe(true)
  })

  it('finalizes a ready journal entry when SQLite and JSONL were already committed', () => {
    const data = fixture('session-1')
    const targetPath = path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath))
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    fs.renameSync(data.rolloutPath, targetPath)
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: targetPath, archived: true })
    database.close()
    fs.mkdirSync(data.managerData, { recursive: true })
    const journalBase = {
      operationId: 'committed-operation',
      sessionId: 'session-1',
      operation: 'archive',
      sourcePath: data.rolloutPath,
      targetPath,
      backupPath: path.join(data.managerData, 'backups', 'state_5.sqlite'),
      timestamp: '2026-07-24T01:00:00.000Z',
    }
    fs.writeFileSync(
      path.join(data.managerData, 'operations.jsonl'),
      `${JSON.stringify({ ...journalBase, state: 'ready' })}\n`,
      'utf8',
    )

    const sessions = service(data)
    expect(fs.readFileSync(sessions.operationJournalPath, 'utf8')).toContain('"state":"committed"')
    expect(sessions.list().items[0]).toMatchObject({ archived: true, rolloutAvailable: true })
  })

  it('reports journal read failures without blocking session startup', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    fs.mkdirSync(data.managerData, { recursive: true })
    fs.mkdirSync(path.join(data.managerData, 'operations.jsonl'))
    const warnings: CodexSessionRecoveryWarning[] = []

    const sessions = new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      onRecoveryWarning: (warning) => warnings.push(warning),
    })

    expect(sessions.list().items).toHaveLength(1)
    expect(warnings).toEqual([{
      code: 'journal-read-failed',
      message: 'Codex 会话操作日志读取失败，已跳过启动恢复',
      detail: { errorCode: 'Error' },
    }])
    expect(JSON.stringify(warnings)).not.toContain(data.root)
  })

  it('warns for malformed journal records but ignores only a clearly truncated final line', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    fs.mkdirSync(data.managerData, { recursive: true })
    fs.writeFileSync(
      path.join(data.managerData, 'operations.jsonl'),
      'not-json\n{"unexpected":"private-session-content"}\n{"operationId":"truncated',
      'utf8',
    )
    const warnings: CodexSessionRecoveryWarning[] = []

    const sessions = new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      onRecoveryWarning: (warning) => warnings.push(warning),
    })

    expect(sessions.list().items).toHaveLength(1)
    expect(warnings).toMatchObject([
      { code: 'journal-invalid-line', detail: { lineNumber: 1, errorCode: 'SyntaxError' } },
      { code: 'journal-invalid-line', detail: { lineNumber: 2, errorCode: 'INVALID_RECORD' } },
    ])
    expect(warnings).toHaveLength(2)
    const serialized = JSON.stringify(warnings)
    expect(serialized).not.toContain('private-session-content')
    expect(serialized).not.toContain(data.root)
  })

  it('caps malformed journal warnings and emits one privacy-safe summary', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    fs.mkdirSync(data.managerData, { recursive: true })
    fs.writeFileSync(
      path.join(data.managerData, 'operations.jsonl'),
      `${Array.from({ length: 100 }, (_, index) => `invalid-private-line-${index}`).join('\n')}\n`,
      'utf8',
    )
    const warnings: CodexSessionRecoveryWarning[] = []

    expect(() => new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      onRecoveryWarning: (warning) => warnings.push(warning),
    })).not.toThrow()

    expect(warnings).toHaveLength(33)
    expect(warnings.slice(0, 32).every((warning) => warning.code === 'journal-invalid-line')).toBe(true)
    expect(warnings.at(-1)).toEqual({
      code: 'recovery-warnings-suppressed',
      message: 'Codex 会话启动恢复产生过多告警，已省略其余明细',
      detail: { suppressedWarnings: 68 },
    })
    const serialized = JSON.stringify(warnings)
    expect(serialized).not.toContain('invalid-private-line')
    expect(serialized).not.toContain(data.root)
  })

  it('reports an unavailable recovery database and tolerates a throwing logger', () => {
    const data = fixture('session-1')
    fs.mkdirSync(data.managerData, { recursive: true })
    fs.writeFileSync(path.join(data.managerData, 'operations.jsonl'), `${JSON.stringify({
      operationId: 'pending-operation',
      sessionId: 'private-session-id',
      operation: 'archive',
      state: 'pending',
      sourcePath: data.rolloutPath,
      targetPath: path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath)),
      backupPath: path.join(data.managerData, 'backups', 'state.sqlite'),
      timestamp: '2026-07-24T01:00:00.000Z',
    })}\n`, 'utf8')
    const warnings: CodexSessionRecoveryWarning[] = []

    expect(() => new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      onRecoveryWarning: (warning) => warnings.push(warning),
    })).not.toThrow()
    expect(warnings).toEqual([{
      code: 'database-unavailable',
      message: 'Codex 会话数据库不可用，未能执行启动恢复',
      detail: { pendingOperations: 1 },
    }])

    fs.writeFileSync(path.join(data.managerData, 'operations.jsonl'), 'not-json\n', 'utf8')
    expect(() => new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      onRecoveryWarning: () => { throw new Error('logger failed') },
    })).not.toThrow()
  })

  it('reports one failed recovery without blocking readable sessions or exposing paths', () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    fs.mkdirSync(data.managerData, { recursive: true })
    const outsidePath = path.join(data.root, 'private-customer', 'rollout.jsonl')
    fs.writeFileSync(path.join(data.managerData, 'operations.jsonl'), `${JSON.stringify({
      operationId: 'failed-recovery',
      sessionId: 'private-session-id',
      operation: 'archive',
      state: 'pending',
      sourcePath: outsidePath,
      targetPath: path.join(data.codexHome, 'archived_sessions', 'rollout.jsonl'),
      backupPath: path.join(data.managerData, 'backups', 'state.sqlite'),
      timestamp: '2026-07-24T01:00:00.000Z',
    })}\n`, 'utf8')
    const warnings: CodexSessionRecoveryWarning[] = []

    const sessions = new CodexSessionsService({
      codexHome: data.codexHome,
      databasePath: data.databasePath,
      managerDataDirectory: data.managerData,
      onRecoveryWarning: (warning) => warnings.push(warning),
    })

    expect(sessions.list().items).toHaveLength(1)
    expect(warnings).toEqual([{
      code: 'operation-recovery-failed',
      message: 'Codex 会话中断操作自动恢复失败，已保留现状和备份',
      detail: { operation: 'archive', errorCode: 'Error' },
    }])
    const serialized = JSON.stringify(warnings)
    expect(serialized).not.toContain('private-session-id')
    expect(serialized).not.toContain(data.root)
  })

  it('rolls the SQLite transaction and JSONL move back when durable synchronization fails', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()

    const sessions = service(data, {
      afterMoveBeforeCommit: () => { throw new Error('injected sync failure') },
    })
    await expect(sessions.archive('session-1')).rejects.toThrow('injected sync failure')

    expect(fs.existsSync(data.rolloutPath)).toBe(true)
    const live = new DatabaseSync(data.databasePath, { readOnly: true })
    expect(live.prepare('SELECT archived, rollout_path FROM threads WHERE id = ?').get('session-1'))
      .toMatchObject({ archived: 0, rollout_path: data.rolloutPath })
    live.close()
    expect(fs.readFileSync(sessions.operationJournalPath, 'utf8')).toContain('rolled-back')
  })

  it('keeps the operation recoverable when a locked rollout leaves both hard links behind', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const sessions = service(data)
    const targetPath = path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath))
    const restore = refuseUnlink([data.rolloutPath, targetPath])

    await expect(sessions.archive('session-1')).rejects.toThrow()
    restore()

    // Both names now point at one inode. validateRollout rejects nlink > 1, so
    // recording 'rolled-back' here would strand the session with no way back.
    expect(fs.existsSync(data.rolloutPath)).toBe(true)
    expect(fs.existsSync(targetPath)).toBe(true)
    expect(sameInode(data.rolloutPath, targetPath)).toBe(true)
    expect(lastJournalEntry(sessions.operationJournalPath).state).toBe('pending')
  })

  it('repairs the leftover hard link on the next start and makes the session usable again', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const failing = service(data)
    const targetPath = path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath))
    const restore = refuseUnlink([data.rolloutPath, targetPath])
    await expect(failing.archive('session-1')).rejects.toThrow()
    restore()
    expect(failing.list().items[0]).toMatchObject({ rolloutAvailable: false })

    // The scanner released the file; starting the app again must self-heal.
    const recovered = service(data)

    expect(fs.existsSync(data.rolloutPath)).toBe(true)
    expect(fs.existsSync(targetPath)).toBe(false)
    expect(lastJournalEntry(recovered.operationJournalPath).state).toBe('rolled-back')
    expect(recovered.list().items[0]).toMatchObject({ archived: false, rolloutAvailable: true })
  })

  it('records a real rollback when the extra hard link can still be dropped', async () => {
    const data = fixture('session-1')
    const database = createThreadsDatabase(data.databasePath)
    insertThread(database, { id: 'session-1', rolloutPath: data.rolloutPath })
    database.close()
    const sessions = service(data)
    const targetPath = path.join(data.codexHome, 'archived_sessions', path.basename(data.rolloutPath))
    // The source stays locked for good, and the target survives both the
    // unlink and moveFileDurably's own cleanup, so the link pair really forms.
    // The scanner then lets go, so the rollback can still finish in-process.
    const restore = refuseUnlink([data.rolloutPath, targetPath], { releaseTargetAfter: 2 })

    await expect(sessions.archive('session-1')).rejects.toThrow()
    restore()

    expect(fs.existsSync(data.rolloutPath)).toBe(true)
    expect(fs.existsSync(targetPath)).toBe(false)
    expect(lastJournalEntry(sessions.operationJournalPath).state).toBe('rolled-back')
    expect(sessions.list().items[0]).toMatchObject({ archived: false, rolloutAvailable: true })
  })
})
