import fs from 'node:fs'
import { promises as fsPromises } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexSessionsService } from './codex-sessions'
import type {
  CodexSessionReader,
  ProviderSessionSummary,
} from './provider-sessions'
import { annotateWorkspaceExistence, codexSessionTitle, ProviderSessionsService } from './provider-sessions'

function summary(overrides: Partial<ProviderSessionSummary> = {}): ProviderSessionSummary {
  return {
    id: 'claude:one',
    provider: 'claude',
    nativeId: 'one',
    title: '一条记录',
    cwd: 'C:/work/app',
    model: 'claude-sonnet',
    archived: false,
    readonly: true,
    createdAt: 100,
    updatedAt: 200,
    messageCount: 2,
    sourcePath: 'C:/work/app/session.jsonl',
    detailAvailable: true,
    ...overrides,
  }
}

const temporaryDirectories: string[] = []

// The probe cache is written after the page has been returned, so these tests
// wait for it. vi.waitFor gives up after 1s by default, and the Windows release
// build of 0.2.17 had not written the file by then (ENOENT on the last poll).
// The wait still ends the moment the file is there; only a cache that is never
// written now takes longer to fail.
const probeCacheWrite = { timeout: 10_000 }

interface Fixture {
  root: string
  codexHome: string
  wrongCodexHome: string
  claude: string
  gemini: string
  grok: string
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-provider-sessions-'))
  temporaryDirectories.push(root)
  const data = {
    root,
    codexHome: path.join(root, 'custom-codex'),
    wrongCodexHome: path.join(root, 'wrong-codex'),
    claude: path.join(root, '.claude', 'projects'),
    gemini: path.join(root, '.gemini', 'tmp'),
    grok: path.join(root, '.grok', 'sessions'),
  }
  fs.mkdirSync(data.claude, { recursive: true })
  fs.mkdirSync(data.gemini, { recursive: true })
  fs.mkdirSync(data.grok, { recursive: true })
  return data
}

function writeJsonLines(filePath: string, entries: Array<unknown | string>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    `${entries.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n')}\n`,
    'utf8',
  )
}

function seedCodexSession(codexHome: string, id: string, title: string): void {
  const rolloutPath = path.join(codexHome, 'sessions', `${id}.jsonl`)
  writeJsonLines(rolloutPath, [
    { type: 'session_meta', payload: { id, cwd: 'C:/codex' } },
    {
      timestamp: '2026-07-24T00:00:00.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: title }] },
    },
  ])
  const databasePath = path.join(codexHome, 'state_5.sqlite')
  const database = new DatabaseSync(databasePath)
  try {
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
    database.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, title, cwd, model_provider,
        model, tokens_used, archived, archived_at, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      rolloutPath,
      1_721_779_900,
      1_721_780_000,
      title,
      'C:/codex',
      'xingmang',
      'gpt-5.6-sol',
      20,
      0,
      null,
      1_721_780_000_000,
    )
  } finally {
    database.close()
  }
}

function codexSummary(id = 'codex-native'): {
  id: string
  title: string
  cwd: string
  model: string
  modelProvider: string
  archived: boolean
  createdAt: number
  updatedAt: number
  tokensUsed: number
  rolloutAvailable: boolean
} {
  return {
    id,
    title: 'Codex 会话',
    cwd: 'C:/codex',
    model: 'gpt-5.6-sol',
    modelProvider: 'xingmang',
    archived: false,
    createdAt: 100,
    updatedAt: 200,
    tokensUsed: 20,
    rolloutAvailable: true,
  }
}

function codexReader(items = [codexSummary()], writable = true): CodexSessionReader {
  return {
    capabilities: vi.fn(() => ({
      schema: {
        kind: 'codex-threads' as const,
        readable: true,
        mutationsAllowed: writable,
        reason: 'Codex SQLite ready',
        columns: ['id', 'rollout_path'],
      },
      databasePath: 'C:/codex/state_5.sqlite',
      backupDirectory: 'C:/backup',
      trashDirectory: 'C:/trash',
      operationJournalPath: 'C:/operations.jsonl',
      permanentDeleteAllowed: false as const,
    })),
    list: vi.fn(async (query = {}) => {
      const pageSize = query.pageSize ?? 20
      const page = query.page ?? 1
      return {
        items: items.slice((page - 1) * pageSize, page * pageSize),
        total: items.length,
        page,
        pageSize,
        pages: items.length === 0 ? 0 : Math.ceil(items.length / pageSize),
        stats: { total: items.length, active: items.length, archived: 0, projects: 1, tokensUsed: 20 },
        schema: {
          kind: 'codex-threads' as const,
          readable: true,
          mutationsAllowed: writable,
          reason: 'Codex SQLite ready',
          columns: ['id', 'rollout_path'],
        },
      }
    }),
    detail: vi.fn(async (sessionId: string) => ({
      session: items.find((item) => item.id === sessionId) ?? codexSummary(sessionId),
      messages: [{ role: 'user', text: 'Codex 正文', timestamp: '2026-07-24T01:00:00.000Z' }],
      messageStats: { total: 1, user: 1, assistant: 0, system: 0, other: 0, invalidLines: 0 },
      messagesTruncated: false,
    })),
    exportMarkdown: vi.fn(async (sessionId: string, outputPath: string) => ({ sessionId, outputPath, messages: 1 })),
    delete: vi.fn(async (sessionId: string) => ({ sessionId, deletedFiles: 1 })),
  }
}

