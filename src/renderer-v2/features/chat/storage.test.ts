import { describe, expect, it, vi } from 'vitest'
import type { AiChatHistorySnapshot, AiChatHistoryWrite } from '../../../../electron/ipc-contract'
import { createConversation, createWorkspace, type ChatMessage, type ChatWorkspace } from './state'
import { ChatStorageError, conversationPlainText, createHistoryWriter, exportableConversations, historyKey, importConversationsIntoHistory, mergeImportedConversations, parseImportedConversations, settleHistoryWrites, importLegacyHistory, legacyHistoryKeys, loadChatHistory, parseHistorySnapshot, planHistoryWrite, readWorkspace, redactPersistentChatText } from './storage'

const scope = 'xm-account:7'
const legacyKey = 'xingmang-ai-chat:v1:7'
const formerLimitBytes = 4 * 1024 * 1024
function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value) }), removeItem: vi.fn((key: string) => { data.delete(key) }), keys: () => [...data.keys()] }
}
// Same contract as electron/ai-chat-history-store.ts: rewrite the listed
// conversations, then the index, then drop files the index no longer names.
function memoryFiles() {
  const stores = new Map<string, AiChatHistorySnapshot>()
  const api = {
    readHistory: vi.fn(async (owner: string): Promise<AiChatHistorySnapshot> => structuredClone(stores.get(owner) ?? { index: null, conversations: [] })),
    writeHistory: vi.fn(async (input: AiChatHistoryWrite) => {
      const files = new Map((stores.get(input.scope)?.conversations ?? []).map((file) => [file.key, file.content]))
      for (const file of input.put) files.set(file.key, file.content)
      stores.set(input.scope, { index: input.index, conversations: input.keys.map((key) => ({ key, content: files.get(key)! })) })
    }),
  }
  function raw(owner = scope) { const snapshot = stores.get(owner); return snapshot ? [snapshot.index, ...snapshot.conversations.map((file) => file.content)].join('\n') : null }
  return { api, stores, raw }
}
async function saveAndReopen(state: ChatWorkspace, files = memoryFiles(), storage = memoryStorage()) {
  await createHistoryWriter(files.api, null).save(state)
  return loadChatHistory(files.api, storage, state.owner)
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
// Hand-built files, so a test can store what planHistoryWrite would refuse to produce.
function snapshotOf(state: ChatWorkspace, owner = scope): AiChatHistorySnapshot {
  const conversations = state.conversations.map((conversation, index) => ({ key: `k${index}`, content: JSON.stringify({ version: 3, owner, conversation }) }))
  return { index: JSON.stringify({ version: 3, owner, activeId: state.activeId, draftConversation: state.draftConversation, conversations: state.conversations.map((conversation, index) => ({ id: conversation.id, key: `k${index}` })) }), conversations }
}

describe('lossless chat history files', () => {
  it('round-trips long Unicode content, reasoning, prompts and drafts without the former 40,000-character clipping', async () => {
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
    const files = memoryFiles()
    const restored = await saveAndReopen(state, files)
    expect(restored.warning).toBeUndefined()
    expect(restored.state).toEqual(state)
    expect(planHistoryWrite(restored.state, restored.saved)).toBeNull()
  })

  it('preserves all 350 messages and all asset references without reusing request limits for stored history', async () => {
    const state = workspace()
    state.conversations[0].messages = Array.from({ length: 350 }, (_, index) => message(index))
    state.conversations[0].messages[0].assets = Array.from({ length: 10 }, (_, index) => ({ assetId: String(index).repeat(43), mimeType: 'image/png', localUrl: `runtime:${index}`, fileName: `图${index}.png`, revisedPrompt: '完整图片提示词'.repeat(8_000) }))
    const restored = await saveAndReopen(state)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations[0].messages).toHaveLength(350)
    expect(restored.state.conversations[0].messages.at(-1)?.content).toBe('content-349')
    expect(restored.state.conversations[0].messages[0].assets).toHaveLength(10)
    expect(restored.state.conversations[0].messages[0].assets?.[0].revisedPrompt).toBe(state.conversations[0].messages[0].assets[0].revisedPrompt)
  })

  // Used to pin the opposite: past 4 MB the write was refused and the older
  // copy kept, so everything said after that point vanished on exit.
  it('keeps saving past the former 4 MB limit, so a reopened window still has the newest content', async () => {
    const files = memoryFiles()
    const writer = createHistoryWriter(files.api, null)
    const state = workspace(scope, 3)
    await writer.save(state)
    const grown = { ...state, conversations: state.conversations.map((conversation, index) => index === 1 ? { ...conversation, messages: [...conversation.messages, message(1, { content: '文'.repeat(1_400_000), reasoning: 'x'.repeat(formerLimitBytes) })] } : conversation) }
    expect(new TextEncoder().encode(files.raw()! + grown.conversations[1].messages[1].content + grown.conversations[1].messages[1].reasoning).byteLength).toBeGreaterThan(2 * formerLimitBytes)
    await writer.save(grown)
    await writer.save({ ...grown, conversations: [{ ...grown.conversations[0], draft: 'said after the limit' }, ...grown.conversations.slice(1)] })
    const reopened = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(reopened.warning).toBeUndefined()
    expect(reopened.state.conversations[1].messages[1].content).toBe('文'.repeat(1_400_000))
    expect(reopened.state.conversations[1].messages[1].reasoning).toHaveLength(formerLimitBytes)
    expect(reopened.state.conversations[0].draft).toBe('said after the limit')
  })

  it('retains the prior files when a save exceeds the 50-conversation limit', async () => {
    const files = memoryFiles()
    const writer = createHistoryWriter(files.api, null)
    await writer.save(workspace())
    const before = files.raw()
    await expect(writer.save(workspace(scope, 51))).rejects.toThrow(ChatStorageError)
    expect(files.raw()).toBe(before)
  })

  it('rewrites only the conversations that changed and removes deleted ones after the index', async () => {
    const files = memoryFiles()
    const writer = createHistoryWriter(files.api, null)
    const state = workspace(scope, 3)
    await writer.save(state)
    expect(files.api.writeHistory.mock.calls[0][0].put).toHaveLength(3)
    const edited = { ...state, conversations: [state.conversations[0], { ...state.conversations[1], draft: 'edited' }] }
    await writer.save(edited)
    const second = files.api.writeHistory.mock.calls[1][0]
    expect(second.put.map((file) => file.key)).toEqual(['conversation-1'])
    expect(second.keys).toEqual(['conversation-0', 'conversation-1'])
    expect(files.stores.get(scope)?.conversations.map((file) => file.key)).toEqual(['conversation-0', 'conversation-1'])
    await writer.save(edited)
    expect(files.api.writeHistory).toHaveBeenCalledTimes(2)
  })

  it('gives conversations with ids unfit for file names their own stable key', async () => {
    const files = memoryFiles()
    const state = workspace()
    state.conversations[0].id = '旧版对话/../1'
    state.activeId = state.conversations[0].id
    const writer = createHistoryWriter(files.api, null)
    await writer.save(state)
    await writer.save({ ...state, conversations: [{ ...state.conversations[0], draft: 'again' }] })
    const [first, second] = files.api.writeHistory.mock.calls.map(([input]) => input)
    expect(first.keys[0]).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(second.keys).toEqual(first.keys)
    expect((await loadChatHistory(files.api, memoryStorage(), scope)).state.conversations[0]).toMatchObject({ id: '旧版对话/../1', draft: 'again' })
  })

  it('collapses saves requested while one is running into the newest snapshot', async () => {
    const files = memoryFiles()
    let release!: () => void
    files.api.writeHistory.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const writer = createHistoryWriter(files.api, null)
    const first = writer.save(workspace())
    await vi.waitFor(() => expect(files.api.writeHistory).toHaveBeenCalledTimes(1))
    for (const draft of ['a', 'ab', 'abc']) void writer.save({ ...workspace(), conversations: [{ ...workspace().conversations[0], draft }] })
    release()
    await first
    expect(files.api.writeHistory).toHaveBeenCalledTimes(2)
    expect((await loadChatHistory(files.api, memoryStorage(), scope)).state.conversations[0].draft).toBe('abc')
  })

  it('keeps the previous files when a write fails and writes everything still pending on the next save', async () => {
    const files = memoryFiles()
    const writer = createHistoryWriter(files.api, null)
    const state = workspace()
    await writer.save(state)
    const before = files.raw()
    files.api.writeHistory.mockRejectedValueOnce(new Error('disk full'))
    const changed = { ...state, conversations: [{ ...state.conversations[0], draft: 'new unsaved content' }] }
    await expect(writer.save(changed)).rejects.toThrow('disk full')
    expect(files.raw()).toBe(before)
    await writer.save({ ...changed })
    expect((await loadChatHistory(files.api, memoryStorage(), scope)).state.conversations[0].draft).toBe('new unsaved content')
  })

  it.each(['conversations', 'duplicate-message', 'duplicate-conversation', 'invalid-message', 'invalid-asset', 'missing-file', 'wrong-owner', 'broken-index'] as const)('refuses a lossy read of %s while retaining its original files', async (kind) => {
    const state = workspace(scope, kind === 'conversations' ? 51 : 1)
    if (kind === 'duplicate-message') state.conversations[0].messages.push(message())
    if (kind === 'duplicate-conversation') state.conversations.push(structuredClone(state.conversations[0]))
    if (kind === 'invalid-message') state.conversations[0].messages.push({ role: 'unrecognized' } as unknown as ChatMessage)
    if (kind === 'invalid-asset') state.conversations[0].messages[0].assets = [{ assetId: 'invalid' } as never]
    const snapshot = snapshotOf(state, kind === 'wrong-owner' ? 'xm-account:8' : scope)
    if (kind === 'missing-file') snapshot.conversations = []
    if (kind === 'broken-index') snapshot.index = '{truncated'
    const files = memoryFiles()
    files.stores.set(scope, snapshot)
    const before = files.raw()
    const restored = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(restored.warning).toContain('原始记录已保留')
    expect(restored.exists).toBe(true)
    expect(restored.saved).toBeNull()
    expect(files.raw()).toBe(before)
    expect(() => parseHistorySnapshot(snapshot, scope)).toThrow(ChatStorageError)
  })

  it('reports an unreadable store without falling back to older localStorage history', async () => {
    const storage = memoryStorage()
    storage.setItem(historyKey(scope), JSON.stringify(workspace()))
    const restored = await loadChatHistory({ readHistory: async () => { throw new Error('reparse point') } }, storage, scope)
    expect(restored).toMatchObject({ exists: true, saved: null, warning: '本地聊天记录暂时无法读取，原始数据已保留' })
    expect(restored.state.conversations).toHaveLength(0)
  })

  it('prefers the file store over an older localStorage copy once it has a record', async () => {
    const storage = memoryStorage()
    const old = workspace()
    old.conversations[0].draft = 'stale localStorage copy'
    storage.setItem(historyKey(scope), JSON.stringify(old))
    const files = memoryFiles()
    const current = workspace()
    current.conversations[0].draft = 'file store copy'
    const restored = await saveAndReopen(current, files, storage)
    expect(restored.state.conversations[0].draft).toBe('file store copy')
  })
})

