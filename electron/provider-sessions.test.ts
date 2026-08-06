import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CodexSessionReader,
  ProviderSessionSummary,
} from './provider-sessions'
import { ProviderSessionsService } from './provider-sessions'

const temporaryDirectories: string[] = []

interface Fixture {
  root: string
  claude: string
  gemini: string
  grok: string
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xingmang-provider-sessions-'))
  temporaryDirectories.push(root)
  const data = {
    root,
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
    list: vi.fn((query = {}) => {
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
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('ProviderSessionsService', () => {
  it('unifies Codex SQLite and Claude/Gemini/Grok local sessions with explicit capabilities', async () => {
    const data = fixture()
    seedExternalSessions(data)
    const sessions = service(data)

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
    expect(byProvider.codex.id).toBe('codex:codex-native')
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
    expect(sessions.capabilities().claude).toMatchObject({ available: false, readable: false })
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

  it('keeps Codex summaries readonly when its SQLite schema disables mutations', async () => {
    const data = fixture()
    const page = await service(data, codexReader([codexSummary()], false)).list({ provider: 'codex' })
    expect(page.items[0].readonly).toBe(true)
    expect(page.capabilities.codex.operations).toMatchObject({ archive: false, restore: false })
  })
})