function service(data: Fixture, codex = codexReader(), overrides: Partial<ConstructorParameters<typeof ProviderSessionsService>[0]> = {}) {
  return new ProviderSessionsService({
    codexService: codex,
    claudeProjectsRoot: data.claude,
    geminiTmpRoot: data.gemini,
    grokSessionsRoot: data.grok,
    ...overrides,
  })
}

function seedExternalSessions(data: Fixture): void {
  writeJsonLines(path.join(data.claude, 'project-a', 'claude-session.jsonl'), [
    {
      type: 'user',
      sessionId: 'claude-native',
      cwd: 'C:/claude',
      timestamp: '2026-07-24T01:00:00.000Z',
      message: { role: 'user', content: '请检查 Claude 项目' },
    },
    '{damaged-json',
    {
      type: 'assistant',
      sessionId: 'claude-native',
      cwd: 'C:/claude',
      timestamp: '2026-07-24T01:00:01.000Z',
      message: { role: 'assistant', model: 'claude-sonnet', content: [{ type: 'text', text: 'Claude 已完成' }] },
    },
    { type: 'custom-title', sessionId: 'claude-native', customTitle: 'Claude 自定义标题' },
  ])

  const geminiPath = path.join(data.gemini, 'project-b', 'chats', 'session-gemini.json')
  fs.mkdirSync(path.dirname(geminiPath), { recursive: true })
  fs.writeFileSync(geminiPath, JSON.stringify({
    sessionId: 'gemini-native',
    startTime: '2026-07-24T02:00:00.000Z',
    lastUpdated: '2026-07-24T02:00:01.000Z',
    messages: [
      { type: 'user', timestamp: '2026-07-24T02:00:00.000Z', content: [{ text: 'Gemini 问题' }] },
      { type: 'gemini', timestamp: '2026-07-24T02:00:01.000Z', model: 'gemini-2.5-pro', content: 'Gemini 回答' },
    ],
  }), 'utf8')

  const grokDirectory = path.join(data.grok, 'grok-native')
  fs.mkdirSync(grokDirectory, { recursive: true })
  fs.writeFileSync(path.join(grokDirectory, 'summary.json'), JSON.stringify({
    info: { id: 'grok-native', cwd: 'C:/grok' },
    generated_title: 'Grok 摘要标题',
    current_model_id: 'grok-4',
    created_at: '2026-07-24T03:00:00.000Z',
    last_active_at: '2026-07-24T03:00:01.000Z',
    num_chat_messages: 2,
  }), 'utf8')
  writeJsonLines(path.join(grokDirectory, 'chat_history.jsonl'), [
    { type: 'user', content: [{ type: 'input_text', text: 'Grok 问题' }] },
    { type: 'assistant', model_id: 'grok-4', content: 'Grok 回答' },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: '不应显示的推理' }] },
  ])
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('annotateWorkspaceExistence', () => {
  it('marks a session whose working directory is still there', async () => {
    const data = fixture()
    const [item] = await annotateWorkspaceExistence([summary({ cwd: data.root })])
    expect(item.cwdExists).toBe(true)
  })

  it('marks a session whose working directory was deleted', async () => {
    const data = fixture()
    const [item] = await annotateWorkspaceExistence([
      summary({ cwd: path.join(data.root, '已经删掉的项目') }),
    ])
    expect(item.cwdExists).toBe(false)
  })

  it('treats a failing stat as a missing directory', async () => {
    const data = fixture()
    // 父级是个文件，所以 stat 不是「不存在」而是直接失败：Linux 报 ENOTDIR、
    // Windows 报 ENOENT。两边都得落到「接不上」，不能把异常抛给列表。
    const filePath = path.join(data.root, 'not-a-directory')
    fs.writeFileSync(filePath, 'x', 'utf8')
    const items = await annotateWorkspaceExistence([
      summary({ id: 'claude:file', cwd: filePath }),
      summary({ id: 'claude:under-file', cwd: path.join(filePath, 'child') }),
    ])
    expect(items.map((item) => item.cwdExists)).toEqual([false, false])
  })

  it('leaves sessions without a recorded directory untouched and stats each path once', async () => {
    const exists = vi.fn(async () => true)
    const items = await annotateWorkspaceExistence([
      summary({ id: 'claude:a', cwd: 'C:/work/app' }),
      summary({ id: 'claude:b', cwd: 'C:/work/app' }),
      summary({ id: 'claude:c', cwd: '   ' }),
    ], exists)
    expect(items.map((item) => item.cwdExists)).toEqual([true, true, undefined])
    expect(exists).toHaveBeenCalledTimes(1)
  })
})

describe('ProviderSessionsService.resolveWorkspace', () => {
  it('gives each provider the folder its record was made in, without reading the transcript', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const codex = codexReader([codexSummary('codex-native')])
    const sessions = service(data, codex)

    const page = await sessions.list({ pageSize: 100 })
    const byProvider = Object.fromEntries(page.items.map((item) => [item.provider, item.id]))

    await expect(sessions.resolveWorkspace(byProvider.claude!)).resolves.toBe('C:/claude')
    await expect(sessions.resolveWorkspace(byProvider.codex!)).resolves.toBe('C:/codex')
    expect(codex.detail).not.toHaveBeenCalled()
  })

  it('refuses an id that belongs to no record', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const sessions = service(data, codexReader([codexSummary('codex-native')]))

    await expect(sessions.resolveWorkspace('codex:missing')).rejects.toThrow('未找到这条记录')
    await expect(sessions.resolveWorkspace('claude:missing')).rejects.toThrow('未找到 claude 会话')
    await expect(sessions.resolveWorkspace('nothing')).rejects.toThrow('会话 ID 缺少有效 Provider 前缀')
  })
})