describe('localStorage history from earlier versions', () => {
  it('reads a stored workspace and moves it into the file store on the first save, removing the source only after that save', async () => {
    const storage = memoryStorage()
    const state = workspace(scope, 2)
    const raw = JSON.stringify(state)
    storage.setItem(historyKey(scope), raw)
    storage.setItem.mockClear()
    const files = memoryFiles()
    const loaded = await loadChatHistory(files.api, storage, scope)
    expect(loaded).toMatchObject({ exists: true, saved: null })
    expect(loaded.state).toEqual(state)
    expect(storage.getItem(historyKey(scope))).toBe(raw)
    expect(storage.setItem).not.toHaveBeenCalled()
    await createHistoryWriter(files.api, loaded.saved, loaded.afterFirstSave).save(loaded.state)
    expect((await loadChatHistory(files.api, memoryStorage(), scope)).state).toEqual(state)
    expect(storage.getItem(historyKey(scope))).toBeNull()
  })

  it('keeps the source when the first save fails and removes it after a later save succeeds', async () => {
    const storage = memoryStorage()
    const state = workspace(scope, 1)
    const raw = JSON.stringify(state)
    storage.setItem(historyKey(scope), raw)
    const files = memoryFiles()
    const loaded = await loadChatHistory(files.api, storage, scope)
    let diskFull = true
    const writer = createHistoryWriter({ writeHistory: async (input) => { if (diskFull) throw new Error('disk full'); await files.api.writeHistory(input) } }, loaded.saved, loaded.afterFirstSave)
    await expect(writer.save(loaded.state)).rejects.toThrow('disk full')
    expect(storage.getItem(historyKey(scope))).toBe(raw)
    diskFull = false
    await writer.save({ ...loaded.state })
    expect(storage.getItem(historyKey(scope))).toBeNull()
  })

  it('does not bring migrated history back when the history folder is cleared later', async () => {
    const storage = memoryStorage()
    const state = workspace(scope, 1)
    storage.setItem(historyKey(scope), JSON.stringify(state))
    const files = memoryFiles()
    const loaded = await loadChatHistory(files.api, storage, scope)
    // Removal refused (for example by a locked profile): only the marker lands.
    storage.removeItem.mockImplementation(() => { throw new Error('denied') })
    await createHistoryWriter(files.api, loaded.saved, loaded.afterFirstSave).save(loaded.state)
    expect(storage.getItem(historyKey(scope))).not.toBeNull()
    files.stores.clear()
    const reopened = await loadChatHistory(files.api, storage, scope)
    expect(reopened).toMatchObject({ exists: false, saved: null })
    expect(reopened.state.conversations).toHaveLength(0)
    expect(reopened.afterFirstSave).toBeUndefined()
  })

  it('removes stale copies an earlier version left behind once the file store has a record', async () => {
    const storage = memoryStorage()
    const files = memoryFiles()
    const state = workspace(scope, 1)
    await createHistoryWriter(files.api, null).save(state)
    for (const key of legacyHistoryKeys(scope)) storage.setItem(key, 'stale copy')
    storage.setItem(historyKey('api-account:7'), 'another account')
    expect(legacyHistoryKeys(scope)).toEqual([historyKey(scope), historyKey('solov:7'), historyKey('sub2api:7'), legacyKey])
    expect((await loadChatHistory(files.api, storage, scope)).state).toEqual(state)
    for (const key of legacyHistoryKeys(scope)) expect(storage.getItem(key)).toBeNull()
    expect(storage.getItem(historyKey('api-account:7'))).toBe('another account')
  })

  it('keeps an unreadable localStorage record and never offers to remove it', async () => {
    const storage = memoryStorage()
    storage.setItem(historyKey(scope), '{not json')
    const loaded = await loadChatHistory(memoryFiles().api, storage, scope)
    expect(loaded.warning).toBeTruthy()
    expect(loaded.afterFirstSave).toBeUndefined()
    expect(storage.getItem(historyKey(scope))).toBe('{not json')
  })

  it.each(['conversations', 'duplicate-message', 'duplicate-conversation', 'invalid-message', 'invalid-asset'] as const)('refuses a lossy read of %s while retaining its original storage', (kind) => {
    const storage = memoryStorage()
    const state = workspace(scope, kind === 'conversations' ? 51 : 1)
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
})

describe('credential redaction before persistence', () => {
  const secrets = ['sk-live-0123456789abcdef', 'Bearer abcdef0123456789', 'blob:xingmang://9f1c', `data:image/png;base64,${'A'.repeat(600)}`]
  function secretWorkspace(): ChatWorkspace {
    const state = workspace()
    const conversation = state.conversations[0]
    conversation.title = `标题 ${secrets[0]}`
    conversation.draft = `草稿 ${secrets[1]}`
    conversation.settings.systemPrompt = `系统提示 ${secrets[0]}`
    conversation.messages = [
      message(0, { content: `请检查 ${secrets[0]} 与 ${secrets[3]}`, reasoning: `思考 ${secrets[1]}`, settings: conversation.settings }),
      message(1, { status: 'error', error: `失败：${secrets[2]}`, assets: [{ assetId: 'a'.repeat(43), mimeType: 'image/png', localUrl: 'runtime:1', fileName: '图.png', revisedPrompt: `提示词 ${secrets[0]}` }] }),
    ]
    state.draftConversation.draft = `另一个草稿 ${secrets[0]}`
    return state
  }

  it('keeps pasted keys, bearer headers and inline payloads out of every persisted text field', async () => {
    const files = memoryFiles()
    const state = secretWorkspace()
    const restored = (await saveAndReopen(state, files)).state
    const raw = files.raw() ?? ''
    for (const secret of secrets) expect(raw).not.toContain(secret)
    expect(raw).toContain('[密钥未保存]')
    expect(raw).toContain('[本地临时链接未保存]')
    expect(raw).toContain('[图片数据未保存]')
    expect(raw).toContain('content-1')
    expect(restored.conversations[0].title).toBe('标题 [密钥未保存]')
    expect(restored.conversations[0].draft).toBe('草稿 Bearer [密钥未保存]')
    expect(restored.conversations[0].settings.systemPrompt).toBe('系统提示 [密钥未保存]')
    expect(restored.conversations[0].messages[0].content).toBe('请检查 [密钥未保存] 与 [图片数据未保存]')
    expect(restored.conversations[0].messages[0].settings?.systemPrompt).toBe('系统提示 [密钥未保存]')
    expect(restored.conversations[0].messages[1].error).toBe('失败：[本地临时链接未保存]')
    expect(restored.conversations[0].messages[1].assets?.[0].revisedPrompt).toBe('提示词 [密钥未保存]')
    expect(restored.draftConversation.draft).toBe('另一个草稿 [密钥未保存]')
  })

  it('leaves the workspace held in the window untouched and stays stable across a second save', async () => {
    const files = memoryFiles()
    const state = secretWorkspace()
    const before = structuredClone(state)
    const restored = (await saveAndReopen(state, files)).state
    expect(state).toEqual(before)
    await createHistoryWriter(files.api, null).save(restored)
    expect((await loadChatHistory(files.api, memoryStorage(), scope)).state).toEqual(restored)
  })

  it('redacts credentials carried in configuration snippets and link parameters', () => {
    expect(redactPersistentChatText('api_key = "sk-abcdefghijkl"')).toBe('api_key = [密钥未保存]')
    expect(redactPersistentChatText('Authorization: Bearer abcdef0123456789')).toBe('Authorization: [密钥未保存]')
    expect(redactPersistentChatText('用 Bearer abcdef0123456789 调用')).toBe('用 Bearer [密钥未保存] 调用')
    expect(redactPersistentChatText('https://example.com/a?token=abcdef&page=2')).toBe('https://example.com/a?token=[密钥未保存]&page=2')
    expect(redactPersistentChatText(`hash ${'Zm9vYmFy'.repeat(80)} end`)).toBe(`hash ${'Zm9vYmFy'.repeat(80)} end`)
  })

  it('keeps ordinary links, prose and long Unicode content byte-identical', async () => {
    const state = workspace()
    const kept = '见 https://xm.example.test/docs/使用说明 与 http://127.0.0.1:3000 ，正文 🙂\n'.repeat(500)
    state.conversations[0].messages = [message(0, { content: kept, reasoning: kept })]
    state.conversations[0].draft = kept
    const restored = await saveAndReopen(state)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations[0].messages[0].content).toBe(kept)
    expect(restored.state.conversations[0].messages[0].reasoning).toBe(kept)
    expect(restored.state.conversations[0].draft).toBe(kept)
  })
})
describe('complete legacy and account-alias migration', () => {
  it('imports all historical messages, reasoning and system text without writing any localStorage key', () => {
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
    expect(readWorkspace(storage, scope).state.conversations[0].messages).toEqual(restored.state.conversations[0].messages)
    expect(storage.getItem(legacyKey)).toBe(raw)
    expect(storage.setItem.mock.calls.filter(([key]) => key !== legacyKey)).toHaveLength(0)
    expect(JSON.parse(planHistoryWrite(restored.state, null)!.write.put[0].content).conversation.messages).toHaveLength(210)
  })

  it('imports a legacy record past the former 4 MB limit in full', () => {
    const storage = memoryStorage()
    storage.setItem(legacyKey, legacy([message(0, { content: 'x'.repeat(formerLimitBytes) })]))
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations[0].messages[0].content).toHaveLength(formerLimitBytes)
  })

  it('imports a system-only old workspace instead of silently ignoring it', () => {
    const storage = memoryStorage()
    storage.setItem(legacyKey, legacy([{ role: 'system', content: 'only prompt' }]))
    expect(readWorkspace(storage, scope).state.conversations[0].settings.systemPrompt).toBe('only prompt')
  })

  it.each(['malformed', 'wrong-owner', 'invalid-message'] as const)('does not create a canonical key after a %s legacy read', (kind) => {
    const storage = memoryStorage()
    const raw = kind === 'malformed' ? '{invalid'
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

  it('refuses to save merged aliases beyond the conversation budget, while retaining every loaded conversation and both sources', async () => {
    const storage = memoryStorage()
    for (const alias of ['solov', 'sub2api']) {
      const state = workspace(`${alias}:7`, 30)
      state.conversations.forEach((item) => { item.id = `${alias}-${item.id}` })
      storage.setItem(historyKey(`${alias}:7`), JSON.stringify(state))
    }
    const files = memoryFiles()
    const restored = await loadChatHistory(files.api, storage, scope)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations).toHaveLength(60)
    await expect(createHistoryWriter(files.api, restored.saved).save(restored.state)).rejects.toThrow('上限')
    expect(files.raw()).toBeNull()
    expect(storage.getItem(historyKey('solov:7'))).not.toBeNull()
    expect(storage.getItem(historyKey('sub2api:7'))).not.toBeNull()
  })

  it('preserves readable migrated content and its source when the first save fails, so the next launch migrates again', async () => {
    const storage = memoryStorage()
    const raw = legacy([message(0, { content: 'long'.repeat(20_000) })])
    storage.setItem(legacyKey, raw)
    const files = memoryFiles()
    files.api.writeHistory.mockRejectedValueOnce(new Error('disk full'))
    const restored = await loadChatHistory(files.api, storage, scope)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations[0].messages[0].content).toHaveLength(80_000)
    await expect(createHistoryWriter(files.api, restored.saved).save(restored.state)).rejects.toThrow('disk full')
    expect(files.raw()).toBeNull()
    expect(storage.getItem(legacyKey)).toBe(raw)
    expect((await loadChatHistory(files.api, storage, scope)).state.conversations[0].messages[0].content).toHaveLength(80_000)
  })
})

