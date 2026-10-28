import { describe, expect, it, vi } from 'vitest'
import type { AiChatHistorySnapshot, AiChatHistoryWrite } from '../../../../electron/ipc-contract'
import { createConversation, createWorkspace, type ChatWorkspace } from './state'
import { createHistoryWriter, loadChatHistory, type LoadedChatHistory } from './storage'
import { createChatTransfer } from './transfer'

const scope = 'xm-account:7'
function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}
// Same contract as electron/ai-chat-history-store.ts: rewrite the listed
// conversations, then the index, then drop files the index no longer names.
function memoryFiles() {
  const stores = new Map<string, AiChatHistorySnapshot>()
  const bridge = {
    readAiChatHistory: vi.fn(async (owner: string): Promise<AiChatHistorySnapshot> => structuredClone(stores.get(owner) ?? { index: null, conversations: [] })),
    writeAiChatHistory: vi.fn(async (input: AiChatHistoryWrite) => {
      const files = new Map((stores.get(input.scope)?.conversations ?? []).map((file) => [file.key, file.content]))
      for (const file of input.put) files.set(file.key, file.content)
      stores.set(input.scope, { index: input.index, conversations: input.keys.map((key) => ({ key, content: files.get(key)! })) })
    }),
  }
  const api = { readHistory: bridge.readAiChatHistory, writeHistory: bridge.writeAiChatHistory }
  return { bridge, api }
}
function conversation(id: string) {
  return { ...createConversation(undefined, id), messages: [{ id: `${id}-message`, role: 'user' as const, content: id, reasoning: '', status: 'complete' as const, createdAt: 1 }] }
}
function ids(loaded: LoadedChatHistory) {
  return new Set(loaded.state.conversations.map((item) => item.id))
}

// R28-2：人在导入时停在聊天页，或者导入中途点进聊天页，聊天页手上的都是导入前那一份。
describe('importing conversations while the chat page is around', () => {
  it('reloads a chat page that was showing during the import, after its last save and the import', async () => {
    const files = memoryFiles()
    const storage = memoryStorage()
    const shown: ChatWorkspace = { ...createWorkspace(scope), conversations: [conversation('on-this-computer')] }
    const opened = await loadChatHistory(files.api, storage, scope)
    const writer = createHistoryWriter(files.api, opened.saved, opened.afterFirstSave)
    let remounted: Promise<LoadedChatHistory> | undefined
    const transfer = createChatTransfer(files.bridge, storage, scope, () => {
      // What the chat page does when it is taken down and put straight back.
      void writer.save({ ...shown, draftConversation: { ...shown.draftConversation, draft: '还没发出去的话' } })
      remounted = loadChatHistory(files.api, storage, scope)
    })
    expect(await transfer.importConversations([conversation('from-old-computer')])).toEqual({ added: 1, skipped: 0 })
    const reloaded = await remounted!
    expect(ids(reloaded)).toEqual(new Set(['on-this-computer', 'from-old-computer']))
    expect(reloaded.state.draftConversation.draft).toBe('还没发出去的话')
    expect(ids(await loadChatHistory(files.api, storage, scope))).toEqual(new Set(['on-this-computer', 'from-old-computer']))
  })

  it('makes a chat page opened mid-import wait for it', async () => {
    const files = memoryFiles()
    const storage = memoryStorage()
    const write = files.bridge.writeAiChatHistory.getMockImplementation()!
    let release: () => void = () => undefined
    files.bridge.writeAiChatHistory.mockImplementationOnce((input) => new Promise<void>((resolve) => { release = () => { void write(input).then(resolve) } }))
    const unmountChat = vi.fn()
    const importing = createChatTransfer(files.bridge, storage, scope, unmountChat).importConversations([conversation('from-old-computer')])
    await vi.waitFor(() => expect(files.bridge.writeAiChatHistory).toHaveBeenCalledOnce())
    expect(unmountChat).toHaveBeenCalledOnce()
    const opened = loadChatHistory(files.api, storage, scope)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(files.bridge.readAiChatHistory).toHaveBeenCalledOnce()
    release()
    await importing
    expect(ids(await opened)).toEqual(new Set(['from-old-computer']))
  })
})