describe('ProviderSessionsService', () => {
  it('passes the Codex export incompleteness through the unified result, defaulting to complete (#491)', async () => {
    const data = fixture()
    const codex = codexReader([codexSummary('codex-native')])
    const sessions = service(data, codex)
    const outputPath = path.join(data.root, 'codex.md')
    await expect(sessions.exportMarkdown('codex:codex-native', outputPath)).resolves.toMatchObject({ truncated: false })
    vi.mocked(codex.exportMarkdown).mockResolvedValueOnce({ sessionId: 'codex-native', outputPath, messages: 1, truncated: true })
    await expect(sessions.exportMarkdown('codex:codex-native', outputPath)).resolves.toMatchObject({ messages: 1, truncated: true })
  })

  it('unifies Codex SQLite and Claude/Gemini/Grok local sessions with explicit capabilities', async () => {
    const data = fixture()
    seedExternalSessions(data)
    seedCodexSession(data.codexHome, 'custom-codex-native', 'Custom Codex 会话')
    seedCodexSession(data.wrongCodexHome, 'wrong-codex-native', 'Wrong Codex 会话')
    vi.stubEnv('CODEX_HOME', data.wrongCodexHome)
    const sessions = service(data, new CodexSessionsService({
      codexHome: data.codexHome,
      managerDataDirectory: path.join(data.root, 'manager-data'),
    }))

    const page = await sessions.list({ pageSize: 100 })
    expect(page.total).toBe(4)
    expect(page.stats.byProvider).toEqual({ codex: 1, claude: 1, gemini: 1, grok: 1 })
    expect(page.capabilities.codex).toMatchObject({ readonly: false, source: 'sqlite-jsonl' })
    expect(page.capabilities.claude).toMatchObject({
      readonly: true,
      operations: { list: true, detail: true, exportMarkdown: true, archive: false, restore: false },
    })
    expect(page.capabilities.gemini.readonly).toBe(true)
    expect(page.capabilities.grok.readonly).toBe(true)

    const byProvider = Object.fromEntries(page.items.map((item) => [item.provider, item])) as Record<string, ProviderSessionSummary>
    expect(byProvider.codex.id).toBe('codex:custom-codex-native')
    expect(page.items.some((item) => item.nativeId === 'wrong-codex-native')).toBe(false)
    expect(byProvider.claude).toMatchObject({ nativeId: 'claude-native', title: 'Claude 自定义标题', model: 'claude-sonnet' })
    expect(byProvider.gemini).toMatchObject({ nativeId: 'gemini-native', model: 'gemini-2.5-pro', messageCount: 2 })
    expect(byProvider.grok).toMatchObject({ nativeId: 'grok-native', title: 'Grok 摘要标题', messageCount: 2 })

    const claude = await sessions.detail(byProvider.claude.id)
    expect(claude.messages.map((message) => message.text)).toEqual(['请检查 Claude 项目', 'Claude 已完成'])
    expect(claude.messageStats).toMatchObject({ total: 2, user: 1, assistant: 1, invalidLines: 1 })
    expect(claude.messagesTruncated).toBe(true)
    const gemini = await sessions.detail(byProvider.gemini.id)
    expect(gemini.messages.map((message) => message.text)).toEqual(['Gemini 问题', 'Gemini 回答'])
    const grok = await sessions.detail(byProvider.grok.id)
    expect(grok.messages.map((message) => message.text)).toEqual(['Grok 问题', 'Grok 回答'])
  })

  it('supports Gemini JSONL records and preserves malformed files in the session index', async () => {
    const data = fixture()
    writeJsonLines(path.join(data.gemini, 'hash', 'chats', 'session-lines.jsonl'), [
      { sessionId: 'gemini-lines', startTime: '2026-07-24T00:59:00.000Z' },
      { $set: { messages: [{ id: 'seed-message', type: 'info', content: 'JSONL 初始信息' }] } },
      { sessionId: 'gemini-lines', type: 'user', timestamp: '2026-07-24T01:00:00.000Z', content: [{ text: 'JSONL 问题' }] },
      'broken-line',
      { sessionId: 'gemini-lines', type: 'gemini', model: 'gemini-flash', content: 'JSONL 回答' },
    ])
    fs.writeFileSync(path.join(data.gemini, 'session-damaged.json'), '{not-json', 'utf8')
    const sessions = service(data, codexReader([]))

    const page = await sessions.list({ provider: 'gemini', pageSize: 100 })
    expect(page.total).toBe(2)
    const valid = page.items.find((item) => item.nativeId === 'gemini-lines') as ProviderSessionSummary
    const damaged = page.items.find((item) => item.nativeId === 'session-damaged')
    expect(damaged).toBeTruthy()
    const detail = await sessions.detail(valid.id)
    expect(detail.messages.map((message) => message.text)).toEqual(['JSONL 初始信息', 'JSONL 问题', 'JSONL 回答'])
    expect(detail.messageStats.invalidLines).toBe(1)
  })

  it('lists a claude conversation once, leaving out the subagent transcripts it spawned', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const subagent = {
      type: 'user',
      isSidechain: true,
      agentId: 'a1b2c3',
      sessionId: 'claude-native',
      cwd: 'C:/claude',
      timestamp: '2026-07-24T05:00:00.000Z',
      message: { role: 'user', content: 'Look through this folder and report what is there' },
    }
    const companion = path.join(data.claude, 'project-a', 'claude-session')
    // 现在的存法：放在与记录同名的文件夹里，下面还可能再分一层。
    writeJsonLines(path.join(companion, 'subagents', 'agent-a1b2c3.jsonl'), [subagent])
    writeJsonLines(path.join(companion, 'subagents', 'workflows', 'run-1', 'agent-a4d5e6.jsonl'), [
      { ...subagent, agentId: 'a4d5e6' },
    ])
    // 同名文件夹里不叫 agent- 的过程记录也属于这一次对话。
    writeJsonLines(path.join(companion, 'remote-agents', 'remote-1.jsonl'), [subagent])
    // Claude Code 2.0 到 2.1 初期的存法：和记录并排放在项目文件夹里。
    writeJsonLines(path.join(data.claude, 'project-a', 'agent-7f3e9a1c.jsonl'), [{ ...subagent, agentId: '7f3e9a1c' }])
    const sessions = service(data, codexReader([]))

    const opened = vi.spyOn(fsPromises, 'open')
    try {
      const page = await sessions.list({ provider: 'claude', pageSize: 100 })
      expect(page.total).toBe(1)
      expect(page.stats.byProvider.claude).toBe(1)
      expect(page.items[0]).toMatchObject({ nativeId: 'claude-native', title: 'Claude 自定义标题' })
      expect(opened.mock.calls.map(([target]) => path.basename(String(target)))).toEqual(['claude-session.jsonl'])
    } finally {
      opened.mockRestore()
    }
  })

  it('keeps transcripts in ordinary sub-folders and names that only contain agent', async () => {
    const data = fixture()
    writeJsonLines(path.join(data.claude, 'project-a', 'nested', 'deeper.jsonl'), [
      { type: 'user', sessionId: 'deeper', message: { role: 'user', content: '子文件夹里的对话' } },
    ])
    writeJsonLines(path.join(data.claude, 'project-a', 'my-agent-notes.jsonl'), [
      { type: 'user', sessionId: 'my-agent-notes', message: { role: 'user', content: '名字里带 agent 的对话' } },
    ])

    const page = await service(data, codexReader([])).list({ provider: 'claude', pageSize: 100 })

    expect(page.items.map((item) => item.nativeId).sort()).toEqual(['deeper', 'my-agent-notes'])
  })

  it('does not count subagent transcripts against the per-provider file limit', async () => {
    const data = fixture()
    seedExternalSessions(data)
    for (const agentId of ['a1', 'a2', 'a3']) {
      writeJsonLines(path.join(data.claude, 'project-a', 'claude-session', 'subagents', `agent-${agentId}.jsonl`), [
        { type: 'user', isSidechain: true, agentId, sessionId: 'claude-native', message: { role: 'user', content: '子任务' } },
      ])
    }

    const page = await service(data, codexReader([]), { maxFilesPerProvider: 1 }).list({ provider: 'claude' })

    expect(page.capabilities.claude.readable).toBe(true)
    expect(page.items.map((item) => item.nativeId)).toEqual(['claude-native'])
  })

  it('skips directory junctions so discovery cannot escape a provider root', async () => {
    const data = fixture()
    writeJsonLines(path.join(data.claude, 'inside.jsonl'), [{
      type: 'user', sessionId: 'inside', message: { role: 'user', content: '内部会话' },
    }])
    const outside = path.join(data.root, 'outside')
    writeJsonLines(path.join(outside, 'outside.jsonl'), [{
      type: 'user', sessionId: 'outside', message: { role: 'user', content: '外部会话' },
    }])
    fs.symlinkSync(outside, path.join(data.claude, 'linked-outside'), 'junction')

    const page = await service(data, codexReader([])).list({ provider: 'claude', pageSize: 100 })
    expect(page.items.map((item) => item.nativeId)).toEqual(['inside'])
  })

  it('rejects a provider root that is itself a directory junction', async () => {
    const data = fixture()
    const outside = path.join(data.root, 'outside-root')
    writeJsonLines(path.join(outside, 'outside.jsonl'), [{
      type: 'user', sessionId: 'outside', message: { role: 'user', content: '外部会话' },
    }])
    const linkedRoot = path.join(data.root, 'linked-claude-root')
    fs.symlinkSync(outside, linkedRoot, 'junction')

    const sessions = service(data, codexReader([]), { claudeProjectsRoot: linkedRoot })
    expect((await sessions.capabilities()).claude).toMatchObject({ available: false, readable: false })
    const page = await sessions.list({ provider: 'claude' })
    expect(page.items).toEqual([])
    expect(page.capabilities.claude).toMatchObject({ available: false, readable: false })
  })

  it('enforces the JSONL line limit in UTF-8 bytes', async () => {
    const data = fixture()
    writeJsonLines(path.join(data.claude, 'multibyte.jsonl'), [{
      type: 'user', sessionId: 'multibyte', message: { role: 'user', content: '中'.repeat(70) },
    }])
    const sessions = service(data, codexReader([]), { maxJsonLineBytes: 256 })

    const page = await sessions.list({ provider: 'claude' })
    const detail = await sessions.detail(page.items[0].id)

    expect(detail.messages).toEqual([])
    expect(detail.messageStats.invalidLines).toBe(1)
    expect(detail.messagesTruncated).toBe(true)
    expect(detail.sourceTruncated).toBe(true)
  })

  it('marks byte-limited details as truncated instead of reporting partial content as complete', async () => {
    const data = fixture()
    writeJsonLines(path.join(data.claude, 'large.jsonl'), [
      { type: 'user', sessionId: 'large', message: { role: 'user', content: '第一条会话' } },
      { type: 'assistant', sessionId: 'large', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(500) }] } },
    ])
    const sessions = service(data, codexReader([]), { maxTranscriptBytes: 180, maxJsonLineBytes: 1024 })
    const page = await sessions.list({ provider: 'claude' })
    const detail = await sessions.detail(page.items[0].id)

    expect(detail.sourceTruncated).toBe(true)
    expect(detail.messagesTruncated).toBe(true)
    expect(detail.messages.map((message) => message.text)).toContain('第一条会话')
  })

  it('streams all messages to Markdown while detail retains a bounded tail', async () => {
    const data = fixture()
    const entries = Array.from({ length: 300 }, (_, index) => ({
      type: index % 2 === 0 ? 'user' : 'assistant',
      sessionId: 'export-session',
      message: {
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: index % 2 === 0 ? `问题-${index}` : [{ type: 'text', text: `回答-${index}` }],
      },
    }))
    writeJsonLines(path.join(data.claude, 'export.jsonl'), entries)
    const sessions = service(data, codexReader([]))
    const page = await sessions.list({ provider: 'claude' })
    const detail = await sessions.detail(page.items[0].id)
    expect(detail.messageStats.total).toBe(300)
    expect(detail.messages).toHaveLength(250)
    expect(detail.messagesTruncated).toBe(true)

    const outputPath = path.join(data.root, 'exports', 'session.md')
    const exported = await sessions.exportMarkdown(page.items[0].id, outputPath)
    expect(exported).toMatchObject({ messages: 300, truncated: false, outputPath })
    const markdown = fs.readFileSync(outputPath, 'utf8')
    expect(markdown).toContain('问题-0')
    expect(markdown).toContain('回答-299')
  })

  it('overwrites an existing .md target atomically on re-export', async () => {
    const data = fixture()
    writeJsonLines(path.join(data.claude, 'export.jsonl'), [
      { type: 'user', sessionId: 'export-session', message: { role: 'user', content: '导出问题' } },
    ])
    const sessions = service(data, codexReader([]))
    const page = await sessions.list({ provider: 'claude' })
    const outputPath = path.join(data.root, 'exports', 'session.md')
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, '旧的导出内容', 'utf8')

    const exported = await sessions.exportMarkdown(page.items[0].id, outputPath)

    expect(exported).toMatchObject({ messages: 1, outputPath })
    const markdown = fs.readFileSync(outputPath, 'utf8')
    expect(markdown).toContain('导出问题')
    expect(markdown).not.toContain('旧的导出内容')
    expect(fs.readdirSync(path.dirname(outputPath)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('keeps an existing non-.md file intact when export fails on extension validation', async () => {
    const data = fixture()
    writeJsonLines(path.join(data.claude, 'export.jsonl'), [
      { type: 'user', sessionId: 'export-session', message: { role: 'user', content: '导出问题' } },
    ])
    const sessions = service(data, codexReader([]))
    const page = await sessions.list({ provider: 'claude' })
    const notesPath = path.join(data.root, 'notes.txt')
    fs.writeFileSync(notesPath, '用户原有内容', 'utf8')

    await expect(sessions.exportMarkdown(page.items[0].id, notesPath)).rejects.toThrow('.md 扩展名')
    expect(fs.readFileSync(notesPath, 'utf8')).toBe('用户原有内容')
  })

  it('reuses probe results for unchanged session files across listings', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const sessions = service(data, codexReader([]))

    const first = await sessions.list({ pageSize: 100 })
    const openSpy = vi.spyOn(fs.promises, 'open')
    const second = await sessions.list({ pageSize: 100 })
    expect(openSpy).not.toHaveBeenCalled()
    openSpy.mockRestore()

    expect(second.items).toEqual(first.items)
  })

  it('invalidates the probe cache when a session file changes', async () => {
    const data = fixture()
    const sourcePath = path.join(data.claude, 'project-a', 'mutating.jsonl')
    writeJsonLines(sourcePath, [
      { type: 'custom-title', sessionId: 'mutating', customTitle: '旧标题' },
      { type: 'user', sessionId: 'mutating', message: { role: 'user', content: '旧问题' } },
    ])
    const sessions = service(data, codexReader([]))
    const first = await sessions.list({ provider: 'claude', pageSize: 100 })
    expect(first.items[0].title).toBe('旧标题')

    writeJsonLines(sourcePath, [
      { type: 'custom-title', sessionId: 'mutating', customTitle: '换了一个新标题' },
      { type: 'user', sessionId: 'mutating', message: { role: 'user', content: '新问题' } },
    ])
    const changed = new Date(Date.now() + 2000)
    fs.utimesSync(sourcePath, changed, changed)

    const second = await sessions.list({ provider: 'claude', pageSize: 100 })
    expect(second.items[0].title).toBe('换了一个新标题')
  })

  it('re-resolves a cached session id after its source file disappears', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const sessions = service(data, codexReader([]))
    const page = await sessions.list({ provider: 'claude', pageSize: 100 })
    const id = page.items[0].id
    await expect(sessions.detail(id)).resolves.toMatchObject({ session: { nativeId: 'claude-native' } })

    fs.rmSync(path.join(data.claude, 'project-a', 'claude-session.jsonl'))

    await expect(sessions.detail(id)).rejects.toThrow('未找到 claude 会话')
  })

  it('reuses the persisted probe cache instead of reading the session files again', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const cacheFile = path.join(data.root, 'sessions', 'probe-cache.json')
    const first = await service(data, codexReader([]), { probeCacheFile: cacheFile })
      .list({ provider: 'claude', pageSize: 100 })
    expect(first.items[0].title).toBe('Claude 自定义标题')
    // The cache write deliberately trails the page, so wait for it here.
    await vi.waitFor(() => expect(fs.existsSync(cacheFile)).toBe(true), probeCacheWrite)

    const opened = vi.spyOn(fsPromises, 'open')
    try {
      const second = await service(data, codexReader([]), { probeCacheFile: cacheFile })
        .list({ provider: 'claude', pageSize: 100 })
      expect(second.items[0].title).toBe('Claude 自定义标题')
      expect(opened.mock.calls.filter(([target]) => String(target).endsWith('claude-session.jsonl'))).toHaveLength(0)
    } finally {
      opened.mockRestore()
    }
  })

  it('re-reads only the session file whose size or mtime changed', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const cacheFile = path.join(data.root, 'sessions', 'probe-cache.json')
    const changedPath = path.join(data.claude, 'project-b', 'changed.jsonl')
    writeJsonLines(changedPath, [
      { type: 'custom-title', sessionId: 'changed', customTitle: '旧标题' },
    ])
    await service(data, codexReader([]), { probeCacheFile: cacheFile }).list({ provider: 'claude', pageSize: 100 })
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).toContain('旧标题'), probeCacheWrite)

    writeJsonLines(changedPath, [
      { type: 'custom-title', sessionId: 'changed', customTitle: '改过的标题' },
    ])
    const later = new Date(Date.now() + 2000)
    fs.utimesSync(changedPath, later, later)

    const opened = vi.spyOn(fsPromises, 'open')
    try {
      const page = await service(data, codexReader([]), { probeCacheFile: cacheFile })
        .list({ provider: 'claude', pageSize: 100 })
      expect(page.items.map((item) => item.title)).toContain('改过的标题')
      const targets = opened.mock.calls.map(([target]) => path.basename(String(target)))
      expect(targets).toContain('changed.jsonl')
      expect(targets).not.toContain('claude-session.jsonl')
    } finally {
      opened.mockRestore()
    }
  })

  it('drops the cached probe of a session file that was deleted', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const cacheFile = path.join(data.root, 'sessions', 'probe-cache.json')
    const removedPath = path.join(data.claude, 'project-c', 'removed.jsonl')
    writeJsonLines(removedPath, [{ type: 'custom-title', sessionId: 'removed', customTitle: '待删除' }])
    const sessions = service(data, codexReader([]), { probeCacheFile: cacheFile })
    await sessions.list({ provider: 'claude', pageSize: 100 })
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).toContain('待删除'), probeCacheWrite)

    fs.rmSync(removedPath)
    await sessions.list({ provider: 'claude', pageSize: 100 })
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).not.toContain('待删除'), probeCacheWrite)
    expect(fs.readFileSync(cacheFile, 'utf8')).toContain('Claude 自定义标题')
  })

  it('drops a deleted session from the cache when the root is reached through a link', async () => {
    // macOS hands /tmp out as a symlink, so the probed paths come back resolved
    // while the configured root does not: pruning must not compare prefixes.
    const data = fixture()
    const realRoot = path.join(data.root, 'real-home')
    const aliasRoot = path.join(data.root, 'alias-home')
    const claudeRoot = path.join(realRoot, '.claude', 'projects')
    fs.mkdirSync(claudeRoot, { recursive: true })
    fs.symlinkSync(realRoot, aliasRoot, process.platform === 'win32' ? 'junction' : 'dir')
    writeJsonLines(path.join(claudeRoot, 'kept', 'kept.jsonl'), [
      { type: 'custom-title', sessionId: 'kept', customTitle: '留下的会话' },
    ])
    const removedPath = path.join(claudeRoot, 'removed', 'removed.jsonl')
    writeJsonLines(removedPath, [{ type: 'custom-title', sessionId: 'removed', customTitle: '待删除' }])
    const cacheFile = path.join(data.root, 'sessions', 'probe-cache.json')
    const sessions = service(data, codexReader([]), {
      claudeProjectsRoot: path.join(aliasRoot, '.claude', 'projects'),
      probeCacheFile: cacheFile,
    })
    await sessions.list({ provider: 'claude', pageSize: 100 })
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).toContain('待删除'), probeCacheWrite)

    fs.rmSync(removedPath)
    await sessions.list({ provider: 'claude', pageSize: 100 })
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).not.toContain('待删除'), probeCacheWrite)
    expect(fs.readFileSync(cacheFile, 'utf8')).toContain('留下的会话')
  })

  it('rebuilds a damaged probe cache without failing the list', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const cacheFile = path.join(data.root, 'sessions', 'probe-cache.json')
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true })
    fs.writeFileSync(cacheFile, '{"version":1,"entries":[{', 'utf8')
    const warnings: string[] = []

    const page = await service(data, codexReader([]), {
      probeCacheFile: cacheFile,
      onProbeCacheWarning: (warning) => warnings.push(warning.code),
    }).list({ provider: 'claude', pageSize: 100 })

    expect(page.items[0].title).toBe('Claude 自定义标题')
    expect(warnings).toEqual(['probe-cache-discarded'])
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).toContain('Claude 自定义标题'), probeCacheWrite)
  })

  it('reports whether each listed session still has its working directory, without caching it', async () => {
    const data = fixture()
    const alive = path.join(data.root, '还在的项目')
    fs.mkdirSync(alive, { recursive: true })
    writeJsonLines(path.join(data.claude, 'alive', 'session.jsonl'), [
      { type: 'user', sessionId: 'alive', cwd: alive, timestamp: '2026-07-24T01:00:00.000Z', message: { role: 'user', content: '还在' } },
    ])
    writeJsonLines(path.join(data.claude, 'gone', 'session.jsonl'), [
      { type: 'user', sessionId: 'gone', cwd: path.join(data.root, '已经删了'), timestamp: '2026-07-24T01:00:01.000Z', message: { role: 'user', content: '没了' } },
    ])
    const cacheFile = path.join(data.root, 'sessions', 'probe-cache.json')
    const sessions = service(data, codexReader([]), { probeCacheFile: cacheFile })

    const page = await sessions.list({ provider: 'claude', pageSize: 100 })
    const byNativeId = new Map(page.items.map((item) => [item.nativeId, item.cwdExists]))
    expect(byNativeId.get('alive')).toBe(true)
    expect(byNativeId.get('gone')).toBe(false)

    // 目录随时会被删掉或恢复，所以这个判断不进探测缓存：缓存住就会一直显示
    // 上一次的状态，用户删了文件夹还看见一颗亮着的「接着聊」。
    await vi.waitFor(() => expect(fs.readFileSync(cacheFile, 'utf8')).toContain('还在'), probeCacheWrite)
    expect(fs.readFileSync(cacheFile, 'utf8')).not.toContain('cwdExists')

    fs.rmSync(alive, { recursive: true, force: true })
    const second = await sessions.list({ provider: 'claude', pageSize: 100 })
    expect(second.items.find((item) => item.nativeId === 'alive')?.cwdExists).toBe(false)
  })

  it('keeps Codex summaries readonly when its SQLite schema disables mutations', async () => {
    const data = fixture()
    const page = await service(data, codexReader([codexSummary()], false)).list({ provider: 'codex' })
    expect(page.items[0].readonly).toBe(true)
    expect(page.capabilities.codex.operations).toMatchObject({ archive: false, restore: false })
  })
})