describe('moving history to another computer', () => {
  const asset = { assetId: 'a'.repeat(43), localUrl: `xingmang-asset://image/${'a'.repeat(43)}`, mimeType: 'image/png' as const, fileName: 'x.png' }
  it('exports conversations without images, request state or pasted keys', () => {
    const state = workspace(scope, 1)
    state.conversations[0].messages = [message(0, { content: 'key sk-abcdefghijklmnop', mayStillComplete: true, requestId: 'r1' } as Partial<ChatMessage>), message(1, { content: '', assets: [asset] })]
    const exported = JSON.stringify(exportableConversations(state))
    expect(exported).not.toContain('sk-abcdefghijklmnop')
    expect(exported).not.toContain('assetId')
    expect(exported).not.toContain('mayStillComplete')
    expect(exported).not.toContain('requestId')
    expect(exported).toContain('[图片没有一起搬过来]')
  })

  it('round-trips exported conversations through the strict import parser', () => {
    const state = workspace(scope, 3)
    const parsed = parseImportedConversations(JSON.parse(JSON.stringify(exportableConversations(state))))
    expect(parsed.map((conversation) => conversation.id)).toEqual(state.conversations.map((conversation) => conversation.id))
  })

  it('rejects the whole import when one conversation is malformed', () => {
    const exported = JSON.parse(JSON.stringify(exportableConversations(workspace(scope, 2))))
    exported[1].messages[0].role = 'system'
    expect(() => parseImportedConversations(exported)).toThrow('没有导入任何内容')
    expect(() => parseImportedConversations([exported[0], exported[0]])).toThrow('没有导入任何内容')
    expect(() => parseImportedConversations(Array.from({ length: 51 }, () => exported[0]))).toThrow(ChatStorageError)
  })

  it('keeps existing conversations and the 50 most recent overall', () => {
    const state = workspace(scope, 49)
    state.conversations.forEach((conversation, index) => { conversation.updatedAt = 1000 + index })
    const same = { ...state.conversations[0], title: 'imported copy' }
    const newer = { ...createConversation(undefined, 'new-1'), updatedAt: 5000 }
    const older = { ...createConversation(undefined, 'old-1'), updatedAt: 1 }
    const merged = mergeImportedConversations(state, [same, newer, older])
    expect(merged.added).toBe(1)
    expect(merged.state.conversations).toHaveLength(50)
    expect(merged.state.conversations[0].id).toBe('new-1')
    expect(merged.state.conversations.find((conversation) => conversation.id === state.conversations[0].id)?.title).not.toBe('imported copy')
    expect(merged.state.conversations.some((conversation) => conversation.id === 'old-1')).toBe(false)
  })

  it('gives an imported conversation a new id when it collides with the draft', () => {
    const state = workspace(scope, 0)
    const merged = mergeImportedConversations(state, [{ ...createConversation(undefined, state.draftConversation.id), messages: [message()] }])
    expect(merged.added).toBe(1)
    expect(merged.state.conversations[0].id).not.toBe(state.draftConversation.id)
  })

  it('merges into the saved files and survives a reopen', async () => {
    const files = memoryFiles()
    await createHistoryWriter(files.api, null).save(workspace(scope, 2))
    const imported = parseImportedConversations(JSON.parse(JSON.stringify(exportableConversations(workspace('xm-account:9', 0)))))
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, imported)).toBe(0)
    const other = { ...createConversation(undefined, 'from-old-computer'), updatedAt: Date.now() + 1000, messages: [message()] }
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, [other])).toBe(1)
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, [other])).toBe(0)
    const reopened = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(reopened.state.conversations.map((conversation) => conversation.id)).toEqual(['from-old-computer', 'conversation-0', 'conversation-1'])
  })

  it('refuses to import over a record it cannot read', async () => {
    const files = memoryFiles()
    files.stores.set(scope, { index: 'not json', conversations: [] })
    await expect(importConversationsIntoHistory(files.api, memoryStorage(), scope, [createConversation()])).rejects.toThrow('没有导入对话')
    expect(files.api.writeHistory).not.toHaveBeenCalled()
  })

  it('waits for saves still in flight, including one started as the page goes away', async () => {
    let release: () => void = () => undefined
    const api = { writeHistory: vi.fn(() => new Promise<void>((resolve) => { release = resolve })) }
    void createHistoryWriter(api, null).save(workspace(scope, 1))
    let settled = false
    const waiting = settleHistoryWrites().then(() => { settled = true })
    await Promise.resolve(); await Promise.resolve()
    expect(api.writeHistory).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    release()
    await waiting
    expect(settled).toBe(true)
  })

  it('formats one conversation as plain text without keys', () => {
    const conversation = { ...createConversation(undefined, 'c'), title: '周报', messages: [message(0, { content: 'token=abcdef123456', createdAt: 1_700_000_000_000 }), message(1, { content: '好的', assets: [asset] }), message(3, { status: 'error', content: '', error: '网络断了' })] }
    const text = conversationPlainText(conversation)
    expect(text.startsWith('周报\n')).toBe(true)
    expect(text).toContain('我（')
    expect(text).toContain('AI（')
    expect(text).not.toContain('abcdef123456')
    expect(text).toContain('[1 张图片，没有放进这个文件]')
    expect(text).toContain('[没有回复成功：网络断了]')
  })
})
