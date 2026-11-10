import { describe, expect, it, vi } from 'vitest'
import type { AiChatHistorySnapshot, AiChatHistoryWrite } from '../../../../electron/ipc-contract'
import { createConversation, createWorkspace, type ChatMessage, type ChatWorkspace } from './state'
import { answerHistoryFlushRequests, autosaveDelay, autosaveMaxWaitMs, autosaveQuietMs, ChatStorageError, conversationLimitMessage, conversationPlainText, createHistoryWriter, flushChatHistory, registerHistoryFlusher, exportableConversations, historyKey, importConversationsIntoHistory, mergeImportedConversations, mergeSessionIntoHistory, parseImportedConversations, settleHistoryWrites, importLegacyHistory, legacyHistoryKeys, loadChatHistory, MAX_CONVERSATIONS, parseHistorySnapshot, planHistoryWrite, readWorkspace, redactPersistentChatText, runHistoryImport } from './storage'

const scope = 'xm-account:7'
const legacyKey = 'xingmang-ai-chat:v1:7'
const formerLimitBytes = 4 * 1024 * 1024
function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { data.set(key, value) }), removeItem: vi.fn((key: string) => { data.delete(key) }), keys: () => [...data.keys()] }
}
// Same contract as electron/ai-chat-history-store.ts: rewrite the listed
// conversations, then the index, then drop files the index no longer names,
// except the ones listed in setAside, which move into the backup folder.
function memoryFiles() {
  const stores = new Map<string, AiChatHistorySnapshot>()
  const aside = new Map<string, AiChatHistorySnapshot['conversations']>()
  const api = {
    readHistory: vi.fn(async (owner: string): Promise<AiChatHistorySnapshot> => structuredClone(stores.get(owner) ?? { index: null, conversations: [] })),
    writeHistory: vi.fn(async (input: AiChatHistoryWrite) => {
      const files = new Map((stores.get(input.scope)?.conversations ?? []).map((file) => [file.key, file.content]))
      for (const file of input.put) files.set(file.key, file.content)
      for (const key of input.setAside ?? []) {
        expect(input.keys).not.toContain(key)
        const content = files.get(key)
        if (content !== undefined) aside.set(input.scope, [...aside.get(input.scope) ?? [], { key, content }])
      }
      stores.set(input.scope, { index: input.index, conversations: input.keys.map((key) => ({ key, content: files.get(key)! })) })
    }),
    logHistoryProblem: vi.fn((_detail: string) => undefined),
  }
  function raw(owner = scope) { const snapshot = stores.get(owner); return snapshot ? [snapshot.index, ...snapshot.conversations.map((file) => file.content)].join('\n') : null }
  return { api, stores, aside, raw }
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

  // 0.2.24 深查 D6：以前 50 个就存满，天天用聊天的客户一两个月就得停下来删。主进程
  // ai-chat-history-store.ts 的上限是同一个数，那边的测试钉着同样的 200 / 201。
  it('saves and reopens 200 conversations and refuses the 201st with the same wording as before', async () => {
    expect(MAX_CONVERSATIONS).toBe(200)
    expect(conversationLimitMessage).toBe('最多保存 200 个对话，请先删除不再需要的对话')
    const state = workspace(scope, 200)
    const files = memoryFiles()
    const restored = await saveAndReopen(state, files)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations).toHaveLength(200)
    expect(files.api.writeHistory.mock.calls[0][0].keys).toHaveLength(200)
    const over = workspace(scope, 201)
    expect(() => planHistoryWrite(over, null)).toThrow('聊天记录超过 200 个，这台电脑存不下，原来的记录没动')
  })

  it('keeps images waiting in the composer as references, and refuses a malformed list', async () => {
    const state = workspace()
    const assetId = 'D'.repeat(43)
    state.conversations[0].draftImages = [{ assetId, mimeType: 'image/png', localUrl: `xingmang-asset://image/${assetId}`, fileName: 'shot.png' }]
    const files = memoryFiles()
    const restored = await saveAndReopen(state, files)
    expect(restored.state.conversations[0].draftImages).toEqual(state.conversations[0].draftImages)
    expect(files.raw()).not.toContain('xingmang-asset://')
    const broken = workspace()
    Object.assign(broken.conversations[0], { draftImages: 'not a list' })
    // Only that conversation is refused (and kept aside); the record as a whole still reads.
    const { state: rest, unreadable } = parseHistorySnapshot(snapshotOf(broken), scope)
    expect(rest.conversations).toEqual([])
    expect(unreadable).toEqual([{ key: 'k0', reason: '聊天图片列表无效，原始记录已保留', kept: true }])
  })

  it('remembers that the long-conversation warning was dismissed', async () => {
    const state = workspace()
    state.conversations[0].lengthNoticeDismissed = true
    const restored = await saveAndReopen(state)
    expect(restored.state.conversations[0].lengthNoticeDismissed).toBe(true)
    expect(restored.state).toEqual(state)
  })
  it('remembers which conversations are pinned or renamed and ignores anything but true', async () => {
    const state = workspace()
    Object.assign(state.conversations[0], { pinned: true, renamed: true, title: '自己起的名字' })
    const restored = await saveAndReopen(state)
    expect(restored.state.conversations[0]).toMatchObject({ pinned: true, renamed: true, title: '自己起的名字' })
    expect(restored.state).toEqual(state)
    const odd = workspace()
    Object.assign(odd.conversations[0], { pinned: 'yes', renamed: 1 })
    const reread = parseHistorySnapshot(snapshotOf(odd), scope).state.conversations[0]
    expect('pinned' in reread || 'renamed' in reread).toBe(false)
  })
  it('moves conversations saved under a group name the xm site retired onto its current name', () => {
    const state = workspace()
    const conversation = state.conversations[0]
    conversation.settings.group = 'GPT-中转/订阅'
    conversation.messages = [message(0, { settings: { ...conversation.settings, group: '图片模型-中转/订阅' } })]
    state.draftConversation.settings.group = 'GPT-官方API直连'
    const restored = parseHistorySnapshot(snapshotOf(state), scope).state
    expect(restored.conversations[0].settings.group).toBe('GPT')
    expect(restored.conversations[0].messages[0].settings?.group).toBe('图片模型')
    // 不是删掉的老名字就原样留着。
    expect(restored.draftConversation.settings.group).toBe('GPT-官方API直连')
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

  it('retains the prior files when a save exceeds the 200-conversation limit', async () => {
    const files = memoryFiles()
    const writer = createHistoryWriter(files.api, null)
    await writer.save(workspace())
    const before = files.raw()
    await expect(writer.save(workspace(scope, 201))).rejects.toThrow(ChatStorageError)
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

  // 索引本身坏了（读不出、归属不对、条目重复、超过上限）：整份不读、这一回不写，原文件不动。
  it.each(['conversations', 'duplicate-conversation', 'wrong-owner', 'broken-index', 'newer-index', 'broken-draft'] as const)('refuses a lossy read when the index has %s while retaining its original files', async (kind) => {
    const state = workspace(scope, kind === 'conversations' ? 201 : 2)
    if (kind === 'duplicate-conversation') state.conversations.push(structuredClone(state.conversations[0]))
    if (kind === 'broken-draft') state.draftConversation.messages.push({ role: 'unrecognized' } as unknown as ChatMessage)
    const snapshot = snapshotOf(state, kind === 'wrong-owner' ? 'xm-account:8' : scope)
    if (kind === 'broken-index') snapshot.index = '{truncated'
    if (kind === 'newer-index') snapshot.index = snapshot.index!.replace('"version":3', '"version":4')
    const files = memoryFiles()
    files.stores.set(scope, snapshot)
    const before = files.raw()
    const restored = await loadChatHistory(files.api, memoryStorage(), scope)
    // 原因只进日志，上屏一律是同一句；超过上限那句照说（W24）。
    expect(restored.warning).toBe(kind === 'conversations' ? '聊天记录超过 200 个，这台电脑存不下，原来的记录没动' : '以前的聊天记录暂时读不出来，原文件没动')
    expect(files.api.logHistoryProblem).toHaveBeenCalledWith(expect.stringMatching(/^聊天记录读不出来，这一回不保存：.+/))
    expect(restored.exists).toBe(true)
    expect(restored.saved).toBeNull()
    expect(restored.unreadable).toBeUndefined()
    expect(files.raw()).toBe(before)
    expect(() => parseHistorySnapshot(snapshot, scope)).toThrow(ChatStorageError)
  })

  // 0.2.24 深查聊天页 C2：以前一段对话坏了、少了，整份记录读不出来，以后聊的也全都不存。
  it.each(['truncated-file', 'duplicate-message', 'invalid-message', 'invalid-asset', 'wrong-file-owner', 'newer-file', 'mismatched-id'] as const)('skips only the conversation whose file has %s, keeps it aside and saves the rest', async (kind) => {
    const state = workspace(scope, 3)
    state.activeId = state.conversations[1].id
    const files = memoryFiles()
    await createHistoryWriter(files.api, null).save(state)
    const stored = files.stores.get(scope)!
    const broken = stored.conversations.find((file) => file.key === 'conversation-1')!
    const original = JSON.parse(broken.content)
    if (kind === 'truncated-file') broken.content = broken.content.slice(0, broken.content.length / 2)
    if (kind === 'duplicate-message') original.conversation.messages.push(original.conversation.messages[0])
    if (kind === 'invalid-message') original.conversation.messages.push({ role: 'unrecognized' })
    if (kind === 'invalid-asset') original.conversation.messages[0].assets = [{ assetId: 'invalid' }]
    if (kind === 'wrong-file-owner') original.owner = 'xm-account:8'
    if (kind === 'newer-file') original.version = 4
    if (kind === 'mismatched-id') original.conversation.id = 'someone-else'
    if (kind !== 'truncated-file') broken.content = JSON.stringify(original)
    const brokenContent = broken.content
    const loaded = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(loaded.warning).toBeUndefined()
    expect(loaded.unreadable).toBe(1)
    expect(loaded.state.conversations.map((conversation) => conversation.id)).toEqual(['conversation-0', 'conversation-2'])
    expect(loaded.state.activeId).toBeNull()
    expect(loaded.saved?.setAside).toEqual(['conversation-1'])
    expect(files.api.logHistoryProblem).toHaveBeenCalledWith(expect.stringContaining('c-conversation-1.json 读不出来，下次保存时挪进备份文件夹：'))
    // Nothing is written by reading; the broken file is still where it was.
    expect(files.stores.get(scope)?.conversations.find((file) => file.key === 'conversation-1')?.content).toBe(brokenContent)

    // The next save moves the broken file into the backup folder byte for byte instead of deleting it.
    const writer = createHistoryWriter(files.api, loaded.saved)
    await writer.save({ ...loaded.state, conversations: [{ ...loaded.state.conversations[0], draft: 'still saving' }, loaded.state.conversations[1]] })
    const first = files.api.writeHistory.mock.calls.at(-1)![0]
    expect(first.setAside).toEqual(['conversation-1'])
    expect(first.keys).toEqual(['conversation-0', 'conversation-2'])
    expect(files.aside.get(scope)).toEqual([{ key: 'conversation-1', content: brokenContent }])
    await writer.save({ ...loaded.state, conversations: [{ ...loaded.state.conversations[0], draft: 'and again' }, loaded.state.conversations[1]] })
    expect(files.api.writeHistory.mock.calls.at(-1)![0].setAside).toBeUndefined()

    const reopened = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(reopened.warning).toBeUndefined()
    expect(reopened.unreadable).toBeUndefined()
    expect(reopened.state.conversations.map((conversation) => conversation.draft)).toEqual(['and again', ''])
  })

  it('drops a conversation whose file is gone from the index without counting it as kept aside', async () => {
    const files = memoryFiles()
    await createHistoryWriter(files.api, null).save(workspace(scope, 3))
    const stored = files.stores.get(scope)!
    stored.conversations = stored.conversations.filter((file) => file.key !== 'conversation-0')
    const loaded = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(loaded.warning).toBeUndefined()
    // 文件已经没了，说「已经单独留着」就不对了；只记日志。
    expect(loaded.unreadable).toBeUndefined()
    expect(loaded.saved?.setAside).toBeUndefined()
    expect(files.api.logHistoryProblem).toHaveBeenCalledWith('聊天对话 c-conversation-0.json 不见了，已从记录里拿掉')
    expect(loaded.state.conversations.map((conversation) => conversation.id)).toEqual(['conversation-1', 'conversation-2'])
    // The index still names the missing file, so the very next save rewrites it even with nothing else changed.
    const plan = planHistoryWrite(loaded.state, loaded.saved)
    expect(plan?.write).toMatchObject({ keys: ['conversation-1', 'conversation-2'], put: [] })
  })

  it('never hands a conversation the file name of one still waiting to be moved aside', () => {
    const state = workspace(scope, 2)
    const snapshot = snapshotOf(state)
    snapshot.conversations[1].content = '{truncated'
    const { state: loaded, saved } = parseHistorySnapshot(snapshot, scope)
    expect(saved.setAside).toEqual(['k1'])
    const fresh = { ...createConversation(undefined, 'k1'), messages: [message()] }
    const plan = planHistoryWrite({ ...loaded, conversations: [fresh, ...loaded.conversations] }, saved)!
    expect(plan.write.setAside).toEqual(['k1'])
    expect(plan.write.keys).not.toContain('k1')
    expect(plan.write.put.map((file) => file.key)).not.toContain('k1')
  })

  it('keeps reading the rest when every conversation file is broken, and still writes nothing until the page saves', async () => {
    const state = workspace(scope, 2)
    const snapshot = snapshotOf(state)
    snapshot.conversations = snapshot.conversations.map((file) => ({ ...file, content: 'garbage' }))
    const files = memoryFiles()
    files.stores.set(scope, snapshot)
    const loaded = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(loaded).toMatchObject({ exists: true, unreadable: 2 })
    expect(loaded.warning).toBeUndefined()
    expect(loaded.state.conversations).toEqual([])
    expect(files.api.writeHistory).not.toHaveBeenCalled()
  })

  it('carries the conversations to move aside into an import, so the import does not delete them', async () => {
    const files = memoryFiles()
    await createHistoryWriter(files.api, null).save(workspace(scope, 2))
    const stored = files.stores.get(scope)!
    stored.conversations[0].content = '{truncated'
    const other = { ...createConversation(undefined, 'from-old-computer'), updatedAt: 3000, messages: [message()] }
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, [other])).toEqual({ added: 1, skipped: 0 })
    expect(files.api.writeHistory.mock.calls.at(-1)![0].setAside).toEqual(['conversation-0'])
    expect(files.aside.get(scope)).toEqual([{ key: 'conversation-0', content: '{truncated' }])
  })

  it('reports an unreadable store without falling back to older localStorage history', async () => {
    const storage = memoryStorage()
    storage.setItem(historyKey(scope), JSON.stringify(workspace()))
    const restored = await loadChatHistory({ readHistory: async () => { throw new Error('reparse point') } }, storage, scope)
    expect(restored).toMatchObject({ exists: true, saved: null, warning: '以前的聊天记录暂时读不出来，原文件没动' })
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

// 回复出字时主进程每 50 毫秒推一段，等「停下 250 毫秒」的自动保存一直被重置，整段说完才存第一次；
// 这时退出或崩了，已经扣了费的回复就没了（0.2.24 深查聊天页 C1）。
describe('saving a reply while it is still streaming', () => {
  it('waits for a pause, but never longer than the cap after the first unsaved change', () => {
    expect(autosaveQuietMs).toBe(250)
    expect(autosaveMaxWaitMs).toBe(2_000)
    // A lone edit still saves once typing pauses.
    expect(autosaveDelay(1_000, 1_000)).toBe(autosaveQuietMs)
    // Chunks keep arriving every 50 ms: the wait shrinks as the cap approaches...
    expect(autosaveDelay(1_000, 2_800)).toBe(200)
    expect(autosaveDelay(1_000, 2_950)).toBe(50)
    // ...and once it is reached the save happens right away.
    expect(autosaveDelay(1_000, 3_000)).toBe(0)
    expect(autosaveDelay(1_000, 9_000)).toBe(0)
  })

  it('saves at least every two seconds while chunks keep arriving every 50 ms', () => {
    // Replays the controller's effect: every state change reschedules the
    // save; the save itself clears the first-unsaved-change mark.
    let since: number | null = null
    let due: number | null = null
    const saves: number[] = []
    for (let now = 0; now <= 6_000; now += 50) {
      if (due !== null && due <= now) { saves.push(due); since = null; due = null }
      since ??= now
      due = now + autosaveDelay(since, now)
    }
    expect(saves.length).toBeGreaterThanOrEqual(2)
    expect(saves[0]).toBeLessThanOrEqual(autosaveMaxWaitMs)
    for (let index = 1; index < saves.length; index += 1) expect(saves[index] - saves[index - 1]).toBeLessThanOrEqual(autosaveMaxWaitMs + 50)
  })

  it('keeps the partial reply when the window goes away mid-stream and shows it as stopped next time', async () => {
    const files = memoryFiles()
    const state = workspace()
    state.conversations[0].messages.push(message(1, { content: 'half of the answer', reasoning: '', status: 'streaming', requestId: 'request-1' }))
    const restored = await saveAndReopen(state, files)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations[0].messages[1]).toMatchObject({ content: 'half of the answer', status: 'canceled' })
    expect(restored.state.conversations[0].messages[1].requestId).toBeUndefined()
  })
})

describe('saving before the app quits', () => {
  it('has every open chat page save now, and waits for those writes to land', async () => {
    const files = memoryFiles()
    let release!: () => void
    files.api.writeHistory.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => { release = resolve })
      files.stores.set(input.scope, { index: input.index, conversations: input.put })
    })
    const writer = createHistoryWriter(files.api, null)
    const state = workspace()
    const unregister = registerHistoryFlusher(() => writer.save(state))
    try {
      let flushed = false
      const flushing = flushChatHistory().then(() => { flushed = true })
      await vi.waitFor(() => expect(files.api.writeHistory).toHaveBeenCalledTimes(1))
      await Promise.resolve()
      expect(flushed).toBe(false)
      release()
      await flushing
      expect((await loadChatHistory(files.api, memoryStorage(), scope)).state.conversations[0].id).toBe(state.conversations[0].id)
    } finally { unregister() }
  })

  it('also waits for the last save of a chat page that has just closed', async () => {
    const files = memoryFiles()
    let release!: () => void
    files.api.writeHistory.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => { release = resolve })
      files.stores.set(input.scope, { index: input.index, conversations: input.put })
    })
    // No page is registered any more; its unmount save is still on the way.
    const closing = createHistoryWriter(files.api, null).save(workspace())
    let flushed = false
    const flushing = flushChatHistory().then(() => { flushed = true })
    await vi.waitFor(() => expect(files.api.writeHistory).toHaveBeenCalledTimes(1))
    expect(flushed).toBe(false)
    release()
    await Promise.all([closing, flushing])
  })

  it('finishes even when a page fails to save or throws, and leaves the other pages saving', async () => {
    const saved = vi.fn(async () => {})
    const unregister = [
      registerHistoryFlusher(() => { throw new Error('boom') }),
      registerHistoryFlusher(async () => { throw new Error('disk full') }),
      registerHistoryFlusher(saved),
    ]
    try {
      await expect(flushChatHistory()).resolves.toBeUndefined()
      expect(saved).toHaveBeenCalledOnce()
    } finally { for (const remove of unregister) remove() }
  })

  it('stops asking a page once it has unregistered', async () => {
    const flush = vi.fn(async () => {})
    registerHistoryFlusher(flush)()
    await flushChatHistory()
    expect(flush).not.toHaveBeenCalled()
  })

  it('answers the quit request with its own number only after the save, even if saving failed', async () => {
    let listener: ((request: { requestId: string }) => void) | undefined
    const confirmed: string[] = []
    const order: string[] = []
    const bridge = {
      onAiChatHistoryFlushRequested: vi.fn((callback: (request: { requestId: string }) => void) => { listener = callback; return () => { listener = undefined } }),
      confirmAiChatHistoryFlushed: vi.fn(async (requestId: string) => { order.push('confirm'); confirmed.push(requestId) }),
    }
    const unregister = registerHistoryFlusher(async () => { order.push('save'); throw new Error('disk full') })
    const unsubscribe = answerHistoryFlushRequests(bridge)
    try {
      listener?.({ requestId: 'request-1' })
      await vi.waitFor(() => expect(confirmed).toEqual(['request-1']))
      expect(order).toEqual(['save', 'confirm'])
    } finally { unregister(); unsubscribe() }
    expect(listener).toBeUndefined()
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
    const files = memoryFiles()
    const loaded = await loadChatHistory(files.api, storage, scope)
    expect(loaded.warning).toBe('以前的聊天记录暂时读不出来，原文件没动')
    expect(loaded).not.toHaveProperty('problem')
    expect(files.api.logHistoryProblem).toHaveBeenCalledWith(expect.stringMatching(/^以前存在本机的聊天记录读不出来，这一回不保存：.+/))
    expect(loaded.afterFirstSave).toBeUndefined()
    expect(storage.getItem(historyKey(scope))).toBe('{not json')
  })

  it.each(['conversations', 'duplicate-message', 'duplicate-conversation', 'invalid-message', 'invalid-asset'] as const)('refuses a lossy read of %s while retaining its original storage', (kind) => {
    const storage = memoryStorage()
    const state = workspace(scope, kind === 'conversations' ? 201 : 1)
    if (kind === 'duplicate-message') state.conversations[0].messages.push(message())
    if (kind === 'duplicate-conversation') state.conversations.push(structuredClone(state.conversations[0]))
    if (kind === 'invalid-message') state.conversations[0].messages.push({ role: 'unrecognized' } as unknown as ChatMessage)
    if (kind === 'invalid-asset') state.conversations[0].messages[0].assets = [{ assetId: 'invalid' } as never]
    const raw = JSON.stringify(state)
    storage.setItem(historyKey(scope), raw)
    storage.setItem.mockClear()
    const restored = readWorkspace(storage, scope)
    expect(restored.warning).toBe(kind === 'conversations' ? '聊天记录超过 200 个，这台电脑存不下，原来的记录没动' : '以前的聊天记录暂时读不出来，原文件没动')
    expect(restored.problem).toBeTruthy()
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

  // Every value is invented for the test and built at run time, so no whole
  // token sits in the source: the prefixes follow the vendor formats, the bodies
  // are filler. These are the shapes the log redaction table already hid while
  // the chat history kept them verbatim.
  const fakeJwt = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'), Buffer.from('{"sub":"fake-test-user"}').toString('base64url'), 'fake-signature_filler-0123'].join('.')
  const sharedShapes = [
    `xai-${'FakeGrokTestValueFillerOnly0123456789'}`,
    `ghp_${'FakeClassicTokenFiller0123'}`,
    `github_pat_${'Fake_Fine_Grained_Filler_0123'}`,
    `glpat-${'Fake-GitLab-Filler-012345'}`,
    `AIza${'Fake0Test1Value2Filler3Xy'.padEnd(35, 'z')}`,
    fakeJwt,
    `AKIA${'FAKE0TEST1FILLER'}`,
  ]
  const sharedShapeText = [
    ...sharedShapes.map((secret) => `我的密钥是 ${secret} ，帮我看看`),
    'git clone https://fake-user:plain-fake-userinfo@git.example.invalid/acme/demo.git',
    'ssh://oauth2:plain-fake-sshpass@git.example.invalid/acme',
    '-----BEGIN OPENSSH PRIVATE KEY-----\nplain-fake-pem-body\n-----END OPENSSH PRIVATE KEY-----',
  ].join('\n')
  const sharedLeaks = [...sharedShapes, 'plain-fake-userinfo', 'plain-fake-sshpass', 'plain-fake-pem-body']

  it('hides every key shape the log redaction table hides, in the chat wording', () => {
    const saved = redactPersistentChatText(sharedShapeText)
    for (const secret of sharedLeaks) expect(saved).not.toContain(secret)
    expect(saved).not.toContain('[REDACTED]')
    expect(saved).toContain('我的密钥是 [密钥未保存] ，帮我看看')
    expect(saved).toContain('git clone https://[密钥未保存]@git.example.invalid/acme/demo.git')
    expect(saved).toContain('ssh://[密钥未保存]@git.example.invalid/acme')
    expect(saved).toContain('-----BEGIN OPENSSH PRIVATE KEY-----\n[密钥未保存]\n-----END OPENSSH PRIVATE KEY-----')
    expect(redactPersistentChatText('ssh://git@github.com/acme/demo.git 和 npm i -g @xai-official/grok')).toBe('ssh://git@github.com/acme/demo.git 和 npm i -g @xai-official/grok')
  })

  it('keeps a relay key whole when it ends in a dash or carries a dot', () => {
    expect(redactPersistentChatText('密钥 sk-fake-relay-value- 用不了')).toBe('密钥 [密钥未保存] 用不了')
    expect(redactPersistentChatText('密钥 sk-fake.relay.value 用不了。')).toBe('密钥 [密钥未保存] 用不了。')
    expect(redactPersistentChatText('结尾 sk-fake-relay-value.')).toBe('结尾 [密钥未保存].')
  })

  // The shared table runs last: its `sk-` rule would otherwise swallow the
  // `api_key` name glued to it and leave the named-value rule nothing to find.
  it('still hides a named value whose name is glued to something that looks like a key', () => {
    expect(redactPersistentChatText('sk-api_key=plain-fake-value')).not.toContain('plain-fake-value')
  })

  it('still replaces a whole inline image whose base64 happens to contain key shapes', () => {
    const payload = `data:image/png;base64,${'QUJD'.repeat(40)}${fakeJwt.replaceAll('.', '')}sk-abcdefghijklAIza${'B'.repeat(35)}`
    expect(redactPersistentChatText(`图 ${payload} 完`)).toBe('图 [图片数据未保存] 完')
  })

  it('gives the same text when an already saved record is saved again', () => {
    const once = redactPersistentChatText(`${sharedShapeText}\nAuthorization: Bearer abcdef0123456789\n?token=abc&api_key=def`)
    expect(redactPersistentChatText(once)).toBe(once)
  })

  it('keeps the newly covered shapes out of the history files and the export for another computer', async () => {
    const files = memoryFiles()
    const state = workspace()
    state.conversations[0].messages = [message(0, { content: sharedShapeText, reasoning: sharedShapeText }), message(1, { content: `回复 ${sharedShapes[0]}` })]
    state.conversations[0].draft = sharedShapeText
    await saveAndReopen(state, files)
    const raw = files.raw() ?? ''
    const exported = JSON.stringify(exportableConversations(state))
    for (const secret of sharedLeaks) {
      expect(raw).not.toContain(secret)
      expect(exported).not.toContain(secret)
    }
    expect(exported).toContain('[密钥未保存]')
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

  // Code that merely names a token, password, secret, API key or Authorization
  // header used to lose everything after the name on the next start, so commands
  // copied back out of the history no longer ran. The first six lines are the
  // ones the chat-page audit (C3) saw broken.
  const codeThatNamesSecrets = [
    'const token = req.headers.authorization',
    'password: string',
    'api_key = os.environ["OPENAI_API_KEY"]',
    'password = input("请输入密码：")',
    'curl -H "Authorization: Bearer $TOKEN" https://api.example.test/v1/models',
    'secret: ${{ secrets.DEPLOY_KEY }}',
    'client = OpenAI(api_key=api_key)',
    'headers: { Authorization: `Bearer ${token}` }',
    'token: process.env.GITHUB_TOKEN,',
    'password=os.getenv("DB_PASSWORD")',
    "const labels = { token: '令牌', password: '密码', secret: 'Client secret' }",
    'api_key: Optional[str] = None',
    'interface Login { password: string; token?: string; secret: Uint8Array }',
    "token = ''",
    'OPENAI_API_KEY=<YOUR_API_KEY>',
    'export GITHUB_TOKEN=$(gh auth token)',
    'set API_KEY=%OPENAI_API_KEY%',
    'api_key: {{ .Values.apiKey }}',
    'const token = await getAccessToken()',
    'csrf_token = request.cookies.get("csrftoken")',
    'token = document.getElementById("token").value',
  ]

  it('keeps code that only names a token, password, secret, API key or Authorization header', () => {
    for (const line of codeThatNamesSecrets) expect(redactPersistentChatText(line)).toBe(line)
  })

  // Invented at run time like the shapes above. Each one is something a person
  // could really paste as a value: random letters and digits, a password with
  // symbols, hex, a UUID, base64, a bcrypt hash, a prefixed vendor token.
  const fakeHex = 'f0e1d2c3b4a59687'.repeat(2)
  const fakeMixed = ['a1B2c3', 'D4e5F6', 'g7H8i9'].join('')
  const fakePassword = ['Xk9', '#mP2', '$vL'].join('')
  const fakeShortPassword = ['hun', 'ter', '2'].join('')
  const fakeUuid = [fakeHex.slice(0, 8), fakeHex.slice(8, 12), fakeHex.slice(12, 16), fakeHex.slice(16, 20), fakeHex.slice(20, 32)].join('-')
  const fakeBase64 = `${'ZmFrZS1zZWNy'.repeat(2)}==`
  const fakeBcrypt = `$2b$12$${fakeMixed.repeat(3)}`
  const fakeVendor = `pk_live_${fakeMixed}`
  const fakeLetters = ['yKJxHG', 'pzLzGk', 'BBsmID', 'cIbbzX'].join('')
  const namedSecrets: Array<[string, string]> = [
    [`token=${fakeMixed}`, fakeMixed],
    [`DB_PASSWORD=${fakePassword}`, fakePassword],
    [`password: ${fakeShortPassword}`, fakeShortPassword],
    [`secret = ${fakeHex}`, fakeHex],
    [`token: ${fakeUuid}`, fakeUuid],
    [`api_key: "${fakeBase64}"`, fakeBase64],
    [`password: ${fakeBcrypt}`, fakeBcrypt],
    [`apiKey: '${fakeVendor}'`, fakeVendor],
    [`api_key = ${fakeLetters}`, fakeLetters],
    [`token = \`${fakeMixed} extra\``, fakeMixed],
    [`password = "my pass ${fakePassword}"`, fakePassword],
    [`password=${fakeMixed}，记得改`, fakeMixed],
    [`token = getToken${fakeMixed}()`, fakeMixed],
    ['token: 12345678', '12345678'],
  ]

  it('still hides named values that look like real secrets', () => {
    for (const [line, secret] of namedSecrets) {
      const saved = redactPersistentChatText(line)
      expect(saved).not.toContain(secret)
      expect(saved).toContain('[密钥未保存]')
    }
  })

  it('keeps the brackets and quotes around a hidden value and gives the same text on a second save', () => {
    expect(redactPersistentChatText(`client = OpenAI(api_key="${fakeHex}")`)).toBe('client = OpenAI(api_key=[密钥未保存])')
    expect(redactPersistentChatText(`curl -H "X-Api-Key: ${fakeHex}" https://api.example.test`)).toBe('curl -H "X-Api-Key: [密钥未保存]" https://api.example.test')
    expect(redactPersistentChatText(`client = OpenAI(api_key="sk-${fakeHex}")`)).toBe('client = OpenAI(api_key=[密钥未保存])')
    const mixed = [...codeThatNamesSecrets, ...namedSecrets.map(([line]) => line), `{"x": "y"}api_key='${fakeHex}'}]`].join('\n')
    const once = redactPersistentChatText(mixed)
    expect(redactPersistentChatText(once)).toBe(once)
  })

  it('keeps code intact in the history files, the export for another computer and the plain-text export', async () => {
    const files = memoryFiles()
    const code = codeThatNamesSecrets.join('\n')
    const state = workspace()
    state.conversations[0].messages = [message(0, { content: `用 token=${fakeMixed} 写一段调用接口的代码` }), message(1, { content: code })]
    const restored = await saveAndReopen(state, files)
    expect(restored.state.conversations[0].messages[1].content).toBe(code)
    expect(files.raw() ?? '').not.toContain(fakeMixed)
    const exported = JSON.stringify(exportableConversations(state))
    expect(exported).toContain(JSON.stringify(code).slice(1, -1))
    expect(exported).not.toContain(fakeMixed)
    expect(conversationPlainText(state.conversations[0])).toContain(code)
    expect(conversationPlainText(state.conversations[0])).not.toContain(fakeMixed)
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
      const state = workspace(`${alias}:7`, 101)
      state.conversations.forEach((item) => { item.id = `${alias}-${item.id}` })
      storage.setItem(historyKey(`${alias}:7`), JSON.stringify(state))
    }
    const files = memoryFiles()
    const restored = await loadChatHistory(files.api, storage, scope)
    expect(restored.warning).toBeUndefined()
    expect(restored.state.conversations).toHaveLength(202)
    await expect(createHistoryWriter(files.api, restored.saved).save(restored.state)).rejects.toThrow('聊天记录超过 200 个，这台电脑存不下，原来的记录没动')
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
    expect(() => parseImportedConversations(Array.from({ length: 201 }, () => exported[0]))).toThrow(ChatStorageError)
  })

  it('keeps every existing conversation and imports only the newest ones that fit', () => {
    const state = workspace(scope, 198)
    state.conversations.forEach((conversation, index) => { conversation.updatedAt = 1000 + index })
    state.activeId = state.conversations[0].id
    const same = { ...state.conversations[0], title: 'imported copy' }
    const newer = { ...createConversation(undefined, 'new-1'), updatedAt: 5000 }
    const older = { ...createConversation(undefined, 'old-1'), updatedAt: 1 }
    const oldest = { ...createConversation(undefined, 'old-2'), updatedAt: 0 }
    const merged = mergeImportedConversations(state, [same, oldest, older, newer])
    expect(merged.added).toBe(2)
    expect(merged.skipped).toBe(1)
    expect(merged.state.conversations).toHaveLength(200)
    expect(merged.state.conversations[0].id).toBe('new-1')
    expect(merged.state.conversations.at(-1)?.id).toBe('old-1')
    for (const conversation of state.conversations) expect(merged.state.conversations.some((item) => item.id === conversation.id)).toBe(true)
    expect(merged.state.conversations.find((conversation) => conversation.id === state.conversations[0].id)?.title).not.toBe('imported copy')
    expect(merged.state.conversations.some((conversation) => conversation.id === 'old-2')).toBe(false)
    expect(merged.state.activeId).toBe(state.conversations[0].id)
  })

  it('imports nothing and deletes nothing when this computer already holds 200 conversations', () => {
    const state = workspace(scope, 200)
    state.conversations.forEach((conversation, index) => { conversation.updatedAt = 2000 - index })
    const merged = mergeImportedConversations(state, [{ ...createConversation(undefined, 'new-1'), updatedAt: 5000 }, state.conversations[3]])
    expect(merged.added).toBe(0)
    expect(merged.skipped).toBe(1)
    expect(merged.state.conversations.map((conversation) => conversation.id)).toEqual(state.conversations.map((conversation) => conversation.id))
  })

  it('gives an imported conversation a new id when it collides with the draft', () => {
    const state = workspace(scope, 0)
    const merged = mergeImportedConversations(state, [{ ...createConversation(undefined, state.draftConversation.id), messages: [message()] }])
    expect(merged.added).toBe(1)
    expect(merged.state.conversations[0].id).not.toBe(state.draftConversation.id)
  })

  it('merges into the saved files and survives a reopen', async () => {
    const files = memoryFiles()
    // 导入按 updatedAt 倒序排；夹具连着建的两个对话偶尔跨过一毫秒，后建的就排到前面，所以时间写死。
    const saved = workspace(scope, 2)
    saved.conversations.forEach((conversation, index) => { conversation.updatedAt = 2000 - index * 1000 })
    await createHistoryWriter(files.api, null).save(saved)
    const imported = parseImportedConversations(JSON.parse(JSON.stringify(exportableConversations(workspace('xm-account:9', 0)))))
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, imported)).toEqual({ added: 0, skipped: 0 })
    const other = { ...createConversation(undefined, 'from-old-computer'), updatedAt: 3000, messages: [message()] }
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, [other])).toEqual({ added: 1, skipped: 0 })
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, [other])).toEqual({ added: 0, skipped: 0 })
    const reopened = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(reopened.state.conversations.map((conversation) => conversation.id)).toEqual(['from-old-computer', 'conversation-0', 'conversation-1'])
  })

  it('never deletes a saved conversation to make room for imported ones', async () => {
    const files = memoryFiles()
    const saved = workspace(scope, 199)
    saved.conversations.forEach((conversation, index) => { conversation.updatedAt = 1000 + index })
    await createHistoryWriter(files.api, null).save(saved)
    const imported = [3, 2, 1].map((index) => ({ ...createConversation(undefined, `from-old-computer-${index}`), updatedAt: 5000 + index, messages: [message()] }))
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, imported)).toEqual({ added: 1, skipped: 2 })
    const reopened = await loadChatHistory(files.api, memoryStorage(), scope)
    expect(reopened.state.conversations).toHaveLength(200)
    expect(reopened.state.conversations[0].id).toBe('from-old-computer-3')
    expect(new Set(reopened.state.conversations.slice(1).map((conversation) => conversation.id))).toEqual(new Set(saved.conversations.map((conversation) => conversation.id)))
    files.api.writeHistory.mockClear()
    expect(await importConversationsIntoHistory(files.api, memoryStorage(), scope, imported)).toEqual({ added: 0, skipped: 2 })
    expect(files.api.writeHistory).not.toHaveBeenCalled()
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

  // R28-2：导入还没写盘就点进聊天页，聊天页读到的是导入前那一份，下一次自动保存把刚导入的对话又删了。
  it('makes a chat page opened during an import read only once the import is saved', async () => {
    const files = memoryFiles()
    await createHistoryWriter(files.api, null).save(workspace(scope, 1))
    const write = files.api.writeHistory.getMockImplementation()!
    let release: () => void = () => undefined
    files.api.writeHistory.mockImplementationOnce((input) => new Promise<void>((resolve) => { release = () => { void write(input).then(resolve) } }))
    const imported = { ...createConversation(undefined, 'from-old-computer'), messages: [message()] }
    const importing = runHistoryImport(scope, () => importConversationsIntoHistory(files.api, memoryStorage(), scope, [imported]))
    const page = loadChatHistory(files.api, memoryStorage(), scope)
    await vi.waitFor(() => expect(files.api.writeHistory).toHaveBeenCalledTimes(2))
    expect(files.api.readHistory).toHaveBeenCalledOnce()
    release()
    expect(await importing).toEqual({ added: 1, skipped: 0 })
    expect(new Set((await page).state.conversations.map((conversation) => conversation.id))).toEqual(new Set(['from-old-computer', 'conversation-0']))
  })

  it('holds a chat page that remounts as the import starts', async () => {
    const files = memoryFiles()
    const imported = { ...createConversation(undefined, 'from-old-computer'), messages: [message()] }
    let page: ReturnType<typeof loadChatHistory> | undefined
    await runHistoryImport(scope, async () => {
      page = loadChatHistory(files.api, memoryStorage(), scope)
      return importConversationsIntoHistory(files.api, memoryStorage(), scope, [imported])
    })
    expect((await page!).state.conversations.map((conversation) => conversation.id)).toEqual(['from-old-computer'])
  })

  it('lets reads through once an import fails, and never holds another account', async () => {
    const files = memoryFiles()
    let fail: (reason: Error) => void = () => undefined
    const importing = runHistoryImport(scope, () => new Promise<never>((_, reject) => { fail = reject }))
    expect((await loadChatHistory(files.api, memoryStorage(), 'xm-account:9')).exists).toBe(false)
    const page = loadChatHistory(files.api, memoryStorage(), scope)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(files.api.readHistory).toHaveBeenCalledOnce()
    fail(new Error('导入失败'))
    await expect(importing).rejects.toThrow('导入失败')
    expect((await page).exists).toBe(false)
    expect(files.api.readHistory).toHaveBeenCalledTimes(2)
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

// 以前的记录没读出来时，这一回聊的内容只在窗口里；点「重新读取」读出来以后要并进去接着存。
describe('reading an unreadable record again', () => {
  function session(conversations: string[], activeId: string | null, draft = '') {
    const state = createWorkspace(scope)
    state.conversations = conversations.map((id) => ({ ...createConversation(undefined, id), messages: [message()] }))
    state.activeId = activeId
    state.draftConversation = { ...state.draftConversation, draft }
    return state
  }

  it('puts what was said meanwhile ahead of the record and stays on the conversation in view', () => {
    const loaded = workspace(scope, 2)
    const merged = mergeSessionIntoHistory(loaded, session(['said-meanwhile'], 'said-meanwhile', 'still typing'))
    expect(merged.conversations.map((conversation) => conversation.id)).toEqual(['said-meanwhile', 'conversation-0', 'conversation-1'])
    expect(merged.activeId).toBe('said-meanwhile')
    expect(merged.draftConversation.draft).toBe('still typing')
    expect(new Set([merged.draftConversation.id, ...merged.conversations.map((conversation) => conversation.id)]).size).toBe(4)
  })

  it('returns to where the record left off when nothing happened meanwhile', () => {
    const loaded = workspace(scope, 2)
    loaded.activeId = 'conversation-1'
    loaded.draftConversation = { ...loaded.draftConversation, draft: 'saved draft' }
    const merged = mergeSessionIntoHistory(loaded, session([], null))
    expect(merged.activeId).toBe('conversation-1')
    expect(merged.draftConversation).toBe(loaded.draftConversation)
    expect(merged.conversations).toEqual(loaded.conversations)
  })

  it('stays on a new conversation being typed instead of jumping to the saved one', () => {
    const merged = mergeSessionIntoHistory(workspace(scope, 1), session([], null, 'half a question'))
    expect(merged.activeId).toBeNull()
    expect(merged.draftConversation.draft).toBe('half a question')
  })

  it('renames a clashing id so the saved record stays readable', () => {
    const loaded = workspace(scope, 1)
    const merged = mergeSessionIntoHistory(loaded, session(['conversation-0'], 'conversation-0'))
    const ids = merged.conversations.map((conversation) => conversation.id)
    expect(new Set(ids).size).toBe(2)
    expect(merged.activeId).toBe(ids[0])
    expect(merged.activeId).not.toBe('conversation-0')
  })

  it('keeps every conversation past the limit so saving asks to delete some rather than dropping any', () => {
    const merged = mergeSessionIntoHistory(workspace(scope, 200), session(['said-meanwhile'], 'said-meanwhile'))
    expect(merged.conversations).toHaveLength(201)
    expect(() => planHistoryWrite(merged, null)).toThrow('聊天记录超过 200 个，这台电脑存不下，原来的记录没动')
  })
})