describe('ProviderSessionsService.delete', () => {
  async function idOf(sessions: ProviderSessionsService, provider: 'claude' | 'gemini' | 'grok'): Promise<string> {
    const page = await sessions.list({ provider, pageSize: 100 })
    expect(page.items).toHaveLength(1)
    return page.items[0].id
  }

  it('offers deletion for every provider whose records are writable', async () => {
    const data = fixture()
    const capabilities = (await service(data).list()).capabilities
    expect(capabilities.claude.operations.delete).toBe(true)
    expect(capabilities.gemini.operations.delete).toBe(true)
    expect(capabilities.grok.operations.delete).toBe(true)
    expect(capabilities.codex.operations.delete).toBe(true)
    expect((await service(data, codexReader([codexSummary()], false)).capabilities()).codex.operations.delete).toBe(false)
  })

  it('removes a claude transcript and its companion folder but nothing else', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const companion = path.join(data.claude, 'project-a', 'claude-session', 'subagents')
    fs.mkdirSync(companion, { recursive: true })
    fs.writeFileSync(path.join(companion, 'agent-1.jsonl'), '{}\n')
    const neighbour = path.join(data.claude, 'project-a', 'notes.txt')
    fs.writeFileSync(neighbour, 'keep')
    const sessions = service(data)
    const page = await sessions.list({ provider: 'claude', pageSize: 100 })
    // 子任务在列表里不另算一条，删的时候跟着这一条一起走。
    expect(page.items).toHaveLength(1)
    const target = page.items.find((item) => item.nativeId === 'claude-native')
    expect(target).toBeDefined()

    const result = await sessions.delete(target!.id)

    expect(result).toEqual({ id: target!.id, provider: 'claude', deletedFiles: 2 })
    expect(fs.existsSync(path.join(data.claude, 'project-a', 'claude-session.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(data.claude, 'project-a', 'claude-session'))).toBe(false)
    expect(fs.readFileSync(neighbour, 'utf8')).toBe('keep')
    expect((await sessions.list({ provider: 'claude', pageSize: 100 })).items).toHaveLength(0)
  })

  it('removes a gemini session file and a grok session folder', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const sessions = service(data)

    await sessions.delete(await idOf(sessions, 'gemini'))
    const grok = await sessions.delete(await idOf(sessions, 'grok'))

    expect(fs.existsSync(path.join(data.gemini, 'project-b', 'chats', 'session-gemini.json'))).toBe(false)
    expect(fs.existsSync(path.join(data.gemini, 'project-b', 'chats'))).toBe(true)
    expect(fs.existsSync(path.join(data.grok, 'grok-native'))).toBe(false)
    expect(fs.existsSync(data.grok)).toBe(true)
    expect(grok.deletedFiles).toBe(2)
    expect((await sessions.list({ pageSize: 100 })).stats.byProvider).toMatchObject({ gemini: 0, grok: 0 })
  })

  it('keeps a grok folder that also holds another session and deletes only the target files', async () => {
    const data = fixture()
    const outer = path.join(data.grok, 'outer')
    writeJsonLines(path.join(outer, 'chat_history.jsonl'), [{ type: 'user', content: '外层' }])
    writeJsonLines(path.join(outer, 'inner', 'chat_history.jsonl'), [{ type: 'user', content: '内层' }])
    const sessions = service(data)
    const page = await sessions.list({ provider: 'grok', pageSize: 100 })
    // Compare by folder name: on Windows the discovered path is the long-name
    // realpath while tmpdir() may be an 8.3 short path, so full paths differ.
    const target = page.items.find((item) => path.basename(path.dirname(item.sourcePath)) === 'outer')
    expect(target).toBeDefined()

    await sessions.delete(target!.id)

    expect(fs.existsSync(path.join(outer, 'chat_history.jsonl'))).toBe(false)
    expect(fs.existsSync(path.join(outer, 'inner', 'chat_history.jsonl'))).toBe(true)
  })

  it('refuses unknown ids without touching any file', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const sessions = service(data)
    await expect(sessions.delete('claude:../../etc/passwd')).rejects.toThrow('没找到这条记录')
    await expect(sessions.delete('unknown:abc')).rejects.toThrow()
    await expect(sessions.delete('codex:../../x')).rejects.toThrow('会话 ID 格式错误')
    expect((await sessions.list({ pageSize: 100 })).stats.byProvider).toMatchObject({ claude: 1, gemini: 1, grok: 1 })
  })

  it.runIf(process.platform !== 'win32')('never follows a linked companion folder out of the root', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const outside = path.join(data.root, 'outside')
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep')
    fs.symlinkSync(outside, path.join(data.claude, 'project-a', 'claude-session'))
    const sessions = service(data)
    const id = (await sessions.list({ provider: 'claude', pageSize: 100 })).items[0].id

    await sessions.delete(id)

    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep')
    expect(fs.lstatSync(path.join(data.claude, 'project-a', 'claude-session')).isSymbolicLink()).toBe(true)
  })

  it('refuses a transcript that gained a second hard link after listing', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const sessions = service(data)
    const id = await idOf(sessions, 'gemini')
    const source = path.join(data.gemini, 'project-b', 'chats', 'session-gemini.json')
    fs.linkSync(source, path.join(data.root, 'hard-link.json'))

    await expect(sessions.delete(id)).rejects.toThrow()
    expect(fs.existsSync(source)).toBe(true)
  })

  it('routes codex ids to the codex store', async () => {
    const data = fixture()
    const codex = codexReader()
    const id = '019a0000-0000-7000-8000-000000000001'
    const result = await service(data, codex).delete(`codex:${id}`)
    expect(codex.delete).toHaveBeenCalledWith(id)
    expect(result).toEqual({ id: `codex:${id}`, provider: 'codex', deletedFiles: 1 })
  })

  it('deletes a real codex thread row and its rollout', async () => {
    const data = fixture()
    const id = '019a0000-0000-7000-8000-000000000002'
    seedCodexSession(data.codexHome, id, '要删的 Codex 对话')
    const codex = new CodexSessionsService({ codexHome: data.codexHome, managerDataDirectory: path.join(data.root, 'manager') })

    const result = await service(data, codex).delete(`codex:${id}`)

    expect(result.deletedFiles).toBe(1)
    expect(fs.existsSync(path.join(data.codexHome, 'sessions', `${id}.jsonl`))).toBe(false)
    expect((await codex.list()).total).toBe(0)
    expect(fs.existsSync(path.join(data.root, 'manager', 'backups'))).toBe(false)
  })

  it('still removes a codex index row whose rollout is already gone', async () => {
    const data = fixture()
    const id = '019a0000-0000-7000-8000-000000000003'
    seedCodexSession(data.codexHome, id, '原文已丢')
    fs.rmSync(path.join(data.codexHome, 'sessions', `${id}.jsonl`))
    const codex = new CodexSessionsService({ codexHome: data.codexHome, managerDataDirectory: path.join(data.root, 'manager') })

    await expect(codex.delete(id)).resolves.toEqual({ sessionId: id, deletedFiles: 0 })
    expect((await codex.list()).total).toBe(0)
  })

  it('refuses a codex rollout that points outside CODEX_HOME and keeps the row', async () => {
    const data = fixture()
    const id = '019a0000-0000-7000-8000-000000000004'
    seedCodexSession(data.codexHome, id, '越界')
    const outside = path.join(data.root, 'outside.jsonl')
    fs.writeFileSync(outside, 'keep')
    const database = new DatabaseSync(path.join(data.codexHome, 'state_5.sqlite'))
    database.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?').run(outside, id)
    database.close()
    const codex = new CodexSessionsService({ codexHome: data.codexHome, managerDataDirectory: path.join(data.root, 'manager') })

    await expect(codex.delete(id)).rejects.toThrow('不在 CODEX_HOME 内')
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep')
    expect((await codex.list()).total).toBe(1)
  })
})

describe('codexSessionTitle', () => {
  it('keeps only the task name of a Codex automation run', () => {
    const prompt = [
      'Automation: 每日制作头像',
      'Automation ID: automation',
      'Automation memory: $CODEX_HOME/automations/automation/memory.md',
      'Last run: 2026-09-29T16:02:10.585Z (1790697730585)',
      '每天北京时间凌晨零点，在“头像制作”项目中运行项目内 `.agents/skills/daily-avatar/SKILL.md` 里的流程。',
    ].join('\n')
    expect(codexSessionTitle(prompt, 'id-1')).toBe('定时任务：每日制作头像')
  })

  it('folds any other title onto one bounded line', () => {
    expect(codexSessionTitle('  修一下\n登录页\t的样式 ', 'id-1')).toBe('修一下 登录页 的样式')
    const long = codexSessionTitle('字'.repeat(400), 'id-1')
    expect(long.length).toBe(161)
    expect(long.endsWith('…')).toBe(true)
  })

  it('falls back to the session id when the title is blank', () => {
    expect(codexSessionTitle(' \n ', 'id-1')).toBe('id-1')
  })
})
