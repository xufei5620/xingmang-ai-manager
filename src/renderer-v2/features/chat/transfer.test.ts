import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatHistorySnapshot, AiChatHistoryWrite, VideoStudioProjectsSnapshot, VideoStudioProjectsWrite } from '../../../../electron/ipc-contract'
import { markBackgroundWork } from '../../background-work'
import { createConversation, createWorkspace, type ChatWorkspace } from './state'
import { createHistoryWriter, loadChatHistory, registerHistoryFlusher, type LoadedChatHistory } from './storage'
import { chatReplyingImportMessage, createChatTransfer } from './transfer'
import { loadVideoStudioLibrary, serializeVideoStudioItem } from '../video-studio/library'
import { createVideoStudioProject, defaultVideoStudioSettings } from '../video-studio/project'

const scope = 'xm-account:7'
function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) }, removeItem: (key: string) => { data.delete(key) } }
}
// Same contract as electron/ai-chat-history-store.ts: rewrite the listed
// conversations, then the index, then drop files the index no longer names.
function memoryFiles() {
  const stores = new Map<string, AiChatHistorySnapshot>()
  // Same contract as electron/video-studio-project-store.ts: one file per video, put and remove by key.
  const videos = new Map<string, VideoStudioProjectsSnapshot>()
  const bridge = {
    readVideoStudioProjects: vi.fn(async (owner: string): Promise<VideoStudioProjectsSnapshot> => structuredClone(videos.get(owner) ?? { index: null, projects: [] })),
    writeVideoStudioProjects: vi.fn(async (input: VideoStudioProjectsWrite) => {
      const current = videos.get(input.scope) ?? { index: null, projects: [] }
      const files = new Map(current.projects.map((file) => [file.key, file.content]))
      for (const file of input.put) files.set(file.key, file.content)
      for (const key of input.remove) files.delete(key)
      videos.set(input.scope, { index: input.index ?? current.index, projects: [...files].map(([key, content]) => ({ key, content })) })
    }),
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
    expect(await transfer.importConversations([conversation('from-old-computer')])).toEqual({ added: 1, updated: 0, skipped: 0, videosAdded: 0, videosSkipped: 0 })
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

// 0.2.24 深查聊天页 C2：一段对话的文件坏了，以前整份读不出来，「迁移到新电脑」也一个都导不出去。
describe('moving to a new computer with one broken conversation file', () => {
  it('exports the conversations that still read and logs the broken one without showing its reason', async () => {
    const files = memoryFiles()
    const storage = memoryStorage()
    await createHistoryWriter(files.api, null).save({ ...createWorkspace(scope), conversations: [conversation('fine'), conversation('broken')] })
    const stored = await files.bridge.readAiChatHistory(scope)
    stored.conversations = stored.conversations.map((file) => file.key === 'broken' ? { ...file, content: '{truncated' } : file)
    files.bridge.readAiChatHistory.mockResolvedValueOnce(stored)
    const reportRendererError = vi.fn(async () => undefined)
    const transfer = createChatTransfer({ ...files.bridge, reportRendererError }, storage, scope, () => undefined)
    const exported = (await transfer.exportChat()).conversations
    expect(exported).toHaveLength(1)
    expect(exported[0]).toMatchObject({ id: 'fine' })
    expect(reportRendererError).toHaveBeenCalledWith({ message: expect.stringContaining('c-broken.json 读不出来'), context: 'chat-history', level: 'warn' })
  })
})

// 0.2.24 Mac 验收 R6：聊天页自动保存最多晚 2 秒，回复刚说完就去设置里导出，以前导出的是上一次存的那份，少了最后一问一答。
describe('exporting right after a reply finished', () => {
  const unregister: (() => void)[] = []
  afterEach(() => {
    for (const remove of unregister.splice(0)) remove()
  })
  function answered(id: string) {
    const asked = conversation(id)
    return { ...asked, messages: [...asked.messages, { id: `${id}-answer`, role: 'assistant' as const, content: '刚说完的回答', reasoning: '', status: 'complete' as const, createdAt: 2 }] }
  }

  it('has the open chat page save what it holds before reading the files', async () => {
    const files = memoryFiles()
    const writer = createHistoryWriter(files.api, null)
    await writer.save({ ...createWorkspace(scope), conversations: [conversation('earlier'), conversation('asking')] })
    // The autosave timer has not fired yet: the page holds the answer, the files do not.
    const onPage: ChatWorkspace = { ...createWorkspace(scope), conversations: [conversation('earlier'), answered('asking')] }
    unregister.push(registerHistoryFlusher(() => writer.save(onPage)))
    const exported = await createChatTransfer(files.bridge, memoryStorage(), scope, () => undefined).exportChat()
    expect(exported.conversations).toHaveLength(2)
    expect(exported.conversations[1]).toMatchObject({ id: 'asking', messages: [{ id: 'asking-message' }, { id: 'asking-answer', content: '刚说完的回答' }] })
  })

  it('still exports what is saved when the chat page cannot save right now', async () => {
    const files = memoryFiles()
    await createHistoryWriter(files.api, null).save({ ...createWorkspace(scope), conversations: [conversation('earlier')] })
    unregister.push(registerHistoryFlusher(async () => { throw new Error('disk full') }))
    const exported = await createChatTransfer(files.bridge, memoryStorage(), scope, () => undefined).exportChat()
    expect(exported.conversations).toHaveLength(1)
    expect(exported.conversations[0]).toMatchObject({ id: 'earlier' })
  })
})

// D41：聊天页藏在设置页后面照样收回复。以前「导入」一点就把聊天页卸下，正在回复、出图的那条被掐断，出图那条可能照样扣了费。
describe('importing conversations while the chat is replying', () => {
  const tokens: symbol[] = []
  function busy(label: string, restartWork?: 'chat' | 'video-compose') {
    const token = Symbol(label)
    tokens.push(token)
    markBackgroundWork(token, true, restartWork)
    return token
  }
  afterEach(() => {
    for (const token of tokens.splice(0)) markBackgroundWork(token, false)
  })

  it('refuses before anything moves, and leaves the chat page and the saved history alone', async () => {
    const files = memoryFiles()
    const unmountChat = vi.fn()
    const transfer = createChatTransfer(files.bridge, memoryStorage(), scope, unmountChat)
    const reply = busy('chat', 'chat')
    expect(() => transfer.assertChatIdle()).toThrow(chatReplyingImportMessage)
    await expect(transfer.importConversations([conversation('from-old-computer')])).rejects.toThrow(chatReplyingImportMessage)
    expect(unmountChat).not.toHaveBeenCalled()
    expect(files.bridge.readAiChatHistory).not.toHaveBeenCalled()
    expect(files.bridge.writeAiChatHistory).not.toHaveBeenCalled()
    markBackgroundWork(reply, false)
    expect(() => transfer.assertChatIdle()).not.toThrow()
    expect(await transfer.importConversations([conversation('from-old-computer')])).toEqual({ added: 1, updated: 0, skipped: 0, videosAdded: 0, videosSkipped: 0 })
    expect(unmountChat).toHaveBeenCalledOnce()
  })

  it('is not held up by other work that the chat page does not do', async () => {
    const files = memoryFiles()
    const transfer = createChatTransfer(files.bridge, memoryStorage(), scope, () => undefined)
    busy('tool-jobs')
    busy('video-compose', 'video-compose')
    expect(() => transfer.assertChatIdle()).not.toThrow()
    expect(await transfer.importConversations([conversation('from-old-computer')])).toEqual({ added: 1, updated: 0, skipped: 0, videosAdded: 0, videosSkipped: 0 })
  })

  it('says it in the exact words the formal wording list gave', () => {
    expect(chatReplyingImportMessage).toBe('聊天正在回复，请待回复完成后再导入。')
  })
})

// Fable 第二轮 Q7：「常用的话」跟聊天记录存在一起，迁移到新电脑时一起带走。
describe('moving saved phrases to a new computer', () => {
  it('exports the saved phrases with the conversations', async () => {
    const files = memoryFiles()
    const storage = memoryStorage()
    await createHistoryWriter(files.api, null).save({ ...createWorkspace(scope), conversations: [conversation('fine')], phrases: ['回答尽量简短', '翻译成英文'] })
    const exported = await createChatTransfer(files.bridge, storage, scope, () => undefined).exportChat()
    expect(exported.phrases).toEqual(['回答尽量简短', '翻译成英文'])
    expect(exported.conversations).toHaveLength(1)
  })

  it('adds imported phrases after the ones already here, without duplicates, even when no conversation is new', async () => {
    const files = memoryFiles()
    const storage = memoryStorage()
    await createHistoryWriter(files.api, null).save({ ...createWorkspace(scope), conversations: [conversation('here')], phrases: ['本机的一句', '两边都有'] })
    const transfer = createChatTransfer(files.bridge, storage, scope, () => undefined)
    expect(await transfer.importConversations([conversation('here')], ['两边都有', '旧电脑的一句'])).toEqual({ added: 0, updated: 0, skipped: 0, videosAdded: 0, videosSkipped: 0 })
    expect((await loadChatHistory(files.api, storage, scope)).state.phrases).toEqual(['本机的一句', '两边都有', '旧电脑的一句'])
  })

  it('writes nothing when the file brings no new conversation and no new phrase', async () => {
    const files = memoryFiles()
    const storage = memoryStorage()
    await createHistoryWriter(files.api, null).save({ ...createWorkspace(scope), conversations: [conversation('here')], phrases: ['两边都有'] })
    files.bridge.writeAiChatHistory.mockClear()
    await createChatTransfer(files.bridge, storage, scope, () => undefined).importConversations([conversation('here')], ['两边都有'])
    expect(files.bridge.writeAiChatHistory).not.toHaveBeenCalled()
  })

  it('stops adding imported phrases once this computer holds the most it can', async () => {
    const files = memoryFiles()
    const storage = memoryStorage()
    const present = Array.from({ length: 29 }, (_, index) => `本机第 ${index} 句`)
    await createHistoryWriter(files.api, null).save({ ...createWorkspace(scope), phrases: present })
    await createChatTransfer(files.bridge, storage, scope, () => undefined).importConversations([], ['旧电脑甲', '旧电脑乙'])
    expect((await loadChatHistory(files.api, storage, scope)).state.phrases).toEqual([...present, '旧电脑甲'])
  })
})

// 「搬作品改」：「创作」里的视频分镜跟聊天记录放在同一份文件里。
describe('moving creation videos to a new computer', () => {
  function video(id: string, idea: string) {
    const project = { ...createVideoStudioProject({ ...defaultVideoStudioSettings(), idea }), shots: [{ id: 'shot-0', prompt: '镜头', caption: '', status: 'idle' as const }] }
    return serializeVideoStudioItem({ id, updatedAt: 5, project })
  }

  it('exports the videos this account has with the conversations', async () => {
    const files = memoryFiles()
    await files.bridge.writeVideoStudioProjects({ scope, put: [video('film-1', '海边'), { key: 'broken', content: '[]' }], remove: [] })
    const exported = await createChatTransfer(files.bridge, memoryStorage(), scope, () => undefined).exportChat()
    expect(exported.videoProjects).toEqual([video('film-1', '海边')])
  })

  it('imports videos even when the file brings no conversation, and keeps the one already here', async () => {
    const files = memoryFiles()
    await files.bridge.writeVideoStudioProjects({ scope, put: [video('film-1', '海边')], remove: [] })
    const transfer = createChatTransfer(files.bridge, memoryStorage(), scope, () => undefined)
    expect(await transfer.importConversations([], [], [video('film-1', '山里'), video('film-2', '城市')])).toEqual({ added: 0, updated: 0, skipped: 0, videosAdded: 2, videosSkipped: 0 })
    const stored = await files.bridge.readVideoStudioProjects(scope)
    expect(stored.projects.map((file) => file.key).sort()).toEqual(['film-1', 'film-1-imported', 'film-2'])
    expect(stored.projects.find((file) => file.key === 'film-1')).toEqual(video('film-1', '海边'))
  })

  it('makes the creation page put back mid-import wait until the videos are written', async () => {
    const files = memoryFiles()
    const write = files.bridge.writeVideoStudioProjects.getMockImplementation()!
    let release: () => void = () => undefined
    files.bridge.writeVideoStudioProjects.mockImplementationOnce((input) => new Promise<void>((resolve) => { release = () => { void write(input).then(resolve) } }))
    let reopened: ReturnType<typeof loadVideoStudioLibrary> | undefined
    const reportRendererError = vi.fn(async () => undefined)
    const importing = createChatTransfer(files.bridge, memoryStorage(), scope, () => {
      reopened = loadVideoStudioLibrary({ ...files.bridge, reportRendererError }, scope, null)
    }).importConversations([], [], [video('film-2', '城市')])
    await vi.waitFor(() => expect(files.bridge.writeVideoStudioProjects).toHaveBeenCalledOnce())
    release()
    await importing
    expect((await reopened!).items.map((item) => item.id)).toEqual(['film-2'])
  })
})
