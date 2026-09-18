import { describe, expect, it, vi } from 'vitest'
import { createConversation, createWorkspace, type ChatMessage, type ChatWorkspace } from './state'
import { ChatStorageError, historyKey, importLegacyHistory, readWorkspace, writeWorkspace } from './storage'

const scope = 'xm-account:7'
const legacyKey = 'xingmang-ai-chat:v1:7'
function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value) }) }
}
function message(index = 0, patch: Partial<ChatMessage> = {}): ChatMessage {
  return { id: `message-${index}`, role: index % 2 ? 'assistant' : 'user', content: `content-${index}`, reasoning: `reasoning-${index}`, status: 'complete', createdAt: index, ...patch }
}
function workspace(owner = scope, count = 1): ChatWorkspace {
  const state = createWorkspace(owner)
  state.conversations = Array.from({ length: count }, (_, index) => ({ ...createConversation(undefined, `conversation-${index}`), messages: [message()] }))
  state.activeId = state.conversations[0]?.id ?? null
  return state
}
function legacy(messages: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ version: 1, userId: '7', data: { group: 'group-a', model: 'gpt-test', messages, ...extra } })
}

describe('lossless bounded chat storage', () => {
  it('round-trips already-stored long Unicode content, reasoning, prompts and drafts without the former 40,000-character clipping', () => {
    const storage = memoryStorage()
    const state = workspace()
    const long = '长文🙂\n'.repeat(18_000)
    const conversation = state.conversations[0]
    conversation.title = '长标题'.repeat(50)
    conversation.draft = long
    conversation.settings.systemPrompt = long
    conversation.settings.model = 'model-'.repeat(35)
    conversation.settings.group = 'group-'.repeat(30)
    conversation.messages = [message(0, { content: long, reasoning: long, settings: conversation.settings }), message(1, { status: 'error', error: '已脱敏的历史错误详情' })]
    state.draftConversation.draft = long
    const raw = JSON.stringify(state)
    storage.setItem(historyKey(scope), raw)
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toBeUndefined()
    expect(restored.state).toEqual(state)
    writeWorkspace(storage, restored.state)
    expect(readWorkspace(storage, scope).state).toEqual(state)
  })

  it('preserves all 350 messages and all asset references without reusing request limits for stored history', () => {
    const storage = memoryStorage()
    const state = workspace()
    state.conversations[0].messages = Array.from({ length: 350 }, (_, index) => message(index))
    state.conversations[0].messages[0].assets = Array.from({ length: 10 }, (_, index) => ({ assetId: String(index).repeat(43), mimeType: 'image/png', localUrl: `runtime:${index}`, fileName: `图${index}.png`, revisedPrompt: '完整图片提示词'.repeat(8_000) }))
    writeWorkspace(storage, state)
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations[0].messages).toHaveLength(350)
    expect(restored.state.conversations[0].messages.at(-1)?.content).toBe('content-349')
    expect(restored.state.conversations[0].messages[0].assets).toHaveLength(10)
    expect(restored.state.conversations[0].messages[0].assets?.[0].revisedPrompt).toBe(state.conversations[0].messages[0].assets[0].revisedPrompt)
  })

  it.each(['bytes', 'conversations'] as const)('retains the prior atomic value when a %s write exceeds storage capacity', (limit) => {
    const storage = memoryStorage()
    const state = workspace()
    writeWorkspace(storage, state)
    const before = storage.getItem(historyKey(scope))
    const excessive = limit === 'bytes' ? workspace() : workspace(scope, 51)
    if (limit === 'bytes') excessive.conversations[0].messages[0].content = '文'.repeat(1_400_000)
    expect(() => writeWorkspace(storage, excessive)).toThrow(ChatStorageError)
    expect(storage.getItem(historyKey(scope))).toBe(before)
    expect(excessive.conversations[0].messages[0].content).toBe(limit === 'bytes' ? '文'.repeat(1_400_000) : 'content-0')
  })

  it.each(['bytes', 'conversations', 'duplicate-message', 'duplicate-conversation', 'invalid-message', 'invalid-asset'] as const)('refuses a lossy read of %s while retaining its original storage', (kind) => {
    const storage = memoryStorage()
    const state = workspace(scope, kind === 'conversations' ? 51 : 1)
    if (kind === 'bytes') state.conversations[0].messages[0].content = 'x'.repeat(4 * 1024 * 1024)
    if (kind === 'duplicate-message') state.conversations[0].messages.push(message())
    if (kind === 'duplicate-conversation') state.conversations.push(structuredClone(state.conversations[0]))
    if (kind === 'invalid-message') state.conversations[0].messages.push({ role: 'unrecognized' } as unknown as ChatMessage)
    if (kind === 'invalid-asset') state.conversations[0].messages[0].assets = [{ assetId: 'invalid' } as never]
    const raw = JSON.stringify(state)
    storage.setItem(historyKey(scope), raw)
    storage.setItem.mockClear()
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toContain('原始记录已保留')
    expect(restored.exists).toBe(true)
    expect(storage.getItem(historyKey(scope))).toBe(raw)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('keeps the previous serialized workspace when localStorage quota rejects a write', () => {
    const storage = memoryStorage()
    const state = workspace()
    writeWorkspace(storage, state)
    const before = storage.getItem(historyKey(scope))
    storage.setItem.mockImplementationOnce(() => { throw new DOMException('quota', 'QuotaExceededError') })
    state.conversations[0].messages[0].content = 'new unsaved content'
    expect(() => writeWorkspace(storage, state)).toThrow('quota')
    expect(storage.getItem(historyKey(scope))).toBe(before)
  })
})

describe('complete legacy and account-alias migration', () => {
  it('imports all historical messages, reasoning and system text synchronously before creating a canonical value', () => {
    const storage = memoryStorage()
    const content = '旧版长正文'.repeat(12_000)
    const reasoning = '旧版长思考'.repeat(11_000)
    const system = '系统提示'.repeat(13_000)
    const messages = [{ id: 'system', role: 'system', content: system }, ...Array.from({ length: 210 }, (_, index) => message(index))]
    Object.assign(messages[1], { content, reasoning })
    const raw = legacy(messages, { model: 'model'.repeat(40), group: 'group'.repeat(30) })
    storage.setItem(legacyKey, raw)
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations[0].messages).toHaveLength(210)
    expect(restored.state.conversations[0].messages[0]).toMatchObject({ content, reasoning })
    expect(restored.state.conversations[0].settings).toMatchObject({ systemPrompt: system, model: 'model'.repeat(40), group: 'group'.repeat(30) })
    expect(readWorkspace(storage, scope).state).toEqual(restored.state)
    expect(storage.getItem(legacyKey)).toBe(raw)
    const writes = storage.setItem.mock.calls.filter(([key]) => key === historyKey(scope))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0][1]).conversations[0].messages).toHaveLength(210)
  })

  it('imports a system-only old workspace instead of silently ignoring it', () => {
    const storage = memoryStorage()
    storage.setItem(legacyKey, legacy([{ role: 'system', content: 'only prompt' }]))
    expect(readWorkspace(storage, scope).state.conversations[0].settings.systemPrompt).toBe('only prompt')
  })

  it.each(['oversized', 'malformed', 'wrong-owner', 'invalid-message'] as const)('does not create a canonical key after a %s legacy read', (kind) => {
    const storage = memoryStorage()
    const raw = kind === 'oversized' ? legacy([message(0, { content: 'x'.repeat(4 * 1024 * 1024) })])
      : kind === 'malformed' ? '{invalid'
        : kind === 'wrong-owner' ? legacy([message()]).replace('"userId":"7"', '"userId":"8"')
          : legacy([{ role: 'tool', content: 'unsupported' }])
    storage.setItem(legacyKey, raw)
    expect(() => importLegacyHistory(storage, scope, 7)).toThrow()
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toBeTruthy()
    expect(restored.exists).toBe(true)
    expect(storage.getItem(historyKey(scope))).toBeNull()
    expect(storage.getItem(legacyKey)).toBe(raw)
  })

  it('keeps merged aliases with independent conversations and conflicting revisions instead of picking only the newest workspace', () => {
    const storage = memoryStorage()
    const recent = workspace('solov:7', 2)
    recent.conversations[0].updatedAt = 10
    recent.conversations[0].messages[0].content = 'latest revision'
    recent.draftConversation.updatedAt = 10
    const older = workspace('sub2api:7')
    older.conversations[0].updatedAt = 5
    older.conversations[0].messages[0].content = 'older divergent revision'
    older.draftConversation.settings.systemPrompt = 'unsent system-only draft'
    older.draftConversation.updatedAt = 5
    const left = JSON.stringify(recent), right = JSON.stringify(older)
    storage.setItem(historyKey('solov:7'), left)
    storage.setItem(historyKey('sub2api:7'), right)
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations).toHaveLength(4)
    expect(new Set(restored.state.conversations.map((item) => item.id)).size).toBe(4)
    expect(restored.state.conversations.map((item) => item.messages[0]?.content)).toContain('older divergent revision')
    expect(restored.state.conversations.some((item) => item.settings.systemPrompt === 'unsent system-only draft')).toBe(true)
    expect(storage.getItem(historyKey('solov:7'))).toBe(left)
    expect(storage.getItem(historyKey('sub2api:7'))).toBe(right)
  })

  it('blocks migration writes if merging aliases exceeds the conversation budget, while retaining every loaded conversation', () => {
    const storage = memoryStorage()
    for (const alias of ['solov', 'sub2api']) {
      const state = workspace(`${alias}:7`, 30)
      state.conversations.forEach((item) => { item.id = `${alias}-${item.id}` })
      storage.setItem(historyKey(`${alias}:7`), JSON.stringify(state))
    }
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toContain('迁移未保存')
    expect(restored.warning).toContain('上限')
    expect(restored.state.conversations).toHaveLength(60)
    expect(storage.getItem(historyKey(scope))).toBeNull()
  })

  it('preserves readable migrated content and source when writing the canonical destination fails', () => {
    const storage = memoryStorage()
    const raw = legacy([message(0, { content: 'long'.repeat(20_000) })])
    storage.setItem(legacyKey, raw)
    storage.setItem.mockImplementationOnce(() => { throw new Error('quota') })
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toContain('迁移未保存')
    expect(restored.state.conversations[0].messages[0].content).toHaveLength(80_000)
    expect(storage.getItem(historyKey(scope))).toBeNull()
    expect(storage.getItem(legacyKey)).toBe(raw)
  })
})
